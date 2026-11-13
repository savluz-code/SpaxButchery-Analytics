'use strict';

// The statement's Completion Time / "Completed on" stamp orders whole
// name/contact pairs, including purchases made on the same calendar day.
// Boot the real app, parsers, imports and renderers with an offline browser
// shim; no network, OCR model, provider or cloud deployment is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(m => !/\bsrc\s*=/.test(m[1]) && m[2].trim()).map(m => m[2]);
const plain = value => JSON.parse(JSON.stringify(value));
const names = rows => Array.from(rows, row => row.name);

function emptyDB() {
  return {
    baselineCleared: true, customers: [], transactions: [], customerTx: {}, seen: {},
    monthly: { labels: [], revenue: [] }, importedRev: 0, importedTx: 0, resolved: 0,
    dailyLedgers: [], dailyExpenses: [], overheads: [], itemCosts: {}, tombstones: {}
  };
}
function element(id) {
  return {
    id, value: '', style: {}, dataset: {}, children: [], innerHTML: '', _text: '', checked: false,
    get textContent() { return this._text; },
    set textContent(value) { this._text = String(value); if (!this._text) this.children = []; },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); return c; },
    setAttribute() {}, getAttribute: () => null, click() {}, focus() {}, scrollIntoView() {}, remove() {},
    querySelector(sel) { this.selectors ||= {}; return this.selectors[sel] ||= element(id + sel); },
    querySelectorAll: () => [], getContext: () => ({})
  };
}
async function boot(database = emptyDB()) {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const store = new Map([
    ['spaxDB_v23', JSON.stringify(database)], ['spaxSyncMode_v1', 'local']
  ]);
  const document = {
    getElementById: $, querySelector: () => element('q'), querySelectorAll: () => [],
    createElement: element, addEventListener() {}, body: element('body'), head: element('head'),
    documentElement: element('html'), hidden: false, visibilityState: 'visible'
  };
  const Chart = function () { return { destroy() {}, update() {} }; };
  Chart.defaults = {};
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} }, document,
    localStorage: {
      getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    location: { hash: '', search: '', href: 'https://example.test/', reload() {} },
    navigator: { serviceWorker: { register: () => Promise.resolve() }, onLine: false, userAgent: 'node' },
    fetch: async () => { throw Error('offline'); },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame() {},
    confirm: () => true, prompt: () => null, alert() {}, open() {},
    Chart, Papa: {}, pdfjsLib: { GlobalWorkerOptions: {} }, Tesseract: {},
    XLSX: { SSF: { parse_date_code(n) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
      return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
    } } },
    URL, Blob, AbortController, TextEncoder, TextDecoder, Date, performance,
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64')
  });
  ctx.window = ctx;
  ctx.self = ctx;
  scripts.forEach((src, i) => vm.runInContext(src, ctx, { filename: `app-inline-${i}.js` }));
  vm.runInContext("getTodayEAT = () => '2026-11-12';", ctx);
  // Let the app's asynchronous local load and derived-history heal finish.
  for (let i = 0; i < 60; i++) await Promise.resolve();
  for (const [id, value] of Object.entries({
    custSort: 'lastDesc', custFilter: 'all', productFilter: 'all',
    txSort: 'dateDesc', txFilter: 'all', segSel: 'all'
  })) $(id).value = value;
  return {
    ctx, $, store, run: code => vm.runInContext(code, ctx),
    db: () => vm.runInContext('DB', ctx),
    body: id => $(id).querySelector('tbody').innerHTML
  };
}
function customer(name, contact, date = '2026-11-12') {
  return {
    name, contact, spent: 0, visits: 0, days: 0, firstVisit: date, lastVisit: date,
    masked: contact.includes('*'), isSeed: false, seedSpent: 0, seedVisits: 0, seedLastVisit: ''
  };
}
function payment(name, phone, time, receipt, date = '2026-11-12', amount = 100) {
  return { name, phone, time, receipt, date, amount, till: '1213294', source: 'test' };
}
function customerNames(markup) {
  return [...markup.matchAll(/<tr[^>]*onclick="showCustomerDetail\('([^']+)'\)"/g)].map(m => m[1]);
}
function assertOrder(markup, expected) {
  let previous = -1;
  expected.forEach(value => {
    const at = markup.indexOf(value);
    assert.ok(at > previous, `${value} should occur in this order: ${expected.join(', ')}`);
    previous = at;
  });
}

