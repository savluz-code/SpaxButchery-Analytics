'use strict';

// TAG-EXACT SAVE VERIFICATION (2026-09-21).
//
// The bug this pins: "Push is not writing to the sheets even after many
// trials. Shows push done, but sheet has no change." Root cause: a save is
// only as honest as its verification. The old verify matched a receipt by
// DATA FINGERPRINTS (txBasis/smallBasis) alone — so after every timed-out
// one-shot upload the retry's verify found an OLD receipt (the last save
// that ever wrote) carrying identical fingerprints — the local data had not
// changed — and adopted it as proof the NEW attempt landed. The app showed
// "✅ Pushed 2182 customers" and recorded everything as pushed while the
// attempt it vouched for had never written a cell. Every retry repeated the
// same false adoption: push "done" forever, sheet unchanged forever.
//
// A receipt proves an attempt ONLY when it carries that attempt's unique
// saveTag. This suite pins the contract end to end: bodies carry their
// identity, the identity is persisted before the first request goes out,
// no other save's receipt is ever adopted, and spaxConfirmLastSave names
// exactly which verdict it found (including the wrong-deployment trap).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function syncLayerSource() {
  const start = HTML.indexOf('const GAS_URL');
  const end = HTML.indexOf('function showSyncStatus');
  assert.notEqual(start, -1, 'GAS_URL not found in index.html');
  assert.notEqual(end, -1, 'showSyncStatus not found in index.html');
  return HTML.slice(start, end);
}

