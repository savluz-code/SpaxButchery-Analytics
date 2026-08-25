'use strict';

// Regression guard for the state of main after PRs #20-#24 were rolled back
// (see "Revert PR #20..#24" commits). Two things must stay true:
//
//   1. Overview revenue / customer KPIs keep using live data (PR #26).
//   2. The cloud-sync code introduced by PRs #20-#24 is fully gone, so that
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

test('PR #20-#24 cloud-sync helpers are absent from the rolled-back app', () => {
  // Each name was added by one of the reverted PRs; none of them may survive.
  const revertedSymbols = [
    'validCloudCustomers',   // #20 / #22
    'cloudCustomerKey',      // #20 / #22
    'cloudWritesSuspended',  // #20 / #22
    'setCloudWriteHold',     // #20 / #22
    'totalRevenueAll',       // #23
    'totalCustomerCount',    // #23
    'healImportedAggregates',// #23
    'importedCustomerCount'  // #23
  ];

  for (const symbol of revertedSymbols) {
    assert.ok(
      !htmlSource.includes(symbol),
      `${symbol} still present in index.html — PR #20-#24 rollback is incomplete`
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
