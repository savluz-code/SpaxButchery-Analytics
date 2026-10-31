'use strict';

// Regression guard for the "new customer this month" tag.
//
// The tag used to be derived from `firstVisit` alone, so it could be LOST
// whenever that date was rewritten: a cloud merge that took the other side's
// (later) first visit, a pull from a sheet written before the tag existed, or
// a date repair. The badge then silently disappeared from a customer who had
// bought for the first time that very month.
//
// The tag is now STORED on the customer record (`newMonth` — the calendar
// month they were tagged in) and healed on load, so it is PERSISTENT for the
// month it was earned and only expires when the calendar month rolls over.
//
// What must stay true:
//   • An import tags a new customer with the month they first bought.
//   • The tag survives a second import in the same month, a newer import
//     batch, a reload and a cloud merge.
//   • A record that lost its tag gets it back; a record that lost its first
//     VISIT keeps the tag it already carries.
//   • The tag expires by itself when the month rolls over.
//   • The badge is visible in the customers table and on the customer card.
//   • The cloud sheet carries the tag (the newMonth column).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const gasSource = fs.readFileSync(path.join(root, 'google-apps-script.gs'), 'utf8');

const TODAY = '2026-10-14';

/* ── minimal DOM / browser shims ─────────────────────────────────────────── */
function makeElement(id) {
  const el = {
    id, style: {}, dataset: {}, children: [], _html: '', textContent: '', value: '', checked: false, files: [],
    _sel: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); return c; }, removeChild() {},
    // Stable per selector, so a test can read what the app wrote into
    // `element.querySelector('tbody').innerHTML`.
    querySelector(sel) { if (!this._sel[sel]) this._sel[sel] = makeElement(id + sel); return this._sel[sel]; },
    querySelectorAll() { return []; }, getContext() { return {}; },
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
      queueMicrotask(() => { req.result = db; req.onsuccess && req.onsuccess(); });
      return req;
    }
  };
}

function bootApp({ localStorageSeed = {}, cloud = null, indexedDB = undefined, today = TODAY } = {}) {
  const els = new Map();
  const savedPayloads = [];
  const store = new Map(Object.entries(localStorageSeed));
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
  Chart.defaults = {};
  Chart.register = () => {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document, localStorage,
    navigator: { serviceWorker: { register: () => Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve({}) } }) }, clipboard: {}, onLine: true, userAgent: 'node' },
    location: { href: 'http://localhost/', search: '', hostname: 'localhost', reload() {} },
    fetch: async (url, opts) => {
      if (!cloud) throw new Error('offline');
      const body = opts && opts.body ? String(opts.body) : '';
      if (/"action"\s*:\s*"save/.test(body) || /action=save/.test(String(url))) {
        try { savedPayloads.push(JSON.parse(body)); } catch (_) {}
        return { ok: true, status: 200, json: async () => ({ success: true }), text: async () => '{"success":true}' };
      }
      const payload = { success: true, ...cloud };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
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
  if (indexedDB !== undefined) sandbox.indexedDB = indexedDB;
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const scripts = [...htmlSource.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc\s*=/.test(m[1] || '') && m[2].trim())
    .map(m => m[2]);
  scripts.forEach((src, i) => vm.runInContext(src, ctx, { filename: `index-inline-${i}.js` }));
  // Pin "today" so days-since figures and the current month are deterministic.
  vm.runInContext(`getTodayEAT = function(){ return ${JSON.stringify(today)}; };`, ctx);
  const app = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string' || name === 'then' || name === 'constructor' || name === 'toJSON' || name === 'inspect') return undefined;
      if (name === 'ctx') return ctx;
      if (name === 'document') return document;
      if (name === 'savedPayloads') return savedPayloads;
      if (name === 'set') return (n, v) => { ctx.__v = v; vm.runInContext(`${n} = __v;`, ctx); };
      return vm.runInContext(String(name), ctx);
    },
    set(_, name, value) { ctx.__v = value; vm.runInContext(`${name} = __v;`, ctx); return true; }
  });
  return app;
}

