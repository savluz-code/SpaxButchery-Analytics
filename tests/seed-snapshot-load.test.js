/**
 * Data tab — "Load Seed Snapshot" (client v2.6).
 *
 * The 🧬 "Export as JS Seed Code" button serialises the live DB (customers +
 * monthly + itemised transactions + per-customer history) into a .js file.
 * Until v2.6 there was no way to load that file back — CSV import was the only
 * route, and it drops transaction detail and baseline bookkeeping. This pins
 * the load path end to end:
 *
 *   1. The button + hidden file input exist and are wired.
 *   2. spaxParseSeedSnapshot_ round-trips a REAL buildSeedCode-shaped file —
 *      including a customer name containing "];", quotes and braces (a lazy
 *      regex parser would truncate inside that string; the bracket-balanced,
 *      string-aware scanner must not).
 *   3. Malformed snapshots fail loudly (missing constant / truncated file).
 *   4. Loading is a wholesale local replacement with the same invariants as
 *      Restore Local Baseline: rebuildCustomerHistory, spaxMarkTxFullReplace
 *      (the snapshot may lack rows the cloud still holds → replace, never
 *      append), overwrite the saved baseline, then save().
 *   5. Cache + title bumps so devices actually see the new client.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

/* ── source pins ─────────────────────────────────────────────────────────── */

test('Data tab has the Load Seed Snapshot button + hidden file input', () => {
  assert.ok(HTML.includes('id="loadSeedBtn"'), 'loadSeedBtn missing');
  assert.ok(HTML.includes('Load Seed Snapshot'), 'button label missing');
  assert.ok(HTML.includes('id="seedFileInput"'), 'seedFileInput missing');
  assert.ok(/id="seedFileInput"[^>]*accept="\.js,\.txt,\.json"/.test(HTML),
    'seedFileInput must accept .js files');
});

test('button opens the file picker; file input runs the loader', () => {
  assert.ok(HTML.includes("$('loadSeedBtn').onclick = () => $('seedFileInput').click();"),
    'loadSeedBtn must open the picker');
  assert.ok(HTML.includes("$('seedFileInput').onchange = handleSeedSnapshotFile;"),
    'seedFileInput must run handleSeedSnapshotFile');
});

test('title + service worker bumps so clients see v2.7', () => {
  assert.ok(HTML.includes('<title>SpaxButchery | Analytics v2.7</title>'),
    'title must be v2.7');
  const m = SW.match(/const CACHE_NAME = 'spax-v(\d+)';/);
  assert.ok(m && Number(m[1]) >= 30,
    'expected the spax-v30 bump (full-save mode), got ' + (m && m[1]));
});

/* ── the parser, executed for real ───────────────────────────────────────── */

function loadParser() {
  const start = HTML.indexOf('function spaxParseSeedSnapshot_');
  const end = HTML.indexOf('async function handleSeedSnapshotFile');
  assert.ok(start > 0 && end > start, 'parser not found in index.html');
  const src = HTML.slice(start, end);
  return vm.runInNewContext(src + '\nspaxParseSeedSnapshot_;', {});
}

function snapshotText(customers, monthly, transactions, customerTx) {
  // Mirrors buildSeedCode()'s exact output shape.
  return `/* ══════════ SPAX SEED SNAPSHOT — generated 2026-09-19 ══════════\n */\n` +
    'const SEED_SNAPSHOT_CUSTOMERS = ' + JSON.stringify(customers, null, 2) + ';\n\n' +
    'const SEED_SNAPSHOT_MONTHLY = ' + JSON.stringify(monthly, null, 2) + ';\n\n' +
    'const SEED_SNAPSHOT_TRANSACTIONS = ' + JSON.stringify(transactions, null, 2) + ';\n\n' +
    'const SEED_SNAPSHOT_CUSTOMER_TX = ' + JSON.stringify(customerTx, null, 2) + ';\n';
}

