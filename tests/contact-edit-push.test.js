'use strict';
/*
 * Targeted contact edits (backend v3.7).
 *
 * Editing ONE contact in the Contact Resolver used to show "large upload,
 * sending in parts": a rename flagged a full Transactions replace (an append
 * cannot rewrite the name on existing rows), so a single phone number cost the
 * whole database. spaxPushCustomerEdit sends exactly the edit as
 * action=updateCustomer instead, and only a refused/failed push takes the old
 * full-save route.
 *
 * Pinned here, against the real sync layer sliced out of index.html:
 *   1. A contact edit is ONE small updateCustomer POST — no saveAll/saveDelta/
 *      saveBegin, and no full-replace latch.
 *   2. A rename does not re-send the customer's rows as a delta afterwards:
 *      the pushed set is re-keyed to the new name.
 *   3. An old deployment ("unknown action") is remembered, and the fallback
 *      path sets the full-replace latch for a rename exactly as before.
 *   4. A transient failure (busy lock) falls back without caching "no
 *      support" — the next edit tries the cheap path again.
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
const syncLayer = () => slice('const GAS_URL', 'function showSyncStatus')
  .replace(/const CLOUD_HTTP_RETRY_DELAYS = \[[^\]]+\];/, 'const CLOUD_HTTP_RETRY_DELAYS = [5, 5];');
// The fallback wrapper lives next to saveContactEdit, outside the sync slice.
const fallback = slice('async function spaxSaveContactEditToCloud(edit, renamed)', '\n}\n') + '\n}\n';

function makeCloud(updateOutcome) {
  const calls = [];
  const store = {};
  const fetchImpl = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    calls.push(body);
    let out = { success: true };
    if (body.action === 'updateCustomer') {
      out = typeof updateOutcome === 'function' ? updateOutcome(body) : updateOutcome;
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
  return {
    calls, store, fetchImpl,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    }
  };
}

function db() {
  return {
    customers: [{ name: 'Old Name', contact: '254700', spent: 100, visits: 2 }],
    monthly: { labels: ['2026-09'], revenue: [100] },
    importedRev: 100, importedTx: 2, resolved: 0, importBatch: 1,
    transactions: [
      { date: '2026-09-01', time: '10:00:00', amount: 50, name: 'Old Name', phone: '254700', receipt: 'R1' },
      // receipt-less: its identity is keyed by NAME, the case a rename breaks
      { date: '2026-09-01', time: '10:05:00', amount: 50, name: 'Old Name', phone: '254700', receipt: '' }
    ],
    customerTx: {}, seen: {}
  };
}

function runCtx(cloud, database, status) {
  const saveCalls = [];
  const ctx = vm.createContext({
    fetch: cloud.fetchImpl,
    localStorage: cloud.localStorage,
    AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    showSyncStatus: (m) => status.push(String(m)),
    isMerchant: () => false,
    persistDB: async () => true,
    save: () => saveCalls.push(1),
    DB: database
  });
  vm.runInContext(syncLayer() + '\n' + fallback, ctx);
  ctx.saveCalls = saveCalls;
  return ctx;
}

const edit = (database, patch) => {
  const c = database.customers[0];
  const before = { oldName: c.name, oldContact: c.contact };
  Object.assign(c, patch);
  database.transactions.forEach((t) => { if (t.name === before.oldName) t.name = c.name; });
  return { ...before, newName: c.name, newContact: c.contact, customer: { ...c } };
};

test('a phone edit is one small updateCustomer POST — no full upload, no latch', async () => {
  const cloud = makeCloud({ success: true, customersUpdated: 1, customersAdded: 0, transactionsRenamed: 0 });
  const database = db();
  const status = [];
  const ctx = runCtx(cloud, database, status);
  // The device already knows the cloud holds these rows.
  vm.runInContext('spaxNotePushedTransactions(DB.transactions)', ctx);

  const ok = await ctx.spaxSaveContactEditToCloud(edit(database, { contact: '0711000000' }), false);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(cloud.calls.map((c) => c.action), ['updateCustomer']);
  const sent = cloud.calls[0].edits[0];
  assert.strictEqual(sent.oldContact, '254700');
  assert.strictEqual(sent.customer.contact, '0711000000');
  assert.strictEqual(ctx.saveCalls.length, 0, 'no general save may be queued');
  assert.strictEqual(vm.runInContext('spaxTxFullReplaceRequired()', ctx), false);
  assert.ok(status.some((m) => /Contact updated in the cloud/.test(m)));
  assert.ok(!status.some((m) => /large upload/.test(m)));
});

test('a rename stays cheap and does not re-send the renamed rows as a delta', async () => {
  const cloud = makeCloud({ success: true, customersUpdated: 1, customersAdded: 0, transactionsRenamed: 2 });
  const database = db();
  const ctx = runCtx(cloud, database, []);
  vm.runInContext('spaxNotePushedTransactions(DB.transactions)', ctx);

  const ok = await ctx.spaxSaveContactEditToCloud(edit(database, { name: 'New Name' }), true);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(cloud.calls.map((c) => c.action), ['updateCustomer']);
  assert.strictEqual(cloud.calls[0].edits[0].oldName, 'Old Name');
  assert.strictEqual(cloud.calls[0].edits[0].newName, 'New Name');
  assert.strictEqual(vm.runInContext('spaxTxFullReplaceRequired()', ctx), false, 'a targeted rename needs no full replace');
  const delta = vm.runInContext('spaxComputeDeltaRows(DB.transactions)', ctx);
  assert.deepStrictEqual(delta, [], 'the renamed receipt-less row must count as already pushed');
});

test('an old deployment is remembered and the rename falls back to the full-replace path', async () => {
  const cloud = makeCloud({ success: false, error: 'unknown action' });
  const database = db();
  const ctx = runCtx(cloud, database, []);
  vm.runInContext('spaxNotePushedTransactions(DB.transactions)', ctx);

  const ok = await ctx.spaxSaveContactEditToCloud(edit(database, { name: 'New Name' }), true);
  assert.strictEqual(ok, false);
  assert.strictEqual(ctx.saveCalls.length, 1, 'the ordinary save must run instead');
  assert.strictEqual(vm.runInContext('spaxTxFullReplaceRequired()', ctx), true, 'the fallback keeps the old latch');
  assert.strictEqual(cloud.store.spaxCloudCustomerEdit, '0');

  // The next edit does not even probe.
  const ok2 = await ctx.spaxSaveContactEditToCloud(edit(database, { contact: '0722000000' }), false);
  assert.strictEqual(ok2, false);
  assert.strictEqual(cloud.calls.filter((c) => c.action === 'updateCustomer').length, 1);
  assert.strictEqual(ctx.saveCalls.length, 2);
});

test('a busy backend falls back this once without caching "unsupported"', async () => {
  const cloud = makeCloud({ success: false, error: 'backend busy with another save — please retry the save' });
  const database = db();
  const ctx = runCtx(cloud, database, []);
  const ok = await ctx.spaxSaveContactEditToCloud(edit(database, { contact: '0733000000' }), false);
  assert.strictEqual(ok, false);
  assert.strictEqual(ctx.saveCalls.length, 1);
  assert.strictEqual(vm.runInContext('spaxTxFullReplaceRequired()', ctx), false, 'a phone edit never needs a full replace');
  assert.strictEqual(cloud.store.spaxCloudCustomerEdit, undefined);
  assert.strictEqual(vm.runInContext('cloudCustomerEdit', ctx), true);
});

test('saveContactEdit routes through the targeted push', () => {
  const body = slice('function saveContactEdit()', '\nwindow.saveContactEdit');
  assert.match(body, /spaxSaveContactEditToCloud\(/);
  assert.ok(!/spaxMarkTxFullReplace\(\)/.test(body), 'the edit itself must no longer latch a full replace');
  assert.ok(!/\bsave\(\);/.test(body), 'the edit must not queue a whole-database save directly');
});
