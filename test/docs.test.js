import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { articleText, checkDocs, DOCS_ORIGIN, API_DOCS_URL } from '../src/docs.js';

const article = (text, noise = '') => `<html><head><title>Using the API</title><style>${noise}</style></head><body><nav>${noise}</nav><main><h1>Using the API</h1><div class="sl-markdown-content"><p>${text} ${'A documented request rule. '.repeat(6)}</p></div><script>${noise}</script></main></body></html>`;
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'palatial-docs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { text: 'Original rule', noise: 'first css', urls: [API_DOCS_URL, `${DOCS_ORIGIN}/pipeline/`], requests: [] };
  const fetchImpl = async (url, init) => {
    state.requests.push({ url, init });
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers['x-api-key'], undefined);
    assert.equal(init.redirect, 'error');
    if (state.fail) return new Response('unavailable', { status: 503 });
    if (url.endsWith('sitemap-index.xml')) return new Response(`<sitemapindex><sitemap><loc>${DOCS_ORIGIN}/sitemap-0.xml</loc></sitemap></sitemapindex>`);
    if (url.endsWith('sitemap-0.xml')) return new Response(`<urlset>${state.urls.map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`);
    if (state.notModified && init.headers['If-None-Match']) return new Response(null, { status: 304 });
    return new Response(article(state.text, state.noise), { headers: { etag: 'fixture-etag' } });
  };
  return { state, options: { cacheFile: path.join(dir, 'snapshot.json'), fetchImpl } };
}

test('every check fetches live docs, ignores site chrome, and compares a persistent baseline', async t => {
  const { state, options } = await fixture(t);
  const first = await checkDocs(options);
  assert.equal(first.status, 'baseline_created'); assert.equal(first.changed, null);
  state.noise = 'new css and account state';
  const before = state.requests.length;
  const second = await checkDocs(options);
  assert.equal(second.status, 'unchanged'); assert.equal(second.changed, false);
  assert.equal(state.requests.length - before, 4, 'No TTL may skip startup network checks.');
  state.text = 'New rule: choose mode and route-specific parameters';
  const third = await checkDocs(options);
  assert.equal(third.changed, true); assert.equal(third.changed_pages.length, 2);
  assert.match(third.changed_pages[0].added.join(' '), /route-specific parameters/);
  assert.match(third.changed_pages[0].removed.join(' '), /Original rule/);
  assert.equal((await checkDocs(options)).changed, false, 'A successful check advances the baseline.');
});

test('added and removed pages are reported, and conditional 304 replies keep content hashes', async t => {
  const { state, options } = await fixture(t);
  await checkDocs(options);
  state.urls = [API_DOCS_URL, `${DOCS_ORIGIN}/release-notes/`];
  state.notModified = true;
  const report = await checkDocs(options);
  assert.deepEqual(report.changed_pages.map(page => page.kind).sort(), ['added', 'removed']);
  assert.ok(state.requests.some(({ init }) => init.headers['If-None-Match'] === 'fixture-etag'));
});

test('offline checks report unknown change state and preserve the last successful baseline', async t => {
  const { state, options } = await fixture(t);
  await checkDocs(options);
  const before = await readFile(options.cacheFile, 'utf8');
  state.fail = true;
  const failed = await checkDocs(options);
  assert.equal(failed.status, 'unavailable'); assert.equal(failed.changed, null);
  assert.equal(await readFile(options.cacheFile, 'utf8'), before);
  state.fail = false; state.text = 'A change after the failed check';
  assert.equal((await checkDocs(options)).changed, true);
});

test('tampered snapshots reset the baseline instead of accepting unverified hashes', async t => {
  const { options } = await fixture(t);
  await checkDocs(options);
  const saved = JSON.parse(await readFile(options.cacheFile)); saved.pages[0].text += 'tampered';
  await writeFile(options.cacheFile, JSON.stringify(saved));
  assert.equal((await checkDocs(options)).status, 'baseline_created');
});

test('foreign sitemap URLs, oversized responses and missing articles are not stored as docs', async t => {
  const { options } = await fixture(t);
  for (const body of ['<urlset><loc>https://another.example/private</loc></urlset>', 'x'.repeat(512 * 1024 + 1)]) {
    const report = await checkDocs({ ...options, fetchImpl: async () => new Response(body) });
    assert.equal(report.status, 'unavailable'); assert.equal(report.changed, null);
  }
  assert.throws(() => articleText('<main>Sign in or complete a challenge</main>'), /article missing/);
  assert.equal((await checkDocs({ ...options, disabled: true })).status, 'disabled');
});
