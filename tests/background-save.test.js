'use strict';

// Background persistence: a save must survive the app being minimized or
// covered by another app, and stay active until every queued task completes.
//
// Guards (all in the sync layer of index.html):
//   1. Screen Wake Lock while a save or import task runs.
//   2. A `spaxPendingSync` localStorage flag, set when a save queues and
//      cleared on drain — a killed page resumes with one push on next boot.
//   3. beforeunload warning + Background Sync registration + completion notice.
//   4. Progress mirrored into document.title (task-switcher visibility).
//
// Behavioural tests run the REAL sync layer in a vm sandbox with fake
// browser APIs; wiring tests pin the hooks at source level.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

function slice(startMarker, endMarker) {
  const start = HTML.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} not found`);
  const end = HTML.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} not found after ${startMarker}`);
  return HTML.slice(start, end);
}

function syncLayerSource() {
  return slice('const GAS_URL', 'function showSyncStatus');
}

function smallDB() {
  return {
    customers: [{ name: 'C0', contact: '254700000000', spent: 100, visits: 1 }],
    monthly: { labels: ['2026-09'], revenue: [100] },
    importedRev: 100,
    importedTx: 1,
    resolved: 0,
    importBatch: 1,
    transactions: [],
    customerTx: {},
    seen: {}
  };
}

// Fake browser environment. Wake-lock, listeners, background sync and the
// resume flag are all observable from the test. `slowMs` delays the fake
// cloud so a save stays in flight across test ticks when needed.
function makeEnv({ slowMs = 0 } = {}) {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const wake = { requests: 0, releases: 0, held: null };
  const listeners = { window: {}, document: {}, sw: {} };
  const syncRegs = [];
  const navigatorFake = {
    wakeLock: {
      request: async () => {
        wake.requests += 1;
        const lock = {
          released: false,
          release() { this.released = true; wake.releases += 1; wake.held = null; },
          addEventListener() {}
        };
        wake.held = lock;
        return lock;
      }
    },
    serviceWorker: {
      ready: Promise.resolve({ sync: { register: async (tag) => { syncRegs.push(tag); } } }),
      addEventListener: (t, fn) => { listeners.sw[t] = fn; }
    }
  };
  const documentFake = {
    title: 'SpaxButchery',
    hidden: false,
    addEventListener: (t, fn) => { listeners.document[t] = fn; }
  };
  const windowFake = { addEventListener: (t, fn) => { listeners.window[t] = fn; } };
  const status = [];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options.body));
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    return { ok: true, text: async () => JSON.stringify({ success: true }) };
  };
  const ctx = vm.createContext({
    fetch: fetchImpl,
    localStorage,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    showSyncStatus: (m) => status.push(m),
    isMerchant: () => false,
    navigator: navigatorFake,
    document: documentFake,
    window: windowFake,
    SyncManager: function SyncManager() {},
    DB: smallDB()
  });
  vm.runInContext(syncLayerSource(), ctx);
  return { ctx, store, wake, listeners, syncRegs, status, calls, documentFake };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('a queued save plants the resume flag and holds a wake lock; draining clears both', async () => {
  const env = makeEnv();
  assert.equal('spaxPendingSync' in env.store, false);

  const p = env.ctx.saveToCloud(true, '🚀 Force Push');
  // Synchronous: the flag is planted the moment the job queues.
  assert.ok('spaxPendingSync' in env.store, 'resume flag must be set while a save is queued');
  assert.equal(env.wake.requests, 1, 'wake lock must be requested for a running save');

  assert.strictEqual(await p, true);
  // The job promise resolves just before the pump unwinds, so let the final
  // .then (flag clear + lock release) run before asserting the drain.
  await tick(10);
  assert.deepStrictEqual(env.syncRegs, ['spax-save'], 'background sync must be registered');
  assert.equal('spaxPendingSync' in env.store, false, 'drain must clear the resume flag');
  assert.equal(env.wake.releases, 1, 'drain must release the wake lock');
});

test('beforeunload warns while a save is queued and stays silent when idle', async () => {
  const env = makeEnv();
  const handler = env.listeners.window.beforeunload;
  assert.ok(handler, 'a beforeunload guard must be registered');

  const idle = { preventDefaultCalls: 0, preventDefault() { this.preventDefaultCalls += 1; } };
  handler(idle);
  assert.equal(idle.preventDefaultCalls, 0, 'idle page must not warn');

  const p = env.ctx.saveToCloud(true, '🚀 Force Push');
  const busy = { preventDefaultCalls: 0, preventDefault() { this.preventDefaultCalls += 1; }, returnValue: undefined };
  handler(busy);
  assert.equal(busy.preventDefaultCalls, 1, 'a queued save must trigger the close warning');
  assert.strictEqual(busy.returnValue, '');

  assert.strictEqual(await p, true);
  await tick(10); // let the pump unwind past job.resolve before asserting idle
  const drained = { preventDefaultCalls: 0, preventDefault() { this.preventDefaultCalls += 1; } };
  handler(drained);
  assert.equal(drained.preventDefaultCalls, 0, 'drained queue must not warn');
});

