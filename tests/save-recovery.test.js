'use strict';
/*
 * Save-recovery tests: the "cloud save fails all the time" fix and the
 * phantom "interrupted save" fix.
 *
 *   1. A client-side TIMEOUT is not an answered failure — the server is
 *      presumably still writing — so it backs off and retries the SAME
 *      resumable path (busy-retry rounds) instead of failing, or worse,
 *      falling back to the slower non-resumable saveAll.
 *   2. Every attempt carries an identity (saveTag + fingerprints); a
 *      v3.6 backend records a receipt, and a retry VERIFIES before
 *      re-uploading — a timed-out attempt that actually landed is adopted
 *      as a success instead of being uploaded twice.
 *   3. The boot resume stands down when a save is already running/queued
 *      (the live job carries the same data) and when nothing is unpushed
 *      (the interrupted save landed) — no more phantom "resumed" task
 *      pushing the user's own change to second place.
 *   4. A batch that failed for a retry-worthy reason re-plants the resume
 *      flag so the next boot pushes; dead deployments and user-cancelled
 *      jobs never re-mark.
 *
 * The fake deployment scripts per-attempt outcomes per action, including
 * hangs that honour the abort signal (the way a real fetch rejects when
 * cloudRequest's deadline fires).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const slice = (a, b) => {
  const start = HTML.indexOf(a);
  assert.notEqual(start, -1, 'slice start not found: ' + a);
  const end = HTML.indexOf(b, start);
  assert.notEqual(end, -1, 'slice end not found: ' + b);
  return HTML.slice(start, end);
};
// Production deadlines are minutes; shrink them so timeouts, backoffs and
// busy rounds surface in milliseconds.
const syncLayerSourceFast = () => slice('const GAS_URL', 'function showSyncStatus')
  .replace('const CLOUD_TIMEOUT_DEFAULT = 30000', 'const CLOUD_TIMEOUT_DEFAULT = 60')
  .replace('const CLOUD_TIMEOUT_SMALL = 60000', 'const CLOUD_TIMEOUT_SMALL = 80')
  .replace('const CLOUD_TIMEOUT_COMMIT = 90000', 'const CLOUD_TIMEOUT_COMMIT = 80')
  .replace('const CLOUD_TIMEOUT_CHUNK = 60000', 'const CLOUD_TIMEOUT_CHUNK = 80')
  .replace('const CLOUD_TIMEOUT_LOAD = 90000', 'const CLOUD_TIMEOUT_LOAD = 80')
  .replace('const CLOUD_TIMEOUT_BIG_SAVE = 180000', 'const CLOUD_TIMEOUT_BIG_SAVE = 100')
  .replace(/const CLOUD_BUSY_RETRY_DELAYS = \[[^\]]+\];/, 'const CLOUD_BUSY_RETRY_DELAYS = [5, 5, 5, 5, 5, 5];')
  .replace(/const CLOUD_HTTP_RETRY_DELAYS = \[[^\]]+\];/, 'const CLOUD_HTTP_RETRY_DELAYS = [5, 5];');

// `plan` maps action -> array of per-attempt outcomes (last one repeats):
//   'ok'            { success: true } (saveBegin mints an uploadId)
//   'hang'          never answers; rejects with AbortError on abort
//   'hangAndLand'   like hang, but the receipt the `status` action serves
//                   afterwards echoes the attempt's own fingerprints
//   { status: 404 } a non-OK HTTP answer (the edge, not the script)
//   { body: {...} } a 200 JSON answer
// 'receiptMode': 'echo' serves the last landed attempt's fingerprints from
// `status`; 'foreign' serves a receipt for somebody else's data; 'old'
// answers `status` as a pre-v3.6 backend would ("unknown action").
function makeCloud(plan = {}, { receiptMode = 'echo' } = {}) {
  const calls = [];
  const attemptsByAction = {};
  const store = {};
  const landed = { saveTag: null, txBasis: null, smallBasis: null, n: 0 };
  const outcomeFor = (action, n) => {
    const list = plan[action];
    if (!list) {
      if (action === 'saveAll' || action === 'saveDelta') return 'ok';
      if (action === 'saveBegin') return 'ok';
      if (action === 'status') return 'ok';
      return { body: { success: false, error: 'unknown action' } };
    }
    return list[Math.min(n, list.length) - 1];
  };
  const abortErr = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; return e; };
  const fetchImpl = async (url, options = {}) => {
    let body = {};
    try { body = options && options.body ? JSON.parse(options.body) : {}; } catch (_) { body = {}; }
    const action = body.action || 'load';
    attemptsByAction[action] = (attemptsByAction[action] || 0) + 1;
    const n = attemptsByAction[action];
    calls.push({ action, attempt: n, body });
    const out = outcomeFor(action, n);
    if (out === 'hang' || out === 'hangAndLand') {
      if (out === 'hangAndLand' && body.saveTag) {
        landed.saveTag = body.saveTag; landed.txBasis = body.txBasis; landed.smallBasis = body.smallBasis; landed.n += 1;
      }
      await new Promise((resolve, reject) => {
        if (options.signal && options.signal.aborted) return reject(abortErr());
        if (options.signal) options.signal.addEventListener('abort', () => reject(abortErr()));
      });
    }
    if (out && out.status) {
      return { ok: false, status: out.status, url: out.url, text: async () => (out.html != null ? out.html : 'HTTP ' + out.status) };
    }
    if (out && out.raw != null) {
      // A 200 the script did not write (a sign-in page, an error page): the
      // positive evidence of a MISCONFIGURED deployment, unlike a 404.
      return { ok: true, status: 200, url: out.url, text: async () => out.raw };
    }
    if (action === 'saveBegin') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, uploadId: 'u-test', ...(body.mode === 'delta' ? { delta: true } : {}) }) };
    }
    if (action === 'status') {
      if (receiptMode === 'old') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: false, error: 'unknown action: status' }) };
      }
      const lastSave = receiptMode === 'foreign'
        ? { tag: 'someone-else', txBasis: 'foreign:1', smallBasis: 'foreign:1', txCount: 1, at: Date.now() }
        : (landed.n ? { tag: landed.saveTag, txBasis: landed.txBasis, smallBasis: landed.smallBasis, txCount: 2, at: Date.now() } : null);
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, version: '3.6', txRows: 2, customersRows: 1, lastSave }) };
    }
    if (out && out.body) {
      return { ok: true, status: 200, text: async () => JSON.stringify(out.body) };
    }
    if (action === 'saveAll' || action === 'saveDelta') {
      if (body.saveTag) {
        landed.saveTag = body.saveTag; landed.txBasis = body.txBasis; landed.smallBasis = body.smallBasis; landed.n += 1;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  return { calls, store, localStorage, fetchImpl, landed, attempts: (a) => attemptsByAction[a] || 0 };
}

function smallDB() {
  return {
    customers: [{ name: 'A', contact: '254700', spent: 100, visits: 1 }],
    monthly: { labels: ['2026-09'], revenue: [100] },
    importedRev: 100, importedTx: 2, resolved: 0, importBatch: 1,
    transactions: [
      { date: '2026-09-01', time: '10:00:00', amount: 50, name: 'A', phone: '254700', receipt: 'R1' },
      { date: '2026-09-01', time: '10:05:00', amount: 50, name: 'A', phone: '254700', receipt: 'R2' }
    ],
    customerTx: {},
    seen: {}
  };
}

function makeSandbox(cloud, db, status) {
  return {
    fetch: cloud.fetchImpl,
    localStorage: cloud.localStorage,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    showSyncStatus: (m) => status.push(String(m)),
    isMerchant: () => false,
    DB: db
  };
}

function runCtx(cloud, db, status) {
  const ctx = vm.createContext(makeSandbox(cloud, db, status));
  vm.runInContext(syncLayerSourceFast(), ctx);
  return ctx;
}

/* ── timeout vs dead-deployment classification ─────────────────────────── */

