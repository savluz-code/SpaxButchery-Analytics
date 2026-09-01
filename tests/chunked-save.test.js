/**
 * Chunked cloud save — regression tests.
 *
 * Background: a large statement day pushed ~2.5 MB / ~23k rows in ONE request.
 * That write could not finish inside the request timeout, so the browser
 * aborted it. Because the backend's writeObjects_ calls clearContents() before
 * writing, an aborted save left the sheet TRUNCATED — a day's imports appeared
 * to vanish, and the next cloud load pulled the truncated copy back down.
 *
 * The fix uploads the big tables in slices to staging sheets and only swaps
 * them over the live sheets once every row has arrived (saveCommit verifies
 * the row counts first). These tests pin that behaviour.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GAS = fs.readFileSync(path.join(ROOT, 'google-apps-script.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Minimal in-memory Google Sheet + Apps Script host running the REAL .gs. */
function makeBackend() {
  const sheets = {};
  const mkSheet = (name) => ({
    _n: name,
    _d: [],
    clearContents() { this._d = []; },
    getLastRow() { return this._d.length; },
    setName(n) { delete sheets[this._n]; this._n = n; sheets[n] = this; },
    getRange(r, c, nr, nc) {
      const self = this;
      return { setValues(v) { for (let i = 0; i < v.length; i++) self._d[r - 1 + i] = v[i].slice(); } };
    }
  });
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = mkSheet(n)),
    deleteSheet: (sh) => { delete sheets[sh._n]; }
  };
  const ctx = vm.createContext({
    SpreadsheetApp: { getActive: () => ss, openById: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate: (d) => String(d) },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
    UrlFetchApp: { fetch: () => ({ getContentText: () => '{}' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    console, JSON, String, Number, Object, Array, Math, Date, RegExp, isNaN, parseInt, parseFloat
  });
  vm.runInContext(GAS, ctx);
  vm.runInContext('function getSpreadsheet_(){return SpreadsheetApp.getActive();}', ctx);
  const call = (fn, body) => { ctx.__b = body; return vm.runInContext(fn + '(__b)', ctx); };
  const rows = (name) => Math.max(0, (sheets[name] ? sheets[name]._d.length : 0) - 1);
  return { ctx, sheets, call, rows };
}

function sampleData(nTx) {
  const transactions = [];
  for (let i = 0; i < nTx; i++) {
    transactions.push({ date: '2026-08-31', time: '10:00:00', amount: 100, name: 'C' + i, phone: '2547' + i, receipt: 'R' + i });
  }
  return {
    customers: [{ name: 'C0', contact: '25470', spent: 100, visits: 1 }],
    monthly: { labels: ['2026-08'], revenue: [100] },
    settings: { importedRev: 100 },
    transactions,
    customerTx: { C0: [{ date: '2026-08-31', amount: 100, receipt: 'R0' }] },
    seen: { 'receipt|R0|2026-08-31|': 1 }
  };
}

test('saveCommit refuses to swap when a chunk went missing, leaving live data intact', () => {
  const b = makeBackend();
  const d = sampleData(3000);

  // Establish good live data first.
  b.call('saveAll_', { action: 'saveAll', ...d });
  assert.strictEqual(b.rows('Transactions'), 3000);

  // Begin a chunked save but only deliver part of the transactions.
  b.call('saveBegin_', { customers: d.customers, monthly: d.monthly, settings: d.settings });
  b.call('saveChunk_', { table: 'transactions', rows: d.transactions.slice(0, 1000) });

  const res = b.call('saveCommit_', { expect: { transactions: 3000, customerTx: 1, seen: 1 } });

  assert.strictEqual(res.success, false, 'commit must refuse a short upload');
  assert.match(res.error, /chunk mismatch on transactions/);
  // The critical guarantee: the live sheet was never touched.
  assert.strictEqual(b.rows('Transactions'), 3000, 'live rows must survive a failed chunked save');
});

test('an interrupted chunked upload never touches the live sheets', () => {
  const b = makeBackend();
  const d = sampleData(3000);
  b.call('saveAll_', { action: 'saveAll', ...d });

  b.call('saveBegin_', { customers: d.customers, monthly: d.monthly, settings: d.settings });
  b.call('saveChunk_', { table: 'transactions', rows: d.transactions.slice(0, 1000) });
  // ...connection dies here; no saveCommit is ever sent.

  assert.strictEqual(b.rows('Transactions'), 3000, 'live data intact after an abandoned upload');
  assert.strictEqual(b.rows('Transactions__stg'), 1000, 'partial rows are isolated in staging');
});

test('a complete chunked save commits every row and cleans up staging', () => {
  const b = makeBackend();
  const d = sampleData(5000);

  b.call('saveBegin_', { customers: d.customers, monthly: d.monthly, settings: d.settings });
  for (let i = 0; i < d.transactions.length; i += 2000) {
    b.call('saveChunk_', { table: 'transactions', rows: d.transactions.slice(i, i + 2000) });
  }
  b.call('saveChunk_', { table: 'customerTx', rows: [{ customer: 'C0', date: '2026-08-31', amount: 100, product: '', receipt: 'R0', importedAt: '' }] });
  b.call('saveChunk_', { table: 'seen', rows: [{ key: 'receipt|R0|2026-08-31|', value: 1 }] });

  const res = b.call('saveCommit_', { expect: { transactions: 5000, customerTx: 1, seen: 1 } });

  assert.strictEqual(res.success, true);
  assert.strictEqual(b.rows('Transactions'), 5000);
  assert.strictEqual(b.rows('CustomerTx'), 1);
  assert.strictEqual(b.rows('Seen'), 1);
  assert.strictEqual(b.rows('Customers'), 1, 'small tables are written by saveBegin');
  assert.deepStrictEqual(
    Object.keys(b.sheets).filter((k) => k.includes('__stg')),
    [],
    'staging sheets are renamed away, not left behind'
  );
});

test('the one-shot and chunked paths write identical sheet layouts', () => {
  const d = sampleData(10);

  const a = makeBackend();
  a.call('saveAll_', { action: 'saveAll', ...d });

  const c = makeBackend();
  c.call('saveBegin_', { customers: d.customers, monthly: d.monthly, settings: d.settings });
  c.call('saveChunk_', { table: 'transactions', rows: d.transactions });
  c.call('saveChunk_', { table: 'customerTx', rows: [{ customer: 'C0', date: '2026-08-31', amount: 100, product: '', receipt: 'R0', importedAt: '' }] });
  c.call('saveChunk_', { table: 'seen', rows: [{ key: 'receipt|R0|2026-08-31|', value: 1 }] });
  c.call('saveCommit_', { expect: { transactions: 10, customerTx: 1, seen: 1 } });

  // Compare by value: each backend runs in its own vm realm, so the arrays are
  // structurally identical but not reference-equal across realms.
  assert.strictEqual(
    JSON.stringify(c.sheets['Transactions']._d),
    JSON.stringify(a.sheets['Transactions']._d),
    'chunked upload must produce the same headers and rows as a one-shot save'
  );
});

test('client keeps a 60s request timeout and chunks above CHUNK_ROWS', () => {
  assert.match(HTML, /controller\.abort\(\), 60000/, 'cloudRequest should time out at 60s');
  assert.match(HTML, /const CHUNK_ROWS = 2000;/, 'chunk size constant should be defined');
  assert.match(HTML, /if \(totalBigRows <= CHUNK_ROWS\)/, 'small payloads should still use a single request');
  assert.match(HTML, /action: 'saveCommit'/, 'client should commit after uploading chunks');
});

test('loadFromCloud unions rows without forcing a push-back', () => {
  const fn = HTML.slice(HTML.indexOf('async function loadFromCloud'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /UNION MERGE, NEVER REPLACE/, 'union merge must stay in place');
  const live = body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/saveToCloud\(/.test(live), 'load must not trigger a forced save (that wedged syncing)');
});