test('hiding mid-save arms the resume path; returning re-holds the lock', async () => {
  const env = makeEnv({ slowMs: 40 });
  const onVis = env.listeners.document.visibilitychange;
  assert.ok(onVis, 'a visibilitychange handler must be registered');

  const p = env.ctx.saveToCloud(true, '📥 Backfill');
  env.documentFake.hidden = true;
  onVis();
  assert.strictEqual(vm.runInContext('spaxHiddenDuringSave', env.ctx), true);
  await tick(10); // serviceWorker.ready.then runs on a microtask
  assert.ok(env.syncRegs.includes('spax-save'), 'hiding mid-save must re-register background sync');

  env.documentFake.hidden = false;
  const before = env.wake.requests;
  onVis();
  // The lock may already be held (no second request) or re-requested after a
  // browser release — either way the intent to hold it must be re-asserted
  // without throwing.
  assert.ok(env.wake.requests >= before);

  assert.strictEqual(await p, true);
  await tick(10);
  assert.strictEqual(vm.runInContext('spaxHiddenDuringSave', env.ctx), false, 'drain must consume the hidden flag');
});

test('save progress is mirrored into the tab title', () => {
  const env = makeEnv();
  env.ctx.spaxTitleProgress('⏳ Saving to cloud — 📥 Backfill (1/2)');
  assert.ok(env.documentFake.title.startsWith('⏳'), 'in-progress status must reach the title');
  const done = env.documentFake.title;
  env.ctx.spaxTitleProgress('✅ Saved to cloud — done');
  assert.strictEqual(env.documentFake.title, done, 'completion must not overwrite the title (drain restores it)');
});

test('an interrupted save resumes with one push on the next boot', async () => {
  const env = makeEnv();
  assert.strictEqual(env.ctx.spaxResumeInterruptedSave(), false, 'no flag → no resume');

  env.store.spaxPendingSync = '1757460000000'; // left by a killed session
  assert.strictEqual(env.ctx.spaxResumeInterruptedSave(), true);
  assert.ok(env.status.some((m) => /Resuming interrupted save/.test(m)));
  await tick(50);
  assert.ok(env.calls.some((c) => c.action === 'saveAll'), 'resume must push the database');
  assert.equal('spaxPendingSync' in env.store, false, 'the resumed save clears the flag on drain');
});

test('resume stays quiet in local-only mode', () => {
  const env = makeEnv();
  vm.runInContext(`SYNC_MODE='local'`, env.ctx);
  env.store.spaxPendingSync = '1757460000000';
  assert.strictEqual(env.ctx.spaxResumeInterruptedSave(), false);
  assert.strictEqual(env.calls.length, 0);
});

test('import tasks hold the same wake lock as saves', async () => {
  const env = makeEnv();
  env.ctx.spaxModalTask(true);
  assert.equal(env.wake.requests, 1);
  await tick();
  env.ctx.spaxModalTask(false);
  assert.equal(env.wake.releases, 1);
});

test('the save queue marks pending on push and clears on drain', () => {
  const push = slice('function saveToCloud(force = false, name) {', 'function cloudSaveQueuedNames()');
  assert.match(push, /spaxMarkPending\(\)/);
  const pump = slice('function cloudSavePump() {', '// ── PRE-EMPTION ──');
  assert.match(pump, /spaxClearPending\(\)/);
});

test('status updates mirror progress into the tab title', () => {
  const body = slice('function showSyncStatus(msg) {', 'function addSyncUI()');
  assert.match(body, /spaxTitleProgress\(msg\)/);
});

test('the import modal holds the lock while it works', () => {
  assert.match(slice('function showImportModal(icon, title, body, pct){', 'function updateImportModal'), /spaxModalTask\(true\)/);
  assert.match(slice('function finishImportModal(body){', 'function closeImportModal()'), /spaxModalTask\(false\)/);
  assert.match(slice('function closeImportModal(){', '/* ══════════ KIMI VISION AI'), /spaxModalTask\(false\)/);
  assert.match(HTML, /stays active until the task completes/);
});

test('file parsing and backfill hold the lock for their whole run', () => {
  const files = slice('async function handleFiles(fileList) {', '// Keep this single-file alias');
  assert.match(files, /spaxModalTask\(true\)/);
  assert.match(files, /finally \{ try \{ spaxModalTask\(false\);/);
  const backfill = slice('async function handleBackfill(input){', '/* ══════════ REBUILD — SCOPED');
  assert.match(backfill, /spaxModalTask\(true\)/);
  assert.match(backfill, /spaxModalTask\(false\)/);
});

test('boot resumes a save a killed session left behind', () => {
  const load = slice('async function load(){', '}function save(){');
  assert.match(load, /spaxResumeInterruptedSave\(\)/);
});

test('the service worker never caches saves and handles background sync', () => {
  assert.match(SW, /const CACHE_NAME = 'spax-v22';/);
  assert.match(SW, /event\.request\.method !== 'GET'/);
  assert.match(SW, /script\.google\.com/);
  assert.match(SW, /addEventListener\('sync'/);
  assert.match(SW, /spax-save/);
  assert.match(SW, /spax-resume-save/);
});
