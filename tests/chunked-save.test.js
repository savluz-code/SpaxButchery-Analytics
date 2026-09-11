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
 *   • The `seen` dedup map is NOT uploaded: it is derivable from the
 *     transactions table (healOrphanedSeenKeys enforces that invariant on
 *     every boot), so syncing it re-sent ~half the database on every save.
 *     The cloud sheet stays empty and every device rebuilds its guard from
 *     the transactions it holds on load.
 *   • An interrupted upload RESUMES from the last acknowledged slice: the
 *     upload session (uploadId, per-table seq cursors, promised counts and
 *     a fingerprint of the data) is persisted after every ack, so the
 *     "Resuming the interrupted save…" on boot continues the upload instead
 *     of restarting the whole database from zero — the loop that made big
 *     saves look like they never end.
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
  // `seen` is deliberately absent: the dedup map is derivable from the
  // transactions table, so it is no longer uploaded (the cloud sheet stays
  // empty and each device rebuilds its guard on load).
  const chunks = cloud.calls.filter((c) => c.action === 'saveChunk');
  assert.deepStrictEqual(
    chunks.map((c) => c.table),
    ['transactions', 'transactions', 'customerTx']
  );
  chunks.forEach((c) => assert.ok(c.rows.length <= 2000, 'chunk over CHUNK_ROWS: ' + c.rows.length));
  assert.strictEqual(chunks.filter((c) => c.table === 'transactions').flatMap((c) => c.rows).length, 3000);
  assert.strictEqual(chunks.filter((c) => c.table === 'customerTx').flatMap((c) => c.rows).length, 50);
  assert.strictEqual(chunks.filter((c) => c.table === 'seen').length, 0, 'the seen map must not be uploaded');
  cloud.calls.forEach((c) => assert.strictEqual(c.seen, undefined, c.action + ' must not carry a seen table'));

  // saveCommit promises exactly what was sent.
  assert.deepStrictEqual(cloud.calls[cloud.calls.length - 1].expect, {
    transactions: 3000,
    customerTx: 50
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
  // 3000 transactions → 2 slices, then customerTx (50) → 1.
  assert.deepStrictEqual(
    chunks.map((c) => [c.table, c.seq]),
    [['transactions', 0], ['transactions', 1], ['customerTx', 0]]
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
  assert.strictEqual(save.seen, undefined, 'the one-shot save must not carry the derivable seen map either');
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
  const first = ctx.saveToCloud(true, '🚀 Force Push'); // forced #1 starts
  const bgA = ctx.saveToCloud(false, '💾 Auto-save'); // background while #1 runs → queued slot
  const bgB = ctx.saveToCloud(false, '💾 Auto-save'); // second background → SAME slot (coalesced)
  const forced2 = ctx.saveToCloud(true, '📥 Backfill'); // forced → its own slot

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

  // The pill names the save in flight AND the ones waiting, the whole time:
  // 1/3 → 2/3 → 3/3, so "what is saving?" never has a generic answer.
  assert.ok(status.some((m) => /Saving to cloud — 🚀 Force Push \(1\/3\)/.test(m)), 'the pill must name the running save and its queue position');
  assert.ok(status.some((m) => /next: 💾 Auto-save, 📥 Backfill/.test(m)), 'the pill must name the saves waiting behind it');
  assert.ok(status.some((m) => /✅ Saved to cloud — 🚀 Force Push \(1\/3\)/.test(m)), 'first completion must name itself and its position');
  assert.ok(status.some((m) => /✅ Saved to cloud — 💾 Auto-save \(2\/3\)/.test(m)), 'second completion must name itself');
  assert.ok(status.some((m) => /✅ Saved to cloud — 📥 Backfill \(3\/3\)/.test(m)), 'last completion must not claim queued tasks');
  assert.ok(!status.some((m) => /another save/i.test(m)), 'no message may fall back to a generic "another save"');
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
  const first = ctx.saveToCloud(true, '🚀 Force Push'); // task 1 — succeeds
  const doomed = ctx.saveToCloud(true, '🔀 Smart Merge'); // task 2 — fails
  const after = ctx.saveToCloud(true, '📥 Backfill'); // task 3 — must still run

  const results = await Promise.all([first, doomed, after]);
  assert.deepStrictEqual(results, [true, false, true], 'a failed queued save must not poison the queue');
  assert.ok(status.some((m) => /❌ Save failed — 🔀 Smart Merge \(2\/3\): cloud rejected the save/.test(m)),
    'the failure must name the save that failed and its queue position');
  assert.ok(status.some((m) => /✅ Saved to cloud — 📥 Backfill \(3\/3\)/.test(m)), 'the task behind the failure must still run');
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

test('a busy response during a chunked upload resumes the same session once the lock frees', async () => {
  // "backend busy" means the backend refused the request WITHOUT touching the
  // staging area (waitLock honouring), so the retry has nothing to reset: it
  // picks the upload back up from the last acknowledged slice and continues
  // under the same uploadId. A writer that DID reset the staging area is
  // caught by the server (supersession / commit count check) and answered
  // with a fresh saveBegin — that path is pinned below.
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
  assert.strictEqual(actions[1], 'saveChunk', 'the busy refusal happens on the first slice');
  assert.strictEqual(
    actions.filter((a) => a === 'saveBegin').length,
    1,
    'a refused-before-write busy needs no fresh saveBegin — the session resumes'
  );
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

/* ── interrupted uploads resume from the last acknowledged slice ─────────── */

test('an upload interrupted mid-flight resumes from the last acknowledged slice', async () => {
  // The phone kills the tab mid-upload (the 3rd slice dies). The next save
  // must CONTINUE from the slice that was never acknowledged — not restart
  // the whole database from saveBegin, which is what made "Resuming the
  // interrupted save…" go on forever: the upload needed more continuous
  // foreground time than the user ever gave it, so starting over never won.
  const cloud = makeCloud({ chunked: true, failChunk: 3 });
  const db = bigDB();
  const run1 = await runClient(cloud, db);
  assert.strictEqual(run1.first, false, 'the interrupted save fails');
  assert.match(run1.lastCloudError, /chunk write failed/);
  // The session survived: both transactions slices (2,000 + 1,000 rows)
  // acknowledged, customerTx never started.
  const session = JSON.parse(cloud.store.spaxUploadSession);
  assert.deepStrictEqual(session.cursors, { transactions: 2, customerTx: 0 });
  assert.strictEqual(session.sent, 3000);

  // Where run 1's requests end — everything after this is the resumed save.
  const callsAfterRun1 = cloud.calls.length;
  const run2 = await runClient(cloud, db);
  assert.strictEqual(run2.first, true, 'the resumed save completes');
  assert.ok(run2.status.some((m) => /resuming interrupted upload/.test(m)), 'the resume must be announced');
  // Exactly ONE saveBegin across both runs — the second save never restarted.
  assert.strictEqual(cloud.calls.filter((c) => c.action === 'saveBegin').length, 1);
  // Run 2 sends exactly ONE slice — the one that was never acknowledged —
  // and then commits. The two acknowledged slices are not re-sent.
  const run2Calls = cloud.calls.slice(callsAfterRun1);
  assert.deepStrictEqual(
    run2Calls.map((c) => c.action),
    ['saveChunk', 'saveCommit'],
    'the resumed save must be one owed slice + the commit, nothing more'
  );
  assert.deepStrictEqual([run2Calls[0].table, run2Calls[0].seq], ['customerTx', 0]);
  assert.deepStrictEqual(run2Calls[1].expect, { transactions: 3000, customerTx: 50 });
  // Progress is legible in absolute rows, not just a percentage.
  assert.ok(run2.status.some((m) => /3,050\/3,050 rows/.test(m)), 'progress must show absolute rows');
  // A finished upload leaves no session behind.
  assert.strictEqual(cloud.store.spaxUploadSession, undefined);
});

test('a session the server no longer holds falls back to a fresh saveBegin', async () => {
  const cloud = makeCloud({ chunked: true, failChunk: 1 });
  const db = bigDB();
  const run1 = await runClient(cloud, db);
  assert.strictEqual(run1.first, false);
  assert.ok(cloud.store.spaxUploadSession, 'session persisted after the interrupted upload');

  // Another device saveBegin'd in the meantime: our uploadId is stale and
  // the server answers the commit with "upload superseded by a newer save".
  // That must not fail the save — it restarts from saveBegin, in the same
  // save, and still lands the data.
  const session = JSON.parse(cloud.store.spaxUploadSession);
  session.uploadId = 'someone-elses-upload';
  session.cursors = { transactions: 2, customerTx: 1 }; // everything "sent"
  cloud.store.spaxUploadSession = JSON.stringify(session);

  const run2 = await runClient(cloud, db);
  assert.strictEqual(run2.first, true, 'the save recovers by restarting from saveBegin');
  const actions = cloud.calls.map((c) => c.action);
  assert.strictEqual(actions.filter((a) => a === 'saveBegin').length, 2, 'the fallback starts a fresh session');
  assert.strictEqual(actions.filter((a) => a === 'saveCommit').length, 2, 'the superseded commit was attempted first');
  assert.strictEqual(actions[actions.length - 1], 'saveCommit');
  assert.strictEqual(cloud.store.spaxUploadSession, undefined, 'the finished save leaves no session behind');
});

test('a database that changed since the session started does not resume', async () => {
  const cloud = makeCloud({ chunked: true, failChunk: 1 });
  const db = bigDB();
  const run1 = await runClient(cloud, db);
  assert.strictEqual(run1.first, false);
  assert.ok(cloud.store.spaxUploadSession);

  // The user imported more rows before the retry: the fingerprint no longer
  // matches, so resuming the old session would stitch two different
  // snapshots into one sheet.
  db.transactions.push({ date: '2026-09-11', time: '09:00:00', amount: 420, name: 'C9', phone: '254799', receipt: 'R9Z' });

  const run2 = await runClient(cloud, db);
  assert.strictEqual(run2.first, true);
  assert.strictEqual(cloud.calls.filter((c) => c.action === 'saveBegin').length, 2,
    'a changed database must start a fresh upload, not resume');
  assert.ok(!run2.status.some((m) => /resuming interrupted upload/.test(m)), 'no resume may be attempted');
  assert.deepStrictEqual(cloud.calls[cloud.calls.length - 1].expect, { transactions: 3001, customerTx: 50 });
});

test('a successful one-shot saveAll discards any interrupted chunked session', async () => {
  const cloud = makeCloud({ chunked: true, failChunk: 1 });
  const db = bigDB();
  const run1 = await runClient(cloud, db);
  assert.strictEqual(run1.first, false);
  assert.ok(cloud.store.spaxUploadSession, 'session persisted after the interrupted upload');

  // The database shrinks below the chunk threshold (Delete All, or a smaller
  // rebuild): the save goes up as ONE saveAll whose swap wiped the staging
  // area — the stale session must not survive it.
  db.transactions = db.transactions.slice(0, 10);
  db.customerTx = {};
  const run2 = await runClient(cloud, db);
  assert.strictEqual(run2.first, true);
  assert.strictEqual(cloud.calls[cloud.calls.length - 1].action, 'saveAll');
  assert.strictEqual(cloud.store.spaxUploadSession, undefined, 'saveAll swapped every sheet — the session is dead');
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
  // Every save is named: the pill, the completions and the failures all say
  // WHICH save they mean, so nothing is ever reported as "another save".
  assert.match(HTML, /'⏳ Saving to cloud — ' \+ cloudSaveRunningName\(\)/, 'the pill must name the save that is running');
  assert.match(HTML, /'✅ Saved to cloud — ' \+ cloudSaveRunningName\(\)/, 'completions must name the save that landed');
  assert.match(HTML, /'❌ Save failed — ' \+ cloudSaveRunningName\(\)/, 'failures must name the save that failed');
  assert.match(HTML, /const CLOUD_SAVE_NAMES = \{/, 'saves must be drawn from a fixed set of names');
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

/* ── pre-emption: Delete All stops an in-flight save and goes first ──────── */

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A cloud whose FIRST saveChunk never answers on its own — it only settles
 * when the request's abort signal fires, exactly like a real fetch. That
 * gives a genuinely in-flight upload to pre-empt.
 */
function makeHangingCloud(cloud) {
  const inner = cloud.fetchImpl;
  // Chunks are counted PER upload session (each saveBegin starts one), so a
  // test can tell the stopped upload's slices apart from the wipe's own.
  // `abortSignals` counts requests whose signal actually fired: the cancel
  // flag alone also stops the loop between slices, but only a real abort
  // makes the pre-emption IMMEDIATE instead of waiting out the chunk timeout.
  const state = { session: 0, chunksPerSession: {}, abortSignals: 0, aborted: false };
  cloud.fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'saveBegin') state.session += 1;
    if (body.action === 'saveChunk') {
      state.chunksPerSession[state.session] = (state.chunksPerSession[state.session] || 0) + 1;
      if (state.session === 1 && state.chunksPerSession[1] === 1) {
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            state.abortSignals += 1;
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          };
          if (options.signal && options.signal.aborted) return onAbort();
          if (options.signal) options.signal.addEventListener('abort', onAbort);
          // Only the abort is meant to end this. The fallback is short and
          // unref'd so a missing abort fails the assertion fast instead of
          // stalling the suite.
          setTimeout(resolve, 2000).unref();
        });
      }
    }
    return inner(url, options);
  };
  return state;
}

test('Delete All pre-empts an in-flight upload: the upload is aborted and the wipe goes first', async () => {
  const cloud = makeCloud({ chunked: true });
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, bigDB(), status));
  const state = makeHangingCloud(cloud);
  ctx.fetch = cloud.fetchImpl;

  vm.runInContext(syncLayerSource(), ctx);
  const backfill = ctx.saveToCloud(true, '📥 Backfill'); // starts, then hangs on slice 1
  await tick();
  assert.strictEqual(vm.runInContext('cloudSaveRunning', ctx), true, 'the Backfill upload is in flight');
  assert.strictEqual(state.chunksPerSession[1], 1, 'it reached the first slice');
  assert.ok(status.some((m) => /Saving to cloud — 📥 Backfill/.test(m)), 'the pill names the save in flight');

  // Delete All arrives while that upload is still going.
  const stopped = vm.runInContext("cloudSavePreempt('🗑️ Delete All')", ctx);
  assert.deepStrictEqual(Array.from(stopped), ['📥 Backfill'], 'the pre-emption reports the save it stopped, by name');
  assert.strictEqual(state.abortSignals, 1,
    'the in-flight request must be ABORTED — the cancel flag alone would leave it running to its timeout');
  state.aborted = true;
  const wipe = ctx.saveToCloud(true, '🗑️ Delete All');

  const [backfillResult, wipeResult] = await Promise.all([backfill, wipe]);
  assert.strictEqual(backfillResult, false, 'the stopped upload resolves false — it did not land');
  assert.strictEqual(wipeResult, true, 'the wipe goes through without waiting for the stopped upload');
  assert.strictEqual(state.chunksPerSession[1], 1, 'the stopped upload sent no further slices');
  assert.strictEqual(state.session, 2, 'the wipe ran as its own upload session');
  assert.ok(state.chunksPerSession[2] > 1, 'the wipe uploaded in full');
  assert.strictEqual(vm.runInContext('cloudSaveRunning', ctx), false, 'the slot is released, not leaked');
  assert.strictEqual(vm.runInContext('cloudSaveRunningJob', ctx), null);

  const actions = cloud.calls.map((c) => c.action);
  assert.ok(actions.indexOf('saveCommit') === -1 || actions[actions.length - 1] === 'saveCommit',
    'the stopped chunked upload must never commit stale data');
});

test('a stopped upload is reported as stopped, never as a failed save', async () => {
  const cloud = makeCloud({ chunked: true });
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, bigDB(), status));
  makeHangingCloud(cloud);
  ctx.fetch = cloud.fetchImpl;

  vm.runInContext(syncLayerSource(), ctx);
  const backfill = ctx.saveToCloud(true, '📥 Backfill');
  await tick();
  vm.runInContext("cloudSavePreempt('🗑️ Delete All')", ctx);
  await backfill;

  assert.ok(!status.some((m) => /❌/.test(m)), 'a save the user deliberately superseded is not a failure');
  assert.ok(!status.some((m) => /timed out/i.test(m)), 'a cancel must not be reported as a timeout');
  assert.strictEqual(vm.runInContext('lastCloudError', ctx), '', 'a cancel leaves no cloud error behind');
  assert.strictEqual(vm.runInContext('cloudStoppedUpload', ctx), '📥 Backfill',
    'the stopped upload is remembered so a busy retry can name it');
});