test('timeouts and dead deployments are told apart', () => {
  const ctx = runCtx(makeCloud(), smallDB(), []);
  const V = (code) => vm.runInContext(code, ctx);
  assert.strictEqual(V(`isTimeoutError(new Error('Cloud connection timed out after 180s (large upload or weak signal).'))`), true);
  assert.strictEqual(V(`isTimeoutError(new Error('backend busy with another save — please retry the save'))`), false);
  assert.strictEqual(V(`isTimeoutError(new Error('Cloud returned HTTP 404 after 3 attempts'))`), false);
  // A 404 is NOT positive evidence the deployment is gone: Google's edge
  // serves 404 + HTML for live deployments too (a spent one-time redirect
  // token on a slow request; the multi-account /u/N redirect bug). Treating
  // it as proof suppressed the boot retry and is what made one hiccup
  // permanent, so 404s must stay retryable.
  assert.strictEqual(V(`isDeadDeploymentError('Google edge answered with a web page instead of JSON (HTTP 404) — a hiccup at Google, not a problem with your data.')`), false);
  assert.strictEqual(V(`isDeadDeploymentError('Cloud returned HTTP 404 after 3 attempts — Google edge kept refusing the request.')`), false);
  // A 200 the script did not write IS positive evidence of a
  // misconfiguration (wrong URL, or a web app not published for "Anyone").
  assert.strictEqual(V(`isDeadDeploymentError('Cloud returned a non-JSON response. Check that the Apps Script web app is deployed.')`), true);
  assert.strictEqual(V(`isDeadDeploymentError('Cloud connection timed out after 180s (large upload or weak signal).')`), false);
  assert.strictEqual(V(`isDeadDeploymentError('backend busy with another save — please retry the save')`), false);
});

