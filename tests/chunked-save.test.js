/**
 * Cloud sync is the pre-PR-38 one-shot saveAll path.
 * Chunked saveBegin/saveChunk/saveCommit was reverted because it needed a
 * Code.gs deploy that was hard to get live, and it broke existing deployments.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GAS = fs.readFileSync(path.join(ROOT, 'google-apps-script.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('client uses a 30s timeout and a single saveAll POST', () => {
  assert.match(HTML, /controller\.abort\(\), 30000/, 'cloudRequest should time out at 30s');
  assert.match(HTML, /action: 'saveAll'/, 'client should send saveAll');
  assert.doesNotMatch(HTML, /CHUNK_ROWS/);
  assert.doesNotMatch(HTML, /action: 'saveBegin'/);
  assert.doesNotMatch(HTML, /action: 'saveChunk'/);
  assert.doesNotMatch(HTML, /action: 'saveCommit'/);
});

test('backend only implements saveAll (no chunked staging actions)', () => {
  assert.match(GAS, /action === 'saveAll'/);
  assert.doesNotMatch(GAS, /saveBegin_/);
  assert.doesNotMatch(GAS, /saveChunk_/);
  assert.doesNotMatch(GAS, /saveCommit_/);
});

test('loadFromCloud does not force a push-back save', () => {
  const fn = HTML.slice(HTML.indexOf('async function loadFromCloud'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const live = body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/saveToCloud\(/.test(live), 'load must not trigger a forced save');
});
