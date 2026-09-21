'use strict';

// HOLLOW-SUCCESS READ-BACK (2026-09-21).
//
// The bug this pins: "Even after the latest merge, no writing on cloud."
// PR #81 killed the hollow success (`saveAll_(body) || {success:true}`)
// SERVER-SIDE in Code.gs v3.10 — but Apps Script only runs the code its
// DEPLOYMENT points at, and the live deployment behind the user's /exec URL
// is pre-v3.6: it still answers `{success:true}` for saves that wrote
// nothing, and it cannot issue the v3.6 receipts the client's verify needs.
// Worse, a pre-v3.6 backend reports no `version` at all, so
// `cloudBackendVersion` stayed null and every stale-backend warning (which
// keyed off a KNOWN version below the minimum) stayed silent for exactly the
// deployments that need it loudest — the Sync tab showed a grey
// "(no status probe — pre-v3.6 backend)" and trusted every hollow ✅.
//
// The contract pinned here:
//   1. A successful answer WITHOUT a version field marks the deployment
//      pre-versioning: spaxBackendStale() and the amber hint fire on it, and
//      spaxBackendCanReceipt() is false.
//   2. Against a backend that cannot receipt, a reported save success is
//      witnessed by reading the cloud back: a hollow success (cloud still
//      holds the old rows) FAILS the save with the redeploy instruction and
//      records nothing as pushed; a real write passes and re-affirms the
//      done pill.
//   3. A receipt-capable backend (v3.6+) is never read back — no extra load.
//   4. The delta witness only requires the rows THIS save appended.

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

// A pre-v3.6-flavoured backend: no `version` on any answer, no status probe,
// "unknown action" for everything it predates. `hollow` makes saveAll answer
// success WITHOUT writing (the pre-v3.10 `|| {success:true}` path);
// `hollowDelta` does the same for saveDelta.
function makeCloud({ version = null, hollow = false, hollowDelta = false } = {}) {
  const calls = [];
  const live = { customers: [], monthly: null, settings: null, transactions: [] };
  const respond = (body) => ({ ok: true, text: async () => JSON.stringify(body) });
  const loadAnswer = () => ({
    success: true,
    ...(version ? { version } : {}),
    customers: live.customers,
    monthly: live.monthly,
    settings: live.settings,
    transactions: live.transactions
  });
  const fetchImpl = async (url, options = {}) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    calls.push(body ? body.action : 'load(get)');
    if (!body || body.action === 'load') return respond(loadAnswer());
    if (body.action === 'status') {
      if (!version) return respond({ success: false, error: 'unknown action: status' });
      return respond({
        success: true, version,
        customersRows: live.customers.length, txRows: live.transactions.length,
        lastSave: null
      });
    }
    if (body.action === 'saveAll') {
      if (!hollow) {
        live.transactions = (body.transactions || []).slice();
        live.customers = (body.customers || []).slice();
        live.monthly = body.monthly || null;
        live.settings = body.settings || null;
      }
      return respond({ success: true }); // pre-v3.6 answer: no version, no receipt
    }
    if (body.action === 'saveDelta') {
      if (!hollowDelta) {
        live.transactions = live.transactions.concat(body.txAdd || []);
        live.customers = (body.customers || []).slice();
        live.monthly = body.monthly || null;
        live.settings = body.settings || null;
      }
      return respond({ success: true });
    }
    return respond({ success: false, error: 'unknown action: ' + body.action });
  };
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  return { calls, live, store, localStorage, fetchImpl };
}

function smallDB(rows = 40) {
  const transactions = [];
  for (let i = 0; i < rows; i++) {
    transactions.push({ date: '2026-08-31', time: '10:00:00', amount: 100, name: 'C' + i, phone: '2547' + i, receipt: 'R' + i });
  }
  return {
    customers: [{ name: 'C0', contact: '25470', spent: 100, visits: 1 }],
    monthly: { labels: ['2026-08'], revenue: [4000] },
    transactions,
    customerTx: {},
    seen: {}
  };
}

