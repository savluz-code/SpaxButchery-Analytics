'use strict';

// Regression guard for the "⚠️ Local storage is full" banner that kept
// coming back even after PR #46 fixed the QuotaExceededError crash:
//
//   "Failed to execute 'setItem' on 'Storage': Setting the value of
//    'spaxDB_v23' exceeded the quota."
//
// Root cause: every imported row is stored THREE times — the global
// transactions list, a per-customer copy in customerTx, and one or two
// dedup keys in seen — so a few weeks of statement imports are tens of MB,
// which can NEVER fit a single localStorage key (~5 MB quota). PR #46's
// persistDB() stopped the crash and shed what was safe to drop, but the DB
// kept outgrowing the key, so every save after a big import day failed to
// persist again and the banner stayed up.
//
// The fix: the durable copy now lives in IndexedDB (quota = a large share of
// the device disk), with localStorage — and its compaction behaviour — kept
// as the fallback for engines without IndexedDB. That must keep five things
// true:
//   1. save() never throws because local storage is full.
//   2. save() still calls saveToCloud() and refreshAll() regardless of the
//      local write result (data is safe in memory + cloud).
//   3. With IndexedDB available the DB is written there in full — never
//      compacted, and localStorage is never touched (no 5 MB wall at all).
//   4. Without IndexedDB (or when it fails to open) the legacy fallback
//      still compacts what is safe to drop (backfillOnly rows and seen-keys
//      with no backing transaction), retries once, and reports false instead
//      of throwing when even the compacted DB does not fit.
//   5. load() reads the IndexedDB copy first and falls back to the legacy
//      localStorage key, so devices that saved with an older build migrate
//      automatically on first load after the update.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// save() + the whole persistence layer (IDB helpers, persistToLocalStorage,
// persistDB) live as one contiguous block: function save(){ … } … const
// saveDB = save;
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
  const calls = { set: 0, remove: 0 };
  return {
    calls,
    getItem: (k) => null,
    removeItem: (k) => { calls.remove += 1; },
    setItem: (k, v) => {
      calls.set += 1;
      if (alwaysThrow || calls.set === 1) {
        throw new Error("Failed to execute 'setItem' on 'Storage': Setting the value of 'spaxDB_v23' exceeded the quota.");
      }
    }
  };
}

// Minimal in-memory IndexedDB stand-in. Implements exactly the surface the
// app's IDB layer uses: open (with onupgradeneeded/onsuccess/onerror),
// transaction/objectStore, get/put/delete with request + transaction
// oncomplete/onabort callbacks.
function makeFakeIndexedDB({ failOpen = false } = {}) {
  const data = new Map();
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    close: () => {},
    transaction: () => ({
      objectStore: () => ({
        get(key) {
          const req = {};
          queueMicrotask(() => { req.result = data.has(key) ? data.get(key) : undefined; req.onsuccess && req.onsuccess(); });
          return req;
        },
        put(value, key) {
          const req = { transaction: {} };
          queueMicrotask(() => { data.set(key, value); req.transaction.oncomplete && req.transaction.oncomplete(); });
          return req;
        },
        delete(key) {
          const req = { transaction: {} };
          queueMicrotask(() => { data.delete(key); req.transaction.oncomplete && req.transaction.oncomplete(); });
          return req;
        }
      })
    })
  };
  return {
    data,
    open() {
      const req = {};
      queueMicrotask(() => {
        if (failOpen) { req.onerror && req.onerror(new Error('IndexedDB unavailable')); return; }
        req.result = db;
        req.onsuccess && req.onsuccess();
      });
      return req;
    }
  };
}

function makeContext(DB, store, { clouds = [], indexedDB = undefined } = {}) {
  const sandbox = {
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
  };
  if (indexedDB !== undefined) sandbox.indexedDB = indexedDB;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(savePersistBlock(), ctx);
  return { ctx, clouds };
}

// Flush the microtask queue (the IDB + persistDB promise chains settle on
// microtasks); one macrotask turn guarantees every hop has run.
const tick = () => new Promise(r => setTimeout(r, 0));

// ── IndexedDB primary path ────────────────────────────────────────────────

test('idbGet/idbSet/idbDel round-trip through the app\'s IDB layer', async () => {
  const fake = makeFakeIndexedDB();
  const { ctx } = makeContext(makeDb(), makeThrowingStore(), { indexedDB: fake });

  assert.strictEqual(await vm.runInContext("idbGet('k1')", ctx), undefined, 'fresh store reads undefined');
  await vm.runInContext("idbSet('k1', 'v1')", ctx);
  assert.strictEqual(await vm.runInContext("idbGet('k1')", ctx), 'v1');
  await vm.runInContext("idbDel('k1')", ctx);
  assert.strictEqual(await vm.runInContext("idbGet('k1')", ctx), undefined, 'delete removes the entry');
});

