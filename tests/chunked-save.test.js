/**
 * Chunked cloud sync — regression tests.
 *
 * Chunked sync (PR #37) was reverted in PR #40 because it hard-required a
 * Code.gs redeploy: on deployments still running the saveAll-only script every
 * large save died with "unknown action". It came back in PR #41 as a
 * CLIENT-ONLY feature, which stopped the hard failures but left large saves as
 * one giant POST that the 30 s client timeout regularly aborted on weak
 * mobile signal — the chronic "cloud sync failed".
 *
 * Backend v3.0 (2026-09-03) completes the protocol:
 *
 *   • Large saves go up in slices (saveBegin → saveChunk×N → saveCommit) so no
 *     single request has to carry the whole ~2.5 MB database, and the backend
 *     stages every table and only swaps the live sheets in once every promised
 *     row has landed.
 *   • saveBegin answers with an uploadId that every chunk/commit echoes, so
 *     two devices can't interleave slices into one staging area.
 *   • saveAll stages + swaps too, so even one-shot saves are atomic: a load
 *     can never again land on a half-written (truncated) sheet.
 *   • The client still probes first: a backend that answers "unknown action"
 *     (a pre-v3.0 deployment) is remembered for the session and every save
 *     falls back to the single saveAll POST — no redeploy is ever REQUIRED.
 *   • Timeouts are payload-aware now (30 s probes/commits, 60 s chunks,
 *     90 s load, 180 s one-shot big save) instead of a blanket 30 s.
 *   • Saves are serialized client-side so two POSTs never fight over the
 *     backend script lock.
 *
 * Backend behaviour itself is pinned in tests/gas-backend.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GAS = fs.readFileSync(path.join(ROOT, 'google-apps-script.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ── the client's sync layer, executed against a scripted cloud ─────────── */

function syncLayerSource() {
  const start = HTML.indexOf('const GAS_URL');
  const end = HTML.indexOf('function showSyncStatus');
  assert.notEqual(start, -1, 'GAS_URL not found in index.html');
  assert.notEqual(end, -1, 'showSyncStatus not found in index.html');
  return HTML.slice(start, end);
}

/**
 * Fake Apps Script web app. `chunked: false` behaves exactly like a
 * pre-v3.0 saveAll-only script (doPost answers { success: false, error:
 * 'unknown action' } for the chunked actions); `chunked: true` behaves like
 * the v3.0 script: saveBegin stages the small tables and mints an uploadId,
 * saveChunk stages rows, and saveCommit verifies the staged row counts
 * before swapping anything in — a short count aborts the commit and leaves
 * live data untouched.
 * `uploadIds: false` downgrades to a chunk-capable backend that predates the
 * uploadId session guard (it never returns one — the client must cope).
 * `failChunk` makes the Nth saveChunk fail; `dropChunk` makes the Nth
 * saveChunk "succeed" while losing its rows (a lost slice).
 * `failBeginTimes: N` makes the first N saveBegin probes die with an HTTP
 * error — a transient failure that must fall back to saveAll without
 * poisoning the capability cache.
 */
