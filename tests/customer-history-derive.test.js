'use strict';

// The per-customer history table (DB.customerTx) stopped being synced — it is
// a PROJECTION of DB.transactions (the same change of contract that made the
// `seen` dedup map local). rebuildCustomerHistory() re-derives it on every
// load. These tests pin the projection itself:
//
//   1. Every non-merchant transaction is attached to the customer the import
//      matcher would have chosen (phone → masked → name), or filed under its
//      statement name when no record exists yet.
//   2. Duplicate receipts collapse (same receipt ≥ 8 chars + date + amount),
//      while two genuinely different receipt-less payments that share a day
//      and amount stay distinct (a multiset, not a set).
//   3. HISTORY-ONLY rows — per-customer rows whose global transaction was
//      shed by the localStorage quota compaction (backfillOnly globals are
//      dropped while the per-customer copy is kept) — survive, so the compaction
//      can never shrink a customer's ledger. Stale rows whose payment still
//      exists globally are always re-derived (a rename re-homes them).
//
// Wiring pins (rebuild on load / force pull / smart merge, never uploaded,
// destructive edits force a full cloud replace) live at the bottom.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function rebuildBlock() {
  const start = htmlSource.indexOf('function rebuildCustomerHistory()');
  const end = htmlSource.indexOf('/* ══════════ NEW-CUSTOMER FLAG', start);
  assert.notEqual(start, -1, 'rebuildCustomerHistory not found in index.html');
  assert.notEqual(end, -1, 'end marker after rebuildCustomerHistory not found');
  return htmlSource.slice(start, end);
}

// Minimal but faithful versions of the helpers the projection shares with
// the import matcher. The projection must give the same answers as an import,
// so these intentionally mirror index.html's real normalisers in the ways the
// matching decisions depend on.
function makeContext(DB) {
  const src = `
    var DB = ${JSON.stringify({ customers: [], transactions: [], customerTx: {} })};
    function stripTime(d){ return String(d == null ? '' : d).replace(/T.*$/,'').split(' ')[0]; }
    function normalizeName(n){
      return String(n == null ? '' : n).toLowerCase().replace(/[^a-z0-9\\s']/g, ' ').replace(/\\s+/g, ' ').trim();
    }
    function normalizeContact(c){
      c = String(c == null ? '' : c).trim();
      if(!c || /missing/i.test(c)) return '';
      c = c.replace(/\\s+/g, '');
      if(c.indexOf('***') >= 0){
        if(c.indexOf('254') === 0) c = '0' + c.substring(3);
        return c;
      }
      c = c.replace(/[^\\d+]/g, '');
      if(c.indexOf('+254') === 0) return '0' + c.substring(4);
      if(c.indexOf('254') === 0) return '0' + c.substring(3);
      return c;
    }
    function isValidKenyanContact(c){ return /^0\\d{9}$/.test(String(c || '')); }
    // Exhaustive indexes cover these fixtures; the fuzzy fallback never wins.
    function findCustomerMatch(){ return null; }
    function isMerchant(name){ return /simon\\s+musyoka/i.test(String(name || '')); }
    ${rebuildBlock()}
  `;
  const ctx = vm.createContext({ console });
  vm.runInContext(src, ctx);
  ctx.DB = DB;
  return ctx;
}

// Objects constructed inside the vm carry a different Object.prototype;
// strict deepEqual refuses them as reference-unequal. Round-trip to plain
// realm-local objects before structural assertions.
const plain = (v) => JSON.parse(JSON.stringify(v));

function tx(over) {
  return Object.assign({
    date: '2026-09-01', time: '10:00:00', amount: 100,
    name: 'Statement Name', phone: '', product: 'Beef', till: '5803756',
    receipt: '', importedAt: '2026-09-02'
  }, over || {});
}

