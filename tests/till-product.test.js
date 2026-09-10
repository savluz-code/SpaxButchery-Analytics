'use strict';

// Till-based product classification (from 6 Sept 2026).
//
// The business now collects on two M-Pesa merchant numbers:
//   5803756 → Meat,  1213294 → Soup (and other small items).
// From 2026-09-06 the RECEIVING TILL decides Meat vs Soup — not the amount.
// Rows before the split keep the legacy heuristic (≤ KES 50 → soup from
// 2026-06-01, everything before that is meat), as do post-split rows whose
// till could not be detected anywhere (row Details → file header → file name).
//
// These tests run the REAL classification functions from index.html inside a
// vm sandbox, and pin the wiring (parse → import/backfill → cloud → UI).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const gasSource = fs.readFileSync(path.join(root, 'google-apps-script.gs'), 'utf8');

function slice(startMarker, endMarker) {
  const start = htmlSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} not found`);
  const end = htmlSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} not found after ${startMarker}`);
  return htmlSource.slice(start, end);
}

// The classification block: constants + extract/tx/classify + reclassify +
// count. customerProductSplit is excluded (it needs the customer-history
// machinery); its till-awareness is pinned at source level instead.
function classificationSource() {
  return slice('const SOUP_START_DATE', 'function customerProductSplit');
}

function makeContext(db) {
  const ctx = vm.createContext({ console, Date, Math, Number, String, Object, Array, JSON });
  vm.runInContext(`var DB = ${JSON.stringify(db || { transactions: [], customerTx: {} })};`, ctx);
  vm.runInContext(classificationSource(), ctx);
  return ctx;
}

const run = (ctx, code) => vm.runInContext(code, ctx);
const q = (s) => JSON.stringify(s);

test('till constants name the meat and soup merchants and the 6 Sept 2026 switch', () => {
  const ctx = makeContext();
  assert.equal(run(ctx, 'MEAT_TILL'), '5803756');
  assert.equal(run(ctx, 'SOUP_TILL'), '1213294');
  assert.equal(run(ctx, 'TILL_RULE_DATE'), '2026-09-06');
  assert.equal(run(ctx, 'SOUP_START_DATE'), '2026-06-01');
});

test('extractTillNumber finds the receiving till in details, headers and file names', () => {
  const ctx = makeContext();
  assert.equal(run(ctx, `extractTillNumber('Merchant Payment to 5803756 - SPAX BUTCHERY')`), '5803756');
  assert.equal(run(ctx, `extractTillNumber('5803756 · SIMON MBULLNZA')`), '5803756');
  assert.equal(run(ctx, `extractTillNumber('Pay Merchant 1213294 · SPAX SOUP')`), '1213294');
  assert.equal(run(ctx, `extractTillNumber('Till Number: 1213294')`), '1213294');
  assert.equal(run(ctx, `extractTillNumber('Statement_Till 5803756_Sep.xlsx')`), '5803756');
  assert.equal(run(ctx, `extractTillNumber('Merchant Payment from JOHN DOE - 0723***321')`), '');
  assert.equal(run(ctx, `extractTillNumber('')`), '');
  assert.equal(run(ctx, 'extractTillNumber(null)'), '');
  assert.equal(run(ctx, 'extractTillNumber(undefined)'), '');
});

test('txTillNumber prefers the stamped till, then Other Party, details, source', () => {
  const ctx = makeContext();
  assert.equal(run(ctx, `txTillNumber({ till: '5803756', details: 'till 1213294' })`), '5803756');
  assert.equal(run(ctx, `txTillNumber({ otherParty: '5803756 · SIMON MBULLNZA' })`), '5803756');
  assert.equal(run(ctx, `txTillNumber({ otherParty: 'till 1213294', details: 'till 5803756' })`), '1213294', 'Other Party beats Details');
  assert.equal(run(ctx, `txTillNumber({ details: 'paid to 1213294' })`), '1213294');
  assert.equal(run(ctx, `txTillNumber({ source: 'Till 5803756 statement' })`), '5803756');
  assert.equal(run(ctx, `txTillNumber('raw till 1213294 text')`), '1213294');
  assert.equal(run(ctx, `txTillNumber({})`), '');
  assert.equal(run(ctx, 'txTillNumber(null)'), '');
  assert.equal(run(ctx, 'txTillNumber(undefined)'), '');
});

