/**
 * SpaxButchery Analytics — Google Apps Script backend  v3.9  (2026-09-19)
 * ─────────────────────────────────────────────────────────────────
 * v3.9 moves the save lock from the script lock to the user lock, and makes
 * every save answer carry its own server-side timings:
 *   • This web app always executes as its owner ("Execute as: Me"), so every
 *     execution — any device, any tab, editor runs — holds the SAME user
 *     lock, and serialisation is identical to the script lock. What changes
 *     is only WHICH lock object guards the saves: a deployment whose script
 *     lock is stuck (waitLock failing with no writer behind it — executions
 *     complete in under a second, yet every save answers "backend busy",
 *     surviving even a redeploy) gets a fresh, un-stuck lock without moving
 *     projects or data.
 *   • Every save answer now echoes `srv`: {wait, work} in milliseconds —
 *     how long the execution waited for the lock and how long it worked.
 *     Busy answers carry {wait} too. A refusal that cost ~30s of waiting is
 *     genuine contention; one that cost ~0s failed instantly with no holder
 *     (stuck lock / LockService failure) — the client shows the number, so a
 *     busy storm is diagnosable from the app instead of by guessing.
 *   • action=status additionally reports `lock`: {free, ms} — a non-blocking
 *     read of the save lock (acquired and released immediately when free,
 *     never waited on), so the app can show whether the lock is free RIGHT
 *     NOW without spending a save attempt to find out.
 * Older clients ignore the extra fields; the busy error string is unchanged.
 * v3.8 makes a LOST saveBegin answer recoverable, so a save that outlives
 * one of its own requests converges instead of restarting forever:
 *   • A client may mint the session's uploadId itself (an `uploadId` field
 *     on action=saveBegin). It is stored and enforced exactly like one the
 *     script mints; anything that is not a 6–80 character opaque token is
 *     ignored and the script mints its own, so a client that sends nothing
 *     or nonsense is unaffected.
 *   • action=status reports the session the newest saveBegin started —
 *     `session` = {uploadId, at, mode, staged} — without taking the script
 *     lock, like every other status answer.
 *   • Together they let a client whose saveBegin request outlived its own
 *     deadline (or whose reply the network dropped) recognise the session it
 *     already began and CONTINUE it, instead of sending a fresh saveBegin
 *     that wipes the staging area the previous attempt had just filled —
 *     which is how a slow-but-alive upload used to burn its whole retry
 *     budget and look like a save that never completes. An older client
 *     ignores both additions.
 * v3.7 adds TARGETED CUSTOMER EDITS (action=updateCustomer):
 *   • Editing one contact in the Contact Resolver used to cost a whole-
 *     database upload: a rename rewrites the customer's name on every one of
 *     their transaction rows, which an append can't express, so the client
 *     flagged a FULL replace ("large upload, sending in parts" for a single
 *     phone number). updateCustomer rewrites exactly the affected cells in
 *     place — the one Customers row, and (on a rename) only that customer's
 *     `name` cells in Transactions — under the script lock, then invalidates
 *     the key index so the next delta re-derives identities from the sheet.
 *     Clients probe for it and fall back to the full save on older
 *     deployments, so the redeploy is never a hard requirement.
 * v3.6 makes saves VERIFIED and commits IDEMPOTENT:
 *   • Every successful save records a RECEIPT (the client's save tag plus
 *     the fingerprints of the data it carried). A client whose upload timed
 *     out asks `action=status` whether its data landed instead of blindly
 *     re-uploading the whole database — the loop that made big saves look
 *     like they "fail all the time" on slow servers (each retry re-sent
 *     everything and timed out again, without ever noticing the first
 *     attempt had already landed).
 *   • A repeated full commit no longer swaps the live sheets a second time:
 *     the committed uploadId is remembered and a replay answers success
 *     without touching anything. (Replaying a swap would silently revert
 *     the live sheets to their pre-save state.)
 *   • Session supersession no longer depends only on the (evictable) script
 *     cache: saveBegin records the newest uploadId in Script Properties, so
 *     a stale chunk/commit from an older session is refused even after the
 *     cache entry expired.
 *   • load and status responses carry the backend `version`, so the app can
 *     tell a deployment that predates these guarantees apart from a live one.
 * Older clients keep working unchanged: they simply never send a save tag
 * and never call status.
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
 *   (+ TxKeys — the transaction identity index, see FAST SAVES below)
 *
 * Deploy: Deploy → New deployment → Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Paste the /exec URL into index.html as GAS_URL.
 *
 * ALREADY DEPLOYED? Re-deploy this version (Deploy → Manage deployments →
 * ✏️ edit → Version: New version → Deploy). v3.5 makes each save MUCH
 * FASTER — which is what decides how long a queue of saves takes, because
 * every save runs behind the script lock and they can only go one at a time.
 * Nothing about the protocol changes, so an unredeployed v3.4 script keeps
 * working exactly as before (it just stays slow):
 *   • FAST SAVES: a delta used to read the entire live Transactions sheet
 *     (~20k rows × 11 columns) on EVERY save just to build the duplicate
 *     guard, then rewrite and swap the whole Customers sheet even when not
 *     one customer had changed. The duplicate keys now live in a narrow
 *     one-column index (TxKeys) that is appended to alongside the sheet, so
 *     a routine save reads one column instead of eleven; a table the client
 *     re-sends unchanged is not re-written at all; and a swap no longer
 *     clears the sheet it just replaced. A routine save went from ~10–20s
 *     to a couple of seconds, so a batch of queued saves finishes in
 *     seconds instead of minutes.
 *   • The index is derived data and is never trusted blindly (see
 *     TX KEY INDEX below): anything that rewrites the live sheet wholesale
 *     invalidates it, and it is rebuilt whenever it does not match.
 * v3.4 adds INCREMENTAL SAVES:
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

var BACKEND_VERSION = '3.9';

var STAGE_SUFFIX = '_Staging';
var SWAP_TMP_SUFFIX = '_SwapTmp';
var UPLOAD_KEY = 'spaxUploadSession';
var CHUNK_SEQ_KEY = 'spaxChunkSeqs';
// The newest uploadId any saveBegin minted (authoritative supersession guard
// — the script cache above it may be evicted at any time).
var LAST_BEGIN_KEY = 'spaxLastBeginUpload';
// When that saveBegin ran (v3.8) — reported by status_ so a client can tell a
// session of its own that is still fresh from one that is stale/superseded.
var LAST_BEGIN_AT_KEY = 'spaxLastBeginAt';
// The uploadId of the last COMMITTED chunked save (duplicate-commit guard).
var COMMITTED_KEY = 'spaxCommittedUpload';
// Receipt of the last successful save (see recordSaveReceipt_).
var LAST_SAVE_KEY = 'spaxLastSave';
var BIG_TABLES = { transactions: 1, customerTx: 1, seen: 1 };
/* `seen` is a SET of dedup keys, not a list of records: the same key staged
   twice is still one key (loadAll_ collapses it with seen[key] = 1). It is
   therefore verified by DISTINCT keys and de-duplicated before the swap, so a
   chunk delivered twice cannot fail an otherwise complete save. The other big
   tables are records — a duplicate there would double-count revenue — so they
   keep the strict row count. */
