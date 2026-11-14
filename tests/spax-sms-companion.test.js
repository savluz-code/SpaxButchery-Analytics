'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function createHarness(options = {}) {
  const firstStart = html.indexOf('function firstName(');
  const firstEnd = html.indexOf('\n', firstStart);
  const tplStart = html.indexOf('const TEMPLATES={');
  const tplEnd = html.indexOf('/* ══════════ COMEBACK SEND', tplStart);
  const phoneStart = html.indexOf('function bulkKenyanPhone(');
  const phoneEnd = html.indexOf('async function sendPersonalBulk(', phoneStart);
  const spaxStart = html.indexOf('/* ══════════ SPAX ANDROID SMS COMPANION');
  const spaxEnd = html.indexOf('/* ══════════ CONTACT RESOLVER', spaxStart);

  assert.ok(firstStart !== -1 && tplStart !== -1 && phoneStart !== -1 && spaxStart !== -1, 'Expected Outreach blocks in index.html');

  let source = [
    html.slice(firstStart, firstEnd),
    html.slice(tplStart, tplEnd),
    html.slice(phoneStart, phoneEnd),
    html.slice(spaxStart, spaxEnd)
  ].join('\n');

  if (options.bridgeUrl) {
    source = source.replace("'http://127.0.0.1:8765'", JSON.stringify(options.bridgeUrl));
  }

  const elements = {
    tplText: { value: options.template ?? "Hi {firstname}! We've missed you at SpaxButchery for {days} days. Are you ok?" },
    segSel: {
      value: 'lapsing',
      selectedIndex: 0,
      options: [{ text: '🟡 Lapsing (31–60 days)' }]
    },
    spaxBridgeBadge: { textContent: '', style: {} },
    spaxAppStatus: { textContent: '' },
    bulkStatus: { innerHTML: '' },
    spaxSmsAppDetails: { open: false, addEventListener: () => {} },
    bulkSpaxApp: {},
    spaxPushBtn: {},
    spaxShareBtn: {},
    spaxDownloadBtn: {},
    spaxCopyBtn: {},
    spaxPingBtn: {}
  };

  const toasts = [];
  const downloads = [];
  const windowObj = { location: { href: 'https://savluz-code.github.io/SpaxButchery-Analytics/' } };

  const sandbox = {
    console,
    Set,
    Date,
    Math,
    JSON,
    URL: {
      createObjectURL: blob => {
        downloads.push({ blob });
        return 'blob:spax-batch';
      },
      revokeObjectURL: () => {}
    },
    Blob: class MockBlob {
      constructor(parts, opts) {
        this.text = parts.join('');
        this.type = opts && opts.type;
      }
    },
    File: options.disableFile ? undefined : class MockFile {
      constructor(parts, name, opts) {
        this.text = parts.join('');
        this.name = name;
        this.type = opts && opts.type;
      }
    },
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval: () => 99,
    clearInterval: () => {},
    fetch: options.fetchImpl || fetch,
    navigator: options.navigator || {},
    document: {
      hidden: false,
      createElement: tag => {
        assert.equal(tag, 'a');
        return {
          href: '',
          download: '',
          click() { downloads[downloads.length - 1].filename = this.download; },
          remove() {}
        };
      },
      body: { appendChild() {} }
    },
    window: windowObj,
    $: id => elements[id],
    selectedPool: () => options.pool || [],
    escHtml: s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])),
    toast: msg => toasts.push(msg)
  };

  vm.runInNewContext(
    source + '\nthis.exports={genericMsg,fill,smsInfo,buildSpaxSmsBatch,checkSpaxSmsBridge,pollSpaxSmsStatusOnce,sendViaSpaxSmsApp};',
    sandbox
  );

  return { ...sandbox.exports, elements, toasts, downloads, windowObj };
}

