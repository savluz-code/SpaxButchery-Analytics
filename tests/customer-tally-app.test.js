'use strict';

// Full-app regression guard for the doubled header revenue after PR #47
// (KES 4,075K instead of ~1,250K). It boots the REAL index.html — every
// inline script, the real 1,669-row SEED_CUSTOMERS, the real import /
// rollback / rebuild / modal code — inside a vm sandbox with a minimal DOM
// and an offline cloud, then drives it the way the app is used.
//
// What must stay true:
//   • A fresh seed load: Σ spent = 1,250,341 = REPORT.totalRevenue exactly.
//   • Every seed customer's cut-off is the REPORT date (Last Visit + Days
//     Since, 2026-07-12 for the report as a whole), not their own Last Visit.
//   • An ITEMISED document is preferred over the seed data: a statement that
//     reaches past a customer's report aggregate replaces it (and the extra is
//     dated to the receipts' own months). A statement that falls short leaves
//     the aggregate as the floor for the part of the period it does not cover —
//     the report counts cash too, a statement only ever shows the M-Pesa side.
//   • A row dated after the report cut-off is always added on top — and the
//     Overview, importedRev and the monthly chart move by the same amount.
//   • A phone whose history holds every report receipt twice comes back to
//     exactly the report total plus the post-report rows.
//   • Rollback debits importedRev / monthly by the drop in derived totals.
//   • Full Rebuild restarts the monthly chart from SEED_MONTHLY (+ ledgers).
//   • The app's own Export CSV, re-imported, changes nothing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const TODAY = '2026-09-05';
const REPORT_DATE = '2026-07-12'; // latest Last Visit + Days Since in the seed report

/* ── minimal DOM / browser shims ─────────────────────────────────────────── */
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

// Minimal in-memory IndexedDB stand-in (same surface the app's IDB layer
// uses): open → onupgradeneeded/onsuccess, transaction/objectStore,
// get/put/delete with request + transaction callbacks. The Map is shared
// between sessions, which is what makes the restart test meaningful.
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

function bootApp({ localStorageSeed = {}, cloud = null, indexedDB = undefined } = {}) {
  const els = new Map();
  const savedPayloads = [];   // every payload POSTed to the stand-in Sheet
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
    // Offline by default. When `cloud` is supplied it stands in for the Google
    // Sheet: loads return it, saves are accepted and discarded.
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
  // Pin "today" so days-since figures are deterministic.
  vm.runInContext(`getTodayEAT = function(){ return ${JSON.stringify(TODAY)}; };`, ctx);
  // Script-level let/const bindings (DB, REPORT, kes, parseAnyFile…) live in
  // the context's declarative record, not on the global object: reach them
  // through an evaluator that runs inside the context.
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

// load() is async (it tries the cloud, which is offline here) — wait for it.
async function bootLoaded(opts) {
  const ctx = bootApp(opts);
  await new Promise(r => setTimeout(r, 50));
  ctx.repairDates();
  return ctx;
}

const sumSpent = ctx => Math.round(ctx.DB.customers.reduce((s, c) => s + (Number(c.spent) || 0), 0) * 100) / 100;
const sumVisits = ctx => ctx.DB.customers.reduce((s, c) => s + (Number(c.visits) || 0), 0);
const monthlyTotal = ctx => Math.round(ctx.DB.monthly.revenue.reduce((s, v) => s + (Number(v) || 0), 0) * 100) / 100;
const monthOf = (ctx, mk) => { const i = ctx.DB.monthly.labels.indexOf(mk); return i >= 0 ? ctx.DB.monthly.revenue[i] : 0; };
const byName = (ctx, name) => ctx.DB.customers.find(c => c.name === name);
const kesText = (ctx, n) => ctx.kes(n);

const row = (name, phone, date, amount, receipt, time = '10:00:00') => ({ name, phone, contact: phone, date, time, amount, receipt, visits: 1, source: 'test' });

test('a fresh seed load sums to exactly the report revenue, with the report date as every cut-off', async () => {
  const ctx = await bootLoaded();
  assert.equal(ctx.DB.customers.length, 1669);
  assert.equal(sumSpent(ctx), 1250341);
  assert.equal(sumSpent(ctx), ctx.REPORT.totalRevenue);
  assert.equal(sumVisits(ctx), ctx.REPORT.totalTxns);
  assert.equal(ctx.getProductStats().totalRevenue, ctx.REPORT.totalRevenue);
  assert.equal(ctx.seedReportCutoff(), REPORT_DATE);
  for (const c of ctx.DB.customers) {
    assert.equal(c.isSeed, true, c.name);
    assert.equal(c.seedLastVisit, REPORT_DATE, `${c.name} cut-off`);
  }
  // Stable: repairDates is idempotent on the seed.
  assert.equal(ctx.repairDates(), 0);
  assert.equal(sumSpent(ctx), 1250341);
});

test('a database the merged build wrote (own Last Visit as cut-off, double-booked rows) heals to the report total', async () => {
  // Build the state PR #47 left behind: every seed customer's cut-off stamped
  // with their own Last Visit, and statement rows dated between their last
  // purchase and the report date booked on top of the report figures.
  const fresh = await bootLoaded();
  const persisted = JSON.parse(JSON.stringify(fresh.DB));
  const georgeSeed = persisted.customers.find(c => c.name === 'George Owiti');
  georgeSeed.seedLastVisit = '2026-06-01';
  georgeSeed.spent = 900; georgeSeed.visits = 3; // 600/2 + a 2026-07-01 row booked again
  persisted.customerTx['George Owiti'] = [{ date: '2026-07-01', amount: 300, product: 'meat', receipt: 'UGA1ABCDEF1', importedAt: '2026-07-02T00:00:00Z' }];
  persisted.transactions.push({ date: '2026-07-01', time: '10:00:00', amount: 300, name: 'George Owiti', phone: '0710428075', product: 'meat', receipt: 'UGA1ABCDEF1', source: 'test', importedAt: '2026-07-02T00:00:00Z' });
  persisted.customers.forEach(c => { if (c !== georgeSeed) c.seedLastVisit = c.lastVisit; });

  const ctx = await bootLoaded({ localStorageSeed: { spaxDB_v23: JSON.stringify(persisted) } });
  const george = byName(ctx, 'George Owiti');
  assert.equal(george.seedLastVisit, REPORT_DATE);
  assert.equal(george.spent, 600);
  assert.equal(george.visits, 2);
  assert.equal(sumSpent(ctx), 1250341);
  ctx.DB.customers.forEach(c => assert.equal(c.seedLastVisit, REPORT_DATE, c.name));
});

test('a statement row dated inside the report period never moves the total; a row after it is added on top everywhere', async () => {
  const ctx = await bootLoaded();
  const george = byName(ctx, 'George Owiti');
  assert.equal(george.spent, 600); assert.equal(george.visits, 2);
  const rev0 = ctx.getProductStats().totalRevenue, imp0 = ctx.DB.importedRev, mon0 = monthlyTotal(ctx), jul0 = monthOf(ctx, '2026-07');

  // 2026-07-01 is before the report date (2026-07-12): already in the 600.
  let r = ctx.importTransactions([row('George Owiti', '0710428075', '2026-07-01', 300, 'UGA1ABCDEF1')]);
  assert.equal(r.imported, 1);
  assert.equal(george.spent, 600); assert.equal(george.visits, 2);
  assert.equal(ctx.getProductStats().totalRevenue, rev0);
  assert.equal(ctx.DB.importedRev, imp0);
  assert.equal(monthlyTotal(ctx), mon0);
  assert.equal(monthOf(ctx, '2026-07'), jul0);

  // 2026-07-13 is after it: new business.
  r = ctx.importTransactions([row('George Owiti', '0710428075', '2026-07-13', 300, 'UGB1ABCDEF1')]);
  assert.equal(r.imported, 1);
  assert.equal(george.spent, 900); assert.equal(george.visits, 3);
  assert.equal(ctx.getProductStats().totalRevenue, rev0 + 300);
  assert.equal(ctx.DB.importedRev, imp0 + 300);
  assert.equal(Math.round(monthlyTotal(ctx) * 100) / 100, Math.round((mon0 + 300) * 100) / 100);
  assert.equal(Math.round(monthOf(ctx, '2026-07') * 100) / 100, Math.round((jul0 + 300) * 100) / 100);
  assert.equal(sumSpent(ctx), 1250341 + 300);

  // Re-importing the same statement is a no-op (dedup guard).
  r = ctx.importTransactions([row('George Owiti', '0710428075', '2026-07-13', 300, 'UGB1ABCDEF1')]);
  assert.equal(r.dupes, 1);
  assert.equal(george.spent, 900);
  assert.equal(ctx.DB.importedRev, imp0 + 300);
});

test('George from the screenshots: his April statement supersedes the report row — 7 receipts = 2100/7, and the modal footer reconciles', async () => {
  const ctx = await bootLoaded();
  const george = byName(ctx, 'George Owiti');
  const apr0 = monthOf(ctx, '2026-04');
  // The report row says 600 / 2 visits; the statement covering the same period
  // shows four dated receipts worth 1,200 — including purchases in April,
  // before the report's own first visit for him. An itemised document is
  // preferred over the seed data (see CUSTOMER TALLY), so it takes over
  // instead of being hidden behind the aggregate.
  const rows = [
    row('George Owiti', '0710428075', '2026-04-17', 300, 'UDA1ABCDEF1'), row('George Owiti', '0710428075', '2026-04-18', 300, 'UDA2ABCDEF1'),
    row('George Owiti', '0710428075', '2026-04-19', 300, 'UDA3ABCDEF1'), row('George Owiti', '0710428075', '2026-04-20', 300, 'UDA4ABCDEF1')
  ];
  ctx.backfillTransactions(rows);
  ctx.repairDates();
  assert.equal(george.spent, 1200); assert.equal(george.visits, 4);
  assert.equal(ctx.DB.importedRev, 600, 'the 600 the report never carried is imported revenue now');
  assert.equal(monthOf(ctx, '2026-04'), apr0 + 600, 'and it lands in the month those receipts belong to');
  assert.equal(sumSpent(ctx), 1250341 + 600);
  ctx.importTransactions([
    row('George Owiti', '0710428075', '2026-09-01', 300, 'UIA1ABCDEF1'), row('George Owiti', '0710428075', '2026-09-02', 300, 'UIA2ABCDEF1'),
    row('George Owiti', '0710428075', '2026-09-03', 300, 'UIA3ABCDEF1')
  ]);
  assert.equal(george.spent, 2100); assert.equal(george.visits, 7);
  assert.equal(ctx.DB.importedRev, 1500);
  assert.equal(sumSpent(ctx), 1250341 + 1500);
  assert.equal(ctx.REPORT.totalRevenue + ctx.DB.importedRev, sumSpent(ctx), 'header invariant');
  assert.equal(Math.round(monthlyTotal(ctx)), Math.round(SEED_MONTHLY_TOTAL + ctx.DB.importedRev), 'monthly invariant');

  ctx.showCustomerDetail('George Owiti');
  const html = ctx.document.getElementById('modalTxList').innerHTML;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /Listed above 7 tx · KES 2,100/);
  assert.match(text, new RegExp(`Statement supersedes the report total \\(up to ${REPORT_DATE}\\) \\+2 visits · KES 600`));
  assert.match(text, /= Total 7 visits · KES 2,100/);
  assert.doesNotMatch(text, /not itemised/);
  assert.doesNotMatch(text, /Already in the report total/);
  assert.equal(ctx.document.getElementById('modalTotal').textContent, kesText(ctx, 2100));
  assert.equal(ctx.document.getElementById('modalVisits').textContent, 7);
});