var IDEMPOTENT_TABLES = { seen: 1 };

/* ── TX KEY INDEX (v3.5) ──
   The duplicate guard for a delta save needs every identity key of every row
   already in the live Transactions sheet. Reading them back out of the sheet
   meant a getDataRange().getValues() of the WHOLE table — usually the single
   slowest call in the save, paid again by every save in a queue. The index
   keeps those keys in a narrow one-column sheet instead:
       row N of TxKeys  ⇔  row N+1 of Transactions (row 1 is the header)
   and holds every key of that row (txIdentityKeys_), newline-separated, so
   the guard reads ONE column instead of eleven and appends only the keys of
   the rows it adds.

   It is DERIVED data and is never trusted blindly:
     • it is only used when its row count matches the live sheet's row count;
     • anything that replaces the live sheet wholesale (a full save, a swap,
       Delete All) invalidates it, so the next delta rebuilds it;
     • it is rebuilt if it grows older than TX_KEY_MAX_AGE_MS, which bounds
       how long a hand-edit made directly in Google Sheets can go unnoticed.
   A wrong index therefore costs one extra read — never a duplicate row. */
var TX_KEY_SHEET = 'TxKeys';
var TX_KEY_PROP = 'spaxTxKeyRows';   // how many live rows the index mirrors (-1 = invalid)
var TX_KEY_STAMP_PROP = 'spaxTxKeyStamp';
var TX_KEY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/* Tables whose stage-and-swap is skipped when the client re-sends them
   unchanged (see stageSmallTables_): Customers is the biggest routine write
   in a save, and most saves change none of it. */
var SMALL_TABLES = ['customers', 'monthly', 'settings'];

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

    // Cheap, lock-free status probe (v3.6): lets a client whose save timed
    // out ask whether its data landed (see recordSaveReceipt_) instead of
    // re-uploading the whole database, and reports the backend version so
    // the app can tell an old deployment from a live one. A deployment that
    // predates this action answers "unknown action", which the client treats
    // as "verify unavailable — retry the save as before".
    if (action === 'status') {
      return json_(status_());
    }

    // Targeted customer edit (v3.7): one Customers row rewritten in place
    // and, on a rename, only that customer's name cells in Transactions —
    // instead of the client re-uploading the whole database because a
    // rename is not append-shaped. Older deployments answer "unknown
    // action" and the client falls back to a full save.
    if (action === 'updateCustomer') {
      return json_(updateCustomer_(body));
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
    version: BACKEND_VERSION,
    customers: customers,
    monthly: monthly,
    settings: settings,
    transactions: transactions,
    customerTx: customerTx,
    seen: seen
  };
}

/* ══════════ STATUS + SAVE RECEIPTS (v3.6) ══════════
   A client whose upload timed out cannot tell "the server never got it"
   from "the server finished after I gave up" — and re-uploading a 20k-row
   database that already landed just times out again. So every successful
   save records a RECEIPT first: the client's save tag plus the fingerprints
   of the data it carried (opaque strings the server stores verbatim — it
   never needs to compute them itself, so no cross-system hash agreement can
   drift). status_() hands that receipt back without taking the script lock
   (a dirty read is harmless: at worst the receipt is one save behind and
   the client retries as it always did). A receipt match is exact — the tag
   is unique per attempt and the fingerprints cover the content — so a false
   "your save landed" is not possible short of a hash collision. */

