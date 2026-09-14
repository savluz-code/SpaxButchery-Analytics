'use strict';
/*
 * Cloud-resilience tests for the sync layer (the "Save failed — Cloud
 * returned HTTP 404" / "timed out" bug):
 *
 *   1. Transient HTTP 404/5xx answers from a LIVE deployment are retried
 *      and the save succeeds — the user's data was never in danger, so the
 *      save must not be reported as failed.
 *   2. A persistent 404 (deployment deleted/replaced) fails FAST after the
 *      retries, with a message that tells the user what to do instead of
 *      just "Cloud returned HTTP 404".
 *   3. Permanent client errors (400) are NOT retried.
 *   4. Capability probes (saveBegin/saveDelta) are NOT retried — a blip
 *      there falls back to a path that works (pinned by chunked-save).
 *   5. A user cancel arriving during a retry backoff wins over the backoff.
 *   6. saveCommit and the small one-shot saveAll ride their own (longer)
 *      deadlines, not the 30s default.
 *   7. The /exec URL can be overridden per device (redeploy → new URL
 *      without a new app release); switching it invalidates every piece of
 *      state derived about the old endpoint, and every cloud call — loads,
 *      saves, the Kimi proxy — follows the override.
 *
 * The fake deployment scripts per-attempt HTTP answers per action, the way
 * Google's /exec edge fails in the field (a 404 with its own HTML page).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const slice = (a, b) => {
  const start = HTML.indexOf(a);
  assert.notEqual(start, -1, 'slice start not found: ' + a);
  const end = HTML.indexOf(b, start);
  assert.notEqual(end, -1, 'slice end not found: ' + b);
  return HTML.slice(start, end);
};
const syncLayerSource = () => slice('const GAS_URL', 'function showSyncStatus');

// Google's own 404 page, the shape the /exec edge actually returns.
const HTML404 = '<!doctype html><html><head><title>404</title></head><body>Not Found</body></html>';

// `plan` maps action -> array of per-attempt outcomes (last one repeats):
//   { status: 404, html: '…' }   a non-OK HTTP answer (the edge, not the script)
//   { body: { success: …, … } }  a 200 JSON answer
// Unplanned actions answer like a pre-chunking deployment: saveAll succeeds,
// saveBegin/saveDelta/saveChunk/saveCommit are "unknown action" — which is
// exactly what steers a small save down the one-shot saveAll path.
function makeCloud(plan = {}) {
  const calls = [];
  const attemptsByAction = {};
  const store = {};
  const live = { transactions: [] };
  const outcomeFor = (action, n) => {
    const list = plan[action];
    if (!list) {
      if (action === 'load') return { body: { success: true, customers: [], transactions: [] } };
      if (action === 'saveAll') return { body: { success: true } };
      return { body: { success: false, error: 'unknown action' } };
    }
    return list[Math.min(n, list.length) - 1];
  };
  const fetchImpl = async (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : {};
    const action = body.action || 'load';
    attemptsByAction[action] = (attemptsByAction[action] || 0) + 1;
    const n = attemptsByAction[action];
    calls.push({ action, url, attempt: n });
    const out = outcomeFor(action, n);
    if (out.status) {
      return { ok: false, status: out.status, text: async () => (out.html != null ? out.html : 'HTTP ' + out.status) };
    }
    if (action === 'saveAll') live.transactions = (body.transactions || []).slice();
    return { ok: true, status: 200, text: async () => JSON.stringify(out.body) };
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  return {
    calls,
    store,
    localStorage,
    fetchImpl,
    live,
    attempts: (action) => attemptsByAction[action] || 0
  };
}

function smallDB() {
  return {
    customers: [{ name: 'A', contact: '254700', spent: 100, visits: 1 }],
    monthly: { labels: ['2026-09'], revenue: [100] },
    importedRev: 100, importedTx: 2, resolved: 0, importBatch: 1,
    transactions: [
      { date: '2026-09-01', time: '10:00:00', amount: 50, name: 'A', phone: '254700', receipt: 'R1' },
      { date: '2026-09-01', time: '10:05:00', amount: 50, name: 'A', phone: '254700', receipt: 'R2' }
    ],
    customerTx: {},
    seen: {}
  };
}

function makeSandbox(cloud, db, status) {
  return {
    fetch: cloud.fetchImpl,
    localStorage: cloud.localStorage,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    showSyncStatus: (m) => status.push(m),
    isMerchant: () => false,
    DB: db
  };
}

// `retryDelays` overrides the production backoffs (4s/12s) so tests do not
// sit on real wall-clock delays — the same treatment the busy-retry delays
// get in the other suites.
async function runClient(cloud, db, { retryDelays = '[5, 5]' } = {}) {
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, db, status));
  const src = syncLayerSource().replace(
    /const CLOUD_HTTP_RETRY_DELAYS = \[[^\]]+\];/,
    'const CLOUD_HTTP_RETRY_DELAYS = ' + retryDelays + ';'
  );
  assert.notEqual(src.indexOf('CLOUD_HTTP_RETRY_DELAYS = ' + retryDelays), -1, 'retry delay patch must apply');
  vm.runInContext(src, ctx);
  const first = await ctx.saveToCloud(true);
  const lastCloudError = vm.runInContext('lastCloudError', ctx);
  return { first, status, lastCloudError, ctx };
}

/* ── transient HTTP failures are retried ────────────────────────────────── */

