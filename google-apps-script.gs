/**
 * SpaxButchery Analytics — Google Apps Script backend  v3.4  (2026-09-11)
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
 * ✏️ edit → Version: New version → Deploy). v3.4 adds INCREMENTAL SAVES:
 * the client appends only transactions new since the last push (saveDelta,
 * and saveBegin/saveCommit with mode:"delta") instead of re-uploading the
 * whole sheet on every save. The append de-duplicates against the live
 * Transactions sheet (same receipt/date/time/amount/contact identity the
 * client uses), so a retried or replayed delta can never double-count
 * revenue; deletions still go up as a full (atomic) save. The CustomerTx
 * history table is no longer written by current clients — it is derived on
 * each device from Transactions — and delta commits empty it (and Seen), as
 * full saves already do. v3.4 speaks every older action unchanged: old
 * clients (saveAll / full chunked saves, customerTx uploads) keep working,
 * and new clients probe for saveDelta and fall back to a full save against a
 * pre-v3.4 deployment, so the redeploy is never a hard requirement. v3.1
 * adds the seedLastVisit customer column; v3.0 completed the chunked save
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
    // seedLastVisit = the date the customer's baseline (report row / export
    // aggregate) runs up to. The client derives spent/visits as
    // max(baseline, history up to that date) + history after it, so this
    // cut-off must survive the round-trip or totals would drift after a sync.
    'seedLastVisit',
    // newBatch = the import batch that first created this customer. isNew is
    // an internal bookkeeping flag derived from it (newBatch ===
    // settings.importBatch) — it must survive the cloud round-trip because
    // revenue reconciliation depends on it, but it is never shown in the UI
    // (the public NEW 🌱 badge comes from firstVisit's month instead).
    'newBatch'
  ],
  monthly: ['label', 'revenue'],
  settings: ['key', 'value'],
  // v3.3: `till` = the receiving M-Pesa merchant number (5803756 → Meat,
  // 1213294 → Soup/others from 2026-09-06). Old sheets without the column
  // keep loading (till reads as '') and gain it on the next save.
  transactions: ['date', 'time', 'amount', 'name', 'phone', 'product', 'till', 'receipt', 'source', 'importedAt', 'backfillOnly'],
  customerTx: ['customer', 'date', 'amount', 'product', 'till', 'receipt', 'importedAt'],
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
   stages and swaps too, so even one-shot saves are atomic for readers.

   v3.2 makes the count check tell a LOST slice from a REPEATED one. A row
   count can only be compared to a promise, so a slice delivered twice (a
   client retry, a proxy replay, the app open in two tabs) used to stage its
   rows twice and fail the commit with "chunk mismatch … staged 5344 rows,
   expected 3672" — a save refused over data that was perfectly fine:
     • saveChunk records each slice's `seq` per session and skips one it has
       already staged, so no table can be appended twice.
     • `seen` is a set of dedup keys, not records, so it is verified by
       DISTINCT keys and de-duplicated before the swap; a repeated slice there
       is harmless. transactions/customerTx are records — a duplicate would
       double-count revenue — so they keep the strict row count.
     • saveCommit checks the uploadId too (it only checked saveChunk before),
       and a refused commit clears the staging sheets so the retry it asks for
       starts from an empty staging area.
     • waitLock's answer is honoured: a save that cannot get the script lock is
       refused instead of running alongside the writer that holds it. */

var STAGE_SUFFIX = '_Staging';
var SWAP_TMP_SUFFIX = '_SwapTmp';
var UPLOAD_KEY = 'spaxUploadSession';
var CHUNK_SEQ_KEY = 'spaxChunkSeqs';
var BIG_TABLES = { transactions: 1, customerTx: 1, seen: 1 };
/* `seen` is a SET of dedup keys, not a list of records: the same key staged
   twice is still one key (loadAll_ collapses it with seen[key] = 1). It is
   therefore verified by DISTINCT keys and de-duplicated before the swap, so a
   chunk delivered twice cannot fail an otherwise complete save. The other big
   tables are records — a duplicate there would double-count revenue — so they
   keep the strict row count. */