test('genericMsg replaces "for {days} days" naturally without leaving "for days"', () => {
  const { genericMsg } = createHarness();
  assert.equal(
    genericMsg("Hi {firstname}! We've missed you at SpaxButchery for {days} days. Are you ok?"),
    "Hi there! We've missed you at SpaxButchery for a while. Are you ok?"
  );
  assert.equal(
    genericMsg("Hello {name}, we haven't seen you in {days} days!"),
    "Hello there, we haven't seen you in a while!"
  );
  assert.equal(
    genericMsg("Welcome back after {days} days away!"),
    "Welcome back after a while away!"
  );
});

test('buildSpaxSmsBatch personalizes every recipient, normalizes Kenyan phones, and skips masked/duplicates', () => {
  const pool = [
    { name: 'Stephen Mwangi', contact: '0712345678', spent: 4200, visits: 9, days: 48 },
    { name: 'Grace Ngei', contact: '+254 745 426 801', spent: 1850, visits: 4, days: 35 },
    { name: 'Airtel Customer', contact: '0110223344', spent: 900, visits: 2, days: 40 },
    { name: 'Duplicate Stephen', contact: '+254712345678', spent: 500, visits: 1, days: 31 },
    { name: 'Masked Contact', contact: '0723***321', spent: 3000, visits: 6, days: 50 },
    { name: 'Foreign Number', contact: '+14155550100', spent: 700, visits: 1, days: 45 }
  ];
  const { buildSpaxSmsBatch } = createHarness({ pool });
  const result = buildSpaxSmsBatch();
  assert.equal(result.error, undefined);
  assert.deepEqual(Array.from(result.invalid), ['Masked Contact', 'Foreign Number']);
  assert.deepEqual(Array.from(result.duplicate), ['Duplicate Stephen']);

  const { batch } = result;
  assert.equal(batch.app, 'spax-sms-batch');
  assert.equal(batch.version, 1);
  assert.equal(batch.segment, 'lapsing');
  assert.equal(batch.segmentLabel, '🟡 Lapsing (31–60 days)');
  assert.equal(batch.stats.selected, 6);
  assert.equal(batch.stats.queued, 3);
  assert.equal(batch.stats.skippedInvalid, 2);
  assert.equal(batch.stats.skippedDuplicate, 1);
  assert.equal(batch.stats.totalSegments, 3);
  assert.equal(batch.stats.hasUnicode, false);

  assert.equal(batch.messages[0].to, '+254712345678');
  assert.equal(batch.messages[0].message, "Hi Stephen! We've missed you at SpaxButchery for 48 days. Are you ok?");
  assert.equal(batch.messages[1].to, '+254745426801');
  assert.equal(batch.messages[1].message, "Hi Grace! We've missed you at SpaxButchery for 35 days. Are you ok?");
  assert.equal(batch.messages[2].to, '+254110223344');
});