test('a transient 404 from the edge is retried and the save succeeds', async () => {
  const cloud = makeCloud({
    saveAll: [
      { status: 404, html: HTML404 }, // first hop dropped by Google's edge
      { body: { success: true } }     // the live deployment answers
    ]
  });
  const { first, status, lastCloudError } = await runClient(cloud, smallDB());

  assert.strictEqual(first, true, 'the save must succeed after the retry');
  assert.strictEqual(cloud.attempts('saveAll'), 2, 'one retry after the 404');
  assert.strictEqual(cloud.live.transactions.length, 2, 'the rows landed');
  assert.ok(status.some((m) => /Cloud hiccup \(HTTP 404\)/.test(m)), 'the retry is announced, not hidden');
  assert.strictEqual(lastCloudError, '', 'no failure is remembered');
});

test('a transient 502 on load is retried and the load succeeds', async () => {
  const cloud = makeCloud({
    load: [
      { status: 502, html: 'Bad Gateway' },
      { body: { success: true, customers: [{ name: 'C' }], transactions: [] } }
    ]
  });
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, smallDB(), status));
  vm.runInContext(syncLayerSource().replace(
    /const CLOUD_HTTP_RETRY_DELAYS = \[[^\]]+\];/,
    'const CLOUD_HTTP_RETRY_DELAYS = [5, 5];'
  ), ctx);
  const data = await ctx.cloudLoad();
  assert.strictEqual(data.customers.length, 1);
  assert.strictEqual(cloud.attempts('load'), 2);
});

/* ── persistent failures fail fast, with an actionable message ──────────── */

test('a persistent 404 fails after the retries with a redeploy hint', async () => {
  const cloud = makeCloud({ saveAll: [{ status: 404, html: HTML404 }] });
  const { first, status, lastCloudError } = await runClient(cloud, smallDB());

  assert.strictEqual(first, false, 'the save fails — the deployment really is gone');
  assert.strictEqual(cloud.attempts('saveAll'), 3, 'initial attempt + both retries, then stop');
  assert.strictEqual(cloud.live.transactions.length, 0, 'nothing was written');
  assert.match(lastCloudError, /404/);
  assert.match(lastCloudError, /deployment/i, 'the likely cause is named');
  assert.match(lastCloudError, /Redeploy/i, 'the fix is named');
  assert.match(lastCloudError, /safe locally/i, 'the user is told where the data is');
  // A dead deployment must not read like a mobile drop — otherwise
  // isTransientNetworkError would swallow it into a second retry wave.
  assert.ok(!/connection/i.test(lastCloudError), 'no "connection" wording in a deployment error');
  assert.ok(status.some((m) => /Cloud hiccup \(HTTP 404\)/.test(m)));
});

test('a permanent 400 is not retried', async () => {
  const cloud = makeCloud({
    saveAll: [
      { status: 400, html: 'Bad Request' },
      { body: { success: true } } // never reached
    ]
  });
  const { first, lastCloudError } = await runClient(cloud, smallDB());
  assert.strictEqual(first, false);
  assert.strictEqual(cloud.attempts('saveAll'), 1, 'client errors are not transient — one attempt');
  assert.strictEqual(lastCloudError, 'Cloud returned HTTP 400');
});