test('classifyProduct keeps the legacy amount rule before 6 Sept 2026', () => {
  const ctx = makeContext();
  // Before the soup launch everything is meat.
  assert.equal(run(ctx, `classifyProduct('2025-07-03', 20)`), 'meat');
  assert.equal(run(ctx, `classifyProduct('2026-05-31', 50)`), 'meat');
  // Soup era, before the till split: amount decides.
  assert.equal(run(ctx, `classifyProduct('2026-06-01', 50)`), 'soup');
  assert.equal(run(ctx, `classifyProduct('2026-08-12', 20)`), 'soup');
  assert.equal(run(ctx, `classifyProduct('2026-09-05', 5000)`), 'meat');
  assert.equal(run(ctx, `classifyProduct('2026-09-05', 50)`), 'soup');
  // Undated rows stay meat (never soup by default).
  assert.equal(run(ctx, `classifyProduct('', 20)`), 'meat');
  // A till mentioned before the split is ignored — the amount rules.
  assert.equal(run(ctx, `classifyProduct('2026-09-05', 5000, 'till 1213294')`), 'meat');
  assert.equal(run(ctx, `classifyProduct('2026-09-05', 20, 'till 5803756')`), 'soup');
});

test('from 6 Sept 2026 the till beats the amount', () => {
  const ctx = makeContext();
  // KES 20 to the meat till is meat, not soup.
  assert.equal(run(ctx, `classifyProduct('2026-09-06', 20, 'Merchant Payment to 5803756')`), 'meat');
  // KES 5,000 to the soup till is soup, not meat.
  assert.equal(run(ctx, `classifyProduct('2026-09-06', 5000, 'Merchant Payment to 1213294')`), 'soup');
  // Transaction-object form (what importTransactions passes).
  assert.equal(run(ctx, `classifyProduct('2026-09-10', 30, { till: '5803756' })`), 'meat');
  assert.equal(run(ctx, `classifyProduct('2026-09-10', 3000, { details: 'to till 1213294' })`), 'soup');
  // String details form.
  assert.equal(run(ctx, `classifyProduct('2026-09-10', 3000, 'to till 1213294')`), 'soup');
});

test('post-split rows without a detectable till fall back to the amount rule', () => {
  const ctx = makeContext();
  assert.equal(run(ctx, `classifyProduct('2026-09-06', 20)`), 'soup');
  assert.equal(run(ctx, `classifyProduct('2026-09-06', 5000)`), 'meat');
  assert.equal(run(ctx, `classifyProduct('2026-09-10', 50, { details: 'no till here' })`), 'soup');
  assert.equal(run(ctx, `classifyProduct('2026-09-10', 51, {})`), 'meat');
});

test('reclassifyTillProducts fixes till-disagreeing rows and nothing else', () => {
  const ctx = makeContext({
    transactions: [
      // Wrong by the old amount rule: KES 20 to the meat till was soup.
      { date: '2026-09-06', amount: 20, product: 'soup', till: '5803756' },
      // Wrong the other way: KES 5,000 to the soup till was meat.
      { date: '2026-09-07', amount: 5000, product: 'meat', till: '1213294' },
      // Already right — untouched.
      { date: '2026-09-07', amount: 5000, product: 'meat', till: '5803756' },
      // No till — left alone (only a re-import can tag it).
      { date: '2026-09-07', amount: 20, product: 'soup', till: '' },
      // Before the split — never touched even with a till stamped.
      { date: '2026-09-05', amount: 20, product: 'soup', till: '5803756' }
    ],
    customerTx: {
      Alice: [
        { date: '2026-09-08', amount: 40, product: 'soup', till: '5803756' },
        { date: '2026-09-08', amount: 40, product: 'meat', till: '5803756' }
      ]
    }
  });
  assert.equal(run(ctx, 'reclassifyTillProducts()'), 3);
  assert.equal(run(ctx, `DB.transactions[0].product`), 'meat');
  assert.equal(run(ctx, `DB.transactions[1].product`), 'soup');
  assert.equal(run(ctx, `DB.transactions[2].product`), 'meat');
  assert.equal(run(ctx, `DB.transactions[3].product`), 'soup');
  assert.equal(run(ctx, `DB.transactions[4].product`), 'soup');
  assert.equal(run(ctx, `DB.customerTx.Alice[0].product`), 'meat');
  assert.equal(run(ctx, `DB.customerTx.Alice[1].product`), 'meat');
  // Idempotent: a second pass finds nothing to fix.
  assert.equal(run(ctx, 'reclassifyTillProducts()'), 0);
});

test('countTillUnknown counts post-split rows with no till', () => {
  const ctx = makeContext({
    transactions: [
      { date: '2026-09-06', amount: 20, till: '' },
      { date: '2026-09-06', amount: 20, till: '5803756' },
      { date: '2026-09-05', amount: 20, till: '' }
    ],
    customerTx: {}
  });
  assert.equal(run(ctx, 'countTillUnknown()'), 1);
});