const screenshotText = [
  'Receipt No Completion Time Details Transaction Status Paid in Withdrawn Balance Transaction Type Other Party',
  'UKC492RRSQ 2026-11-12\n22:16:06 Merchant Payment from 0702***790 - OSCAR KIGALI MAGADA Completed 100.00 0.00 1,435.05 Customer Merchant Payment 1213294- SIMON MBULUNZA',
  'UKC9623VOU 2026-11-12\n21:52:26 Merchant Payment from 254769***132 - VENESSA ATIENO OCHIENG Completed 80.00 0.00 1,335.05 Customer Merchant Payment 1213294- SIMON MBULUNZA'
].join('\n');

test('the attached statement layout orders names and their masked contacts by completion time', async () => {
  const app = await boot();
  const rows = app.ctx.parseMpesaText(screenshotText);
  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows, row => row.time), ['22:16:06', '21:52:26']);
  app.ctx.importTransactions(rows);
  // Processing is oldest first, but the default name/contact lists are newest first.
  assert.deepEqual(names(app.db().customers), ['Venessa Atieno Ochieng', 'Oscar Kigali Magada']);
  app.ctx.renderCustTable();
  assert.deepEqual(customerNames(app.body('custTable')), ['Oscar Kigali Magada', 'Venessa Atieno Ochieng']);
  app.ctx.renderTransactions();
  assertOrder(app.body('txTable'), ['Oscar Kigali Magada', '0702***790', 'Venessa Atieno Ochieng', '0769***132']);
  assert.doesNotMatch(app.body('custTable') + app.body('txTable'), /22:16:06|21:52:26/,
    'completion time is only an ordering key, not a new visible column');
});

test('a repeat purchase moves the whole name/contact row, independent of capture order or spend', async () => {
  const app = await boot();
  app.ctx.importTransactions([payment('Morning Buyer', '0712000001', '09:00:00', 'UKCORDER01')]);
  app.ctx.importTransactions([payment('Evening Buyer', '0712000002', '18:00:00', 'UKCORDER02', undefined, 900)]);
  app.ctx.importTransactions([payment('Morning Buyer', '0712000001', '22:30:01', 'UKCORDER03', undefined, 10)]);
  // An older statement uploaded later must not change the last-purchase order.
  app.ctx.importTransactions([payment('Evening Buyer', '0712000002', '23:59:59', 'UKCORDER04', '2026-11-11')]);
  app.ctx.renderCustTable();
  assert.deepEqual(customerNames(app.body('custTable')), ['Morning Buyer', 'Evening Buyer']);
  assert.equal(app.db().customers.find(c => c.name === 'Morning Buyer').contact, '0712000001',
    'CSV-style phone fields remain paired with their customer');
  assert.equal(app.db().customers.find(c => c.name === 'Evening Buyer').contact, '0712000002');
  app.$('custSort').value = 'spentDesc';
  app.ctx.renderCustTable();
  assert.deepEqual(customerNames(app.body('custTable')), ['Evening Buyer', 'Morning Buyer'],
    'an explicitly chosen non-date sort is still respected');
});

test('first/last visit and transaction ascending sorts break same-day ties using the purchase time', async () => {
  const app = await boot();
  app.ctx.importTransactions([
    payment('Repeat Customer', '0712000011', '22:00:00', 'UKCORDER11'),
    payment('Afternoon Customer', '0712000012', '14:00:00', 'UKCORDER12'),
    payment('Repeat Customer', '0712000011', '09:00:00', 'UKCORDER13')
  ]);
  for (const [sort, expected] of [
    ['lastDesc', ['Repeat Customer', 'Afternoon Customer']],
    ['lastAsc', ['Afternoon Customer', 'Repeat Customer']],
    ['firstDesc', ['Afternoon Customer', 'Repeat Customer']],
    ['firstAsc', ['Repeat Customer', 'Afternoon Customer']]
  ]) {
    app.$('custSort').value = sort;
    app.ctx.renderCustTable();
    assert.deepEqual(customerNames(app.body('custTable')), expected, sort);
  }
  app.$('txSort').value = 'dateAsc';
  app.ctx.renderTransactions();
  assertOrder(app.body('txTable'), ['UKCORDER13', 'UKCORDER12', 'UKCORDER11']);
  app.$('txSort').value = 'dateDesc';
  app.ctx.renderTransactions();
  assertOrder(app.body('txTable'), ['UKCORDER11', 'UKCORDER12', 'UKCORDER13']);
  app.$('custSort').value = 'lastDesc';
  app.$('lastVisitFrom').value = '2026-11-12';
  app.$('lastVisitTo').value = '2026-11-12';
  app.ctx.renderCustTable();
  assert.deepEqual(customerNames(app.body('custTable')), ['Repeat Customer', 'Afternoon Customer']);
});

