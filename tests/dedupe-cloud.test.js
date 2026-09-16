'use strict';

// "Why does deduplicate customers not stick?" — regression guard.
//
// The sync model has no delete primitive: every save pushes the full
// customer list and every load/merge re-adds any record the other side
// still holds. Deduplicate Customers merges records AWAY, so the union
// merge resurrected them from whichever copy still had them — and the
// dedupe's own save is a FULL replace (whole-database re-upload) that a
// phone killing the tab mid-upload, or any failure before the commit,
// leaves unlanded. The next boot merged the stale pre-dedupe sheet back
// over the clean local list and the resumed "interrupted save" pushed the
// resurrected copies back up — the dedupe visibly never stuck.
//
// The fix has two halves, both pinned here against the REAL index.html
// booted in a vm with a STATEFUL mock cloud (a faithful miniature of
// google-apps-script.gs: every successful save replaces the small tables
// and the Transactions sheet with exactly what the client sent):
//
//   1. LOCAL-AUTHORITATIVE GUARD — while the full-replace latch is set
//      (a destructive change has not yet replaced the cloud sheets),
//      loadFromCloud skips the union merge entirely: the cloud copy is
//      stale relative to this device and must not be merged back.
//   2. MERGE TOMBSTONES — every record a dedupe merges away leaves its
//      customerMergeKey behind; the set rides the settings sheet and
//      every merge path drops tombstoned records from the incoming cloud
//      copy AND from local rows an older sync already resurrected, so
//      every device converges on the same deletion.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const TODAY = '2026-09-16';

/* ── minimal DOM / browser shims (same shape as customer-tally-app.test.js) ── */
function makeElement(id) {
  const el = {
    id, style: {}, dataset: {}, children: [], _html: '', textContent: '', value: '', checked: false, files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); return c; }, removeChild() {},
    querySelector() { return makeElement('q'); }, querySelectorAll() { return []; }, getContext() { return {}; },
    click() {}, focus() {}, scrollIntoView() {}, setAttribute() {}, getAttribute() { return null; }, closest() { return null; },
    insertAdjacentHTML() {}, remove() {}, getBoundingClientRect() { return { width: 0, height: 0 }; }
  };
  return el;
}

function makeFakeIndexedDB() {
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
          const req = {};
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
      queueMicrotask(() => { req.result = db; req.onsuccess && req.onsuccess(); });
      return req;
    }
  };
}

/* ── a stateful cloud: every landed save replaces the sheets, exactly the
      semantics of saveAll / saveCommit / saveDelta in google-apps-script.gs.
      `failSaves` makes the next N save requests die like a dropped
      connection (the phone killed the tab mid-upload), applying nothing. ── */
function makeCloud() {
  return {
    customers: [], transactions: [], monthly: { labels: [], revenue: [] }, settings: {},
    failSaves: 0, log: [], _stagedSmall: null, _stagedTx: [],
    applySmall(body) {
      if (Array.isArray(body.customers)) this.customers = body.customers.filter(c => c && String(c.name || '').trim());
      if (body.monthly) this.monthly = body.monthly;
      if (body.settings) this.settings = body.settings;
    },
    loadPayload() {
      return { success: true, backendVersion: '3.7', customers: this.customers, transactions: this.transactions, monthly: this.monthly, settings: this.settings };
    }
  };
}

