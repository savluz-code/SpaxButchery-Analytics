/**
 * Backend v3.9 — user lock + server-side timing echo.
 *
 * v3.9 moves the save lock from the script lock to the user lock (identical
 * serialisation for an Execute-as-Me web app — every execution runs as the
 * owner — but a fresh lock object for deployments whose script lock answers
 * "backend busy" with no writer behind it), and makes every save answer echo
 * its server-side timings (`srv`: {wait, work} in ms; busy answers carry
 * {wait}). action=status additionally reports the lock itself (`lock`:
 * {free, ms}) without taking it.
 *
 * These tests execute the REAL google-apps-script.gs in a vm against an
 * in-memory Spreadsheet/LockService/CacheService mock and pin:
 *
 *   1. Every save action takes the USER lock — touching the script lock
 *      throws in the mock, so any missed call site fails loudly.
 *   2. Busy refusals keep the EXACT error string the client matches on, and
 *      carry srv.wait (a ~30s wait met a real writer; ~0s failed instantly).
 *   3. Successful saves echo srv {wait, work} as finite numbers.
 *   4. status answers even while the lock is held, and reports lock.free
 *      truthfully in both states.
 *   5. The client keeps srv on thrown failures, notes every timing, and
 *      names the server-side wait on busy pills + Sync details (source pins
 *      on the sync slice — the full client harness lives in
 *      tests/chunked-save.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GAS = fs.readFileSync(path.join(ROOT, 'google-apps-script.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ── an in-memory Apps Script environment (mirrors gas-backend.test.js) ──── */

function makeSheet(name, sheets) {
  const sheet = {
    rows: [],
    getName() { return name; },
    setName(next) {
      sheets.delete(name);
      name = next;
      sheets.set(name, sheet);
    },
    clearContents() { sheet.rows = []; },
    getLastRow() {
      for (let i = sheet.rows.length - 1; i >= 0; i--) {
        if (sheet.rows[i] && sheet.rows[i].some((c) => c !== '' && c !== null && c !== undefined)) return i + 1;
      }
      return 0;
    },
    getLastColumn() {
      let n = 0;
      sheet.rows.forEach((r) => { if (r) n = Math.max(n, r.length); });
      return n;
    },
    getRange(row, col, numRows, numCols) {
      return {
        setValues(data) {
          assert.strictEqual(data.length, numRows, 'setValues row count mismatch');
          assert.strictEqual(data[0].length, numCols, 'setValues col count mismatch');
          while (sheet.rows.length < row + numRows - 1) sheet.rows.push([]);
          for (let i = 0; i < numRows; i++) {
            const target = sheet.rows[row - 1 + i] || (sheet.rows[row - 1 + i] = []);
            for (let j = 0; j < numCols; j++) target[col - 1 + j] = data[i][j];
          }
        },
        getValues() {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const r = sheet.rows[row - 1 + i] || [];
            out.push(Array.from({ length: numCols }, (_, j) => (
              r[col - 1 + j] === undefined || r[col - 1 + j] === null ? '' : r[col - 1 + j]
            )));
          }
          return out;
        }
      };
    },
    getDataRange() {
      const lastRow = sheet.getLastRow();
      let lastCol = 0;
      sheet.rows.forEach((r) => { if (r) lastCol = Math.max(lastCol, r.length); });
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < lastRow; i++) {
            const r = sheet.rows[i] || [];
            out.push(Array.from({ length: lastCol }, (_, j) => (r[j] === undefined ? '' : r[j])));
          }
          return out;
        }
      };
    }
  };
  return sheet;
}

