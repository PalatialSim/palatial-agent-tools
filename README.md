# Palatial Agent Tools

Palatial's thin JavaScript/CLI client and MCP server. Generation, planning, provider orchestration and proprietary prompts stay on Palatial servers.

## One native Agent entry

Package **0.1.23-dev.0** exposes exactly one MCP tool: `palatial_agent`. It is a **Dev preview**: configure `PALATIAL_API_URL=https://dashboard.dev.palatial.cloud/api/v1/external/` and a Dev workspace API key until the owning Backend is promoted.

The native Agent handles Palatial asset creation, configuration, modification, recovery, status and delivery. It reads the user's intent and existing project data. Unrelated tasks are refused. The public path always executes unattended: the server chooses supported routes, preferences, references and justified dimension estimates, and executes through shared owning services. No caller execution policy, token ceiling, answers, selections or confirmation messages exist.

Submit with the sole tool:

```json
{
  "message": "Create a rigid plastic storage bin for Isaac Sim, 60 by 40 by 32 cm."
}
```

Poll with the same tool:

```json
{ "turn_id": "RETURNED_ID" }
```

- Submit and poll are exclusive branches. A poll carries only `turn_id`; it never creates a request.
- Optional `files` contains local images, CAD/3D files, MP4/MOV videos, PDF or text documents. Supply them with your message in one call. The client streams the files and retains only paths, digests, sizes and a small request receipt for safe replay.
- To change an existing asset, pass its `asset_id` with your message (for example "raise the texture quality" or "create a variant of it"). The Agent decides from the message and the project whether to update that asset in place or create a new Variant. Optional `conversation_id` continues the same conversation. Keep returned identities.
- `request_id` is optional. Without it, every call creates a new request. Supply a stable explicit ID and identical inputs for idempotent replay, including avoiding duplicate charges. Local-file submissions generate one ID per call when omitted and share it across project reservation, upload preparation and final submission; another call without an ID is new work. Preserve the original explicit or saved ID after uncertainty; never create another request to check progress. After an uncertain file submission, this client checks the same request identity with a small receipt before sending any file bytes again.
- Product Research makes a best attempt: the native Agent resolves product identity, candidates, dimensions and references using sources, research and defaults, recording uncertainty in `assumptions` as `{ decision, evidence }`. Uncertainty alone is not a blocker. An essential missing source that research/defaults cannot replace, an unsupported task or permission refusal is a structured blocker. Typed refusals include `AGENT_OUT_OF_SCOPE` and `AGENT_SOURCE_MISSING`; required source bytes can return `AGENT_SOURCE_BYTES_REQUIRED` or `AGENT_SOURCE_UPLOAD_REQUIRED`. Permission failures retain native codes or `AGENT_PERMISSION_DENIED`. The client preserves these facts without a second planner or bypass.
- Native permissions, prerequisites, billing, cancellation and replay checks remain shared. `insufficient_tokens` or `insufficient_credits` sets automation to `paused`; admission rechecks each minute and shared pipeline billing resumes the same asset after sufficient top-up; there is no separate public token-ceiling policy.
- Read `automation.state` (`active`, `completed`, `blocked`, `paused`, `superseded`) for unattended progress, and keep polling the same id while active even when the underlying planner `status` is completed. A handled request or admitted action is not finished generation. Check the returned project/media/validation facts before claiming delivery or simulation success. A cancellation acknowledgment alone is not a completed stop.
- Requested downloads are authoritative structured results. Use exact host-issued URLs promptly; do not reconstruct credentials from model text. A representation may be pending, unsupported or genuinely missing independently of asset completion.

A request accepts at most 50 attachments and up to 1 GiB of files total. MP4/MOV videos must be at most 300 MiB (314572800 bytes), the current Mad Max processing limit; larger videos are rejected before transfer. Other supported file types retain the 1 GiB total file budget. At most 64 MiB uses one multipart HTTP POST. The current Dev gateway accepts at most 100 MiB (104857600 bytes) for the complete HTTP request body, including metadata and multipart framing; it does not support a 1 GiB single POST. Larger inputs use an internal resumable transport; callers still make one method or MCP call. Active transfer has a 60-second idle timeout, followed by a 120-second response timeout. A slow but progressing transfer has no fixed 30-second total deadline. Raw URLs are rejected; format and route capabilities remain server-owned.

Use `files` for all new file bytes in this call; existing owned attachment metadata may accompany it. JSON-only requests can still use small inline images within the existing 2 MiB per image, eight-image and 12 MiB total limits.

JavaScript callers can use `startAgentWithFiles({ requestId, message, files })` for the same file handling as MCP. For example:

```js
const receipt = await client.startAgentWithFiles({
  requestId: "storage-bin-1",
  message: "Create the storage bin in this photo.",
  files: ["./storage-bin.jpg"]
});
```

Use the same explicit request ID and unchanged files after a lost response. The client verifies local digests and sends only a small receipt first. It repeats a full multipart transfer at most once, only after the server confirms missing bytes. Old inline receipts retain their original replay format.

The JavaScript methods `startAgentTurn(input)` and `getAgentTurn(id)` use camelCase JSON (`requestId` is optional; omission is forwarded to the server for requests without local files) over `POST agent` (new asset), `POST assets/:assetId/agent` (existing asset, sent automatically when `assetId` is set) and `GET agent/:id`; method names do not introduce an alternate HTTP path. The old `agent/turns` path has no alias. Compatibility JavaScript and CLI operations remain available, but are not registered or advertised as MCP tools. The MCP server performs no startup docs/network calls or health/guide tool discovery.

## Install and configure

Requires Node.js 22 or newer and a Palatial workspace API key. Generation charges the shared workspace balance according to native postpaid stage billing. Your coding agent's model charges are separate.

```sh
npm install --global https://github.com/PalatialSim/palatial-agent-tools/releases/download/v0.1.23-dev.0/palatial-agent-tools-0.1.23-dev.0.tgz
palatial-agent login
palatial-agent setup --client codex
```

`palatial-agent setup --client claude` configures Claude Code. Run `palatial-agent setup --help` for supported setup choices. Credentials stay in local configuration or environment; never put API keys into tool arguments or chat. Set the Dev API origin in the MCP process environment for this preview.

Use `palatial-agent --help` for standalone CLI compatibility operations. Local CLI guidance is available through `palatial-agent guide`; these commands are separate from the one-tool MCP catalog.

## Development

```sh
npm run check
npm test
npm run test:package
```

The normal `v*` Git tag workflow verifies package/tag version equality, runs checks, packs the tarball and publishes it with a SHA-256 checksum. Package release does not promote Backend services to Stage or Production.
