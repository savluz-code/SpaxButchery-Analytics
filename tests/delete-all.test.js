/**
 * Delete All — pre-emption regression tests.
 *
 * Delete All used to queue its cloud push behind whatever save was already
 * running, so a wipe confirmed during a long Backfill upload left the pre-wipe
 * database in the cloud for as long as that upload took. It now stops the save
 * in flight, drops the queue, and pushes first — and every message names the
 * saves involved instead of saying "another save".
 *
 * These tests execute the REAL deleteAllStandalone from index.html against a
 * scripted cloud, with only the app-level pieces it calls stubbed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ── sources under test ─────────────────────────────────────────────────── */

function syncLayerSource() {
  const start = HTML.indexOf('const GAS_URL');
  const end = HTML.indexOf('function showSyncStatus');
  assert.notEqual(start, -1, 'GAS_URL not found in index.html');
  assert.notEqual(end, -1, 'showSyncStatus not found in index.html');
  return HTML.slice(start, end);
}

function deleteAllSource() {
  const start = HTML.indexOf('async function deleteAllStandalone(){');
  assert.notEqual(start, -1, 'deleteAllStandalone not found in index.html');
  return HTML.slice(start, HTML.indexOf('\n}\n', start) + 3);
}

/* ── a small fake cloud ─────────────────────────────────────────────────── */

/**
 * `hangFirstChunk` makes the first slice of the FIRST upload session never
 * answer on its own — it settles only when the request is aborted, like a real
 * fetch. That is the in-flight upload Delete All has to interrupt.
 */
function makeCloud({ hangFirstChunk = false } = {}) {
  const calls = [];
  const state = { session: 0, chunksPerSession: {}, abortSignals: 0 };
  const respond = (body) => ({ ok: true, text: async () => JSON.stringify(body) });
  const store = {};
  const fetchImpl = async (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : {};
    calls.push(body);
    if (body.action === 'saveBegin') {
      state.session += 1;
      return respond({ success: true, uploadId: 'upload-' + state.session });
    }
    if (body.action === 'saveChunk') {
      state.chunksPerSession[state.session] = (state.chunksPerSession[state.session] || 0) + 1;
      if (hangFirstChunk && state.session === 1 && state.chunksPerSession[1] === 1) {
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            state.abortSignals += 1;
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          };
          if (options.signal && options.signal.aborted) return onAbort();
          if (options.signal) options.signal.addEventListener('abort', onAbort);
          // Only an abort is meant to end this; short + unref'd so a missing
          // abort fails fast instead of stalling the suite.
          setTimeout(resolve, 2000).unref();
        });
      }
      return respond({ success: true, written: (body.rows || []).length });
    }
    if (body.action === 'saveCommit' || body.action === 'saveAll') return respond({ success: true });
    return respond({ success: false, error: 'unknown action' });
  };
  return {
    calls, state, fetchImpl,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    }
  };
}

const PLAN = {
  customersDeleted: 41, transactionsDeleted: 3000, historyRowsDeleted: 120,
  revenueDeleted: 500000, savedCount: 12, resolvedKept: 3,
  ledgersKept: 2, expensesKept: 1, overheadsKept: 1, itemCostsKept: 4
};

function makeSandbox(cloud, status, toasts, confirmAnswers) {
  return {
    fetch: cloud.fetchImpl,
    localStorage: cloud.localStorage,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    showSyncStatus: (m) => status.push(m),
    toast: (m) => toasts.push(m),
    isMerchant: () => false,
    escHtml: (s) => String(s == null ? '' : s),
    kes: (n) => 'KSh ' + Number(n).toLocaleString(),
    SYNC_MODE: 'auto',
    // App-level pieces Delete All calls; stubbed so the test drives the real
    // deleteAllStandalone without the whole dashboard.
    planDeleteAll: () => PLAN,
    deleteAllKeepResolved: () => Object.assign({}, PLAN),
    showConfirm: async () => (confirmAnswers.length > 1 ? confirmAnswers.shift() : confirmAnswers[0]),
    persistDB: async () => true,
    refreshAll: () => {},
    DB: {
      customers: [], monthly: {}, importedRev: 0, importedTx: 0, resolved: 0,
      importBatch: 1, transactions: [], customerTx: {}, seen: {}, baselineCleared: 1
    }
  };
}

function bigDB() {
  const transactions = [];
  for (let i = 0; i < 3000; i++) transactions.push({ date: '2026-08-31', amount: 100, name: 'C' + i, receipt: 'R' + i });
  const customerTx = {};
  for (let i = 0; i < 50; i++) customerTx['C' + i] = [{ date: '2026-08-31', amount: 100, product: 'Beef', receipt: 'R' + i }];
  const seen = {};
  for (let i = 0; i < 100; i++) seen['receipt|R' + i + '|2026-08-31|'] = 1;
  return {
    customers: [{ name: 'C0', contact: '25470', spent: 100, visits: 1 }],
    monthly: { labels: ['2026-08'], revenue: [300000] },
    importedRev: 300000, importedTx: 3000, resolved: 0, importBatch: 1,
    transactions, customerTx, seen
  };
}