test('only a timeout is rerouted to a busy-retry round', () => {
  const ctx = runCtx(makeCloud(), smallDB(), []);
  const V = (code) => vm.runInContext(code, ctx);
  assert.strictEqual(V(`cloudSaveRerouteTimeout(new Error('Cloud connection timed out after 180s.'), {txBasis:'a',smallBasis:'b'}) instanceof Error`), true);
  assert.strictEqual(V(`isBackendBusyError(cloudSaveRerouteTimeout(new Error('Cloud connection timed out after 180s.'), {txBasis:'a',smallBasis:'b'}))`), true,
    'the rerouted error must run through the existing busy-retry machinery');
  assert.strictEqual(V(`cloudSaveRerouteTimeout(new Error('Cloud connection timed out after 180s.'), {txBasis:'a',smallBasis:'b'}).spaxVerifyFirst.txBasis`), 'a');
  // Everything else passes through untouched for its existing handling.
  assert.strictEqual(V(`cloudSaveRerouteTimeout(cloudSaveCancelledError(), null).spaxCancelled`), true);
  assert.strictEqual(V(`cloudSaveRerouteTimeout(new Error('backend busy with another save'), null).spaxVerifyFirst`), undefined);
  assert.strictEqual(V(`cloudSaveRerouteTimeout(new Error('Cloud returned HTTP 500'), null).message`), 'Cloud returned HTTP 500');
});

/* ── retry, don't fail, when the server is just slow ────────────────────── */

test('a saveAll that times out once backs off and retries instead of failing', async () => {
  const cloud = makeCloud({ saveAll: ['hang', 'ok'] });
  const status = [];
  const ctx = runCtx(cloud, smallDB(), status);
  const ok = await ctx.saveToCloud(true, '🚀 Force Push');
  assert.strictEqual(ok, true, 'the retry must succeed');
  assert.strictEqual(cloud.attempts('saveAll'), 2);
  assert.strictEqual(cloud.attempts('status'), 1, 'the retry must verify before re-uploading');
  assert.ok(status.some((m) => /still being written on the server after the connection timed out/.test(m)),
    'the wait must name its cause, not the lock holder: ' + JSON.stringify(status));
  assert.ok(status.some((m) => /checking whether the last attempt landed/.test(m)));
});