test('a statement that reaches past the report aggregate supersedes it — card, header and the receipts\' own months', async () => {
  const ctx = await bootLoaded();
  const florah = byName(ctx, 'Florah Olisa Esikuri');   // report row: KES 20 / 1 visit
  assert.equal(florah.spent, 20); assert.equal(florah.visits, 1);
  const oct0 = monthOf(ctx, '2025-10'), nov0 = monthOf(ctx, '2025-11');

  // A partial statement (one receipt) does NOT displace the aggregate: it says
  // nothing about the rest of the period, so the aggregate stays the floor.
  ctx.backfillTransactions([row('Florah Olisa Esikuri', '0714445070', '2025-10-05', 20, 'UFL0ABCDEF0')]);
  ctx.repairDates();
  assert.equal(florah.spent, 20); assert.equal(florah.visits, 1);
  assert.equal(ctx.DB.importedRev, 0);
  assert.equal(monthOf(ctx, '2025-10'), oct0, 'a statement under the aggregate moves no month');

  // The full statement: five dated receipts worth 1,000 against the report's
  // 20. The itemised document wins, and the 980 the report never carried is
  // credited to the months those receipts belong to — in proportion, not
  // dumped on the cut-off month the way the un-itemised surplus has to be.
  const stmt = [
    row('Florah Olisa Esikuri', '0714445070', '2025-10-05', 20, 'UFL0ABCDEF0'),
    row('Florah Olisa Esikuri', '0714445070', '2025-10-12', 300, 'UFL1ABCDEF1'),
    row('Florah Olisa Esikuri', '0714445070', '2025-10-20', 180, 'UFL2ABCDEF2'),
    row('Florah Olisa Esikuri', '0714445070', '2025-11-03', 300, 'UFL3ABCDEF3'),
    row('Florah Olisa Esikuri', '0714445070', '2025-11-19', 200, 'UFL4ABCDEF4')
  ];
  ctx.backfillTransactions(stmt);
  ctx.repairDates();
  assert.equal(florah.spent, 1000); assert.equal(florah.visits, 5);
  assert.equal(ctx.DB.importedRev, 980);
  assert.equal(sumSpent(ctx), 1250341 + 980);
  assert.equal(ctx.REPORT.totalRevenue + ctx.DB.importedRev, sumSpent(ctx), 'header invariant');
  assert.equal(Math.round(monthlyTotal(ctx)), Math.round(SEED_MONTHLY_TOTAL + ctx.DB.importedRev), 'monthly invariant');
  // KES 500 of the statement sits in each month, so the 980 splits evenly.
  assert.equal(monthOf(ctx, '2025-10'), oct0 + 490);
  assert.equal(monthOf(ctx, '2025-11'), nov0 + 490);

  // Re-importing the same statement changes nothing: the receipt dedupe runs
  // before the tally, so a supersede can never be manufactured by re-importing.
  ctx.importTransactions(stmt);
  assert.equal(florah.spent, 1000, 'a re-imported statement must not raise the supersede');
  assert.equal(florah.visits, 5);
  assert.equal(ctx.DB.importedRev, 980);
  const settled = JSON.stringify(ctx.DB);
  ctx.repairDates();
  assert.equal(JSON.stringify(ctx.DB), settled, 'idempotent');
});

test('a phone whose history holds every report receipt twice comes back to exactly the report total plus post-report rows', async () => {
  const fresh = await bootLoaded();
  const persisted = JSON.parse(JSON.stringify(fresh.DB));
  // Onyango Akinyi Edwina: 9,960 / 33 up to 2026-07-12. An older build let the
  // whole statement in twice, plus two September rows, also twice.
  const seedRows = [];
  for (let i = 0; i < 33; i++) seedRows.push({ date: '2026-0' + (1 + (i % 6)) + '-' + String(10 + (i % 18)).padStart(2, '0'), amount: 300, product: 'meat', receipt: 'SEED' + String(i).padStart(7, '0'), importedAt: 'x' });
  const post = [{ date: '2026-09-01', amount: 400, product: 'meat', receipt: 'POST0000001', importedAt: 'x' }, { date: '2026-09-02', amount: 200, product: 'meat', receipt: 'POST0000002', importedAt: 'x' }];
  const twice = a => a.concat(JSON.parse(JSON.stringify(a)));
  persisted.customerTx['Onyango Akinyi Edwina'] = twice(seedRows.concat(post));
  const rec = persisted.customers.find(c => c.name === 'Onyango Akinyi Edwina');
  rec.spent = 99999; rec.visits = 999; // drifted

  const ctx = await bootLoaded({ localStorageSeed: { spaxDB_v23: JSON.stringify(persisted) } });
  const c = byName(ctx, 'Onyango Akinyi Edwina');
  assert.equal(ctx.DB.customerTx['Onyango Akinyi Edwina'].length, 35);
  assert.equal(c.spent, 9960 + 600);
  assert.equal(c.visits, 33 + 2);
  assert.equal(sumSpent(ctx), 1250341 + 600);
  assert.equal(ctx.repairDates(), 0);
});