test('a capability probe is not retried — a blip falls back instead', async () => {
  // saveBegin dies with HTTP 500 (not "unknown action"): the probe must not
  // pay the backoff — it falls back to the one-shot path that works. This
  // pins the probe/data-path split in the retry design. (A big DB is needed
  // so the save even reaches the chunked path and therefore the probe.)
  const cloud = makeCloud({ saveBegin: [{ status: 500, html: 'Internal Server Error' }] });
  const { first, status, lastCloudError } = await runClient(cloud, bigDB());

  assert.strictEqual(first, true, 'the fallback save succeeds');
  assert.strictEqual(cloud.attempts('saveBegin'), 1, 'the probe is tried once, never retried');
  assert.strictEqual(cloud.attempts('saveAll'), 1);
  assert.strictEqual(cloud.live.transactions.length, bigDB().transactions.length);
  assert.ok(!('spaxCloudChunked' in cloud.store) || cloud.store.spaxCloudChunked !== '0',
    'a transient 500 must not be cached as "one-shot only"');
  assert.strictEqual(lastCloudError, '');
});

function bigDB() {
  const transactions = [];
  for (let i = 0; i < 3000; i++) {
    transactions.push({ date: '2026-09-01', time: '10:00:00', amount: 100, name: 'C' + i, phone: '2547' + i, receipt: 'R' + i });
  }
  return {
    customers: [{ name: 'C0', contact: '254700', spent: 100, visits: 1 }],
    monthly: { labels: ['2026-09'], revenue: [300000] },
    importedRev: 300000, importedTx: 3000, resolved: 0, importBatch: 1,
    transactions,
    customerTx: {},
    seen: {}
  };
}

/* ── a cancel wins over the retry backoff ───────────────────────────────── */

test('a user cancel during the retry backoff stops the save at once', async () => {
  const cloud = makeCloud({ saveAll: [{ status: 404, html: HTML404 }] });
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, smallDB(), status));
  // First backoff is 300ms so the cancel can land inside it.
  vm.runInContext(syncLayerSource().replace(
    /const CLOUD_HTTP_RETRY_DELAYS = \[[^\]]+\];/,
    'const CLOUD_HTTP_RETRY_DELAYS = [300, 5];'
  ), ctx);
  const pending = ctx.saveToCloud(true);
  setTimeout(() => { ctx.cloudSaveCancelAll(); }, 50);
  const first = await pending;

  assert.strictEqual(first, false, 'a cancelled save reports as not saved');
  assert.strictEqual(cloud.attempts('saveAll'), 1, 'no second attempt after the cancel');
  assert.ok(status.some((m) => /cancelled/i.test(m)), 'the cancel is announced');
});

/* ── per-step deadlines ─────────────────────────────────────────────────── */

test('saveCommit and the small one-shot saveAll ride their own deadlines', () => {
  // saveCommit verifies every staged row and swaps the live sheets — the
  // heaviest one-shot step — so it needs the commit deadline; a small
  // one-shot saveAll still rewrites every sheet and needs the small-save
  // deadline. Neither may silently fall back to the 30s default (that is
  // the "timeouts" half of the reported bug).
  assert.match(HTML, /CLOUD_TIMEOUT_SMALL = 60000/);
  assert.match(HTML, /CLOUD_TIMEOUT_COMMIT = 90000/);
  assert.match(HTML, /commit = await post\(commitBody, CLOUD_TIMEOUT_COMMIT\)/);
  assert.match(HTML, /totalBigRows > CHUNK_ROWS \? CLOUD_TIMEOUT_BIG_SAVE : CLOUD_TIMEOUT_SMALL/);
  // The data-path retry machinery and its split from the capability probes.
  assert.match(HTML, /CLOUD_HTTP_RETRIES = 2/);
  assert.match(HTML, /isTransientCloudStatus/);
  assert.match(HTML, /cloudSaveRetrySleep/);
  assert.match(HTML, /mode === 'delta' \? \{ mode: 'delta' \} : null\), CLOUD_TIMEOUT_CHUNK, 0\)/, 'saveBegin probe opts out of retries');
  assert.match(HTML, /txAdd\n(\s+)?\}, CLOUD_TIMEOUT_CHUNK, 0\)/, 'saveDelta probe opts out of retries');
});

/* ── per-device URL override ────────────────────────────────────────────── */