function status_() {
  var txRows = -1;
  var customersRows = -1;
  try {
    ensureSheets_();
    var ss = getSpreadsheet_();
    var tx = ss.getSheetByName(SHEETS.transactions);
    var cu = ss.getSheetByName(SHEETS.customers);
    if (tx) txRows = Math.max(0, tx.getLastRow() - 1);
    if (cu) customersRows = Math.max(0, cu.getLastRow() - 1);
  } catch (err) { /* counts are informational — never fail the probe */ }
  return {
    success: true,
    version: BACKEND_VERSION,
    txRows: txRows,
    customersRows: customersRows,
    lastSave: lastSaveReceipt_(),
    // v3.8: the staging session the newest saveBegin started. A client whose
    // saveBegin answer was lost asks for this to recognise the session its
    // own uploadId created and continue it (see saveBegin_). The mode and the
    // staged counts let it refuse anything that is not a continuation of its
    // own upload.
    session: currentSessionInfo_(),
    // v3.9: non-blocking read of the save lock itself (see spaxLockProbe_).
    lock: spaxLockProbe_()
  };
}

// The session the newest saveBegin started, as `status` reports it. Lock-free
// and best-effort by design: a status probe must never fail and must never
// invent a session it cannot read.
function currentSessionInfo_() {
  try {
    var uploadId = String(PropertiesService.getScriptProperties().getProperty(LAST_BEGIN_KEY) || '');
    if (!uploadId) return null;
    var at = Number(PropertiesService.getScriptProperties().getProperty(LAST_BEGIN_AT_KEY)) || 0;
    var state = null;
    try {
      var raw = PropertiesService.getScriptProperties().getProperty(CHUNK_SEQ_KEY);
      if (raw) state = JSON.parse(raw);
    } catch (seqErr) { state = null; }
    var staged = {};
    Object.keys(BIG_TABLES).forEach(function (table) {
      try {
        var sheet = stagingSheet_(SHEETS[table]);
        staged[table] = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
      } catch (sheetErr) { staged[table] = -1; }
    });
    return {
      uploadId: uploadId,
      at: at,
      mode: (state && String(state.uploadId) === uploadId && state.delta) ? 'delta' : 'full',
      staged: staged
    };
  } catch (err) { return null; }
}

// An opaque session token: 6-80 characters of [A-Za-z0-9_-]. Anything else is
// refused and the server mints its own (see saveBegin_).
function cleanUploadId_(v) {
  var s = String(v == null ? '' : v);
  return /^[A-Za-z0-9_-]{6,80}$/.test(s) ? s : '';
}

// The receipt of the last successful save, or null when no v3.6 save has
// landed yet (or the property is unreadable).
function lastSaveReceipt_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(LAST_SAVE_KEY);
    if (!raw) return null;
    var rec = JSON.parse(raw);
    return rec && typeof rec === 'object' ? rec : null;
  } catch (err) { return null; }
}

// Called at the END of every successful save, after every sheet is written
// (and, for chunked saves, after the commit). Best-effort by design: if the
// property write fails the save itself still succeeded — verification just
// stays unavailable for this one attempt and the client retries as before.
function recordSaveReceipt_(body, txCount) {
  try {
    PropertiesService.getScriptProperties().setProperty(LAST_SAVE_KEY, JSON.stringify({
      tag: String((body && body.saveTag) || ''),
      txBasis: String((body && body.txBasis) || ''),
      smallBasis: String((body && body.smallBasis) || ''),
      txCount: Number(txCount) || 0,
      at: new Date().getTime()
    }));
  } catch (err) { /* best-effort only — see above */ }
}

/* ══════════ SAVE ══════════ */