test('a timed-out attempt that landed is adopted, not uploaded twice', async () => {
  // The server appended/swapped, then the ack never made it back: the retry's
  // verify step sees its own fingerprints in the receipt and succeeds.
  const cloud = makeCloud({ saveAll: ['hangAndLand'] });
  const status = [];
  const ctx = runCtx(cloud, smallDB(), status);
  const ok = await ctx.saveToCloud(true, '🚀 Force Push');
  assert.strictEqual(ok, true);
  assert.strictEqual(cloud.attempts('saveAll'), 1, 'the landed attempt must not be re-uploaded');
  assert.strictEqual(cloud.attempts('status'), 1);
  assert.ok(status.some((m) => /already landed|Saved to cloud/.test(m)));
  // The adoption is a REAL success: pushed rows and the saved basis update,
  // so the next save has nothing to re-send.
  assert.ok(cloud.store.spaxPushedTx_v1, 'pushed rows must be recorded');
  assert.ok(cloud.store.spaxSavedBasis_v1, 'the saved basis must be recorded');
});

test('a foreign receipt does not fool the verify step', async () => {
  // Somebody else's save landed between our attempts: fingerprints differ,
  // so the retry uploads instead of adopting.
  const cloud = makeCloud({ saveAll: ['hang', 'ok'] }, { receiptMode: 'foreign' });
  const ctx = runCtx(cloud, smallDB(), []);
  const ok = await ctx.saveToCloud(true, '🚀 Force Push');
  assert.strictEqual(ok, true);
  assert.strictEqual(cloud.attempts('saveAll'), 2, 'a mismatched receipt must not shortcut the upload');
});

test('an old backend without status answers just uploads', async () => {
  // Pre-v3.6 deployments answer `status` with "unknown action": the verify
  // throws, the retry shrugs and uploads — no new failure mode.
  const cloud = makeCloud({ saveAll: ['hang', 'ok'] }, { receiptMode: 'old' });
  const ctx = runCtx(cloud, smallDB(), []);
  const ok = await ctx.saveToCloud(true, '🚀 Force Push');
  assert.strictEqual(ok, true);
  assert.strictEqual(cloud.attempts('saveAll'), 2);
});

test('every save attempt carries its receipt identity', async () => {
  const cloud = makeCloud({ saveAll: ['hang', 'ok'] });
  const ctx = runCtx(cloud, smallDB(), []);
  await ctx.saveToCloud(true, '🚀 Force Push');
  for (const c of cloud.calls.filter((c) => c.action === 'saveAll')) {
    assert.ok(c.body.saveTag, 'saveTag must ride the saveAll body');
    assert.ok(c.body.txBasis, 'txBasis must ride the saveAll body');
    assert.ok(c.body.smallBasis, 'smallBasis must ride the saveAll body');
  }
});

/* ── the resume stands down instead of queueing a phantom ───────────────── */

test('the resume stands down when the interrupted save already landed', async () => {
  const cloud = makeCloud({});
  const status = [];
  const ctx = runCtx(cloud, smallDB(), status);
  assert.strictEqual(await ctx.saveToCloud(true, '🚀 Force Push'), true, 'setup: one clean save');
  await new Promise((r) => setTimeout(r, 30)); // let the unwind release the slot, as at boot
  const callsBefore = cloud.calls.length;
  cloud.store.spaxPendingSync = String(Date.now() - 3600000);
  assert.strictEqual(vm.runInContext('spaxResumeInterruptedSave()', ctx), false, 'nothing unpushed — no job');
  assert.strictEqual(cloud.calls.length, callsBefore, 'no request may go out');
  assert.strictEqual(vm.runInContext('cloudSaveRunning', ctx), false);
  assert.strictEqual(vm.runInContext('spaxActiveTasks().length', ctx), 0, 'no phantom task may appear');
  assert.ok(status.some((m) => /already landed/.test(m)));
  assert.equal('spaxPendingSync' in cloud.store, false, 'the stale flag is consumed');
});