// A tiny backend: answers status with a configurable `lastSave` receipt and
// accepts everything else. `dropAll` makes every request throw (a dead
// link), letting "persisted BEFORE the request" be observed.
function makeCloud({ lastSave = null, dropAll = false, spreadsheet = null } = {}) {
  const calls = [];
  const live = { transactions: [] };
  const staged = { transactions: [] };
  let session = null;
  const respond = (body) => ({ ok: true, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, options = {}) => {
    const body = options && options.body ? JSON.parse(options.body) : {};
    calls.push(body);
    if (dropAll) throw new Error('Failed to fetch');
    if (body.action === 'status') {
      return respond({
        success: true, version: '3.10', lastSave, lock: { free: true, ms: 0 },
        ...(spreadsheet ? { spreadsheet } : {})
      });
    }
    if (body.action === 'saveAll') {
      live.transactions = (body.transactions || []).slice();
      return respond({ success: true });
    }
    if (body.action === 'saveBegin') {
      staged.transactions = [];
      session = { uploadId: String(body.uploadId || 'up-1'), mode: body.mode === 'delta' ? 'delta' : 'full' };
      return respond({ success: true, uploadId: session.uploadId });
    }
    if (body.action === 'saveChunk') {
      staged[body.table] = (staged[body.table] || []).concat(body.rows || []);
      return respond({ success: true, written: (body.rows || []).length });
    }
    if (body.action === 'saveCommit') {
      const want = Number((body.expect || {}).transactions || 0);
      if (staged.transactions.length !== want) {
        return respond({ success: false, error: 'chunk mismatch' });
      }
      live.transactions = staged.transactions.slice();
      return respond({ success: true });
    }
    return respond({ success: false, error: 'unknown action' });
  };
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  return { calls, live, store, localStorage, fetchImpl };
}

function smallDB(rows = 40) {
  const transactions = [];
  for (let i = 0; i < rows; i++) {
    transactions.push({ date: '2026-08-31', time: '10:00:00', amount: 100, name: 'C' + i, phone: '2547' + i, receipt: 'R' + i });
  }
  return {
    customers: [{ name: 'C0', contact: '25470', spent: 100, visits: 1 }],
    monthly: { labels: ['2026-08'], revenue: [4000] },
    transactions,
    customerTx: {},
    seen: {}
  };
}

function bigDB(rows = 2501) {
  const db = smallDB(rows);
  db.monthly = { labels: ['2026-08'], revenue: [rows * 100] };
  return db;
}

function runCtx(cloud, db, { patch = [] } = {}) {
  const status = [];
  const ctx = vm.createContext({
    fetch: cloud.fetchImpl,
    localStorage: cloud.localStorage,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    showSyncStatus: (m) => status.push(m),
    isMerchant: () => false,
    DB: db
  });
  let src = syncLayerSource();
  for (const [re, to] of patch) src = src.replace(re, to);
  vm.runInContext(src, ctx);
  return { ctx, status };
}

function bases(ctx) {
  return {
    txBasis: vm.runInContext('spaxTableBasis(spaxBuildSavePayload().transactions)', ctx),
    smallBasis: vm.runInContext('spaxSmallBasis(spaxBuildSavePayload())', ctx)
  };
}

/* ── spaxVerifySaveLanded: the receipt must carry THIS attempt's tag ─────── */

test('spaxVerifySaveLanded adopts only a receipt carrying the exact attempt tag', async () => {
  const b = { txBasis: 'tb:1', smallBasis: 'sb:1' };
  const check = async (cloud, verifyFirst) => {
    const { ctx } = runCtx(cloud, smallDB());
    // Same contract as cloudRequest: post returns the parsed answer JSON.
    const post = async (obj) => {
      const res = await cloud.fetchImpl('x', { body: JSON.stringify(obj) });
      return JSON.parse(await res.text());
    };
    return ctx.spaxVerifySaveLanded(post, verifyFirst);
  };

  // The exact attempt: tag + both fingerprints → adopted.
  assert.strictEqual(await check(makeCloud({ lastSave: { ...b, tag: 'mine', at: 1 } }), { tag: 'mine', ...b }), true);

  // THE BUG: identical fingerprints, an older save's tag → never adopted.
  assert.strictEqual(await check(makeCloud({ lastSave: { ...b, tag: 'an-older-save', at: 1 } }), { tag: 'mine', ...b }), false,
    'a stale receipt with matching fingerprints must NOT verify a later attempt');

  // Same tag but the data changed under the attempt → not adopted.
  assert.strictEqual(await check(makeCloud({ lastSave: { ...b, txBasis: 'tb:CHANGED', tag: 'mine', at: 1 } }), { tag: 'mine', ...b }), false);

  // A verify without a tag (legacy identity) can never prove anything.
  assert.strictEqual(await check(makeCloud({ lastSave: { ...b, tag: 'x', at: 1 } }), { ...b }), false,
    'verifyFirst without a tag must never be satisfied');
  assert.strictEqual(await check(makeCloud({ lastSave: { ...b, tag: 'x', at: 1 } }), null), false,
    'without verifyFirst nothing is ever adopted');
  assert.strictEqual(await check(makeCloud({ lastSave: null }), { tag: 'mine', ...b }), false);
});

/* ── save bodies carry their identity ────────────────────────────────────── */

test('every save body carries a unique saveTag plus both fingerprints', async () => {
  const cloud = makeCloud();
  const db = smallDB();
  const { ctx } = runCtx(cloud, db);
  assert.strictEqual(await ctx.saveToCloud(true), true);
  assert.strictEqual(await ctx.saveToCloud(true), true);

  const saveAlls = cloud.calls.filter((c) => c.action === 'saveAll');
  assert.strictEqual(saveAlls.length, 2);
  saveAlls.forEach((c, i) => {
    assert.match(String(c.saveTag), /^t[0-9a-z]+$/, 'a saveTag must ride the body (attempt ' + i + ')');
    assert.ok(c.txBasis && c.smallBasis, 'both fingerprints must ride the body');
  });
  assert.notStrictEqual(saveAlls[0].saveTag, saveAlls[1].saveTag,
    'two attempts must never share a tag — the receipt could then prove the wrong one');
});

test('the chunked commit carries the attempt tag too', async () => {
  const cloud = makeCloud();
  const { ctx } = runCtx(cloud, bigDB());
  assert.strictEqual(await ctx.saveToCloud(true), true);
  const commit = cloud.calls.find((c) => c.action === 'saveCommit');
  assert.ok(commit, 'the session must commit');
  assert.match(String(commit.saveTag), /^t[0-9a-z]+$/, 'the commit must name the attempt it completes');
  assert.ok(commit.txBasis && commit.smallBasis, 'the commit carries the fingerprints');
});

/* ── the identity is persisted BEFORE the first request ──────────────────── */

test('the attempt identity is persisted before its first request goes out', async () => {
  const cloud = makeCloud({ dropAll: true }); // every request dies
  const { ctx } = runCtx(cloud, smallDB(), {
    patch: [[/const CLOUD_BUSY_RETRY_DELAYS = \[[^\]]+\];/, 'const CLOUD_BUSY_RETRY_DELAYS = [];']]
  });
  let ok = true;
  try { ok = await ctx.saveToCloud(true); } catch (_) { ok = false; }
  assert.notStrictEqual(ok, true, 'the save must not report success on a dead link');
  assert.ok(cloud.calls.length >= 1, 'a request did go out');
  const persisted = JSON.parse(cloud.store.spaxSaveAttempt_v1);
  assert.ok(persisted && persisted.tag, 'the tag must be stored even though nothing landed');
  assert.strictEqual(persisted.tag, cloud.calls[0].saveTag,
    'the persisted identity must be the request\'s own — so a resume can ask about IT');
  assert.ok(persisted.txBasis && persisted.smallBasis, 'fingerprints persist with the tag');
});

/* ── the post-timeout retry never adopts someone else's receipt ──────────── */

test('a retry does not adopt a stale receipt and re-uploads instead', async () => {
  const b = { txBasis: 'tb:1', smallBasis: 'sb:1' };
  const cloud = makeCloud({ lastSave: { ...b, tag: 'an-older-save', at: 1 } });
  const { ctx } = runCtx(cloud, smallDB());
  // The previous attempt's identity survives (its response never arrived).
  const verifyFirst = { tag: 'mine', ...bases(ctx) };
  cloud.calls.length = 0;
  assert.strictEqual(await ctx.performSaveToCloud(0, verifyFirst), true);
  assert.ok(cloud.calls.some((c) => c.action === 'saveAll'),
    'a stale receipt must NOT shortcut the upload — the save re-uploads');
});