test('parseMpesaText captures the Other Party trailing columns per row', () => {
  const body = slice('function parseMpesaText(raw, sourceLabel) {', 'function transactionKey(tx) {');
  assert.match(body, /function trailingAfter\(matchEnd\)/, 'must slice the Transaction Type + Other Party cells after the Balance');
  assert.match(body, /hasMeat !== hasSoup/, 'file fallback applies only when exactly one till is named file-wide');
  assert.match(body, /otherParty: trailing1/);
  assert.match(body, /otherParty: trailing2/);
  assert.match(body, /otherParty: trailingLine/);
  assert.match(body, /till: extractTillNumber\(trailing1\)/);
  assert.match(body, /t\.till = t\.till \|\|/, 'safety net must fill missing tills, never overwrite the row’s own');
});

// The REAL parseMpesaText + classification block against minimal stubs, fed
// statement text shaped like the 9 Sept 2026 merchant statement (Receipt,
// Completion Time, Details, Completed, Paid In, Withdrawn, Balance,
// Transaction Type, Other Party).
function makeParseContext() {
  const ctx = vm.createContext({ console, Date, Math, Number, String, Object, Array, JSON });
  vm.runInContext(`
    function normalizeMpesaText(s){ return String(s||''); }
    function cleanReceipt(r){ return String(r||'').replace(/[^A-Z0-9]/gi,'').toUpperCase(); }
    function parseDate(v){ const m = String(v||'').match(/(\\d{4}-\\d{2}-\\d{2})/); return m ? m[1] : ''; }
    function parseAmount(v){ return parseFloat(String(v||'').replace(/[^\\d.]/g,'')) || 0; }
    function isChargeRow(d){ return /\\bcharges?\\b/i.test(String(d||'')); }
    function chargeJudgeSegment(d){ const p = String(d||'').split(/\\b\\d{4}[-\\/]\\d{2}[-\\/]\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}\\b/); return p[p.length-1]; }
    function isIncomingMpesaDetails(d){ return /merchant\\s+payment|pay\\s+merchant|buy\\s+goods|received\\s+from/i.test(String(d||'')); }
    function extractPerson(){ return { name: 'Test User', contact: '' }; }
    function isMerchant(){ return false; }
  `, ctx);
  vm.runInContext(classificationSource(), ctx);
  vm.runInContext(slice('function parseMpesaText(raw, sourceLabel) {', 'function transactionKey(tx) {'), ctx);
  return ctx;
}

test('each row takes the till from its own Other Party cell', () => {
  const ctx = makeParseContext();
  const stmt =
    'UI9KN68I0U 2026-09-09 18:53:49 Merchant Payment from 254727111222 MARY WANJORA Completed 150.00 0.00 2,981.17 Pay Merchant 5803756 · SIMON MBULLNZA\n' +
    'UI9KN68I0V 2026-09-09 19:10:02 Merchant Payment from 254700111222 JOHN DOE Completed 50.00 0.00 3,031.17 Pay Merchant 1213294 · SPAX SOUP';
  const txs = run(ctx, `parseMpesaText(${q(stmt)})`);
  assert.equal(txs.length, 2);
  assert.equal(txs[0].till, '5803756');
  assert.match(txs[0].otherParty, /5803756/);
  assert.equal(txs[1].till, '1213294');
  assert.match(txs[1].otherParty, /1213294/);
  assert.equal(run(ctx, `classifyProduct('2026-09-09', 150, ${JSON.stringify({ till: txs[0].till })})`), 'meat');
  assert.equal(run(ctx, `classifyProduct('2026-09-09', 50, ${JSON.stringify({ till: txs[1].till })})`), 'soup');
});

test('a single-till statement shares its header till with rows that name none', () => {
  const ctx = makeParseContext();
  const stmt =
    'M-PESA STATEMENT Till Number 5803756\n' +
    'UI9KN68I0U 2026-09-09 18:53:49 Merchant Payment from 254727111222 MARY WANJORA Completed 150.00 0.00 2,981.17';
  const txs = run(ctx, `parseMpesaText(${q(stmt)})`);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].till, '5803756');
});

test('a combined statement never lets rows inherit each other’s till', () => {
  const ctx = makeParseContext();
  const stmt =
    'UI9KN68I0U 2026-09-09 18:53:49 Merchant Payment from 254727111222 MARY WANJORA Completed 150.00 0.00 2,981.17 Pay Merchant 5803756\n' +
    'UI9KN68I0V 2026-09-09 19:10:02 Merchant Payment from 254700111222 JOHN DOE Completed 50.00 0.00 3,031.17 Pay Merchant 1213294\n' +
    'UI9KN68I0W 2026-09-09 19:22:40 Merchant Payment from 254711111222 JANE SMITH Completed 5000.00 0.00 8,031.17';
  const txs = run(ctx, `parseMpesaText(${q(stmt)})`);
  assert.equal(txs.length, 3);
  assert.equal(txs[0].till, '5803756', 'explicit row keeps its own till');
  assert.equal(txs[1].till, '1213294', 'explicit row keeps its own till');
  assert.equal(txs[2].till, '', 'till-less row in a both-tills file stays untagged, not meat-by-default');
  assert.equal(run(ctx, `classifyProduct('2026-09-09', 5000, ${JSON.stringify({ till: txs[2].till })})`), 'meat', 'falls back to the amount rule');
});