test('pre-emption drops every queued save and names each one it drops', async () => {
  const cloud = makeCloud({ chunked: true });
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, bigDB(), status));
  makeHangingCloud(cloud);
  ctx.fetch = cloud.fetchImpl;

  vm.runInContext(syncLayerSource(), ctx);
  const running = ctx.saveToCloud(true, '📥 Backfill');
  await tick();
  const queuedAuto = ctx.saveToCloud(false, '💾 Auto-save');
  const queuedMerge = ctx.saveToCloud(true, '🔀 Smart Merge');
  assert.strictEqual(vm.runInContext('cloudSaveQueue.length', ctx), 2);

  const stopped = vm.runInContext("cloudSavePreempt('🗑️ Delete All')", ctx);
  assert.deepStrictEqual(Array.from(stopped), ['📥 Backfill', '💾 Auto-save', '🔀 Smart Merge'],
    'the running save and both queued saves are named, in order');
  assert.strictEqual(vm.runInContext('cloudSaveQueue.length', ctx), 0, 'the queue is emptied');

  const wipe = ctx.saveToCloud(true, '🗑️ Delete All');
  assert.deepStrictEqual(await Promise.all([running, queuedAuto, queuedMerge, wipe]),
    [false, false, false, true], 'dropped saves resolve false; only the wipe lands');
});

