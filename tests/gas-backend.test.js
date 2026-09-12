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
 *
 * v3.2 additions, pinned at the bottom of this file: a slice delivered TWICE
 * must not fail the save it belongs to. A row count can only be compared to a
 * promise, so the check used to treat a repeated slice exactly like a lost one
 * and refuse an otherwise complete save — that was the reported
 * "chunk mismatch on seen: staged 5344 rows, expected 3672". Slices are now
 * recorded per session and a replay is skipped; `seen` (a set of dedup keys,
 * not records) is verified by distinct keys and de-duplicated before the swap,
 * while transactions/customerTx keep the strict count because a duplicate
 * there would double-count revenue.
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
        },
        // Apps Script returns the rectangular block, padded with '' where the
        // sheet has no cell yet.
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
      // Apps Script's waitLock returns a boolean: false means another writer
      // still holds the lock and this execution must NOT proceed.
      getScriptLock: () => ({
        waitLock: () => !lockBusy,
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

/* ── repeated chunk delivery (the "staged 5344 rows, expected 3672" failure) ──
 *
 * A row count can only be compared to a promise, so the check could not tell a
 * LOST slice (dangerous — abort) from a slice delivered TWICE (harmless — the
 * data is all there). Any duplicate delivery — a client retry, a proxy replay,
 * the app open in two tabs — appended its rows a second time and failed an
 * otherwise complete save. The reported case was `seen`, the last table up:
 * 3672 dedup keys chunk as [2000, 1672], the final slice landed twice, and the
 * commit refused at 5344 staged rows.
 */

// The client's exact slicing: CHUNK_ROWS is 2000 in index.html.
const CHUNK_ROWS = 2000;
function sliceRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) out.push(rows.slice(i, i + CHUNK_ROWS));
  return out;
}

test('a repeated `seen` slice no longer fails the commit — the set is de-duplicated', async () => {
  const env = makeEnv();
  // The reported shape: 3672 dedup keys → slices of [2000, 1672].
  const seenRows = [];
  for (let i = 0; i < 3672; i++) seenRows.push({ key: 'receipt|R' + i + '|2026-09-01|', value: 1 });
  const slices = sliceRows(seenRows);
  assert.deepStrictEqual(slices.map((s) => s.length), [2000, 1672], 'fixture must reproduce the reported slicing');

  const begin = await env.post({ action: 'saveBegin', customers: [], monthly: { labels: [], revenue: [] }, settings: {} });
  for (const s of slices) {
    await env.post({ action: 'saveChunk', table: 'seen', rows: s, uploadId: begin.uploadId });
  }
  // The final slice is delivered a second time by a client that predates `seq`
  // (it echoes no seq, so nothing can prove it is a replay).
  const replay = await env.post({ action: 'saveChunk', table: 'seen', rows: slices[1], uploadId: begin.uploadId });
  assert.strictEqual(replay.success, true);

  const commit = await env.post({
    action: 'saveCommit',
    expect: { transactions: 0, customerTx: 0, seen: seenRows.length },
    uploadId: begin.uploadId
  });
  assert.deepStrictEqual(commit, { success: true }, 'a duplicate `seen` slice must not fail the save');

  // What actually landed: one row per key, not 5344 rows.
  assert.strictEqual(env.sheet('Seen').getLastRow(), seenRows.length + 1, 'live Seen must hold one row per key plus the header');
  const loaded = await env.load();
  assert.strictEqual(Object.keys(loaded.seen).length, seenRows.length);
});

test('de-duplication collapses repeated keys only — a keyless row still counts', async () => {
  const env = makeEnv();
  const begin = await env.post({ action: 'saveBegin', customers: [], monthly: { labels: [], revenue: [] }, settings: {} });
  // Two copies of one key (a replayed slice) plus a row with no key at all.
  // Only the repeated key may be collapsed: dropping the keyless row too would
  // change the count for something that is not a duplicate.
  const rows = [{ key: 'a', value: 1 }, { key: '', value: 1 }, { key: 'a', value: 1 }];
  await env.post({ action: 'saveChunk', table: 'seen', rows, uploadId: begin.uploadId });

  const commit = await env.post({
    action: 'saveCommit', expect: { transactions: 0, customerTx: 0, seen: 2 }, uploadId: begin.uploadId
  });
  assert.deepStrictEqual(commit, { success: true });
  assert.strictEqual(env.sheet('Seen').getLastRow(), 3, 'header + the one key + the keyless row');
});