async function bootLoaded(opts) {
  const ctx = bootApp(opts);
  await new Promise(r => setTimeout(r, 60));
  return ctx;
}

const row = (name, phone, date, amount, receipt, time = '10:00:00') =>
  ({ name, phone, contact: phone, date, time, amount, receipt, visits: 1, source: 'test' });

const byName = (ctx, name) => ctx.DB.customers.find(c => c.name === name);

test('an import tags the customer with the month they first bought', async () => {
  const ctx = await bootLoaded();
  const res = ctx.importTransactions([row('Tagged Buyer', '0712000555', '2026-10-09', 800, 'TBY1ABCDEF1')]);
  assert.equal(res.added, 1);

  const rec = byName(ctx, 'Tagged Buyer');
  assert.ok(rec, 'the customer was created');
  assert.equal(rec.firstVisit, '2026-10-09');
  assert.equal(rec.newMonth, '2026-10', 'the tag names the month of the first purchase');
  assert.equal(ctx.isNewThisMonth(rec), true, 'the customer is new this month');
  assert.equal(ctx.isNewThisMonth(rec, '2026-09'), false, 'and new in no other month');
});

test('the tag is persistent for the month: a second import and a newer batch keep it', async () => {
  const ctx = await bootLoaded();
  ctx.importTransactions([row('Persistent Buyer', '0712000666', '2026-10-03', 500, 'PSB1ABCDEF1')]);

  // A second statement later in the SAME month must not take the tag away.
  ctx.importTransactions([row('Persistent Buyer', '0712000666', '2026-10-21', 300, 'PSB2ABCDEF1')]);
  let rec = byName(ctx, 'Persistent Buyer');
  assert.equal(rec.newMonth, '2026-10', 'the tag survived a second import in the same month');
  assert.equal(ctx.isNewThisMonth(rec), true);

  // A NEWER import batch used to clear the old teal "new" flag — the
  // new-customer tag must not follow that flag.
  ctx.DB.importBatch = 9;
  ctx.reconcileNewFlags();
  rec = byName(ctx, 'Persistent Buyer');
  assert.equal(rec.isNew, false, 'the provenance flag expires with the batch, as before');
  assert.equal(rec.newMonth, '2026-10', 'the new-customer tag does not');
  assert.equal(ctx.isNewThisMonth(rec), true, 'the customer is still tagged as new this month');
});

test('the tag survives a reload', async () => {
  const fake = makeFakeIndexedDB();
  const ctx1 = await bootLoaded({ indexedDB: fake });
  ctx1.importTransactions([row('Reload Buyer', '0712000333', '2026-10-05', 400, 'RLD1ABCDEF1')]);
  ctx1.save();
  await new Promise(r => setTimeout(r, 30));

  const ctx2 = await bootLoaded({ indexedDB: fake });
  const rec = byName(ctx2, 'Reload Buyer');
  assert.ok(rec, 'the customer survived the restart');
  assert.equal(rec.newMonth, '2026-10', 'the tag survived the restart');
  assert.equal(ctx2.isNewThisMonth(rec), true);
});

test('a record that lost its tag gets it back, and one that lost its first visit keeps it', async () => {
  const ctx = await bootLoaded();
  ctx.importTransactions([row('Lost Tag Buyer', '0712000444', '2026-10-07', 300, 'LST1ABCDEF1')]);
  const rec = byName(ctx, 'Lost Tag Buyer');

  // The stored tag was lost (an older save, or a merge from a sheet without
  // it). The first visit still proves the acquisition, so the customer is
  // still tagged — and the stored tag is restored, so the badge can no
  // longer be lost by a later rewrite of that date.
  rec.newMonth = '';
  assert.equal(ctx.isNewThisMonth(rec), true, 'the first visit still proves the acquisition');
  ctx.restoreNewMonthTags();
  assert.equal(rec.newMonth, '2026-10', 'the stored tag is restored from the first visit');
  assert.equal(ctx.isNewThisMonth(rec), true);

  // The first VISIT was lost instead — the tag must carry it.
  rec.firstVisit = '';
  ctx.restoreNewMonthTags();
  assert.equal(rec.newMonth, '2026-10', 'the tag survives a lost first-visit date');
  assert.equal(ctx.isNewThisMonth(rec), true);
});

