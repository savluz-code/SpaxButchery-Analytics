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
//   • A statement row dated inside the report period never moves a seed
//     customer's total; a row dated after it is added on top — and the
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

function bootApp({ localStorageSeed = {} } = {}) {
  const els = new Map();
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
    fetch: async () => { throw new Error('offline'); },
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

test('George from the screenshots: 4 April rows + 3 September rows of 300 = 1500/5, and the modal footer reconciles', async () => {
  const ctx = await bootLoaded();
  const george = byName(ctx, 'George Owiti');
  const rows = [
    row('George Owiti', '0710428075', '2026-04-17', 300, 'UDA1ABCDEF1'), row('George Owiti', '0710428075', '2026-04-18', 300, 'UDA2ABCDEF1'),
    row('George Owiti', '0710428075', '2026-04-19', 300, 'UDA3ABCDEF1'), row('George Owiti', '0710428075', '2026-04-20', 300, 'UDA4ABCDEF1')
  ];
  ctx.backfillTransactions(rows);
  ctx.repairDates();
  assert.equal(george.spent, 600); assert.equal(george.visits, 2);
  ctx.importTransactions([
    row('George Owiti', '0710428075', '2026-09-01', 300, 'UIA1ABCDEF1'), row('George Owiti', '0710428075', '2026-09-02', 300, 'UIA2ABCDEF1'),
    row('George Owiti', '0710428075', '2026-09-03', 300, 'UIA3ABCDEF1')
  ]);
  assert.equal(george.spent, 1500); assert.equal(george.visits, 5);
  assert.equal(ctx.DB.importedRev, 900);
  assert.equal(sumSpent(ctx), 1250341 + 900);

  ctx.showCustomerDetail('George Owiti');
  const html = ctx.document.getElementById('modalTxList').innerHTML;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /Listed above 7 tx · KES 2,100/);
  assert.match(text, new RegExp(`− Already in the report total \\(up to ${REPORT_DATE}\\) 2 visits · KES 600`));
  assert.match(text, /= Total 5 visits · KES 1,500/);
  assert.doesNotMatch(text, /not itemised/);
  assert.equal(ctx.document.getElementById('modalTotal').textContent, kesText(ctx, 1500));
  assert.equal(ctx.document.getElementById('modalVisits').textContent, 5);
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
  // (600 raw); the derived total only moved by 300 for the after-period row.
  ctx.DB.importedRev = imp1 + 300;
  const i8 = ctx.DB.monthly.labels.indexOf('2026-08'); ctx.DB.monthly.revenue[i8] += 300;
  ctx.repairDates();
  assert.equal(george.spent, 900, 'duplicate receipts are dropped from the history by repairDates');

  const res = ctx.reconcileImportedRevenue();
  assert.equal(res.removed, 2);
  assert.equal(res.amount, 600, 'raw duplicate sum is still reported');
  assert.equal(george.spent, 900);
  assert.equal(george.visits, 3);
  // History already de-duplicated by repairDates → derived totals did not
  // drop when the transaction copies went, so nothing is debited: the raw 600
  // must NOT have been subtracted.
  assert.equal(res.rolledBack, 0);
  assert.equal(ctx.DB.importedRev, imp1 + 300);
  assert.equal(monthOf(ctx, '2026-08'), aug1 + 300);
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
