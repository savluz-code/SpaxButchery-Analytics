/**
 * SpaxButchery Analytics — Google Apps Script backend  v2.5  (2026-08-18)
 * ─────────────────────────────────────────────────────────────────
 * MOBILE: can't edit script.google.com on your phone? Open
 *   https://savluz-code.github.io/SpaxButchery-Analytics/code.html
 * on your phone → tap "Copy Entire Code.gs" → paste over Code.gs
 * in script.google.com (open Chrome → ⋮ → Desktop site). That's it.
 *
 * Copy everything below into script.google.com → New project → paste → Save.
 *
 * Sheets used (created automatically):
 *   Customers, Monthly, Settings, Transactions, CustomerTx, Seen
 *
 * Deploy: Deploy → New deployment → Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Paste the /exec URL into index.html as GAS_URL.
 *
 * Vision OCR proxy (kimiVision action) works with any provider.
 *   FREE option: set GEMINI_API_KEY below (aistudio.google.com/apikey — no card
 *   needed). The app sends base=https://generativelanguage.googleapis.com/v1beta
 *   and this script calls Gemini's NATIVE :generateContent endpoint.
 *   PAID option (optional): set MOONSHOT_API_KEY for Kimi (Moonshot).
 */

var MOONSHOT_API_KEY = 'YOUR_API_KEY'; // sk-…  (optional paid; only needed for Kimi)
var GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY'; // AIza…  (FREE — aistudio.google.com/apikey)
var MOONSHOT_BASE = 'https://api.moonshot.ai/v1';
var DEFAULT_KIMI_MODEL = 'kimi-k3';

