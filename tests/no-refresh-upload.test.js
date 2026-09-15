'use strict';

// No-refresh statement uploads: one statement after another, no page refresh.
//
// History: attaching a statement used to "require" a page refresh in two
// different ways:
//   1. The file inputs were reset (input.value = '') only at the END of long
//      async handlers. An early return, an error, or a long OCR left the
//      input stuck on the previous selection — and the browser fires no
//      onchange when the same files are selected again, so the next
//      statement could only be attached after a manual refresh (PR #64).
//   2. A deploy could leave a long-open tab / installed PWA running an OLD
//      build forever, so "fixed" behaviour appeared to come back. The
//      stale-build guard (stamped SPAX_BUILD_DATE, guarded SW
//      controllerchange reload, tap-to-update banner) exists so a device
//      can no longer sit silently on a pre-fix build (PR #24's auto-reload
//      was reverted wholesale; this re-introduces ONLY the reload, guarded
//      so it can never interrupt an in-flight upload).
//
// These tests run at source level (same style as the other tests) and pin
// every one of those guarantees.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const swSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

function functionBody(name) {
  // `name` is a top-level function in index.html; return its body up to the
  // matching close of the first top-level `}` at column 0 after the header.
  const start = htmlSource.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} not found`);
  const end = htmlSource.indexOf('\n}', start);
  assert.notEqual(end, -1, `function ${name} end not found`);
  return htmlSource.slice(start, end + 2);
}

test('main drop zone: the input is reset inside its own change handler', () => {
  const handler = htmlSource.match(/\$\(\'fileInput\'\)\.onchange = e => \{ ([^}]+) \};/);
  assert.ok(handler, 'fileInput.onchange handler not found');
  assert.match(handler[1], /handleFiles\(e\.target\.files\)/, 'must parse the selection');
  assert.match(handler[1], /e\.target\.value = ''/, 'must reset the input so the next file (even the same file) fires onchange again');
});

test('backfill / rebuild / first-visit / ledger-photo: input reset BEFORE any await or early return', () => {
  for (const name of ['handleBackfill', 'handleRebuild', 'handleFixFirstVisit', 'handleLedgerPhoto']) {
    const body = functionBody(name);
    // Everything between the function header and the first `await` / `if`
    // return must contain the reset.
    const firstAsync = body.search(/\bawait\b/);
    const firstEarlyReturn = body.search(/if\s*\([^)]*\)\s*return/);
    let cutoff = body.length;
    if (firstAsync >= 0) cutoff = Math.min(cutoff, firstAsync);
    if (firstEarlyReturn >= 0) cutoff = Math.min(cutoff, firstEarlyReturn);
    const head = body.slice(0, cutoff);
    assert.match(head, /input\.value = ''/, `${name}: input.value = '' must run before the first await/early return`);
  }
});

test('contact resolver input is reset in its change handler', () => {
  const handler = htmlSource.match(/\$\(\'resolverFile\'\)\.onchange = e => \{ ([^}]+) \};/);
  assert.ok(handler, 'resolverFile.onchange handler not found');
  assert.match(handler[1], /e\.target\.value = ''/, 'resolver input must be reset so the same contact list can be attached again');
});

test('no page refresh is triggered by any import/upload path', () => {
  // The ONLY reloads in the app must live inside the stale-build guard's
  // doReload() (SW took over, everything idle, once per session) and the
  // user-tapped "Update now" button.
  const reloads = htmlSource.split('location.reload()').length - 1;
  assert.equal(reloads, 2, `expected exactly 2 location.reload() call sites (guard + update button), found ${reloads}`);
  const guardStart = htmlSource.indexOf('function spaxSwUpdateGuard');
  const guardEnd = htmlSource.indexOf('})();', guardStart);
  assert.notEqual(guardStart, -1, 'stale-build guard not found');
  const guard = htmlSource.slice(guardStart, guardEnd);
  assert.match(guard, /spaxActiveTasks\(\)\.length/, 'guard must check the live task registry');
  assert.match(guard, /spaxLocalTaskCount > 0/, 'guard must check in-flight local import/OCR tasks');
  assert.match(guard, /cloudSaveRunning/, 'guard must check a running cloud save');
  assert.match(guard, /cloudSaveQueue\.length/, 'guard must check queued saves');
  assert.match(guard, /sessionStorage\.getItem\(RELOAD_KEY\)/, 'guard must reload at most once per tab session');
  assert.match(guard, /e\.newWorker === initialController|initialController === nw|nw === initialController/, 'guard must not reload on first-install controller take-over');
});

test('new-build check compares SPAX_BUILD_DATE and never auto-reloads', () => {
  const m = htmlSource.match(/const SPAX_BUILD_DATE = '(\d{4}-\d{2}-\d{2})'/);
  assert.ok(m, 'SPAX_BUILD_DATE stamp missing — bump it on every merge');
  // The footer shows the same date statically so it is visible even before JS.
  assert.match(htmlSource, new RegExp(`build ${m[1]}`), 'footer must stamp the build date');
  const fnStart = htmlSource.indexOf('async function spaxCheckForNewBuild');
  const fnEnd = htmlSource.indexOf('\n}', fnStart);
  const fn = htmlSource.slice(fnStart, fnEnd);
  assert.match(fn, /SPAX_BUILD_DATE/, 'check must compare the build dates');
  // The check itself must never reload: the only reload inside it may be the
  // user-tapped "Update now" button.
  const reloadsInFn = fn.split('location.reload()').length - 1;
  assert.equal(reloadsInFn, 1, 'exactly one reload call site allowed inside the new-build check (the button)');
  assert.match(fn, /btn\.onclick = \(\) => \{ location\.reload\(\); \}/, 'the reload must be wired to the user tap, not to the check');
  assert.match(fn, /Update now/, 'the banner must offer an explicit update button');
});

test('service worker cache is bumped so installed apps drop the stale shell', () => {
  const m = swSource.match(/const CACHE_NAME = '(spax-v\d+)'/);
  assert.ok(m, 'SW CACHE_NAME not found');
  const n = Number(m[1].slice('spax-v'.length));
  assert.ok(n >= 25, `expected the spax-v25 bump (stale-shell fix), got ${m[1]}`);
  // The SW still uses network-first navigations, so an OPEN app gets fresh
  // HTML; the cache is the offline fallback and the installed-app shell.
  assert.match(swSource, /event\.request\.mode === 'navigate'/, 'network-first navigation handling must remain');
});