test('a `seen` slice that is genuinely short still aborts the commit', async () => {
  const env = makeEnv();
  const begin = await env.post({ action: 'saveBegin', customers: [], monthly: { labels: [], revenue: [] }, settings: {} });
  // Only 20 of 50 promised keys arrive — de-duplication must not paper over a
  // real loss.
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ key: 'k' + i, value: 1 });
  await env.post({ action: 'saveChunk', table: 'seen', rows, uploadId: begin.uploadId });

  const commit = await env.post({
    action: 'saveCommit', expect: { transactions: 0, customerTx: 0, seen: 50 }, uploadId: begin.uploadId
  });
  assert.strictEqual(commit.success, false);
  assert.match(commit.error, /chunk mismatch on seen: staged 20 rows, expected 50/);
});

test('a slice that repeats with its seq is skipped — a record table is never appended twice', async () => {
  const env = makeEnv();
  const db = dbFixture();
  const begin = await env.post({ action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings });

  const first = await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: begin.uploadId, seq: 0 });
  assert.deepStrictEqual(first, { success: true, written: 5 });

  // The same slice arrives again (retry / proxy replay / second tab).
  const again = await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: begin.uploadId, seq: 0 });
  assert.deepStrictEqual(again, { success: true, written: 0, duplicate: true });
  assert.strictEqual(env.sheet('Transactions_Staging').getLastRow(), 6, 'the replay must not stage a second copy');

  const commit = await env.post({
    action: 'saveCommit', expect: { transactions: 5, customerTx: 0, seen: 0 }, uploadId: begin.uploadId
  });
  assert.deepStrictEqual(commit, { success: true });
  const loaded = await env.load();
  assert.strictEqual(loaded.transactions.length, 5, 'revenue rows must not be doubled by a replayed slice');
});

test('seq numbers are per upload session — a new save starts counting from scratch', async () => {
  const env = makeEnv();
  const db = dbFixture();

  const one = await env.post({ action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings });
  await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: one.uploadId, seq: 0 });

  const two = await env.post({ action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings });
  // seq 0 again, but for the NEW session: it must stage, not be skipped.
  const res = await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: two.uploadId, seq: 0 });
  assert.deepStrictEqual(res, { success: true, written: 5 });

  const commit = await env.post({
    action: 'saveCommit', expect: { transactions: 5, customerTx: 0, seen: 0 }, uploadId: two.uploadId
  });
  assert.deepStrictEqual(commit, { success: true });
});

test('a repeated record-table slice with no seq still refuses — a duplicate would double revenue', async () => {
  const env = makeEnv();
  const db = dbFixture();
  assert.deepStrictEqual(await env.post({ action: 'saveAll', ...db }), { success: true });

  const begin = await env.post({ action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings });
  // A pre-seq client replays a slice: nothing can prove it is a replay, so the
  // strict count must still catch it rather than stage two of every row.
  await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: begin.uploadId });
  await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: begin.uploadId });

  const commit = await env.post({
    action: 'saveCommit', expect: { transactions: 5, customerTx: 0, seen: 0 }, uploadId: begin.uploadId
  });
  assert.strictEqual(commit.success, false);
  assert.match(commit.error, /chunk mismatch on transactions: staged 10 rows, expected 5/);
  assert.strictEqual((await env.load()).transactions.length, 5, 'live data must be untouched');
});

test('a refused commit clears the staging sheets, so the retry starts clean', async () => {
  const env = makeEnv();
  const db = dbFixture();
  const begin = await env.post({ action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings });
  await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: begin.uploadId });
  const refused = await env.post({
    action: 'saveCommit', expect: { transactions: 99, customerTx: 0, seen: 0 }, uploadId: begin.uploadId
  });
  assert.strictEqual(refused.success, false);
  assert.strictEqual(env.sheet('Transactions_Staging').getLastRow(), 1, 'only the header row may be left staged');

  // The retry the message asks for now stages from empty.
  const retry = await env.post({ action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings });
  await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: retry.uploadId });
  assert.deepStrictEqual(
    await env.post({ action: 'saveCommit', expect: { transactions: 5, customerTx: 0, seen: 0 }, uploadId: retry.uploadId }),
    { success: true }
  );
});