test('rollback debits importedRev and the monthly chart by the drop in derived totals, not the raw duplicate sum', async () => {
  const ctx = await bootLoaded();
  const george = byName(ctx, 'George Owiti');
  // One duplicate INSIDE the report period (worth 0 revenue) and one AFTER it
  // (worth 300) — force them past the import guard as an older build did.
  const inside = row('George Owiti', '0710428075', '2026-07-01', 300, 'UGA1ABCDEF1');
  const after = row('George Owiti', '0710428075', '2026-08-20', 300, 'UGC1ABCDEF1');
  ctx.importTransactions([inside, after]);
  assert.equal(george.spent, 900);
  const imp1 = ctx.DB.importedRev, aug1 = monthOf(ctx, '2026-08'), jul1 = monthOf(ctx, '2026-07');
  assert.equal(imp1, 300);
  // Duplicate both rows behind the guard's back (distinct importedAt so the
  // rollback removes exactly one history copy each).
  ctx.DB.transactions.forEach(t => { if (t.receipt === 'UGA1ABCDEF1' || t.receipt === 'UGC1ABCDEF1') { const d = { ...t, importedAt: 'dup' }; ctx.DB.transactions.push(d); ctx.DB.customerTx['George Owiti'].push({ date: d.date, amount: d.amount, product: d.product, receipt: d.receipt, importedAt: 'dup' }); } });
  // Pretend the duplicates had been booked as the merged build would have
  // (600 raw). The ledgers are DERIVED (REVENUE LEDGERS), so repairDates()
  // simply corrects this hand-written inflation back to the truth — this is
  // the leak PR #48 left open: it fixed the cards but never re-derived the
  // money, so an inflated importedRev / monthly chart survived forever.
  ctx.DB.importedRev = imp1 + 300;
  const i8 = ctx.DB.monthly.labels.indexOf('2026-08'); ctx.DB.monthly.revenue[i8] += 300;
  ctx.repairDates();
  assert.equal(george.spent, 900, 'duplicate receipts are dropped from the history by repairDates');
  assert.equal(ctx.DB.importedRev, imp1, 'the injected inflation is re-derived away');
  assert.equal(monthOf(ctx, '2026-08'), aug1, 'so is the inflated August bucket');

  const res = ctx.reconcileImportedRevenue();
  assert.equal(res.removed, 2);
  assert.equal(res.amount, 600, 'raw duplicate sum is still reported');
  assert.equal(george.spent, 900);
  assert.equal(george.visits, 3);
  // History already de-duplicated by repairDates → derived totals did not
  // drop when the transaction copies went, so nothing is debited: the raw 600
  // must NOT have been subtracted.
  assert.equal(res.rolledBack, 0);
  assert.equal(ctx.DB.importedRev, imp1);
  assert.equal(monthOf(ctx, '2026-08'), aug1);
  assert.equal(monthOf(ctx, '2026-07'), jul1);
});

test('rollback of a duplicate that did inflate the card debits exactly that inflation', async () => {
  const ctx = await bootLoaded();
  const george = byName(ctx, 'George Owiti');
  ctx.importTransactions([row('George Owiti', '0710428075', '2026-08-20', 300, 'UGC1ABCDEF1')]);
  assert.equal(george.spent, 900);
  const imp1 = ctx.DB.importedRev, aug1 = monthOf(ctx, '2026-08');
  // A composite-key duplicate (no receipt) slipped through: it inflated the
  // card by 300 and was booked as such.
  const dup = { date: '2026-08-21', time: '', amount: 300, name: 'George Owiti', phone: '0710428075', product: 'meat', receipt: '', source: 'test', importedAt: 'a' };
  ctx.DB.transactions.push(dup, { ...dup, importedAt: 'b' });
  ctx.DB.customerTx['George Owiti'].push({ date: '2026-08-21', amount: 300, product: 'meat', receipt: '', importedAt: 'a' }, { date: '2026-08-21', amount: 300, product: 'meat', receipt: '', importedAt: 'b' });
  ctx.repairDates();
  assert.equal(george.spent, 1500, 'rows without a receipt are never deduped by repairDates');
  ctx.DB.importedRev = imp1 + 600;
  ctx.DB.monthly.revenue[ctx.DB.monthly.labels.indexOf('2026-08')] += 600;

  const res = ctx.reconcileImportedRevenue();
  assert.equal(res.removed, 1);
  assert.equal(res.rolledBack, 300);
  assert.equal(george.spent, 1200);
  assert.equal(george.visits, 4);
  assert.equal(ctx.DB.importedRev, imp1 + 300);
  assert.equal(Math.round(monthOf(ctx, '2026-08') * 100) / 100, Math.round((aug1 + 300) * 100) / 100);
});

test('Full Rebuild restarts the monthly chart from the seed months (+ daily ledgers) instead of crediting every month twice', async () => {
  const ctx = await bootLoaded();
  const seedMonthly = monthlyTotal(ctx);
  const aug0 = monthOf(ctx, '2026-08');
  // A daily ledger (not a statement — it is not re-imported by a rebuild).
  ctx.DB.dailyLedgers.push({ date: '2026-08-15', revenue: 1000, items: [] });
  ctx.DB.importedRev += 1000;
  ctx.DB.monthly.revenue[ctx.DB.monthly.labels.indexOf('2026-08')] += 1000;
  const stmt = [row('George Owiti', '0710428075', '2026-08-20', 300, 'UGC1ABCDEF1'), row('Brand New Person', '0799000111', '2026-08-21', 450, 'UGD1ABCDEF1')];
  ctx.importTransactions(stmt);
  assert.equal(monthOf(ctx, '2026-08'), aug0 + 1000 + 750);
  assert.equal(ctx.DB.importedRev, 1000 + 750);

  // Rebuild from the same statement: parseAnyFile is replaced by a stub that
  // returns the rows again.
  ctx.parseAnyFile = async () => stmt.map(r => ({ ...r }));
  ctx.saveToCloud = async () => true;
  await ctx.handleRebuild({ files: [{ name: 'statement.csv' }], value: '' });
  assert.equal(monthOf(ctx, '2026-08'), aug0 + 1000 + 750, 'August is credited once, not twice');
  assert.equal(monthlyTotal(ctx), seedMonthly + 1000 + 750);
  assert.equal(ctx.DB.importedRev, 1000 + 750);
  assert.equal(byName(ctx, 'George Owiti').spent, 900);
  assert.equal(byName(ctx, 'Brand New Person').spent, 450);
  assert.equal(sumSpent(ctx), 1250341 + 750);
});

test('a Full Rebuild wipes only the statement period and leaves periods before/after untouched', async () => {
  const ctx = await bootLoaded();
  const jul0 = monthOf(ctx, '2026-07');
  // Import two separate statement periods: a July row and an August row.
  ctx.importTransactions([
    row('George Owiti', '0710428075', '2026-07-20', 500, 'UJ1ABCDEF1'),
    row('George Owiti', '0710428075', '2026-08-20', 300, 'UJ2ABCDEF1')
  ]);
  const sumAfterTwo = sumSpent(ctx);
  const julAfter = monthOf(ctx, '2026-07');
  assert.equal(julAfter, jul0 + 500, 'July credited before the rebuild');
  assert.equal(monthOf(ctx, '2026-08'), 300, 'August credited before the rebuild');

  // Rebuild ONLY the August statement — July must survive untouched.
  ctx.parseAnyFile = async () => [row('George Owiti', '0710428075', '2026-08-20', 300, 'UJ2ABCDEF1')];
  ctx.saveToCloud = async () => true;
  await ctx.handleRebuild({ files: [{ name: 'august.csv' }], value: '' });

  assert.equal(monthOf(ctx, '2026-07'), julAfter, 'July is preserved after a rebuild of August');
  assert.equal(monthOf(ctx, '2026-08'), 300, 'August is credited once (wiped + re-imported)');
  // George has a 600 seed baseline; he keeps the July row and gets the rebuilt
  // August row back → 600 + 500 + 300 = 1400.
  assert.equal(byName(ctx, 'George Owiti').spent, 1400, 'George keeps the July row and gets the rebuilt August row back');
  assert.equal(sumSpent(ctx), sumAfterTwo, 'no revenue is lost or double-counted by a scoped rebuild');
  assert.equal(ctx.DB.importedRev, 800, 'importedRev = 500 (July) + 300 (August)');

  // Rebuild a period that was never imported (after the report cut-off) must
  // not clear anything else — it is simply added on top.
  ctx.parseAnyFile = async () => [row('George Owiti', '0710428075', '2026-09-10', 150, 'UF1ABCDEF1')];
  await ctx.handleRebuild({ files: [{ name: 'september.csv' }], value: '' });
  assert.equal(monthOf(ctx, '2026-07'), julAfter, 'rebuilding September leaves July alone');
  assert.equal(monthOf(ctx, '2026-08'), 300, 'and August stays put too');
  assert.equal(byName(ctx, 'George Owiti').spent, 1550, 'the September row is added on top');
  assert.equal(ctx.DB.importedRev, 950, 'importedRev = 500 (July) + 300 (August) + 150 (September)');
});

