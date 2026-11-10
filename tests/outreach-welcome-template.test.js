'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const LIMIT = 50;

// Pull the real TEMPLATES / fill / genericMsg code out of the app so the test
// fails if the shipped template drifts, rather than testing a copy of it.
function loadTemplates() {
  const start = html.indexOf('const TEMPLATES={');
  const end = html.indexOf('/* ══════════ COMEBACK SEND', start);
  assert.ok(start !== -1 && end > start, 'TEMPLATES/fill/genericMsg block not found');
  const firstStart = html.indexOf('function firstName(');
  const firstEnd = html.indexOf('\n', firstStart);
  assert.ok(firstStart !== -1 && firstEnd > firstStart, 'firstName() not found');
  const source = html.slice(firstStart, firstEnd) + '\n' + html.slice(start, end) +
    '\nthis.TEMPLATES=TEMPLATES;this.fill=fill;this.genericMsg=genericMsg;';
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  return sandbox;
}

const { TEMPLATES, fill, genericMsg } = loadTemplates();

function visibleLength(text) { return Array.from(text).length; }

test('welcome template exists, welcomes and thanks the customer', () => {
  assert.equal(typeof TEMPLATES.welcome, 'string');
  assert.match(TEMPLATES.welcome, /\bwelcome\b/i);
  assert.match(TEMPLATES.welcome, /asante|thank/i);
  assert.match(TEMPLATES.welcome, /\{firstname\}/);
});

test('welcome template stays within 50 characters', () => {
  // Counted both ways: an emoji is one visible character but two UTF-16 units.
  assert.ok(visibleLength(TEMPLATES.welcome) <= LIMIT, `visible length ${visibleLength(TEMPLATES.welcome)}`);
  assert.ok(TEMPLATES.welcome.length <= LIMIT, `string length ${TEMPLATES.welcome.length}`);
});

test('personalized and shared versions stay short and fully substituted', () => {
  const customer = { name: 'Amina Ali', spent: 1250, visits: 4, days: 0 };
  const personal = fill(TEMPLATES.welcome, customer);
  assert.equal(personal, 'Hi Amina! Welcome to SpaxButchery 🥩 Asante!');
  assert.ok(visibleLength(personal) <= LIMIT, `personalized length ${visibleLength(personal)}`);

  const shared = genericMsg(TEMPLATES.welcome);
  assert.equal(shared, 'Hi there! Welcome to SpaxButchery 🥩 Asante!');
  assert.ok(visibleLength(shared) <= LIMIT, `shared length ${visibleLength(shared)}`);
  assert.doesNotMatch(shared, /\{[a-z]+\}/);
});

test('Outreach template picker offers the welcome template', () => {
  assert.match(html, /<option value="welcome">Welcome[^<]*<\/option>/);
});