function makeCloud({ chunked = true, uploadIds = true, failChunk = 0, dropChunk = 0, failBeginTimes = 0 } = {}) {
  const calls = [];
  const staged = { transactions: [], customerTx: [], seen: [] };
  const store = {};
  let chunkNo = 0;
  let beginNo = 0;
  const respond = (body) => ({ ok: true, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : {};
    calls.push(body);
    if (body.action === 'saveBegin') {
      if (!chunked) return respond({ success: false, error: 'unknown action' });
      beginNo += 1;
      if (beginNo <= failBeginTimes) return { ok: false, status: 500, text: async () => 'Internal Error' };
      return respond({ success: true, ...(uploadIds ? { uploadId: 'upload-123' } : {}) });
    }
    if (body.action === 'saveChunk') {
      chunkNo += 1;
      if (failChunk === chunkNo) return respond({ success: false, error: 'chunk write failed' });
      if (dropChunk !== chunkNo) (staged[body.table] || []).push(...body.rows);
      return respond({ success: true, written: dropChunk === chunkNo ? 0 : body.rows.length });
    }
    if (body.action === 'saveCommit') {
      if (uploadIds && body.uploadId !== 'upload-123') {
        return respond({ success: false, error: 'upload superseded by a newer save — please retry the whole save' });
      }
      for (const t of ['transactions', 'customerTx', 'seen']) {
        const want = Number((body.expect || {})[t] || 0);
        if (staged[t].length !== want) {
          return respond({
            success: false,
            error: 'chunk mismatch on ' + t + ': staged ' + staged[t].length + ' rows, expected ' + want +
                   ' — live data left untouched, please retry the save'
          });
        }
      }
      return respond({ success: true });
    }
    if (body.action === 'saveAll') return respond({ success: true });
    return respond({ success: false, error: 'unknown action' });
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  return { calls, staged, store, localStorage, fetchImpl };
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

async function runClient(cloud, db, { saveTwice = false } = {}) {
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, db, status));
  vm.runInContext(syncLayerSource(), ctx);
  const first = await ctx.saveToCloud(true);
  const second = saveTwice ? await ctx.saveToCloud(true) : undefined;
  const lastCloudError = vm.runInContext('lastCloudError', ctx);
  return { first, second, status, lastCloudError, ctx };
}

function bigDB() {
  const transactions = [];
  for (let i = 0; i < 3000; i++) {
    transactions.push({ date: '2026-08-31', time: '10:00:00', amount: 100, name: 'C' + i, phone: '2547' + i, receipt: 'R' + i });
  }
  const customerTx = {};
  for (let i = 0; i < 50; i++) {
    customerTx['C' + i] = [{ date: '2026-08-31', amount: 100, product: 'Beef', receipt: 'R' + i, importedAt: '2026-08-31' }];
  }
  const seen = {};
  for (let i = 0; i < 100; i++) seen['receipt|R' + i + '|2026-08-31|'] = 1;
  return {
    customers: [{ name: 'C0', contact: '25470', spent: 100, visits: 1 }],
    monthly: { labels: ['2026-08'], revenue: [300000] },
    importedRev: 300000,
    importedTx: 3000,
    resolved: 0,
    importBatch: 1,
    transactions,
    customerTx,
    seen
  };
}

/* ── behaviour against a chunk-capable backend ──────────────────────────── */

test('large save uses saveBegin → saveChunk×N → saveCommit on a chunk-capable backend', async () => {
  const cloud = makeCloud({ chunked: true });
  const { first, status } = await runClient(cloud, bigDB());

  assert.strictEqual(first, true);
  const actions = cloud.calls.map((c) => c.action);
  assert.strictEqual(actions[0], 'saveBegin', 'first request must be saveBegin');
  assert.strictEqual(actions[actions.length - 1], 'saveCommit', 'last request must be saveCommit');

  // saveBegin carries only the small tables.
  const begin = cloud.calls[0];
  assert.strictEqual(begin.customers.length, 1);
  assert.deepStrictEqual(begin.monthly, { labels: ['2026-08'], revenue: [300000] });
  assert.ok(begin.settings && begin.settings.importBatch === 1);
  assert.strictEqual(begin.transactions, undefined, 'big tables must not ride on saveBegin');
  assert.strictEqual(begin.customerTx, undefined);
  assert.strictEqual(begin.seen, undefined);

  // The big tables are sliced, in a stable order, never over CHUNK_ROWS.
  const chunks = cloud.calls.filter((c) => c.action === 'saveChunk');
  assert.deepStrictEqual(
    chunks.map((c) => c.table),
    ['transactions', 'transactions', 'customerTx', 'seen']
  );
  chunks.forEach((c) => assert.ok(c.rows.length <= 2000, 'chunk over CHUNK_ROWS: ' + c.rows.length));
  assert.strictEqual(chunks.filter((c) => c.table === 'transactions').flatMap((c) => c.rows).length, 3000);
  assert.strictEqual(chunks.filter((c) => c.table === 'customerTx').flatMap((c) => c.rows).length, 50);
  assert.strictEqual(chunks.filter((c) => c.table === 'seen').flatMap((c) => c.rows).length, 100);

  // saveCommit promises exactly what was sent.
  assert.deepStrictEqual(cloud.calls[cloud.calls.length - 1].expect, {
    transactions: 3000,
    customerTx: 50,
    seen: 100
  });

  // Live progress is shown and the capability is remembered.
  assert.ok(status.some((m) => /%/.test(m)), 'no percentage progress shown during upload');
  assert.strictEqual(cloud.store.spaxCloudChunked, '1');
});

test('a chunk that fails mid-upload surfaces the error and never commits', async () => {
  const cloud = makeCloud({ chunked: true, failChunk: 2 });
  const { first, lastCloudError } = await runClient(cloud, bigDB());

  assert.strictEqual(first, false);
  const actions = cloud.calls.map((c) => c.action);
  assert.ok(actions.includes('saveChunk'));
  assert.ok(!actions.includes('saveCommit'), 'a failed chunk must never be committed');
  assert.ok(!actions.includes('saveAll'), 'a mid-upload failure must NOT replay the whole database as one request');
  assert.match(lastCloudError, /chunk write failed/);
});

test('a lost chunk aborts the commit — the backend refuses and live data stays untouched', async () => {
  const cloud = makeCloud({ chunked: true, dropChunk: 1 });
  const { first, lastCloudError } = await runClient(cloud, bigDB());

  assert.strictEqual(first, false);
  assert.ok(cloud.calls.some((c) => c.action === 'saveCommit'), 'client should still ask to commit');
  assert.match(lastCloudError, /chunk mismatch on transactions/);
  assert.match(lastCloudError, /live data left untouched/);
  // Only the two delivered slices are staged — the lost one is not.
  assert.strictEqual(cloud.staged.transactions.length, 1000);
});

/* ── behaviour against the unchanged saveAll-only backend ───────────────── */

test('a saveAll-only backend still saves: probe falls back to one full saveAll POST', async () => {
  const cloud = makeCloud({ chunked: false });
  const { first, second } = await runClient(cloud, bigDB(), { saveTwice: true });

  assert.strictEqual(first, true);
  // First save: the tiny saveBegin probe is answered "unknown action", so the
  // whole database goes up as ONE saveAll — nothing is chunked, nothing lost.
  assert.deepStrictEqual(
    cloud.calls.map((c) => c.action),
    ['saveBegin', 'saveAll', 'saveAll'],
    'expected probe + fallback save, then a probe-free second save'
  );
  const save = cloud.calls[1];
  assert.strictEqual(save.action, 'saveAll');
  assert.strictEqual(save.customers.length, 1);
  assert.strictEqual(save.transactions.length, 3000);
  assert.strictEqual(Object.keys(save.seen).length, 100);
  assert.strictEqual(save.customerTx.C0.length, 1);

  // The second large save in the same session skips the doomed probe.
  assert.strictEqual(second, true);
  assert.strictEqual(cloud.store.spaxCloudChunked, '0', 'one-shot backend must be remembered');
});

test('a new session re-probes a remembered one-shot backend (a later chunked deploy is picked up)', async () => {
  const cloud = makeCloud({ chunked: true });
  cloud.store.spaxCloudChunked = '0'; // remembered from a previous session
  const { first } = await runClient(cloud, bigDB());

  assert.strictEqual(first, true);
  const actions = cloud.calls.map((c) => c.action);
  assert.strictEqual(actions[0], 'saveBegin');
  assert.strictEqual(actions[actions.length - 1], 'saveCommit', 'fresh session must retry chunked saves');
  assert.strictEqual(cloud.store.spaxCloudChunked, '1');
});

test('small saves stay a single saveAll request on every backend', async () => {
  const cloud = makeCloud({ chunked: true });
  const db = bigDB();
  db.transactions = db.transactions.slice(0, 10);
  db.customerTx = { C0: [{ date: '2026-08-31', amount: 100 }] };
  db.seen = { 'receipt|R0|2026-08-31|': 1 };

  const { first } = await runClient(cloud, db);
  assert.strictEqual(first, true);
  assert.deepStrictEqual(
    cloud.calls.map((c) => c.action),
    ['saveAll'],
    'payloads at or under CHUNK_ROWS must not be chunked'
  );
});

/* ── source-level pins ───────────────────────────────────────────────────── */

/* ── upload session guard + probe resilience (backend v3.0 era) ──────────── */

test('the uploadId from saveBegin is echoed on every chunk and the commit', async () => {
  const cloud = makeCloud({ chunked: true, uploadIds: true });
  const { first } = await runClient(cloud, bigDB());

  assert.strictEqual(first, true);
  cloud.calls
    .filter((c) => c.action === 'saveChunk' || c.action === 'saveCommit')
    .forEach((c) => assert.strictEqual(c.uploadId, 'upload-123', c.action + ' must echo the uploadId'));
});

test('a chunk-capable backend that predates uploadIds still syncs (uploadId: "")', async () => {
  const cloud = makeCloud({ chunked: true, uploadIds: false });
  const { first } = await runClient(cloud, bigDB());

  assert.strictEqual(first, true);
  const actions = cloud.calls.map((c) => c.action);
  assert.strictEqual(actions[0], 'saveBegin');
  assert.strictEqual(actions[actions.length - 1], 'saveCommit');
});

test('a transient probe failure falls back to one saveAll without poisoning the capability cache', async () => {
  const cloud = makeCloud({ chunked: true, failBeginTimes: 1 });
  const { first, second } = await runClient(cloud, bigDB(), { saveTwice: true });

  // First save: the probe died with HTTP 500 (NOT "unknown action"), so the
  // client must not conclude the backend is saveAll-only — it saves via the
  // one-shot path this once and leaves the cache alone.
  assert.strictEqual(first, true);
  assert.deepStrictEqual(
    cloud.calls.map((c) => c.action).slice(0, 2),
    ['saveBegin', 'saveAll']
  );
  assert.notStrictEqual(cloud.store.spaxCloudChunked, '0', 'transient probe failure must not be cached as one-shot');

  // Second save in the same session: still unprobed, so it tries chunked
  // again — and this time the backend answers, so it goes up in slices.
  const actions = cloud.calls.map((c) => c.action);
  assert.ok(actions.includes('saveChunk'), 'second save should retry the chunked protocol');
  assert.strictEqual(actions[actions.length - 1], 'saveCommit');
  assert.strictEqual(second, true);
});

test('forced saves queue behind each other — never two requests in flight', async () => {
  const cloud = makeCloud({ chunked: true });
  const db = bigDB();
  db.transactions = db.transactions.slice(0, 10); // small save → single saveAll each
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, db, status));

  let inFlight = 0;
  let maxInFlight = 0;
  const inner = cloud.fetchImpl;
  cloud.fetchImpl = async (url, options) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 15));
      return await inner(url, options);
    } finally {
      inFlight -= 1;
    }
  };
  ctx.fetch = cloud.fetchImpl;

  vm.runInContext(syncLayerSource(), ctx);
  const [a, b] = await Promise.all([ctx.saveToCloud(true), ctx.saveToCloud(true)]);

  assert.strictEqual(a, true);
  assert.strictEqual(b, true);
  assert.strictEqual(maxInFlight, 1, 'saves must be serialized — overlapping POSTs fight over the backend script lock');
  assert.strictEqual(cloud.calls.filter((c) => c.action === 'saveAll').length, 2);
});