test('sendViaSpaxSmsApp pushes personalized batch to local 127.0.0.1 bridge and launches spaxsms://campaign', async () => {
  let receivedBatch = null;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', 'https://savluz-code.github.io');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'GET' && req.url === '/ping') {
      res.end(JSON.stringify({ ok: true, app: 'spax-sms-companion', version: '1.0.0' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/queue') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        receivedBatch = JSON.parse(body);
        res.end(JSON.stringify({ ok: true, queued: receivedBatch.messages.length, status: 'READY' }));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bridgeUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const pool = [
      { name: 'Stephen', contact: '0712345678', spent: 1000, visits: 2, days: 48 },
      { name: 'Grace Ngei', contact: '0745426801', spent: 2000, visits: 5, days: 35 }
    ];
    const h = createHarness({ pool, bridgeUrl });
    assert.equal(await h.checkSpaxSmsBridge(1000), true);
    assert.match(h.elements.spaxBridgeBadge.textContent, /connected/i);

    const out = await h.sendViaSpaxSmsApp('auto');
    assert.equal(out.ok, true);
    assert.equal(out.method, 'bridge');
    assert.equal(out.queued, 2);
    assert.equal(receivedBatch.messages.length, 2);
    assert.equal(h.windowObj.location.href, 'spaxsms://campaign');
    assert.match(h.elements.spaxAppStatus.textContent, /Sent 2 personalized SMS/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('sendViaSpaxSmsApp respects 409 busy response when a campaign is already sending', async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 409;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'A campaign is currently sending (45/326). Pause or finish it first.' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bridgeUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = createHarness({
      pool: [{ name: 'Stephen', contact: '0712345678', spent: 1000, visits: 2, days: 48 }],
      bridgeUrl
    });
    const out = await h.sendViaSpaxSmsApp('auto');
    assert.equal(out.ok, false);
    assert.equal(out.method, 'busy');
    assert.match(h.elements.spaxAppStatus.textContent, /45\/326/);
    assert.equal(h.downloads.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('sendViaSpaxSmsApp falls back to Android Share Sheet file when bridge is asleep, or .json download on desktop', async () => {
  const sharedCalls = [];
  const offlineFetch = async () => { throw new Error('ECONNREFUSED'); };
  const pool = [{ name: 'Grace Ngei', contact: '0745426801', spent: 2000, visits: 5, days: 35 }];

  // Mobile browser with navigator.share({ files })
  const mobile = createHarness({
    pool,
    fetchImpl: offlineFetch,
    navigator: {
      canShare: () => true,
      share: async payload => { sharedCalls.push(payload); }
    }
  });
  const sharedRes = await mobile.sendViaSpaxSmsApp('auto');
  assert.equal(sharedRes.ok, true);
  assert.equal(sharedRes.method, 'share-file');
  assert.equal(sharedCalls.length, 1);
  assert.equal(sharedCalls[0].files.length, 1);
  const parsedFile = JSON.parse(sharedCalls[0].files[0].text);
  assert.equal(parsedFile.messages[0].to, '+254745426801');

  // Desktop browser without navigator.share -> downloads .json file
  const desktop = createHarness({
    pool,
    fetchImpl: offlineFetch,
    navigator: {}
  });
  const dlRes = await desktop.sendViaSpaxSmsApp('auto');
  assert.equal(dlRes.ok, true);
  assert.equal(dlRes.method, 'download');
  assert.equal(desktop.downloads.length, 1);
  assert.equal(desktop.downloads[0].filename, 'spax-sms-lapsing-1.json');
});

test('Share to App and main button share a Chromium-allowlisted text/plain (.txt) batch synchronously for 321+ recipients', async () => {
  // Build 321 distinct valid Kenyan mobile recipients (>40 KB JSON)
  const pool = Array.from({ length: 321 }, (_, idx) => ({
    name: `Customer ${idx + 1}`,
    contact: '07' + String(10000000 + idx).slice(0, 8),
    spent: 1500,
    visits: 3,
    days: 31 + (idx % 30)
  }));

  let fetchCalled = false;
  let shareCalledSynchronously = false;
  let syncTick = true;
  const sharedPayloads = [];

  // Emulate real Chromium Android Web Share allowlist:
  // - Rejects `application/json` (.json) files
  // - Permits `text/plain` (.txt) files
  const chromiumCanShare = data => {
    if (data && data.files) {
      return data.files.every(f => f.type === 'text/plain' && f.name.endsWith('.txt'));
    }
    return Boolean(data && data.text && data.text.length <= 16000);
  };

  const h = createHarness({
    pool,
    fetchImpl: async () => { fetchCalled = true; throw new Error('Should not fetch before share'); },
    navigator: {
      canShare: chromiumCanShare,
      share: async payload => {
        if (syncTick) shareCalledSynchronously = true;
        sharedPayloads.push(payload);
      }
    }
  });

  const promise = h.elements.bulkSpaxApp.onclick();
  syncTick = false;
  assert.equal(shareCalledSynchronously, true, 'navigator.share must fire synchronously inside user tap');
  assert.equal(fetchCalled, false, 'Main button must not await network fetch before opening Share Sheet');

  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.method, 'share-file');
  assert.equal(res.queued, 321);
  assert.equal(sharedPayloads.length, 1);
  assert.equal(sharedPayloads[0].files[0].type, 'text/plain');
  assert.equal(sharedPayloads[0].files[0].name, 'spax-sms-lapsing-321.txt');

  const parsed = JSON.parse(sharedPayloads[0].files[0].text);
  assert.equal(parsed.messages.length, 321);

  // Also verify closing the share sheet (AbortError) gives visible UI feedback instead of silent no-op
  const abortHarness = createHarness({
    pool: pool.slice(0, 2),
    navigator: {
      canShare: chromiumCanShare,
      share: async () => {
        const err = new Error('Share canceled');
        err.name = 'AbortError';
        throw err;
      }
    }
  });
  const abortRes = await abortHarness.elements.spaxShareBtn.onclick();
  assert.equal(abortRes.ok, false);
  assert.equal(abortRes.cancelled, true);
  assert.match(abortHarness.elements.spaxAppStatus.textContent, /Share menu closed/);
  assert.ok(abortHarness.toasts.length > 0, 'Cancelling share must show feedback toast');
});

test('Android companion app project, manifest, icons, and CI workflow are complete and consistent', () => {
  const manifestPath = path.join(ROOT, 'android-sms-app/app/src/main/AndroidManifest.xml');
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  assert.match(manifest, /android\.permission\.SEND_SMS/);
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_DATA_SYNC/);
  assert.match(manifest, /android:scheme="spaxsms"/);
  assert.match(manifest, /android:mimeType="application\/json"/);
  assert.match(manifest, /android:name="\.SmsCampaignService"/);
  assert.match(manifest, /android:name="\.SmsStatusReceiver"/);

  const javaDir = path.join(ROOT, 'android-sms-app/app/src/main/java/com/spaxbutchery/sms');
  const expectedJava = [
    'CampaignModels.java',
    'CampaignStore.java',
    'SmsStatusReceiver.java',
    'LocalBridgeServer.java',
    'SmsCampaignService.java',
    'MainActivity.java'
  ];
  for (const file of expectedJava) {
    const src = fs.readFileSync(path.join(javaDir, file), 'utf8');
    assert.match(src, /^package com\.spaxbutchery\.sms;/m, `${file} missing package header`);
    // Verify balanced braces across every Java source file
    let depth = 0;
    for (const ch of src) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      assert.ok(depth >= 0, `Unmatched closing brace in ${file}`);
    }
    assert.equal(depth, 0, `Unbalanced braces in ${file}`);
  }

  assert.ok(fs.existsSync(path.join(ROOT, 'android-sms-app/app/src/main/res/mipmap-xxhdpi/ic_launcher.png')));
  assert.ok(fs.existsSync(path.join(ROOT, 'android-sms-app/app/src/main/res/mipmap-xxhdpi/ic_launcher_foreground.png')));
  assert.ok(fs.existsSync(path.join(ROOT, 'android-sms-app/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml')));
  assert.ok(fs.existsSync(path.join(ROOT, 'android-sms-app/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml')));

  const stringsXml = fs.readFileSync(path.join(ROOT, 'android-sms-app/app/src/main/res/values/strings.xml'), 'utf8');
  assert.match(stringsXml, /<string name="app_name">Spax Sms<\/string>/);

  const colorsXml = fs.readFileSync(path.join(ROOT, 'android-sms-app/app/src/main/res/values/colors.xml'), 'utf8');
  assert.match(colorsXml, /#D91E2A/i);

  const mainJava = fs.readFileSync(path.join(javaDir, 'MainActivity.java'), 'utf8');
  assert.match(mainJava, /new SpannableString\("Spax Sms"\)/);
  assert.match(mainJava, /#C81922/i);

  assert.ok(fs.existsSync(path.join(ROOT, 'android-sms-app/github-workflow-android-sms-app.yml')));
});
