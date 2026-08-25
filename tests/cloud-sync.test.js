'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const gasSource = fs.readFileSync(path.join(root, 'google-apps-script.gs'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function gasContext(overrides = {}) {
  const context = vm.createContext({ console, ...overrides });
  vm.runInContext(gasSource, context, { filename: 'google-apps-script.gs' });
  return context;
}

function syncContext(overrides = {}) {
  const start = htmlSource.indexOf("const GAS_URL =");
  const end = htmlSource.indexOf('function addSyncUI()', start);
  assert.notEqual(start, -1, 'sync script start not found');
  assert.notEqual(end, -1, 'sync script end not found');

  const storage = new Map();
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  const context = vm.createContext({
    console,
    localStorage,
    setTimeout,
    clearTimeout,
    ...overrides
  });
  const source = htmlSource.slice(start, end) + `
    globalThis.__syncTests = {
      cloudRequest,
      validCloudCustomers,
      cloudCustomerKey,
      setCloudWriteHold,
      isWriteHeld: () => cloudWritesSuspended
    };
  `;
  vm.runInContext(source, context, { filename: 'index-sync.js' });
  return { context, storage, api: context.__syncTests };
}

test('Google Sheet headers accept common title-case export formats', () => {
  const context = gasContext();
  const sheet = {
    getDataRange: () => ({
      getValues: () => [
        ['Name', 'First Visit', 'LAST_VISIT', 'Is New', 'seed-spent', 'Imported At', 'Custom Header'],
        ['Jane Doe', '2026-01-02', '2026-08-01', true, 1250, '2026-08-24', 'kept']
      ]
    })
  };

  const rows = context.rowsToObjects_(sheet);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(rows[0])), {
    name: 'Jane Doe',
    firstVisit: '2026-01-02',
    lastVisit: '2026-08-01',
    isNew: true,
    seedSpent: 1250,
    importedAt: '2026-08-24',
    'custom Header': 'kept'
  });
});

test('configured spreadsheet failures never create a silent fallback database', () => {
  let deleted = false;
  let created = false;
  const props = {
    getProperty: () => 'known-sheet-id',
    setProperty: () => assert.fail('must not replace configured spreadsheet ID'),
    deleteProperty: () => { deleted = true; }
  };
  const context = gasContext({
    PropertiesService: { getScriptProperties: () => props },
    SpreadsheetApp: {
      openById: () => { throw new Error('temporary permission failure'); },
      getActiveSpreadsheet: () => null,
      create: () => { created = true; return { getId: () => 'replacement' }; }
    }
  });

  assert.throws(
    () => context.getSpreadsheet_(),
    /saved ID was kept so no fallback database was created/
  );
  assert.equal(deleted, false);
  assert.equal(created, false);
});

test('standalone Apps Script creates and remembers a database only when no ID exists', () => {
  let saved;
  const createdSheet = { getId: () => 'new-sheet-id' };
  const context = gasContext({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: () => null,
        setProperty: (key, value) => { saved = [key, value]; }
      })
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => null,
      create: name => {
        assert.equal(name, 'SpaxButchery Cloud Data');
        return createdSheet;
      }
    }
  });

  assert.equal(context.getSpreadsheet_(), createdSheet);
  assert.deepEqual(saved, ['SPAX_SPREADSHEET_ID', 'new-sheet-id']);
});

test('cloud request falls back cleanly when AbortController is unavailable', async () => {
  let requestOptions;
  const { api } = syncContext({
    AbortController: undefined,
    fetch: async (_url, options) => {
      requestOptions = options;
      return { ok: true, status: 200, text: async () => '{"success":true,"customers":[]}' };
    }
  });

  const result = await api.cloudRequest('https://example.test/exec');
  assert.equal(result.success, true);
  assert.equal(requestOptions.redirect, 'follow');
  assert.equal('signal' in requestOptions, false);
});

test('cloud customer validation trims names and uses case-insensitive merge keys', () => {
  const { api } = syncContext({ AbortController: undefined, fetch: async () => assert.fail('not used') });
  const customers = api.validCloudCustomers([
    null,
    {},
    { name: '   ' },
    { name: '  JANE   DOE  ', visits: 2 }
  ]);

  assert.equal(customers.length, 1);
  assert.equal(customers[0].name, 'JANE DOE');
  assert.equal(api.cloudCustomerKey(customers[0]), 'jane doe');
});

test('local recovery write hold persists until explicitly cleared', () => {
  const { api, storage } = syncContext({ AbortController: undefined, fetch: async () => assert.fail('not used') });
  api.setCloudWriteHold(true);
  assert.equal(api.isWriteHeld(), true);
  assert.equal(storage.get('spaxCloudWriteHold_v1'), '1');

  api.setCloudWriteHold(false);
  assert.equal(api.isWriteHeld(), false);
  assert.equal(storage.has('spaxCloudWriteHold_v1'), false);
});
