import { randomUUID } from 'node:crypto';
import { PalatialApiError } from './client.js';

// Bounded recovery for public Agent turn submits (POST agent, POST assets/{id}/agent).
//
// Duplicate safety comes from the request identity: the server binds a caller's requestId to its
// inputs and answers an identical replay with the original turn. The deadline and send ceiling only
// bound time and cost. Automatic replay therefore needs both a caller-known requestId (a generated one
// may be lost with the host's result) and a verified host time limit (an MCP server cannot observe its
// host's timeout). Without either, a turn is sent once and an unresolved outcome is returned with its
// request_id.

/** Physical Agent-turn POSTs per logical call, including the first send, saved manifests and file resends. */
export const AGENT_TURN_MAX_SENDS = 4;
/** Longest single JSON turn attempt. */
export const AGENT_TURN_ATTEMPT_MS = 30_000;
/** Turn-phase time per logical call: dispatch, response handling and recovery waits, never file preparation. */
export const AGENT_TURN_PHASE_MS = 120_000;
/** Time kept back from the host limit for cleanup and delivering the result. */
export const AGENT_TURN_HOST_MARGIN_MS = 10_000;
/** Smallest window in which starting a recovery send is useful. */
export const AGENT_TURN_MIN_SEND_MS = { json: 5_000, multipart: 15_000 };
const RETRY_STARTING_MAX_WAIT_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 4_000];
const FILE_RESPONSE_MS = 120_000;
const turnIdentity = /^[A-Za-z0-9._:-]{1,192}$/;

/** A host tool-call limit in milliseconds from configuration, or undefined when none is verified. */
export function hostTimeoutMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const ms = Number(String(value).trim());
  if (!Number.isInteger(ms) || ms <= 0) throw new Error('PALATIAL_HOST_TIMEOUT_MS must be a positive whole number of milliseconds.');
  return ms;
}

// An existing asset is addressed by path; the body carries only the message and optional extras.
export function agentTurnRoute(body) {
  if (body.assetId === undefined) return { route: 'agent', body };
  const { assetId, ...rest } = body;
  return { route: `assets/${encodeURIComponent(assetId)}/agent`, body: rest };
}

const clock = client => (client.now ? client.now() : performance.now());

/** State shared by every turn send of one logical call. `startedAt` is tool entry on the client clock. */
export function agentTurnBudget(client, { requestId, callerSupplied, startedAt = clock(client) }) {
  const host = client.hostTimeoutMs;
  const margin = client.hostMarginMs ?? AGENT_TURN_HOST_MARGIN_MS;
  return {
    requestId, callerSupplied,
    hostDeadline: Number.isFinite(host) && host > 0 ? startedAt + host - margin : null,
    sends: 0, turnMs: 0, runningSince: null, ambiguous: false, last: undefined
  };
}

function startTurnClock(client, budget) { if (budget.runningSince === null) budget.runningSince = clock(client); }
function stopTurnClock(client, budget) {
  if (budget.runningSince === null) return;
  budget.turnMs += clock(client) - budget.runningSince;
  budget.runningSince = null;
}
function turnElapsed(client, budget) { return budget.turnMs + (budget.runningSince === null ? 0 : clock(client) - budget.runningSince); }

/** Time left for recovery, or null when automatic recovery is off for this call. */
function recoveryWindow(client, budget) {
  if (!budget.callerSupplied || budget.hostDeadline === null) return null;
  return Math.min(budget.hostDeadline - clock(client), AGENT_TURN_PHASE_MS - turnElapsed(client, budget));
}

function canRecover(client, budget, waitMs, transport) {
  const window = recoveryWindow(client, budget);
  return window !== null && budget.sends < AGENT_TURN_MAX_SENDS && window - waitMs >= AGENT_TURN_MIN_SEND_MS[transport];
}

/** A send is allowed as the call's first submission, or as recovery inside the window after an ambiguous one. */
function maySend(client, budget, transport) {
  if (budget.sends >= AGENT_TURN_MAX_SENDS) return false;
  return !budget.ambiguous || canRecover(client, budget, 0, transport);
}

const statusOf = error => error?.http_status ?? error?.status;

function retryAfterMs(error) {
  const header = error?.retryAfter;
  if (header === undefined || header === null) return 1_000;
  const seconds = /^\d+$/.test(header.trim()) ? Number(header.trim()) : (Date.parse(header) - Date.now()) / 1000;
  return Math.min(Math.max(Number.isFinite(seconds) ? seconds : 1, 0) * 1000, RETRY_STARTING_MAX_WAIT_MS);
}

/** The wait before replaying an identical JSON send after this failure, or null when it may not be replayed. */
function replayWait(budget, error) {
  const status = statusOf(error);
  if (status === undefined) return error?.transport ? BACKOFF_MS[Math.min(budget.sends - 1, BACKOFF_MS.length - 1)] : null;
  if (status === 503 && error.code === 'RUN_RETRY_STARTING') return retryAfterMs(error);
  if ([502, 503, 504].includes(status)) return BACKOFF_MS[Math.min(budget.sends - 1, BACKOFF_MS.length - 1)];
  return null;
}

function remember(budget, error) {
  budget.last = { http_status: statusOf(error), code: typeof error?.code === 'string' ? error.code : undefined };
}

