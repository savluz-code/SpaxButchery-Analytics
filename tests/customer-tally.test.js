'use strict';

// Regression guard for "the counts are not in tally": the customer card
// (Total Spent · Visits · Avg/Visit) disagreed with the Transaction History
// listed directly under it, e.g.
//
//   Eunice Mbithe Ndelesi   card KES 240 / 3 visits   history 7 tx · KES 520
//   Diana Muli Musili       card KES 380 / 3 visits   history 7 tx · KES 840
//   George Owiti            card KES 900 / 3 visits   history 7 tx · KES 2,100
//
// Root cause: spent/visits were running counters mutated independently by six
// code paths (additive import, seed max() reconcile, cloud merge, rollback,
// dedupe, and backfill — which by design touched neither) while the history
// was a separate list. Nothing ever forced the two to agree again.
//
// Fix: every customer carries an explicit BASELINE (seedSpent / seedVisits /
// seedLastVisit) and the totals are DERIVED:
//
//   spent  = max(baseline.spent,  Σ rows dated ≤ baseline.lastVisit) + Σ rows after
//   visits = max(baseline.visits, count(rows ≤ cutoff))              + count(rows after)
//
// These tests run the REAL functions from index.html inside a vm sandbox.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function slice(startMarker, endMarker) {
  const start = htmlSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} not found`);
  const end = htmlSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} not found after ${startMarker}`);
  return htmlSource.slice(start, end);
}

// Three seed rows exactly as they appear in SEED_CUSTOMERS (name, contact,
// spent, visits, days, firstVisit, lastVisit).
const SEED_ROWS = [
  ['George Owiti', '0710428075', 600, 2, 23, '2026-06-01', '2026-06-01'],
  ['Diana Muli Musili', '0113***835', 150, 1, 155, '2026-01-20', '2026-01-20'],
  ['Eunice Mbithe Ndelesi', '0723***680', 100, 1, 325, '2025-08-03', '2025-08-03'],
  // Same-name pair (the report has 41 of these) — must not double count.
  ['Tobias Odipo', '0720208056', 2900, 7, 40, '2025-07-01', '2026-06-20'],
  ['Tobias Odipo', '0720964081', 500, 1, 90, '2026-05-01', '2026-05-01']
];

function makeContext(today = '2026-09-05') {
  const ctx = vm.createContext({ console, Date, Math, Number, String, Map, Set, Object, Array, JSON, isFinite });
  vm.runInContext(`
    const SEED_CUSTOMERS = ${JSON.stringify(SEED_ROWS)};
    function getTodayEAT(){ return ${JSON.stringify(today)}; }
    function stripTime(d){ if(d===null||d===undefined||d==='') return ''; const m=String(d).match(/(\\d{4}-\\d{2}-\\d{2})/); return m?m[1]:''; }
    function normalizeSeenDates(){ return 0; }
    function resetComebackIfLapsed(){}
    function isNewThisMonth(){ return false; }
    function normPhone(p){ return String(p||''); }
    DB = { customers: [], transactions: [], customerTx: {}, seen: {}, monthly: { labels: [], revenue: [] }, importedRev: 0, importedTx: 0 };
  `, ctx);
  // Product classification + stats + the CUSTOMER TALLY block + repairDates.
  vm.runInContext(slice('const SOUP_START_DATE', 'function maskedMatches'), ctx);
  return ctx;
}

function seedCustomer(ctx, row) {
  const c = {
    name: row[0], contact: row[1], spent: row[2], visits: row[3], days: row[4],
    firstVisit: row[5], lastVisit: row[6], masked: row[1].includes('***'),
    isNew: false, isSeed: true, seedSpent: row[2], seedVisits: row[3], seedLastVisit: row[6]
  };
  ctx.DB.customers.push(c);
  return c;
}

function history(ctx, name, rows) {
  ctx.DB.customerTx[name] = rows.map(([date, amount]) => ({ date, amount, product: amount <= 50 && date >= '2026-06-01' ? 'soup' : 'meat', receipt: 'R' + date + amount }));
}

const SEP = (amt) => [['2026-09-01', amt], ['2026-09-02', amt], ['2026-09-03', amt]];