test('a commit from a superseded session is refused — it cannot swap another device\'s staged rows', async () => {
  const env = makeEnv();
  const db = dbFixture();
  const first = await env.post({ action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings });
  const second = await env.post({ action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings });
  assert.notStrictEqual(first.uploadId, second.uploadId);

  await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: second.uploadId });
  // The stale device comes back and asks to commit counts for slices that are
  // no longer staged.
  const stale = await env.post({
    action: 'saveCommit', expect: { transactions: 5, customerTx: 0, seen: 0 }, uploadId: first.uploadId
  });
  assert.strictEqual(stale.success, false);
  assert.match(stale.error, /upload superseded/);

  // The current session still commits normally.
  const ok = await env.post({
    action: 'saveCommit', expect: { transactions: 5, customerTx: 0, seen: 0 }, uploadId: second.uploadId
  });
  assert.deepStrictEqual(ok, { success: true });
});

/* ── script lock ───────────────────────────────────────────────────────────── */

test('a save that cannot get the script lock is refused, not run alongside the other writer', async () => {
  const env = makeEnv({ lockBusy: true });
  const db = dbFixture();

  for (const body of [
    { action: 'saveAll', ...db },
    { action: 'saveBegin', customers: db.customers, monthly: db.monthly, settings: db.settings },
    { action: 'saveChunk', table: 'seen', rows: [{ key: 'k', value: 1 }] },
    { action: 'saveCommit', expect: { transactions: 0, customerTx: 0, seen: 0 } }
  ]) {
    const res = await env.post(body);
    assert.strictEqual(res.success, false, body.action + ' must not proceed without the lock');
    assert.match(res.error, /backend busy/, body.action);
  }
  // Nothing was staged or swapped while the lock was held elsewhere.
  assert.strictEqual(env.sheet('Transactions'), null, 'no sheet may be touched without the lock');
});

/* ── the deploy page must not lie about the version ──────────────────────────
 *
 * Merging to GitHub updates the Pages-hosted app but NOT the Apps Script
 * backend — that only changes when Code.gs is pasted and redeployed. code.html
 * is the page you copy from, so a stale version label on it tells you that you
 * have deployed a version you have not. It now reads the version out of the
 * file it is about to put on your clipboard.
 */

test('code.html reads the backend version from the file, not from hard-coded markup', () => {
  const html = fs.readFileSync(path.join(ROOT, 'code.html'), 'utf8');

  // The badge and the note are filled in at load time, not written as a
  // version string in the markup.
  assert.match(html, /<span class="badge" id="verBadge">/);
  assert.match(html, /<b id="verNote">/);
  assert.ok(!/class="badge">v\d+\.\d+/.test(html), 'the badge must not carry a hard-coded version');

  // The regex it parses with, lifted from the page.
  const fn = /function versionOf\(txt\)\{[\s\S]*?\n\}/.exec(html);
  assert.ok(fn, 'versionOf must exist in code.html');
  const versionOf = vm.runInContext('(' + fn[0].replace('function versionOf', 'function') + ')', vm.createContext({}));

  // It must read the real file correctly — including the release before this
  // one, which is what proves it is parsing rather than guessing.
  const current = versionOf(GAS);
  assert.ok(current, 'versionOf must match the header of google-apps-script.gs');
  const header = /backend\s+(v[\d.]+)\s+\(([\d-]+)\)/.exec(GAS);
  assert.strictEqual(current.ver, header[1]);
  assert.strictEqual(current.date, header[2]);

  // …and the version it reports is the incremental-save backend.
  // (v3.4 supersedes the v3.3 till-column release.)
  assert.strictEqual(current.ver, 'v3.4', 'code.html must be offering the fixed backend');
});

/* ── incremental saves (backend v3.4) ───────────────────────────────────────
 * Routine saves append ONLY the transactions added since the last push — the
 * live Transactions sheet is never replaced by a delta (an append cannot
 * truncate), de-duplication is identity-based so a retried/replayed/two-device
 * append cannot double-count, and the small tables still stage-and-swap so
 * contact edits and baseline-cleared state always land exactly. Deletions and
 * renames are not append-shaped: the client takes the full path for those.
 * Old saveAll clients keep working unchanged (the table set is untouched). */

