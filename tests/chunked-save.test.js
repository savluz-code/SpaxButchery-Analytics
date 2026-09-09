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
function makeCloud({ chunked = true, uploadIds = true, failChunk = 0, dropChunk = 0, doubleSend = 0, failBeginTimes = 0 } = {}) {
  const calls = [];
  const staged = { transactions: [], customerTx: [], seen: [] };
  const stagedSeqs = new Set(); // (table, seq) pairs already staged this session
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
      // A new upload session stages from empty, exactly like the real backend.
      staged.transactions = []; staged.customerTx = []; staged.seen = [];
      stagedSeqs.clear();
      return respond({ success: true, ...(uploadIds ? { uploadId: 'upload-123' } : {}) });
    }
    if (body.action === 'saveChunk') {
      chunkNo += 1;
      if (failChunk === chunkNo) return respond({ success: false, error: 'chunk write failed' });
      // `doubleSend` hands the SAME POST to the backend twice — what a
      // retrying proxy or a second tab does. The v3.2 seq bookkeeping makes the
      // second copy a no-op; a backend without it stages the slice twice and
      // the commit then refuses with the reported "staged N rows, expected M".
      const deliveries = doubleSend === chunkNo ? 2 : 1;
      let res = null;
      for (let d = 0; d < deliveries; d++) {
        const seqKey = body.table + ':' + body.seq;
        if (body.seq !== undefined && stagedSeqs.has(seqKey)) {
          res = { success: true, written: 0, duplicate: true };
          continue;
        }
        if (dropChunk !== chunkNo) (staged[body.table] || []).push(...body.rows);
        if (body.seq !== undefined) stagedSeqs.add(seqKey);
        res = { success: true, written: dropChunk === chunkNo ? 0 : body.rows.length };
      }
      return respond(res);
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

async function runClient(cloud, db, { saveTwice = false, fastBusy = false } = {}) {
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, db, status));
  // Busy-retry backoffs are multi-second in production (outlast a server-side
  // write). Tests that exercise the busy path pass fastBusy so they don't
  // sit on real wall-clock delays.
  let src = syncLayerSource();
  if (fastBusy) {
    src = src.replace(
      /const CLOUD_BUSY_RETRY_DELAYS = \[[^\]]+\];/,
      'const CLOUD_BUSY_RETRY_DELAYS = [5, 5, 5, 5, 5, 5];'
    );
  }
  vm.runInContext(src, ctx);
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

test('every slice carries a per-table seq, so the backend can recognise a replay', async () => {
  const cloud = makeCloud({ chunked: true });
  const { first } = await runClient(cloud, bigDB());
  assert.strictEqual(first, true);

  const chunks = cloud.calls.filter((c) => c.action === 'saveChunk');
  // 3000 transactions → 2 slices, then customerTx (50) and seen (100) → 1 each.
  assert.deepStrictEqual(
    chunks.map((c) => [c.table, c.seq]),
    [['transactions', 0], ['transactions', 1], ['customerTx', 0], ['seen', 0]]
  );
  assert.ok(chunks.every((c) => Number.isInteger(c.seq)), 'seq must be a number, not undefined');
});