test('outreach, masked contacts and the customer drill-down share the newest-purchase order', async () => {
  const app = await boot();
  app.ctx.importTransactions([
    payment('Low Spend', '0712000021', '22:16:06', 'UKCORDER21', undefined, 10),
    payment('High Spend', '0712000022', '21:52:26', 'UKCORDER22', undefined, 900)
  ]);
  app.ctx.renderSeg();
  assert.deepEqual(names(app.ctx._pool), ['Low Spend', 'High Spend']);
  assertOrder(app.body('segTable'), ['Low Spend', '0712000021', 'High Spend', '0712000022']);
  app.ctx.drillCustomers();
  assertOrder(app.$('listBody').innerHTML, ['Low Spend', '0712000021', 'High Spend', '0712000022']);
  app.db().customers.forEach(c => { c.masked = true; c.contact = app.ctx.maskContact(c.contact); });
  app.ctx.renderMaskTable();
  assertOrder(app.body('maskTable'), ['Low Spend', '0712***021', 'High Spend', '0712***022']);
});

test('extracted contact pairs follow their matched customer’s purchase time and keep unmatched pairs stable', async () => {
  const app = await boot();
  app.ctx.importTransactions([
    payment('Earlier Buyer', '0712000025', '21:52:26', 'UKCORDER25'),
    payment('Later Buyer', '0712000026', '22:16:06', 'UKCORDER26')
  ]);
  app.ctx.renderResolverExtractedContacts([
    { name: 'Unmatched One', phone: '0712000027' },
    { name: 'Earlier Buyer', phone: '0712000025' },
    { name: 'Unmatched Two', phone: '0712000028' },
    { name: 'Later Buyer', phone: '0712000026' }
  ], true);
  const extracted = () => app.$('resolverExtractedBody').children.map(row => row.children.map(cell => cell.textContent));
  assert.deepEqual(extracted(), [
    ['Later Buyer', '0712000026'], ['Earlier Buyer', '0712000025'],
    ['Unmatched One', '0712000027'], ['Unmatched Two', '0712000028']
  ]);
  app.ctx.renderResolverExtractedContacts([{ name: 'Earlier Buyer Longer', phone: '0712000025' }]);
  assert.deepEqual(extracted()[1], ['Earlier Buyer Longer', '0712000025'], 'deduplication preserves the correct phone and order');
});

test('ties are stable, missing dates go last, and date-only rows never borrow a different day’s time', async () => {
  const db = emptyDB();
  db.customers = [
    { ...customer('No Date', '0712000030', ''), days: 999 }, customer('Baseline Day', '0712000031', '2026-11-12'),
    customer('Morning', '0712000032'), customer('Tie First', '0712000033'), customer('Tie Second', '0712000034')
  ];
  db.customerTx = {
    'Baseline Day': [{ date: '2026-11-11', time: '23:59:59', amount: 100 }],
    Morning: [{ date: '2026-11-12', time: '09:00:00', amount: 100 }],
    'Tie First': [{ date: '2026-11-12', time: '10:00:00', amount: 100 }],
    'Tie Second': [{ date: '2026-11-12', time: '10:00:00', amount: 100 }]
  };
  const app = await boot(db);
  // Date repair treats a single known history row conservatively. Restore
  // this later date-only baseline to exercise the sort's fallback directly.
  app.db().customers.find(c => c.name === 'Baseline Day').lastVisit = '2026-11-12';
  const before = JSON.stringify(app.db());
  assert.equal(app.ctx.spaxCustomerPurchaseStamp(app.db().customers[1]), '2026-11-12T00:00:00');
  assert.deepEqual(names(app.ctx.spaxSortCustomersByPurchaseTime(app.db().customers)),
    ['Tie First', 'Tie Second', 'Morning', 'Baseline Day', 'No Date']);
  assert.deepEqual(names(app.ctx.spaxSortCustomersByPurchaseTime(app.db().customers, 'last', 'asc')),
    ['Baseline Day', 'Morning', 'Tie First', 'Tie Second', 'No Date']);
  assert.equal(JSON.stringify(app.db()), before, 'sorting must not mutate data or totals');
});

