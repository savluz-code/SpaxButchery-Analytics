/**
 * SpaxButchery Analytics — Google Apps Script backend  v3.0  (2026-09-03)
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
 *   (+ a *_Staging twin per sheet — see CHUNKED SAVE below)
 *
 * Deploy: Deploy → New deployment → Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Paste the /exec URL into index.html as GAS_URL.
 *
 * ALREADY DEPLOYED? Re-deploy this version (Deploy → Manage deployments →
 * ✏️ edit → Version: New version → Deploy). v3.0 completes the chunked save
 * protocol the client has spoken since PR #41: large saves stop dying at the
 * client's one-shot timeout and no aborted save can truncate a live sheet
 * anymore. Clients that only know saveAll keep working unchanged.
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

/* Column order for every sheet. loadAll_/saveAll_ and the chunked staging
   writers all use this one map so the round-trip can never drift. */
var TABLE_HEADERS = {
  customers: [
    'name', 'contact', 'spent', 'visits', 'days',
    'firstVisit', 'lastVisit', 'masked', 'isNew', 'isSeed', 'seedSpent', 'seedVisits',
    // newBatch = the import batch that first created this customer. isNew is
    // an internal bookkeeping flag derived from it (newBatch ===
    // settings.importBatch) — it must survive the cloud round-trip because
    // revenue reconciliation depends on it, but it is never shown in the UI
    // (the public NEW 🌱 badge comes from firstVisit's month instead).
    'newBatch'
  ],
  monthly: ['label', 'revenue'],
  settings: ['key', 'value'],
  transactions: ['date', 'time', 'amount', 'name', 'phone', 'product', 'receipt', 'source', 'importedAt', 'backfillOnly'],
  customerTx: ['customer', 'date', 'amount', 'product', 'receipt', 'importedAt'],
  seen: ['key', 'value']
};

/* ══════════ CHUNKED SAVE PROTOCOL (v3.0) ══════════
   The client has sliced large saves into saveBegin → saveChunk×N → saveCommit
   since PR #41, but this script only understood saveAll — so a big import day
   (~2.5 MB / ~23k rows) still went up as ONE request that weak mobile signal
   regularly aborted, and writeObjects_'s clear-then-write could leave a live
   sheet truncated ("a day's imports vanished"). These actions complete the
   protocol:

     saveBegin  → stage the small tables, reset the big staging sheets, mint
                  an uploadId for this upload session
     saveChunk  → append one slice of a big table to its staging sheet
     saveCommit → verify every promised row landed, THEN swap every live sheet
                  for its staging copy (renames — no second data copy)

   Live sheets are only ever replaced after the staged row counts verify, so a
   dropped connection costs a retry — never a truncated sheet. saveAll now
   stages and swaps too, so even one-shot saves are atomic for readers. */

var STAGE_SUFFIX = '_Staging';
var SWAP_TMP_SUFFIX = '_SwapTmp';
var UPLOAD_KEY = 'spaxUploadSession';
var BIG_TABLES = { transactions: 1, customerTx: 1, seen: 1 };

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

    if (action === 'saveBegin') {
      return json_(saveBegin_(body));
    }

    if (action === 'saveChunk') {
      return json_(saveChunk_(body));
    }

    if (action === 'saveCommit') {
      return json_(saveCommit_(body));
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
  var ss = getSpreadsheet_();

  var customers = rowsToObjects_(ss.getSheetByName(SHEETS.customers)).filter(function (c) {
    return String(c.name || '').trim() !== '';
  });
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
    c.firstVisit = dateOnly_(c.firstVisit);
    c.lastVisit = dateOnly_(c.lastVisit);
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
    t.date = dateOnly_(t.date);
  });

  var customerTx = {};
  rowsToObjects_(ss.getSheetByName(SHEETS.customerTx)).forEach(function (r) {
    var name = r.customer || r.name;
    if (!name) return;
    if (!customerTx[name]) customerTx[name] = [];
    customerTx[name].push({
      date: dateOnly_(r.date),
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

// One-shot save. Now stages every table first and swaps the live sheets in
// only after all writes succeed — an aborted or timed-out execution leaves
// the live database at its previous, complete state instead of truncating it.
function saveAll_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    prepareStaging_();
    stageSmallTables_(body);
    stageBigTable_('transactions', body.transactions || []);
    stageBigTable_('customerTx', flattenCustomerTx_(body.customerTx || {}));
    stageBigTable_('seen', flattenSeen_(body.seen || {}));
    swapAllSheets_();
  } finally {
    lock.releaseLock();
  }
}

/* ── chunked actions ── */

function saveBegin_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    prepareStaging_();
    stageSmallTables_(body);
    // Big staging sheets are reset to header-only and filled by saveChunk.
    Object.keys(BIG_TABLES).forEach(function (table) {
      writeObjects_(stagingSheet_(SHEETS[table]), [], TABLE_HEADERS[table]);
    });
    var uploadId = Utilities.getUuid();
    try {
      CacheService.getScriptCache().put(UPLOAD_KEY, uploadId, 3600);
    } catch (cacheErr) { /* best-effort session guard only */ }
    return { success: true, uploadId: uploadId };
  } finally {
    lock.releaseLock();
  }
}

