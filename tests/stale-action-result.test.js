'use strict';

// Regression guard for the 2026-09-20 "one stale ✅, two deployments"
// confusion. A Force Push confirmed against one /exec URL left an
// untimestamped "✅ Pushed 2182 customers to cloud successfully." on the Sync
// tab; after the saved cloud URL changed (a redeploy's new /exec pasted into
// the Cloud Endpoint card), the NEW deployment's empty test read
// ("Reachable — 0 customers") sat beside that old verdict and read as a
// contradiction — "the push succeeded, so why is the cloud empty?".
// Two invariants keep that from recurring:
//   • every FINAL action-line outcome goes through spaxSetActionResult, which
//     stamps the write time the way the connection-test line already does;
//   • changing or resetting the saved cloud URL voids the line, naming the
//     previous deployment as the owner of whatever verdict it showed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('every sync action-line write goes through the stamping helper', () => {
  const rawWrites = htmlSource.match(/\$\('syncActionResult'\)\.innerHTML/g) || [];
  assert.equal(rawWrites.length, 0,
    'raw syncActionResult writes remain (they would skip the timestamp): ' + rawWrites.length);
  const at = htmlSource.indexOf('function spaxSetActionResult(html)');
  assert.notEqual(at, -1, 'spaxSetActionResult helper not found');
  const body = htmlSource.slice(at, htmlSource.indexOf('\n}', at));
  assert.match(body, /toLocaleTimeString\(\)/, 'helper must stamp the write time');
  assert.match(body, /innerHTML = html/, 'helper must render the passed markup verbatim');
});

test('the final outcomes all route through the helper', () => {
  // The stamp only means something if the success/failure/warning lines use
  // it: count call sites — push, push-fail, empty-pull, pull, pull-fail,
  // merge-blocked, no-valid-cloud, merged, merge-fail, local-reset, plus the
  // two URL-change voids.
  const calls = htmlSource.match(/spaxSetActionResult\(/g) || [];
  assert.ok(calls.length >= 13, 'expected every action-line writer plus the URL voids to call the helper, got ' + calls.length);
});

test('changing or resetting the saved cloud URL voids the stale verdict', () => {
  for (const fn of ['function saveCloudUrlField()', 'function resetCloudUrlField()']) {
    const at = htmlSource.indexOf(fn);
    assert.notEqual(at, -1, fn + ' not found');
    const body = htmlSource.slice(at, htmlSource.indexOf('\n}', at));
    assert.match(body, /spaxSetActionResult\(/, fn + ' must void the action line');
    assert.match(body, /previous deployment/, fn + ' must name the previous deployment as the verdict owner');
  }
});

test('the shell cache is bumped past the untimestamped-result build', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const name = /const CACHE_NAME = '([^']+)'/.exec(sw);
  assert.ok(name, 'CACHE_NAME not found in sw.js');
  assert.notEqual(name[1], 'spax-v30', 'installed apps would keep the stale-result shell');
});