function bootApp({ store, idb, cloud }) {
  const els = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    key: i => [...store.keys()][i],
    get length() { return store.size; }
  };
  const document = {
    getElementById: id => { if (!els.has(id)) els.set(id, makeElement(id)); return els.get(id); },
    querySelector: () => makeElement('q'), querySelectorAll: () => [], addEventListener() {},
    createElement: t => makeElement(t), body: makeElement('body'), head: makeElement('head'),
    documentElement: makeElement('html'), hidden: false, visibilityState: 'visible', readyState: 'complete'
  };
  const Chart = function () { return { destroy() {}, update() {}, data: {} }; };
  Chart.defaults = {}; Chart.register = () => {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document, localStorage,
    navigator: { serviceWorker: { register: () => Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve({}) } }) }, clipboard: {}, onLine: true, userAgent: 'node' },
    location: { href: 'http://localhost/', search: '', hostname: 'localhost', reload() {} },
    fetch: async (url, opts) => {
      const body = opts && opts.body ? String(opts.body) : '';
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (_) {}
      const action = parsed && parsed.action;
      const reply = obj => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
      if (!action) return reply(cloud.loadPayload());              // action=load GET
      if (action === 'load') return reply(cloud.loadPayload());
      if (cloud.failSaves > 0) { cloud.failSaves--; cloud.log.push('dropped:' + action); throw new Error('Failed to fetch'); }
      if (action === 'saveAll') {
        cloud.applySmall(parsed); cloud.transactions = parsed.transactions || [];
        cloud.log.push('saveAll'); return reply({ success: true });
      }
      if (action === 'saveDelta') {
        cloud.applySmall(parsed); cloud.transactions = cloud.transactions.concat(parsed.txAdd || []);
        cloud.log.push('saveDelta'); return reply({ success: true, added: (parsed.txAdd || []).length, skippedDuplicates: 0, transactions: cloud.transactions.length });
      }
      if (action === 'saveBegin') { cloud._stagedSmall = parsed; cloud._stagedTx = []; cloud.log.push('saveBegin'); return reply({ success: true, uploadId: 'u1' }); }
      if (action === 'saveChunk') { cloud._stagedTx = cloud._stagedTx.concat(parsed.rows || []); return reply({ success: true, written: (parsed.rows || []).length }); }
      if (action === 'saveCommit') {
        cloud.applySmall(cloud._stagedSmall || {}); cloud.transactions = cloud._stagedTx || [];
        cloud.log.push('saveCommit'); return reply({ success: true });
      }
      return reply({ success: true });
    },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob, AbortController, TextEncoder, TextDecoder,
    confirm: () => false, alert() {}, prompt: () => null, open() { return null; },
    Chart, Papa: { parse: () => ({ data: [] }) }, XLSX: {}, pdfjsLib: { GlobalWorkerOptions: {} }, Tesseract: {},
    Image: function () {}, FileReader: function () {},
    Intl, Date, Math, JSON, Promise, Map, Set, Object, Array, Number, String, Boolean, RegExp, Error,
    parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent,
    atob: s => Buffer.from(s, 'base64').toString('binary'), btoa: s => Buffer.from(s, 'binary').toString('base64'),
    requestAnimationFrame: f => setTimeout(f, 0), performance, structuredClone, queueMicrotask,
    crypto: require('node:crypto').webcrypto, addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} })
  };
  sandbox.indexedDB = idb;
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const scripts = [...htmlSource.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc\s*=/.test(m[1] || '') && m[2].trim())
    .map(m => m[2]);
  scripts.forEach((src, i) => vm.runInContext(src, ctx, { filename: `index-inline-${i}.js` }));
  vm.runInContext(`getTodayEAT = function(){ return ${JSON.stringify(TODAY)}; };`, ctx);
  return new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string' || name === 'then' || name === 'constructor' || name === 'toJSON' || name === 'inspect') return undefined;
      if (name === 'ctx') return ctx;
      return vm.runInContext(String(name), ctx);
    },
    set(_, name, value) { ctx.__v = value; vm.runInContext(`${name} = __v;`, ctx); return true; }
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function drain(ctx, ms = 300) {
  await sleep(ms);
  let n = 0;
  while ((ctx.cloudSaveRunning || ctx.cloudSaveQueue.length > 0) && n++ < 60) await sleep(100);
}

