'use strict';

// FULL-SAVE MODE — the default since 2026-09-20.
//
// The user's verdict on three weeks of incremental upload machinery,
// verbatim: "better the save all with duplicates than the cloud fail I am
// experiencing." Deltas (backend v3.4), chunked sessions (v3.0) and
// recoverable upload sessions (v3.8) each added another way for a save to
// die on a weak link, and what kept failing was the machinery itself. The
// default is now the one path that cannot fail structurally:
//
//   EVERY save is ONE atomic one-shot saveAll POST of the whole database.
//   • the backend stages then swaps, so a retry only re-sends the same body;
//   • the load path union-merges by dedup key, so re-sent rows ("the
//     duplicates") can never double-count;
//   • saveAll is the one action every backend version has ever answered, so
//     no Code.gs redeploy is ever required.
//
// The incremental machinery is still in the code, opt-in via localStorage
// spaxCloudFullSave='0' (the suites that pin it seed that flag). This suite
// pins the DEFAULT: a backend that speaks every protocol — so the only thing
// that can make the client send plain saveAll is full-save mode itself.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function syncLayerSource() {
  const start = HTML.indexOf('const GAS_URL');
  const end = HTML.indexOf('function showSyncStatus');
  assert.notEqual(start, -1, 'GAS_URL not found in index.html');
  assert.notEqual(end, -1, 'showSyncStatus not found in index.html');
  return HTML.slice(start, end);
}

// Same identity the backend's dedup uses: receipt rows key on
// receipt|date|time (plus the time-less legacy variant), rows without a
// receipt on date|time|amount|name|contact.
function txKey(r) {
  const rc = String(r.receipt || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (rc) return 'R|' + rc + '|' + String(r.date || '') + '|' + (r.time || '');
  return 'C|' + String(r.date || '') + '|' + (r.time || '') + '|' + (Number(r.amount) || 0) + '|' + String(r.name || '') + '|' + String(r.phone || r.contact || '');
}

// A backend that speaks EVERYTHING: chunked sessions (v3.8 semantics),
// saveDelta (v3.4), updateCustomer (v3.7), receipts on status (v3.6+).
// `statusUnknown` downgrades status to "unknown action" — an ancient
// deployment — so convergence can be pinned with no receipt machinery.
// `slowSaveAll: {ms, times}` holds the first N saveAll answers longer than
// the client's (patched) deadline, honouring the abort signal like a real
// fetch: the answer never arrives, but the write lands server-side.
function makeCloud({ statusUnknown = false, slowSaveAll = null } = {}) {
  const calls = [];
  const live = { transactions: [] };
  const staged = { transactions: [] };
  const stagedSeqs = new Set();
  let session = null;
  let saveAllNo = 0;
  const respond = (body) => ({ ok: true, text: async () => JSON.stringify(body) });
  const abortError = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; return e; };
  const waitOrAbort = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(true); }, { once: true });
  });
  const fetchImpl = async (url, options = {}) => {
    const body = options && options.body ? JSON.parse(options.body) : {};
    calls.push(body);
    if (body.action === 'saveAll') {
      saveAllNo += 1;
      if (slowSaveAll && saveAllNo <= slowSaveAll.times) {
        if (await waitOrAbort(slowSaveAll.ms, options.signal)) throw abortError();
      }
      live.transactions = (body.transactions || []).slice(); // atomic stage→swap
      return respond({ success: true });
    }
    if (body.action === 'status') {
      if (statusUnknown) return respond({ success: false, error: 'unknown action' });
      return respond({ success: true, version: '3.9', lastSave: null, lock: { free: true, ms: 0 } });
    }
    if (body.action === 'saveBegin') {
      staged.transactions = [];
      stagedSeqs.clear();
      session = { uploadId: String(body.uploadId || 'upload-123'), mode: body.mode === 'delta' ? 'delta' : 'full' };
      return respond({ success: true, uploadId: session.uploadId, ...(body.mode === 'delta' ? { delta: true } : {}) });
    }
    if (body.action === 'saveChunk') {
      const key = body.table + ':' + body.seq;
      if (stagedSeqs.has(key)) return respond({ success: true, written: 0, duplicate: true });
      stagedSeqs.add(key);
      staged[body.table] = (staged[body.table] || []).concat(body.rows || []);
      return respond({ success: true, written: (body.rows || []).length });
    }
    if (body.action === 'saveCommit') {
      const want = Number((body.expect || {}).transactions || 0);
      if (staged.transactions.length !== want) {
        return respond({ success: false, error: 'chunk mismatch: staged ' + staged.transactions.length + ', expected ' + want });
      }
      live.transactions = session && session.mode === 'delta'
        ? live.transactions.concat(staged.transactions)
        : staged.transactions.slice();
      return respond({ success: true });
    }
    if (body.action === 'saveDelta') {
      const have = new Set(live.transactions.map(txKey));
      let added = 0, skipped = 0;
      (body.txAdd || []).forEach((r) => {
        if (have.has(txKey(r))) { skipped += 1; return; }
        have.add(txKey(r));
        live.transactions.push(r);
        added += 1;
      });
      return respond({ success: true, added, skippedDuplicates: skipped, transactions: live.transactions.length });
    }
    if (body.action === 'updateCustomer') {
      return respond({ success: true, customersUpdated: 1, customersAdded: 0, transactionsRenamed: 0 });
    }
    return respond({ success: false, error: 'unknown action' });
  };
  const store = {}; // deliberately NO spaxCloudFullSave seed: the default is under test
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  return { calls, live, store, localStorage, fetchImpl };
}