test('the tag survives a cloud merge whose copy carries a later first visit', async () => {
  // Session 1 (offline): the customer buys for the first time on the 3rd.
  const local = await bootLoaded();
  local.importTransactions([row('Merged Buyer', '0712000222', '2026-10-03', 500, 'MRG1ABCDEF1')]);
  const localDb = JSON.parse(JSON.stringify(local.DB));
  assert.equal(byName(local, 'Merged Buyer').newMonth, '2026-10');

  // Session 2: the sheet holds the same customer with a LATER first visit
  // and no tag at all — a sheet written before the tag existed.
  const sheet = {
    customers: [{
      name: 'Merged Buyer', contact: '0712000222', spent: 900, visits: 2, days: 0,
      firstVisit: '2026-10-20', lastVisit: '2026-10-20', masked: false, isNew: false, isSeed: false,
      seedSpent: 0, seedVisits: 0, seedLastVisit: ''
    }],
    monthly: { labels: [], revenue: [] },
    settings: { importedRev: 0, importedTx: 0, resolved: 0, importBatch: 1 },
    transactions: [], customerTx: {}, seen: {}
  };
  const ctx = await bootLoaded({ localStorageSeed: { spaxDB_v23: JSON.stringify(localDb) }, cloud: sheet });
  await ctx.loadFromCloud();

  const rec = byName(ctx, 'Merged Buyer');
  assert.ok(rec, 'the customer survived the merge');
  assert.equal(rec.firstVisit, '2026-10-03', 'the first visit is the earliest either side knows');
  assert.equal(rec.newMonth, '2026-10', 'the tag survived the merge');
  assert.equal(ctx.isNewThisMonth(rec), true, 'the customer is still tagged as new this month');
});

test('the tag expires by itself when the calendar month rolls over', async () => {
  const ctx = await bootLoaded({ today: '2026-11-02' });
  ctx.importTransactions([
    row('October Buyer', '0712000777', '2026-10-05', 300, 'OCT1ABCDEF1'),
    row('November Buyer', '0712000888', '2026-11-01', 300, 'NOV1ABCDEF1')
  ]);
  const oct = byName(ctx, 'October Buyer');
  const nov = byName(ctx, 'November Buyer');
  assert.equal(oct.newMonth, '2026-10');
  assert.equal(nov.newMonth, '2026-11');
  assert.equal(ctx.isNewThisMonth(oct), false, 'last month\'s customer is no longer new this month');
  assert.equal(ctx.isNewThisMonth(nov), true, 'this month\'s customer is new this month');
});

test('the badge is visible in the customers table and on the customer card', async () => {
  const ctx = await bootLoaded();
  ctx.importTransactions([row('Visible Buyer', '0712000999', '2026-10-06', 900, 'VIS1ABCDEF1')]);
  ctx.renderCustTable();
  const table = ctx.document.getElementById('custTable').querySelector('tbody').innerHTML;
  assert.match(table, /b-month/, 'the gold new-customer badge is rendered');
  assert.match(table, /New customer/, 'and it is labelled, not a bare emoji');

  ctx.showCustomerDetail('Visible Buyer');
  const card = ctx.document.getElementById('modalCustInfo').innerHTML;
  assert.match(card, /New customer this month/, 'the customer card names the tag');
});

test('the cloud sheet carries the tag', () => {
  assert.match(gasSource, /'newMonth'/, 'the Customers sheet has a newMonth column');
  assert.match(gasSource, /c\.newMonth\s*=/, 'the backend normalises the tag on load');
  assert.match(htmlSource, /newMonth: spaxMonthOnly\(/, 'the client stores the tag on the record');
});
