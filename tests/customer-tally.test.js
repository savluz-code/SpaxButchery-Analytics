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
//   spent  = max(baseline.spent, Σ rows dated inside the period)
//            + Σ rows dated after baseline.lastVisit
//   visits = max(baseline.visits, count(rows inside)) + count(rows after)
//
// PR #47 first shipped this with two mistakes that DOUBLED the header revenue
// (KES 4,075K): (a) a seed customer's cut-off was their own Last Visit rather
// than the REPORT date (Last Visit + Days Since — one date for the whole
// export: 2026-06-24, and 2026-07-12 for the later export), so statement rows
// dated between their last purchase and the report date were booked on top
// of a total that already included them; (b) inside the period the formula
// took max(baseline, Σ rows) over a history that still held DUPLICATE
// receipts, so a re-imported statement raised the total further.
//
// (a) still stands: the cut-off is the report date for every seed row.
// (b) was the symptom, not the max() — repairDates() now collapses duplicate
// receipts BEFORE the tally runs, so what is left above the baseline is
// genuine. The rule today is: WHERE AN ITEMISED DOCUMENT IS AVAILABLE IT IS
// PREFERRED OVER THE SEED DATA. A statement is one dated, receipt-numbered row
// per payment; the baseline is one undated total. When the itemised rows for
// the period add up to more than the aggregate, the aggregate missed purchases
// and the rows take over. It only ever RAISES a total — the report counts
// every payment channel while a statement can only show the M-Pesa ones, so a
// smaller itemised total is incomplete coverage and the aggregate stays as the
// floor for the part of the period no statement reaches.
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

// Five seed rows exactly as they appear in SEED_CUSTOMERS (name, contact,
// spent, visits, days, firstVisit, lastVisit). Last Visit + Days Since is
// 2026-06-24 for every row — the date the report was generated.
const SEED_ROWS = [
  ['George Owiti', '0710428075', 600, 2, 23, '2026-06-01', '2026-06-01'],
  ['Diana Muli Musili', '0113***835', 150, 1, 155, '2026-01-20', '2026-01-20'],
  ['Eunice Mbithe Ndelesi', '0723***680', 100, 1, 325, '2025-08-03', '2025-08-03'],
  // Same-name pair (the report has 41 of these) — must not double count.
  ['Tobias Odipo', '0720208056', 2900, 7, 4, '2025-07-01', '2026-06-20'],
  ['Tobias Odipo', '0720964081', 500, 1, 54, '2026-05-01', '2026-05-01']
];
const REPORT_DATE = '2026-06-24';

