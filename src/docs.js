import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { VERSION } from './version.js';

export const DOCS_ORIGIN = 'https://docs.palatial.cloud';
export const API_DOCS_URL = `${DOCS_ORIGIN}/integrations/api/`;
const MAX_PAGES = 64;
const MAX_BYTES = 512 * 1024;
const hash = text => createHash('sha256').update(text).digest('hex');
const cachePath = () => path.join(process.env.PALATIAL_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'palatial-agent'), 'docs-snapshot.json');

function decode(text) {
  return text.replace(/&#(x[\da-f]+|\d+);/gi, (_, value) => {
    const n = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name]);
}

// Compare article text rather than generated scripts, navigation or account
// state. Source text is never evaluated or used to rewrite the client schema.
export function articleText(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!main || !/sl-markdown-content/.test(main)) throw new Error('Documentation article missing.');
  const text = decode(main
    .replace(/<(script|style|svg|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|pre|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  if (text.length < 100) throw new Error('Documentation article is unexpectedly short.');
  return text;
}

function docsUrl(raw) {
  const url = new URL(decode(raw));
  if (url.origin !== DOCS_ORIGIN || url.username || url.password || url.search || url.hash) throw new Error('Unexpected documentation URL.');
  return url.href;
}

async function boundedText(response) {
  if (!response.body) throw new Error('Empty documentation response.');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error('Documentation response exceeds size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function excerpts(before, after) {
  const oldLines = new Set((before || '').split('\n'));
  const newLines = new Set((after || '').split('\n'));
  return {
    added: [...newLines].filter(line => line && !oldLines.has(line)).slice(0, 8).map(line => line.slice(0, 600)),
    removed: [...oldLines].filter(line => line && !newLines.has(line)).slice(0, 8).map(line => line.slice(0, 600))
  };
}

/** Check the live site on every call. A failed check never advances the baseline. */
export async function checkDocs({ fetchImpl = fetch, cacheFile = cachePath(), now = Date.now(), timeoutMs = 7000, disabled = process.env.PALATIAL_DOCS_CHECK === '0' } = {}) {
  const base = { docs_url: DOCS_ORIGIN, api_docs_url: API_DOCS_URL, checked_at: new Date(now).toISOString() };
  if (disabled) return { ...base, status: 'disabled', changed: null };
  let previous;
  try {
    const saved = await readFile(cacheFile, 'utf8');
    if (saved.length <= 8 * 1024 * 1024) {
      const candidate = JSON.parse(saved);
      if (candidate.schema_version === 1 && Array.isArray(candidate.pages) && candidate.pages.length <= MAX_PAGES && candidate.pages.every(page => docsUrl(page.url) && typeof page.text === 'string' && hash(page.text) === page.sha256)) previous = candidate;
    }
  } catch { /* A missing or invalid snapshot establishes a fresh baseline. */ }
  const signal = AbortSignal.timeout(timeoutMs);
  const get = async (url, extra = {}) => fetchImpl(url, { headers: { Accept: 'text/html, application/xml;q=0.9', 'User-Agent': `palatial-agent/${VERSION}`, ...extra }, redirect: 'error', signal });
  let pages;
  try {
    const index = await get(`${DOCS_ORIGIN}/sitemap-index.xml`);
    if (!index.ok) throw new Error(`Documentation sitemap returned HTTP ${index.status}.`);
    const xml = await boundedText(index);
    const locations = value => [...value.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)].map(match => docsUrl(match[1].trim()));
    let urls = locations(xml);
    if (/<sitemapindex\b/i.test(xml)) {
      if (!urls.length || urls.length > 4) throw new Error('Unexpected documentation sitemap count.');
      const lists = await Promise.all(urls.map(async url => {
        const response = await get(url);
        if (!response.ok) throw new Error(`Documentation sitemap returned HTTP ${response.status}.`);
        return locations(await boundedText(response));
      }));
      urls = lists.flat();
    }
    urls = [...new Set([...urls, API_DOCS_URL])].sort();
    if (urls.length < 2 || urls.length > MAX_PAGES) throw new Error('Unexpected documentation page count.');
    const oldPages = new Map((previous?.pages || []).map(page => [page.url, page]));
    pages = new Array(urls.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, urls.length) }, async () => {
      while (next < urls.length) {
        const i = next++; const url = urls[i]; const old = oldPages.get(url);
        const response = await get(url, old?.etag ? { 'If-None-Match': old.etag } : {});
        if (response.status === 304 && old) { pages[i] = old; continue; }
        if (!response.ok) throw new Error(`Documentation page returned HTTP ${response.status}: ${url}`);
        const html = await boundedText(response);
        const text = articleText(html);
        pages[i] = { url, title: decode(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || url), sha256: hash(text), text, etag: response.headers.get('etag') || null };
      }
    }));
  } catch (error) {
    return { ...base, status: 'unavailable', changed: null, last_successful_check: previous?.checked_at || null, message: error instanceof Error ? error.message : 'Documentation check failed.', action: 'Read the live docs directly when reachable. Use packaged guidance meanwhile; the previous snapshot is preserved.' };
  }
  const oldPages = new Map((previous?.pages || []).map(page => [page.url, page]));
  const newPages = new Map(pages.map(page => [page.url, page]));
  const changes = previous ? [
    ...pages.filter(page => oldPages.get(page.url)?.sha256 !== page.sha256).map(page => ({ url: page.url, title: page.title, kind: oldPages.has(page.url) ? 'modified' : 'added', ...excerpts(oldPages.get(page.url)?.text, page.text) })),
    ...previous.pages.filter(page => !newPages.has(page.url)).map(page => ({ url: page.url, title: page.title, kind: 'removed', ...excerpts(page.text, '') }))
  ] : [];
  const report = { ...base, status: !previous ? 'baseline_created' : changes.length ? 'changed' : 'unchanged', changed: previous ? changes.length > 0 : null, previous_checked_at: previous?.checked_at || null, page_count: pages.length, changed_pages: changes, snapshot_file: cacheFile, action: changes.length ? 'Read the changed pages at docs.palatial.cloud before using affected options. Report any mismatch with the installed tool schema; a docs change does not update client code automatically.' : 'Use the live API documentation for current request rules.' };
  const temporary = `${cacheFile}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ schema_version: 1, checked_at: base.checked_at, pages }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, cacheFile);
  } catch { report.cache_warning = 'Live check succeeded, but the snapshot could not be saved; a future startup may repeat this comparison.'; }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
  return report;
}