function makeEnv({ lockBusy = false } = {}) {
  const sheets = new Map();
  const props = {};
  const cache = {};
  let scriptLockTouched = false;

  const spreadsheet = {
    getId: () => 'SSID-9',
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => {
      const s = makeSheet(n, sheets);
      sheets.set(n, s);
      return s;
    }
  };

  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => null,
      openById: (id) => (id === 'SSID-9' ? spreadsheet : null),
      create: () => spreadsheet
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; }
      })
    },
    LockService: {
      // v3.9 must never touch this: any call throws and fails the test.
      getScriptLock: () => { scriptLockTouched = true; throw new Error('v3.9 must never take the script lock'); },
      getUserLock: () => ({
        waitLock: () => !lockBusy,
        tryLock: () => !lockBusy,
        releaseLock: () => {},
        hasLock: () => !lockBusy
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        put: (k, v) => { cache[k] = String(v); },
        remove: (k) => { delete cache[k]; }
      })
    },
    Utilities: {
      getUuid: () => 'uuid-v39-' + Math.floor(Math.random() * 1e9),
      formatDate: (d) => new Date(d).toISOString().slice(0, 10)
    },
    ContentService: {
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
      MimeType: { JSON: 'JSON' }
    },
    UrlFetchApp: { fetch: () => { throw new Error('UrlFetchApp not expected in these tests'); } }
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(GAS, ctx);
  return {
    ctx,
    scriptLockTouched: () => scriptLockTouched,
    async post(body) {
      const out = await vm.runInContext(
        'doPost({ postData: { contents: ' + JSON.stringify(JSON.stringify(body)) + ' } })',
        ctx
      );
      return JSON.parse(out.text);
    }
  };
}

function dbFixture() {
  return {
    customers: [
      { name: 'Alice', contact: '254700000001', spent: 500, visits: 3, days: 12, firstVisit: '2026-06-01', lastVisit: '2026-08-31', masked: false, isNew: true, isSeed: false, seedSpent: 0, seedVisits: 0, newBatch: 2 }
    ],
    monthly: { labels: ['2026-08'], revenue: [1500] },
    settings: { importedRev: 1500, importedTx: 5, resolved: 1, importBatch: 2 },
    transactions: [
      { date: '2026-08-31', time: '09:00', amount: 100, name: 'Alice', phone: '254700000001', product: 'Beef', receipt: 'RCPT0', source: 'test', importedAt: '2026-08-31', backfillOnly: false },
      { date: '2026-08-31', time: '09:01', amount: 101, name: 'Alice', phone: '254700000001', product: 'Soup', receipt: 'RCPT1', source: 'test', importedAt: '2026-08-31', backfillOnly: false }
    ]
  };
}

const BUSY_STRING = 'backend busy with another save — please retry the save';

/* ── 1. every save action takes the user lock ────────────────────────────── */

test('v3.9: all six save actions run on the user lock; the script lock is never touched', async () => {
  const env = makeEnv();
  const db = dbFixture();

  assert.strictEqual((await env.post({ action: 'saveAll', ...db })).success, true);
  assert.strictEqual((await env.post({ action: 'saveDelta', customers: db.customers, monthly: db.monthly, settings: db.settings, txAdd: db.transactions })).success, true);
  assert.strictEqual((await env.post({
    action: 'updateCustomer',
    edits: [{ oldName: 'Alice', oldContact: '254700000001', newName: 'Alice', newContact: '254700000002', customer: { ...db.customers[0], contact: '254700000002' } }]
  })).success, true);
  const begin = await env.post({ action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings });
  assert.strictEqual(begin.success, true);
  assert.strictEqual((await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: begin.uploadId, seq: 0 })).success, true);
  assert.strictEqual((await env.post({ action: 'saveCommit', expect: { transactions: 2, customerTx: 0, seen: 0 }, uploadId: begin.uploadId })).success, true);
  assert.strictEqual((await env.post({ action: 'status' })).success, true);

  assert.strictEqual(env.scriptLockTouched(), false, 'no save path may touch getScriptLock');
});

/* ── 2. busy refusals: exact string + srv.wait ───────────────────────────── */

test('v3.9: a refused save keeps the exact busy string and carries srv.wait', async () => {
  const env = makeEnv({ lockBusy: true });
  const db = dbFixture();

  for (const body of [
    { action: 'saveAll', ...db },
    { action: 'saveDelta', customers: db.customers, monthly: db.monthly, settings: db.settings, txAdd: db.transactions },
    { action: 'updateCustomer', edits: [{ oldName: 'Alice', oldContact: '', newName: 'Alice', newContact: '1', customer: { ...db.customers[0] } }] },
    { action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings },
    { action: 'saveChunk', table: 'transactions', rows: db.transactions },
    { action: 'saveCommit', expect: { transactions: 0, customerTx: 0, seen: 0 } }
  ]) {
    const res = await env.post(body);
    assert.strictEqual(res.success, false, body.action + ' must not proceed without the lock');
    assert.strictEqual(res.error, BUSY_STRING, body.action + ': busy string is the client contract');
    assert.ok(res.srv && typeof res.srv.wait === 'number', body.action + ': busy answers carry srv.wait');
  }
});