test('a Full Rebuild overlapping the report baseline warns, and cancelling leaves seed data untouched', async () => {
  const ctx = await bootLoaded();
  const sum0 = sumSpent(ctx);
  // A statement dated INSIDE the baseline period (before the report cut-off).
  ctx.parseAnyFile = async () => [row('George Owiti', '0710428075', '2026-05-10', 50, 'UJ0ABCDEF0')];
  ctx.saveToCloud = async () => true;
  // User cancels the baseline-overlap warning.
  ctx.showConfirm = async () => false;
  await ctx.handleRebuild({ files: [{ name: 'may.csv' }], value: '' });
  assert.equal(sumSpent(ctx), sum0, 'a cancelled rebuild changes nothing');
  assert.equal(monthlyTotal(ctx), SEED_MONTHLY_TOTAL, 'seed monthly untouched');
  assert.equal((ctx.DB.transactions || []).length, 0, 'no transaction rows added');
  assert.equal(ctx.DB.importedRev, 0, 'no revenue booked');
});

test('a Full Rebuild overlapping the baseline that the user keeps absorbs the row and never moves seed totals', async () => {
  const ctx = await bootLoaded();
  const sum0 = sumSpent(ctx);
  ctx.parseAnyFile = async () => [row('George Owiti', '0710428075', '2026-05-10', 50, 'UJ0ABCDEF0')];
  ctx.saveToCloud = async () => true;
  // User continues past the warning (keep baseline).
  ctx.showConfirm = async () => true;
  await ctx.handleRebuild({ files: [{ name: 'may.csv' }], value: '' });
  // The row is dated inside George's report period and KES 50 is far under his
  // 600 aggregate, so the aggregate stays the floor and nothing is counted.
  assert.equal(sumSpent(ctx), sum0, 'an in-baseline row under the aggregate does not inflate revenue');
  assert.equal(monthlyTotal(ctx), SEED_MONTHLY_TOTAL, 'seed monthly unchanged');
  assert.equal(ctx.DB.importedRev, 0, 'no new revenue from an in-baseline row');
});

test('the New-Customers-by-Month drill pops the customers whose first visit is that month', async () => {
  const ctx = bootApp();
  // load() is async (it checks IndexedDB before localStorage) — flush the
  // microtask queue so DB is seeded before we assert on it.
  await new Promise(r => setTimeout(r, 0));
  // bootApp seeds DB.customers from SEED_CUSTOMERS, which has June 2026 first visits.
  assert.ok((ctx.DB.customers || []).some(c => c.firstVisit && String(c.firstVisit).slice(0, 7) === '2026-06'), 'seed has a June 2026 first visit');
  ctx.showNewCustomersMonth('2026-06');
  const title = ctx.document.getElementById('listTitle').textContent;
  const body = ctx.document.getElementById('listBody').innerHTML;
  assert.match(title, /June 2026/, 'title names the clicked month');
  assert.match(title, /New Customers/, 'title labels it as new customers');
  assert.ok(/new customer\(s\)/.test(body), 'subtitle reports a customer count');
});

test('a payment matched to the second record of a same-name pair still reaches importedRev', async () => {
  const ctx = await bootLoaded();
  const pair = ctx.DB.customers.filter(c => c.name === 'Tobias Odipo');
  assert.equal(pair.length, 2);
  const [first, second] = pair;
  const imp0 = ctx.DB.importedRev;
  // Pay from the SECOND record's phone — findCustomerMatch resolves that
  // record, but the history (and so the derived total) belongs to the first.
  const r = ctx.importTransactions([row('Tobias Odipo', second.contact, '2026-08-25', 700, 'UTB1ABCDEF1')]);
  assert.equal(r.imported, 1);
  assert.equal(first.spent, 2900 + 700);
  assert.equal(second.spent, 500);
  assert.equal(ctx.DB.importedRev, imp0 + 700);
  assert.equal(sumSpent(ctx), 1250341 + 700);
});

test("the app's own Export CSV re-imported compares against the card and never moves the cut-off", async () => {
  const ctx = await bootLoaded();
  const george = byName(ctx, 'George Owiti');
  ctx.importTransactions([row('George Owiti', '0710428075', '2026-08-20', 300, 'UGC1ABCDEF1')]);
  assert.equal(george.spent, 900); assert.equal(george.visits, 3);
  const imp1 = ctx.DB.importedRev;
  // Export Database (CSV): Name,Contact,Total_Spent,Visits,Days_Since_Last_Visit,Contact_Status — no Last_Visit.
  const exportRows = ctx.DB.customers.slice(0, 50).concat([george]).map(c => ({
    name: c.name, phone: c.contact, contact: c.contact, amount: c.spent, visits: c.visits, date: '', time: '', receipt: '', source: 'Customer Export', isAggregate: true
  }));
  const r = ctx.importTransactions(exportRows);
  assert.equal(r.added, 0, 'no new customers from our own export');
  assert.equal(george.spent, 900); assert.equal(george.visits, 3);
  assert.equal(george.seedSpent, 600); assert.equal(george.seedVisits, 2);
  assert.equal(george.seedLastVisit, REPORT_DATE, 'the cut-off never moves for an undated aggregate');
  assert.equal(ctx.DB.importedRev, imp1);
  assert.equal(sumSpent(ctx), 1250341 + 300);
  // Every other exported customer is unchanged too.
  ctx.DB.customers.slice(0, 50).forEach(c => assert.equal(c.seedLastVisit, REPORT_DATE, c.name));
  // A post-report row still lands on top afterwards.
  ctx.importTransactions([row('George Owiti', '0710428075', '2026-08-22', 100, 'UGE1ABCDEF1')]);
  assert.equal(george.spent, 1000); assert.equal(george.visits, 4);
});

test('a dated customer-export aggregate newer than the report supersedes the baseline as of its own date', async () => {
  const ctx = await bootLoaded();
  const george = byName(ctx, 'George Owiti');
  ctx.importTransactions([{ name: 'George Owiti', phone: '0710428075', contact: '0710428075', amount: 1200, visits: 4, date: '2026-08-10', time: '', receipt: '', source: 'Customer Export', isAggregate: true }]);
  assert.equal(george.seedSpent, 1200); assert.equal(george.seedVisits, 4); assert.equal(george.seedLastVisit, '2026-08-10');
  assert.equal(george.spent, 1200); assert.equal(george.visits, 4);
  // Survives a reload: ensureBaselineFields must not drag the cut-off back to
  // the report date (a bigger baseline superseded the report row).
  const persisted = JSON.stringify(ctx.DB);
  const ctx2 = await bootLoaded({ localStorageSeed: { spaxDB_v23: persisted } });
  const g2 = byName(ctx2, 'George Owiti');
  assert.equal(g2.seedLastVisit, '2026-08-10');
  assert.equal(g2.spent, 1200);
  // A row inside the new period is absorbed, one after it is added.
  ctx2.importTransactions([row('George Owiti', '0710428075', '2026-08-01', 300, 'UGF1ABCDEF1'), row('George Owiti', '0710428075', '2026-08-11', 300, 'UGG1ABCDEF1')]);
  assert.equal(g2.spent, 1500); assert.equal(g2.visits, 5);
});