test('same-name records do not borrow the other contact’s owned transaction history', async () => {
  const app = await boot();
  const one = customer('Shared Name', '0712000041');
  const two = customer('Shared Name', '0712000042');
  app.db().customers.push(one, two);
  app.db().customerTx['Shared Name'] = [{ date: '2026-11-12', time: '22:16:06', amount: 100 }];
  assert.equal(app.ctx.spaxCustomerPurchaseStamp(one), '2026-11-12T22:16:06');
  assert.equal(app.ctx.spaxCustomerPurchaseStamp(two), '2026-11-12T00:00:00');
});

test('Completion Time and Completed on/at headers win over a later report date in CSV imports', async () => {
  const app = await boot();
  for (const header of ['Completion Time', 'Completed on', 'Completed_At', 'Completion\nTime']) {
    const input = [{
      'Receipt No': 'UKC492RRSQ', Date: '2026-11-13', [header]: '2026-11-12 22:16:06',
      Details: 'Merchant Payment from 0702***790 - OSCAR KIGALI MAGADA', 'Paid In': '100.00',
      'Other Party': '1213294- SIMON MBULUNZA'
    }];
    app.ctx.parseCsvExcelFile = async () => input;
    const rows = await app.ctx.parseAnyFile({ name: 'statement.csv' });
    assert.equal(rows.length, 1, header);
    assert.equal(rows[0].date, '2026-11-12', header);
    assert.equal(rows[0].time, '22:16:06', header);
    assert.equal(rows[0].phone, '0702***790', header);
  }
});

test('legacy CSV/Excel statement parsing preserves combined and separate completion times', async () => {
  const app = await boot();
  const previews = [];
  app.ctx.showPreview = rows => previews.push(plain(rows));
  app.ctx.parseSheetRows([
    ['Receipt No', 'Completed on', 'Date', 'Details', 'Paid In'],
    ['UKC492RRSQ', '2026-11-12 22:16:06', '2026-11-13', 'Merchant Payment from 0702***790 - OSCAR KIGALI MAGADA', 100]
  ]);
  app.ctx.parseSheetRows([
    ['Receipt No', 'Date', 'Time', 'Details', 'Paid In'],
    ['UKC9623VOU', '2026-11-12', '9:52:26 PM', 'Merchant Payment from 254769***132 - VENESSA ATIENO OCHIENG', 80]
  ]);
  assert.deepEqual(previews.map(rows => [rows[0].date, rows[0].time]), [
    ['2026-11-12', '22:16:06'], ['2026-11-12', '21:52:26']
  ]);
});

