'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const ONE_SMS = 160; // GSM-7

// Run the shipped TEMPLATES/fill/genericMsg/smsInfo code rather than a copy.
function loadOutreach() {
  const start = html.indexOf('const TEMPLATES={');
  const end = html.indexOf('/* ══════════ COMEBACK SEND', start);
  const firstStart = html.indexOf('function firstName(');
  const firstEnd = html.indexOf('\n', firstStart);
  assert.ok(start !== -1 && end > start, 'TEMPLATES block not found');
  assert.ok(firstStart !== -1 && firstEnd > firstStart, 'firstName() not found');
  const source = html.slice(firstStart, firstEnd) + '\n' + html.slice(start, end) +
    '\nthis.TEMPLATES=TEMPLATES;this.fill=fill;this.genericMsg=genericMsg;this.smsInfo=smsInfo;';
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  return sandbox;
}

const { TEMPLATES, fill, genericMsg, smsInfo } = loadOutreach();

test('thanks template says "Thanks for shopping with us"', () => {
  assert.equal(typeof TEMPLATES.thanks, 'string');
  assert.match(TEMPLATES.thanks, /Thanks for shopping with us/i);
});

test('thanks template fits one SMS for every recipient, however long the name', () => {
  const names = ['A', 'Amina Ali', 'Wanjiku', 'Njeri Wambui Mwangi', 'Abdullahi Mohammed Hussein'];
  for (const name of names) {
    const msg = fill(TEMPLATES.thanks, { name, spent: 1250, visits: 4, days: 2 });
    const info = smsInfo(msg);
    assert.equal(info.encoding, 'GSM-7', `${name}: ${info.encoding}`);
    assert.ok(info.units <= ONE_SMS, `${name}: ${info.units} units`);
    assert.equal(info.segments, 1, `${name}: ${info.segments} segments`);
    assert.doesNotMatch(msg, /\{[a-z]+\}/);
  }
  const shared = genericMsg(TEMPLATES.thanks);
  assert.doesNotThrow(() => smsInfo(shared));
  assert.equal(smsInfo(shared).segments, 1, shared);
  assert.doesNotMatch(shared, /\{[a-z]+\}/);
});

test('smsInfo counts GSM-7 characters, extensions and the 160/153 boundary', () => {
  const plain = smsInfo('a'.repeat(160));
  assert.equal(plain.encoding, 'GSM-7');
  assert.equal(plain.units, 160);
  assert.equal(plain.segments, 1);

  const over = smsInfo('a'.repeat(161));
  assert.equal(over.units, 161);
  assert.equal(over.segments, 2);

  // Extension-table characters are billed twice (^ { } \ [ ~ ] | €).
  const extended = smsInfo('{' + 'a'.repeat(159));
  assert.equal(extended.encoding, 'GSM-7');
  assert.equal(extended.units, 161);
  assert.equal(extended.segments, 2);

  // The shared welcome version is GSM-7 safe only if it has no emoji; the emoji
  // in the welcome template therefore switches it to UCS-2.
  assert.equal(smsInfo(TEMPLATES.welcome).encoding, 'UCS-2');
  assert.equal(smsInfo(TEMPLATES.welcome).segments, 1);
});

test('smsInfo switches to UCS-2 with its 70/67 boundary once an emoji appears', () => {
  const atLimit = smsInfo('a'.repeat(69) + '🥩');
  assert.equal(atLimit.encoding, 'UCS-2');
  assert.equal(atLimit.units, 71);
  assert.equal(atLimit.segments, 2);

  const emojiOnly = smsInfo('🥩');
  assert.equal(emojiOnly.encoding, 'UCS-2');
  assert.equal(emojiOnly.units, 2);
  assert.equal(emojiOnly.segments, 1);
});

test('Outreach picker offers the thanks template and shows the SMS count', () => {
  assert.match(html, /<option value="thanks">Thank you \(one SMS\)<\/option>/);
  assert.match(html, /id="tplSms"/);
});
