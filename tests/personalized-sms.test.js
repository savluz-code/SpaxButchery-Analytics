'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createServer } = require('../sms-gateway/server');

const config = { apiKey: 'provider-secret', username: 'sandbox', token: 'x'.repeat(32), origin: 'https://app.example', sandbox: true };
async function withGateway(provider, run) {
  const server = createServer(config, provider);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}/sms`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function request(url, body, overrides = {}) {
  return fetch(url, { method: 'POST', headers: { Origin: config.origin, Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json', ...overrides }, body: JSON.stringify(body) });
}

test('gateway authenticates and submits a single personalized message without exposing credentials', async () => {
  let calls = 0;
  await withGateway(async (url, opts) => {
    calls++;
    assert.equal(url, 'https://api.sandbox.africastalking.com/version1/messaging');
    assert.equal(opts.headers.apiKey, config.apiKey);
    const body = new URLSearchParams(opts.body);
    assert.equal(body.get('to'), '+254712345678');
    assert.equal(body.get('message'), 'Hi Amina!');
    return { ok: true, json: async () => ({ SMSMessageData: { Recipients: [{ number: '+254712345678', statusCode: 101, messageId: 'id1' }] } }) };
  }, async url => {
    assert.equal((await request(url, { to: '+254712345678', message: 'Hi Amina!' }, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await request(url, { to: '+254712345678', message: 'Hi Amina!' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request(url, { to: '072***678', message: 'Hi!' })).status, 400);
    const res = await request(url, { to: '+254712345678', message: 'Hi Amina!' });
    assert.deepEqual(await res.json(), { status: 'accepted', code: 101, messageId: 'id1', cost: '' });
    assert.equal(calls, 1);
  });
});

test('gateway reports provider rejection separately from uncertain outcomes', async () => {
  let code = 405;
  await withGateway(async () => ({ ok: true, json: async () => ({ SMSMessageData: { Recipients: [{ number: '+254712345678', statusCode: code, status: 'No balance' }] } }) }), async url => {
    let res = await request(url, { to: '+254712345678', message: 'Hi' });
    assert.equal((await res.json()).status, 'rejected');
    code = 500;
    res = await request(url, { to: '+254712345678', message: 'Hi' });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).status, 'unknown');
  });
});

function boot(pool, fetchImpl, confirmed = true) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const source = html.slice(html.indexOf('function bulkKenyanPhone('), html.indexOf("$('bulkPersonalSMS').onclick=sendPersonalBulk;") + "$('bulkPersonalSMS').onclick=sendPersonalBulk;".length);
  const elements = { bulkPersonalSMS: {}, personalSMSStatus: {}, tplText: { value: 'Hi {firstname}, {days} days!' }, smsGatewayUrl: { value: 'https://gateway.example/sms' }, smsGatewayToken: { value: 'secret' } };
  const sandbox = { URL, Set, console, $: id => elements[id], selectedPool: () => pool, fill: (t,c) => t.replace('{firstname}', c.name.split(' ')[0]).replace('{days}', c.days), fetch: fetchImpl, confirm: () => confirmed };
  vm.runInNewContext(source, sandbox);
  return { elements, send: sandbox.sendPersonalBulk };
}

test('campaign sends personalized messages once per valid selected phone', async () => {
  const sent = [];
  const { elements, send } = boot([{ name:'Amina Ali', contact:'0712345678', days:42 }, { name:'John Doe', contact:'+254 111 222 333', days:10 }, { name:'Duplicate', contact:'+254712345678', days:1 }, { name:'Masked', contact:'07***678', days:3 }], async (url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok:true, json:async()=>({ status:'accepted', messageId:'id' }) };
  });
  await send();
  assert.deepEqual(sent, [{ to:'+254712345678', message:'Hi Amina, 42 days!' }, { to:'+254111222333', message:'Hi John, 10 days!' }]);
  assert.match(elements.personalSMSStatus.textContent, /Provider accepted: 2; rejected: 0; unknown: 0; not attempted: 0; skipped invalid: 1; skipped duplicates: 1/);
  assert.equal(elements.bulkPersonalSMS.disabled, false);
});

test('unknown outcome stops campaign and identifies unattempted recipients', async () => {
  let count = 0;
  const { elements, send } = boot([{ name:'A', contact:'0712345678', days:1 }, { name:'B', contact:'0712345679', days:2 }], async () => { count++; throw Error('offline'); });
  await send();
  assert.equal(count, 1);
  assert.match(elements.personalSMSStatus.textContent, /unknown: 1; not attempted: 1/);
  assert.match(elements.personalSMSStatus.textContent, /B \(\+254712345679\): not attempted/);
});

test('cancelling confirmation never submits', async () => {
  let calls = 0;
  const { send } = boot([{ name:'A', contact:'0712345678', days:1 }], async () => { calls++; }, false);
  await send();
  assert.equal(calls, 0);
});