function runCtx(cloud, db, { store = {} } = {}) {
  const status = [];
  Object.entries(store).forEach(([k, v]) => cloud.localStorage.setItem(k, v));
  const ctx = vm.createContext({
    fetch: cloud.fetchImpl,
    localStorage: cloud.localStorage,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    showSyncStatus: (m) => status.push(m),
    isMerchant: () => false,
    escHtml: (s) => String(s == null ? '' : s),
    normalizeContact: (c) => String(c || '').replace(/[^0-9]/g, ''),
    DB: db
  });
  vm.runInContext(syncLayerSource(), ctx);
  return { ctx, status };
}

/* ── 1. an answer without a version field proves the deployment is stale ── */

test('a successful answer with no version field flags the backend stale and unreceiptable', () => {
  const { ctx } = runCtx(makeCloud(), smallDB());
  // Unknown (never asked) is not "stale" yet — but it cannot receipt either,
  // so saves to it are read back until proven otherwise.
  assert.equal(ctx.spaxBackendStale(), false);
  assert.equal(ctx.spaxBackendCanReceipt(), false);
  assert.equal(ctx.spaxBackendHintHtml(), '');

  ctx.spaxNoteBackendVersion({ success: true, customers: [] }); // a pre-v3.6 load answer
  assert.equal(vm.runInContext('cloudBackendPreVersioning', ctx), true);
  assert.equal(ctx.spaxBackendStale(), true, 'a backend that never names a version IS stale');
  assert.equal(ctx.spaxBackendCanReceipt(), false);
  const hint = ctx.spaxBackendHintHtml();
  assert.match(hint, /older than v3.6/, 'the hint must name what the endpoint is');
  assert.match(hint, /Version: New version/, 'the hint must carry the redeploy instruction');
  assert.match(hint, /hollow/i, 'the hint must say WHY pushes "succeed" without writing');

  // A versioned answer clears the flag; below-minimum versions stay stale.
  ctx.spaxNoteBackendVersion({ success: true, version: '3.5' });
  assert.equal(vm.runInContext('cloudBackendPreVersioning', ctx), false);
  assert.equal(ctx.spaxBackendStale(), true);
  assert.equal(ctx.spaxBackendCanReceipt(), false);
  assert.match(ctx.spaxBackendHintHtml(), /v3\.5/);

  // v3.6+ can receipt; v3.10 is the minimum this build expects.
  ctx.spaxNoteBackendVersion({ success: true, version: '3.6' });
  assert.equal(ctx.spaxBackendStale(), true);
  assert.equal(ctx.spaxBackendCanReceipt(), true);
  ctx.spaxNoteBackendVersion({ success: true, version: '3.10' });
  assert.equal(ctx.spaxBackendStale(), false);
  assert.equal(ctx.spaxBackendHintHtml(), '');
});

/* ── 2. hollow successes are caught, not celebrated ─────────────────────── */

test('a pre-v3.6 hollow success fails the save loudly and records nothing as pushed', async () => {
  const cloud = makeCloud({ hollow: true });
  const db = smallDB();
  const { ctx, status } = runCtx(cloud, db);
  ctx.spaxNoteBackendVersion({ success: true, customers: [], transactions: [] }); // boot load named it pre-v3.6

  const ok = await ctx.saveToCloud(true);
  assert.equal(ok, false, 'a hollow success must NOT be booked as a saved save');

  // The read-back actually ran: saveAll first, then a load witness.
  const saveAt = cloud.calls.lastIndexOf('saveAll');
  assert.notEqual(saveAt, -1);
  assert.ok(cloud.calls.slice(saveAt).includes('load(get)'),
    'the save must be witnessed by reading the cloud back');

  // The verdict names the real fix, not a retry-later shrug.
  const last = status[status.length - 1];
  assert.match(last, /never landed/, 'the pill must say the write did not happen');
  assert.match(last, /Version: New version/, 'the pill must carry the redeploy instruction');
  assert.doesNotMatch(last, /✅/, 'no celebration on a hollow success');

  // Nothing was booked as pushed: the next save (and the boot retry) re-pushes.
  assert.equal(cloud.store['spaxSavedBasis_v1'], undefined);
  assert.equal(cloud.store['spaxPushedTx_v1'], undefined);
});

