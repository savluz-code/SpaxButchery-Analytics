'use strict';

// LIVE TASK REGISTRY + PER-TASK CANCEL
//
// The app must be able to say exactly WHICH saves/tasks are happening (by
// name, state and progress) rather than a vague "resuming interrupted save…",
// and the user must be able to cancel ONE of them without disturbing the rest.
//
// These tests run the real sync layer in a vm sandbox with fake browser APIs.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function slice(startMarker, endMarker) {
  const start = HTML.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} not found`);
  const end = HTML.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} not found after ${startMarker}`);
  return HTML.slice(start, end);
}

const syncLayer = () => slice('const GAS_URL', 'function showSyncStatus');

function smallDB() {
  return {
    customers: [{ name: 'C0', contact: '254700000000', spent: 100, visits: 1 }],
    monthly: { labels: ['2026-09'], revenue: [100] },
    importedRev: 100, importedTx: 1, resolved: 0, importBatch: 1,
    transactions: [], customerTx: {}, seen: {}
  };
}

function makeEnv({ slowMs = 0 } = {}) {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const status = [];
  const toasts = [];
  const calls = [];
  const aborted = [];
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options.body));
    if (!slowMs) return { ok: true, text: async () => JSON.stringify({ success: true }) };
    return await new Promise((resolve, reject) => {
      const abortErr = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; return e; };
      if (options.signal && options.signal.aborted) { aborted.push(1); return reject(abortErr()); }
      const timer = setTimeout(() => resolve({ ok: true, text: async () => JSON.stringify({ success: true }) }), slowMs);
      const sig = options.signal;
      if (sig) sig.addEventListener('abort', () => {
        clearTimeout(timer);
        aborted.push(1);
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  const ctx = vm.createContext({
    fetch: fetchImpl,
    localStorage,
    AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
    showSyncStatus: (m) => status.push(m),
    toast: (m) => toasts.push(m),
    isMerchant: () => false,
    navigator: {},
    document: { title: 'Spax', hidden: false, addEventListener() {} },
    window: { addEventListener() {} },
    DB: smallDB()
  });
  vm.runInContext(syncLayer(), ctx);
  return { ctx, store, status, toasts, calls, aborted };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('every save is registered by NAME with a live state', async () => {
  const env = makeEnv({ slowMs: 60 });
  const p1 = env.ctx.saveToCloud(true, '📥 Backfill');
  const p2 = env.ctx.saveToCloud(true, '🚀 Force Push');

  const active = env.ctx.spaxActiveTasks();
  assert.deepEqual(JSON.parse(JSON.stringify(active.map((t) => t.name))), ['📥 Backfill', '🚀 Force Push']);
  assert.strictEqual(active[0].state, 'running');
  assert.strictEqual(active[1].state, 'queued');
  assert.ok(active.every((t) => t.kind === 'save' && typeof t.cancel === 'function'));

  await Promise.all([p1, p2]);
  await tick(30);
  assert.strictEqual(env.ctx.spaxActiveTasks().length, 0, 'finished saves leave the active list');
  const recent = env.ctx.spaxRecentTasks().map((t) => [t.name, t.state]);
  assert.deepEqual(JSON.parse(JSON.stringify(recent)), [['📥 Backfill', 'done'], ['🚀 Force Push', 'done']]);
});

test('cancelling ONE queued save leaves the others running', async () => {
  const env = makeEnv({ slowMs: 60 });
  const running = env.ctx.saveToCloud(true, '📥 Backfill');
  const doomed = env.ctx.saveToCloud(true, '🔧 Rebuild');
  const keeper = env.ctx.saveToCloud(true, '🚀 Force Push');

  const target = env.ctx.spaxActiveTasks().find((t) => t.name === '🔧 Rebuild');
  assert.strictEqual(env.ctx.spaxCancelTask(target.id), true);
  assert.strictEqual(await doomed, false, 'a cancelled save resolves false, it does not hang');
  assert.strictEqual(target.state, 'cancelled');

  assert.strictEqual(await running, true, 'the running save is untouched');
  assert.strictEqual(await keeper, true, 'the other queued save still runs');
  assert.ok(env.toasts.some((m) => /Cancelled 🔧 Rebuild/.test(m)));
  assert.ok(env.calls.length >= 2, 'the two surviving saves both reached the cloud');
});

test('cancelling the RUNNING save aborts its upload and the queue moves on', async () => {
  const env = makeEnv({ slowMs: 200 });
  const running = env.ctx.saveToCloud(true, '📥 Backfill');
  const next = env.ctx.saveToCloud(true, '🚀 Force Push');

  const target = env.ctx.spaxActiveTasks().find((t) => t.name === '📥 Backfill');
  assert.strictEqual(env.ctx.spaxCancelTask(target.id), true);
  assert.strictEqual(await running, false);
  assert.ok(env.aborted.length >= 1, 'the in-flight request must be aborted');
  assert.strictEqual(target.state, 'cancelled');

  assert.strictEqual(await next, true, 'the next save takes the slot');
  await tick(20);
  assert.strictEqual(env.ctx.spaxActiveTasks().length, 0);
});

test('cancel is idempotent and a finished task cannot be cancelled', async () => {
  const env = makeEnv();
  const p = env.ctx.saveToCloud(true, '💾 Save');
  assert.strictEqual(await p, true);
  await tick(20);
  const done = env.ctx.spaxRecentTasks()[0];
  assert.strictEqual(env.ctx.spaxCancelTask(done.id), false);
  assert.strictEqual(env.ctx.spaxCancelTask('nope'), false);
});

test('cancelAll stops every save and clears the pending flag', async () => {
  const env = makeEnv({ slowMs: 200 });
  const a = env.ctx.saveToCloud(true, '📥 Backfill');
  const b = env.ctx.saveToCloud(true, '🔧 Rebuild');
  assert.ok('spaxPendingSync' in env.store);
  assert.strictEqual(env.ctx.cloudSaveCancelAll(), 2);
  assert.strictEqual(await a, false);
  assert.strictEqual(await b, false);
  await tick(30);
  assert.strictEqual(env.ctx.spaxActiveTasks().length, 0);
  assert.equal('spaxPendingSync' in env.store, false, 'no save left to resume');
});

test('progress from the sync pill lands on the running task row', async () => {
  const env = makeEnv({ slowMs: 60 });
  const p = env.ctx.saveToCloud(true, '📥 Backfill');
  env.ctx.spaxTaskProgress('⏳ Saving to cloud — 📥 Backfill · 42% (chunk 3/7)');
  const t = env.ctx.spaxActiveTasks()[0];
  assert.match(t.detail, /42%/);
  await p;
});

test('a resumed save is named, not anonymous', async () => {
  const env = makeEnv();
  env.store.spaxPendingSync = String(Date.now());
  assert.strictEqual(env.ctx.spaxResumeInterruptedSave(), true);
  const names = env.ctx.spaxActiveTasks().map((t) => t.name);
  assert.deepEqual(JSON.parse(JSON.stringify(names)), ['🔄 Resumed save']);
  assert.ok(env.status.some((m) => /🔄 Resumed save/.test(m)));
  await tick(40);
});

test('local import tasks are listed by name and individually cancellable', async () => {
  const env = makeEnv();
  const t1 = env.ctx.spaxBeginLocalTask('📄 Import — statement.pdf', 'reading');
  const t2 = env.ctx.spaxBeginLocalTask('📥 Backfill — 3 files', 'starting');
  assert.deepEqual(JSON.parse(JSON.stringify(env.ctx.spaxActiveTasks().map((t) => t.name))),
    ['📄 Import — statement.pdf', '📥 Backfill — 3 files']);

  const target = env.ctx.spaxActiveTasks()[0];
  assert.strictEqual(env.ctx.spaxCancelTask(target.id), true);
  assert.strictEqual(t1.cancelled, true, 'the worker loop sees the cancel flag');
  assert.strictEqual(t2.cancelled, false, 'the other import is untouched');

  t1.end();
  assert.strictEqual(target.state, 'cancelled');
  t2.progress('parsing 2/3');
  assert.strictEqual(env.ctx.spaxActiveTasks()[0].detail, 'parsing 2/3');
  t2.end('done', 'finished');
  assert.strictEqual(env.ctx.spaxActiveTasks().length, 0);
});

test('a pre-emption marks the jobs it drops as cancelled in the list', async () => {
  const env = makeEnv({ slowMs: 120 });
  const a = env.ctx.saveToCloud(true, '📥 Backfill');
  const b = env.ctx.saveToCloud(true, '🔧 Rebuild');
  const stopped = env.ctx.cloudSavePreempt('🗑️ Delete All');
  assert.deepEqual(JSON.parse(JSON.stringify(stopped)), ['📥 Backfill', '🔧 Rebuild']);
  assert.strictEqual(await a, false);
  assert.strictEqual(await b, false);
  await tick(20);
  const states = env.ctx.spaxRecentTasks().map((t) => t.state);
  assert.ok(states.every((s) => s === 'cancelled'), 'both dropped jobs read as cancelled, not failed');
});

// ── UI wiring (source-level) ──
test('the Sync tab hosts a live activity panel with per-task cancel', () => {
  assert.match(HTML, /id="taskPanel"/);
  assert.match(HTML, /Live Activity/);
  const render = slice('function spaxRenderTasks() {', 'function addSyncUI()');
  assert.match(render, /taskPanel/);
  assert.match(render, /taskDock/);
  const row = slice('function spaxTaskRowHtml(t) {', 'function spaxCancelTaskFromUI');
  assert.match(row, /spaxCancelTaskFromUI/);
  assert.match(HTML, /function spaxCancelAllFromUI\(\)/);
});

test('status updates mirror progress into the task list', () => {
  const body = slice('function showSyncStatus(msg) {', 'function spaxTaskAge');
  assert.match(body, /spaxTaskProgress\(msg\)/);
});