function saveChunk_(body) {
  var table = String(body.table || '');
  if (!BIG_TABLES[table]) {
    return { success: false, error: 'unknown table: ' + table };
  }
  if (!uploadSessionValid_(body.uploadId)) {
    return { success: false, error: 'upload superseded by a newer save — please retry the whole save' };
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = stagingSheet_(SHEETS[table]);
    if (!sheet) {
      return { success: false, error: 'no upload in progress — saveBegin must run before saveChunk' };
    }
    var rows = body.rows || [];
    if (!rows.length) return { success: true, written: 0 };
    appendObjects_(sheet, rows, TABLE_HEADERS[table]);
    return { success: true, written: rows.length };
  } finally {
    lock.releaseLock();
  }
}

function saveCommit_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // 1) Verify every promised row landed BEFORE touching any live sheet.
    var expect = body.expect || {};
    var tables = Object.keys(BIG_TABLES);
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      var want = Number(expect[table] || 0);
      var staged = stagedRowCount_(table);
      if (staged !== want) {
        return {
          success: false,
          error: 'chunk mismatch on ' + table + ': staged ' + staged + ' rows, expected ' + want +
                 ' — live data left untouched, please retry the save'
        };
      }
    }
    // 2) Counts are exact — swap every live sheet for its staging copy.
    swapAllSheets_();
    try { CacheService.getScriptCache().remove(UPLOAD_KEY); } catch (cacheErr) {}
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/* ── staging helpers ── */

// Creates any missing staging sheets and, if a previous swap was interrupted
// half-renamed, folds the leftovers back in (see ensureSheets_ for the live
// side of that recovery).
function prepareStaging_() {
  ensureSheets_();
  var ss = getSpreadsheet_();
  Object.keys(SHEETS).forEach(function (k) {
    var stageName = SHEETS[k] + STAGE_SUFFIX;
    if (ss.getSheetByName(stageName)) return;
    // A commit that died after live→SwapTmp but before SwapTmp→Staging left
    // the old live data under the tmp name — that is a perfectly good staging
    // sheet (it gets cleared before use anyway).
    var tmp = ss.getSheetByName(SHEETS[k] + SWAP_TMP_SUFFIX);
    if (tmp) {
      tmp.setName(stageName);
    } else {
      ss.insertSheet(stageName);
    }
  });
}

function stagingSheet_(liveName) {
  return getSpreadsheet_().getSheetByName(liveName + STAGE_SUFFIX);
}

function stageSmallTables_(body) {
  writeObjects_(stagingSheet_(SHEETS.customers), (body.customers || []).filter(function (c) {
    return c && String(c.name || '').trim() !== '';
  }), TABLE_HEADERS.customers);

  var monthly = body.monthly || { labels: [], revenue: [] };
  var monthRows = (monthly.labels || []).map(function (label, i) {
    return { label: label, revenue: monthly.revenue[i] };
  });
  writeObjects_(stagingSheet_(SHEETS.monthly), monthRows, TABLE_HEADERS.monthly);

  var settings = body.settings || {};
  var settingRows = Object.keys(settings).map(function (k) {
    return { key: k, value: settings[k] };
  });
  writeObjects_(stagingSheet_(SHEETS.settings), settingRows, TABLE_HEADERS.settings);
}

function flattenCustomerTx_(customerTx) {
  var txRows = [];
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
  return txRows;
}

function flattenSeen_(seen) {
  return Object.keys(seen).map(function (k) {
    return { key: k, value: 1 };
  });
}

// Full-table staging write (saveAll path — one writeObjects_ per table).
function stageBigTable_(table, rows) {
  writeObjects_(stagingSheet_(SHEETS[table]), rows, TABLE_HEADERS[table]);
}

