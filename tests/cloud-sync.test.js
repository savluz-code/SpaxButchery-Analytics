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
      isWriteHeld: () => cloudWritesSuspended,
      healImportedAggregates,
      importedCustomerCount
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

test('settings counters round-trip through the Apps Script sheets', () => {
  function mockSheet() {
    let values = [];
    return {
      getDataRange: () => ({ getValues: () => values }),
      clearContents: () => { values = []; },
      getRange: (row, col, numRows, numCols) => ({
        setValues: grid => {
          while (values.length < row + numRows - 1) values.push([]);
          for (let i = 0; i < numRows; i++) {
            const target = row - 1 + i;
            while (values[target].length < col + numCols - 1) values[target].push('');
            for (let j = 0; j < numCols; j++) values[target][col - 1 + j] = grid[i][j];
          }
        }
      })
    };
  }
  const sheets = {};
  const ss = {
    getSheetByName: name => sheets[name] || null,
    insertSheet: name => { sheets[name] = mockSheet(); return sheets[name]; }
  };
  const context = gasContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'sheet-id', setProperty: () => {} }) },
    SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => null },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) }
  });

  context.saveAll_({
    customers: [{ name: 'Jane Doe', spent: 100, visits: 2, newBatch: 3, isSeed: false }],
    monthly: { labels: ['2026-08'], revenue: [500] },
    settings: { importedRev: 652310, importedTx: 412, resolved: 38, importBatch: 3 },
    transactions: [{ date: '2026-08-01', amount: 500, name: 'Jane Doe', receipt: 'QGH7XTRN7Y' }],
    customerTx: { 'Jane Doe': [{ date: '2026-08-01', amount: 500 }] },
    seen: { 'receipt|QGH7XTRN7Y|2026-08-01|': 1 }
  });

  const loaded = context.loadAll_();
  assert.equal(Number(loaded.settings.importedRev), 652310);
  assert.equal(Number(loaded.settings.importedTx), 412);
  assert.equal(Number(loaded.settings.importBatch), 3);
  assert.equal(loaded.customers[0].newBatch, 3);
  assert.equal(loaded.seen['receipt|QGH7XTRN7Y|2026-08-01|'], 1);
});

test('healImportedAggregates rebuilds zeroed counters from the synced data', () => {
  const { context, api } = syncContext({
    AbortController: undefined,
    fetch: async () => assert.fail('not used'),
    isMerchant: name => /simon\s+musyoka/i.test(String(name || ''))
  });
  context.DB = {
    importedRev: 0, // Settings sheet was zeroed — the "1250K" bug
    importedTx: 0,
    customers: [
      { name: 'Seed Customer', isSeed: true, seedSpent: 500, seedVisits: 1, newBatch: 0 },
      { name: 'Imported One', newBatch: 3 },
      { name: 'Aggregate Row', newBatch: 0 }
    ],
    transactions: [
      { name: 'Imported One', amount: 250, receipt: 'R1', date: '2026-08-01' },
      { name: 'Imported One', amount: 120, receipt: 'R2', date: '2026-08-02' },
      { name: 'Walk In', amount: 80, receipt: 'R3', date: '2026-08-03' },        // matches no customer → counts in full
      { name: 'Seed Customer', amount: 300, receipt: 'R4', date: '2026-07-01' },
      { name: 'Seed Customer', amount: 300, receipt: 'R5', date: '2026-08-04' }, // history 600 vs seed 500 → +100 only
      { name: 'Anyone', amount: 999, receipt: 'R6', backfillOnly: true },        // history-only → never counts
      { name: 'Simon Musyoka', amount: 500, receipt: 'R7', date: '2026-08-05' }  // merchant → never counts
    ]
  };

  const healed = api.healImportedAggregates();
  assert.equal(healed.importedRev, true);
  assert.equal(healed.importedTx, true);
  // 250 + 120 + 80 + max(0, 600 - 500)
  assert.equal(context.DB.importedRev, 550);
  // 3 non-seed rows + max(0, 2 seed rows - 1 seed visit)
  assert.equal(context.DB.importedTx, 4);
});

test('healImportedAggregates never lowers a counter the data cannot justify', () => {
  const { context, api } = syncContext({
    AbortController: undefined,
    fetch: async () => assert.fail('not used')
  });
  context.DB = {
    importedRev: 10000,
    importedTx: 50,
    customers: [{ name: 'Imported One', newBatch: 1 }],
    transactions: [{ name: 'Imported One', amount: 250, receipt: 'R1', date: '2026-08-01' }]
  };

  const healed = api.healImportedAggregates();
  assert.equal(healed.importedRev, undefined);
  assert.equal(healed.importedTx, undefined);
  assert.equal(context.DB.importedRev, 10000);
  assert.equal(context.DB.importedTx, 50);
});

test('importedCustomerCount stays stable across import batches', () => {
  const { context, api } = syncContext({
    AbortController: undefined,
    fetch: async () => assert.fail('not used')
  });
  context.DB = {
    customers: [
      { name: 'Seed', isSeed: true, newBatch: 5 },  // seed rows are inside the report baseline
      { name: 'Batch1', newBatch: 1 },              // earlier batch — used to vanish from the KPI
      { name: 'Batch2', newBatch: 2 },
      { name: 'Latest', newBatch: 3, isNew: true },
      { name: 'Aggregate', newBatch: 0 },           // pre-baseline history — never counted
      { name: 'No Batch' }
    ]
  };

  assert.equal(api.importedCustomerCount(), 3);
});

test('Overview KPIs source live product stats and customer list length', () => {
  const start = htmlSource.indexOf('function refreshAll(){');
  assert.notEqual(start, -1, 'refreshAll not found');
  const end = htmlSource.indexOf('function renderCustTable', start);
  assert.notEqual(end, -1, 'refreshAll end not found');
  const refreshAll = htmlSource.slice(start, end);

  assert.match(refreshAll, /const totRev=getProductStats\(\)\.totalRevenue;/);
  assert.match(refreshAll, /const totCust=DB\.customers\.length;/);
  assert.doesNotMatch(refreshAll, /const totRev=totalRevenueAll\(\);/);
  assert.doesNotMatch(refreshAll, /const totCust=totalCustomerCount\(\);/);
  assert.doesNotMatch(refreshAll, /const totRev=REPORT\.totalRevenue\+DB\.importedRev;/);
});