/* ══════════ REVENUE LEDGERS — the leak PR #48 left open ══════════
   PR #47 doubled the headline revenue. PR #48 fixed the customer tally, so
   Σ spent came back to 1,250,341 — but importedRev, importedTx and the monthly
   chart were STORED RUNNING COUNTERS that #47 had also inflated and nothing
   ever re-derived. The header healed; the Overview chart, Settings' "Imported
   Revenue" and the AI summary (REPORT.totalRevenue + importedRev) stayed
   double. These tests pin the ledgers as derived quantities. */

const SEED_MONTHLY_TOTAL = 1353769;

test('a database PR #47 inflated heals its MONEY too, not just the customer cards', async () => {
  const fresh = await bootLoaded();
  const persisted = JSON.parse(JSON.stringify(fresh.DB));
  // Exactly what the merged #47 build wrote: statement rows dated between each
  // customer's own last purchase and the report date were booked on top of a
  // baseline that already contained them, and that inflated delta went into
  // importedRev / the monthly buckets as well.
  const victims = persisted.customers.filter(c => c.contact && !c.masked).slice(0, 50);
  let injected = 0;
  victims.forEach((c, i) => {
    c.seedLastVisit = c.lastVisit;             // #47's per-customer cut-off
    c.spent = (Number(c.spent) || 0) + 800;    // double-booked
    c.visits = (Number(c.visits) || 0) + 2;
    persisted.customerTx[c.name] = (persisted.customerTx[c.name] || []).concat([
      { date: '2026-06-10', amount: 400, product: 'meat', receipt: 'INF' + String(i).padStart(8, '0'), importedAt: 'x' },
      { date: '2026-07-03', amount: 400, product: 'meat', receipt: 'ING' + String(i).padStart(8, '0'), importedAt: 'x' }
    ]);
    injected += 800;
  });
  persisted.importedRev = injected;
  persisted.importedTx = victims.length * 2;
  const jun = persisted.monthly.labels.indexOf('2026-06');
  const jul = persisted.monthly.labels.indexOf('2026-07');
  persisted.monthly.revenue[jun] += injected / 2;
  persisted.monthly.revenue[jul] += injected / 2;

  const ctx = await bootLoaded({ localStorageSeed: { spaxDB_v23: JSON.stringify(persisted) } });
  // The cards heal (that was #48) …
  assert.equal(sumSpent(ctx), 1250341);
  // … and so does every money figure the user reads (this is the new part).
  assert.equal(ctx.DB.importedRev, 0, 'Settings "Imported Revenue" must come back to 0');
  // Not zero on VISITS: two of these 50 customers have a single visit in the
  // report while the injected statement shows them two dated receipts, and an
  // itemised document is preferred over the seed data — so those two visits are
  // real and importedTx reports them. No money moved (800 is under every
  // victim's report total), which is why Σ spent and importedRev are unchanged.
  assert.equal(ctx.DB.importedTx, 2);
  assert.equal(sumVisits(ctx), ctx.REPORT.totalTxns + ctx.DB.importedTx, 'visit invariant');
  assert.equal(monthlyTotal(ctx), SEED_MONTHLY_TOTAL, 'the Overview chart must come back to the report months');
  assert.equal(monthOf(ctx, '2026-06'), 90040);
  assert.equal(monthOf(ctx, '2026-07'), 23315);
  // The AI summary / chat total and the header now agree.
  assert.equal(ctx.REPORT.totalRevenue + ctx.DB.importedRev, sumSpent(ctx));
  // Stable: healing converges — a further pass changes nothing at all.
  // (repairDates' own counter reports a few cosmetic date touches on this
  // fixture, so compare the data itself rather than the counter.)
  const settled = JSON.stringify(ctx.DB);
  ctx.repairDates();
  assert.equal(JSON.stringify(ctx.DB), settled, 'no endless re-healing');
});

test('the two revenue invariants hold across import, re-import, backfill and a daily ledger', async () => {
  const ctx = await bootLoaded();
  const targets = ctx.DB.customers.filter(c => c.contact && !c.masked).slice(0, 40);
  const invariants = (label) => {
    assert.equal(ctx.REPORT.totalRevenue + ctx.DB.importedRev, sumSpent(ctx), `header = REPORT + importedRev (${label})`);
    assert.equal(Math.round(monthlyTotal(ctx)), Math.round(SEED_MONTHLY_TOTAL + ctx.DB.importedRev), `Σ monthly = seed + importedRev (${label})`);
  };
  invariants('fresh');
  assert.equal(ctx.DB.importedRev, 0);

  // Post-report rows are genuine new business.
  const newBiz = targets.map((c, i) => row(c.name, c.contact, '2026-08-10', 500, 'N' + String(i).padStart(8, '0') + 'B'));
  ctx.importTransactions(newBiz);
  invariants('after a post-report statement');
  assert.equal(ctx.DB.importedRev, 500 * targets.length);
  assert.equal(monthOf(ctx, '2026-08'), 500 * targets.length);

  // Rows dated inside the report period are already in the report total —
  // KES 500 is under every one of these customers' report figure, so the
  // aggregate stays as the floor for the part of the period this one receipt
  // does not cover (the supersede case is its own test below).
  ctx.importTransactions(targets.map((c, i) => row(c.name, c.contact, '2026-06-10', 500, 'P' + String(i).padStart(8, '0') + 'C')));
  invariants('after in-period rows');
  assert.equal(ctx.DB.importedRev, 500 * targets.length, 'in-period rows under the aggregate add no revenue');
  assert.equal(monthOf(ctx, '2026-06'), 90040, 'and do not touch their month');

  // Re-importing the same file changes nothing.
  const before = ctx.DB.importedRev;
  ctx.importTransactions(newBiz);
  invariants('after a re-import');
  assert.equal(ctx.DB.importedRev, before);

  // A backfill is history only — it must never create revenue.
  ctx.backfillTransactions(targets.map((c, i) => row(c.name, c.contact, '2026-05-05', 300, 'F' + String(i).padStart(8, '0') + 'D')));
  ctx.repairDates();
  invariants('after a backfill');
  assert.equal(ctx.DB.importedRev, before, 'backfill books no revenue');

  // A daily ledger is till revenue, not attributable to a customer: it raises
  // importedRev and its own month, but not Σ spent.
  const spentBefore = sumSpent(ctx);
  ctx.DB.dailyLedgers.push({ date: '2026-09-01', revenue: 12345, items: [] });
  ctx.repairDates();
  assert.equal(ctx.DB.importedRev, before + 12345);
  assert.equal(monthOf(ctx, '2026-09'), 12345);
  assert.equal(Math.round(monthlyTotal(ctx)), Math.round(SEED_MONTHLY_TOTAL + ctx.DB.importedRev));
  assert.equal(sumSpent(ctx), spentBefore, 'till revenue does not belong to any customer card');
  // Idempotent: another pass changes nothing.
  const settled = JSON.stringify(ctx.DB);
  ctx.repairDates();
  assert.equal(JSON.stringify(ctx.DB), settled);
});

test('a stale cloud sheet written by the inflated build can no longer re-inflate the chart', async () => {
  // The Google Sheet still holds the doubled figures PR #47 pushed to it.
  const fresh = await bootLoaded();
  const inflatedSheet = {
    customers: fresh.DB.customers.map(c => ({ ...c })),
    monthly: { labels: fresh.DB.monthly.labels.slice(), revenue: fresh.DB.monthly.revenue.map(v => (Number(v) || 0) * 2) },
    settings: { importedRev: 999000, importedTx: 4321, resolved: 0, importBatch: 0 },
    transactions: [], customerTx: {}, seen: {}
  };

  const ctx = await bootLoaded({ cloud: inflatedSheet });
  assert.equal(await ctx.loadFromCloud(), true);
  // Previously the merge took max(cloud, local) per month and for importedRev,
  // so the stale sheet won and the chart was inflated again on every sync —
  // even straight after a Full Rebuild had just cleaned it.
  assert.equal(ctx.DB.importedRev, 0, 'a stale sheet cannot resurrect importedRev');
  assert.equal(ctx.DB.importedTx, 0);
  assert.equal(monthlyTotal(ctx), SEED_MONTHLY_TOTAL, 'nor the monthly chart');
  // Month labels are still preserved (the x-axis must not lose a month).
  assert.deepEqual(ctx.DB.monthly.labels, fresh.DB.monthly.labels);
});

