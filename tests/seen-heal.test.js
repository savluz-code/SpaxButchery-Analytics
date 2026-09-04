'use strict';

// Regression guard for the "31 Aug stayed at 11 transactions after re-import"
// bug. Root cause: the dedup seen-map kept keys for transactions that had been
// deleted (pre-PR-38 wholesale-replace), while the later union-merges made the
// map sticky. Re-importing the statement then flagged the missing rows as
// "already imported" and skipped them. healOrphanedSeenKeys() must clear any
// seen-key with no backing transaction so the next re-import re-books the rows.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// The dedup helpers live as one contiguous block: transactionKey → txKeyNoTime →
// legacyReceiptKeys → normalizeSeenDates → isSeen → markSeenInto → markSeen →
// healOrphanedSeenKeys. Slice it and evaluate it against minimal stubs so the
// test exercises the REAL key logic rather than a re-implementation.
function dedupBlock() {
  const start = htmlSource.indexOf('function transactionKey(tx)');
  const end = htmlSource.indexOf('/* ══════════ NEW-CUSTOMER FLAG', start);
  assert.notEqual(start, -1, 'transactionKey not found in index.html');
  assert.notEqual(end, -1, 'end marker after healOrphanedSeenKeys not found');
  return htmlSource.slice(start, end);
}

function makeContext(transactions, seen) {
  const src = `
    var DB = { transactions: [], seen: {} };
    function stripTime(d){ return String(d||'').replace(/T.*$/,''); }
    function cleanReceipt(r){ return String(r||'').replace(/[^A-Z0-9]/gi,'').toUpperCase(); }
    function normalizeName(n){ return String(n||'').trim().toLowerCase(); }
    function normalizeContact(c){ return String(c||'').trim(); }
    ${dedupBlock()}
  `;
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  ctx.DB.transactions = transactions;
  ctx.DB.seen = seen;
  return ctx;
}

test('healOrphanedSeenKeys clears seen-keys with no backing transaction', () => {
  const txs = [
    { receipt: 'UHVH4T4SL28', date: '2026-08-31', time: '16:52:19', amount: 50, name: 'Elena', contact: '' },
    { receipt: 'UHV1J44VCHA', date: '2026-08-31', time: '17:01:02', amount: 120, name: 'Ann', contact: '' }
  ];
  const ctx = makeContext(txs, {});
  // Populate the legitimate keys exactly as import would.
  txs.forEach(t => ctx.markSeen(t));
  // Inject a phantom key for a transaction that was deleted (the 41→11 bug).
  ctx.DB.seen['receipt|UHV3K77XQZ9|2026-08-31|15:00:00'] = 1;

  const cleared = ctx.healOrphanedSeenKeys();

  assert.equal(cleared, 1, 'expected exactly one orphaned key to be cleared');
  assert.equal('receipt|UHV3K77XQZ9|2026-08-31|15:00:00' in ctx.DB.seen, false, 'orphan key must be removed');
  // The two legitimate keys must survive.
  txs.forEach(t => {
    assert.equal(ctx.isSeen(t), true, 'legitimate seen-key must survive the heal');
  });
});

test('healOrphanedSeenKeys is a no-op when every key has a backing transaction', () => {
  const txs = [
    { receipt: 'QGH7XTRN7YA', date: '2026-08-31', time: '09:00:00', amount: 75, name: 'Winfred', contact: '' }
  ];
  const ctx = makeContext(txs, {});
  txs.forEach(t => ctx.markSeen(t));

  const cleared = ctx.healOrphanedSeenKeys();

  assert.equal(cleared, 0, 'no orphaned keys expected');
});

test('healOrphanedSeenKeys tolerates a missing seen map', () => {
  const ctx = makeContext([], undefined);
  assert.equal(ctx.healOrphanedSeenKeys(), 0);
});

test('load path wires healOrphanedSeenKeys into startup and cloud merge', () => {
  // The heal must run both after the cloud union (so a manual 🔄 sync also
  // heals) and after load() settles (local-only / cloud-failed paths).
  const loadTail = htmlSource.slice(
    htmlSource.indexOf('return loadFromCloud().then(cloudLoaded =>'),
    htmlSource.indexOf('}function save(){')
  );
  assert.match(loadTail, /healOrphanedSeenKeys\(\)/);
  assert.match(htmlSource, /DB\.seen = \{\s*\.\.\.cloudSeen, \.\.\.localSeenSnap\};[\s\S]*?healOrphanedSeenKeys\(\);/);
});