// One-shot save. Now stages every table first and swaps the live sheets in
// only after all writes succeed — an aborted or timed-out execution leaves
// the live database at its previous, complete state instead of truncating it.
function saveAll_(body) {
  var held = spaxTakeSaveLock_();
  if (!held.lock) return backendBusy_(held.waited);
  var tWork = new Date().getTime();
  try {
    prepareStaging_();
    // Only the small tables can be skipped (a table the client re-sends
    // unchanged is not re-written); the big tables are always re-staged.
    var swapped = stageSmallTables_(body, true);
    stageBigTable_('transactions', body.transactions || []);
    stageBigTable_('customerTx', flattenCustomerTx_(body.customerTx || {}));
    stageBigTable_('seen', flattenSeen_(body.seen || {}));
    swapSheets_(swapped.concat(['transactions', 'customerTx', 'seen']));
    // Every sheet is swapped: a client whose response never arrived can now
    // be told its save landed (see status_).
    recordSaveReceipt_(body, (body.transactions || []).length);
    return spaxWithSrv_({ success: true }, held, tWork);
  } finally {
    held.lock.releaseLock();
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
  var held = spaxTakeSaveLock_();
  if (!held.lock) return backendBusy_(held.waited);
  var tWork = new Date().getTime();
  try {
    prepareStaging_();
    var swapped = stageSmallTables_(body, true);
    var addRows = body.txAdd || body.transactions || [];
    var result = appendNewTransactions_(addRows);
    // The derivable caches are no longer synced — empty them via the same
    // atomic swap the small tables use.
    writeObjects_(stagingSheet_(SHEETS.customerTx), [], TABLE_HEADERS.customerTx);
    writeObjects_(stagingSheet_(SHEETS.seen), [], TABLE_HEADERS.seen);
    swapSheetsIfChanged_(swapped.concat(['customerTx', 'seen']));
    // Transactions were appended live (not swapped); leave their staging
    // sheet header-only for the next chunked session.
    writeObjects_(stagingSheet_(SHEETS.transactions), [], TABLE_HEADERS.transactions);
    recordSaveReceipt_(body, result.total);
    return spaxWithSrv_({
      success: true,
      added: result.added,
      skippedDuplicates: result.skipped,
      transactions: result.total
    }, held, tWork);
  } finally {
    held.lock.releaseLock();
  }
}

/* ── targeted customer edit (v3.7) ── */

// body.edits = [{ oldName, oldContact, newName, newContact, customer }]
// `customer` is the full client record after the edit (TABLE_HEADERS.customers
// fields). The live row is located by the same name+contact merge key the
// client uses (falling back to name-only for records without a contact) and
// rewritten in place; a record the sheet does not hold yet is appended.
// A rename also rewrites the `name` cell of every live transaction row that
// carried the old name — exactly the rows the client rewrote locally.
function updateCustomer_(body) {
  var edits = (body && body.edits) || [];
  if (!edits.length) return { success: true, customersUpdated: 0, customersAdded: 0, transactionsRenamed: 0 };
  var held = spaxTakeSaveLock_();
  if (!held.lock) return backendBusy_(held.waited);
  var tWork = new Date().getTime();
  try {
    ensureSheets_();
    var ss = getSpreadsheet_();
    var cu = ss.getSheetByName(SHEETS.customers);
    ensureSheetHeader_(cu, TABLE_HEADERS.customers);
    var headers = TABLE_HEADERS.customers;
    var cuLast = cu.getLastRow();
    var cuValues = cuLast > 1 ? cu.getRange(2, 1, cuLast - 1, headers.length).getValues() : [];
    var sheetHeaders = cu.getRange(1, 1, 1, Math.max(cu.getLastColumn(), headers.length)).getValues()[0]
      .map(function (h) { return String(h || '').trim(); });
    var nameCol = sheetHeaders.indexOf('name');
    var contactCol = sheetHeaders.indexOf('contact');
    if (nameCol < 0) nameCol = 0;
    if (contactCol < 0) contactCol = 1;

    var updated = 0, added = 0, renamed = 0;
    var renames = [];
    edits.forEach(function (e) {
      if (!e || !e.customer || String(e.customer.name || '').trim() === '') return;
      var oldName = String(e.oldName == null ? e.customer.name : e.oldName);
      var oldContact = e.oldContact == null ? e.customer.contact : e.oldContact;
      var wantKey = gasNormName_(oldName) + '|' + gasNormContact_(oldContact);
      var wantLoose = gasNormName_(oldName) + '|';
      var rowIdx = -1, looseIdx = -1;
      for (var i = 0; i < cuValues.length; i++) {
        var k = gasNormName_(cuValues[i][nameCol]) + '|' + gasNormContact_(cuValues[i][contactCol]);
        if (k === wantKey) { rowIdx = i; break; }
        if (looseIdx < 0 && k === wantLoose) looseIdx = i;
      }
      if (rowIdx < 0 && gasNormContact_(oldContact) === '') rowIdx = looseIdx;
      var row = headers.map(function (h) {
        var v = e.customer[h];
        if (v === undefined || v === null) return '';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        return v;
      });
      if (rowIdx >= 0) {
        cu.getRange(rowIdx + 2, 1, 1, headers.length).setValues([row]);
        cuValues[rowIdx] = row.slice();
        updated++;
      } else {
        cu.getRange(cuValues.length + 2, 1, 1, headers.length).setValues([row]);
        cuValues.push(row.slice());
        added++;
      }
      var newName = String(e.customer.name);
      if (e.newName != null) newName = String(e.newName);
      if (newName !== oldName) renames.push({ from: oldName, to: newName });
    });

    // The Customers basis is what lets a later one-shot save skip re-staging
    // an unchanged table; it no longer describes the live sheet.
    try { PropertiesService.getScriptProperties().deleteProperty('spaxBasis_customers'); } catch (err) {}

    if (renames.length) {
      var tx = ss.getSheetByName(SHEETS.transactions);
      var txLast = tx ? tx.getLastRow() : 0;
      if (txLast > 1) {
        var txHeaders = tx.getRange(1, 1, 1, tx.getLastColumn()).getValues()[0]
          .map(function (h) { return String(h || '').trim(); });
        var txNameCol = txHeaders.indexOf('name');
        if (txNameCol >= 0) {
          var range = tx.getRange(2, txNameCol + 1, txLast - 1, 1);
          var names = range.getValues();
          var map = {};
          renames.forEach(function (r) { map[r.from] = r.to; });
          var changed = false;
          for (var j = 0; j < names.length; j++) {
            var cur = String(names[j][0] == null ? '' : names[j][0]);
            if (Object.prototype.hasOwnProperty.call(map, cur)) {
              names[j][0] = map[cur];
              renamed++;
              changed = true;
            }
          }
          if (changed) {
            range.setValues(names);
            // Receipt-less rows are keyed by name — the index is stale now.
            txKeyInvalidate_();
          }
        }
      }
    }
    return spaxWithSrv_({ success: true, customersUpdated: updated, customersAdded: added, transactionsRenamed: renamed }, held, tWork);
  } finally {
    held.lock.releaseLock();
  }
}

/* ── chunked actions ── */

function saveBegin_(body) {
  var held = spaxTakeSaveLock_();
  if (!held.lock) return backendBusy_(held.waited);
  var tWork = new Date().getTime();
  try {
    prepareStaging_();
    // No skip here: a chunked session stages now and swaps at commit,
    // minutes and several requests later.
    stageSmallTables_(body, false);
    // Big staging sheets are reset to header-only and filled by saveChunk.
    resetStaging_();
    // v3.8: a client that can mint its own session id sends one. It is stored
    // and enforced exactly like a server-minted id, and that is what lets a
    // client whose saveBegin ANSWER was lost (its own deadline on a slow
    // link, or the network dropping the reply) find this session again via
    // status_ and continue it, instead of re-beginning and wiping the
    // staging area it had just filled. Anything that is not a plain opaque
    // token is ignored and the id is minted here as before.
    var uploadId = cleanUploadId_(body && body.uploadId) || Utilities.getUuid();
    try {
      CacheService.getScriptCache().put(UPLOAD_KEY, uploadId, 3600);
    } catch (cacheErr) { /* best-effort session guard only */ }
    // Authoritative record of the newest session: the cache above may be
    // evicted at any time, but a stale chunk/commit must stay refused even
    // then (see uploadSessionCurrent_).
    try {
      PropertiesService.getScriptProperties().setProperty(LAST_BEGIN_KEY, uploadId);
    } catch (propErr) { /* best-effort — the cache check remains */ }
    try {
      PropertiesService.getScriptProperties().setProperty(LAST_BEGIN_AT_KEY, String(new Date().getTime()));
    } catch (propErr2) { /* best-effort — only the recovery probe reads it */ }
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
    return spaxWithSrv_(answer, held, tWork);
  } finally {
    held.lock.releaseLock();
  }
}

function saveChunk_(body) {
  var table = String(body.table || '');
  if (!BIG_TABLES[table]) {
    return { success: false, error: 'unknown table: ' + table };
  }
  if (!uploadSessionCurrent_(body.uploadId)) {
    return { success: false, error: 'upload superseded by a newer save — please retry the whole save' };
  }
  var held = spaxTakeSaveLock_();
  if (!held.lock) return backendBusy_(held.waited);
  var tWork = new Date().getTime();
  try {
    var sheet = stagingSheet_(SHEETS[table]);
    if (!sheet) {
      return spaxWithSrv_({ success: false, error: 'no upload in progress — saveBegin must run before saveChunk' }, held, tWork);
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
      return spaxWithSrv_({ success: true, written: 0, duplicate: true }, held, tWork);
    }
    var rows = body.rows || [];
    if (!rows.length) {
      if (hasSeq) recordChunkSeq_(body.uploadId, table, seq);
      return spaxWithSrv_({ success: true, written: 0 }, held, tWork);
    }
    appendObjects_(sheet, rows, TABLE_HEADERS[table]);
    if (hasSeq) recordChunkSeq_(body.uploadId, table, seq);
    return spaxWithSrv_({ success: true, written: rows.length }, held, tWork);
  } finally {
    held.lock.releaseLock();
  }
}

function saveCommit_(body) {
  // A commit from a superseded session must not swap in another device's
  // staged rows — it promised counts for slices that are no longer there.
  if (!uploadSessionCurrent_(body.uploadId)) {
    return { success: false, error: 'upload superseded by a newer save — please retry the whole save' };
  }
  // A commit that already succeeded answers success WITHOUT swapping again:
  // the swap already renamed the staging sheets over the live ones, so a
  // second swap would silently revert the live sheets to their pre-save
  // state. This is what a client retrying a commit whose response never
  // arrived must get (its session cursors say "everything sent", so it
  // re-commits rather than re-uploading).
  if (body.uploadId && committedUploadId_() === String(body.uploadId)) {
    return { success: true, duplicate: true };
  }
  var held = spaxTakeSaveLock_();
  if (!held.lock) return backendBusy_(held.waited);
  var tWork = new Date().getTime();
  try {
    // Delta sessions append new transactions instead of swapping tables —
    // they have their own commit (append + dedup, then swap only the small
    // and derivable-cache sheets). The client's explicit mode is honoured
    // too, so losing the session bookkeeping can never make a delta commit
    // swap the live Transactions sheet for a staging sheet holding only the
    // appended rows.
    if (body.mode === 'delta' || sessionIsDelta_(body.uploadId)) return spaxWithSrv_(commitDelta_(body), held, tWork);
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
        return spaxWithSrv_({
          success: false,
          error: 'chunk mismatch on ' + table + ': staged ' + staged + ' rows, expected ' + want +
                 ' — live data left untouched, please retry the save'
        }, held, tWork);
      }
    }
    // 2) Counts are exact — swap every live sheet for its staging copy.
    swapAllSheets_();
    try { CacheService.getScriptCache().remove(UPLOAD_KEY); } catch (cacheErr) {}
    try { PropertiesService.getScriptProperties().deleteProperty(CHUNK_SEQ_KEY); } catch (propsErr) {}
    rememberCommittedUpload_(body.uploadId);
    recordSaveReceipt_(body, Number((body.expect || {}).transactions || 0));
    return spaxWithSrv_({ success: true }, held, tWork);
  } finally {
    held.lock.releaseLock();
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
  // The small tables were staged at saveBegin, which stages all three
  // unconditionally (a chunked session spans requests, so it never relies on
  // a "this table did not change" decision that could be answered from
  // different data minutes later).
  swapSheetsIfChanged_(SMALL_TABLES.concat(['customerTx', 'seen']));
  // Transactions appended live rather than swapped — clear its staging area.
  writeObjects_(stagingSheet_(SHEETS.transactions), [], TABLE_HEADERS.transactions);
  try { CacheService.getScriptCache().remove(UPLOAD_KEY); } catch (cacheErr) {}
  try { PropertiesService.getScriptProperties().deleteProperty(CHUNK_SEQ_KEY); } catch (propsErr) {}
  rememberCommittedUpload_(body.uploadId);
  recordSaveReceipt_(body, result.total);
  return {
    success: true,
    added: result.added,
    skippedDuplicates: result.skipped,
    transactions: result.total
  };
}

