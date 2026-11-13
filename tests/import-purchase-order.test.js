'use strict';

// IMPORT ORDER = TIME OF PURCHASE (internal process, not shown in the app).
//
// Statements carry a purchase stamp per row (date + completion time). That
// stamp decides the order rows are read in — not the order the file lists
// them in, not the parse order, not the import timestamp. When two or more
// statements are imported together their rows are merged into ONE list and
// re-sorted, so the purchase time supersedes any other capture order.
//
// These tests run the REAL helpers from index.html.

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

function orderingSource() {
  return slice('function spaxTimeOfDay(v){', 'function stripTime(dateStr){');
}

const run = (ctx, code) => vm.runInContext(code, ctx);

// stripTime + parseDate are the real ones from index.html; the ordering block
// on top of them.
function ctxWithOrdering() {
  const ctx = vm.createContext({ console, Date, Math, Number, String, Object, Array, JSON, XLSX: {} });
  vm.runInContext(slice('function parseDate(value) {', 'function toTitleCase'), ctx);
  vm.runInContext(slice('function stripTime(dateStr){', "pdfjsLib"), ctx);
  vm.runInContext(orderingSource(), ctx);
  return ctx;
}

test('the purchase stamp pairs the date with the time of day, padded to sort as text', () => {
  const ctx = ctxWithOrdering();
  assert.equal(run(ctx, `spaxPurchaseStamp({ date: '2026-08-12', time: '9:07:05' })`), '2026-08-12T09:07:05');
  assert.equal(run(ctx, `spaxPurchaseStamp({ date: '2026-08-12 14:25:30' })`), '2026-08-12T14:25:30');
  // No time on the row → sorted at the start of its day, never after it.
  assert.equal(run(ctx, `spaxPurchaseStamp({ date: '2026-08-12' })`), '2026-08-12T00:00:00');
  assert.equal(run(ctx, `spaxPurchaseStamp({ date: '2026-08-12', time: '' })`), '2026-08-12T00:00:00');
});

test('rows are ordered by time of purchase, ignoring the order they were captured in', () => {
  const ctx = ctxWithOrdering();
  // Deliberately shuffled: a later file listed first, and rows inside a file
  // out of order.
  run(ctx, `var rows = [
    { id: 'c', name: 'Later Statement', date: '2026-08-13', time: '08:00:00' },
    { id: 'b', name: 'Same Day Late', date: '2026-08-12', time: '18:45:10' },
    { id: 'a', name: 'Same Day Early', date: '2026-08-12', time: '07:05:00' },
    { id: 'd', name: 'Two Statements Merged', date: '2026-08-11', time: '23:59:59' }
  ];`);
  assert.equal(run(ctx, `spaxSortByPurchaseTime(rows).map(r => r.id).join(',')`), 'd,a,b,c',
    'oldest purchase first, ties on the date broken by the time of purchase');
  // Newest-first for the per-customer history lists.
  assert.equal(run(ctx, `rows.slice().sort(spaxByPurchaseTimeDesc).map(r => r.id).join(',')`), 'c,b,a,d');
  // The sort is stable for rows sharing an exact stamp.
  run(ctx, `var tie = [
    { id: 'first', date: '2026-08-12', time: '10:00:00' },
    { id: 'second', date: '2026-08-12', time: '10:00:00' }
  ];`);
  assert.equal(run(ctx, `spaxSortByPurchaseTime(tie).map(r => r.id).join(',')`), 'first,second');
  // Sorting is non-destructive: the caller's array keeps its capture order.
  assert.equal(run(ctx, `rows[0].id`), 'c');
});

/* ── wiring: every import path orders by the stamp ──────────────────────── */