var IDEMPOTENT_TABLES = { seen: 1 };

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
      // saveAll_ returns a failure object when it could not take the script
      // lock; anything else means the stage-and-swap completed.
      return json_(saveAll_(body) || { success: true });
    }

    if (action === 'saveDelta') {
      // Incremental one-shot: small tables replaced (stage + swap), new
      // transactions appended to the live sheet. A busy result means the
      // script lock could not be taken; the client retries (and a deployment
      // that predates this action answers "unknown action", which is the
      // client's signal to fall back to a full save).
      return json_(saveDelta_(body));
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
    // Legacy sheets have no seedLastVisit column: leave the field absent so
    // the client stamps the baseline itself instead of reading an empty
    // cut-off as "no baseline".
    if (c.seedLastVisit === undefined || c.seedLastVisit === null || c.seedLastVisit === '') delete c.seedLastVisit;
    else c.seedLastVisit = dateOnly_(c.seedLastVisit);
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
      till: r.till || '',
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
  if (!lock.waitLock(30000)) return backendBusy_();
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

/* ── incremental save (v3.4) ──
   Routine saves only add transactions (a daily statement imports hundreds
   of rows; the whole sheet is tens of thousands). A delta therefore carries
   the small tables in full — Customers/Monthly/Settings are cheap and stay
   exact — plus ONLY the transactions the client has not pushed before. The
   new rows are appended to the LIVE Transactions sheet and de-duplicated
   against every row already there (txIdentityKeys_ uses the same receipt /
   date+time+amount+name+contact identity the client's dedup guard writes),
   so a retried, replayed or two-device delta can never double-count — an
   append that loses its response simply appends nothing the second time.
   The CustomerTx and Seen sheets are caches the client derives locally
   (v3.4 stops syncing them): every delta swaps header-only copies over
   them, as full saves already did. Deletions cannot be expressed as an
   append — the client takes the full stage-and-swap path for those (Delete
   All, a scoped Rebuild, duplicate rollback, a rename).
   Appends go straight to the live sheet on purpose: an append can never
   TRUNCATE it, so a killed execution leaves at most some rows already
   appended — idempotency absorbs the retry — instead of the half-written
   sheet that made the stage-then-swap protocol necessary for full saves. */

function saveDelta_(body) {
  var lock = LockService.getScriptLock();
  if (!lock.waitLock(30000)) return backendBusy_();
  try {
    prepareStaging_();
    stageSmallTables_(body);
    var addRows = body.txAdd || body.transactions || [];
    var result = appendNewTransactions_(addRows);
    // The derivable caches are no longer synced — empty them via the same
    // atomic swap the small tables use.
    writeObjects_(stagingSheet_(SHEETS.customerTx), [], TABLE_HEADERS.customerTx);
    writeObjects_(stagingSheet_(SHEETS.seen), [], TABLE_HEADERS.seen);
    swapSheets_(['customers', 'monthly', 'settings', 'customerTx', 'seen']);
    // Transactions were appended live (not swapped); leave their staging
    // sheet header-only for the next chunked session.
    writeObjects_(stagingSheet_(SHEETS.transactions), [], TABLE_HEADERS.transactions);
    return {
      success: true,
      added: result.added,
      skippedDuplicates: result.skipped,
      transactions: result.total
    };
  } finally {
    lock.releaseLock();
  }
}

/* ── chunked actions ── */

function saveBegin_(body) {
  var lock = LockService.getScriptLock();
  if (!lock.waitLock(30000)) return backendBusy_();
  try {
    prepareStaging_();
    stageSmallTables_(body);
    // Big staging sheets are reset to header-only and filled by saveChunk.
    resetStaging_();
    var uploadId = Utilities.getUuid();
    try {
      CacheService.getScriptCache().put(UPLOAD_KEY, uploadId, 3600);
    } catch (cacheErr) { /* best-effort session guard only */ }
    // A delta session chunks ONLY new transactions and appends them at
    // commit; a full (default) session stages every big table and swaps the
    // live sheets. The mode rides the same per-upload Script Properties
    // record as the chunk seqs, so saveChunk/saveCommit know which one they
    // are completing. Echo `delta: true` so the client can tell a backend
    // that honoured the mode from one that ignores the field (pre-v3.4).
    var isDelta = String(body.mode || '') === 'delta';
    resetChunkSeqs_(uploadId, isDelta);
    var answer = { success: true, uploadId: uploadId };
    if (isDelta) answer.delta = true;
    return answer;
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
  if (!lock.waitLock(30000)) return backendBusy_();
  try {
    var sheet = stagingSheet_(SHEETS[table]);
    if (!sheet) {
      return { success: false, error: 'no upload in progress — saveBegin must run before saveChunk' };
    }
    // A delta session appends transactions only — the other big tables are
    // derivable caches the client never uploads anymore. Routing one of them
    // here would stage rows the delta commit neither counts nor swaps. The
    // client echoes mode on every chunk, so a lost session record can't let a
    // cache table slip into a delta staging area either.
    var chunkIsDelta = body.mode === 'delta' || sessionIsDelta_(body.uploadId);
    if (chunkIsDelta && table !== 'transactions') {
      return { success: false, error: 'delta uploads append transactions only' };
    }
    var seq = body.seq;
    var hasSeq = seq !== undefined && seq !== null && seq !== '';
    // A slice this session already staged is a no-op the second time it
    // arrives (a client retry, a proxy replay, a second tab). Appending it
    // again is what produced "staged 5344 rows, expected 3672".
    if (hasSeq && chunkAlreadyStaged_(body.uploadId, table, seq)) {
      return { success: true, written: 0, duplicate: true };
    }
    var rows = body.rows || [];
    if (!rows.length) {
      if (hasSeq) recordChunkSeq_(body.uploadId, table, seq);
      return { success: true, written: 0 };
    }
    appendObjects_(sheet, rows, TABLE_HEADERS[table]);
    if (hasSeq) recordChunkSeq_(body.uploadId, table, seq);
    return { success: true, written: rows.length };
  } finally {
    lock.releaseLock();
  }
}

function saveCommit_(body) {
  // A commit from a superseded session must not swap in another device's
  // staged rows — it promised counts for slices that are no longer there.
  if (!uploadSessionValid_(body.uploadId)) {
    return { success: false, error: 'upload superseded by a newer save — please retry the whole save' };
  }
  var lock = LockService.getScriptLock();
  if (!lock.waitLock(30000)) return backendBusy_();
  try {
    // Delta sessions append new transactions instead of swapping tables —
    // they have their own commit (append + dedup, then swap only the small
    // and derivable-cache sheets). The client's explicit mode is honoured
    // too, so losing the session bookkeeping can never make a delta commit
    // swap the live Transactions sheet for a staging sheet holding only the
    // appended rows.
    if (body.mode === 'delta' || sessionIsDelta_(body.uploadId)) return commitDelta_(body);
    // 1) Verify every promised row landed BEFORE touching any live sheet.
    var expect = body.expect || {};
    var tables = Object.keys(BIG_TABLES);
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      var want = Number(expect[table] || 0);
      if (IDEMPOTENT_TABLES[table]) dedupeStaged_(table);
      var staged = stagedRowCount_(table);
      if (staged !== want) {
        // Leave nothing stale behind: the retry starts from an empty staging
        // area instead of inheriting the rows this attempt left lying around.
        resetStaging_();
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
    try { PropertiesService.getScriptProperties().deleteProperty(CHUNK_SEQ_KEY); } catch (propsErr) {}
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// Delta commit: every promised APPENDED row is in the transactions staging
// sheet (strict count — records, like a full save), then the new-only rows
// are appended to the LIVE Transactions sheet after de-duplicating against
// everything already there. The small tables and the (now-empty) derivable
// caches swap atomically; Transactions itself is never replaced.
function commitDelta_(body) {
  var want = Number((body.expect || {}).transactions || 0);
  var staged = stagingSheet_(SHEETS.transactions);
  var count = stagedRowCount_('transactions');
  if (count !== want) {
    // Same contract as a full commit: refuse before touching anything live.
    resetStaging_();
    return {
      success: false,
      error: 'chunk mismatch on transactions: staged ' + count + ' rows, expected ' + want +
             ' — live data left untouched, please retry the save'
    };
  }
  var stagedRows = rowsToObjects_(staged);
  var result = appendNewTransactions_(stagedRows);
  // Small tables were staged at saveBegin; the derivable caches are empty by
  // contract — stage them so the same swap publishes all four.
  writeObjects_(stagingSheet_(SHEETS.customerTx), [], TABLE_HEADERS.customerTx);
  writeObjects_(stagingSheet_(SHEETS.seen), [], TABLE_HEADERS.seen);
  swapSheets_(['customers', 'monthly', 'settings', 'customerTx', 'seen']);
  // Transactions appended live rather than swapped — clear its staging area.
  writeObjects_(stagingSheet_(SHEETS.transactions), [], TABLE_HEADERS.transactions);
  try { CacheService.getScriptCache().remove(UPLOAD_KEY); } catch (cacheErr) {}
  try { PropertiesService.getScriptProperties().deleteProperty(CHUNK_SEQ_KEY); } catch (propsErr) {}
  return {
    success: true,
    added: result.added,
    skippedDuplicates: result.skipped,
    transactions: result.total
  };
}

// waitLock returning false means another writer still holds the script lock.
// Proceeding anyway is how two saves interleave their renames, so refuse the
// request instead — the client's next save retries with the latest data.
function backendBusy_() {
  return { success: false, error: 'backend busy with another save — please retry the save' };
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
        till: t.till || '',
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

// Back to header-only. Used at saveBegin (a fresh upload session) and after a
// refused commit, so a retry never inherits rows from the attempt before it.
function resetStaging_() {
  Object.keys(BIG_TABLES).forEach(function (table) {
    var sheet = stagingSheet_(SHEETS[table]);
    if (sheet) writeObjects_(sheet, [], TABLE_HEADERS[table]);
  });
}

// Collapse repeated keys in a staged set-table down to one row each. A chunk
// that lands twice stages its rows twice; for `seen` those copies are the same
// keys, so dropping them leaves exactly the data the client promised instead
// of failing the commit. Returns the number of duplicate rows removed.
function dedupeStaged_(table) {
  var sheet = stagingSheet_(SHEETS[table]);
  if (!sheet) return 0;
  var headers = TABLE_HEADERS[table];
  var last = sheet.getLastRow();
  if (last <= 2) return 0; // header alone, or header + a single row
  var values = sheet.getRange(2, 1, last - 1, headers.length).getValues();
  var kept = [];
  var keys = {};
  for (var i = 0; i < values.length; i++) {
    var first = values[i][0];
    var key = String(first === undefined || first === null ? '' : first);
    // Only a REPEATED key is dropped. A row with no key at all is kept as-is so
    // this cannot change the staged count for anything but genuine duplicates.
    if (key !== '') {
      if (keys[key]) continue; // this key is already staged — drop the copy
      keys[key] = 1;
    }
    kept.push(values[i]);
  }
  if (kept.length === values.length) return 0; // nothing duplicated
  writeValueRows_(sheet, kept, headers);
  return values.length - kept.length;
}

/* ── chunk sequence bookkeeping ──
   Which slices of this upload session have already been staged, so a slice
   delivered twice is recognised and skipped rather than appended again. Kept
   in Script Properties (a few dozen bytes — one entry per chunk, not per row)
   and scoped to the uploadId, so a new session starts clean. Clients that
   predate `seq` send none: they are appended as before and the commit's row
   count stays the safety net. */

function chunkSeqStateRecord_(uploadId) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(CHUNK_SEQ_KEY);
    if (raw) {
      var state = JSON.parse(raw);
      if (state && String(state.uploadId) === String(uploadId || '')) return state;
    }
  } catch (err) { /* unreadable state — treat as nothing staged yet */ }
  return null;
}

function chunkSeqState_(uploadId) {
  var state = chunkSeqStateRecord_(uploadId);
  return state ? (state.seqs || {}) : {};
}

// Whether this upload session is an incremental delta (append transactions)
// rather than a full stage-and-swap. Sessions without stored state (legacy
// clients send no uploadId) are always full saves.
function sessionIsDelta_(uploadId) {
  if (!uploadId) return false;
  var state = chunkSeqStateRecord_(uploadId);
  return !!(state && state.delta);
}

function chunkAlreadyStaged_(uploadId, table, seq) {
  var list = chunkSeqState_(uploadId)[table] || [];
  return list.indexOf(String(seq)) !== -1;
}

function recordChunkSeq_(uploadId, table, seq) {
  var state = chunkSeqStateRecord_(uploadId) || { uploadId: String(uploadId || ''), seqs: {}, delta: false };
  if (!state.seqs) state.seqs = {};
  if (!state.seqs[table]) state.seqs[table] = [];
  state.seqs[table].push(String(seq));
  try {
    PropertiesService.getScriptProperties().setProperty(CHUNK_SEQ_KEY, JSON.stringify(state));
  } catch (err) { /* best-effort: the commit count check still catches trouble */ }
}

function resetChunkSeqs_(uploadId, isDelta) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      CHUNK_SEQ_KEY,
      JSON.stringify({ uploadId: String(uploadId || ''), seqs: {}, delta: !!isDelta })
    );
  } catch (err) { /* best-effort */ }
}

// Atomically-ish replace the named live sheets with their staging copies.
// Renames are metadata-only, so no data is copied twice; the window where a
// table has no live-named sheet is a few milliseconds, and ensureSheets_
// recovers it if an execution dies inside that window. A delta commit swaps
// only the small tables + derivable caches (Transactions is appended to
// live, never replaced); a full save swaps every table.
function swapSheets_(keys) {
  var ss = getSpreadsheet_();
  keys.forEach(function (k) {
    var liveName = SHEETS[k];
    if (!liveName) return;
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

// Every table — the full stage-and-swap used by saveAll and a full commit.
function swapAllSheets_() {
  swapSheets_(Object.keys(SHEETS));
}

/* ── incremental (delta) transaction append ── */

// Identity keys for a transaction row, mirroring the client's
// transactionKey / txKeyNoTime / legacyReceiptKeys exactly: a receipt row is
// keyed by its cleaned receipt + date (with and without the time, plus the
// old 10-char truncation); a receipt-less row is a strict
// date+time+amount+name+contact composite, so two genuinely different
// same-day/same-amount payments never collapse together.
function txIdentityKeys_(r) {
  r = r || {};
  var keys = [];
  var rc = String(r.receipt == null ? '' : r.receipt).replace(/\s+/g, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  var d = dateOnly_(r.date);
  var tm = String(r.time || '');
  if (rc) {
    keys.push('receipt|' + rc + '|' + d + '|' + tm);
    keys.push('receipt|' + rc + '|' + d + '|');
    if (rc.length > 10) keys.push('receipt|' + rc.substring(0, 10) + '|' + d + '|' + tm);
  } else {
    keys.push('composite|' + d + '|' + tm + '|' + (Number(r.amount) || 0).toFixed(2) + '|' +
      gasNormName_(r.name) + '|' + gasNormContact_(r.phone != null ? r.phone : r.contact));
  }
  return keys;
}

function gasNormName_(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
}

// Same normalisation as the client's normalizeContact: Kenyan number
// variants (+254…/254…/0…) collapse to the 0… form; masked numbers and
// blanks pass through.
function gasNormContact_(contact) {
  var c = String(contact == null ? '' : contact).trim();
  if (!c || /missing/i.test(c)) return '';
  c = c.replace(/\s+/g, '');
  if (c.indexOf('***') >= 0) {
    if (c.indexOf('254') === 0) c = '0' + c.substring(3);
    return c;
  }
  c = c.replace(/[^\d+]/g, '');
  if (c.indexOf('+254') === 0) c = '0' + c.substring(4);
  else if (c.indexOf('254') === 0) c = '0' + c.substring(3);
  return c;
}

// Write the header row on a still-empty sheet (a brand-new deployment has
// never held a full save). Without this an append would land at row 1 and
// look like the header on the next load.
function ensureSheetHeader_(sheet, headers) {
  if (!sheet) return;
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

// Append the transactions the live sheet does not already hold. Returns
// {added, skipped, total} — the skip count includes duplicates inside the
// batch itself, so a retried delivery of the same delta appends nothing.
function appendNewTransactions_(rows) {
  var live = getSpreadsheet_().getSheetByName(SHEETS.transactions);
  if (!live) throw new Error('missing live Transactions sheet');
  ensureSheetHeader_(live, TABLE_HEADERS.transactions);
  var have = {};
  rowsToObjects_(live).forEach(function (r) {
    txIdentityKeys_(r).forEach(function (k) { have[k] = 1; });
  });
  var fresh = [];
  var seenInBatch = {};
  var skipped = 0;
  (rows || []).forEach(function (r) {
    var keys = txIdentityKeys_(r);
    var dup = false;
    for (var i = 0; i < keys.length; i++) {
      if (have[keys[i]] || seenInBatch[keys[i]]) { dup = true; break; }
    }
    if (dup) { skipped++; return; }
    keys.forEach(function (k) { seenInBatch[k] = 1; });
    fresh.push(r);
  });
  if (fresh.length) appendObjects_(live, fresh, TABLE_HEADERS.transactions);
  return { added: fresh.length, skipped: skipped, total: Math.max(0, live.getLastRow() - 1) };
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
  if (!headers || !headers.length) {
    sheet.clearContents();
    return;
  }
  writeValueRows_(sheet, rows.map(function (r) {
    return headers.map(function (h) {
      var v = r[h];
      if (v === undefined || v === null) return '';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      return v;
    });
  }), headers);
}

// Same write, from rows that are already plain arrays (the de-duplication path
// rewrites staged values it read straight back out of the sheet).
function writeValueRows_(sheet, valueRows, headers) {
  sheet.clearContents();
  if (!headers || !headers.length) return;
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (!valueRows.length) return;
  sheet.getRange(2, 1, valueRows.length, headers.length).setValues(valueRows);
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