// waitLock returning false means another writer still holds the save lock.
// Proceeding anyway is how two saves interleave their renames, so refuse the
// request instead — the client's next save retries with the latest data.
//
// v3.9: the save lock is the USER lock, not the script lock (see the header —
// identical serialisation for an Execute-as-Me web app, but a fresh lock
// object for deployments whose script lock is stuck). Every acquisition is
// timed: the wait rides every answer as `srv`, so the client can tell a
// refusal that waited ~30s behind a real writer from one that failed
// instantly with no holder. A LockService EXCEPTION (service error) is also
// answered as busy — with a ~0s wait as the tell — because the client's
// busy path backs off and retries, while any other failure kills the save
// outright, and a service blip must never kill a save.
function spaxTakeSaveLock_() {
  var t0 = new Date().getTime();
  var lock = null;
  var ok = false;
  try {
    lock = LockService.getUserLock();
    ok = lock.waitLock(30000);
  } catch (err) {
    ok = false;
  }
  var waited = new Date().getTime() - t0;
  if (!ok) return { lock: null, waited: waited };
  return { lock: lock, waited: waited };
}

// Attach the server-side timing to an in-lock answer. Pre-lock refusals
// (unknown table, superseded session) carry none — no lock was involved.
function spaxWithSrv_(answer, held, tWork) {
  if (answer && typeof answer === 'object' && !answer.srv) {
    answer.srv = { wait: held.waited, work: new Date().getTime() - Number(tWork || 0) };
  }
  return answer;
}