function makeContext(today = '2026-09-05', seedRows = SEED_ROWS) {
  const ctx = vm.createContext({ console, Date, Math, Number, String, Map, Set, Object, Array, JSON, isFinite, isNaN });
  vm.runInContext(`
    const SEED_CUSTOMERS = ${JSON.stringify(seedRows)};
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

// A seed record exactly as the MERGED build (PR #47) wrote it: the cut-off is
// the customer's own Last Visit. ensureBaselineFields must re-stamp it.
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
  // An explicit receipt (even '') is kept as given; otherwise a unique one is
  // generated so the receipt dedupe in repairDates never touches these rows.
  ctx.DB.customerTx[name] = rows.map(([date, amount, receipt], i) => ({ date, amount, product: amount <= 50 && date >= '2026-06-01' ? 'soup' : 'meat', receipt: receipt !== undefined ? receipt : ('R' + date.replace(/-/g, '') + amount + 'N' + i) }));
}

const SEP = (amt) => [['2026-09-01', amt], ['2026-09-02', amt], ['2026-09-03', amt]];

test('the report date is one cut-off for every seed row (Last Visit + Days Since)', () => {
  const ctx = makeContext();
  assert.equal(ctx._addDays('2026-06-01', 23), REPORT_DATE);
  assert.equal(ctx._addDays('2025-08-03', 325), REPORT_DATE);
  assert.equal(ctx._addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(ctx._addDays('not-a-date', 3), '');
  assert.equal(ctx.seedReportCutoff(), REPORT_DATE);
  // Every row carries the report date, not its own Last Visit.
  for (const row of SEED_ROWS) {
    const r = ctx.seedBaselineFor(row[0], row[1]);
    assert.equal(r.asOf, REPORT_DATE, `${row[0]} asOf`);
    assert.equal(r.lastVisit, row[6]);
  }
});

test('a later export moves the cut-off for the whole report, and 999-day rows fall back to their Last Visit', () => {
  const rows = [
    ['Early Customer', '0711111111', 1000, 4, 23, '2026-01-01', '2026-06-01'],  // 2026-06-24
    ['Late Customer', '0722222222', 2000, 8, 0, '2026-01-01', '2026-07-12'],    // 2026-07-12 (later export)
    ['Unknown Days', '0733333333', 300, 1, 999, '', '2026-03-03']
  ];
  const ctx = makeContext('2026-09-05', rows);
  assert.equal(ctx.seedReportCutoff(), '2026-07-12');
  assert.equal(ctx.seedBaselineFor('Early Customer', '0711111111').asOf, '2026-07-12');
  assert.equal(ctx.seedBaselineFor('Unknown Days', '0733333333').asOf, '2026-07-12');
});

test('a record the merged build stamped with its own Last Visit is moved to the report date', () => {
  const ctx = makeContext();
  const george = seedCustomer(ctx, SEED_ROWS[0]);
  assert.equal(george.seedLastVisit, '2026-06-01');
  assert.equal(ctx.ensureBaselineFields(george), true);
  assert.equal(george.seedLastVisit, REPORT_DATE);
  assert.equal(george.seedSpent, 600);
  assert.equal(george.seedVisits, 2);
  // Idempotent.
  assert.equal(ctx.ensureBaselineFields(george), false);

  // A record without any cut-off gets the report date too.
  const diana = seedCustomer(ctx, SEED_ROWS[1]);
  diana.seedLastVisit = '';
  ctx.ensureBaselineFields(diana);
  assert.equal(diana.seedLastVisit, REPORT_DATE);

  // A newer export aggregate has superseded the report figures (bigger
  // baseline as of its own date): that cut-off is kept.
  const eunice = seedCustomer(ctx, SEED_ROWS[2]);
  Object.assign(eunice, { seedSpent: 900, seedVisits: 5, seedLastVisit: '2026-06-10' });
  ctx.ensureBaselineFields(eunice);
  assert.equal(eunice.seedLastVisit, '2026-06-10');
  assert.equal(eunice.seedSpent, 900);
});

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

  // Card = the ITEMISED history where one exists. Every one of these three has
  // a statement for the report period, and each statement reaches past the
  // report aggregate, so the aggregate gives way to it: the card is now exactly
  // the sum of the receipts listed under it — the "history" column the original
  // screenshots disagreed with.
  assert.equal(eunice.spent, 400 + 120); assert.equal(eunice.visits, 4 + 3);
  assert.equal(diana.spent, 600 + 240); assert.equal(diana.visits, 4 + 3);
  assert.equal(george.spent, 2100); assert.equal(george.visits, 7);

  // The modal footer reconciles the list to the card:
  //   Listed above 7 tx · KES 2,100
  //   ↳ Statement supersedes the report total (up to 2026-06-24)  +2 visits · KES 600
  //     (a note — that money is already inside "Listed above")
  //   = Total 7 visits · KES 2,100
  const t = ctx.customerTally(george);
  const listed = ctx.customerHistoryFor(george);
  assert.equal(listed.length, 7);
  assert.equal(listed.reduce((s, r) => s + r.amount, 0), 2100);
  assert.equal(t.unitemised.spent, 0); assert.equal(t.unitemised.visits, 0);
  assert.equal(t.supersedes.spent, 600); assert.equal(t.supersedes.visits, 2);
  assert.equal(t.base.lastVisit, REPORT_DATE);
  assert.equal(listed.reduce((s, r) => s + r.amount, 0) + t.unitemised.spent, george.spent);
  assert.equal(listed.length + t.unitemised.visits, george.visits);

  // Idempotent — a second pass changes nothing.
  assert.equal(ctx.repairDates(), 0);
  assert.equal(eunice.spent, 520);
  assert.equal(george.visits, 7);
});

test('an itemised statement is preferred over the seed aggregate: it raises the total, and never lowers it', () => {
  const ctx = makeContext();
  // Report (generated 2026-06-24) says KES 600 over 2 visits — one undated
  // total. Every history() row below is a dated receipt from a statement.
  const george = seedCustomer(ctx, SEED_ROWS[0]);

  // ONE statement receipt inside the period: coverage is partial, so the
  // aggregate is still the better figure for the part no statement reaches.
  history(ctx, 'George Owiti', [['2026-05-20', 300]]);
  ctx.repairDates();
  assert.equal(george.spent, 600);
  assert.equal(george.visits, 2);
  assert.equal(ctx.customerTally(george).unitemised.spent, 300);
  assert.equal(ctx.customerTally(george).supersedes.spent, 0);

  // BOTH report-period receipts: the itemised total meets the aggregate, so
  // there is nothing left un-itemised — and nothing extra to book.
  history(ctx, 'George Owiti', [['2026-05-20', 300], ['2026-06-01', 300]]);
  ctx.repairDates();
  assert.equal(george.spent, 600);
  assert.equal(george.visits, 2);
  assert.equal(ctx.customerTally(george).unitemised.spent, 0);

  // A THIRD receipt the report never carried — including one dated between his
  // last purchase (2026-06-01) and the report date, the row the merged build
  // double counted. It is real, deduped money, so the statement takes over.
  history(ctx, 'George Owiti', [['2026-05-20', 300], ['2026-06-01', 300], ['2026-06-15', 300]]);
  ctx.repairDates();
  assert.equal(george.spent, 900);
  assert.equal(george.visits, 3);
  assert.equal(george.seedLastVisit, REPORT_DATE);
  assert.equal(ctx.customerTally(george).supersedes.spent, 300);
  assert.equal(ctx.customerTally(george).supersedes.visits, 1);

  // A different statement that only reaches 850: still above the aggregate, so
  // it still wins — but only by what it actually shows.
  history(ctx, 'George Owiti', [['2026-05-20', 300], ['2026-06-01', 300], ['2026-05-01', 250]]);
  ctx.repairDates();
  assert.equal(george.spent, 850);
  assert.equal(george.visits, 3);
  assert.equal(ctx.customerTally(george).supersedes.spent, 250);
  assert.equal(ctx.customerTally(george).supersedes.visits, 1);

  // And a statement SMALLER than the aggregate never erases the difference:
  // the report counts cash too, a statement only ever shows the M-Pesa side.
  history(ctx, 'George Owiti', [['2026-05-20', 100]]);
  ctx.repairDates();
  assert.equal(george.spent, 600, 'the aggregate is the floor for the un-itemised part');
  assert.equal(george.visits, 2);
  assert.equal(ctx.customerTally(george).unitemised.spent, 500);
});

test('rows after the report cut-off are always added on top, whatever the baseline says', () => {
  const ctx = makeContext();
  const george = seedCustomer(ctx, SEED_ROWS[0]);

  // The report is dated 2026-06-24 for the seed rows in this fixture: a row on
  // the cut-off is inside the period, the day after it is new business.
  history(ctx, 'George Owiti', [['2026-06-24', 300], ['2026-06-25', 300]]);
  ctx.repairDates();
  assert.equal(george.spent, 900);
  assert.equal(george.visits, 3);

  // New business after the report cut-off is always ADDED — never swallowed
  // by a large baseline (the old max(seed, history) rule got this wrong).
  history(ctx, 'George Owiti', [...SEP(300)]);
  ctx.repairDates();
  assert.equal(george.spent, 600 + 900);
  assert.equal(george.visits, 2 + 3);
});

test('a row dated 2026-07-01 leaves George at 600/2; a row dated 2026-07-13 makes him 900/3 under the later export', () => {
  // The real report mixes the 2026-06-24 export with a later one generated
  // 2026-07-12; one cut-off (the later one) applies to every row.
  const rows = SEED_ROWS.concat([['Onyango Akinyi Edwina', '0720638326', 9960, 33, 0, '2025-07-14', '2026-07-12']]);
  const ctx = makeContext('2026-09-05', rows);
  assert.equal(ctx.seedReportCutoff(), '2026-07-12');
  const george = seedCustomer(ctx, SEED_ROWS[0]);
  history(ctx, 'George Owiti', [['2026-07-01', 300]]);
  ctx.repairDates();
  assert.equal(george.seedLastVisit, '2026-07-12');
  assert.equal(george.spent, 600);
  assert.equal(george.visits, 2);
  history(ctx, 'George Owiti', [['2026-07-01', 300], ['2026-07-13', 300]]);
  ctx.repairDates();
  assert.equal(george.spent, 900);
  assert.equal(george.visits, 3);
});

test('a phone whose history holds every report receipt twice comes back to exactly the report total plus post-report rows', () => {
  const ctx = makeContext();
  const george = seedCustomer(ctx, SEED_ROWS[0]);
  // Two report-period receipts, each imported twice (older builds let a
  // re-imported statement through), plus one September payment, also twice.
  history(ctx, 'George Owiti', [
    ['2026-05-20', 300, 'ABC12345678'], ['2026-05-20', 300, 'ABC12345678'],
    ['2026-06-01', 300, 'ABC22345678'], ['2026-06-01', 300, 'abc-2234-5678'],
    ['2026-09-01', 250, 'SEP00000001'], ['2026-09-01', 250, 'SEP00000001'],
    // Rows without a usable receipt are never touched by the dedupe.
    ['2026-09-02', 100, ''], ['2026-09-02', 100, ''], ['2026-09-03', 80, 'SHORT1']
  ]);
  const fixed = ctx.repairDates();
  assert.ok(fixed >= 3, 'three duplicate receipts must be counted as repairs');
  const hist = ctx.DB.customerTx['George Owiti'];
  assert.equal(hist.length, 6);
  assert.deepEqual(hist.map(r => r.receipt), ['ABC12345678', 'ABC22345678', 'SEP00000001', '', '', 'SHORT1']);
  // Report total + the post-report rows (one copy each of the receipts).
  assert.equal(george.spent, 600 + 250 + 100 + 100 + 80);
  assert.equal(george.visits, 2 + 4);
  // A second pass is a no-op.
  assert.equal(ctx.repairDates(), 0);
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
  assert.match(body, /Already in the report total/, 'the baseline-less suppression line stays');
  assert.match(body, /tally\.supersedes/);
  assert.match(body, /Statement supersedes the report total/);
  assert.match(body, /= Total/);
});

test('seedDB stamps the report date, and the service worker cache was bumped', () => {
  const seed = slice('function seedDB(){', 'function load(){');
  assert.match(seed, /seedLastVisit:\s*\(lastVisit && days < 999\) \? _addDays\(lastVisit, days\) : lastVisit/);
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(sw, /const CACHE_NAME = 'spax-v23';/);
});

test('every mutation path re-derives the totals instead of hand-adjusting them', () => {
  const importBody = slice('function importTransactions(txs, opts = {}) {', '/* ══════════ 1-CLICK ROLLBACK DUPLICATE REVENUE');
  assert.doesNotMatch(importBody, /match\.spent\s*=\s*Math\.max\(0,\s*Number\(match\.spent/, 'import must not accumulate spent');
  assert.doesNotMatch(importBody, /match\.visits\s*=\s*Number\(match\.visits \|\| 0\) \+ 1/, 'import must not accumulate visits');
  assert.match(importBody, /reconcileCustomerAggregates\(cust\)/);
  // The revenue delta is measured on the record that owns the history.
  assert.match(importBody, /historyOwnerMap\(\)\.get\(cust\.name\) \|\| cust/);

  const backfillBody = slice('function backfillTransactions(txs){', 'async function handleBackfill(input){');
  assert.match(backfillBody, /reconcileCustomerAggregates\(c\)/, 'backfill must bring the card back in tally');

  const rollback = slice('function reconcileImportedRevenue(){', 'window.reconcileImportedRevenue');
  assert.doesNotMatch(rollback, /cust\.spent\s*=\s*Math\.max\(0,\s*\(Number\(cust\.spent/, 'rollback must not subtract by hand');
  assert.doesNotMatch(rollback, /DB\.importedRev\s*=\s*Math\.max\(0,\s*\(Number\(DB\.importedRev \|\| 0\) - amount\)\)/, 'rollback must debit the drop in derived totals, not the raw duplicate sum');
  assert.match(rollback, /rolledBack/);
  assert.match(rollback, /repairDates\(\)/);

  const dedupe = slice('function dedupeCustomers(){', 'window.dedupeCustomers');
  assert.match(dedupe, /mergeBaselineFields\(primary, o\)/);
  assert.doesNotMatch(dedupe, /primary\.spent\s*=\s*Math\.max/);

  const rebuildHandler = slice('async function handleRebuild(input){', 'function recalcFromHistory(){');
  // A Full Rebuild is now SCOPED to the statement period: it derives the window
  // from the re-imported rows, clears only that window, rebuilds the seen-map
  // from the survivors, and re-derives the ledgers from the surviving history +
  // daily ledgers — it must NOT reset the whole monthly chart / importedRev to
  // the seed months (that would erase the periods before/after the statement).
  assert.match(rebuildHandler, /statementPeriodOf\(allRows\)/, 'rebuild must derive the statement period from the re-imported rows');
  assert.match(rebuildHandler, /clearHistoryInPeriod\(period\)/, 'rebuild must clear only the statement period, not the whole set');
  assert.match(rebuildHandler, /rebuildSeenMap\(\)/, 'rebuild must rebuild the seen-map from the surviving transactions');
  assert.match(rebuildHandler, /importTransactions\(allRows\)/, 'rebuild must import the parsed rows in one batch');
  assert.doesNotMatch(rebuildHandler, /DB\.monthly = JSON\.parse\(JSON\.stringify\(SEED_MONTHLY\)\)/, 'rebuild must NOT restart the monthly chart from the seed months (it is scoped to the statement period)');
  assert.doesNotMatch(rebuildHandler, /DB\.importedRev = 0/, 'rebuild must NOT zero importedRev (it is re-derived from the survivors + ledgers)');
  // The daily ledgers are folded back in by reconcileRevenueLedgers() (REVENUE
  // LEDGERS) rather than re-added by hand, so a rebuild can neither drop them
  // nor credit them twice.

  const rebuild = slice('function recalcFromHistory(){', '/* ══════════ IMPORT MODAL HELPERS');
  assert.match(rebuild, /reconcileCustomerAggregates\(c, txs\)/);

  const load = slice('async function loadFromCloud() {', 'let cloudSaveQueue');
  assert.match(load, /mergeBaselineFields\(localCust, cloudCust\)/);

  // The baseline cut-off must survive the cloud round-trip.
  const gas = fs.readFileSync(path.join(root, 'google-apps-script.gs'), 'utf8');
  assert.match(gas, /'seedVisits',[\s\S]*?'seedLastVisit',/);
});