test('time extraction accepts Excel serials, short hours and AM/PM without timezone conversion', async () => {
  const app = await boot();
  const serial = (Date.UTC(2026, 10, 12) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.deepEqual(plain(app.ctx.spaxCompletionFields({ 'Completion Time': serial + (22 * 3600 + 16 * 60 + 6) / 86400 })),
    { date: '2026-11-12', time: '22:16:06' });
  assert.deepEqual(plain(app.ctx.spaxCompletionFields({ Date: serial, Time: 0.5 })),
    { date: '2026-11-12', time: '12:00:00' });
  assert.equal(app.ctx.spaxTimeOfDay('9:07'), '09:07:00');
  assert.equal(app.ctx.spaxTimeOfDay('9:07:05 PM'), '21:07:05');
  assert.equal(app.ctx.spaxTimeOfDay('12:00 am'), '00:00:00');
  assert.equal(app.ctx.spaxTimeOfDay('12:00 pm'), '12:00:00');
  assert.equal(app.ctx.spaxExtractPurchaseTime('25:61:70'), '');
  assert.deepEqual(plain(app.ctx.spaxCompletionFields({ 'Completed on': '2026-11-12', Date: '2026-11-13 01:00:00' })),
    { date: '2026-11-12', time: '' }, 'a report timestamp must never supply a missing purchase time');
  assert.equal(app.ctx.spaxPurchaseStamp({ date: '2026-11-12', importedAt: '2026-11-13T22:00:00Z' }), '2026-11-12T00:00:00');
  assert.equal(app.ctx.spaxPurchaseStamp({ time: '22:16:06' }), '', 'an undated row cannot sort ahead of known purchases');
});

test('date normalization and history derivation keep embedded legacy completion times', async () => {
  const app = await boot();
  app.ctx.importTransactions([
    payment('Legacy Buyer', '0712000051', '', 'UKCORDER51', '2026-11-12 22:16:06')
  ]);
  assert.equal(app.db().transactions[0].time, '22:16:06');
  assert.equal(app.db().customerTx['Legacy Buyer'][0].time, '22:16:06');
  const legacy = payment('Legacy Buyer', '0712000051', '', 'UKCORDER52', '2026-11-12T23:16:06');
  app.db().transactions.push(legacy);
  app.ctx.rebuildCustomerHistory();
  assert.equal(app.db().customerTx['Legacy Buyer'][0].time, '23:16:06');
  app.ctx.repairDates();
  assert.equal(legacy.date, '2026-11-12');
  assert.equal(legacy.time, '23:16:06');
  assert.equal(app.ctx.spaxCustomerPurchaseStamp(app.db().customers[0]), '2026-11-12T23:16:06');
});

test('backfills, cloud unions and reloads retain purchase ordering without adding duplicate revenue', async () => {
  const app = await boot();
  app.ctx.importTransactions([
    payment('First Buyer', '0712000061', '09:00:00', 'UKCORDER61'),
    payment('Second Buyer', '0712000062', '10:00:00', 'UKCORDER62')
  ]);
  const backfill = [payment('First Buyer', '0712000061', '', 'UKCORDER63', '2026-11-12 22:16:06')];
  app.ctx.backfillTransactions(backfill);
  assert.deepEqual(names(app.ctx.spaxSortCustomersByPurchaseTime(app.db().customers)), ['First Buyer', 'Second Buyer']);
  const totalBefore = app.db().customers.reduce((sum, c) => sum + c.spent, 0);
  assert.equal(app.ctx.backfillTransactions(backfill).dupes, 1);
  assert.equal(app.db().customers.reduce((sum, c) => sum + c.spent, 0), totalBefore);
  const cloud = plain(app.db().transactions);
  cloud.find(t => t.receipt === 'UKCORDER63').date = '2026-11-12 22:16:06';
  cloud.find(t => t.receipt === 'UKCORDER63').time = '';
  app.ctx.mergeCloudTransactionsIntoDB(cloud);
  app.ctx.rebuildCustomerHistory();
  assert.equal(app.ctx.spaxCustomerPurchaseStamp(app.db().customers[0]), '2026-11-12T22:16:06');
  const clocklessCloud = plain(app.db().transactions);
  clocklessCloud.find(t => t.receipt === 'UKCORDER63').time = '';
  app.ctx.mergeCloudTransactionsIntoDB(clocklessCloud);
  app.ctx.rebuildCustomerHistory();
  assert.equal(app.ctx.spaxCustomerPurchaseStamp(app.db().customers[0]), '2026-11-12T22:16:06',
    'an old cloud row cannot erase the known local time for the same receipt');
  const persisted = plain(app.db());
  persisted.customerTx = {}; // the cloud does not sync this derived cache
  const reloaded = await boot(persisted);
  reloaded.ctx.renderCustTable();
  reloaded.ctx.renderTransactions();
  assert.deepEqual(customerNames(reloaded.body('custTable')), ['First Buyer', 'Second Buyer']);
  assertOrder(reloaded.body('txTable'), ['UKCORDER63', 'UKCORDER62', 'UKCORDER61']);
  assert.equal(reloaded.db().customers.reduce((sum, c) => sum + c.spent, 0), totalBefore);
});