test('confirm-import and backfill read their rows in purchase-time order', () => {
  const importFn = slice('function importTransactions(txs, opts = {}) {', '/* ══════════ 1-CLICK ROLLBACK DUPLICATE REVENUE');
  assert.match(importFn, /txs = spaxSortByPurchaseTime\(txs\)/, 'the import must order rows by the purchase stamp');
  const importSortAt = importFn.indexOf('txs = spaxSortByPurchaseTime(txs)');
  const firstRowUse = importFn.indexOf('const fresh = [];');
  assert.ok(importSortAt < firstRowUse, 'the order must be applied before any row is booked');

  const backfill = slice('function backfillTransactions(txs){', 'async function handleBackfill(input){');
  assert.match(backfill, /txs = spaxSortByPurchaseTime\(txs\)/, 'backfill must order rows by the purchase stamp');
  assert.ok(backfill.indexOf('spaxSortByPurchaseTime') < backfill.indexOf('txs.forEach'),
    'the order must be applied before backfill books anything');
});

test('several statements in one selection are merged, then ordered by purchase time', () => {
  const handleFiles = slice('async function handleFiles(fileList) {', '// Keep this single-file alias');
  assert.match(handleFiles, /const rows = \[\];/);
  assert.match(handleFiles, /rows\.push\(\.\.\.parsed\)/, 'each file contributes to ONE combined list');

  const preview = slice('function showPreview(rows, fmt) {', "$('exportBtn').onclick");
  assert.match(preview, /rows = spaxSortByPurchaseTime\(rows\)/,
    'the combined multi-file selection must be re-ordered by purchase time, not by file');
  assert.ok(preview.indexOf('spaxSortByPurchaseTime') < preview.indexOf('pendingRows = rows.map'),
    'the order must be settled before the preview rows are captured for confirm');

  const confirm = preview.slice(preview.indexOf("$('confirmImport').onclick"));
  assert.match(confirm, /importTransactions\(toImport\)/,
    'confirm imports exactly the previewed (purchase-time ordered) rows');

  // Rebuild merges every parsed file into allRows and imports once.
  const rebuild = slice('async function handleRebuild(input){', 'function recalcFromHistory(){');
  assert.match(rebuild, /allRows\.push\(\.\.\.rows\)/);
  assert.match(rebuild, /importTransactions\(allRows\)/);
});

test('per-customer history keeps the purchase time and is listed newest purchase first', () => {
  const importFn = slice('function importTransactions(txs, opts = {}) {', '/* ══════════ 1-CLICK ROLLBACK DUPLICATE REVENUE');
  assert.match(importFn, /const histRow = \{[^}]*time: tx\.time \|\| ''/,
    'the history row must carry the statement time, not just the date');
  assert.equal((importFn.match(/\.sort\(spaxByPurchaseTimeDesc\)/g) || []).length, 2,
    'both history attach paths sort by the purchase stamp');

  const backfill = slice('function backfillTransactions(txs){', 'async function handleBackfill(input){');
  assert.match(backfill, /time: ntx\.time \|\| ''/);
  assert.match(backfill, /\.sort\(spaxByPurchaseTimeDesc\)/);

  const rebuild = slice('function rebuildCustomerHistory() {', '/* ══════════ NEW-CUSTOMER FLAG');
  assert.match(rebuild, /time: t\.time \|\| spaxExtractPurchaseTime\(t\.date\)/, 'the projection must preserve the purchase time, even inside a legacy date');
  assert.match(rebuild, /next\[name\]\.sort\(spaxByPurchaseTimeDesc\)/);
});

test('the purchase time is never rendered, including in the import preview', () => {
  const preview = slice('function showPreview(rows, fmt) {', "$('exportBtn').onclick");
  assert.doesNotMatch(preview, /r\.time/, 'the preview table must not print the time of purchase');
  // No view renders a row's `time` at all: it exists only as the internal
  // ordering key, the dedup identity and a stored field.
  assert.doesNotMatch(htmlSource, /\$\{[^}]*\.time[^}]*\}/,
    'no template may interpolate a transaction/history row time');
  assert.doesNotMatch(htmlSource, /<th>[^<]*Time<\/th>/i, 'no table exposes a Time column');
});

test('the time of purchase is an INTERNAL rule — nothing new is shown in the UI', () => {
  // No toasts, hints or table columns were added for it.
  assert.doesNotMatch(htmlSource, /time of purchase[^\n]*toast/i);
  assert.doesNotMatch(htmlSource, /<th>\s*Purchase time/i);
});