test('a slice delivered twice still saves — the seq stops it staging twice', async () => {
  // A retrying proxy hands the second transactions slice to the backend twice.
  // Without `seq` that stages 4000 rows against a promise of 3000 and the
  // commit refuses ("staged 4000 rows, expected 3000"); with it the backend
  // recognises the replay, answers { written: 0, duplicate: true }, and the
  // save carries on to a successful commit.
  const cloud = makeCloud({ chunked: true, doubleSend: 2 });
  const { first, lastCloudError } = await runClient(cloud, bigDB());

  assert.strictEqual(first, true, 'a replayed slice must not fail the save');
  assert.strictEqual(lastCloudError, '');
  assert.strictEqual(cloud.staged.transactions.length, 3000, 'the replayed slice must not be staged twice');
  assert.ok(cloud.calls.some((c) => c.action === 'saveCommit'), 'the save must still go on to commit');
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

test('background saves coalesce into ONE queued slot while forced saves queue individually — shown as 1/3…3/3', async () => {
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
      await new Promise((r) => setTimeout(r, 20));
      return await inner(url, options);
    } finally {
      inFlight -= 1;
    }
  };
  ctx.fetch = cloud.fetchImpl;

  vm.runInContext(syncLayerSource(), ctx);
  const first = ctx.saveToCloud(true); // forced #1 starts
  const bgA = ctx.saveToCloud(false); // background while #1 runs → queued slot
  const bgB = ctx.saveToCloud(false); // second background → SAME slot (coalesced)
  const forced2 = ctx.saveToCloud(true); // forced → its own slot

  assert.strictEqual(bgA, bgB, 'background saves while one is queued must share one promise');
  assert.strictEqual(vm.runInContext('cloudSaveQueue.length', ctx), 2, 'one shared background slot + one forced slot');
  assert.strictEqual(vm.runInContext('cloudSavePos', ctx), 1, 'the running job is task 1');

  const results = await Promise.all([first, bgA, bgB, forced2]);
  assert.deepStrictEqual(results, [true, true, true, true]);
  assert.strictEqual(maxInFlight, 1, 'the queue must keep saves strictly serialized');
  assert.strictEqual(cloud.calls.filter((c) => c.action === 'saveAll').length, 3,
    '3 uploads: forced #1, ONE coalesced background save, forced #2');
  assert.strictEqual(vm.runInContext('cloudSaveQueue.length', ctx), 0);
  assert.strictEqual(vm.runInContext('cloudSaveRunning', ctx), false);

  // The pill tells the user what is going on the whole time: 1/3 → 2/3 → 3/3,
  // with the remaining count on every completion.
  assert.ok(status.some((m) => /Saving to cloud… 1\/3/.test(m)), 'running save must show its queue position');
  assert.ok(status.some((m) => /✅ Save 1\/3 complete — 2 more queued/.test(m)), 'first completion must announce the rest');
  assert.ok(status.some((m) => /✅ Save 2\/3 complete — 1 more queued/.test(m)), 'second completion must announce the rest');
  assert.ok(status.some((m) => /✅ Save 3\/3 complete/.test(m)), 'last completion must not claim queued tasks');
});

test('a queued save that fails stays visible and the queue keeps going for the next task', async () => {
  const cloud = makeCloud({ chunked: true });
  const db = bigDB();
  db.transactions = db.transactions.slice(0, 10);
  db.customerTx = {};
  db.seen = {};
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, db, status));

  let saveAllNo = 0;
  const inner = cloud.fetchImpl;
  cloud.fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'saveAll') {
      saveAllNo += 1;
      if (saveAllNo === 2) { // the middle task of three
        cloud.calls.push(body);
        return { ok: true, text: async () => JSON.stringify({ success: false, error: 'cloud rejected the save' }) };
      }
    }
    return inner(url, options);
  };
  ctx.fetch = cloud.fetchImpl;

  vm.runInContext(syncLayerSource(), ctx);
  const first = ctx.saveToCloud(true); // task 1 — succeeds
  const doomed = ctx.saveToCloud(true); // task 2 — fails
  const after = ctx.saveToCloud(true); // task 3 — must still run

  const results = await Promise.all([first, doomed, after]);
  assert.deepStrictEqual(results, [true, false, true], 'a failed queued save must not poison the queue');
  assert.ok(status.some((m) => /❌ Save 2\/3 failed: cloud rejected the save/.test(m)), 'the failure must name its queue position');
  assert.ok(status.some((m) => /✅ Save 3\/3 complete/.test(m)), 'the task behind the failure must still run');
  assert.strictEqual(vm.runInContext('cloudSaveQueue.length', ctx), 0);
});