test('history is projected onto matched customers by phone, masked number and name', () => {
  const DB = {
    customers: [
      { name: 'Alice Achieng', contact: '0722000001' },
      { name: 'Brian O.', contact: '0733***222', masked: true },
      { name: 'Carol Wanjiku', contact: '' }
    ],
    transactions: [
      tx({ name: 'ALICE ACHIENG', phone: '254722000001', receipt: 'R1001', amount: 450 }),
      tx({ name: 'Carol Wanjiku', receipt: 'R1002', amount: 120 }),                 // exact-name owner
      tx({ name: 'brian o.', phone: '0733***222', receipt: 'R1003', amount: 80 }), // masked owner
      // Unmatched backfill row whose statement name never had a bucket —
      // backfillTransactions historically wrote these to transactions only.
      tx({ name: 'Stranger Name', phone: '0755000009', receipt: 'R1004', amount: 60 })
    ],
    customerTx: {}
  };
  const ctx = makeContext(DB);
  assert.equal(ctx.rebuildCustomerHistory(), true);

  assert.equal(DB.customerTx['Alice Achieng'].length, 1);
  assert.equal(DB.customerTx['Alice Achieng'][0].receipt, 'R1001');
  assert.equal(DB.customerTx['Carol Wanjiku'].length, 1);
  assert.equal(DB.customerTx['Brian O.'].length, 1);
  assert.equal(DB.customerTx['Stranger Name'], undefined, 'an unmatched name with no prior bucket never gains one');
});

test('an unmatched transaction keeps an already-existing statement-name bucket (cloud/history-only names)', () => {
  const DB = {
    customers: [],
    transactions: [
      // A cloud-sourced history bucket name with no local customer record.
      tx({ name: 'Cloud Only Name', receipt: 'R1101', amount: 60 })
    ],
    customerTx: {
      'Cloud Only Name': [
        { date: '2026-09-01', amount: 60, product: 'Beef', till: '', receipt: 'R1101', importedAt: '' },
        { date: '2026-08-01', amount: 90, product: 'Beef', till: '', receipt: 'R11GONE001', importedAt: '' }
      ]
    }
  };
  const ctx = makeContext(DB);
  ctx.rebuildCustomerHistory();
  const rows = plain(DB.customerTx['Cloud Only Name']);
  assert.ok(rows, 'the pre-existing statement-name bucket survives');
  assert.deepEqual(rows.map((r) => r.receipt).sort(), ['R1101', 'R11GONE001']);
});

test('the projected row carries date/amount/product/till/receipt/importedAt', () => {
  const DB = {
    customers: [{ name: 'Alice', contact: '0722000001' }],
    transactions: [tx({ name: 'Alice', phone: '0722000001', receipt: 'R2001001', product: 'Soup', till: '1213294' })],
    customerTx: {}
  };
  const ctx = makeContext(DB);
  ctx.rebuildCustomerHistory();
  assert.deepEqual(plain(DB.customerTx.Alice[0]), {
    date: '2026-09-01', amount: 100, product: 'Soup',
    till: '1213294', receipt: 'R2001001', importedAt: '2026-09-02'
  });
});

test('duplicate receipts collapse but receipt-less same-day/same-amount payments stay distinct', () => {
  const DB = {
    customers: [{ name: 'Alice', contact: '0722000001' }],
    transactions: [
      tx({ name: 'Alice', phone: '0722000001', receipt: 'R3001001', amount: 50 }),
      tx({ name: 'Alice', phone: '0722000001', receipt: 'R3001001', amount: 50, time: '11:00:00' }), // same payment, re-imported
      tx({ name: 'Alice', phone: '0722000001', amount: 70, time: '12:00:00' }),
      tx({ name: 'Alice', phone: '0722000001', amount: 70, time: '13:30:00' })  // genuinely different payment
    ],
    customerTx: {}
  };
  const ctx = makeContext(DB);
  ctx.rebuildCustomerHistory();
  assert.equal(DB.customerTx.Alice.length, 3, 'one receipt pair + both receipt-less payments');
});

test('merchant rows are never projected into history', () => {
  const DB = {
    customers: [{ name: 'Real Customer', contact: '0722000001' }],
    transactions: [
      tx({ name: 'Simon Musyoka', details: 'the Merchant', receipt: 'R4001', amount: 9999 }),
      tx({ name: 'Real Customer', phone: '0722000001', receipt: 'R4002', amount: 200 })
    ],
    customerTx: {}
  };
  const ctx = makeContext(DB);
  ctx.rebuildCustomerHistory();
  assert.equal(DB.customerTx['Simon Musyoka'], undefined);
  assert.equal(DB.customerTx['Real Customer'].length, 1);
});