test('persistDB writes the FULL db to IndexedDB — no compaction, no localStorage, even beyond the old 5 MB wall', async () => {
  const DB = makeDb([{ date: '2026-09-02', time: '12:00:00', amount: 999, name: 'C3', phone: '25473', receipt: 'R3' }]);
  const store = makeThrowingStore({ alwaysThrow: true }); // would have rejected this size before
  const fake = makeFakeIndexedDB();
  const { ctx } = makeContext(DB, store, { indexedDB: fake });

  const ok = await vm.runInContext('persistDB()', ctx);

  assert.strictEqual(ok, true, 'the IndexedDB write succeeds');
  assert.strictEqual(store.calls.set, 0, 'localStorage is never written when IndexedDB works');
  assert.ok(store.calls.remove >= 1, 'the stale legacy localStorage copy is removed once IndexedDB holds the newer one');
  assert.strictEqual(fake.data.size, 1);
  const saved = JSON.parse(fake.data.get('spaxDB_v23'));
  assert.strictEqual(saved.transactions.length, 3, 'every row is persisted — nothing is compacted away');
  assert.ok(saved.transactions.some(t => t.backfillOnly), 'backfillOnly rows survive: the 5 MB compaction path must not fire');
  assert.strictEqual(vm.runInContext('DB_persistFailed', ctx), false);
  assert.strictEqual(vm.runInContext('DB_persistWarned', ctx), false);
});

test('save() with IndexedDB: no warning, flags cleared, cloud + refresh still run, full db stored', async () => {
  const DB = makeDb();
  const store = makeThrowingStore({ alwaysThrow: true });
  const fake = makeFakeIndexedDB();
  const { ctx, clouds } = makeContext(DB, store, { indexedDB: fake });

  // Prime the failure flags (incl. the compaction latch), then a healthy
  // save must clear them and store the full db.
  vm.runInContext('DB_persistFailed = true; DB_persistWarned = true; DB_persistCompacted = true;', ctx);
  assert.doesNotThrow(() => vm.runInContext('save()', ctx));
  await tick();

  assert.deepStrictEqual(clouds, ['cloud', 'refresh'], 'cloud sync + refresh run regardless of the local write');
  assert.strictEqual(store.calls.set, 0, 'localStorage never touched');
  assert.strictEqual(JSON.parse(fake.data.get('spaxDB_v23')).transactions.length, 2, 'full db in IndexedDB');
  assert.strictEqual(vm.runInContext('DB_persistFailed', ctx), false);
  assert.strictEqual(vm.runInContext('DB_persistWarned', ctx), false);
  assert.strictEqual(vm.runInContext('DB_persistCompacted', ctx), false, 'a healthy write resets the compaction latch');
});

test('IndexedDB that fails to open falls back to the legacy compaction path', async () => {
  const DB = makeDb();
  const store = makeThrowingStore({ alwaysThrow: true });
  const fake = makeFakeIndexedDB({ failOpen: true });
  const { ctx } = makeContext(DB, store, { indexedDB: fake });

  const ok = await vm.runInContext('persistDB()', ctx);

  assert.strictEqual(ok, false, 'still-over-quota store reports failure without throwing');
  assert.ok(!DB.transactions.some(t => t.backfillOnly), 'fallback compacted the backfillOnly row');
  assert.strictEqual(vm.runInContext('DB_persistFailed', ctx), true);
});

// ── Legacy fallback (no IndexedDB) — the PR #46 contract, preserved ───────

test('persistDB compacts a quota-full DB and returns true after shrinking it', async () => {
  const DB = makeDb();
  const store = makeThrowingStore({ alwaysThrow: false }); // fails once, then fits
  const { ctx } = makeContext(DB, store); // no indexedDB in this context

  const ok = await vm.runInContext('persistDB()', ctx);

  assert.strictEqual(ok, true, 'persistDB must succeed once the DB is compacted');
  assert.strictEqual(store.calls.set, 2, 'expected an initial throw then one retry');
  // The backfillOnly row was dropped, the real row is retained.
  assert.strictEqual(DB.transactions.length, 1, 'backfillOnly rows must be dropped');
  assert.ok(!DB.transactions.some((t) => t.backfillOnly), 'no backfillOnly rows may survive');
  assert.strictEqual(DB.transactions[0].receipt, 'R2');
  // Per-customer history (customerTx) is intact.
  assert.strictEqual(DB.customerTx.Winfred.length, 1);
});

test('save() never throws on a quota-full store and still syncs + refreshes', async () => {
  const DB = makeDb();
  const store = makeThrowingStore({ alwaysThrow: true }); // still full after compaction
  const { ctx, clouds } = makeContext(DB, store);

  // save() must not throw even though localStorage will never accept the DB.
  assert.doesNotThrow(() => vm.runInContext('save()', ctx));
  // Cloud sync and UI refresh ran synchronously — local persistence is decoupled.
  assert.deepStrictEqual(clouds, ['cloud', 'refresh']);
  await tick();
  // persistDB reported the failure without throwing.
  assert.strictEqual(vm.runInContext('DB_persistFailed', ctx), true);
  assert.strictEqual(vm.runInContext('DB_persistWarned', ctx), true);
});