test('a backend-busy response retries a small save automatically', async () => {
  const cloud = makeCloud({ chunked: true });
  const db = bigDB();
  db.transactions = db.transactions.slice(0, 10); // keep this on the saveAll path
  db.customerTx = {};
  db.seen = {};
  const inner = cloud.fetchImpl;
  let busy = true;
  cloud.fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (busy && body.action === 'saveAll') {
      busy = false;
      cloud.calls.push(body);
      return { ok: true, text: async () => JSON.stringify({
        success: false,
        error: 'backend busy with another save — please retry the save'
      }) };
    }
    return inner(url, options);
  };

  const { first, status, lastCloudError } = await runClient(cloud, db, { fastBusy: true });
  assert.strictEqual(first, true, 'a transient lock collision should not surface as a failed push');
  assert.strictEqual(lastCloudError, '');
  assert.strictEqual(cloud.calls.map((c) => c.action).join(','), 'saveAll,saveAll');
  assert.ok(status.some((message) => /retrying/.test(message)), 'the retry should be visible');
});

test('a busy response during a chunked upload restarts from saveBegin', async () => {
  const cloud = makeCloud({ chunked: true });
  const inner = cloud.fetchImpl;
  let busy = true;
  cloud.fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (busy && body.action === 'saveChunk') {
      busy = false;
      cloud.calls.push(body);
      return { ok: true, text: async () => JSON.stringify({
        success: false,
        error: 'backend busy with another save — please retry the save'
      }) };
    }
    return inner(url, options);
  };

  const { first, lastCloudError } = await runClient(cloud, bigDB(), { fastBusy: true });
  assert.strictEqual(first, true);
  assert.strictEqual(lastCloudError, '');
  const actions = cloud.calls.map((c) => c.action);
  assert.strictEqual(actions[0], 'saveBegin');
  assert.strictEqual(actions[1], 'saveChunk');
  assert.strictEqual(actions[2], 'saveBegin', 'retry must reset the chunked upload');
  assert.strictEqual(actions[actions.length - 1], 'saveCommit');
});

test('busy retries keep isSyncing true so a concurrent save cannot start', async () => {
  // Regression for the permanent "backend busy" loop: a bare
  // `return performSaveToCloud(next)` runs `finally { isSyncing = false }`
  // the moment the inner call is *scheduled*, not when it finishes. That
  // let save() fire a second POST while the first was still mid-retry, and
  // the second POST then hit the lock the first still held.
  const cloud = makeCloud({ chunked: true });
  const db = bigDB();
  db.transactions = db.transactions.slice(0, 10);
  db.customerTx = {};
  db.seen = {};

  let busyHits = 0;
  const inner = cloud.fetchImpl;
  cloud.fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'saveAll' && busyHits < 2) {
      busyHits += 1;
      cloud.calls.push(body);
      // Hold the "lock" briefly so a concurrent save would race if isSyncing
      // were cleared mid-retry.
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, text: async () => JSON.stringify({
        success: false,
        error: 'backend busy with another save — please retry the save'
      }) };
    }
    return inner(url, options);
  };

  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, db, status));
  // Speed up busy backoffs so the test does not wait real seconds.
  const src = syncLayerSource()
    .replace(/const CLOUD_BUSY_RETRY_DELAYS = \[[^\]]+\];/, 'const CLOUD_BUSY_RETRY_DELAYS = [5, 5, 5, 5, 5, 5];');
  vm.runInContext(src, ctx);

  const first = ctx.saveToCloud(true);
  // While the first save is mid-busy-retry, a background save must QUEUE (not
  // start, not vanish) and a forced save queues in its own slot — the queue
  // slot, not isSyncing, is what serializes them now.
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(vm.runInContext('cloudSaveRunning', ctx), true, 'first save still in flight');
  const bg = ctx.saveToCloud(false);
  const forced = ctx.saveToCloud(true);
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(vm.runInContext('cloudSaveQueue.length', ctx), 2,
    'background save + forced save must both be queued, never silently dropped');
  assert.strictEqual(vm.runInContext('cloudSaveQueue[0].auto', ctx), true);
  assert.strictEqual(vm.runInContext('cloudSaveQueue[1].force', ctx), true);

  const results = await Promise.all([first, bg, forced]);
  assert.deepStrictEqual(results, [true, true, true], 'every queued save must eventually succeed');
  assert.strictEqual(vm.runInContext('isSyncing', ctx), false, 'isSyncing must clear only after the whole chain');
  assert.strictEqual(vm.runInContext('cloudSaveRunning', ctx), false, 'queue must drain fully');
  assert.strictEqual(vm.runInContext('cloudSaveQueue.length', ctx), 0);
  // One failed attempt ×2 busy, then one success — never two concurrent POSTs.
  assert.ok(cloud.calls.filter((c) => c.action === 'saveAll').length >= 3);
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

