'use strict';

// Regression guard for the Contact Resolver / any save() crashing with:
//
//   "Failed to execute 'setItem' on 'Storage': Setting the value of
//    'spaxDB_v23' exceeded the quota."
//
// Root cause: DB is persisted to ONE localStorage key. A big import day grows
// it past ~5 MB, and an unguarded localStorage.setItem('spaxDB_v23', …) then
// throws QuotaExceededError. That used to bubble straight out of save(), so
// Resolve / Apply / dedupe / contact-edit save all red-ringed — AND save()
// threw before its own saveToCloud() ran, so cloud sync got skipped at the
// exact moment imports were growing the database.
//
// The fix (persistDB) must keep four things true:
//   1. save() never throws because localStorage is full.
//   2. save() still calls saveToCloud() and refreshAll() regardless of the
//      local write result (data is safe in memory + cloud).
//   3. persistDB() compacts what is safe to drop (backfillOnly rows and
//      seen-keys with no backing transaction) and retries, returning true once
//      the DB fits again.
//   4. persistDB() reports false (instead of throwing) when even the compacted
//      DB does not fit.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// save() + persistDB() live as one contiguous block: function save(){ … }
// … function persistDB(){ … } … const saveDB = save;
function savePersistBlock() {
  const start = htmlSource.indexOf('function save(){');
  assert.notEqual(start, -1, 'save() not found in index.html');
  const end = htmlSource.indexOf('const saveDB = save;');
  assert.notEqual(end, -1, 'saveDB marker not found');
  assert.ok(end > start, 'save block markers out of order');
  return htmlSource.slice(start, end);
}

function makeDb(extraTransactions = []) {
  return {
    customers: [{ name: 'Winfred', contact: '0727311744', spent: 37460, visits: 76, masked: false, isSeed: true }],
    transactions: [
      // A history-only backfill row — safe to drop under quota pressure.
      { date: '2026-08-31', time: '10:00:00', amount: 100, name: 'C1', phone: '25471', receipt: 'R1', backfillOnly: true },
      // A real imported row — must survive compaction.
      { date: '2026-09-01', time: '11:00:00', amount: 200, name: 'C2', phone: '25472', receipt: 'R2' },
      ...extraTransactions
    ],
    customerTx: { Winfred: [{ date: '2026-08-31', amount: 100, receipt: 'R1' }] },
    monthly: { labels: ['2026-09'], revenue: [200] },
    seen: {},
    importedRev: 200,
    importedTx: 2,
    resolved: 0,
    importBatch: 1
  };
}

// localStorage whose setItem('spaxDB_v23', …) throws the real quota error.
function makeThrowingStore({ alwaysThrow = false } = {}) {
  const calls = { set: 0 };
  return {
    calls,
    getItem: (k) => null,
    removeItem: (k) => {},
    setItem: (k, v) => {
      calls.set += 1;
      if (alwaysThrow || calls.set === 1) {
        throw new Error("Failed to execute 'setItem' on 'Storage': Setting the value of 'spaxDB_v23' exceeded the quota.");
      }
    }
  };
}

function makeContext(DB, store, { clouds = [] } = {}) {
  const ctx = vm.createContext({
    console,
    localStorage: store,
    SYNC_MODE: 'auto',
    DB,
    healOrphanedSeenKeys: () => 0,
    saveToCloud: () => { clouds.push('cloud'); },
    refreshAll: () => { clouds.push('refresh'); },
    showSyncStatus: () => {},
    toast: () => {},
    setTimeout,
    clearTimeout,
    Date,
    Math
  });
  vm.runInContext(savePersistBlock(), ctx);
  return { ctx, clouds };
}

test('persistDB compacts a quota-full DB and returns true after shrinking it', () => {
  const DB = makeDb();
  const store = makeThrowingStore({ alwaysThrow: false }); // fails once, then fits
  const { ctx } = makeContext(DB, store);

  const ok = vm.runInContext('persistDB()', ctx);

  assert.strictEqual(ok, true, 'persistDB must succeed once the DB is compacted');
  assert.strictEqual(store.calls.set, 2, 'expected an initial throw then one retry');
  // The backfillOnly row was dropped, the real row is retained.
  assert.strictEqual(DB.transactions.length, 1, 'backfillOnly rows must be dropped');
  assert.ok(!DB.transactions.some((t) => t.backfillOnly), 'no backfillOnly rows may survive');
  assert.strictEqual(DB.transactions[0].receipt, 'R2');
  // Per-customer history (customerTx) is intact.
  assert.strictEqual(DB.customerTx.Winfred.length, 1);
});