test('save() persists normally when localStorage has room and clears the failure flags', async () => {
  const DB = makeDb();
  const store = {
    calls: { set: 0, remove: 0 },
    getItem: (k) => null,
    removeItem: (k) => { store.calls.remove += 1; },
    setItem: (k, v) => { store.calls.set += 1; }
  };
  const { ctx, clouds } = makeContext(DB, store);

  // Prime the failure flags (incl. the one-time-compaction latch), then a
  // healthy save must clear them and write exactly once.
  vm.runInContext('DB_persistFailed = true; DB_persistWarned = true; DB_persistCompacted = true;', ctx);
  assert.doesNotThrow(() => vm.runInContext('save()', ctx));
  await tick();
  assert.strictEqual(store.calls.set, 1, 'a healthy save writes once');
  assert.strictEqual(store.calls.remove, 0, 'the legacy path must never delete its own store — it IS the store');
  assert.deepStrictEqual(clouds, ['cloud', 'refresh']);
  assert.strictEqual(vm.runInContext('DB_persistFailed', ctx), false);
  assert.strictEqual(vm.runInContext('DB_persistWarned', ctx), false);
  assert.strictEqual(vm.runInContext('DB_persistCompacted', ctx), false,
    'a healthy write must reset the compaction latch so the next overflow re-compacts');
});

test('a still-over-quota store compacts ONCE then stops re-compacting on every save', async () => {
  const DB = makeDb([{ date: '2026-09-02', time: '12:00:00', amount: 999, name: 'C3', phone: '25473', receipt: 'R3' }]);
  // The store throws on every write — even after compaction the DB won't fit.
  const store = makeThrowingStore({ alwaysThrow: true });
  const { ctx } = makeContext(DB, store);

  const first = await vm.runInContext('persistDB()', ctx);
  // After the first compaction pass the backfillOnly row is gone.
  assert.strictEqual(first, false);
  assert.strictEqual(store.calls.set, 2, 'first persistDB: one failed write + one post-compaction write');
  assert.ok(!DB.transactions.some((t) => t.backfillOnly));

  // A second persistDB() when the store is still full must NOT re-compact:
  // it simply records the failure WITHOUT re-serializing/retrying an enum pass.
  const before = store.calls.set;
  const second = await vm.runInContext('persistDB()', ctx);
  assert.strictEqual(second, false);
  assert.strictEqual(store.calls.set, before + 1, 'follow-up persistDB must not re-compact or re-write twice');
  assert.ok(DB.transactions.every((t) => !t.backfillOnly), 'no re-drop needed — rows already trimmed');
});

// ── load(): IndexedDB first, legacy localStorage key as migration fallback ─

test('load() reads IndexedDB before the legacy localStorage key, and the baseline follows the same store', () => {
  const loadStart = htmlSource.indexOf('async function load(){');
  assert.notEqual(loadStart, -1, 'async load() not found');
  const loadEnd = htmlSource.indexOf('function save(){');
  const loadBody = htmlSource.slice(loadStart, loadEnd);
  const idbIdx = loadBody.indexOf('idbGet(DB_LOCAL_KEY)');
  const lsIdx = loadBody.indexOf('localStorage.getItem(DB_LOCAL_KEY)');
  assert.ok(idbIdx > -1, 'load() must read the IndexedDB copy');
  assert.ok(lsIdx > -1, 'load() must keep the legacy localStorage fallback for migration');
  assert.ok(idbIdx < lsIdx, 'IndexedDB must be consulted BEFORE localStorage');
  assert.match(loadBody, /DB=await seedDB\(\);/, 'seedDB() is async now and must be awaited in load()');

  // The saved baseline is a full DB copy — it must use the same store, or it
  // hits the same 5 MB wall the main store did.
  const baselineBody = htmlSource.slice(
    htmlSource.indexOf('async function seedFromSavedBaseline(){'),
    htmlSource.indexOf('async function seedDB(){')
  );
  assert.match(baselineBody, /idbGet\(BASELINE_KEY\)/);
  assert.match(baselineBody, /localStorage\.getItem\(BASELINE_KEY\)/);
  const saveIdx = baselineBody.indexOf('idbGet(BASELINE_KEY)');
  const lsIdxB = baselineBody.indexOf('localStorage.getItem(BASELINE_KEY)');
  assert.ok(saveIdx < lsIdxB, 'baseline: IndexedDB before localStorage');

  const saveBaseline = htmlSource.slice(
    htmlSource.indexOf('async function saveLocalBaseline(){'),
    htmlSource.indexOf('async function restoreLocalBaseline(){')
  );
  assert.match(saveBaseline, /idbSet\(BASELINE_KEY, payload\)/, 'baseline save must prefer IndexedDB');
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
  // An AbortError is never retried, even when the message looks like a fetch blip.
  assert.strictEqual(run("const e = new Error('Failed to fetch'); e.name='AbortError'; isTransientNetworkError(e)"), false);
});