// A classic M-Pesa duplicate pair: one person, one full and one masked number.
function seedDuplicatePair(ctx, cloud) {
  const base = ctx.DB.customers.find(c => c.name);
  const A = { ...base, name: 'Test Kamau', contact: '0712345678', masked: false, spent: 500, visits: 2 };
  const B = { ...base, name: 'Test Kamau', contact: '07***45678', masked: true, spent: 500, visits: 2 };
  cloud.customers = [A, B];
  cloud.transactions = [
    { date: '2026-09-01', time: '10:00:00', amount: 250, name: 'Test Kamau', phone: '0712345678', product: 'meat', receipt: 'QGH7AAAAAA1', source: 'PDF', importedAt: '2026-09-02T00:00:00Z' },
    { date: '2026-09-03', time: '11:00:00', amount: 250, name: 'Test Kamau', phone: '07***45678', product: 'meat', receipt: '', source: 'PDF', importedAt: '2026-09-04T00:00:00Z' }
  ];
  return { A, B };
}
const duplicatesOf = ctx => ctx.DB.customers.filter(c => c.name === 'Test Kamau').length;

test('dedupe tombstones the merged-away identity and never the survivor', async () => {
  const store = new Map(), idb = makeFakeIndexedDB(), cloud = makeCloud();
  let ctx = bootApp({ store, idb, cloud });
  await sleep(120); ctx.repairDates();
  seedDuplicatePair(ctx, cloud);

  ctx = bootApp({ store, idb, cloud });
  await sleep(150); ctx.repairDates();
  assert.equal(duplicatesOf(ctx), 2, 'the pair merges in from the cloud');

  const res = ctx.dedupeCustomers();
  assert.ok(res.merged >= 1);
  assert.equal(duplicatesOf(ctx), 1, 'one survivor locally');
  assert.ok(ctx.DB.tombstones['test kamau|07***45678'], 'the masked twin is tombstoned');
  assert.equal(ctx.DB.tombstones['test kamau|0712345678'], undefined, 'the survivor is NOT tombstoned');
});

test('the dedupe save carries the tombstones on the settings sheet', async () => {
  const store = new Map(), idb = makeFakeIndexedDB(), cloud = makeCloud();
  let ctx = bootApp({ store, idb, cloud });
  await sleep(120); ctx.repairDates();
  seedDuplicatePair(ctx, cloud);

  ctx = bootApp({ store, idb, cloud });
  await sleep(150); ctx.repairDates();
  ctx.dedupeCustomers();
  await drain(ctx);

  assert.ok(cloud.log.length >= 1, 'a save landed');
  assert.equal(cloud.customers.filter(c => c.name === 'Test Kamau').length, 1, 'the sheet holds only the survivor');
  const tombs = JSON.parse(cloud.settings.tombstones || '{}');
  assert.ok(tombs['test kamau|07***45678'], 'the deletion itself synced via settings');
});

test('an interrupted dedupe save can no longer resurrect the duplicates (the reported bug)', async () => {
  const store = new Map(), idb = makeFakeIndexedDB(), cloud = makeCloud();
  let ctx = bootApp({ store, idb, cloud });
  await sleep(120); ctx.repairDates();
  seedDuplicatePair(ctx, cloud);

  ctx = bootApp({ store, idb, cloud });
  await sleep(150); ctx.repairDates();
  assert.equal(duplicatesOf(ctx), 2);

  // The dedupe's full-replace upload dies in flight (phone killed the tab).
  cloud.failSaves = 99;
  ctx.dedupeCustomers();
  await drain(ctx, 600);
  assert.equal(duplicatesOf(ctx), 1, 'locally merged');
  assert.equal(cloud.customers.filter(c => c.name === 'Test Kamau').length, 2, 'the stale pair is still up there');
  assert.equal(store.has('spaxPendingSync'), true, 'the interrupted save plants the resume flag');

  // Next boot: the stale cloud must NOT be unioned back over the clean local
  // list while the full-replace latch is set.
  cloud.failSaves = 0;
  ctx = bootApp({ store, idb, cloud });
  await sleep(250); ctx.repairDates();
  assert.equal(duplicatesOf(ctx), 1, 'the boot merge no longer resurrects the pair');
  await drain(ctx, 1000); // the resumed save lands the dedupe at last
  assert.equal(cloud.customers.filter(c => c.name === 'Test Kamau').length, 1, 'the cloud converges on the survivor');
  const tombs = JSON.parse(cloud.settings.tombstones || '{}');
  assert.ok(tombs['test kamau|07***45678'], 'and the tombstone lands with it');

  // A later boot merges normally again (latch cleared by the landed save)
  // and stays clean.
  ctx = bootApp({ store, idb, cloud });
  await sleep(250); ctx.repairDates();
  assert.equal(duplicatesOf(ctx), 1, 'steady state: one record');
});