test('a busy retry names the upload this device stopped instead of saying "another save"', async () => {
  const cloud = makeCloud({ chunked: true });
  const db = bigDB();
  db.transactions = db.transactions.slice(0, 10); // keep this on the saveAll path
  db.customerTx = {};
  db.seen = {};
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, db, status));
  const inner = cloud.fetchImpl;
  let busy = true;
  cloud.fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (busy && body.action === 'saveAll') {
      busy = false;
      cloud.calls.push(body);
      return { ok: true, text: async () => JSON.stringify({
        success: false, error: 'backend busy with another save — please retry the save'
      }) };
    }
    return inner(url, options);
  };
  ctx.fetch = cloud.fetchImpl;

  let src = syncLayerSource().replace(
    /const CLOUD_BUSY_RETRY_DELAYS = \[[^\]]+\];/,
    'const CLOUD_BUSY_RETRY_DELAYS = [5, 5, 5, 5, 5, 5];'
  );
  vm.runInContext(src, ctx);
  // Delete All just stopped a Backfill upload; Apps Script is still writing it.
  vm.runInContext("cloudStoppedUpload = '📥 Backfill'", ctx);

  const result = await ctx.saveToCloud(true, '🗑️ Delete All');
  assert.strictEqual(result, true, 'the retry still lands the wipe');
  assert.ok(status.some((m) => /the 📥 Backfill upload this device stopped is still being written/.test(m)),
    'the retry names the save holding the lock');
  assert.ok(!status.some((m) => /another save/i.test(m)), 'no message falls back to a generic "another save"');
  assert.strictEqual(vm.runInContext('cloudStoppedUpload', ctx), null, 'a successful save clears the suspect');
});