test('save() never throws on a quota-full store and still syncs + refreshes', () => {
  const DB = makeDb();
  const store = makeThrowingStore({ alwaysThrow: true }); // still full after compaction
  const { ctx, clouds } = makeContext(DB, store);

  // save() must not throw even though localStorage will never accept the DB.
  assert.doesNotThrow(() => vm.runInContext('save()', ctx));
  // Cloud sync and UI refresh still ran — local persistence failure is decoupled.
  assert.deepStrictEqual(clouds, ['cloud', 'refresh']);
  // persistDB reported the failure without throwing.
  assert.strictEqual(vm.runInContext('DB_persistFailed', ctx), true);
  assert.strictEqual(vm.runInContext('DB_persistWarned', ctx), true);
});

test('save() persists normally when localStorage has room and clears the failure flag', () => {
  const DB = makeDb();
  const store = {
    calls: { set: 0 },
    getItem: (k) => null,
    removeItem: (k) => {},
    setItem: (k, v) => { store.calls.set += 1; }
  };
  const { ctx, clouds } = makeContext(DB, store);

  // Prime the failure flags (incl. the one-time-compaction latch), then a
  // healthy save must clear them and write exactly once.
  vm.runInContext('DB_persistFailed = true; DB_persistWarned = true; DB_persistCompacted = true;', ctx);
  assert.doesNotThrow(() => vm.runInContext('save()', ctx));
  assert.strictEqual(store.calls.set, 1, 'a healthy save writes once');
  assert.deepStrictEqual(clouds, ['cloud', 'refresh']);
  assert.strictEqual(vm.runInContext('DB_persistFailed', ctx), false);
  assert.strictEqual(vm.runInContext('DB_persistWarned', ctx), false);
  assert.strictEqual(vm.runInContext('DB_persistCompacted', ctx), false,
    'a healthy write must reset the compaction latch so the next overflow re-compacts');
});

test('a still-over-quota store compacts ONCE then stops re-compacting on every save', () => {
  const DB = makeDb([{ date: '2026-09-02', time: '12:00:00', amount: 999, name: 'C3', phone: '25473', receipt: 'R3' }]);
  // The store throws on every write — even after compaction the DB won't fit.
  const store = makeThrowingStore({ alwaysThrow: true });
  const { ctx } = makeContext(DB, store);

  const first = vm.runInContext('persistDB()', ctx);
  // After the first compaction pass the backfillOnly row is gone.
  assert.strictEqual(first, false);
  assert.strictEqual(store.calls.set, 2, 'first persistDB: one failed write + one post-compaction write');
  assert.ok(!DB.transactions.some((t) => t.backfillOnly));

  // A second persistDB() when the store is still full must NOT re-compact:
  // it simply records the failure WITHOUT re-serializing/retrying an enum pass.
  const before = store.calls.set;
  const second = vm.runInContext('persistDB()', ctx);
  assert.strictEqual(second, false);
  assert.strictEqual(store.calls.set, before + 1, 'follow-up persistDB must not re-compact or re-write twice');
  assert.ok(DB.transactions.every((t) => !t.backfillOnly), 'no re-drop needed — rows already trimmed');
});

// The sync-layer retry helper must distinguish a reusable network blip from a
// timeout (which already burned its budget and must not be retried).
function transientErrorBlock() {
  const start = htmlSource.indexOf('function isUnknownActionError(err)');
  const end = htmlSource.indexOf('function showSyncStatus(msg)');
  assert.notEqual(start, -1, 'isUnknownActionError not found');
  assert.notEqual(end, -1, 'showSyncStatus not found');
  return htmlSource.slice(start, end);
}

test('isTransientNetworkError retries only real network blips, never timeouts', () => {
  const ctx = vm.createContext({});
  vm.runInContext(transientErrorBlock(), ctx);

  const run = (expr) => vm.runInContext(expr, ctx);
  assert.strictEqual(run("isTransientNetworkError(new Error('Failed to fetch'))"), true);
  assert.strictEqual(run("isTransientNetworkError(new Error('network error'))"), true);
  assert.strictEqual(run("isTransientNetworkError(new Error('Cloud connection timed out after 60s (large upload or weak signal).'))"), false);
  assert.strictEqual(run("isTransientNetworkError(new Error('Cloud returned HTTP 500'))"), false);
  // An AbortError is never retried, even if the message looks like a fetch blip.
  assert.strictEqual(run("const e = new Error('Failed to fetch'); e.name='AbortError'; isTransientNetworkError(e)"), false);
});