test('a stale second device is scrubbed by the tombstones in the cloud settings', async () => {
  const store = new Map(), idb = makeFakeIndexedDB(), cloud = makeCloud();
  // Device 1 leaves a deduped cloud behind (survivor + tombstones).
  let ctx = bootApp({ store, idb, cloud });
  await sleep(120); ctx.repairDates();
  const { A, B } = seedDuplicatePair(ctx, cloud);
  cloud.customers = [A];
  cloud.transactions = [];
  cloud.settings = { tombstones: JSON.stringify({ [ctx.customerMergeKey(B)]: Date.now() }) };

  // Device 2 boots from a local snapshot that still holds BOTH records.
  const staleStore = new Map(), staleIdb = makeFakeIndexedDB();
  let ctx2 = bootApp({ store: staleStore, idb: staleIdb, cloud });
  await sleep(120); ctx2.repairDates();
  const snap = JSON.parse(JSON.stringify(ctx2.DB));
  snap.customers = [A, B];
  staleStore.set('spaxDB_v23', JSON.stringify(snap));

  ctx2 = bootApp({ store: staleStore, idb: staleIdb, cloud });
  await sleep(250); ctx2.repairDates();
  assert.equal(duplicatesOf(ctx2), 1, 'the tombstone deletes the stale local twin');
  assert.ok(ctx2.DB.tombstones[ctx2.customerMergeKey(B)], 'and is adopted locally');

  // Whatever device 2 pushes next can only be the clean list.
  ctx2.saveToCloud(true, 'device-2');
  await drain(ctx2, 800);
  assert.equal(cloud.customers.filter(c => c.name === 'Test Kamau').length, 1);
});

test('Smart Merge refuses to run while a destructive full replace is still pending', async () => {
  const store = new Map(), idb = makeFakeIndexedDB(), cloud = makeCloud();
  const ctx = bootApp({ store, idb, cloud });
  await sleep(120); ctx.repairDates();
  ctx.spaxMarkTxFullReplace();
  await ctx.smartMergeCloud();
  assert.equal(ctx.DB.customers.length, 1669, 'nothing was merged while the latch is set');
  ctx.spaxClearTxFullReplace();
});

test('source pins: guard, tombstone merge and payload wiring stay wired', () => {
  const load = htmlSource.slice(
    htmlSource.indexOf('async function loadFromCloud()'),
    htmlSource.indexOf('async function loadFromCloud()') + 6000
  );
  assert.match(load, /spaxTxFullReplaceRequired\(\)/, 'the local-authoritative guard must sit in loadFromCloud');
  assert.match(load, /spaxMergeTombstoneSets\(/, 'the merge must union tombstones');
  assert.match(load, /spaxDropTombstonedCustomers\(/, 'the merge must drop tombstoned records');

  const payload = htmlSource.slice(
    htmlSource.indexOf('function spaxBuildSavePayload()'),
    htmlSource.indexOf('function spaxComputeDeltaRows(')
  );
  assert.match(payload, /tombstones: JSON\.stringify\(spaxPruneTombstones/, 'tombstones must ride the settings sheet');

  const dedupe = htmlSource.slice(
    htmlSource.indexOf('function dedupeCustomers()'),
    htmlSource.indexOf('window.dedupeCustomers')
  );
  assert.match(dedupe, /DB\.tombstones\[tk\] = tombNow/, 'dedupe must tombstone every merged-away record');
  assert.match(dedupe, /delete DB\.tombstones\[sk\]/, 'and must protect the survivor\'s key');

  const smart = htmlSource.slice(
    htmlSource.indexOf('async function smartMergeCloud()'),
    htmlSource.indexOf('async function smartMergeCloud()') + 2500
  );
  assert.match(smart, /spaxTxFullReplaceRequired\(\)/, 'smart merge must stand down while a full replace is pending');
});