test('the resume stands down while a save is already queued or running', async () => {
  const cloud = makeCloud({ saveAll: ['hang', 'hang', 'hang', 'ok'] });
  const ctx = runCtx(cloud, smallDB(), []);
  const running = ctx.saveToCloud(); // grinds through timeouts in the background
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(vm.runInContext('cloudSaveRunning', ctx), true, 'setup: a save is running');
  const tasksBefore = vm.runInContext('spaxTasks.length', ctx);
  assert.strictEqual(vm.runInContext('spaxResumeInterruptedSave()', ctx), false,
    'the live job carries the same data — no second job');
  assert.strictEqual(vm.runInContext('cloudSaveQueue.length', ctx), 0, 'nothing may queue behind the live save');
  assert.strictEqual(vm.runInContext('spaxTasks.length', ctx), tasksBefore, 'no phantom task may appear');
  assert.strictEqual(await running, true);
});

test('the resume still pushes when data is genuinely unpushed', async () => {
  const cloud = makeCloud({});
  const ctx = runCtx(cloud, smallDB(), []);
  cloud.store.spaxPendingSync = String(Date.now() - 3600000);
  assert.strictEqual(vm.runInContext('spaxResumeInterruptedSave()', ctx), true);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(cloud.calls.some((c) => c.action === 'saveAll'), 'the unpushed data must go up');
});

/* ── the resume waits out the interrupted upload's zombie writer ─────────── */
// A client timeout does not stop the server: the Apps Script execution keeps
// writing — and holding the lock — for up to its ~6-minute quota. The old
// resume fired at boot and burned its entire busy-retry budget fighting that
// zombie ("Resumed save … backend busy … 4m 33s"), then failed. Now a FRESH
// pending stamp defers the resume until the window can have elapsed, and the
// resume probes the lock-free `status` receipt before re-uploading data the
// zombie may already have landed.

function runCtxWith(src, cloud, db, status) {
  const ctx = vm.createContext(makeSandbox(cloud, db, status));
  vm.runInContext(src, ctx);
  return ctx;
}
const syncLayerSourceFastSmallWindow = () => syncLayerSourceFast()
  .replace(/const SPAX_SERVER_EXEC_WINDOW_MS = [^;]+;/, 'const SPAX_SERVER_EXEC_WINDOW_MS = 150;');

test('a fresh interruption defers the resume until the server-side writer can be done', async () => {
  const cloud = makeCloud({});
  const status = [];
  const ctx = runCtxWith(syncLayerSourceFastSmallWindow(), cloud, smallDB(), status);
  cloud.store.spaxPendingSync = String(Date.now()); // interrupted seconds ago
  assert.strictEqual(vm.runInContext('spaxResumeInterruptedSave()', ctx), true, 'a resume is scheduled');
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(cloud.attempts('saveAll') || 0, 0, 'no push may race the zombie writer');
  assert.strictEqual(vm.runInContext('cloudSaveRunning', ctx), false);
  assert.ok(status.some((m) => /still being written on the server/.test(m)),
    'the wait must say why: ' + JSON.stringify(status));
  // The flag survives the wait: killing the tab inside the window must not
  // lose the resume.
  assert.equal(cloud.store.spaxPendingSync && true, true, 'the flag stays planted during the defer');
  await new Promise((r) => setTimeout(r, 400)); // window elapses → probe → push
  assert.ok(cloud.attempts('saveAll') >= 1, 'the deferred resume must push once the window passes');
  assert.equal('spaxPendingSync' in cloud.store, false, 'consumed once the resume runs');
});