test('parser round-trips a buildSeedCode-shaped file (hostile strings included)', () => {
  const parse = loadParser();
  const customers = [
    { name: 'Plain Name', contact: '254700000001', spent: 500, visits: 2, days: 3 },
    // A lazy regex would cut inside this string: it contains "];", quotes and braces.
    { name: 'A"];B \\"quoted\\" {x}[y]";', contact: '254700000002', spent: 0, visits: 0, days: 999 }
  ];
  const monthly = { '2026-08': 12000, '2026-09': 3400 };
  const transactions = [
    { date: '2026-09-01', time: '10:00', amount: 200, name: 'Plain Name', phone: '254700000001', product: 'Soup', till: '5803756', receipt: 'R1', source: 'statement' },
    { date: '2026-09-02', time: '11:30', amount: 300, name: 'Plain Name', phone: '254700000001', product: 'Meat', till: '1213294', receipt: 'R2', source: 'statement' }
  ];
  const customerTx = { 'Plain Name': [{ date: '2026-09-01', amount: 200, product: 'Soup' }] };

  const snap = parse(snapshotText(customers, monthly, transactions, customerTx));
  assert.strictEqual(snap.customers.length, 2);
  assert.strictEqual(snap.customers[1].name, customers[1].name, 'hostile name must survive byte-for-byte');
  // The parser runs in a vm realm → its objects have a foreign prototype, so
  // structural (loose) equality is the right comparison across the realm edge.
  assert.deepEqual(snap.monthly, monthly);
  assert.strictEqual(snap.transactions.length, 2);
  assert.deepEqual(snap.transactions[1], transactions[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(snap.customerTx)), customerTx);
});

test('parser fails loudly on malformed snapshots', () => {
  const parse = loadParser();
  assert.throws(() => parse('const SEED_SNAPSHOT_CUSTOMERS = [];'),
    /missing constant/);
  assert.throws(() => parse(snapshotText([], {}, [], {}).replace('SEED_SNAPSHOT_MONTHLY', 'SEED_SNAPSHOT_OTHER')),
    /missing constant/);
  assert.throws(() => parse(snapshotText([{ name: 'x' }], {}, [], {}).slice(0, snapshotText([{ name: 'x' }], {}, [], {}).length - 40)),
    /unterminated|missing constant/);
  assert.throws(() => parse('const SEED_SNAPSHOT_CUSTOMERS = not-json;'),
    /expected \[ or \{/);
});

/* ── the load flow keeps the full-replace invariants ─────────────────────── */

test('loader replaces wholesale: rebuild + full-replace flag + baseline overwrite + save', () => {
  const start = HTML.indexOf('async function handleSeedSnapshotFile');
  const end = HTML.indexOf("if ($('seedFileInput'))");
  assert.ok(start > 0 && end > start, 'loader not found');
  const body = HTML.slice(start, end);

  assert.ok(body.includes('spaxParseSeedSnapshot_('), 'must parse via the pinned parser');
  assert.ok(body.includes('confirm(') && body.includes('OVERWRITES'),
    'must confirm the overwrite with counts');
  assert.ok(body.includes('if (!nC)'), 'must refuse empty snapshots');
  assert.ok(body.includes('DB.tombstones') && body.includes('next.tombstones = DB.tombstones'),
    'dedupe tombstones must carry over (viral)');
  assert.ok(body.includes('rebuildCustomerHistory();'), 'must reproject derived history');
  assert.ok(body.includes('spaxMarkTxFullReplace();'),
    'snapshot may lack cloud rows → next save must FULLY REPLACE, never append');
  assert.ok(body.includes('await saveLocalBaseline();'),
    'snapshot must become the durable local baseline too');
  assert.ok(/await saveLocalBaseline\(\);[\s\S]*?save\(\);/.test(body),
    'save() comes after the baseline write');
  assert.ok(body.includes("input.value = '';"), 'must reset the input so the same file can be reloaded');
});