test('a retry adopts its OWN receipt and does not re-upload', async () => {
  const cloud = makeCloud();
  const { ctx } = runCtx(cloud, smallDB());
  const b = bases(ctx); // identical fixture → identical fingerprints in the new ctx
  const ownTag = 'mine-7';
  cloud.calls.length = 0;
  // The zombie landed OUR attempt after the client gave up: its receipt now
  // answers on status.
  const cloud2 = makeCloud({ lastSave: { ...b, tag: ownTag, at: Date.now() } });
  const s = runCtx(cloud2, smallDB());
  assert.strictEqual(await s.ctx.performSaveToCloud(0, { tag: ownTag, ...b }), true,
    'its own receipt means it landed');
  assert.ok(!cloud2.calls.some((c) => c.action === 'saveAll'),
    'nothing is re-uploaded when the receipt carries this attempt\'s own tag');
});

/* ── spaxConfirmLastSave: every verdict, named ───────────────────────────── */

async function confirmWith({ rec, attempt }) {
  const cloud = makeCloud({ lastSave: rec, spreadsheet: { id: 'S1', name: 'Spax Sheet', url: 'https://docs.google.com/x' } });
  const { ctx, status } = runCtx(cloud, smallDB());
  if (attempt) vm.runInContext('spaxSaveAttempt(' + JSON.stringify(attempt) + ')', ctx);
  const post = async (obj) => {
    const res = await cloud.fetchImpl('x', { body: JSON.stringify(obj) });
    return JSON.parse(await res.text());
  };
  const res = await ctx.spaxConfirmLastSave(post);
  return { res, status, cloud };
}

test('spaxConfirmLastSave: the attempt\'s own tag is "Receipt confirmed" (with the sheet named)', async () => {
  const now = Date.now();
  const { res } = await confirmWith({
    rec: { tag: 'mine', txBasis: 'tb', smallBasis: 'sb', at: now },
    attempt: { tag: 'mine', txBasis: 'tb', smallBasis: 'sb', ts: now - 100 }
  });
  assert.strictEqual(res.ok, true);
  assert.match(res.note, /Receipt confirmed/);
  assert.match(res.note, /Spax Sheet/, 'the verdict must name the sheet this endpoint writes');
});

test('spaxConfirmLastSave: same fingerprints but another save\'s tag is only "content confirmed"', async () => {
  const now = Date.now();
  const { res } = await confirmWith({
    rec: { tag: 'an-older-save', txBasis: 'tb', smallBasis: 'sb', at: now - 999999 },
    attempt: { tag: 'mine', txBasis: 'tb', smallBasis: 'sb', ts: now - 100 }
  });
  assert.strictEqual(res.ok, true);
  assert.match(res.note, /content is confirmed|Content confirmed/i);
  assert.doesNotMatch(res.note, /Receipt confirmed/);
});

test('spaxConfirmLastSave: a genuinely newer receipt is another device, not a failure', async () => {
  const now = Date.now();
  const { res } = await confirmWith({
    rec: { tag: 'other-device', txBasis: 'xx', smallBasis: 'yy', at: now + 5000 },
    attempt: { tag: 'mine', txBasis: 'tb', smallBasis: 'sb', ts: now - 100 }
  });
  assert.strictEqual(res.ok, true);
  assert.match(res.note, /another device/);
});

test('spaxConfirmLastSave: an OLDER mismatched receipt is the wrong-deployment verdict', async () => {
  const now = Date.now();
  const { res } = await confirmWith({
    rec: { tag: 'ancient', txBasis: 'xx', smallBasis: 'yy', at: now - 99999999 },
    attempt: { tag: 'mine', txBasis: 'tb', smallBasis: 'sb', ts: now - 100 }
  });
  assert.strictEqual(res.ok, false, 'this push did NOT land — it must not be reported as done');
  assert.match(res.note, /did NOT land/);
  assert.match(res.note, /different Google Sheet|deployment/i, 'the verdict must name the two-deployments trap');
});

/* ── source pins ─────────────────────────────────────────────────────────── */

test('source pins: verification is tag-exact and the attempt persists first', () => {
  const fn = HTML.slice(HTML.indexOf('async function spaxVerifySaveLanded'), HTML.indexOf('function spaxNoteBackendVersion'));
  assert.match(fn, /!verifyFirst\.tag/, 'a verify without a tag can prove nothing');
  assert.match(fn, /rec\.tag !== verifyFirst\.tag/, 'the receipt must carry the exact attempt tag');

  const perf = HTML.slice(HTML.indexOf('async function performSaveToCloud'), HTML.indexOf('async function saveToCloudChunked'));
  assert.match(perf, /spaxSaveAttempt\(attempt\)/, 'the identity must be persisted');
  assert.ok(perf.indexOf('spaxSaveAttempt(attempt)') < perf.indexOf('await post('),
    'persistence must happen BEFORE the first request goes out');

  assert.match(HTML, /const SPAX_ATTEMPT_KEY = 'spaxSaveAttempt_v1'/, 'the persisted-attempt key must exist');
  assert.match(HTML, /spaxLoadAttempt\(\)/, 'resumes must be able to load the persisted attempt');
});