/* ── source-level pins ───────────────────────────────────────────────────── */

test('backend v3.0 ships the chunked staging actions alongside saveAll', () => {
  assert.match(GAS, /action === 'saveAll'/);
  assert.match(GAS, /action === 'saveBegin'/);
  assert.match(GAS, /action === 'saveChunk'/);
  assert.match(GAS, /action === 'saveCommit'/);
  // The commit verifies staged counts BEFORE swapping any live sheet.
  assert.match(GAS, /chunk mismatch on /);
  assert.match(GAS, /live data left untouched/);
  // An upload session id guards against interleaved uploads.
  assert.match(GAS, /uploadId/);
});

test('client keeps payload-aware timeouts and wires the chunked actions + fallback', () => {
  assert.match(HTML, /controller\.abort\(\), timeoutMs/, 'cloudRequest timeout must be parameterized');
  assert.match(HTML, /CLOUD_TIMEOUT_DEFAULT = 30000/);
  assert.match(HTML, /CLOUD_TIMEOUT_CHUNK = 60000/);
  assert.match(HTML, /CLOUD_TIMEOUT_LOAD = 90000/);
  assert.match(HTML, /CLOUD_TIMEOUT_BIG_SAVE = 180000/);
  assert.match(HTML, /const CHUNK_ROWS = 2000/);
  assert.match(HTML, /action: 'saveBegin'/);
  assert.match(HTML, /action: 'saveChunk'/);
  assert.match(HTML, /action: 'saveCommit'/);
  assert.match(HTML, /isUnknownActionError/, 'the unknown-action fallback must stay wired');
  assert.match(HTML, /spaxCloudChunked/, 'backend capability must be cached');
  assert.match(HTML, /uploadId/, 'the upload session id must be echoed');
});

test('loadFromCloud does not force a push-back save', () => {
  const fn = HTML.slice(HTML.indexOf('async function loadFromCloud'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const live = body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/saveToCloud\(/.test(live), 'load must not trigger a forced save');
});