function deltaRow(receipt, extra) {
  return Object.assign({
    date: '2026-09-10', time: '12:00:00', amount: 200, name: 'New Person',
    phone: '254710000000', product: 'Beef', till: '5803756',
    source: 'test', importedAt: '2026-09-10'
  }, extra || {}, receipt ? { receipt } : {});
}

test('saveDelta appends new transactions to the LIVE sheet and empties the derivable caches', async () => {
  const env = makeEnv();
  const db = dbFixture();
  assert.deepStrictEqual(await env.post({ action: 'saveAll', ...db }), { success: true });
  assert.strictEqual((await env.load()).transactions.length, 5);

  const addRows = [deltaRow('NEW0001'), deltaRow('NEW0002')];
  const res = await env.post({
    action: 'saveDelta',
    customers: db.customers,
    monthly: db.monthly,
    settings: db.settings,
    txAdd: addRows
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.added, 2, 'both new rows appended');
  assert.strictEqual(res.skippedDuplicates, 0);
  assert.strictEqual(res.transactions, 7, 'total live rows reported');

  // The append never replaced the sheet: the original five rows keep their
  // place and the two new rows follow them.
  const loaded = await env.load();
  assert.strictEqual(loaded.transactions.length, 7);
  assert.strictEqual(loaded.transactions[0].receipt, 'RCPT0');
  assert.strictEqual(loaded.transactions[5].receipt, 'NEW0001');
  assert.strictEqual(loaded.transactions[6].receipt, 'NEW0002');
  assert.strictEqual(loaded.transactions[6].till, '5803756', 'the appended row keeps its till');

  // The derivable caches are no longer synced — a delta empties them exactly
  // like a full save does.
  assert.strictEqual(Object.keys(loaded.customerTx).length, 0, 'CustomerTx must be header-only after a delta');
  assert.strictEqual(Object.keys(loaded.seen).length, 0, 'Seen must be header-only after a delta');
});

test('saveDelta is idempotent — replaying the same append adds nothing', async () => {
  const env = makeEnv();
  const db = dbFixture();
  await env.post({ action: 'saveAll', ...db });

  const payload = {
    action: 'saveDelta',
    customers: db.customers, monthly: db.monthly, settings: db.settings,
    txAdd: [deltaRow('NEW0003'), deltaRow('NEW0004')]
  };
  const first = await env.post(payload);
  assert.strictEqual(first.added, 2);

  // The response got lost; the client retries the identical POST (what a
  // mobile timeout then retry actually does). Nothing may be double-booked.
  const retry = await env.post(payload);
  assert.strictEqual(retry.success, true);
  assert.strictEqual(retry.added, 0, 'the replay appends nothing');
  assert.strictEqual(retry.skippedDuplicates, 2);
  assert.strictEqual(retry.transactions, 7);
  assert.strictEqual((await env.load()).transactions.length, 7);
});

test('saveDelta de-duplicates a row repeated inside one batch', async () => {
  const env = makeEnv();
  const db = dbFixture();
  await env.post({ action: 'saveAll', ...db });

  const row = deltaRow('NEW0005');
  const res = await env.post({
    action: 'saveDelta',
    customers: db.customers, monthly: db.monthly, settings: db.settings,
    txAdd: [row, { ...row }]
  });
  assert.strictEqual(res.added, 1);
  assert.strictEqual(res.skippedDuplicates, 1);
  assert.strictEqual((await env.load()).transactions.length, 6);
});

test('saveDelta recognises duplicates by the time-less receipt identity after a cloud round-trip', async () => {
  const env = makeEnv();
  const db = dbFixture();
  await env.post({ action: 'saveAll', ...db });
  // First append carries a time (as an import does).
  await env.post({
    action: 'saveDelta',
    customers: db.customers, monthly: db.monthly, settings: db.settings,
    txAdd: [deltaRow('NEW0006', { time: '08:15:00' })]
  });
  // Another device only knows the time-less cloud row; its replay must skip.
  const again = await env.post({
    action: 'saveDelta',
    customers: db.customers, monthly: db.monthly, settings: db.settings,
    txAdd: [deltaRow('NEW0006', { time: '' })]
  });
  assert.strictEqual(again.added, 0, 'receipt + date alone must identify the payment');
  assert.strictEqual((await env.load()).transactions.length, 6);
});

test('saveDelta keeps receipt-less payments apart with the strict composite identity', async () => {
  const env = makeEnv();
  const db = dbFixture();
  await env.post({ action: 'saveAll', ...db });

  // Same day and amount, different customers — both must append.
  const a = deltaRow('', { name: 'Cash Buyer A', phone: '254711111111' });
  const b = deltaRow('', { name: 'Cash Buyer B', phone: '254722222222' });
  const res = await env.post({
    action: 'saveDelta',
    customers: db.customers, monthly: db.monthly, settings: db.settings,
    txAdd: [a, b]
  });
  assert.strictEqual(res.added, 2, 'two genuinely different same-day payments must not collapse');

  // An exact composite repeat (same date/time/amount/name/contact) skips.
  const replay = await env.post({
    action: 'saveDelta',
    customers: db.customers, monthly: db.monthly, settings: db.settings,
    txAdd: [{ ...a }]
  });
  assert.strictEqual(replay.added, 0);
  assert.strictEqual((await env.load()).transactions.length, 7);
});

test('saveDelta with no new rows still swaps the small tables', async () => {
  const env = makeEnv();
  const db = dbFixture();
  await env.post({ action: 'saveAll', ...db });

  // A contact resolution/baseline edit is the only thing this save carries.
  const customers = [{ ...db.customers[0], spent: 999 }];
  const res = await env.post({
    action: 'saveDelta', customers, monthly: db.monthly, settings: db.settings, txAdd: []
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.added, 0);
  const loaded = await env.load();
  assert.strictEqual(loaded.transactions.length, 5, 'an empty delta never touches transactions');
  assert.strictEqual(loaded.customers[0].spent, 999, 'the small-table edit still lands');
});

test('saveDelta without the lock answers busy and appends nothing', async () => {
  const env = makeEnv({ lockBusy: true });
  const res = await env.post({ action: 'saveDelta', customers: [], monthly: { labels: [], revenue: [] }, settings: {}, txAdd: [deltaRow('X')] });
  assert.strictEqual(res.success, false);
  assert.match(res.error, /backend busy/);
  assert.strictEqual(env.sheet('Transactions'), null, 'a busy refusal must not touch any sheet');
});

test('a delta chunked session is advertised, appends transactions, and refuses other tables', async () => {
  const env = makeEnv();
  const db = dbFixture();
  await env.post({ action: 'saveAll', ...db });

  const begin = await env.post({
    action: 'saveBegin', mode: 'delta',
    customers: db.customers, monthly: db.monthly, settings: db.settings
  });
  assert.strictEqual(begin.success, true);
  assert.strictEqual(begin.delta, true, 'the backend must echo delta:true so the client can tell it apart from a pre-v3.4 deploy');

  const addRows = [deltaRow('CHUNK001'), deltaRow('CHUNK002'), deltaRow('CHUNK003')];
  const chunk = await env.post({
    action: 'saveChunk', table: 'transactions', rows: addRows,
    uploadId: begin.uploadId, seq: 0
  });
  assert.strictEqual(chunk.success, true);
  assert.strictEqual(chunk.written, 3);
  // Nothing has been appended yet — a delta only appends at commit.
  assert.strictEqual((await env.load()).transactions.length, 5, 'the live sheet is untouched until the commit');

  // The derivable caches never ride a delta session.
  const refused = await env.post({
    action: 'saveChunk', table: 'customerTx',
    rows: [{ customer: 'Alice', date: '2026-09-10', amount: 1 }],
    uploadId: begin.uploadId, seq: 0
  });
  assert.strictEqual(refused.success, false);
  assert.match(refused.error, /delta uploads append transactions only/);

  const commit = await env.post({
    action: 'saveCommit', mode: 'delta',
    expect: { transactions: 3 }, uploadId: begin.uploadId
  });
  assert.strictEqual(commit.success, true);
  assert.strictEqual(commit.added, 3);
  const loaded = await env.load();
  assert.strictEqual(loaded.transactions.length, 8, 'commit appends to the live sheet, never replaces it');
  assert.strictEqual(loaded.transactions[5].receipt, 'CHUNK001');
  assert.strictEqual(Object.keys(loaded.customerTx).length, 0);
});

test('a full (non-delta) saveBegin does not echo delta and still swaps every table', async () => {
  const env = makeEnv();
  const db = dbFixture();
  const begin = await env.post({
    action: 'saveBegin',
    customers: db.customers, monthly: db.monthly, settings: db.settings
  });
  assert.strictEqual(begin.success, true);
  assert.strictEqual(begin.delta, undefined, 'a pre-delta session must not be flagged delta');
  await env.post({ action: 'saveChunk', table: 'transactions', rows: db.transactions, uploadId: begin.uploadId, seq: 0 });
  // Old clients still stage the derivable tables on a full session.
  await env.post({
    action: 'saveChunk', table: 'customerTx',
    rows: [{ customer: 'Alice', date: '2026-08-31', amount: 500, product: 'Beef', till: '', receipt: 'RCPT0', importedAt: '2026-08-31' }],
    uploadId: begin.uploadId, seq: 0
  });
  const commit = await env.post({
    action: 'saveCommit', expect: { transactions: 5, customerTx: 1, seen: 0 }, uploadId: begin.uploadId
  });
  assert.deepStrictEqual(commit, { success: true });
  const loaded = await env.load();
  assert.strictEqual(loaded.transactions.length, 5);
  assert.strictEqual(loaded.customerTx.Alice.length, 1, 'old-client full saves keep working byte-for-byte');
});

test('a delta commit with a missing slice refuses and leaves the live sheet untouched', async () => {
  const env = makeEnv();
  const db = dbFixture();
  await env.post({ action: 'saveAll', ...db });

  const begin = await env.post({
    action: 'saveBegin', mode: 'delta',
    customers: db.customers, monthly: db.monthly, settings: db.settings
  });
  await env.post({
    action: 'saveChunk', table: 'transactions', rows: [deltaRow('PARTIAL1')],
    uploadId: begin.uploadId, seq: 0
  });
  // Promise four rows, only one staged.
  const commit = await env.post({
    action: 'saveCommit', mode: 'delta',
    expect: { transactions: 4 }, uploadId: begin.uploadId
  });
  assert.strictEqual(commit.success, false);
  assert.match(commit.error, /chunk mismatch on transactions: staged 1 rows, expected 4/);
  const loaded = await env.load();
  assert.strictEqual(loaded.transactions.length, 5, 'a refused delta commit appends nothing');
});

test('delta routing honors the client mode even if the session record were lost (source pin)', () => {
  // A delta commit misrouted to the full path would swap the live sheet for
  // staging that holds only the appended rows. The session record is
  // authoritative, but body.mode must decide too — belt and braces.
  assert.match(GAS, /if \(body\.mode === 'delta' \|\| sessionIsDelta_\(body\.uploadId\)\) return commitDelta_\(body\)/);
  assert.match(GAS, /var chunkIsDelta = body\.mode === 'delta' \|\| sessionIsDelta_\(body\.uploadId\)/);
});

test('a replayed delta slice is skipped and the delta still commits', async () => {
  const env = makeEnv();
  const db = dbFixture();
  await env.post({ action: 'saveAll', ...db });

  const begin = await env.post({
    action: 'saveBegin', mode: 'delta',
    customers: db.customers, monthly: db.monthly, settings: db.settings
  });
  const addRows = [deltaRow('REPLAY1'), deltaRow('REPLAY2')];
  await env.post({ action: 'saveChunk', table: 'transactions', rows: addRows, uploadId: begin.uploadId, seq: 0 });
  const dup = await env.post({ action: 'saveChunk', table: 'transactions', rows: addRows, uploadId: begin.uploadId, seq: 0 });
  assert.strictEqual(dup.duplicate, true);
  assert.strictEqual(dup.written, 0);

  const commit = await env.post({
    action: 'saveCommit', mode: 'delta',
    expect: { transactions: 2 }, uploadId: begin.uploadId
  });
  assert.strictEqual(commit.success, true);
  assert.strictEqual(commit.added, 2, 'the replayed slice is appended once');
  assert.strictEqual((await env.load()).transactions.length, 7);
});