/* ── 3. successes echo srv {wait, work} ──────────────────────────────────── */

test('v3.9: successful saves echo srv {wait, work} as finite numbers', async () => {
  const env = makeEnv();
  const db = dbFixture();

  const check = (res, what) => {
    assert.strictEqual(res.success, true, what);
    assert.ok(res.srv, what + ': answers echo srv');
    assert.ok(Number.isFinite(res.srv.wait), what + ': srv.wait is a number');
    assert.ok(Number.isFinite(res.srv.work), what + ': srv.work is a number');
  };

  check(await env.post({ action: 'saveAll', ...db }), 'saveAll');
  check(await env.post({ action: 'saveDelta', customers: db.customers, monthly: db.monthly, settings: db.settings, txAdd: db.transactions }), 'saveDelta');
  check(await env.post({
    action: 'updateCustomer',
    edits: [{ oldName: 'Alice', oldContact: '254700000001', newName: 'Alice', newContact: '254700000002', customer: { ...db.customers[0], contact: '254700000002' } }]
  }), 'updateCustomer');
  const begin = await env.post({ action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings });
  check(begin, 'saveBegin');
  check(await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: begin.uploadId, seq: 0 }), 'saveChunk');
  check(await env.post({ action: 'saveCommit', expect: { transactions: 2, customerTx: 0, seen: 0 }, uploadId: begin.uploadId }), 'saveCommit');
});

/* ── 4. status reports the lock without taking it ────────────────────────── */

test('v3.9: status answers even while the lock is held, and reports lock.free truthfully', async () => {
  const free = makeEnv();
  const st = await free.post({ action: 'status' });
  assert.strictEqual(st.success, true);
  assert.strictEqual(st.version, '3.10');
  assert.ok(st.lock && st.lock.free === true, 'free lock reports free:true');
  assert.ok(typeof st.lock.ms === 'number', 'probe reports its own duration');

  const held = makeEnv({ lockBusy: true });
  const stBusy = await held.post({ action: 'status' });
  assert.strictEqual(stBusy.success, true, 'status must answer even with the lock held');
  assert.ok(stBusy.lock && stBusy.lock.free === false, 'held lock reports free:false');
});

/* ── 5. client wiring (source pins on the sync slice) ────────────────────── */

function syncSlice() {
  const start = HTML.indexOf('const GAS_URL');
  const end = HTML.indexOf('function showSyncStatus');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return HTML.slice(start, end);
}

test('v3.9 client: cloudRequest keeps srv on thrown failures and notes every timing', () => {
  const slice = syncSlice();
  assert.ok(slice.includes('failure.spaxSrv = data.srv'), 'thrown failures carry spaxSrv');
  assert.ok(slice.includes('spaxNoteServerTiming(data.srv, false)'), 'refusals are noted');
  assert.ok(slice.includes('spaxNoteServerTiming(data.srv, true)'), 'successes are noted');
  assert.ok(slice.includes('function spaxNoteServerTiming(srv, ok)'), 'noting helper exists');
});

test('v3.9 client: busy pills name the server-side lock wait', () => {
  const slice = syncSlice();
  assert.ok(slice.includes('function spaxServerWaitNote()'), 'wait-note helper exists');
  assert.ok(slice.includes("' — ' + busyWhy + spaxServerWaitNote() +"), 'retry pill names the server wait');
  assert.ok(slice.includes('cloudSaveBusyReason()) + spaxServerWaitNote() +'), 'final busy message names the server wait');
});

test('v3.9 client: Sync details surfaces server timing and lock state', () => {
  assert.ok(HTML.includes('function spaxServerTimingLineHtml()'), 'timing line renderer exists');
  assert.ok(HTML.includes('<b>Server timing:</b> ${spaxServerTimingLineHtml()}'), 'timing line is in Sync details');
  const lockRefs = (HTML.match(/cloudBackendLock/g) || []).length;
  assert.ok(lockRefs >= 3, 'lock probe is stored and rendered (found ' + lockRefs + ' refs)');
  assert.ok(syncSlice().includes('data.lock.free'), 'status lock probe is noted with the version');
});
