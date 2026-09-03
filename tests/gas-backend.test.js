/**
 * Google Apps Script backend v3.0 — regression tests.
 *
 * The chronic "cloud sync failed" was rooted here: the client has sliced
 * large saves into saveBegin → saveChunk×N → saveCommit since PR #41, but the
 * backend only understood saveAll — so a big import day still went up as ONE
 * ~2.5 MB request that weak mobile signal regularly aborted, and
 * writeObjects_'s clear-then-write could leave a live sheet truncated
 * mid-write. v3.0 completes the protocol.
 *
 * These tests execute the REAL google-apps-script.gs in a vm against an
 * in-memory Spreadsheet/LockService/CacheService mock and pin:
 *
 *   1. saveAll → load round-trips (the pre-v3.0 contract still holds).
 *   2. saveAll is atomic: a save that dies mid-write leaves live data at its
 *      previous, complete state — never truncated.
 *   3. The chunked protocol: begin mints an uploadId, chunks append, commit
 *      verifies counts and only then swaps the live sheets.
 *   4. A short count aborts the commit and leaves live data untouched.
 *   5. A second device's saveBegin supersedes the first's uploadId — stale
 *      chunks are rejected; legacy clients without an uploadId still work.
 *   6. Recovery when an execution died mid-swap (live sheet left renamed).
 *   7. Unknown actions still answer "unknown action" (the client's probe).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GAS = fs.readFileSync(path.join(ROOT, 'google-apps-script.gs'), 'utf8');

/* ── an in-memory Apps Script environment ───────────────────────────────── */

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