// Data rows currently staged for a big table (header row excluded).
function stagedRowCount_(table) {
  var sheet = stagingSheet_(SHEETS[table]);
  if (!sheet) return -1;
  return Math.max(0, sheet.getLastRow() - 1);
}

// Atomically-ish replace every live sheet with its staging copy. Renames are
// metadata-only, so no data is copied twice; the window where a table has no
// live-named sheet is a few milliseconds, and ensureSheets_ recovers it if an
// execution dies inside that window.
function swapAllSheets_() {
  var ss = getSpreadsheet_();
  Object.keys(SHEETS).forEach(function (k) {
    var liveName = SHEETS[k];
    var staging = ss.getSheetByName(liveName + STAGE_SUFFIX);
    if (!staging) throw new Error('missing staging sheet for ' + liveName);
    var live = ss.getSheetByName(liveName);
    var tmpName = liveName + SWAP_TMP_SUFFIX;
    if (live) live.setName(tmpName);
    staging.setName(liveName);
    var tmp = ss.getSheetByName(tmpName);
    if (tmp) {
      tmp.setName(liveName + STAGE_SUFFIX);
      tmp.clearContents();
    }
  });
}

// A chunk belongs to the newest saveBegin. Legacy clients that never saw the
// uploadId response send none — accept those (the commit count check is the
// real safety net); reject only chunks that provably belong to an older
// upload than the one currently staged.
function uploadSessionValid_(uploadId) {
  if (!uploadId) return true;
  var current = null;
  try { current = CacheService.getScriptCache().get(UPLOAD_KEY); } catch (cacheErr) { return true; }
  if (!current) return true; // evicted/expired cache — cannot prove supersession
  return String(current) === String(uploadId);
}

// Appends rows below whatever is already staged (same value coercion as
// writeObjects_ so a staged sheet is byte-identical to a saveAll write).
function appendObjects_(sheet, rows, headers) {
  if (!rows.length) return;
  var data = rows.map(function (r) {
    return headers.map(function (h) {
      var v = r[h];
      if (v === undefined || v === null) return '';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      return v;
    });
  });
  var at = sheet.getLastRow() + 1;
  sheet.getRange(at, 1, data.length, headers.length).setValues(data);
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

// Works both when this project is bound to a Google Sheet and when it is a
// standalone web-app project (the setup instructions use a standalone project).
// A standalone project has no active spreadsheet, which used to make every
// load/save fail with "Cannot read properties of null". Keep the created
// spreadsheet ID in Script Properties so every web-app request uses the same
// cloud database.
function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPAX_SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (err) { props.deleteProperty('SPAX_SPREADSHEET_ID'); }
  }

  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    props.setProperty('SPAX_SPREADSHEET_ID', active.getId());
    return active;
  }

  var created = SpreadsheetApp.create('SpaxButchery Cloud Data');
  props.setProperty('SPAX_SPREADSHEET_ID', created.getId());
  return created;
}

function ensureSheets_() {
  var ss = getSpreadsheet_();
  Object.keys(SHEETS).forEach(function (k) {
    if (ss.getSheetByName(SHEETS[k])) return;
    // A commit that died mid-swap can leave the live sheet under a temp name.
    // The staging copy holds the newest count-verified data, so promote it;
    // SwapTmp is the previous live sheet — better than an empty insert, but
    // only if no staging copy exists.
    var staging = ss.getSheetByName(SHEETS[k] + STAGE_SUFFIX);
    if (staging) {
      staging.setName(SHEETS[k]);
      return;
    }
    var tmp = ss.getSheetByName(SHEETS[k] + SWAP_TMP_SUFFIX);
    if (tmp) {
      tmp.setName(SHEETS[k]);
      return;
    }
    ss.insertSheet(SHEETS[k]);
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

// Strip everything after the date so cloud rows never deliver timestamp digits
// ("2026-08-12T00:00:00.000Z", "2026-08-12 14:25:30", Excel serials) to the app.
function dateOnly_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = s.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  var serial = Number(s);
  if (isFinite(serial) && serial >= 20000 && serial <= 80000) {
    var d = new Date(Math.round((serial - 25569) * 86400000));
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  }
  var dm = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dm && Number(dm[2]) <= 12 && Number(dm[1]) <= 31) {
    return dm[3] + '-' + ('0' + dm[2]).slice(-2) + '-' + ('0' + dm[1]).slice(-2);
  }
  return '';
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