test('history-only rows (globals shed by quota compaction) are preserved', () => {
  // The storage-quota fallback drops backfillOnly global transactions while
  // keeping their per-customer history rows. After compaction the only copy of
  // Winfred’s 31-Aug purchase is the history row — the rebuild must keep it.
  const DB = {
    customers: [{ name: 'Winfred', contact: '0722000011' }],
    transactions: [
      tx({ name: 'Winfred', phone: '0722000011', receipt: 'R5001001', amount: 300, date: '2026-09-05' })
    ],
    customerTx: {
      Winfred: [
        { date: '2026-09-05', amount: 300, product: 'Beef', till: '5803756', receipt: 'R5001001', importedAt: '2026-09-05' },
        // History-only: no global transaction carries this key anymore.
        { date: '2026-08-31', amount: 75, product: 'Beef', till: '5803756', receipt: '', importedAt: '2026-09-01' }
      ]
    }
  };
  const ctx = makeContext(DB);
  ctx.rebuildCustomerHistory();
  const rows = plain(DB.customerTx.Winfred);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.amount).sort((a, b) => a - b), [75, 300], 'the shed global survives through its history-only row');
  assert.deepEqual(rows.map((r) => r.date), ['2026-09-05', '2026-08-31'], 'newest-first order kept');
});

test('a history-only receipt row whose payment still exists globally is re-homed, never duplicated', () => {
  // A contact edit renamed the customer; the global transaction now points at
  // the new record while the stale history bucket still uses the old name.
  const DB = {
    customers: [{ name: 'Alice Achieng', contact: '0722000001' }],
    transactions: [
      tx({ name: 'Alice Achieng', phone: '0722000001', receipt: 'R6001001', amount: 450 })
    ],
    customerTx: {
      // Stale bucket from before the rename (same receipt still exists globally).
      'Alice A.': [{ date: '2026-09-01', amount: 450, product: 'Beef', till: '', receipt: 'R6001001', importedAt: '' }]
    }
  };
  const ctx = makeContext(DB);
  ctx.rebuildCustomerHistory();
  assert.equal(DB.customerTx['Alice A.'], undefined, 'the stale bucket must disappear');
  assert.equal(DB.customerTx['Alice Achieng'].length, 1, 'one derived row under the current owner');
  assert.equal(DB.customerTx['Alice Achieng'][0].receipt, 'R6001001');
});

test('a history-only receipt row whose payment is GONE globally is kept verbatim', () => {
  const DB = {
    customers: [{ name: 'Winfred', contact: '0722000011' }],
    transactions: [tx({ name: 'Winfred', phone: '0722000011', receipt: 'R7001001', amount: 100 })],
    customerTx: {
      Winfred: [
        { date: '2026-09-01', amount: 100, product: 'Beef', till: '', receipt: 'R7001001', importedAt: '' },
        // Rolled-back / compacted away globally, no surviving transaction.
        { date: '2026-08-15', amount: 250, product: 'Soup', till: '1213294', receipt: 'R7GONE0001', importedAt: '' }
      ]
    }
  };
  const ctx = makeContext(DB);
  ctx.rebuildCustomerHistory();
  const receipts = plain(DB.customerTx.Winfred).map((r) => r.receipt).sort();
  assert.deepEqual(receipts, ['R7001001', 'R7GONE0001']);
});

test('the projection is sorted newest-first and is idempotent (second pass reports no change)', () => {
  const DB = {
    customers: [{ name: 'Alice', contact: '0722000001' }],
    transactions: [
      tx({ name: 'Alice', phone: '0722000001', receipt: 'R8001001', date: '2026-08-01' }),
      tx({ name: 'Alice', phone: '0722000001', receipt: 'R8002002', date: '2026-09-01' }),
      tx({ name: 'Alice', phone: '0722000001', receipt: 'R8003003', date: '2026-08-20' })
    ],
    customerTx: {}
  };
  const ctx = makeContext(DB);
  assert.equal(ctx.rebuildCustomerHistory(), true);
  assert.deepEqual(plain(DB.customerTx.Alice).map((r) => r.date), ['2026-09-01', '2026-08-20', '2026-08-01']);
  assert.equal(ctx.rebuildCustomerHistory(), false, 're-running an identical projection is a no-op');
});

