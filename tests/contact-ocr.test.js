'use strict';

// Phone screenshots show the Kenyan number first, then a wrapped sender name,
// followed by unrelated text such as "New Account balance". Pin the real
// parser from index.html so the resolver keeps only the name and phone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const slice = (startText, endText) => {
  const start = html.indexOf(startText);
  assert.notEqual(start, -1, `missing source start: ${startText}`);
  const end = html.indexOf(endText, start);
  assert.notEqual(end, -1, `missing source end: ${endText}`);
  return html.slice(start, end);
};

const helpers = slice('function toTitleCase(str) {', 'function daysSince(dateStr) {');
const merchant = slice('function isMerchant(name) {', 'let _purgeBusy');
const parser = slice('function findContactPhoneMatch(line) {', '/* ══════════ FILE ROUTER');
const context = vm.createContext({});
vm.runInContext(`${helpers}\n${merchant}\n${parser}`, context);
const parse = text => JSON.parse(JSON.stringify(context.parseContactListFromText(text)));

test('M-Pesa phone screenshots return only the number and wrapped sender name', () => {
  const ocr = [
    'Message',
    'received from',
    '254723280296',
    'DAVID OTIENO',
    'ODUNDO. New',
    'Account balance is KES 410.00',
    'Message',
    'received from 254708967580 KELVIN',
    'ODHIAMBO',
    'AMOLO. New Account balance',
    'received from',
    '254 725 654 068',
    'EVALYN MUGEHA',
    'AGIDA. New',
    'Account balance'
  ].join('\n');

  assert.deepEqual(parse(ocr), [
    { name: 'David Otieno Odundo', phone: '0723280296' },
    { name: 'Kelvin Odhiambo Amolo', phone: '0708967580' },
    { name: 'Evalyn Mugeha Agida', phone: '0725654068' }
  ]);
});

test('notification names can be on one line and a local or international number is normalized', () => {
  const ocr = 'received from +254 742 447 130\nISAAC Njoroge Wango. New Account balance';
  assert.deepEqual(parse(ocr), [
    { name: 'Isaac Njoroge Wango', phone: '0742447130' }
  ]);
});

test('notification labels, balance text, and number-only alerts are never contacts', () => {
  const ocr = [
    'Message',
    'received from',
    '254723280296',
    'New Account balance is KES 1,200.00',
    'Merchant Payment from Jane Doe 254711122233 Completed 2026-11-03 10:20:00'
  ].join('\n');
  assert.deepEqual(parse(ocr), []);
});

test('normal name-before-phone contact-list OCR still works', () => {
  assert.deepEqual(parse('Ruth Emilly, +254 723 456 321'), [
    { name: 'Ruth Emilly', phone: '0723456321' }
  ]);
});

test('merchant contact remains excluded from the resolver', () => {
  const ocr = 'received from 254712345678\nSimon Musyoka. New Account balance';
  assert.deepEqual(parse(ocr), []);
});

test('Contact Resolver renders extracted values as readable name/contact rows', () => {
  const elements = new Map();
  const makeElement = id => ({
    id, style: {}, _text: '', children: [],
    get textContent() { return this._text; },
    set textContent(value) { this._text = String(value); if (this._text === '') this.children = []; },
    appendChild(child) { this.children.push(child); return child; }
  });
  const document = { createElement: makeElement };
  const ui = slice('let resolverExtractedContacts = [];', '/* ══════════ CONTACT EDIT');
  const uiContext = vm.createContext({
    document,
    $: id => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); },
    resolveContacts: contacts => contacts.length
  });
  vm.runInContext(`${helpers}\n${ui}`, uiContext);
  uiContext.renderResolverExtractedContacts([
    { name: 'Alice Achieng', phone: '254723456321' },
    { name: '<img src=x>', phone: '0723456322' }
  ], true);

  const wrap = elements.get('resolverExtractedWrap');
  const count = elements.get('resolverExtractedCount');
  const body = elements.get('resolverExtractedBody');
  assert.equal(wrap.style.display, 'block');
  assert.equal(count.textContent, '2 found');
  assert.equal(body.children.length, 2);
  assert.deepEqual(body.children.map(row => row.children.map(cell => cell.textContent)), [
    ['Alice Achieng', '0723456321'],
    ['<img src=x>', '0723456322']
  ]);

  uiContext.renderResolverExtractedContacts([
    { name: 'Alice Achieng Longer', phone: '0723456321' }
  ]);
  assert.equal(elements.get('resolverExtractedCount').textContent, '2 found', 'same phone is not duplicated across files');
  assert.equal(elements.get('resolverExtractedBody').children[0].children[0].textContent, 'Alice Achieng Longer');
});