function bigDB(rows = 2501) {
  const transactions = [];
  for (let i = 0; i < rows; i++) {
    transactions.push({ date: '2026-08-31', time: '10:00:00', amount: 100, name: 'C' + i, phone: '2547' + i, receipt: 'R' + i });
  }
  return {
    customers: [{ name: 'C0', contact: '25470', spent: 100, visits: 1 }],
    monthly: { labels: ['2026-08'], revenue: [rows * 100] },
    importedRev: rows * 100,
    importedTx: rows,
    resolved: 0,
    importBatch: 1,
    transactions,
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

async function runClient(cloud, db, { patch = [] } = {}) {
  const status = [];
  const ctx = vm.createContext(makeSandbox(cloud, db, status));
  let src = syncLayerSource();
  // Shrink the one-shot deadline and the busy backoffs to milliseconds so a
  // timeout-then-retry round is observable without wall-clock waits (the
  // same technique the chunked suite uses for its deadline tests).
  for (const [re, to] of patch) src = src.replace(re, to);
  vm.runInContext(src, ctx);
  return { ctx, status };
}

const INCREMENTAL_ACTIONS = ['saveBegin', 'saveChunk', 'saveCommit', 'saveDelta', 'updateCustomer'];

test('default: a big save is ONE atomic saveAll — no probes, no sessions, no deltas', async () => {
  const cloud = makeCloud(); // speaks EVERY protocol — must not matter
  const { ctx } = await runClient(cloud, bigDB());
  assert.strictEqual(vm.runInContext('cloudFullSave', ctx), true,
    'full-save mode must be the default when localStorage has no override');

  assert.strictEqual(await ctx.saveToCloud(true), true);
  assert.deepStrictEqual(cloud.calls.map(c => c.action), ['saveAll'],
    'exactly one POST, on a backend that could have served every other path');
  assert.strictEqual(cloud.calls[0].transactions.length, 2501, 'the whole database rides');
  assert.strictEqual(cloud.live.transactions.length, 2501, 'and it landed');
});

test('a routine background save is full too: rows the cloud already holds are re-sent ("with duplicates")', async () => {
  const cloud = makeCloud();
  const db = bigDB();
  const { ctx } = await runClient(cloud, db);
  assert.strictEqual(await ctx.saveToCloud(true), true); // baseline: everything pushed

  const before = cloud.calls.length;
  db.transactions.push({ date: '2026-09-01', time: '09:00:00', amount: 250, name: 'NEW', phone: '254700000009', receipt: 'NEW1' });
  assert.strictEqual(await ctx.saveToCloud(false), true); // a background save

  const calls = cloud.calls.slice(before);
  assert.deepStrictEqual(calls.map(c => c.action), ['saveAll'],
    'the routine save must not probe, append or slice');
  assert.strictEqual(calls[0].transactions.length, 2502,
    'ALL rows are re-sent — the 2501 the cloud already holds included');
  assert.strictEqual(cloud.live.transactions.length, 2502);
});

test('a timed-out saveAll converges by re-sending the SAME full body — on a backend that predates every receipt', async () => {
  const cloud = makeCloud({ statusUnknown: true, slowSaveAll: { ms: 200, times: 1 } });
  const { ctx } = await runClient(cloud, bigDB(), {
    patch: [
      [/const CLOUD_TIMEOUT_BIG_SAVE = \d+;/, 'const CLOUD_TIMEOUT_BIG_SAVE = 40;'],
      [/const CLOUD_BUSY_RETRY_DELAYS = \[[^\]]+\];/, 'const CLOUD_BUSY_RETRY_DELAYS = [5, 5, 5, 5, 5, 5, 5, 5];']
    ]
  });
  assert.strictEqual(await ctx.saveToCloud(true), true, 'the save must eventually succeed');

  const saveAlls = cloud.calls.filter(c => c.action === 'saveAll');
  assert.ok(saveAlls.length >= 2, 'the timed-out attempt must be retried, not abandoned');
  saveAlls.forEach((c) => assert.strictEqual(c.transactions.length, 2501,
    'every attempt carries the whole database'));
  assert.ok(!cloud.calls.some(c => INCREMENTAL_ACTIONS.includes(c.action)),
    'the retry must never fall into the incremental machinery');
  assert.strictEqual(cloud.live.transactions.length, 2501, 'the retried body landed whole');
});

test('a contact edit rides the full save — no second protocol to fail', async () => {
  const cloud = makeCloud();
  const { ctx } = await runClient(cloud, bigDB());
  const edit = {
    oldName: 'C0', oldContact: '25470', newName: 'C0', newContact: '254711122233',
    customer: { name: 'C0', contact: '254711122233', spent: 100, visits: 1 }
  };
  assert.strictEqual(await ctx.spaxPushCustomerEdit(edit), false,
    'the targeted push must stand down in full-save mode');
  assert.deepStrictEqual(cloud.calls, [], 'no updateCustomer POST may be made');

  assert.strictEqual(await ctx.saveToCloud(true), true);
  assert.deepStrictEqual(cloud.calls.map(c => c.action), ['saveAll'],
    'the edit reaches the cloud inside the next full save');
});

test('opt-in (spaxCloudFullSave=0) still reaches the incremental machinery', async () => {
  const cloud = makeCloud();
  cloud.store.spaxCloudFullSave = '0'; // seeded BEFORE the sync layer loads
  const { ctx } = await runClient(cloud, bigDB());
  assert.strictEqual(vm.runInContext('cloudFullSave', ctx), false);

  assert.strictEqual(await ctx.saveToCloud(true), true);
  assert.strictEqual(cloud.calls[0].action, 'saveBegin',
    'the chunked machinery must still be reachable behind the flag');
  assert.ok(cloud.calls.some(c => c.action === 'saveCommit'), 'the session must commit');
});

test('source pins: the default is full-save and every clever path is behind the flag', () => {
  assert.ok(/let cloudFullSave = true;/.test(HTML), 'the flag must default ON');
  assert.ok(/localStorage\.getItem\('spaxCloudFullSave'\) !== '0'/.test(HTML),
    'absence of the key must mean ON (no legacy device silently keeps the failing path)');
  assert.ok(/if \(!cloudFullSave && deltaRows !== null && \(cloudDelta \|\| !cloudDeltaProbed\)\)/.test(HTML),
    'the delta path must be gated');
  assert.ok(/if \(!cloudFullSave && totalBigRows > CHUNK_ROWS && \(cloudChunks \|\| !cloudChunkProbed\)\)/.test(HTML),
    'the chunked path must be gated');
  const fn = HTML.slice(HTML.indexOf('async function spaxPushCustomerEdit'), HTML.indexOf('function spaxComputeDeltaRows'));
  assert.ok(/if \(cloudFullSave\) return false;/.test(fn),
    'the targeted contact-edit push must stand down in full-save mode');
});