function makeCtx(cloud, { confirmAnswers = [true, true], syncMode = 'auto' } = {}) {
  const status = [];
  const toasts = [];
  const ctx = vm.createContext(makeSandbox(cloud, status, toasts, confirmAnswers));
  // SYNC_MODE is a lexical `let` inside the sliced source, so it has to be
  // patched there — assigning a context property would only shadow it.
  let src = syncLayerSource();
  if (syncMode !== 'auto') {
    assert.ok(src.includes("let SYNC_MODE = 'auto';"), 'SYNC_MODE declaration moved — update this test');
    src = src.replace("let SYNC_MODE = 'auto';", "let SYNC_MODE = '" + syncMode + "';");
  }
  vm.runInContext(src, ctx);
  vm.runInContext(deleteAllSource(), ctx);
  return { ctx, status, toasts };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ── tests ──────────────────────────────────────────────────────────────── */

test('Delete All interrupts an in-flight Backfill upload and pushes the wipe first', async () => {
  const cloud = makeCloud({ hangFirstChunk: true });
  const { ctx, status, toasts } = makeCtx(cloud);
  vm.runInContext('DB = ' + JSON.stringify(bigDB()), ctx);

  const backfill = ctx.saveToCloud(true, '📥 Backfill'); // hangs mid-upload
  await tick();
  assert.strictEqual(vm.runInContext('cloudSaveRunning', ctx), true, 'a Backfill upload is in flight');

  const wipeDone = ctx.deleteAllStandalone();
  await tick(); // let the confirm resolve so the pre-emption runs

  assert.strictEqual(cloud.state.abortSignals, 1, 'the Backfill request was aborted, not left running');
  assert.ok(toasts.some((m) => /⏸️ Stopped 📥 Backfill — 🗑️ Delete All is taking over/.test(m)),
    'the toast names the save that was stopped and the one taking over');

  const [backfillResult, wipeResult] = await Promise.all([backfill, wipeDone]);
  assert.strictEqual(backfillResult, false, 'the stopped Backfill did not land');
  assert.strictEqual(wipeResult, true, 'Delete All completed');
  assert.strictEqual(cloud.state.chunksPerSession[1], 1, 'the stopped upload sent no further slices');
  assert.ok(cloud.state.session >= 2, 'the wipe ran as its own upload after the abort');
  assert.ok(status.some((m) => /✅ Delete All complete — ready for normal import/.test(m)),
    'the wipe announces its own completion');
});

test('the wipe report names every save Delete All stopped', async () => {
  const cloud = makeCloud({ hangFirstChunk: true });
  const notes = [];
  const { ctx, status } = makeCtx(cloud);
  vm.runInContext('DB = ' + JSON.stringify(bigDB()), ctx);
  // Capture the completion dialog body, which carries the cloud note.
  ctx.showConfirm = async (icon, title, body) => { notes.push(String(body)); return true; };

  const backfill = ctx.saveToCloud(true, '📥 Backfill');
  const queued = ctx.saveToCloud(true, '🔀 Smart Merge'); // waiting behind it
  await tick();

  await ctx.deleteAllStandalone();
  await Promise.all([backfill, queued]);

  const report = notes.join('\n');
  assert.match(report, /Stopped mid-flight to let the wipe go first: 📥 Backfill, 🔀 Smart Merge/,
    'the completion dialog lists the stopped saves by name');
  assert.match(report, /wiped state pushed to the cloud/, 'the wipe itself reports success');
  assert.ok(!/another save/i.test(report + status.join('\n')),
    'no Delete All message falls back to a generic "another save"');
});

test('Delete All with nothing running still pushes and does not claim it stopped anything', async () => {
  const cloud = makeCloud();
  const { ctx, status, toasts } = makeCtx(cloud);
  vm.runInContext('DB = ' + JSON.stringify(bigDB()), ctx);

  assert.strictEqual(await ctx.deleteAllStandalone(), true);
  assert.ok(status.some((m) => /🗑️ Delete All done — pushing the clean state to the cloud/.test(m)),
    'the plain path is unchanged');
  assert.ok(!toasts.some((m) => /Stopped/.test(m)), 'nothing was stopped, so nothing is reported as stopped');
  assert.ok(cloud.calls.some((c) => c.action === 'saveBegin' || c.action === 'saveAll'), 'the wipe reached the cloud');
});

test('Delete All in local-only mode never touches the cloud or the queue', async () => {
  const cloud = makeCloud();
  const { ctx, status } = makeCtx(cloud, { syncMode: 'local' });
  vm.runInContext('DB = ' + JSON.stringify(bigDB()), ctx);

  assert.strictEqual(await ctx.deleteAllStandalone(), true);
  assert.strictEqual(cloud.calls.length, 0, 'local-only mode makes no cloud request');
  assert.ok(status.some((m) => /Delete All complete/.test(m)));
});
