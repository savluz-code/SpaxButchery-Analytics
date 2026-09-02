'use strict';
// Shared harness: load index.html's inline script into a vm sandbox (same
// technique as overview-kpi.test.js) and expose the M-Pesa parser functions.
// Optional `opts`:
//   fetch        - custom fetch implementation (defaults to a stub returning
//                  { success: true, customers: [] })
//   setTimeout   - custom timer implementation (defaults to a no-op timer)
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function loadApp(opts = {}) {
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
  const windowMock = { addEventListener: () => {}, location: locationMock, navigator: navigatorMock };
  const documentMock = {
    getElementById: (id) => domElements[id] || (domElements[id] = mockEl()),
    querySelector: () => mockEl(),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => mockEl(),
    body: mockEl()
  };
  const store = {};
  const sandbox = {
    window: windowMock,
    location: locationMock,
    navigator: navigatorMock,
    document: documentMock,
    AbortController: globalThis.AbortController,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: opts.setTimeout || (() => {}),
    clearTimeout: () => {},
    Chart: class { static defaults = { color: '', borderColor: '' }; destroy() {} },
    Papa: {},
    XLSX: {},
    pdfjsLib: { GlobalWorkerOptions: {} },
    Tesseract: {},
    $: (id) => domElements[id] || (domElements[id] = mockEl()),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    fetch: opts.fetch || (() => Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ success: true, customers: [] })) }))
  };
  sandbox.window.document = documentMock;

  const inline = [...htmlSource.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1] || '') && match[2].trim());

  const ctx = vm.createContext(sandbox);
  inline.forEach(match => vm.runInContext(match[2], ctx));
  return ctx;
}

module.exports = { loadApp, root };