var SHEETS = {
  customers: 'Customers',
  monthly: 'Monthly',
  settings: 'Settings',
  transactions: 'Transactions',
  customerTx: 'CustomerTx',
  seen: 'Seen'
};

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'load';
  try {
    if (action === 'load') return json_(loadAll_());
    return json_({ success: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ success: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var action = body.action || '';

    if (action === 'saveAll') {
      saveAll_(body);
      return json_({ success: true });
    }

    if (action === 'kimiVision') {
      return json_(kimiVision_(body));
    }

    return json_({ success: false, error: 'unknown action' });
  } catch (err) {
    return json_({ success: false, error: String(err) });
  }
}

/* ══════════ LOAD ══════════ */

function loadAll_() {
  ensureSheets_();
  var ss = SpreadsheetApp.getActive();

  var customers = rowsToObjects_(ss.getSheetByName(SHEETS.customers));
  customers.forEach(function (c) {
    c.spent = Number(c.spent) || 0;
    c.visits = Number(c.visits) || 0;
    c.days = Number(c.days) || 0;
    c.masked = toBool_(c.masked);
    c.isNew = toBool_(c.isNew);
    c.isSeed = toBool_(c.isSeed);
    c.newBatch = Number(c.newBatch) || 0;
    c.seedSpent = Number(c.seedSpent) || 0;
    c.seedVisits = Number(c.seedVisits) || 0;
  });

  var monthlyRows = rowsToObjects_(ss.getSheetByName(SHEETS.monthly));
  var monthly = { labels: [], revenue: [] };
  monthlyRows.forEach(function (r) {
    if (r.label) {
      monthly.labels.push(String(r.label));
      monthly.revenue.push(Number(r.revenue) || 0);
    }
  });

  var settings = {};
  rowsToObjects_(ss.getSheetByName(SHEETS.settings)).forEach(function (r) {
    if (r.key) settings[r.key] = r.value;
  });

  var transactions = rowsToObjects_(ss.getSheetByName(SHEETS.transactions));
  transactions.forEach(function (t) {
    t.amount = Number(t.amount) || 0;
  });

  var customerTx = {};
  rowsToObjects_(ss.getSheetByName(SHEETS.customerTx)).forEach(function (r) {
    var name = r.customer || r.name;
    if (!name) return;
    if (!customerTx[name]) customerTx[name] = [];
    customerTx[name].push({
      date: r.date || '',
      amount: Number(r.amount) || 0,
      product: r.product || '',
      receipt: r.receipt || '',
      importedAt: r.importedAt || ''
    });
  });

  var seen = {};
  rowsToObjects_(ss.getSheetByName(SHEETS.seen)).forEach(function (r) {
    if (r.key) seen[r.key] = 1;
  });

  return {
    success: true,
    customers: customers,
    monthly: monthly,
    settings: settings,
    transactions: transactions,
    customerTx: customerTx,
    seen: seen
  };
}

/* ══════════ SAVE ══════════ */

function saveAll_(body) {
  ensureSheets_();
  var ss = SpreadsheetApp.getActive();

  writeObjects_(ss.getSheetByName(SHEETS.customers), body.customers || [], [
    'name', 'contact', 'spent', 'visits', 'days',
    'firstVisit', 'lastVisit', 'masked', 'isNew', 'isSeed', 'seedSpent', 'seedVisits',
    // newBatch = the import batch that first created this customer. isNew is
    // derived from it (newBatch === settings.importBatch), so it must survive
    // the cloud round-trip or NEW badges would be lost/stuck after a sync.
    'newBatch'
  ]);

  var monthly = body.monthly || { labels: [], revenue: [] };
  var monthRows = (monthly.labels || []).map(function (label, i) {
    return { label: label, revenue: monthly.revenue[i] };
  });
  writeObjects_(ss.getSheetByName(SHEETS.monthly), monthRows, ['label', 'revenue']);

  var settings = body.settings || {};
  var settingRows = Object.keys(settings).map(function (k) {
    return { key: k, value: settings[k] };
  });
  writeObjects_(ss.getSheetByName(SHEETS.settings), settingRows, ['key', 'value']);

  writeObjects_(ss.getSheetByName(SHEETS.transactions), body.transactions || [], [
    'date', 'time', 'amount', 'name', 'phone', 'product', 'receipt', 'source', 'importedAt', 'backfillOnly'
  ]);

  var txRows = [];
  var customerTx = body.customerTx || {};
  Object.keys(customerTx).forEach(function (name) {
    (customerTx[name] || []).forEach(function (t) {
      txRows.push({
        customer: name,
        date: t.date || '',
        amount: t.amount || 0,
        product: t.product || '',
        receipt: t.receipt || '',
        importedAt: t.importedAt || ''
      });
    });
  });
  writeObjects_(ss.getSheetByName(SHEETS.customerTx), txRows, [
    'customer', 'date', 'amount', 'product', 'receipt', 'importedAt'
  ]);

  var seen = body.seen || {};
  var seenRows = Object.keys(seen).map(function (k) {
    return { key: k, value: 1 };
  });
  writeObjects_(ss.getSheetByName(SHEETS.seen), seenRows, ['key', 'value']);
}

/* ══════════ KIMI VISION PROXY ══════════ */

function kimiVision_(body) {
  var base = String(body.base || '').replace(/\/+$/, '').replace(/\/openai$/, '');
  var isGemini = base.indexOf('generativelanguage.googleapis.com') !== -1;
  var key = isGemini ? GEMINI_API_KEY : MOONSHOT_API_KEY;
  if (!key || key === 'YOUR_API_KEY' || key === 'YOUR_GEMINI_API_KEY') {
    return { success: false, error: 'Set ' + (isGemini ? 'GEMINI_API_KEY (free from aistudio.google.com/apikey)' : 'MOONSHOT_API_KEY') + ' in the Apps Script' };
  }
  var model = body.model || (isGemini ? 'gemini-2.5-flash' : DEFAULT_KIMI_MODEL);
  var prompt = body.prompt || 'Extract all text from this image. Return ONLY the text.';

  // Gemini uses its NATIVE generateContent API — the old /v1beta/openai
  // OpenAI-compat path now returns 404.
  if (isGemini) {
    var durl = String(body.image || '');
    var comma = durl.indexOf(',');
    var img = comma >= 0 ? durl.slice(comma + 1) : durl;
    var mm = /^data:(image\/[a-z+.-]+);/i.exec(durl);
    var res = UrlFetchApp.fetch(base + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mm ? mm[1] : 'image/jpeg', data: img } },
            { text: prompt }
          ]
        }]
      }),
      muteHttpExceptions: true
    });
    var gdata = JSON.parse(res.getContentText());
    if (gdata.candidates && gdata.candidates[0] && gdata.candidates[0].content) {
      var parts = gdata.candidates[0].content.parts || [];
      var gtext = parts.map(function (p) { return p.text || ''; }).join('');
      if (gtext) return { success: true, text: gtext };
    }
    return { success: false, error: gdata.error || gdata };
  }

  var payload = {
    model: model,
    temperature: 0.1,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: body.image } },
        { type: 'text', text: prompt }
      ]
    }]
  };
  // If the client chose a base, use it as-is. Otherwise fall back to Moonshot
  // (and try both regions, since .ai / .cn keys are not interchangeable).
  var bases = base ? [base] : [MOONSHOT_BASE, 'https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1'];
  var seen = {};
  var lastErr = null;
  for (var i = 0; i < bases.length; i++) {
    var b = String(bases[i] || '').replace(/\/+$/, '');
    if (!b || seen[b]) continue;
    seen[b] = 1;
    var res2 = UrlFetchApp.fetch(b + '/chat/completions', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var data = JSON.parse(res2.getContentText());
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return { success: true, text: data.choices[0].message.content };
    }
    lastErr = data.error || data;
    var code = (data.error && data.error.code) || res2.getResponseCode();
    if (code !== 401 && code !== 403 && res2.getResponseCode() !== 401 && res2.getResponseCode() !== 403) {
      return { success: false, error: lastErr };
    }
  }
  return { success: false, error: lastErr || 'All Moonshot regions rejected the key (401). Use a key from the same platform as the URL.' };
}

/* ══════════ SHEET HELPERS ══════════ */

function ensureSheets_() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (k) {
    if (!ss.getSheetByName(SHEETS[k])) ss.insertSheet(SHEETS[k]);
  });
}

function rowsToObjects_(sheet) {
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  var headers = values[0].map(function (h) { return String(h || '').trim(); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.every(function (c) { return c === '' || c === null; })) continue;
    var obj = {};
    headers.forEach(function (h, j) {
      if (h) obj[h] = row[j];
    });
    out.push(obj);
  }
  return out;
}

function writeObjects_(sheet, rows, headers) {
  sheet.clearContents();
  if (!headers || !headers.length) return;
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (!rows.length) return;
  var data = rows.map(function (r) {
    return headers.map(function (h) {
      var v = r[h];
      if (v === undefined || v === null) return '';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      return v;
    });
  });
  sheet.getRange(2, 1, data.length, headers.length).setValues(data);
}

function toBool_(v) {
  if (v === true || v === 1) return true;
  var s = String(v || '').toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