function makeEnv() {
  const sheets = new Map();
  const props = {};
  const cache = {};

  const spreadsheet = {
    getId: () => 'SSID-1',
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
      openById: (id) => (id === 'SSID-1' ? spreadsheet : null),
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
      getScriptLock: () => ({
        waitLock: () => {},
        releaseLock: () => {},
        hasLock: () => true
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
      getUuid: () => 'uuid-' + (++makeEnv.uuidNo),
      formatDate: (d) => new Date(d).toISOString().slice(0, 10)
    },
    ContentService: {
      createTextOutput: (text) => ({
        text,
        setMimeType() { return this; }
      }),
      MimeType: { JSON: 'JSON' }
    },
    UrlFetchApp: { fetch: () => { throw new Error('UrlFetchApp not expected in these tests'); } }
  };
  makeEnv.uuidNo = (makeEnv.uuidNo || 0);

  const ctx = vm.createContext(sandbox);
  vm.runInContext(GAS, ctx);
  return {
    ctx,
    sheets,
    cache,
    // Drive the web-app entrypoints exactly as Apps Script would.
    async post(body) {
      const out = await vm.runInContext(
        'doPost({ postData: { contents: ' + JSON.stringify(JSON.stringify(body)) + ' } })',
        ctx
      );
      return JSON.parse(out.text);
    },
    async load() {
      const out = await vm.runInContext('doGet({ parameter: { action: "load" } })', ctx);
      return JSON.parse(out.text);
    },
    sheet: (name) => sheets.get(name) || null
  };
}

/* ── fixtures ────────────────────────────────────────────────────────────── */

function dbFixture() {
  const transactions = [];
  for (let i = 0; i < 5; i++) {
    transactions.push({
      date: '2026-08-31', time: '09:0' + i, amount: 100 + i, name: 'C' + i,
      phone: '25470' + i, product: 'Beef', receipt: 'RCPT' + i,
      source: 'test', importedAt: '2026-08-31', backfillOnly: false
    });
  }
  return {
    customers: [
      { name: 'Alice', contact: '254700000001', spent: 500, visits: 3, days: 12, firstVisit: '2026-06-01', lastVisit: '2026-08-31', masked: false, isNew: true, isSeed: false, seedSpent: 0, seedVisits: 0, newBatch: 2 }
    ],
    monthly: { labels: ['2026-08'], revenue: [1500] },
    settings: { importedRev: 1500, importedTx: 5, resolved: 1, importBatch: 2 },
    transactions,
    customerTx: { Alice: [{ date: '2026-08-31', amount: 500, product: 'Beef', receipt: 'RCPT0', importedAt: '2026-08-31' }] },
    seen: { 'receipt|RCPT0|2026-08-31|09:00': 1 }
  };
}

/* ── saveAll contract (pre-v3.0 behaviour must keep working) ─────────────── */

test('saveAll → load round-trips every table', async () => {
  const env = makeEnv();
  const db = dbFixture();
  const saved = await env.post({ action: 'saveAll', ...db });
  assert.deepStrictEqual(saved, { success: true });

  const loaded = await env.load();
  assert.strictEqual(loaded.success, true);
  assert.strictEqual(loaded.customers.length, 1);
  const c = loaded.customers[0];
  assert.strictEqual(c.name, 'Alice');
  assert.strictEqual(c.spent, 500);
  assert.strictEqual(c.visits, 3);
  assert.strictEqual(c.masked, false);   // 'true'/'false' strings revived
  assert.strictEqual(c.isNew, true);
  assert.strictEqual(c.newBatch, 2);
  assert.deepStrictEqual(loaded.monthly, { labels: ['2026-08'], revenue: [1500] });
  // Sheets round-trip numbers as numbers (only booleans become 'true'/'false'
  // strings); the client Number()s these settings when it consumes them.
  assert.strictEqual(loaded.settings.importedRev, 1500);
  assert.strictEqual(loaded.settings.importBatch, 2);
  assert.strictEqual(loaded.transactions.length, 5);
  assert.strictEqual(loaded.transactions[0].receipt, 'RCPT0');
  assert.strictEqual(loaded.transactions[0].amount, 100);
  assert.strictEqual(loaded.customerTx.Alice.length, 1);
  assert.strictEqual(loaded.customerTx.Alice[0].receipt, 'RCPT0');
  assert.deepStrictEqual(loaded.seen, { 'receipt|RCPT0|2026-08-31|09:00': 1 });
});

test('saveAll is atomic — a save that dies mid-write leaves live data complete', async () => {
  const env = makeEnv();
  const db = dbFixture();
  assert.deepStrictEqual(await env.post({ action: 'saveAll', ...db }), { success: true });

  // Break the NEXT save mid-write: the staging write for Transactions throws
  // (simulates an execution killed by the 6-minute limit or a backend error).
  const staging = env.sheet('Transactions_Staging');
  assert.ok(staging, 'saveAll must have created staging sheets');
  staging.getRange = () => { throw new Error('simulated write failure'); };

  const bigger = dbFixture();
  bigger.transactions.push({ ...bigger.transactions[0], receipt: 'RCPT9' });
  const failed = await env.post({ action: 'saveAll', ...bigger });
  assert.strictEqual(failed.success, false);
  assert.match(failed.error, /simulated write failure/);

  // Live data is exactly the first save — NOT truncated, NOT half-swapped.
  const loaded = await env.load();
  assert.strictEqual(loaded.transactions.length, 5, 'live Transactions must be untouched');
  assert.strictEqual(loaded.transactions.every((t) => t.receipt !== 'RCPT9'), true);
  assert.strictEqual(loaded.customers.length, 1);
});

/* ── chunked protocol ────────────────────────────────────────────────────── */

test('saveBegin → saveChunk×N → saveCommit lands every table and mints an uploadId', async () => {
  const env = makeEnv();
  const db = dbFixture();

  const begin = await env.post({
    action: 'saveBegin',
    customers: db.customers,
    monthly: db.monthly,
    settings: db.settings
  });
  assert.strictEqual(begin.success, true);
  assert.ok(begin.uploadId, 'v3.0 must mint an uploadId');

  for (const [table, rows] of [
    ['transactions', db.transactions.map((t) => ({ ...t, backfillOnly: t.backfillOnly === undefined ? '' : String(t.backfillOnly) }))],
    ['customerTx', [{ customer: 'Alice', date: '2026-08-31', amount: 500, product: 'Beef', receipt: 'RCPT0', importedAt: '2026-08-31' }]],
    ['seen', [{ key: 'receipt|RCPT0|2026-08-31|09:00', value: 1 }]]
  ]) {
    const res = await env.post({ action: 'saveChunk', table, rows, uploadId: begin.uploadId });
    assert.deepStrictEqual(res, { success: true, written: rows.length }, table);
  }

  const commit = await env.post({
    action: 'saveCommit',
    expect: { transactions: 5, customerTx: 1, seen: 1 },
    uploadId: begin.uploadId
  });
  assert.deepStrictEqual(commit, { success: true });

  const loaded = await env.load();
  assert.strictEqual(loaded.transactions.length, 5);
  assert.strictEqual(loaded.customers[0].name, 'Alice');
  assert.strictEqual(loaded.customerTx.Alice.length, 1);
  assert.deepStrictEqual(loaded.seen, { 'receipt|RCPT0|2026-08-31|09:00': 1 });

  // After a swap the staging sheets are empty, ready for the next session.
  assert.strictEqual(env.sheet('Transactions_Staging').getLastRow(), 0);
});

test('a short count aborts the commit — live data stays untouched', async () => {
  const env = makeEnv();
  const db = dbFixture();
  assert.deepStrictEqual(await env.post({ action: 'saveAll', ...db }), { success: true });

  const begin = await env.post({
    action: 'saveBegin',
    customers: db.customers,
    monthly: db.monthly,
    settings: db.settings
  });
  // Only ONE of the five promised transaction slices makes it up.
  await env.post({ action: 'saveChunk', table: 'transactions', rows: [db.transactions[0]], uploadId: begin.uploadId });

  const commit = await env.post({
    action: 'saveCommit',
    expect: { transactions: 5, customerTx: 0, seen: 0 },
    uploadId: begin.uploadId
  });
  assert.strictEqual(commit.success, false);
  assert.match(commit.error, /chunk mismatch on transactions: staged 1 rows, expected 5/);
  assert.match(commit.error, /live data left untouched/);

  const loaded = await env.load();
  assert.strictEqual(loaded.transactions.length, 5, 'live data must be untouched after a refused commit');
});

test('a newer saveBegin supersedes the previous uploadId; legacy chunks without one still pass', async () => {
  const env = makeEnv();
  const db = dbFixture();

  const first = await env.post({
    action: 'saveBegin',
    customers: db.customers, monthly: db.monthly, settings: db.settings
  });
  const second = await env.post({
    action: 'saveBegin',
    customers: db.customers, monthly: db.monthly, settings: db.settings
  });
  assert.notStrictEqual(first.uploadId, second.uploadId);

  // A stale slice from the superseded upload must be rejected.
  const stale = await env.post({ action: 'saveChunk', table: 'seen', rows: [{ key: 'x', value: 1 }], uploadId: first.uploadId });
  assert.strictEqual(stale.success, false);
  assert.match(stale.error, /upload superseded/);

  // The current upload proceeds…
  await env.post({ action: 'saveChunk', table: 'seen', rows: [{ key: 'x', value: 1 }], uploadId: second.uploadId });
  // …and so does a legacy client that never saw the uploadId field.
  const legacy = await env.post({ action: 'saveChunk', table: 'seen', rows: [{ key: 'y', value: 1 }] });
  assert.strictEqual(legacy.success, true);
});

test('unknown actions still answer "unknown action" (the client probe contract)', async () => {
  const env = makeEnv();
  const res = await env.post({ action: 'saveBegin' }); // no body fields, but the action IS known now
  assert.strictEqual(res.success, true);
  const bogus = await env.post({ action: 'definitelyNotAThing' });
  assert.deepStrictEqual(bogus, { success: false, error: 'unknown action' });
});

/* ── mid-swap crash recovery ─────────────────────────────────────────────── */

test('ensureSheets_ recovers a live sheet left renamed by a commit that died mid-swap', async () => {
  const env = makeEnv();
  const db = dbFixture();
  assert.deepStrictEqual(await env.post({ action: 'saveAll', ...db }), { success: true });

  // Stage newer, count-verified data via the chunked protocol…
  const begin = await env.post({
    action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings
  });
  const newer = db.transactions.map((t) => ({ ...t, receipt: t.receipt + 'X' }));
  await env.post({ action: 'saveChunk', table: 'transactions', rows: newer, uploadId: begin.uploadId });
  // …then simulate the crash INSIDE the swap: the live sheet got renamed to
  // SwapTmp but the staging sheet never took its name.
  env.sheet('Transactions').setName('Transactions_SwapTmp');

  // The next load recovers: the staging copy (newest verified data) is
  // promoted to the live name.
  const loaded = await env.load();
  assert.strictEqual(loaded.success, true);
  assert.strictEqual(loaded.transactions.length, 5);
  assert.ok(loaded.transactions.every((t) => t.receipt.endsWith('X')), 'staged (newer) data must win the recovery');
  assert.ok(env.sheet('Transactions'), 'live sheet must exist again');
});