test('spaxCloudUrl honours a per-device override and falls back to the built-in URL', () => {
  const cloud = makeCloud({});
  const ctx = vm.createContext(makeSandbox(cloud, smallDB(), []));
  vm.runInContext(syncLayerSource(), ctx);
  assert.strictEqual(vm.runInContext('spaxCloudUrl()', ctx), vm.runInContext('GAS_URL', ctx), 'default = built-in URL');
  vm.runInContext("spaxSetCloudUrl('https://script.google.com/macros/s/NEWID/exec')", ctx);
  assert.strictEqual(vm.runInContext('spaxCloudUrl()', ctx), 'https://script.google.com/macros/s/NEWID/exec');
  assert.strictEqual(cloud.store.spaxCloudUrl_v1, 'https://script.google.com/macros/s/NEWID/exec', 'the override persists per device');
  vm.runInContext("spaxSetCloudUrl('')", ctx);
  assert.strictEqual(vm.runInContext('spaxCloudUrl()', ctx), vm.runInContext('GAS_URL', ctx), 'reset returns to the built-in URL');
  assert.equal('spaxCloudUrl_v1' in cloud.store, false);
});

test('switching the URL invalidates every piece of state derived about the old cloud', () => {
  const cloud = makeCloud({});
  const ctx = vm.createContext(makeSandbox(cloud, smallDB(), []));
  // The device knows things about the OLD endpoint before the switch…
  cloud.store.spaxCloudChunked = '1';
  cloud.store.spaxCloudDelta = '1';
  cloud.store.spaxUploadSession = JSON.stringify({ uploadId: 'upload-123' });
  cloud.store.spaxPushedTx_v1 = JSON.stringify({ v: 2, keys: 'R|R1|2026-09-01|\nR|R2|2026-09-01|' });
  cloud.store.spaxTxFullReplace = '0';
  cloud.store.spaxSavedBasis_v1 = 'basis|1757460000000';
  vm.runInContext(syncLayerSource(), ctx);
  assert.strictEqual(vm.runInContext('cloudChunks', ctx), true, 'precondition: chunked capability cached');
  assert.strictEqual(vm.runInContext('cloudDelta', ctx), true, 'precondition: delta capability cached');

  vm.runInContext("spaxSetCloudUrl('https://script.google.com/macros/s/NEWID/exec')", ctx);

  assert.strictEqual(cloud.store.spaxCloudUrl_v1, 'https://script.google.com/macros/s/NEWID/exec');
  assert.equal('spaxCloudChunked' in cloud.store, false, 'capability probes belong to the old endpoint');
  assert.equal('spaxCloudDelta' in cloud.store, false);
  assert.equal('spaxUploadSession' in cloud.store, false, 'a half-finished upload into the old cloud is dead');
  assert.ok(cloud.store.spaxTxFullReplace === '1' || !('spaxTxFullReplace' in cloud.store),
    'the next save must be a full replace, never a delta onto unknown data');
  assert.match(cloud.store.spaxPushedTx_v1 || '', /"keys":""/, 'the pushed set is emptied — the new cloud is unknown');
  assert.equal('spaxSavedBasis_v1' in cloud.store, false, 'the "nothing new" basis is stale');
  assert.strictEqual(vm.runInContext('cloudChunks', ctx), false);
  assert.strictEqual(vm.runInContext('cloudDelta', ctx), false);
});

test('loads and saves follow the per-device URL override', async () => {
  const cloud = makeCloud({});
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, smallDB(), status));
  vm.runInContext(syncLayerSource(), ctx);
  vm.runInContext("spaxSetCloudUrl('https://script.google.com/macros/s/NEWID/exec')", ctx);

  await ctx.cloudLoad();
  const saveOk = await ctx.saveToCloud(true);
  assert.strictEqual(saveOk, true);

  const urls = cloud.calls.map((c) => c.url);
  assert.ok(urls.length > 0, 'the cloud was called');
  urls.forEach((u) => {
    assert.ok(u.startsWith('https://script.google.com/macros/s/NEWID/exec'), 'every call follows the override: ' + u);
  });
});

test('the Kimi proxy and the connection test follow the effective URL', () => {
  // The proxy reuses the cloud deployment, so a redeployed URL must work for
  // both without re-pasting anything; the test-connection + URL editor live
  // in the ⚙️ Sync tab and drive cloudLoad / spaxSetCloudUrl.
  const kimi = slice('function getKimiProxyUrl(){', 'async function kimiVisionAPI');
  assert.match(kimi, /spaxCloudUrl\(\)/, 'the proxy must honour the per-device override');
  assert.match(HTML, /id="cloudUrlInput"/);
  assert.match(HTML, /id="cloudTestStatus"/);
  assert.match(HTML, /async function testCloudConnection\(\)\{/);
  assert.match(HTML, /function spaxSetCloudUrl\(url\)/);
});