function backendBusy_(waitedMs) {
  var ans = { success: false, error: 'backend busy with another save — please retry the save' };
  if (waitedMs !== undefined && waitedMs !== null) ans.srv = { wait: waitedMs };
  return ans;
}

// Non-blocking read of the save lock for action=status: acquired and
// released immediately when free, never waited on, never allowed to fail
// the probe. Tells the app whether the lock is free RIGHT NOW.
function spaxLockProbe_() {
  try {
    var t0 = new Date().getTime();
    var free = false;
    try {
      var probe = LockService.getUserLock();
      free = !!probe.tryLock(0);
      if (free) {
        try { probe.releaseLock(); } catch (relErr) { /* held for ~0ms; harmless */ }
      }
    } catch (tryErr) {
      return { free: false, ms: new Date().getTime() - t0 };
    }
    return { free: free, ms: new Date().getTime() - t0 };
  } catch (err) {
    return { free: false, ms: -1 };
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

/* Stages Customers / Monthly / Settings and returns the keys it actually
   wrote, so the caller swaps exactly those.

   With `allowSkip` (the ONE-SHOT paths — saveAll and saveDelta stage and
   swap inside a single request, so the decision cannot go stale) a table the
   client re-sends unchanged is not staged at all: the live sheet already
   holds exactly those values, and staging + writing + swapping Customers
   (the biggest routine write in a save, ~1.5k rows × 14 columns) plus
   clearing the copy it displaces was the second-slowest thing every save
   did. Chunked sessions pass false: they stage in saveBegin and swap minutes
   later in saveCommit, and must never depend on a decision answered from
   different data. */
function stageSmallTables_(body, allowSkip) {
  var staged = [];

  var customers = (body.customers || []).filter(function (c) {
    return c && String(c.name || '').trim() !== '';
  });
  if (stageSmallTable_('customers', customers, allowSkip)) staged.push('customers');

  var monthly = body.monthly || { labels: [], revenue: [] };
  var monthRows = (monthly.labels || []).map(function (label, i) {
    return { label: label, revenue: monthly.revenue[i] };
  });
  if (stageSmallTable_('monthly', monthRows, allowSkip)) staged.push('monthly');

  var settings = body.settings || {};
  var settingRows = Object.keys(settings).map(function (k) {
    return { key: k, value: settings[k] };
  });
  if (stageSmallTable_('settings', settingRows, allowSkip)) staged.push('settings');

  return staged;
}

// Writes one small table to its staging sheet. Returns false when the table
// was recognised as unchanged and therefore left unstaged — the caller must
// then not swap it either.
function stageSmallTable_(key, rows, allowSkip) {
  var headers = TABLE_HEADERS[key];
  var sheet = stagingSheet_(SHEETS[key]);
  var valueRows = rows.map(function (r) {
    return headers.map(function (h) {
      var v = r[h];
      if (v === undefined || v === null) return '';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      return v;
    });
  });
  var basis = valueRows.length + ':' + valueBasis_(valueRows);
  var propKey = 'spaxBasis_' + key;
  var previous = null;
  try { previous = PropertiesService.getScriptProperties().getProperty(propKey); } catch (err) {}
  if (allowSkip && previous === basis) {
    // Identical to what this script last wrote AND the live sheet still has
    // exactly that many rows: the write would be a byte-for-byte no-op.
    var live = getSpreadsheet_().getSheetByName(SHEETS[key]);
    if (live && Math.max(0, live.getLastRow() - 1) === valueRows.length) return false;
  }
  writeValueRows_(sheet, valueRows, headers);
  try { PropertiesService.getScriptProperties().setProperty(propKey, basis); } catch (err) {}
  return true;
}

// Cheap fingerprint of already-coerced value rows: a rolling hash over every
// character plus the total length, so one changed cell changes the basis.
function valueBasis_(valueRows) {
  var h = 0;
  var len = 0;
  for (var i = 0; i < valueRows.length; i++) {
    var row = valueRows[i];
    for (var j = 0; j < row.length; j++) {
      var s = String(row[j]);
      len += s.length;
      for (var k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
    }
  }
  return (h >>> 0) + ':' + len;
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
    // The old live sheet becomes the next staging sheet. It is NOT cleared
    // here any more: clearing a sheet that holds tens of thousands of rows
    // was one of the slowest calls in every save, and it was never needed —
    // every writer clears its staging sheet before staging anything
    // (writeObjects_ for the small tables and resetStaging_, saveChunk only
    // ever runs after a saveBegin that reset the area), so those rows cannot
    // leak into a later upload.
    if (tmp) tmp.setName(liveName + STAGE_SUFFIX);
    // A live sheet replaced wholesale invalidates the transaction key index:
    // the keys it holds describe rows that are gone.
    if (k === 'transactions') txKeyInvalidate_();
  });
}

// Swaps only the tables that would actually change. CustomerTx and Seen are
// caches the client stopped syncing: after the first save that emptied them
// they are empty on both sides, and swapping two empty sheets still costs
// three lookups and two renames each — every single save.
function swapSheetsIfChanged_(keys) {
  var ss = getSpreadsheet_();
  var needed = keys.filter(function (k) {
    var liveName = SHEETS[k];
    if (!liveName) return false;
    var staging = ss.getSheetByName(liveName + STAGE_SUFFIX);
    if (!staging) return true; // nothing staged — nothing to skip
    var live = ss.getSheetByName(liveName);
    var stagedRows = Math.max(0, staging.getLastRow() - 1);
    var liveRows = live ? Math.max(0, live.getLastRow() - 1) : -1;
    // Both sides empty (header-only): the swap would replace nothing with
    // nothing. Anything else goes through the real swap.
    return !(stagedRows === 0 && liveRows === 0);
  });
  if (needed.length) swapSheets_(needed);
}

// Every table — the full stage-and-swap used by a full commit.
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
//
// The duplicate guard reads the TxKeys index (ONE column) instead of the
// whole live sheet (eleven columns) and appends the new rows' keys to it, so
// a routine save no longer pays for a full read of the database.
function appendNewTransactions_(rows) {
  var live = getSpreadsheet_().getSheetByName(SHEETS.transactions);
  if (!live) throw new Error('missing live Transactions sheet');
  ensureSheetHeader_(live, TABLE_HEADERS.transactions);
  var liveRows = Math.max(0, live.getLastRow() - 1);
  var index = txKeyRead_(liveRows);
  var have = index.have;
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
  if (fresh.length) {
    appendObjects_(live, fresh, TABLE_HEADERS.transactions);
    // Index rows are 1:1 with the live sheet's data rows, so the keys of the
    // rows just appended land directly below the ones already indexed.
    txKeyAppend_(fresh, liveRows);
    liveRows += fresh.length;
  }
  return { added: fresh.length, skipped: skipped, total: liveRows };
}

/* ── transaction key index ──
   The narrow mirror of the live Transactions sheet that makes a delta save
   cheap. Row N holds every identity key of live row N+1 (row 1 of the sheet
   is the header), newline-separated, so the duplicate guard reads one column
   of short strings instead of eleven columns of everything.

   Derived data, never trusted blindly: it is used only when its row count
   matches the live sheet's, it is invalidated whenever the live sheet is
   replaced wholesale, and it is rebuilt when it gets too old (so a hand edit
   made straight in Google Sheets cannot be missed for more than
   TX_KEY_MAX_AGE_MS). The worst a wrong index can cost is one extra read —
   never a duplicate row. */

function txKeySheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(TX_KEY_SHEET);
  if (!sheet) sheet = ss.insertSheet(TX_KEY_SHEET);
  return sheet;
}