test('backend v3.2 can tell a repeated slice from a lost one', () => {
  // Chunks are recorded per session so a replay is skipped instead of appended.
  assert.match(GAS, /chunkAlreadyStaged_/);
  assert.match(GAS, /recordChunkSeq_/);
  // `seen` is a set of dedup keys: verified by distinct keys, de-duplicated
  // before the swap, so a repeated slice cannot fail an otherwise complete save.
  assert.match(GAS, /IDEMPOTENT_TABLES/);
  assert.match(GAS, /dedupeStaged_/);
  // The commit checks the session id too, and a refusal leaves staging empty.
  assert.match(GAS, /function saveCommit_\(body\) \{\n[\s\S]{0,240}uploadSessionValid_/);
  assert.match(GAS, /function resetStaging_/);
  // waitLock's answer is honoured rather than ignored.
  assert.ok(!/^\s*lock\.waitLock\(30000\);\s*$/m.test(GAS), 'waitLock result must not be discarded');
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
  assert.match(HTML, /isBackendBusyError/, 'a lock collision must be retried');
  assert.match(HTML, /CLOUD_BUSY_RETRIES/, 'busy retries must be bounded');
  // Busy retries must await the recursive call and only clear isSyncing on the
  // outermost attempt — otherwise a concurrent save starts mid-retry.
  assert.match(HTML, /return await performSaveToCloud\(nextRetry\)/);
  assert.match(HTML, /if \(busyRetry === 0\) isSyncing = false/);
  // The save queue: background saves coalesce into one slot (never silently
  // dropped), forced saves each get a slot, and the queue announces itself.
  assert.match(HTML, /if \(!force && cloudSaveAutoPromise\) return cloudSaveAutoPromise/, 'background saves must coalesce, not disappear');
  assert.match(HTML, /cloudSaveQueue\.push\(job\)/, 'every save must take a place in the queue');
  assert.match(HTML, /'⏳ Saving to cloud… ' \+ cloudSavePos \+ '\/' \+ total/, 'the pill must show "Saving to cloud… 1/3"');
  assert.match(HTML, /'✅ Save ' \+ cloudSavePos \+ '\/' \+ total \+ ' complete' \+ rest/, 'completions must report the queue position');
  assert.match(HTML, /Save queue complete/, 'the batch completion must be announced');
  assert.match(HTML, /cloudSaveAnnounceRunning\(\)/, 'a running save must re-announce when tasks are queued behind it');
  // importTransactions must NOT fire its own cloud push — callers persist.
  // Strip comments first so the "Do NOT saveToCloud()" note doesn't match.
  const importBody = HTML.slice(
    HTML.indexOf('function importTransactions(txs, opts = {}) {'),
    HTML.indexOf('/* ══════════ 1-CLICK ROLLBACK DUPLICATE REVENUE')
  ).split('\n').filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)).join('\n');
  assert.ok(!/saveToCloud\s*\(/.test(importBody), 'import must not nest a cloud push (collides with rebuild wipe push)');
  assert.ok(!/\bsave\s*\(\s*\)/.test(importBody), 'import must not call save() — callers persist after it returns');
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