test('the resume verifies ITS OWN interrupted attempt (by tag) before re-uploading', async () => {
  const cloud = makeCloud({});
  const status = [];
  const ctx = runCtx(cloud, smallDB(), status);
  // The zombie landed OUR ATTEMPT after the client gave up: the receipt
  // echoes that attempt's unique tag and fingerprints — which the attempt
  // persisted before its first request went out (the state a killed tab
  // leaves behind).
  const txBasis = vm.runInContext('spaxTableBasis(DB.transactions)', ctx);
  const smallBasis = vm.runInContext('spaxSmallBasis(spaxBuildSavePayload())', ctx);
  cloud.landed.n = 1;
  cloud.landed.saveTag = 'zombie';
  cloud.landed.txBasis = txBasis;
  cloud.landed.smallBasis = smallBasis;
  cloud.store.spaxSaveAttempt_v1 = JSON.stringify({ tag: 'zombie', txBasis, smallBasis, ts: Date.now() - 3600000 });
  cloud.store.spaxPendingSync = String(Date.now() - 3600000);
  assert.strictEqual(vm.runInContext('spaxResumeInterruptedSave()', ctx), true);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(cloud.attempts('status'), 1, 'the first attempt verifies via the lock-free status probe');
  assert.strictEqual(cloud.attempts('saveAll') || 0, 0, 'landed data must not be re-uploaded');
  assert.ok(status.some((m) => /already landed|checking whether the last attempt landed/.test(m)));
  assert.equal('spaxPendingSync' in cloud.store, false, 'the stale flag is consumed');
});

test('the resume never adopts a STALE receipt — same fingerprints, another save\'s tag', async () => {
  // The "push shows done but the sheet has no change" trap: the receipt on
  // the backend belongs to an OLDER save (the last one that ever wrote). It
  // carries identical fingerprints (the local data never changed — the user
  // was re-pushing the same database) but a different tag. Matching on
  // fingerprints alone adopted it as "the interrupted attempt landed", the
  // app showed ✅, recorded everything as pushed — and the upload it vouched
  // for had never written a cell. The tag is the proof; without it the save
  // must re-upload.
  const cloud = makeCloud({});
  const status = [];
  const ctx = runCtx(cloud, smallDB(), status);
  const txBasis = vm.runInContext('spaxTableBasis(DB.transactions)', ctx);
  const smallBasis = vm.runInContext('spaxSmallBasis(spaxBuildSavePayload())', ctx);
  cloud.landed.n = 1;
  cloud.landed.saveTag = 'an-older-save';       // NOT the interrupted attempt
  cloud.landed.txBasis = txBasis;               // …but identical fingerprints
  cloud.landed.smallBasis = smallBasis;
  cloud.store.spaxSaveAttempt_v1 = JSON.stringify({ tag: 'zombie', txBasis, smallBasis, ts: Date.now() - 3600000 });
  cloud.store.spaxPendingSync = String(Date.now() - 3600000);
  assert.strictEqual(vm.runInContext('spaxResumeInterruptedSave()', ctx), true);
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(cloud.attempts('status'), 1, 'the receipt is asked for');
  assert.ok((cloud.attempts('saveAll') || 0) >= 1, 'a stale receipt must NOT shortcut the upload');
});