test('the three customers from the screenshots come back into tally with their history', () => {
  const ctx = makeContext();
  const eunice = seedCustomer(ctx, SEED_ROWS[2]);
  const diana = seedCustomer(ctx, SEED_ROWS[1]);
  const george = seedCustomer(ctx, SEED_ROWS[0]);

  // Exactly the histories visible in the screenshots: an old backfilled
  // statement (4 rows) + this month's import (3 rows).
  history(ctx, 'Eunice Mbithe Ndelesi', [['2025-07-01', 100], ['2025-07-02', 100], ['2025-07-03', 100], ['2025-07-04', 100], ...SEP(40)]);
  history(ctx, 'Diana Muli Musili', [['2025-12-06', 150], ['2025-12-07', 150], ['2025-12-08', 150], ['2025-12-09', 150], ...SEP(80)]);
  history(ctx, 'George Owiti', [['2026-04-17', 300], ['2026-04-18', 300], ['2026-04-19', 300], ['2026-04-20', 300], ...SEP(300)]);

  // Reproduce the drifted state the screenshots showed.
  Object.assign(eunice, { spent: 240, visits: 3 });
  Object.assign(diana, { spent: 380, visits: 3 });
  Object.assign(george, { spent: 900, visits: 3 });

  const fixed = ctx.repairDates();
  assert.ok(fixed >= 3, 'repairDates must report the three repaired customers');

  // Card == what the history lists (all rows are itemised, and they exceed the
  // report baseline in each period, so the sum of the list is the total).
  assert.equal(eunice.spent, 520); assert.equal(eunice.visits, 7);
  assert.equal(diana.spent, 840); assert.equal(diana.visits, 7);
  assert.equal(george.spent, 2100); assert.equal(george.visits, 7);

  // Idempotent — a second pass changes nothing.
  assert.equal(ctx.repairDates(), 0);
  assert.equal(eunice.spent, 520);
  assert.equal(george.visits, 7);
});

test('rows dated inside the baseline period are absorbed by the baseline, rows after it are added on top', () => {
  const ctx = makeContext();
  // Report says KES 600 over 2 visits up to 2026-06-01.
  const george = seedCustomer(ctx, SEED_ROWS[0]);

  // Backfilling ONE of the two report-period purchases must not change the total.
  history(ctx, 'George Owiti', [['2026-05-20', 300]]);
  ctx.repairDates();
  assert.equal(george.spent, 600);
  assert.equal(george.visits, 2);

  // Backfilling BOTH: still 600 / 2 (the baseline already covered them).
  history(ctx, 'George Owiti', [['2026-05-20', 300], ['2026-06-01', 300]]);
  ctx.repairDates();
  assert.equal(george.spent, 600);
  assert.equal(george.visits, 2);

  // A backfilled statement that reveals MORE than the report knew inside the
  // period wins (the history is the more complete record).
  history(ctx, 'George Owiti', [['2026-05-20', 300], ['2026-06-01', 300], ['2026-05-01', 250]]);
  ctx.repairDates();
  assert.equal(george.spent, 850);
  assert.equal(george.visits, 3);

  // New business after the report cut-off is always ADDED — never swallowed
  // by a large baseline (the old max(seed, history) rule got this wrong).
  history(ctx, 'George Owiti', [...SEP(300)]);
  ctx.repairDates();
  assert.equal(george.spent, 600 + 900);
  assert.equal(george.visits, 2 + 3);
});

test('two records sharing one exact name never count the same history twice', () => {
  const ctx = makeContext();
  const first = seedCustomer(ctx, SEED_ROWS[3]);
  const second = seedCustomer(ctx, SEED_ROWS[4]);
  history(ctx, 'Tobias Odipo', [...SEP(200)]);
  ctx.repairDates();
  // The first record (the one the modal and matcher resolve) owns the history.
  assert.equal(first.spent, 2900 + 600);
  assert.equal(first.visits, 7 + 3);
  // The second keeps its own baseline and nothing else.
  assert.equal(second.spent, 500);
  assert.equal(second.visits, 1);
});

test('a legacy record without a baseline stamp keeps its unexplained total as a frozen baseline', () => {
  const ctx = makeContext();
  // Created by an older build from a customer-export row (KES 1,000 / 4 visits),
  // then two statement rows were imported additively → 1,300 / 6. It carries no
  // seed* fields at all.
  const legacy = { name: 'Legacy Customer', contact: '0711000000', spent: 1300, visits: 6, days: 5, firstVisit: '2026-08-01', lastVisit: '2026-09-03', masked: false, isNew: false };
  ctx.DB.customers.push(legacy);
  history(ctx, 'Legacy Customer', [['2026-09-02', 150], ['2026-09-03', 150]]);

  ctx.repairDates();
  // Nothing the user already saw gets smaller…
  assert.equal(legacy.spent, 1300);
  assert.equal(legacy.visits, 6);
  // …and the unexplained part is now an explicit baseline dated just before
  // the earliest itemised row, so future rows are booked on top of it.
  assert.equal(legacy.seedSpent, 1000);
  assert.equal(legacy.seedVisits, 4);
  assert.equal(legacy.seedLastVisit, '2026-09-01');
  assert.equal(legacy.isSeed, undefined);

  history(ctx, 'Legacy Customer', [['2026-09-02', 150], ['2026-09-03', 150], ['2026-09-04', 200]]);
  ctx.repairDates();
  assert.equal(legacy.spent, 1500);
  assert.equal(legacy.visits, 7);
});

