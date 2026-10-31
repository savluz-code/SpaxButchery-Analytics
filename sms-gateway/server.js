'use strict';

// A small, authenticated bridge: provider credentials never enter the browser.
const http = require('node:http');
const crypto = require('node:crypto');

function createServer(config, send = fetch) {
  if (!config.apiKey || !config.username || !config.token || !config.origin) throw new Error('Missing SMS gateway configuration');
  if (config.token.length < 32) throw new Error('SMS_GATEWAY_TOKEN must be at least 32 characters');
  const origin = new URL(config.origin).origin;
  if (origin !== config.origin || !/^https?:\/\//.test(origin)) throw new Error('SMS_ALLOWED_ORIGIN must be an exact origin');
  const endpoint = config.sandbox ? 'https://api.sandbox.africastalking.com/version1/messaging' : 'https://api.africastalking.com/version1/messaging';
  function respond(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' });
    res.end(JSON.stringify(data));
  }
  return http.createServer(async (req, res) => {
    if (req.headers.origin !== origin) return respond(res, 403, { error: 'Origin not allowed' });
    if (req.method === 'OPTIONS' && req.url === '/sms') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Vary': 'Origin' });
      return res.end();
    }
    if (req.method !== 'POST' || req.url !== '/sms') return respond(res, 404, { error: 'Not found' });
    const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
    const expected = Buffer.from(config.token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return respond(res, 401, { error: 'Unauthorized' });
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192) return respond(res, 413, { error: 'Request too large' });
      }
      const data = JSON.parse(body);
      if (!/^\+254[17]\d{8}$/.test(data.to) || typeof data.message !== 'string' || !data.message.trim() || data.message.length > 1500) {
        return respond(res, 400, { error: 'Invalid Kenyan mobile number or message (maximum 1500 characters)' });
      }
      const form = new URLSearchParams({ username: config.username, to: data.to, message: data.message });
      if (config.senderId) form.set('from', config.senderId);
      let result;
      try {
        const response = await send(endpoint, { method: 'POST', headers: { apiKey: config.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.timeout(20000) });
        // Even an HTTP error can arrive after a provider has accepted a request.
        if (!response.ok) return respond(res, 502, { status: 'unknown', detail: 'Provider response was not successful; verify before retrying.' });
        result = await response.json();
      } catch (_) {
        return respond(res, 502, { status: 'unknown', detail: 'Provider response unavailable; verify before retrying.' });
      }
      const recipient = result && result.SMSMessageData && result.SMSMessageData.Recipients && result.SMSMessageData.Recipients[0];
      if (!recipient || recipient.number !== data.to || !Number.isInteger(recipient.statusCode)) return respond(res, 502, { status: 'unknown', detail: 'Unrecognized provider response; verify before retrying.' });
      const code = recipient.statusCode;
      if ([100, 101, 102].includes(code)) return respond(res, 200, { status: 'accepted', code, messageId: recipient.messageId || '', cost: recipient.cost || '' });
      // Only explicit rejection codes are safe to call failures; anything else is uncertain.
      if ([402, 403, 404, 405, 406, 407, 409, 502].includes(code)) return respond(res, 200, { status: 'rejected', code, detail: String(recipient.status || 'Rejected').slice(0, 100) });
      return respond(res, 502, { status: 'unknown', detail: 'Unrecognized provider status; verify before retrying.' });
    } catch (_) { return respond(res, 400, { error: 'Invalid request' }); }
  });
}

if (require.main === module) {
  const server = createServer({ apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME, token: process.env.SMS_GATEWAY_TOKEN, origin: process.env.SMS_ALLOWED_ORIGIN, senderId: process.env.AT_SENDER_ID, sandbox: process.env.AT_SANDBOX === '1' });
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('SMS gateway listening'));
}
module.exports = { createServer };