test('Full Rebuild followed by a cloud sync stays clean (the "48 tried to undo but did not succeed" loop)', async () => {
  const fresh = await bootLoaded();
  const persisted = JSON.parse(JSON.stringify(fresh.DB));
  persisted.importedRev = 500000;
  persisted.importedTx = 900;
  persisted.monthly.revenue = persisted.monthly.revenue.map(v => (Number(v) || 0) * 2);
  const inflatedSheet = {
    customers: persisted.customers.map(c => ({ ...c })),
    monthly: JSON.parse(JSON.stringify(persisted.monthly)),
    settings: { importedRev: 500000, importedTx: 900, resolved: 0, importBatch: 0 },
    transactions: [], customerTx: {}, seen: {}
  };

  const ctx = await bootLoaded({ localStorageSeed: { spaxDB_v23: JSON.stringify(persisted) }, cloud: inflatedSheet });
  // Loading alone already re-derives the ledgers.
  assert.equal(ctx.DB.importedRev, 0);
  assert.equal(monthlyTotal(ctx), SEED_MONTHLY_TOTAL);

  // A Full Rebuild keeps them clean …
  ctx.parseAnyFile = async () => [];
  ctx.saveToCloud = async () => true;
  await ctx.handleRebuild({ files: [{ name: 'statement.csv' }], value: '' });
  assert.equal(ctx.DB.importedRev, 0);
  assert.equal(monthlyTotal(ctx), SEED_MONTHLY_TOTAL);

  // … and the next sync with the still-stale sheet does NOT undo the cleanup.
  assert.equal(await ctx.loadFromCloud(), true);
  assert.equal(ctx.DB.importedRev, 0, 'the sheet must not re-inflate a cleaned database');
  assert.equal(monthlyTotal(ctx), SEED_MONTHLY_TOTAL);
});

/* ══════════ SAME-NAME RECORDS SURVIVE A CLOUD SYNC ══════════
   Both cloud merges keyed customers by NAME alone
   (`new Map(customers.map(c => [c.name, c]))`). The report lists 41 names
   twice — and "Peris Wacera Waite" three times — with different phone numbers:
   different people who happen to share a name. Keying by name kept only the
   last of each, so every sync silently destroyed 42 real customers worth
   KES 50,625 / 352 visits, and the survivor carried the other twin's phone, so
   the lost customer's future payments could no longer be matched by phone.
   Records are now keyed by name + normalised contact (customerMergeKey). */

const cloudSheetOf = ctx => ({
  customers: ctx.DB.customers.map(c => ({ ...c })),
  monthly: { labels: ctx.DB.monthly.labels.slice(), revenue: ctx.DB.monthly.revenue.slice() },
  settings: { importedRev: ctx.DB.importedRev, importedTx: ctx.DB.importedTx, resolved: ctx.DB.resolved, importBatch: ctx.DB.importBatch },
  transactions: ctx.DB.transactions.map(t => ({ ...t })),
  customerTx: JSON.parse(JSON.stringify(ctx.DB.customerTx)),
  seen: { ...ctx.DB.seen }
});

test('the 41 same-name pairs (and the one triple) survive repeated cloud syncs', async () => {
  const local = await bootLoaded();
  assert.equal(local.DB.customers.length, 1669);
  // The fixture really does contain same-name records with different phones.
  const names = new Map();
  local.DB.customers.forEach(c => names.set(c.name, (names.get(c.name) || 0) + 1));
  const dupNames = [...names.entries()].filter(([, n]) => n > 1);
  assert.equal(dupNames.length, 41, '41 names appear more than once');
  assert.equal(dupNames.reduce((s, [, n]) => s + (n - 1), 0), 42, 'holding 42 extra records');
  assert.equal(names.get('Peris Wacera Waite'), 3, 'and one name appears three times');

  const ctx = await bootLoaded({ cloud: cloudSheetOf(local) });
  // Syncing must be lossless, and stay lossless however many times it runs.
  for (let i = 0; i < 3; i++) {
    assert.equal(await ctx.loadFromCloud(), true);
    assert.equal(ctx.DB.customers.length, 1669, `customer count after sync ${i + 1}`);
    assert.equal(sumSpent(ctx), 1250341, `Σ spent after sync ${i + 1}`);
    assert.equal(sumVisits(ctx), 5519, `Σ visits after sync ${i + 1}`);
  }
  // Every distinct phone is still present for the duplicated names.
  const tobias = ctx.DB.customers.filter(c => c.name === 'Tobias Odipo');
  assert.equal(tobias.length, 2);
  assert.equal(tobias.map(c => c.contact).sort().join(','), '0720208056,0720964081');
  assert.equal(ctx.DB.customers.filter(c => c.name === 'Peris Wacera Waite').length, 3);
});

test('a v3.4 sheet (empty CustomerTx/Seen caches) still syncs losslessly — history is derived, never uploaded', async () => {
  // v3.4 clients stop syncing the per-customer history and the dedup map:
  // the sheet's CustomerTx/Seen tabs stay header-only and every device
  // rebuilds both from Transactions. A cloud in that exact shape must load
  // with the same tallies (and the same derived history) as a sheet that
  // still carried the caches.
  const local = await bootLoaded();
  // A typical day: payments to existing customers, one brand-new cash buyer,
  // and a receipt-less pair that must stay two distinct visits.
  local.importTransactions([
    row('George Owiti', '0710428075', '2026-09-03', 300, 'V34NEW0001'),
    row('Florah Atieno', '0711000022', '2026-09-03', 250, 'V34NEW0002'),
    row('Cash Walk-in', '0722333444', '2026-09-04', 120, 'V34NEW0003'),
    { name: 'George Owiti', phone: '0710428075', contact: '0710428075', date: '2026-09-04', time: '12:00:00', amount: 70, receipt: '', source: 'test', visits: 1 },
    { name: 'George Owiti', phone: '0710428075', contact: '0710428075', date: '2026-09-04', time: '18:00:00', amount: 70, receipt: '', source: 'test', visits: 1 }
  ]);
  await new Promise(r => setTimeout(r, 10));

  const histRowsOf = c => Object.values(c.DB.customerTx).reduce((s, a) => s + a.length, 0);
  const expected = {
    customers: local.DB.customers.length,
    transactions: local.DB.transactions.length,
    spent: sumSpent(local),
    visits: sumVisits(local),
    historyRows: histRowsOf(local),
    george: local.DB.customerTx['George Owiti'].length
  };
  assert.ok(expected.transactions >= 5, 'fixture must actually carry transactions');
  assert.ok(expected.historyRows >= 5, 'fixture must actually carry derived history');

  const emptyCacheSheet = cloudSheetOf(local);
  emptyCacheSheet.customerTx = {};
  emptyCacheSheet.seen = {};
  // Control: a sheet in the OLD shape, carrying the caches as before.
  const fullCacheSheet = cloudSheetOf(local);

  const deriveDevice = async (sheet) => {
    const c = await bootLoaded({ cloud: sheet });
    assert.equal(await c.loadFromCloud(), true);
    return c;
  };
  const fromEmpty = await deriveDevice(emptyCacheSheet);
  const fromFull = await deriveDevice(fullCacheSheet);
  for (const c of [fromEmpty, fromFull]) {
    assert.equal(c.DB.customers.length, expected.customers);
    assert.equal(c.DB.transactions.length, expected.transactions);
    assert.equal(histRowsOf(c), expected.historyRows, 'the history re-projects to exactly the same rows');
    assert.equal(c.DB.customerTx['George Owiti'].length, expected.george, 'both receipt-less visits survive');
    assert.equal(sumSpent(c), expected.spent);
    assert.equal(sumVisits(c), expected.visits);
  }
  // Repeated loads converge and never re-grow or shrink the projection.
  assert.equal(await fromEmpty.loadFromCloud(), true);
  assert.equal(histRowsOf(fromEmpty), expected.historyRows);

  // A save must never re-introduce the derived tables to the wire.
  await fromEmpty.saveToCloud(true);
  assert.ok(fromEmpty.savedPayloads.length > 0, 'a save payload was sent');
  fromEmpty.savedPayloads.forEach((p, i) => {
    assert.equal(p.customerTx, undefined, `payload ${i} must not upload customerTx`);
    assert.equal(p.seen, undefined, `payload ${i} must not upload seen`);
    if (p.action === 'saveAll') assert.ok(Array.isArray(p.transactions), 'saveAll still carries Transactions');
  });

  // History-only rows (global copy shed by the localStorage quota compaction)
  // survive a rebuild even with no sheet history to pull from.
  const compacted = await deriveDevice(emptyCacheSheet);
  const keep = compacted.DB.customerTx['George Owiti'].slice();
  keep.push({ date: '2026-08-31', amount: 75, product: 'meat', till: '', receipt: '', importedAt: '2026-09-01' });
  compacted.DB.customerTx['George Owiti'] = keep;
  compacted.rebuildCustomerHistory();
  assert.ok(
    compacted.DB.customerTx['George Owiti'].some(r => r.date === '2026-08-31' && r.amount === 75),
    'the history-only compaction survivor must be preserved'
  );
});