test('structural pins: the resume defers inside the server-exec window and verifies before pushing', () => {
  assert.match(HTML, /const SPAX_SERVER_EXEC_WINDOW_MS = /, 'the zombie window must exist');
  assert.match(HTML, /spaxResumeDeferred = true/, 'the defer must be scheduled once');
  assert.match(HTML, /saveToCloud\(true, resumeName, verifyFirst\)/, 'the resume must carry fingerprints to verify before uploading');
  assert.match(HTML, /performSaveToCloud\(0, job\.verifyFirst/, 'the pump must hand the job its verifyFirst');
  assert.match(HTML, /const CLOUD_BUSY_RETRIES = 8/, 'the busy budget must outlast a ~6-minute lock holder');
});

/* ── the drain re-plants the flag only for retry-worthy failures ────────── */

test('a retry-worthy failure re-marks the resume flag for the next boot', async () => {
  // Busy on every attempt: the batch fails, but the data is still unpushed.
  const busy = { body: { success: false, error: 'backend busy with another save — please retry the save' } };
  const cloud = makeCloud({ saveAll: [busy] });
  const ctx = runCtx(cloud, smallDB(), []);
  assert.strictEqual(await ctx.saveToCloud(true, '🚀 Force Push'), false);
  await new Promise((r) => setTimeout(r, 30)); // the drain re-marks after the job resolves
  assert.strictEqual(cloud.store.spaxPendingSync && true, true, 'the next boot must push automatically');
});

test('a 404 hiccup still re-marks the flag for the next boot', async () => {
  // A 404 is not proof the deployment is dead — Google's edge 404s healthy
  // deployments — so the save must retry on the next launch instead of
  // waiting for a human. That suppression is what made the outage outlive
  // every app restart.
  const edge = { status: 404, html: '<!doctype html><html>not found</html>' };
  const cloud = makeCloud({ saveAll: [edge] });
  const ctx = runCtx(cloud, smallDB(), []);
  assert.strictEqual(await ctx.saveToCloud(true, '🚀 Force Push'), false);
  await new Promise((r) => setTimeout(r, 30)); // the drain runs after the job resolves
  assert.strictEqual(cloud.store.spaxPendingSync && true, true, 'the next boot must push automatically');
});

test('a misconfigured endpoint never re-marks the flag', async () => {
  // A 200 that is not JSON — a sign-in page where the database should be —
  // proves the URL or the deployment's access setting is wrong. No retry can
  // fix that, so the flag stays off until a human corrects it.
  const misconfigured = { raw: '<!doctype html><html>Sign in</html>' };
  const cloud = makeCloud({ saveAll: [misconfigured] });
  const ctx = runCtx(cloud, smallDB(), []);
  assert.strictEqual(await ctx.saveToCloud(true, '🚀 Force Push'), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal('spaxPendingSync' in cloud.store, false, 'no retry can fix a misconfiguration');
});

test('a cancelled save never re-marks the flag', async () => {
  const cloud = makeCloud({ saveAll: ['hang'] });
  const ctx = runCtx(cloud, smallDB(), []);
  const p = ctx.saveToCloud(true, '🚀 Force Push');
  await new Promise((r) => setTimeout(r, 30));
  vm.runInContext('cloudSaveCancelAll()', ctx);
  assert.strictEqual(await p, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal('spaxPendingSync' in cloud.store, false, 'a save the user stopped must stay stopped');
});

/* ── structural pins ───────────────────────────────────────────────────── */

test('verify-before-re-uploading stays wired into the save path', () => {
  // Attempt identity, the receipt check, its failure being non-fatal, and
  // the reroute at every timeout site (delta probe, post-landing delta,
  // chunked probe, post-landing chunked, one-shot saveAll + its re-send).
  assert.match(HTML, /const saveTag = /);
  assert.match(HTML, /action: 'status'/);
  assert.match(HTML, /spaxVerifySaveLanded\(post, verifyFirst\)/);
  assert.match(HTML, /save proceeds exactly as before/, 'an unverifiable attempt must upload, not fail');
  assert.ok((HTML.match(/cloudSaveRerouteTimeout\(/g) || []).length >= 6, 'every timeout site must reroute');
  assert.match(HTML, /err\.spaxCommitStep = true/, 'the commit step must be flagged for verify-first');
  // The resume must stand down (and consume the flag — the live job carries
  // the data, and its drain re-plants on failure) while a save is live. The
  // check grew a block body when the flag consumption moved into it.
  assert.match(HTML, /if \(cloudSaveRunning \|\| cloudSaveQueue\.length\) \{[\s\S]{0,300}return false/, 'a live save owns the resume flag');
  assert.match(HTML, /spaxCloudAlreadyCurrent\(spaxBuildSavePayload\(\), spaxComputeDeltaRows\(allTx\)\)/,
    'the resume must stand down when nothing is unpushed');
  assert.match(HTML, /cloudSaveBatchFailed\.push/, 'failed jobs must be booked for the drain');
  assert.match(HTML, /!isDeadDeploymentError\(f\.error\)/, 'misconfigured deployments must not resurrect on boot');
});