/* ── wiring ─────────────────────────────────────────────────────────────── */

test('the cloud load merge rebuilds history instead of merging a cloud copy', () => {
  const fn = htmlSource.slice(htmlSource.indexOf('async function loadFromCloud'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /rebuildCustomerHistory\(\)/, 'the merge tail must re-project history');
  assert.match(body, /spaxNoteCloudTransactions\(cloudTx\)/, 'cloud rows must be marked already-pushed');
  // No union-merge of a customerTx payload remains.
  assert.doesNotMatch(body, /data\.customerTx/, 'load must not consume a cloud customerTx table');
});

test('Force Pull and Smart Merge rebuild history and own the pushed set', () => {
  const pull = htmlSource.slice(
    htmlSource.indexOf('async function forcePullFromCloud()'),
    htmlSource.indexOf('async function smartMergeCloud()')
  );
  assert.match(pull, /rebuildCustomerHistory\(\)/);
  assert.match(pull, /spaxReplacePushedFromCloud\(DB\.transactions \|\| \[\]\)/);
  assert.doesNotMatch(pull, /data\.customerTx/, 'a pull must not overwrite history from the cloud');

  const merge = htmlSource.slice(
    htmlSource.indexOf('async function smartMergeCloud()'),
    htmlSource.indexOf('async function resetLocalData()')
  );
  assert.match(merge, /mergeCloudTransactionsIntoDB\(data\.transactions\)/);
  assert.match(merge, /rebuildCustomerHistory\(\)/);
  assert.doesNotMatch(merge, /data\.customerTx/, 'a smart merge must not consume a cloud customerTx table');
});

test('the boot path rebuilds history before reconciling tallies', () => {
  const boot = htmlSource.slice(
    htmlSource.indexOf('return loadFromCloud().then(cloudLoaded =>'),
    htmlSource.indexOf('}function save(){')
  );
  // Both the settled-load branch and the cloud-failed catch branch rebuild,
  // ahead of repairDates() reconciling tallies against the history.
  const occurrences = boot.match(/rebuildCustomerHistory\(\)/g) || [];
  assert.ok(occurrences.length >= 2, 'rebuild must run on the merge path, the catch path, and the seed fallback');
  assert.match(boot, /histRebuilt/);
});

test('the save payload no longer carries customerTx', () => {
  const payload = htmlSource.slice(
    htmlSource.indexOf('const payload = {', htmlSource.indexOf('async function performSaveToCloud')),
    htmlSource.indexOf('const allTx = payload.transactions;')
  );
  assert.match(payload, /transactions: \(DB\.transactions/);
  assert.doesNotMatch(payload, /customerTx:/, 'the derived history must never be uploaded');
});

test('destructive edits set the full-replace latch before their next save', () => {
  // Appends cannot delete or rename: every path that removes transactions or
  // rewrites an identity field must force the next full cloud replace.
  const sites = [
    ['delete all', 'function deleteAllKeepResolved()'],
    ['scoped rebuild wipe', 'function clearHistoryInPeriod(period)'],
    ['duplicate rollback', 'function reconcileImportedRevenue()'],
    ['customer dedupe/merge', 'function dedupeCustomers()'],
    ['contact rename', 'function saveContactEdit()'],
    ['merchant purge', 'function purgeMerchantData(quiet)']
  ];
  sites.forEach(([label, marker]) => {
    const start = htmlSource.indexOf(marker);
    assert.notEqual(start, -1, marker + ' missing');
    const end = htmlSource.indexOf('\n}\n', start);
    const body = htmlSource.slice(start, end);
    assert.match(body, /spaxMarkTxFullReplace\(\)/, label + ' must flag a full replace');
  });
});
