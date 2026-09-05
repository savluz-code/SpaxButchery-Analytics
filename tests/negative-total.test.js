'use strict';

// Regression guard for the negative Overview Total Revenue bug.
//
// Root cause: getProductStats() sums every non-NEW customer's `spent` plus
// non-seed transaction amounts. A customer-export/baseline CSV whose
// `Amount`/`Revenue`/`Total_Spent` column held a negative value produced a
// customer with `spent < 0`, and the Overview (PR #26) started showing a
// negative Total Revenue. That became visible on the 21st when PR #19 changed
// `isNew` from a sticky flag to a derived flag (legacy negative rows stopped
// being excluded by `if(c.isNew) return`).
//
// The fix must keep three things true:
//   1. mergeBaselineCustomer() never stores a negative lifetime spent/visits.
//   2. getProductStats() treats negative spent/amounts as zero for revenue.
//   3. sanitizeNegativeTotals() repairs already-persisted negative rows.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function baseContext(overrides = {}) {
  return vm.createContext({
    console,
    Date,
    Math,
    ...overrides
  });
}

// mergeBaselineCustomer now writes the incoming aggregate into the customer's
// BASELINE and derives spent/visits through the CUSTOMER TALLY helpers, so the
// sandbox needs that block too.
function customerTallySource() {
  const start = htmlSource.indexOf('/* ══════════ CUSTOMER TALLY');
  assert.notEqual(start, -1, 'CUSTOMER TALLY block not found');
  const end = htmlSource.indexOf('function repairDates', start);
  assert.notEqual(end, -1, 'CUSTOMER TALLY end not found');
  return htmlSource.slice(start, end);
}

test('mergeBaselineCustomer clamps a negative baseline spent for a new customer', () => {
  const start = htmlSource.indexOf('function mergeBaselineCustomer');
  assert.notEqual(start, -1, 'mergeBaselineCustomer not found');
  const end = htmlSource.indexOf('/* ══════════ M-PESA PDF / OCR', start);
  assert.notEqual(end, -1, 'mergeBaselineCustomer end not found');

  const context = baseContext();
  vm.runInContext(`
    function getTodayEAT(){ return new Date().toISOString().slice(0,10); }
    function daysSince(){ return 999; }
    function normalizeContact(x){ return String(x || '').replace(/\\s+/g, ''); }
    function isValidKenyanContact(){ return true; }
    function normalizeName(x){ return String(x || '').toLowerCase().trim(); }
    function tokenMatchScore(){ return 0; }
    function findCustomerMatch(){ return null; }
    function contactStatus(){ return { masked: false }; }
    DB = {
      customers: [],
      transactions: [],
      customerTx: {},
      monthly: { labels: [], revenue: [] },
      importBatch: 0,
      importedRev: 0,
      importedTx: 0,
      seen: {}
    };
  `, context);
  vm.runInContext(customerTallySource(), context);
  vm.runInContext(htmlSource.slice(start, end), context);

  vm.runInContext(`
    mergeBaselineCustomer({
      name: 'Negative Baseline',
      totalSpent: -1250000,
      visits: -3,
      firstVisit: '2026-08-01',
      lastVisit: '2026-08-01'
    });
  `, context);

  const customer = context.DB.customers[0];
  assert.ok(customer, 'customer was not created');
  assert.equal(customer.spent, 0);
  assert.equal(customer.visits, 1);
});

test('mergeBaselineCustomer never lowers an existing customer to a negative spent', () => {
  const start = htmlSource.indexOf('function mergeBaselineCustomer');
  const end = htmlSource.indexOf('/* ══════════ M-PESA PDF / OCR', start);
  const context = baseContext();
  vm.runInContext(`
    function getTodayEAT(){ return new Date().toISOString().slice(0,10); }
    function daysSince(){ return 999; }
    function normalizeContact(x){ return String(x || '').replace(/\\s+/g, ''); }
    function isValidKenyanContact(){ return true; }
    function normalizeName(x){ return String(x || '').toLowerCase().trim(); }
    function tokenMatchScore(){ return 0; }
    function contactStatus(){ return { masked: false }; }
    DB = {
      customers: [{ name: 'Existing', contact: '', spent: 500, visits: 2, isSeed: false, newBatch: 0 }],
      transactions: [],
      customerTx: {},
      monthly: { labels: [], revenue: [] },
      importBatch: 0,
      importedRev: 0,
      importedTx: 0,
      seen: {}
    };
    function findCustomerMatch(c){
      return DB.customers.find(x => normalizeName(x.name) === normalizeName(c.name)) || null;
    }
  `, context);
  vm.runInContext(customerTallySource(), context);
  vm.runInContext(htmlSource.slice(start, end), context);

  vm.runInContext(`
    mergeBaselineCustomer({
      name: 'Existing',
      totalSpent: -900,
      visits: 1,
      firstVisit: '2026-08-01',
      lastVisit: '2026-08-01'
    });
  `, context);

  assert.equal(context.DB.customers[0].spent, 500);
  assert.equal(context.DB.customers[0].visits, 2);
});

test('getProductStats never returns a negative total from a corrupt negative row', () => {
  const start = htmlSource.indexOf('const SOUP_START_DATE');
  const end = htmlSource.indexOf('function repairDates', start);
  assert.notEqual(end, -1, 'getProductStats end not found');

  const context = baseContext();
  context.DB = {
    customers: [
      { name: 'Seed A', isSeed: true, spent: 500, visits: 2, lastVisit: '2026-05-01', isNew: false },
      { name: 'Negative Customer', isSeed: false, spent: -1250000, visits: 1, lastVisit: '2026-08-01', isNew: false }
    ],
    transactions: [
      { name: 'Negative Customer', amount: -5000, product: 'meat', backfillOnly: false }
    ],
    importedRev: 0,
    importedTx: 0
  };
  vm.runInContext(htmlSource.slice(start, end), context);

  const stats = context.getProductStats();
  assert.equal(stats.totalRevenue, 500);
  assert.equal(stats.meatRevenue, 500);
  assert.equal(stats.soupRevenue, 0);
  assert.ok(stats.totalRevenue >= 0);
});

test('sanitizeNegativeTotals repairs persisted negative customers and amounts', () => {
  const start = htmlSource.indexOf('function sanitizeNegativeTotals');
  const end = htmlSource.indexOf('/* ══════════ NEW THIS MONTH (isNewThisMonth) ══════════', start);
  assert.notEqual(end, -1, 'sanitizeNegativeTotals end not found');

  const context = baseContext();
  context.DB = {
    customers: [
      { name: 'Bad Customer', spent: -1000, visits: -2, seedSpent: -50, seedVisits: -1 },
      { name: 'Good Customer', spent: 100, visits: 1, seedSpent: 0, seedVisits: 0 }
    ],
    transactions: [
      { name: 'Bad Customer', amount: -200, receipt: 'R1' }
    ],
    customerTx: {
      'Bad Customer': [{ date: '2026-08-01', amount: -200, receipt: 'R1' }]
    }
  };
  vm.runInContext(htmlSource.slice(start, end), context);

  const fixed = context.sanitizeNegativeTotals();
  assert.ok(fixed > 0, 'expected at least one negative value to be clamped');
  assert.equal(context.DB.customers[0].spent, 0);
  assert.equal(context.DB.customers[0].visits, 0);
  assert.equal(context.DB.customers[0].seedSpent, 0);
  assert.equal(context.DB.transactions[0].amount, 0);
  assert.equal(context.DB.customerTx['Bad Customer'][0].amount, 0);
  assert.equal(context.DB.customers[1].spent, 100);
});