test('Smart Merge is lossless for same-name records too', async () => {
  const local = await bootLoaded();
  const ctx = await bootLoaded({ cloud: cloudSheetOf(local) });
  ctx.saveToCloud = async () => true;
  await ctx.smartMergeCloud();
  assert.equal(ctx.DB.customers.length, 1669);
  assert.equal(sumSpent(ctx), 1250341);
  assert.equal(ctx.DB.customers.filter(c => c.name === 'Peris Wacera Waite').length, 3);
});

test('a sheet already damaged by the old build is repaired, not propagated', async () => {
  const local = await bootLoaded();
  // The Google Sheet was written by the name-keyed build, so 42 records are
  // already missing up there.
  const collapsed = new Map();
  local.DB.customers.forEach(c => collapsed.set(c.name, c));
  const damaged = cloudSheetOf(local);
  damaged.customers = [...collapsed.values()].map(c => ({ ...c }));
  assert.equal(damaged.customers.length, 1627, 'the damaged sheet is short 42 records');

  const ctx = await bootLoaded({ cloud: damaged });
  assert.equal(await ctx.loadFromCloud(), true);
  // The local copy still has them, and the merge must not delete them again.
  assert.equal(ctx.DB.customers.length, 1669, 'local twins survive a damaged sheet');
  assert.equal(sumSpent(ctx), 1250341);
  // And the repaired client pushes the full set back up, healing the sheet.
  const pushed = [];
  await ctx.saveToCloud(true);
  ctx.savedPayloads.forEach(p => { if (p && Array.isArray(p.customers)) pushed.push(p.customers.length); });
  assert.ok(pushed.length > 0, 'a save payload was sent');
  assert.equal(pushed[pushed.length - 1], 1669, 'the sheet is healed with all 1,669 records');
});

test('same-name twins stay independent across a sync, and the revenue invariant holds', async () => {
  const ctx = await bootLoaded();
  const [first, second] = ctx.DB.customers.filter(c => c.name === 'Tobias Odipo');
  assert.equal(first.spent, 2900);
  assert.equal(second.spent, 500);
  // A post-report payment from the SECOND twin's phone.
  ctx.importTransactions([row('Tobias Odipo', second.contact, '2026-08-25', 700, 'UTB1ABCDEF1')]);
  assert.equal(ctx.DB.importedRev, 700);

  // Round-trip the whole database through the cloud.
  const after = await bootLoaded({ cloud: cloudSheetOf(ctx), localStorageSeed: { spaxDB_v23: JSON.stringify(ctx.DB) } });
  assert.equal(await after.loadFromCloud(), true);
  const pair = after.DB.customers.filter(c => c.name === 'Tobias Odipo');
  assert.equal(pair.length, 2, 'both twins survive');
  assert.equal(after.DB.customers.length, 1669);
  assert.equal(sumSpent(after), 1250341 + 700);
  assert.equal(after.DB.importedRev, 700, 'the payment is not double counted by the sync');
  assert.equal(after.REPORT.totalRevenue + after.DB.importedRev, sumSpent(after));
  assert.equal(monthlyTotal(after), SEED_MONTHLY_TOTAL + 700);
});

test('a database persisted to IndexedDB survives a browser restart — with NO localStorage copy', async () => {
  // Session 1: a fresh device (empty localStorage) whose browser has IndexedDB.
  const fake = makeFakeIndexedDB();
  const ctx1 = await bootLoaded({ indexedDB: fake });
  const before = ctx1.DB.customers.length;

  // A new customer + payment arrives; save() must persist it durably.
  ctx1.importTransactions([row('Restart Test Customer', '0712000111', '2026-09-01', 850, 'RTST123456')]);
  ctx1.save();
  await new Promise(r => setTimeout(r, 20));

  assert.ok(fake.data.has('spaxDB_v23'), 'the durable copy landed in IndexedDB');
  const stored = JSON.parse(fake.data.get('spaxDB_v23'));
  assert.ok(stored.customers.some(c => c.name === 'Restart Test Customer'), 'the new customer is in the durable copy');

  // Session 2: the user closes and reopens the app — same IndexedDB, and
  // localStorage is empty (it never held the database).
  const ctx2 = await bootLoaded({ indexedDB: fake });
  assert.equal(ctx2.DB.customers.length, before + 1, 'the restarted session restored the full database from IndexedDB');
  assert.ok(ctx2.DB.customers.some(c => c.name === 'Restart Test Customer'), 'the new customer survived the restart');
  assert.ok(ctx2.DB.transactions.some(t => t.receipt === 'RTST123456'), 'the transaction survived the restart');
  // The dedup guard must survive too: re-importing the same statement skips.
  const re = ctx2.importTransactions([row('Restart Test Customer', '0712000111', '2026-09-01', 850, 'RTST123456')]);
  assert.equal(re.dupes, 1, 'the seen-map survived the restart, so the re-import is recognised as a duplicate');
});