test('a customer discovered by a statement is a pure sum of their history', () => {
  const ctx = makeContext();
  const c = { name: 'New Person', contact: '0722000000', spent: 0, visits: 0, days: 0, firstVisit: '2026-09-01', lastVisit: '2026-09-03', masked: false, isNew: true, isSeed: false, seedSpent: 0, seedVisits: 0, seedLastVisit: '' };
  ctx.DB.customers.push(c);
  history(ctx, 'New Person', [...SEP(120)]);
  ctx.repairDates();
  assert.equal(c.spent, 360);
  assert.equal(c.visits, 3);
  // Removing a duplicate row from the history rolls the total back by itself.
  history(ctx, 'New Person', [['2026-09-01', 120], ['2026-09-02', 120]]);
  ctx.repairDates();
  assert.equal(c.spent, 240);
  assert.equal(c.visits, 2);
});

test('Overview revenue equals the sum of the customer totals — no double counting', () => {
  const ctx = makeContext();
  const george = seedCustomer(ctx, SEED_ROWS[0]);
  history(ctx, 'George Owiti', [...SEP(300)]);
  // A non-seed customer whose isNew flag has been cleared by a newer import —
  // the old formula counted BOTH their spent AND their transactions.
  const later = { name: 'Later Customer', contact: '0733000000', spent: 0, visits: 0, days: 0, firstVisit: '2026-08-10', lastVisit: '2026-08-10', masked: false, isNew: false, isSeed: false, seedSpent: 0, seedVisits: 0, seedLastVisit: '' };
  ctx.DB.customers.push(later);
  history(ctx, 'Later Customer', [['2026-08-10', 500]]);
  ctx.DB.transactions = [
    ...SEP(300).map(([date, amount]) => ({ date, amount, name: 'George Owiti', phone: '0710428075', product: 'meat' })),
    { date: '2026-08-10', amount: 500, name: 'Later Customer', phone: '0733000000', product: 'meat' }
  ];
  ctx.repairDates();

  const stats = ctx.getProductStats();
  const sumSpent = ctx.DB.customers.reduce((s, c) => s + c.spent, 0);
  assert.equal(sumSpent, 1500 + 500);
  assert.equal(stats.totalRevenue, sumSpent);
  assert.equal(stats.meatRevenue + stats.soupRevenue, stats.totalRevenue);
  assert.equal(stats.meatVisits + stats.soupVisits, stats.totalVisits);
  assert.equal(stats.totalVisits, ctx.DB.customers.reduce((s, c) => s + c.visits, 0));
  assert.equal(stats.meatCustomers + stats.soupCustomers, 2);
});

test('the modal renders card figures from the same tally it lists — with a reconciling footer', () => {
  const body = slice('function showCustomerDetail(name){', 'function closeCustModal(){');
  assert.match(body, /reconcileCustomerAggregates\(c\)/, 'card must be reconciled before rendering');
  assert.match(body, /customerTally\(c\)/);
  assert.match(body, /customerHistoryFor\(c\)/, 'history must come from the owning record');
  assert.match(body, /Listed above/);
  assert.match(body, /not itemised/);
  assert.match(body, /= Total/);
});

test('every mutation path re-derives the totals instead of hand-adjusting them', () => {
  const importBody = slice('function importTransactions(txs, opts = {}) {', '/* ══════════ 1-CLICK ROLLBACK DUPLICATE REVENUE');
  assert.doesNotMatch(importBody, /match\.spent\s*=\s*Math\.max\(0,\s*Number\(match\.spent/, 'import must not accumulate spent');
  assert.doesNotMatch(importBody, /match\.visits\s*=\s*Number\(match\.visits \|\| 0\) \+ 1/, 'import must not accumulate visits');
  assert.match(importBody, /reconcileCustomerAggregates\(cust\)/);

  const backfillBody = slice('function backfillTransactions(txs){', 'async function handleBackfill(input){');
  assert.match(backfillBody, /reconcileCustomerAggregates\(c\)/, 'backfill must bring the card back in tally');

  const rollback = slice('function reconcileImportedRevenue(){', 'window.reconcileImportedRevenue');
  assert.doesNotMatch(rollback, /cust\.spent\s*=\s*Math\.max\(0,\s*\(Number\(cust\.spent/, 'rollback must not subtract by hand');
  assert.match(rollback, /repairDates\(\)/);

  const dedupe = slice('function dedupeCustomers(){', 'window.dedupeCustomers');
  assert.match(dedupe, /mergeBaselineFields\(primary, o\)/);
  assert.doesNotMatch(dedupe, /primary\.spent\s*=\s*Math\.max/);

  const rebuild = slice('function recalcFromHistory(){', '/* ══════════ IMPORT MODAL HELPERS');
  assert.match(rebuild, /reconcileCustomerAggregates\(c, txs\)/);

  const load = slice('async function loadFromCloud() {', 'let cloudSaveChain');
  assert.match(load, /mergeBaselineFields\(localCust, cloudCust\)/);

  // The baseline cut-off must survive the cloud round-trip.
  const gas = fs.readFileSync(path.join(root, 'google-apps-script.gs'), 'utf8');
  assert.match(gas, /'seedVisits',[\s\S]*?'seedLastVisit',/);
});
