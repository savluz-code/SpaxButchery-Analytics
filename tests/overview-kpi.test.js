'use strict';

// Regression guard for the state of main after PR #20 was restored while
// PRs #21-#24 remain rolled back. Three things must stay true:
//
//   1. Overview revenue / customer KPIs keep using live data (PR #26).
//   2. The PR #20 cloud-sync hardening (blank-record rejection, no destructive
//      empty-cloud writes, Apps Script lock, actionable errors) is present.
//   3. The cloud-sync code introduced by PRs #21-#24 is still gone, so that
//      re-applying them one at a time is a clean, attributable change.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const gasSource = fs.readFileSync(path.join(root, 'google-apps-script.gs'), 'utf8');

function refreshAllBody() {
  const start = htmlSource.indexOf('function refreshAll(){');
  assert.notEqual(start, -1, 'refreshAll not found');
  const end = htmlSource.indexOf('function renderCustTable', start);
  assert.notEqual(end, -1, 'refreshAll end not found');
  return htmlSource.slice(start, end);
}

test('Overview KPIs source live product stats and customer list length', () => {
  const refreshAll = refreshAllBody();

  assert.match(refreshAll, /const totRev=getProductStats\(\)\.totalRevenue;/);
  assert.match(refreshAll, /const totCust=DB\.customers\.length;/);
  assert.doesNotMatch(refreshAll, /const totRev=totalRevenueAll\(\);/);
  assert.doesNotMatch(refreshAll, /const totCust=totalCustomerCount\(\);/);
  assert.doesNotMatch(refreshAll, /const totRev=REPORT\.totalRevenue\+DB\.importedRev;/);
});

test('PR #20 cloud-sync hardening helpers are present', () => {
  // Each name was added by PR #20 (commit bdef619); they must survive.
  const restoredSymbols = [
    'cloudRequest',       // fetch wrapper: timeout, HTTP/JSON errors
    'cloudLoad',          // config check + action=load via cloudRequest
    'validCloudCustomers' // rejects blank rows before any pull/overwrite
  ];

  for (const symbol of restoredSymbols) {
    assert.ok(
      htmlSource.includes(symbol),
      `${symbol} missing from index.html — PR #20 restoration is incomplete`
    );
  }
});

test('PR #21-#24 cloud-sync helpers are absent from the app', () => {
  // Each name was added by one of the still-reverted PRs; none of them may
  // survive alongside the #20 restoration.
  const revertedSymbols = [
    'cloudCustomerKey',   // #22
    'cloudWritesSuspended', // #22
    'setCloudWriteHold',  // #22
    'totalRevenueAll',    // #23
    'totalCustomerCount', // #23
    'healImportedAggregates',// #23
    'importedCustomerCount'  // #23
  ];

  for (const symbol of revertedSymbols) {
    assert.ok(
      !htmlSource.includes(symbol),
      `${symbol} still present in index.html — PR #20-only restoration is incomplete`
    );
  }
});

test('app shell and service worker still parse after the rollback', () => {
  const inline = [...htmlSource.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1] || '') && match[2].trim());

  assert.ok(inline.length > 0, 'no inline scripts found in index.html');
  inline.forEach((match, i) => {
    assert.doesNotThrow(
      () => new vm.Script(match[2], { filename: `index-inline-${i + 1}.js` }),
      `inline script #${i + 1} of index.html does not parse`
    );
  });

  assert.doesNotThrow(() => new vm.Script(gasSource, { filename: 'google-apps-script.gs' }));
  assert.doesNotThrow(
    () => new vm.Script(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), { filename: 'sw.js' })
  );
});

test('refreshAll executes without ReferenceError (e.g. TDZ on overview KPI variables)', () => {
  const domElements = {};
  function mockEl() {
    return {
      innerHTML: '',
      textContent: '',
      value: '',
      style: {},
      classList: { contains: () => false, add: () => {}, remove: () => {} },
      addEventListener: () => {},
      appendChild: () => {},
      getContext: () => ({}),
      querySelector: () => mockEl(),
      querySelectorAll: () => []
    };
  }
  const locationMock = { hash: '' };
  const navigatorMock = { serviceWorker: { register: () => Promise.resolve() } };
  const windowMock = {
    addEventListener: () => {},
    location: locationMock,
    navigator: navigatorMock
  };
  const documentMock = {
    getElementById: (id) => domElements[id] || (domElements[id] = mockEl()),
    querySelector: () => mockEl(),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => mockEl(),
    body: mockEl()
  };
  const sandbox = {
    window: windowMock,
    location: locationMock,
    navigator: navigatorMock,
    document: documentMock,
    AbortController: globalThis.AbortController,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => {},
    clearTimeout: () => {},
    Chart: class { static defaults = { color: '', borderColor: '' }; destroy() {} },
    Papa: {},
    XLSX: {},
    pdfjsLib: { GlobalWorkerOptions: {} },
    Tesseract: {},
    $: (id) => domElements[id] || (domElements[id] = mockEl()),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ success: true, customers: [] })) })
  };
  sandbox.window.document = documentMock;

  const inline = [...htmlSource.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1] || '') && match[2].trim());

  const ctx = vm.createContext(sandbox);
  inline.forEach(match => vm.runInContext(match[2], ctx));

  assert.doesNotThrow(() => {
    ctx.refreshAll();
  }, 'refreshAll threw an error during execution');
});