// How many live rows the index mirrors. -1 = invalid (rebuild before use).
function txKeyIndexedRows_() {
  try {
    var n = Number(PropertiesService.getScriptProperties().getProperty(TX_KEY_PROP));
    return isFinite(n) ? n : -1;
  } catch (err) { return -1; }
}

function txKeySetIndexedRows_(n) {
  try { PropertiesService.getScriptProperties().setProperty(TX_KEY_PROP, String(n)); } catch (err) {}
}

function txKeyInvalidate_() {
  txKeySetIndexedRows_(-1);
}

// A bounded-lifetime index: an edit made directly in the sheet (outside this
// script) does not change the row count, so it cannot be detected any other
// way than re-deriving the keys from the rows themselves.
function txKeyFresh_() {
  try {
    var stamp = Number(PropertiesService.getScriptProperties().getProperty(TX_KEY_STAMP_PROP));
    return !!stamp && (new Date().getTime() - stamp) < TX_KEY_MAX_AGE_MS;
  } catch (err) { return false; }
}

function txKeyStamp_() {
  try {
    PropertiesService.getScriptProperties().setProperty(TX_KEY_STAMP_PROP, String(new Date().getTime()));
  } catch (err) {}
}

// {have, rows}: the identity set for the live sheet's first `liveRows` rows.
// Rebuilds the index when it is missing, stale or out of step with the sheet
// — the rebuild is exactly the read every delta used to do, so the slow path
// is never worse than before. It is just rare.
function txKeyRead_(liveRows) {
  var have = {};
  if (txKeyIndexedRows_() === liveRows && txKeyFresh_()) {
    if (liveRows > 0) {
      var values = txKeySheet_().getRange(1, 1, liveRows, 1).getValues();
      for (var i = 0; i < values.length; i++) {
        var keys = String(values[i][0] == null ? '' : values[i][0]).split('\n');
        for (var j = 0; j < keys.length; j++) {
          if (keys[j]) have[keys[j]] = 1;
        }
      }
    }
    return { have: have, rows: liveRows };
  }
  return txKeyRebuild_();
}