test('CSV statement exports read the till off the Other Party column first', () => {
  const body = slice('if(hasDetails&&hasPaidIn){', 'isAggregate:true');
  assert.match(body, /Other Party/);
  assert.match(body, /extractTillNumber\(otherParty\)/);
  assert.match(body, /otherParty:otherParty/);
});

test('the legacy sheet parser reads the till off the Other Party column first', () => {
  const body = slice('function parseSheetRows(raw) {', 'function showPreview(rows, fmt) {');
  assert.match(body, /iParty = col\(\/other/);
  assert.match(body, /extractTillNumber\(party\)/);
});

test('importTransactions classifies with the row and stores the till', () => {
  const body = slice('function importTransactions(txs, opts = {}) {', '/* ══════════ 1-CLICK ROLLBACK DUPLICATE REVENUE');
  assert.match(body, /const till = txTillNumber\(tx\)/);
  assert.match(body, /classifyProduct\(tx\.date, tx\.amount, tx\)/, 'must pass the row so the till decides');
  assert.match(body, /DB\.transactions\.push\(\{[\s\S]*?till: till,/);
  assert.match(body, /const histRow = \{[^}]*till: till/);
});

test('backfillTransactions classifies with the row and stores the till', () => {
  const body = slice('function backfillTransactions(txs){', 'async function handleBackfill(input){');
  assert.match(body, /const till = txTillNumber\(tx\)/);
  assert.match(body, /classifyProduct\(tx\.date, tx\.amount, tx\)/);
  assert.match(body, /till: till,/);
  assert.match(body, /till: ntx\.till/);
});

test('unstamped history rows still classify by till through the product split', () => {
  const body = slice('function customerProductSplit(c){', 'function getProductStats(){');
  assert.match(body, /classifyProduct\(t\.date, a, t\)/, 'must pass the row, not just date+amount');
});

test('the cloud upload carries the till on per-customer rows', () => {
  const body = slice('const ctxRows = [];', 'const totalBigRows');
  assert.match(body, /till: t\.till \|\| ''/);
});

test('repairDates re-stamps till products on every derive pass', () => {
  const body = slice('function repairDates(){', 'function customerProduct(c){');
  assert.match(body, /reclassifyTillProducts\(\)/);
});

test('the Apps Script backend stores and returns the till column', () => {
  assert.match(gasSource, /transactions: \[[^\]]*'product', 'till', 'receipt'/);
  assert.match(gasSource, /customerTx: \[[^\]]*'product', 'till', 'receipt'/);
  assert.match(gasSource, /till: t\.till \|\| ''/);
  assert.match(gasSource, /till: r\.till \|\| ''/);
});

test('the Transactions tab shows and filters by till', () => {
  assert.match(htmlSource, /<th>Product<\/th><th>Till<\/th><th>Source<\/th>/);
  assert.match(htmlSource, /<option value="tillMeat">.*5803756/);
  assert.match(htmlSource, /<option value="tillSoup">.*1213294/);
  assert.match(htmlSource, /<option value="tillUnknown">/);
  const render = slice('function renderTransactions(){', "$('txSearch').oninput=renderTransactions;");
  assert.match(render, /f==='tillMeat'/);
  assert.match(render, /f==='tillSoup'/);
  assert.match(render, /f==='tillUnknown'/);
  assert.match(render, /countTillUnknown\(\)/, 'stats line must nudge a re-import while Sept 6+ rows lack tills');
});

test('the import preview shows the detected till', () => {
  assert.match(htmlSource, /<th>Date<\/th><th>Till<\/th><th>Match<\/th>/);
  const preview = slice('function showPreview(rows, fmt) {', "$('cancelImport').onclick");
  assert.match(preview, /tillBadge/);
});

test('the import tab documents the 6 Sept till rule', () => {
  assert.match(htmlSource, /Till rule \(from 6 Sept 2026\)/);
  assert.match(htmlSource, /5803756.*Meat/);
  assert.match(htmlSource, /1213294.*Soup/);
  assert.match(htmlSource, /Other Party<\/b> column/);
});