test('Delete All wipes EVERYTHING \u2014 records, rows, baseline \u2014 keeping reachable contacts + manual books', async () => {
  const ctx = await bootLoaded();
  const validBefore = ctx.DB.customers.filter(c => !c.masked && ctx.isValidKenyanContact(c.contact)).length;
  assert.ok(validBefore > 1000, 'the seed carries 1k+ reachable contacts');
  assert.ok(ctx.DB.customers.filter(c => c.masked).length > 0, 'the seed carries masked contacts');

  // Resolve one masked contact, bloat the database, add manual entries.
  assert.equal(ctx.resolveContacts([{ name: 'Ruth Emilly', phone: '0723456321' }], true), 1);
  ctx.importTransactions([
    row('Wipe Test Customer', '0712999000', '2026-08-20', 500, 'WIP1ABCDEF1'),
    row('George Owiti', '0710428075', '2026-07-13', 300, 'WIP2ABCDEF2')
  ]);
  ctx.DB.dailyLedgers.push({ date: '2026-08-20', revenue: 1000, items: [] });
  ctx.DB.dailyExpenses.push({ date: '2026-08-20', cat: 'Wages', amount: 200, note: 'test' });
  ctx.DB.overheads.push({ name: 'Rent', amount: 5000, cadence: 'monthly' });
  ctx.DB.itemCosts['beef'] = 500;
  assert.ok(ctx.DB.transactions.length > 0);

  // The plan is pure: previewing the wipe changes nothing.
  const customersBefore = ctx.DB.customers.length;
  const plan = ctx.planDeleteAll();
  assert.equal(ctx.DB.customers.length, customersBefore, 'planning touches nothing');
  assert.equal(plan.savedCount, validBefore + 2, 'every reachable contact survives: seed-valid + resolved + import-created');
  assert.equal(plan.resolvedKept, 1, 'the resolved contact is counted as resolved');
  assert.equal(plan.customersDeleted, customersBefore - plan.savedCount);
  assert.ok(plan.transactionsDeleted > 0);
  assert.ok(plan.revenueDeleted > 0);
  assert.equal(plan.ledgersKept, 1, 'the manual books are counted as kept');
  assert.equal(plan.expensesKept, 1);
  assert.equal(plan.overheadsKept, 1);
  assert.equal(plan.itemCostsKept, 1);

  const result = ctx.deleteAllKeepResolved();
  assert.equal(result.savedCount, plan.savedCount);

  // Only reachable contacts survive \u2014 as blank, baseline-free records.
  assert.equal(ctx.DB.customers.length, plan.savedCount);
  assert.ok(ctx.DB.customers.every(c => !c.masked && ctx.isValidKenyanContact(c.contact)));
  assert.ok(ctx.DB.customers.every(c => c.spent === 0 && c.visits === 0 && c.seedSpent === 0 && c.seedVisits === 0 && c.seedLastVisit === '' && c.isSeed === false));
  assert.equal(byName(ctx, 'Ruth Emilly').contact, '0723456321', 'the resolved number survives');
  assert.equal(byName(ctx, 'George Owiti').spent, 0, 'NO report figures are restored \u2014 the baseline is not immune');
  assert.equal(byName(ctx, 'George Owiti').lastVisit, '');
  assert.equal(ctx.DB.customers.filter(c => c.masked).length, 0, 'masked records are gone (statements re-create whatever is real)');
  assert.equal(ctx.DB.customers.filter(c => c.name === 'Peris Wacera Waite').length, 3, 'same-name twins with valid numbers all survive as blanks');

  // EVERYTHING else is gone: rows, guard, money, months, baseline.
  assert.equal(ctx.DB.transactions.length, 0);
  assert.equal(Object.keys(ctx.DB.customerTx).length, 0);
  assert.equal(Object.keys(ctx.DB.seen).length, 0);
  assert.equal(ctx.DB.importedRev, 0);
  assert.equal(ctx.DB.importedTx, 0);
  assert.equal(ctx.DB.monthly.labels.length, 0, 'no seed months leak back in');
  assert.equal(ctx.DB.dailyLedgers.length, 1, 'manual ledgers are kept \u2014 no statement can restore them');
  assert.equal(ctx.DB.dailyExpenses.length, 1, 'manual expenses are kept');
  assert.equal(ctx.DB.overheads.length, 1, 'manual overheads are kept');
  assert.equal(ctx.DB.itemCosts['beef'], 500, 'item costs are kept');
  assert.equal(ctx.DB.baselineCleared, true);
  assert.equal(ctx.DB.resolved, plan.savedCount, 'the counter equals the kept contacts');
  assert.equal(ctx.DB.importBatch, 0);

  // Totals are ZERO \u2014 header, cards and chart agree on nothing.
  assert.equal(sumSpent(ctx), 0);
  assert.equal(sumVisits(ctx), 0);
  assert.equal(ctx.getProductStats().totalRevenue, 0, 'the header revenue is zero');
  assert.equal(monthlyTotal(ctx), 0);

  // Every baseline read is gated: no seed row, no cut-off, no report.
  assert.equal(ctx.seedBaselineFor('George Owiti', '0710428075'), null);
  assert.equal(ctx.seedReportCutoff(), '');
  assert.equal(ctx.reportTotals().totalRevenue, 0);
  assert.equal(ctx.reportTotals().totalCustomers, 0);

  // Re-derivation heals nothing back except the kept ledger: cards stay zero.
  ctx.repairDates();
  assert.equal(sumSpent(ctx), 0);
  assert.equal(sumVisits(ctx), 0);
  assert.equal(ctx.DB.importedRev, 1000, 'importedRev = the kept ledger revenue, nothing else');
  assert.equal(monthlyTotal(ctx), 1000);
  assert.equal(ctx.DB.monthly.labels.join(','), '2026-08', 'the only month is the kept ledger\'s own');
  assert.equal(byName(ctx, 'Ruth Emilly').contact, '0723456321');
});

test('standalone Delete All needs no statement, and a normal import fills the wiped database', async () => {
  const ctx = await bootLoaded();
  ctx.showConfirm = async () => true; // destructive confirmation and completion screen
  ctx.saveToCloud = async () => true;

  const completed = await ctx.deleteAllStandalone();
  assert.equal(completed, true);
  assert.equal(ctx.DB.baselineCleared, true);
  assert.equal(ctx.DB.transactions.length, 0);
  assert.equal(sumSpent(ctx), 0);

  // The ordinary import path works after the wipe; it does not need Rebuild.
  const result = ctx.importTransactions([
    row('George Owiti', '0710428075', '2026-09-01', 700, 'NORMAL1ABC1')
  ]);
  assert.equal(result.imported, 1);
  assert.equal(byName(ctx, 'George Owiti').spent, 700);
  assert.equal(byName(ctx, 'George Owiti').visits, 1);
  assert.equal(monthOf(ctx, '2026-09'), 700);
});

test('Reset restores the report baseline after a Delete All', async () => {
  const ctx = await bootLoaded();
  ctx.deleteAllKeepResolved();
  assert.equal(ctx.DB.baselineCleared, true);
  assert.equal(sumSpent(ctx), 0);
  ctx.set('DB', await ctx.seedDB());
  assert.ok(!ctx.DB.baselineCleared, 'the flag is gone');
  assert.equal(sumSpent(ctx), ctx.REPORT.totalRevenue, '\u03a3 spent is the report total again');
  assert.ok(ctx.seedBaselineFor('George Owiti', '0710428075'), 'seed lookups work again');
  assert.equal(ctx.reportTotals().totalRevenue, ctx.REPORT.totalRevenue);
});

test('a cleared baseline is viral across syncs and never resurrected by a stale sheet', async () => {
  const fresh = await bootLoaded();
  // This device wiped and pushed: the sheet carries wiped customers + the flag.
  const wiped = await bootLoaded();
  wiped.deleteAllKeepResolved();
  const wipedSheet = {
    customers: JSON.parse(JSON.stringify(wiped.DB.customers)),
    monthly: { labels: [], revenue: [] },
    settings: { importedRev: 0, importedTx: 0, resolved: wiped.DB.resolved, importBatch: 0, baselineCleared: 1 },
    transactions: [], customerTx: {}, seen: {}
  };
  // A stale device (full baseline) syncs against the wiped sheet.
  const stale = await bootLoaded({ cloud: wipedSheet });
  assert.equal(await stale.loadFromCloud(), true);
  assert.equal(stale.DB.baselineCleared, true, 'the cleared flag wins the merge');
  assert.ok(stale.DB.customers.every(c => !c.isSeed && Number(c.seedSpent) === 0 && c.seedLastVisit === ''), 'no record keeps baseline figures');
  assert.equal(stale.DB.resolved, wiped.DB.resolved, 'the counter follows the cleared side');

  // And a wiped device syncing against a stale (baseline) sheet stays cleared.
  const staleSheet = {
    customers: fresh.DB.customers.map(c => ({ ...c })),
    monthly: { labels: fresh.DB.monthly.labels.slice(), revenue: fresh.DB.monthly.revenue.slice() },
    settings: { importedRev: 0, importedTx: 0, resolved: 99, importBatch: 3 },
    transactions: [], customerTx: {}, seen: {}
  };
  const ctx2 = await bootLoaded({ cloud: staleSheet });
  ctx2.deleteAllKeepResolved();
  const localResolved = ctx2.DB.resolved;
  await ctx2.loadFromCloud();
  assert.equal(ctx2.DB.baselineCleared, true, 'local cleared state survives a stale sync');
  assert.equal(ctx2.DB.resolved, localResolved, 'the stale counter cannot resurrect');
  assert.ok(ctx2.DB.customers.every(c => !c.isSeed && Number(c.seedSpent) === 0), 'stale baselines cannot merge back in');
  assert.equal(monthlyTotal(ctx2), 0, 'stale seed months cannot re-inflate the chart');
});

test('the Import tab keeps Delete All separate from Full Rebuild', async () => {
  assert.ok(/onclick=\"openRebuildModal\(\)\"/.test(htmlSource), 'the Import tab has a Full Rebuild button');
  assert.ok(/onclick=\"deleteAllStandalone\(\)\"/.test(htmlSource), 'the Import tab has a standalone Delete All button');
  assert.ok(!/Delete All & Rebuild/.test(htmlSource), 'Delete All is not coupled to Rebuild');

  const ctx = await bootLoaded();
  ctx.openRebuildModal();
  assert.equal(ctx.document.getElementById('rebuildTitle').textContent, 'Full Rebuild from Statements');
  assert.equal(ctx.document.getElementById('rebuildIcon').textContent, '🔄');
});