test('Delete All names the saves it stopped in the wipe push message', () => {
  const fn = HTML.slice(HTML.indexOf('async function deleteAllStandalone(){'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /cloudSavePreempt\(CLOUD_SAVE_NAMES\.deleteAll\)/, 'Delete All must pre-empt before it pushes');
  assert.ok(body.indexOf('cloudSavePreempt') < body.indexOf('deleteAllKeepResolved()'),
    'the pre-emption must happen before the wipe, not after');
  assert.match(body, /Stopped ' \+ stoppedSaves\.join/, 'the pill must name what Delete All stopped');
  assert.match(body, /saveToCloud\(true, CLOUD_SAVE_NAMES\.deleteAll\)/, 'the wipe push must be named');
});

test('every forced save is named at its call site', () => {
  const expected = [
    ['deleteAll', 'saveToCloud(true, CLOUD_SAVE_NAMES.deleteAll)'],
    ['forcePush', 'saveToCloud(true, CLOUD_SAVE_NAMES.forcePush)'],
    ['smartMerge', 'saveToCloud(true, CLOUD_SAVE_NAMES.smartMerge)'],
    ['backfill', 'saveToCloud(true, CLOUD_SAVE_NAMES.backfill)'],
    ['rebuild', 'saveToCloud(true, CLOUD_SAVE_NAMES.rebuild)'],
    ['dupFix', 'saveToCloud(false, CLOUD_SAVE_NAMES.dupFix)']
  ];
  expected.forEach(([key, call]) => {
    assert.ok(HTML.includes(call), key + ' must save under its own name: ' + call);
  });
  assert.ok(!/await saveToCloud\(true\)/.test(HTML), 'no forced save may stay anonymous');
});