test('a pre-v3.6 backend that really writes passes the read-back', async () => {
  const cloud = makeCloud(); // no version field, but saveAll stores
  const db = smallDB();
  const { ctx, status } = runCtx(cloud, db);
  ctx.spaxNoteBackendVersion({ success: true, customers: [], transactions: [] }); // boot load named it pre-v3.6

  assert.equal(await ctx.saveToCloud(true), true);
  const saveAt = cloud.calls.lastIndexOf('saveAll');
  assert.ok(cloud.calls.slice(saveAt).includes('load(get)'), 'the write is witnessed even when it lands');
  assert.match(status[status.length - 1], /Saved to cloud/, 'the done pill is re-affirmed after verifying');
  assert.ok(cloud.store['spaxSavedBasis_v1'], 'a witnessed save books its basis');

  // The load answer carried no version, so the deployment is now known stale:
  // the amber note must be up for the next render.
  assert.equal(vm.runInContext('cloudBackendPreVersioning', ctx), true);
  assert.equal(ctx.spaxBackendStale(), true);
});

/* ── 3. receipt-capable backends are not read back ───────────────────────── */

test('a backend whose version is still unknown is not read back (the boot load names it first)', async () => {
  const cloud = makeCloud({ hollow: true });
  const db = smallDB();
  const { ctx } = runCtx(cloud, db); // no boot load yet: version unknown
  assert.equal(await ctx.saveToCloud(true), true, 'ignorance alone must not tax every save with a full load');
  assert.deepEqual(cloud.calls.filter((c) => c === 'load(get)'), []);
});

test('a receipt-capable but stale backend (v3.9) is trusted as before — no read-back', async () => {
  // v3.6–v3.9 deployments carry save receipts and their saveAll_ answers an
  // explicit object on every path, so the hollow fallback was unreachable
  // there; reading them back would tax every save of a backend that cannot
  // lie this way. The read-back is for pre-v3.6 endpoints alone.
  const cloud = makeCloud({ version: '3.9', hollow: true });
  const db = smallDB();
  const { ctx } = runCtx(cloud, db);
  ctx.spaxNoteBackendVersion({ success: true, version: '3.9' });
  assert.equal(ctx.spaxBackendStale(), true);
  assert.equal(ctx.spaxBackendCanReceipt(), true);
  assert.equal(await ctx.saveToCloud(true), true);
  assert.deepEqual(cloud.calls.filter((c) => c === 'load(get)'), []);
});

test('a receipt-capable backend gets no read-back load', async () => {
  const cloud = makeCloud({ version: '3.10' });
  const db = smallDB();
  const { ctx, status } = runCtx(cloud, db);
  ctx.spaxNoteBackendVersion({ success: true, version: '3.10' }); // boot load saw it

  assert.equal(await ctx.saveToCloud(true), true);
  assert.deepEqual(cloud.calls.filter((c) => c === 'load(get)'), [],
    'v3.6+ receipts make the read-back redundant — no extra load');
  assert.doesNotMatch(status.join('\n'), /reading the cloud back/);
});

/* ── 4. the delta witness requires only what THIS save appended ─────────── */

test('delta saves: a hollow append is caught, a real append passes', async () => {
  const run = async (hollowDelta) => {
    const cloud = makeCloud({ hollowDelta });
    const db = smallDB(40);
    // A confirmed push of the first 30 rows, then 10 new ones: the delta is
    // exactly the 10 new rows.
    const pre = { ...db, transactions: db.transactions.slice(0, 30) };
    const { ctx, status } = runCtx(cloud, pre, { store: { spaxCloudFullSave: '0' } });
    ctx.spaxNoteBackendVersion({ success: true, customers: [], transactions: [] }); // boot load named it pre-v3.6
    ctx.spaxNotePushedTransactions(pre.transactions);
    ctx.DB.transactions = db.transactions; // the 10 new rows appear locally
    const ok = await ctx.saveToCloud(true);
    return { ok, cloud, status };
  };

  const hollow = await run(true);
  assert.equal(hollow.ok, false, 'a hollow saveDelta success must fail the save');
  assert.match(hollow.status[hollow.status.length - 1], /never landed/);
  assert.ok(hollow.cloud.calls.includes('saveDelta'), 'the delta probe must have run');

  const real = await run(false);
  assert.equal(real.ok, true, 'a witnessed append passes without a full re-upload');
  // Delta appends ONLY the new rows: the cloud gains exactly the 10-row delta
  // (the 30 "already pushed" rows this mock never held are a gap the next
  // full save heals — not this save's witness).
  assert.equal(real.cloud.live.transactions.length, 10, 'the cloud holds the appended rows');
});