/** The unresolved-admission result: the turn may or may not exist under request_id. */
export function outcomeUnknown(budget, detail = '') {
  const id = budget.requestId;
  return new PalatialApiError(`The Agent turn outcome is unknown after ${budget.sends} send(s)${detail}. It may have been admitted under request_id ${id}. Do not submit it as new work: call again with request_id ${id}, the same API key and identical inputs once the service responds; an identical replay returns the original turn instead of starting another. Once you have a turn id, poll it with turn_id. A turn confirmed failed stays failed; replacing it is a separate request with a new request_id.`, {
    code: 'AGENT_TURN_OUTCOME_UNKNOWN', request_id: id, retryable: true, turn_sends: budget.sends,
    ...(budget.last?.http_status !== undefined ? { last_http_status: budget.last.http_status } : {}),
    ...(budget.last?.code ? { last_code: budget.last.code } : {})
  });
}

/** A definitive refusal of this send, carrying request_id and, for a caller's ID, the cross-call qualification. */
function refusal(budget, error) {
  const id = budget.requestId;
  const result = error instanceof PalatialApiError ? error : new PalatialApiError(error.message, { http_status: statusOf(error), ...(typeof error.code === 'string' ? { code: error.code } : {}) });
  result.request_id = id;
  if (!budget.callerSupplied) return result;
  result.earlier_outcome = 'unresolved';
  result.message += result.code === 'REQUEST_ID_CONFLICT'
    ? ` request_id ${id} is already bound to different inputs. To recover the original request, resend request_id ${id} with its original inputs; a changed request needs a new request_id.`
    : ` This refusal applies to this attempt only and does not settle any earlier submission under request_id ${id}. Poll a known turn_id, or once the refusal is resolved resend request_id ${id} with identical inputs.`;
  return result;
}

function receipt(budget, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.id !== 'string' || !turnIdentity.test(result.id)) return null;
  return { ...result, request_id: budget.requestId };
}

/** One counted Agent-turn POST. Resolves { result } or { error }; never throws for a sent request. */
async function dispatch(client, budget, route, options) {
  budget.sends++;
  try { return { result: await client.request(route, { method: 'POST', structuredErrors: true, ...options }) }; }
  catch (error) { return { error }; }
}

/**
 * Sends one frozen JSON turn body, replaying it unchanged inside the recovery window after a connection
 * failure, timeout, 502, 503 or 504. `missingBytes` returns `{ missingBytes: true }` for a saved digest
 * manifest the server cannot resolve, instead of treating that refusal as an outcome.
 */
export async function sendJsonTurn(client, budget, route, json, { missingBytes = false } = {}) {
  for (;;) {
    if (!maySend(client, budget, 'json')) throw outcomeUnknown(budget);
    const window = recoveryWindow(client, budget);
    const timeoutMs = window !== null && window > 0 ? Math.min(AGENT_TURN_ATTEMPT_MS, window) : client.timeoutMs ?? AGENT_TURN_ATTEMPT_MS;
    startTurnClock(client, budget);
    const { result, error } = await dispatch(client, budget, route, { json, timeoutMs });
    if (!error) {
      const valid = receipt(budget, result);
      stopTurnClock(client, budget);
      if (valid) return valid;
      budget.ambiguous = true;
      budget.last = undefined;
      throw outcomeUnknown(budget, ' (the response carried no valid turn receipt)');
    }
    const status = statusOf(error);
    if (status >= 400 && status < 500) {
      stopTurnClock(client, budget);
      if (missingBytes && status === 400 && error.code === 'AGENT_SOURCE_BYTES_REQUIRED') return { missingBytes: true };
      if (budget.ambiguous) { remember(budget, error); throw outcomeUnknown(budget); }
      throw refusal(budget, error);
    }
    budget.ambiguous = true;
    remember(budget, error);
    const wait = replayWait(budget, error);
    if (wait === null || !canRecover(client, budget, wait, 'json')) { stopTurnClock(client, budget); throw outcomeUnknown(budget); }
    await client.sleep(wait);
  }
}

/**
 * Sends one streamed multipart turn. The body streams under its progress timer; turn-phase time starts
 * when streaming ends. Resolves { receipt }, { refused }, or { ambiguous } after recording the failure.
 */
export async function sendMultipartTurn(client, budget, route, uploadBody) {
  const window = () => recoveryWindow(client, budget);
  const body = {
    ...uploadBody,
    onStreamEnd: () => startTurnClock(client, budget),
    // Inside a verified host window the response wait ends with it; past the window, or without one,
    // the existing response timer applies and no recovery send follows.
    responseTimeoutMs: () => { const left = window(); return left !== null && left > 0 ? Math.min(FILE_RESPONSE_MS, left) : FILE_RESPONSE_MS; }
  };
  const { result, error } = await dispatch(client, budget, route, { uploadBody: body });
  startTurnClock(client, budget);
  stopTurnClock(client, budget);
  if (!error) {
    const valid = receipt(budget, result);
    if (valid) return { receipt: valid };
    budget.ambiguous = true;
    budget.last = undefined;
    return { ambiguous: true };
  }
  const status = statusOf(error);
  if (status >= 400 && status < 500) {
    if (budget.ambiguous) remember(budget, error);
    return { refused: error };
  }
  budget.ambiguous = true;
  remember(budget, error);
  return { ambiguous: true };
}

export { maySend as mayTurnSend, refusal as turnRefusal };

/** A JSON Agent turn: generates the request identity when omitted and applies the bounded policy. */
export async function submitAgentTurn(client, parsed, { startedAt } = {}) {
  const callerSupplied = parsed.requestId !== undefined;
  const intent = callerSupplied ? parsed : { requestId: randomUUID(), ...parsed };
  const budget = agentTurnBudget(client, { requestId: intent.requestId, callerSupplied, startedAt });
  const { route, body } = agentTurnRoute(intent);
  return sendJsonTurn(client, budget, route, JSON.stringify(body));
}
