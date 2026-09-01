'use strict';

// Regression guard for the U+2212 "−" dash-cell M-Pesa parser corruption.
//
// Root cause: newer Safaricom statements print U+2212 (MINUS SIGN, "\u2212")
// in the unused amount column ("...Completed 320.00 − 19,660.50") and glued to
// fee amounts ("...Completed −3.85 - 19,340.50"). regex2's dash class only
// listed ASCII "-", en-dash and em-dash, so:
//   - every U+2212 row failed to anchor at ITS OWN "Completed", and
//   - the lazy [\s\S]*? slid to the NEXT row's "Completed", booking a phantom
//     row with the next row's amount AND stealing the anchor row's dedup key —
//     the real payment was then dropped as a "duplicate".
// The slide was ORDER-DEPENDENT (fee-first vs payment-first rows produced
// different row counts on identical statements).
//
// The fix must keep four things true:
//   1. U+2212 is accepted as a dash cell in regex2 / the fallback / the
//      Withdrawn-first check (a glued U+2212 amount is a valid cell too).
//   2. Cross-row slides are rejected in BOTH passes (crossed1/crossed2 → skip),
//      so no match may ever book a "Completed" that belongs to a later row.
//   3. Fee rows ("...Charge" wording) are still rejected BEFORE their dedup
//      key is claimed, so the payment sharing the receipt/time is not dropped.
//   4. Row order (fee-first / payment-first / no-fee) must not change output.

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadApp } = require('./_mpesa-harness.js');

const MINUS = '\u2212';
const fee = 'UHN9A4YL7L 2026-08-31 16:52:19 Pay merchant Charge Completed ' + MINUS + '3.85 - 19340.50';
const elena = 'UHN9A4YL7L 2026-08-31 16:52:19 Merchant Payment from ELENA KAMANDE 0723 123456 Completed 50.00 0.00 19340.50';
const john = 'UHVH4T4SL28 2026-08-31 16:53:01 Merchant Payment from JOHN MWANGI 0722 111222 Completed 320.00 ' + MINUS + ' 19660.50';
const jane = 'UHV1J44VCHA 2026-08-31 16:54:12 Small Business Pay Merchant from JANE WANJIKU 0733 333444 Completed 1500.00 0.00 21160.50';
const peter = 'TFT1UWWUZR 2026-08-31 16:55:02 Merchant Payment from PETER OTIENO 0745 555666 Completed 850.00 ' + MINUS + ' 22010.50';

function checkRows(rows, msg) {
  assert.equal(rows.length, 4, msg + ': row count');
  assert.equal(rows.possibleMissed, 0, msg + ': possibleMissed');
  const sum = rows.reduce((a, r) => a + r.amount, 0);
  assert.equal(sum.toFixed(2), '2720.00', msg + ': sum');
  const byReceipt = Object.fromEntries(rows.map(r => [r.receipt, r]));
  assert.equal(byReceipt.UHN9A4YL7L.amount, 50, msg + ': Elena amount');
  assert.equal(byReceipt.UHVH4T4SL28.amount, 320, msg + ': John amount');
  assert.equal(byReceipt.UHV1J44VCHA.amount, 1500, msg + ': Jane amount');
  assert.equal(byReceipt.TFT1UWWUZR.amount, 850, msg + ': Peter amount');
  // Names must be clean (no cross-row pollution like
  // "John Mwangi Completed . . Uhv J Vcha - - Small Business Pay").
  assert.equal(byReceipt.UHVH4T4SL28.name, 'John Mwangi', msg + ': John name');
  assert.equal(byReceipt.UHV1J44VCHA.name, 'Jane Wanjiku', msg + ': Jane name');
}

test('U+2212 single-line page parses all 4 payments (fee excluded, no phantom, no missed)', () => {
  const app = loadApp();
  const page = [fee, elena, john, jane, peter].join(' ');
  checkRows(app.parseMpesaText(page), 'fee-first');
});

test('U+2212 result is order-independent (fee-first / payment-first / no-fee)', () => {
  const app = loadApp();
  checkRows(app.parseMpesaText([elena, fee, john, jane, peter].join(' ')), 'elena-first');
  checkRows(app.parseMpesaText([elena, john, jane, peter].join(' ')), 'no-fee');
});

test('ASCII dash control: same rows parse with "-" instead of U+2212', () => {
  const app = loadApp();
  const page = [
    fee.replace(MINUS, '-'),
    elena,
    john.replace(MINUS, '-'),
    jane,
    peter.replace(MINUS, '-')
  ].join(' ');
  checkRows(app.parseMpesaText(page), 'ascii');
});