// Recompute the index from the live sheet. Needed after anything that changed
// the sheet outside a delta append (a full save, Delete All, a hand edit, the
// first save after this redeploy) — after which appends keep it current.
function txKeyRebuild_() {
  var live = getSpreadsheet_().getSheetByName(SHEETS.transactions);
  if (!live) throw new Error('missing live Transactions sheet');
  var last = live.getLastRow();
  var values = last > 0 ? live.getDataRange().getValues() : [];
  var headers = values.length ? values[0].map(function (h) { return String(h || '').trim(); }) : [];
  var lines = [];
  var have = {};
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var obj = {};
    headers.forEach(function (h, j) { if (h) obj[h] = row[j]; });
    // Rows are mirrored position-for-position, blank rows included, so the
    // index stays row-aligned with the sheet it describes.
    var keys = txIdentityKeys_(obj);
    for (var j = 0; j < keys.length; j++) if (keys[j]) have[keys[j]] = 1;
    lines.push([keys.join('\n')]);
  }
  var sheet = txKeySheet_();
  sheet.clearContents();
  if (lines.length) sheet.getRange(1, 1, lines.length, 1).setValues(lines);
  txKeySetIndexedRows_(lines.length);
  txKeyStamp_();
  return { have: have, rows: lines.length };
}

// Append the keys of rows just added to the live sheet, starting at index row
// `at + 1` (the live row they became).
function txKeyAppend_(rows, at) {
  if (!rows || !rows.length) return;
  var lines = [];
  for (var i = 0; i < rows.length; i++) lines.push([txIdentityKeys_(rows[i]).join('\n')]);
  txKeySheet_().getRange(at + 1, 1, lines.length, 1).setValues(lines);
  txKeySetIndexedRows_(at + lines.length);
  txKeyStamp_();
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

// Same question, answered authoritatively: saveBegin records the newest
// uploadId in Script Properties (which persist, unlike the cache above), so
// a stale chunk/commit is refused even after the cache entry expired —
// including a replay from a tab whose commit already landed and was
// superseded by another save since. Anything the property cannot decide
// (no property yet, legacy client without an id) falls back to the cache
// check, so pre-v3.6 behaviour is unchanged there.
function uploadSessionCurrent_(uploadId) {
  if (uploadId) {
    try {
      var newest = PropertiesService.getScriptProperties().getProperty(LAST_BEGIN_KEY);
      if (newest && String(newest) !== String(uploadId)) return false;
    } catch (err) { /* fall through to the cache check */ }
  }
  return uploadSessionValid_(uploadId);
}

// The uploadId of the last committed chunked save ('' when none). A commit
// carrying it is a replay of an already-successful commit.
function committedUploadId_() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(COMMITTED_KEY) || '');
  } catch (err) { return ''; }
}

function rememberCommittedUpload_(uploadId) {
  if (!uploadId) return;
  try {
    PropertiesService.getScriptProperties().setProperty(COMMITTED_KEY, String(uploadId));
  } catch (err) { /* best-effort — the count check remains the safety net */ }
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
// A single save asks for the spreadsheet a dozen times (once per staging
// sheet, per write, per rename). Each call used to re-read the Script
// Property AND re-open the spreadsheet by id — two API round-trips, every
// time. The handle is cached for this execution instead. It is invalidated
// with the stored id, so a deployment whose spreadsheet is (re)created
// always resolves to the current one.
var SPREADSHEET_CACHE_ = null;

function getSpreadsheet_() {
  if (SPREADSHEET_CACHE_) return SPREADSHEET_CACHE_;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPAX_SPREADSHEET_ID');
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); }
    catch (err) { props.deleteProperty('SPAX_SPREADSHEET_ID'); ss = null; }
  }
  if (!ss) {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      props.setProperty('SPAX_SPREADSHEET_ID', active.getId());
      ss = active;
    } else {
      ss = SpreadsheetApp.create('SpaxButchery Cloud Data');
      props.setProperty('SPAX_SPREADSHEET_ID', ss.getId());
    }
  }
  SPREADSHEET_CACHE_ = ss;
  return ss;
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
