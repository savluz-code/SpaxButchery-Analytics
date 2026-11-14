package com.spaxbutchery.sms;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.text.TextUtils;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import com.spaxbutchery.sms.CampaignModels.CampaignState;
import com.spaxbutchery.sms.CampaignModels.Counts;
import com.spaxbutchery.sms.CampaignModels.RecipientItem;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public final class MainActivity extends Activity implements CampaignStore.Listener {

    private static final int REQ_PERMISSIONS = 101;
    private static final int REQ_PICK_JSON = 102;
    private static final int MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB
    private static final String EXTRA_CONSUMED = "_spax_intent_consumed";
    private static final String ANALYTICS_URL = "https://savluz-code.github.io/SpaxButchery-Analytics/";

    // SpaxButchery dark palette
    private static final int COL_BG = Color.parseColor("#0F1419");
    private static final int COL_CARD = Color.parseColor("#1A2129");
    private static final int COL_CARD2 = Color.parseColor("#212B35");
    private static final int COL_BORDER = Color.parseColor("#2C3945");
    private static final int COL_RED = Color.parseColor("#E63946");
    private static final int COL_GREEN = Color.parseColor("#2EC4B6");
    private static final int COL_BLUE = Color.parseColor("#4CC9F0");
    private static final int COL_AMBER = Color.parseColor("#F4A261");
    private static final int COL_TEXT = Color.parseColor("#E8EDF2");
    private static final int COL_MUTED = Color.parseColor("#8B9AA7");

    private static final int[] DELAY_VALUES = new int[]{12, 32, 7, 4};
    private static final String[] DELAY_LABELS = new String[]{
            "Balanced Safe — 12s / SMS (Default)",
            "Hands-Free 300+ — 32s / SMS (Under 30/15m cap)",
            "Moderate — 7s / SMS",
            "Fast (Small lists <=30) — 4s / SMS"
    };

    private CampaignStore store;

    private TextView tvBridgeBadge;
    private TextView tvPermSummary;
    private TextView tvRestrictedHint;
    private Button btnGrantPerms;
    private Button btnAppSettings;
    private Button btnBatteryOpt;
    private Button btnToggleBridge;

    private Spinner spSim;
    private Spinner spDelay;
    private final List<Integer> simSubIds = new ArrayList<>();
    private final List<String> simLabels = new ArrayList<>();
    private boolean suppressSpinnerEvents = false;

    private TextView tvCampaignTitle;
    private TextView tvCampaignStatus;
    private ProgressBar progressBar;
    private TextView tvKpiPending;
    private TextView tvKpiSent;
    private TextView tvKpiDelivered;
    private TextView tvKpiFailed;
    private TextView tvUnicodeNotice;
    private TextView tvPreviewSample;
    private TextView tvRecipientLog;

    private Button btnStartResume;
    private Button btnPause;
    private Button btnRetryFailed;
    private Button btnClear;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = CampaignStore.getInstance(this);
        buildUi();
        populateSimOptions();
        syncSpinnersFromPrefs();
        startBridgeService();
        renderState();
        handleIncomingIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        store.addListener(this);
        populateSimOptions();
        renderState();
    }

    @Override
    protected void onResume() {
        super.onResume();
        renderPermissionsState();
        renderState();
    }

    @Override
    protected void onStop() {
        store.removeListener(this);
        super.onStop();
    }

    @Override
    public void onCampaignUpdated() {
        renderState();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(COL_BG);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(COL_BG);

        // 1. Header Banner matching SpaxButchery Analytics
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable hdrBg = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{Color.parseColor("#7F1D1D"), Color.parseColor("#450A0A")});
        header.setBackground(hdrBg);
        header.setPadding(dp(20), dp(18), dp(20), dp(16));

        TextView hdrTitle = new TextView(this);
        hdrTitle.setText("SpaxButchery SMS Companion");
        hdrTitle.setTextColor(COL_TEXT);
        hdrTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        hdrTitle.setTypeface(Typeface.DEFAULT_BOLD);
        header.addView(hdrTitle);

        TextView hdrSub = new TextView(this);
        hdrSub.setText("Personalized Bulk SIM Sender · Sends from your phone's SIM bundle");
        hdrSub.setTextColor(Color.parseColor("#FCA5A5"));
        hdrSub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        hdrSub.setPadding(0, dp(3), 0, dp(8));
        header.addView(hdrSub);

        tvBridgeBadge = new TextView(this);
        tvBridgeBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tvBridgeBadge.setPadding(dp(10), dp(5), dp(10), dp(5));
        tvBridgeBadge.setBackground(roundedBox(Color.parseColor("#4D000000"), dp(8), 0, 0));
        tvBridgeBadge.setTextColor(Color.parseColor("#FECACA"));
        LinearLayout.LayoutParams badgeLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        header.addView(tvBridgeBadge, badgeLp);

        root.addView(header);

        View redLine = new View(this);
        redLine.setBackgroundColor(COL_RED);
        root.addView(redLine, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        // Content container
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(14), dp(14), dp(14), dp(28));
        root.addView(body);

        // 2. Permissions & Background Readiness Card
        LinearLayout permCard = createCard("1. SIM Permissions & Background Readiness");
        tvPermSummary = createBodyText("", COL_TEXT, 13);
        permCard.addView(tvPermSummary);

        tvRestrictedHint = createBodyText(
                "Android 13+ tip: If SMS permission is greyed out after installing this APK, tap 'App Settings' below -> tap the 3 dots (top-right) -> 'Allow restricted settings', then come back and tap 'Grant Permissions'.",
                COL_AMBER, 12);
        tvRestrictedHint.setPadding(0, dp(6), 0, dp(6));
        permCard.addView(tvRestrictedHint);

        LinearLayout permBtns1 = createButtonRow();
        btnGrantPerms = createButton("Grant Permissions", COL_BLUE, Color.parseColor("#081C24"));
        btnGrantPerms.setOnClickListener(v -> requestNeededPermissions());
        permBtns1.addView(btnGrantPerms, weightedBtnParams(true));

        btnAppSettings = createButton("App Settings", COL_CARD2, COL_TEXT);
        btnAppSettings.setOnClickListener(v -> openAppSettings());
        permBtns1.addView(btnAppSettings, weightedBtnParams(false));
        permCard.addView(permBtns1);

        LinearLayout permBtns2 = createButtonRow();
        btnBatteryOpt = createButton("Unrestricted Battery", COL_CARD2, COL_TEXT);
        btnBatteryOpt.setOnClickListener(v -> requestUnrestrictedBattery());
        permBtns2.addView(btnBatteryOpt, weightedBtnParams(true));

        btnToggleBridge = createButton("Restart Bridge", COL_CARD2, COL_TEXT);
        btnToggleBridge.setOnClickListener(v -> toggleBridgeService());
        permBtns2.addView(btnToggleBridge, weightedBtnParams(false));
        permCard.addView(permBtns2);

        body.addView(permCard);

        // 3. SIM Card & Pacing Card
        LinearLayout cfgCard = createCard("2. SIM Line & Safe Pacing");
        cfgCard.addView(createLabel("SEND USING SIM CARD"));
        spSim = createStyledSpinner();
        spSim.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (suppressSpinnerEvents) return;
                if (position >= 0 && position < simSubIds.size()) {
                    store.setSubscriptionId(simSubIds.get(position));
                }
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        cfgCard.addView(spSim);

        TextView lblDelay = createLabel("DELAY BETWEEN MESSAGES (PROTECTS SIM & BUNDLE)");
        lblDelay.setPadding(0, dp(10), 0, dp(4));
        cfgCard.addView(lblDelay);

        spDelay = createStyledSpinner();
        ArrayAdapter<String> delayAdapter = createSpinnerAdapter(java.util.Arrays.asList(DELAY_LABELS));
        spDelay.setAdapter(delayAdapter);
        spDelay.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (suppressSpinnerEvents) return;
                if (position >= 0 && position < DELAY_VALUES.length) {
                    store.setDelaySeconds(DELAY_VALUES[position]);
                }
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        cfgCard.addView(spDelay);
        body.addView(cfgCard);

        // 4. Active Campaign & Controls Card
        LinearLayout campCard = createCard("3. Personalized Campaign Queue");
        tvCampaignTitle = createBodyText("No campaign loaded", COL_TEXT, 15);
        tvCampaignTitle.setTypeface(Typeface.DEFAULT_BOLD);
        campCard.addView(tvCampaignTitle);

        tvCampaignStatus = createBodyText("", COL_MUTED, 12.5f);
        tvCampaignStatus.setPadding(0, dp(4), 0, dp(10));
        campCard.addView(tvCampaignStatus);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(0);
        LinearLayout.LayoutParams pbLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(10));
        pbLp.bottomMargin = dp(12);
        campCard.addView(progressBar, pbLp);

        // KPI Counters Row
        LinearLayout kpiRow = new LinearLayout(this);
        kpiRow.setOrientation(LinearLayout.HORIZONTAL);
        tvKpiPending = createKpiPill(kpiRow, "PENDING", COL_BLUE, true);
        tvKpiSent = createKpiPill(kpiRow, "SENT", COL_GREEN, true);
        tvKpiDelivered = createKpiPill(kpiRow, "DELIV.", COL_GREEN, true);
        tvKpiFailed = createKpiPill(kpiRow, "FAILED", COL_RED, false);
        campCard.addView(kpiRow);

        tvUnicodeNotice = createBodyText("", COL_AMBER, 12);
        tvUnicodeNotice.setPadding(0, dp(8), 0, 0);
        tvUnicodeNotice.setVisibility(View.GONE);
        campCard.addView(tvUnicodeNotice);

        // Control buttons
        LinearLayout ctrlRow1 = createButtonRow();
        btnStartResume = createButton("Start Sending", COL_GREEN, Color.parseColor("#06231F"));
        btnStartResume.setOnClickListener(v -> onStartOrResumeClicked());
        ctrlRow1.addView(btnStartResume, weightedBtnParams(true));

        btnPause = createButton("Pause", COL_AMBER, Color.parseColor("#231404"));
        btnPause.setOnClickListener(v -> sendServiceCommand(SmsCampaignService.ACTION_PAUSE_SENDING));
        ctrlRow1.addView(btnPause, weightedBtnParams(false));
        campCard.addView(ctrlRow1);

        LinearLayout ctrlRow2 = createButtonRow();
        btnRetryFailed = createButton("Retry Failed", COL_CARD2, COL_TEXT);
        btnRetryFailed.setOnClickListener(v -> onRetryFailedClicked());
        ctrlRow2.addView(btnRetryFailed, weightedBtnParams(true));

        btnClear = createButton("Clear Queue", COL_CARD2, COL_MUTED);
        btnClear.setOnClickListener(v -> onClearClicked());
        ctrlRow2.addView(btnClear, weightedBtnParams(false));
        campCard.addView(ctrlRow2);

        TextView lblPrev = createLabel("PERSONALIZED PREVIEW");
        lblPrev.setPadding(0, dp(14), 0, dp(4));
        campCard.addView(lblPrev);

        tvPreviewSample = createBodyText("—", COL_TEXT, 13);
        tvPreviewSample.setPadding(dp(12), dp(10), dp(12), dp(10));
        tvPreviewSample.setBackground(roundedBox(COL_CARD2, dp(8), dp(1), COL_BORDER));
        campCard.addView(tvPreviewSample);

        TextView lblLog = createLabel("RECIPIENT STATUS LOG");
        lblLog.setPadding(0, dp(12), 0, dp(4));
        campCard.addView(lblLog);

        tvRecipientLog = createBodyText("Waiting for Outreach batch…", COL_MUTED, 12);
        tvRecipientLog.setTypeface(Typeface.MONOSPACE);
        tvRecipientLog.setPadding(dp(10), dp(10), dp(10), dp(10));
        tvRecipientLog.setBackground(roundedBox(COL_CARD2, dp(8), dp(1), COL_BORDER));
        campCard.addView(tvRecipientLog);

        body.addView(campCard);

        // 5. Import / Open Spax Analytics Card
        LinearLayout impCard = createCard("4. Load Batch / Open Dashboard");
        TextView impHint = createBodyText(
                "In SpaxButchery Analytics -> Outreach, tap 'Personalized Bulk SMS (Spax App)' for 1-tap handoff, or import a saved .json batch below:",
                COL_MUTED, 12.5f);
        impCard.addView(impHint);

        LinearLayout impRow1 = createButtonRow();
        Button btnPickFile = createButton("Import .json File", COL_CARD2, COL_TEXT);
        btnPickFile.setOnClickListener(v -> pickJsonFile());
        impRow1.addView(btnPickFile, weightedBtnParams(true));

        Button btnPaste = createButton("Paste Clipboard", COL_CARD2, COL_TEXT);
        btnPaste.setOnClickListener(v -> importFromClipboard());
        impRow1.addView(btnPaste, weightedBtnParams(false));
        impCard.addView(impRow1);

        LinearLayout impRow2 = createButtonRow();
        Button btnOpenDash = createButton("Open SpaxButchery Analytics", COL_BLUE, Color.parseColor("#081C24"));
        btnOpenDash.setOnClickListener(v -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(ANALYTICS_URL)));
            } catch (Exception e) {
                Toast.makeText(this, "No browser found", Toast.LENGTH_SHORT).show();
            }
        });
        impRow2.addView(btnOpenDash, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        impCard.addView(impRow2);

        body.addView(impCard);

        scroll.addView(root);
        setContentView(scroll);
    }

    private void renderPermissionsState() {
        boolean smsOk = checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED;
        boolean phoneOk = checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
        boolean notifOk = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        boolean batteryOk = pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());

        String summary = (smsOk ? "[OK] SMS Send Permitted" : "[NEEDED] SMS Send Permission")
                + "  ·  " + (phoneOk ? "[OK] Dual-SIM Info" : "[Optional] Dual-SIM Info")
                + "\n" + (notifOk ? "[OK] Progress Notifications" : "[Optional] Notifications")
                + "  ·  " + (batteryOk ? "[OK] Unrestricted Battery" : "[Recommended] Unrestricted Battery");
        tvPermSummary.setText(summary);
        tvPermSummary.setTextColor(smsOk ? COL_GREEN : COL_AMBER);
        tvRestrictedHint.setVisibility(smsOk ? View.GONE : View.VISIBLE);
        btnGrantPerms.setText(smsOk && phoneOk && notifOk ? "Permissions OK" : "Grant Permissions");
        btnBatteryOpt.setText(batteryOk ? "Battery: Unrestricted" : "Allow Background Battery");
    }

    private void renderState() {
        renderPermissionsState();

        boolean bridgeUp = store.isBridgeRunning();
        tvBridgeBadge.setText(bridgeUp
                ? "Bridge ON · 127.0.0.1:" + LocalBridgeServer.PORT + " ready for Outreach"
                : "Bridge OFF · Tap 'Start Bridge' to enable 1-tap web handoff");
        btnToggleBridge.setText(bridgeUp ? "Stop Bridge" : "Start Bridge");

        CampaignState snap = store.snapshot();
        Counts c = snap.computeCounts();

        if (c.total == 0) {
            tvCampaignTitle.setText("No campaign loaded yet");
            tvCampaignStatus.setText("Select a segment in SpaxButchery Outreach and tap 'Personalized Bulk SMS (Spax App)'.");
            progressBar.setMax(100);
            progressBar.setProgress(0);
            tvKpiPending.setText("0\nPENDING");
            tvKpiSent.setText("0\nSENT");
            tvKpiDelivered.setText("0\nDELIV.");
            tvKpiFailed.setText("0\nFAILED");
            tvUnicodeNotice.setVisibility(View.GONE);
            tvPreviewSample.setText("—");
            tvRecipientLog.setText("Waiting for Outreach batch…");
            btnStartResume.setEnabled(false);
            btnStartResume.setAlpha(0.45f);
            btnStartResume.setText("Start Sending");
            btnPause.setEnabled(false);
            btnPause.setAlpha(0.45f);
            btnRetryFailed.setEnabled(false);
            btnRetryFailed.setAlpha(0.45f);
            btnClear.setEnabled(false);
            btnClear.setAlpha(0.45f);
            return;
        }

        tvCampaignTitle.setText(snap.segmentLabel + " — " + c.total + " recipients (" + c.totalSegments + " SMS)");
        String skipNote = (snap.skippedInvalid + snap.skippedDuplicate) > 0
                ? " · Skipped " + snap.skippedInvalid + " invalid, " + snap.skippedDuplicate + " duplicate"
                : "";
        tvCampaignStatus.setText("[" + snap.status + "] " + snap.statusMessage + skipNote);

        int processed = c.sent + c.failed + c.unknown;
        progressBar.setMax(Math.max(1, c.total));
        progressBar.setProgress(processed);

        tvKpiPending.setText((c.pending + c.sending) + "\nPENDING");
        tvKpiSent.setText(c.sent + "\nSENT");
        tvKpiDelivered.setText(c.delivered + "\nDELIV.");
        tvKpiFailed.setText((c.failed + (c.unknown > 0 ? "+" + c.unknown + "?" : "")) + "\nFAILED");

        if (c.hasUnicode) {
            tvUnicodeNotice.setVisibility(View.VISIBLE);
            tvUnicodeNotice.setText("Note: Emoji/Unicode detected (UCS-2 encoding, 70 chars per SMS). Plain text fits 160 chars per SMS.");
        } else {
            tvUnicodeNotice.setVisibility(View.GONE);
        }

        boolean isRunning = CampaignModels.CAMPAIGN_RUNNING.equals(snap.status);
        boolean canStart = !isRunning && c.pending > 0;
        btnStartResume.setEnabled(canStart);
        btnStartResume.setAlpha(canStart ? 1f : 0.45f);
        btnStartResume.setText(CampaignModels.CAMPAIGN_PAUSED.equals(snap.status)
                ? "Resume (" + c.pending + ")"
                : "Start Sending (" + c.pending + ")");

        btnPause.setEnabled(isRunning);
        btnPause.setAlpha(isRunning ? 1f : 0.45f);

        btnRetryFailed.setEnabled(!isRunning && c.failed > 0);
        btnRetryFailed.setAlpha((!isRunning && c.failed > 0) ? 1f : 0.45f);
        btnRetryFailed.setText(c.failed > 0 ? "Retry Failed (" + c.failed + ")" : "Retry Failed");

        btnClear.setEnabled(!isRunning);
        btnClear.setAlpha(!isRunning ? 1f : 0.45f);

        // Preview next pending (or first item)
        RecipientItem sample = snap.items.get(0);
        for (RecipientItem item : snap.items) {
            if (CampaignModels.ITEM_SENDING.equals(item.status) || CampaignModels.ITEM_PENDING.equals(item.status)) {
                sample = item;
                break;
            }
        }
        tvPreviewSample.setText("To: " + sample.name + " (" + sample.to + ") · "
                + sample.segments + " SMS (" + sample.encoding + ")\n\n" + sample.message);

        // Build compact live status log (prioritize active, failed/unknown, recent sent, upcoming)
        StringBuilder log = new StringBuilder(2048);
        int shown = 0;
        int maxRows = 80;
        for (RecipientItem item : snap.items) {
            if (shown >= maxRows) break;
            if (CampaignModels.ITEM_SENDING.equals(item.status)
                    || CampaignModels.ITEM_FAILED.equals(item.status)
                    || CampaignModels.ITEM_UNKNOWN.equals(item.status)) {
                appendLogLine(log, item);
                shown++;
            }
        }
        for (RecipientItem item : snap.items) {
            if (shown >= maxRows) break;
            if (!CampaignModels.ITEM_SENDING.equals(item.status)
                    && !CampaignModels.ITEM_FAILED.equals(item.status)
                    && !CampaignModels.ITEM_UNKNOWN.equals(item.status)) {
                appendLogLine(log, item);
                shown++;
            }
        }
        if (snap.items.size() > shown) {
            log.append("\n… and ").append(snap.items.size() - shown).append(" more recipients");
        }
        tvRecipientLog.setText(log.toString());
    }

    private static void appendLogLine(StringBuilder sb, RecipientItem item) {
        if (sb.length() > 0) sb.append('\n');
        String tag;
        switch (item.status) {
            case CampaignModels.ITEM_DELIVERED: tag = "[DELIV]"; break;
            case CampaignModels.ITEM_SENT:      tag = "[SENT ]"; break;
            case CampaignModels.ITEM_SENDING:   tag = "[SEND…]"; break;
            case CampaignModels.ITEM_FAILED:    tag = "[FAIL ]"; break;
            case CampaignModels.ITEM_UNKNOWN:   tag = "[UNKN?]"; break;
            default:                            tag = "[WAIT ]"; break;
        }
        sb.append(tag).append(' ').append(item.name).append(" (").append(item.to).append(')');
        if (item.detail != null && !item.detail.isEmpty()
                && (CampaignModels.ITEM_FAILED.equals(item.status) || CampaignModels.ITEM_UNKNOWN.equals(item.status))) {
            sb.append(" — ").append(item.detail);
        }
    }

    private void onStartOrResumeClicked() {
        if (checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "Please grant SMS permission first.", Toast.LENGTH_LONG).show();
            requestNeededPermissions();
            return;
        }
        CampaignState snap = store.snapshot();
        Counts c = snap.computeCounts();
        if (c.pending == 0) return;

        if (CampaignModels.CAMPAIGN_PAUSED.equals(snap.status)) {
            sendServiceCommand(SmsCampaignService.ACTION_START_SENDING);
            return;
        }

        int delay = store.getDelaySeconds();
        int estMinutes = Math.max(1, Math.round((c.pending * delay) / 60f));
        String simDesc = spSim.getSelectedItem() != null ? spSim.getSelectedItem().toString() : "Selected SIM";

        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Start Personalized SIM Campaign?")
                .setMessage("Recipients: " + c.pending + " (" + c.totalSegments + " total SMS parts)\n"
                        + "SIM Line: " + simDesc + "\n"
                        + "Pacing: 1 SMS every " + delay + "s (~" + estMinutes + " min in background)\n\n"
                        + "Only message customers who have consented. Make sure your SIM has an active SMS bundle or airtime.")
                .setPositiveButton("Start Sending", (d, w) -> sendServiceCommand(SmsCampaignService.ACTION_START_SENDING))
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void onRetryFailedClicked() {
        int count = store.retryFailedOnly();
        Toast.makeText(this, count > 0
                ? count + " failed message(s) queued. Tap Resume to send."
                : "No failed messages to retry.", Toast.LENGTH_SHORT).show();
    }

    private void onClearClicked() {
        CampaignState snap = store.snapshot();
        Counts c = snap.computeCounts();
        if (c.pending > 0) {
            new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                    .setTitle("Clear Unfinished Campaign?")
                    .setMessage(c.pending + " message(s) have not been sent yet. Clear the queue anyway?")
                    .setPositiveButton("Clear", (d, w) -> store.clearCampaign())
                    .setNegativeButton("Keep", null)
                    .show();
        } else {
            store.clearCampaign();
        }
    }

    private void populateSimOptions() {
        simSubIds.clear();
        simLabels.clear();
        simSubIds.add(SubscriptionManager.INVALID_SUBSCRIPTION_ID);
        simLabels.add("System Default SMS SIM");

        if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
            try {
                SubscriptionManager sm = (SubscriptionManager) getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
                if (sm != null) {
                    List<SubscriptionInfo> list = sm.getActiveSubscriptionInfoList();
                    if (list != null) {
                        for (SubscriptionInfo info : list) {
                            int slot = info.getSimSlotIndex() + 1;
                            CharSequence carrier = info.getCarrierName();
                            CharSequence display = info.getDisplayName();
                            String label = "SIM " + slot + " — "
                                    + (!TextUtils.isEmpty(carrier) ? carrier : (!TextUtils.isEmpty(display) ? display : "Active SIM"));
                            simSubIds.add(info.getSubscriptionId());
                            simLabels.add(label);
                        }
                    }
                }
            } catch (Exception ignored) {
            }
        }

        suppressSpinnerEvents = true;
        spSim.setAdapter(createSpinnerAdapter(simLabels));
        int savedSub = store.getSubscriptionId();
        int idx = simSubIds.indexOf(savedSub);
        spSim.setSelection(idx >= 0 ? idx : 0);
        suppressSpinnerEvents = false;
    }

    private void syncSpinnersFromPrefs() {
        suppressSpinnerEvents = true;
        int savedDelay = store.getDelaySeconds();
        int delayIdx = 0;
        for (int i = 0; i < DELAY_VALUES.length; i++) {
            if (DELAY_VALUES[i] == savedDelay) {
                delayIdx = i;
                break;
            }
        }
        spDelay.setSelection(delayIdx);
        suppressSpinnerEvents = false;
    }

    private void requestNeededPermissions() {
        List<String> req = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            req.add(Manifest.permission.SEND_SMS);
        }
        if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            req.add(Manifest.permission.READ_PHONE_STATE);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            req.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (req.isEmpty()) {
            Toast.makeText(this, "All permissions are granted!", Toast.LENGTH_SHORT).show();
            populateSimOptions();
            renderPermissionsState();
            return;
        }
        requestPermissions(req.toArray(new String[0]), REQ_PERMISSIONS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERMISSIONS) {
            populateSimOptions();
            renderPermissionsState();
            if (checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(this,
                        "SMS permission still blocked? Tap 'App Settings' -> 3 dots -> 'Allow restricted settings'.",
                        Toast.LENGTH_LONG).show();
            }
        }
    }

    private void openAppSettings() {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getPackageName(), null));
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, "Could not open App Settings", Toast.LENGTH_SHORT).show();
        }
    }

    @SuppressWarnings("BatteryLife")
    private void requestUnrestrictedBattery() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null && pm.isIgnoringBatteryOptimizations(getPackageName())) {
            Toast.makeText(this, "Background battery is already unrestricted!", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Exception e) {
            try {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception ignored) {
            }
        }
    }

    private void startBridgeService() {
        sendServiceCommand(SmsCampaignService.ACTION_START_BRIDGE);
    }

    private void toggleBridgeService() {
        if (store.isBridgeRunning() && !store.isActivelyRunning()) {
            sendServiceCommand(SmsCampaignService.ACTION_STOP_SERVICE);
        } else {
            sendServiceCommand(SmsCampaignService.ACTION_START_BRIDGE);
        }
    }

    private void sendServiceCommand(String action) {
        Intent i = new Intent(this, SmsCampaignService.class);
        i.setAction(action);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i);
            } else {
                startService(i);
            }
        } catch (Exception e) {
            Toast.makeText(this, "Service error: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void pickJsonFile() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        try {
            startActivityForResult(intent, REQ_PICK_JSON);
        } catch (Exception e) {
            Toast.makeText(this, "File picker unavailable", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_JSON && resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
            importFromUri(data.getData());
        }
    }

    private void importFromClipboard() {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip() || cm.getPrimaryClip() == null
                || cm.getPrimaryClip().getItemCount() == 0) {
            Toast.makeText(this, "Clipboard is empty", Toast.LENGTH_SHORT).show();
            return;
        }
        CharSequence text = cm.getPrimaryClip().getItemAt(0).coerceToText(this);
        if (text == null || text.toString().trim().isEmpty()) {
            Toast.makeText(this, "No JSON batch found on clipboard", Toast.LENGTH_SHORT).show();
            return;
        }
        tryLoadBatchJson(text.toString());
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null || intent.getBooleanExtra(EXTRA_CONSUMED, false)) return;
        String action = intent.getAction();
        if (action == null) return;

        if (Intent.ACTION_SEND.equals(action)) {
            intent.putExtra(EXTRA_CONSUMED, true);
            Uri streamUri = getStreamUri(intent);
            if (streamUri != null) {
                importFromUri(streamUri);
                return;
            }
            String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (sharedText != null && !sharedText.trim().isEmpty()) {
                tryLoadBatchJson(sharedText);
                return;
            }
            ClipData clip = intent.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                ClipData.Item item = clip.getItemAt(0);
                if (item.getUri() != null) {
                    importFromUri(item.getUri());
                } else if (item.getText() != null) {
                    tryLoadBatchJson(item.getText().toString());
                }
            }
        } else if (Intent.ACTION_VIEW.equals(action)) {
            Uri uri = intent.getData();
            if (uri == null) return;
            intent.putExtra(EXTRA_CONSUMED, true);
            if ("spaxsms".equalsIgnoreCase(uri.getScheme())) {
                String b64 = uri.getQueryParameter("b64");
                if (b64 != null && !b64.isEmpty()) {
                    try {
                        byte[] decoded = Base64.decode(b64, Base64.URL_SAFE | Base64.DEFAULT);
                        tryLoadBatchJson(new String(decoded, StandardCharsets.UTF_8));
                    } catch (Exception e) {
                        Toast.makeText(this, "Invalid deep-link payload", Toast.LENGTH_LONG).show();
                    }
                }
                renderState();
            } else {
                importFromUri(uri);
            }
        }
    }

    @SuppressWarnings("deprecation")
    private static Uri getStreamUri(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    private void importFromUri(Uri uri) {
        try (InputStream is = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            if (is == null) {
                Toast.makeText(this, "Unable to read shared file", Toast.LENGTH_LONG).show();
                return;
            }
            byte[] buf = new byte[8192];
            int n;
            int total = 0;
            while ((n = is.read(buf)) > 0) {
                total += n;
                if (total > MAX_IMPORT_BYTES) {
                    Toast.makeText(this, "Batch file exceeds 5 MB limit", Toast.LENGTH_LONG).show();
                    return;
                }
                bos.write(buf, 0, n);
            }
            String json = new String(bos.toByteArray(), StandardCharsets.UTF_8);
            tryLoadBatchJson(json);
        } catch (Exception e) {
            Toast.makeText(this, "Could not open file: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void tryLoadBatchJson(String rawJson) {
        final CampaignState incoming;
        try {
            incoming = CampaignModels.parseIncomingBatch(rawJson);
        } catch (Exception e) {
            Toast.makeText(this, "Invalid batch: " + e.getMessage(), Toast.LENGTH_LONG).show();
            return;
        }

        CampaignState existing = store.snapshot();
        Counts existingCounts = existing.computeCounts();
        boolean hasUnsentWork = existingCounts.total > 0 && existingCounts.pending > 0
                && !existing.campaignId.equals(incoming.campaignId);

        if (store.isActivelyRunning() || hasUnsentWork) {
            new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                    .setTitle("Replace Current Campaign?")
                    .setMessage("Current queue still has " + existingCounts.pending
                            + " unsent message(s). Replace it with the new batch of "
                            + incoming.items.size() + " recipients?")
                    .setPositiveButton("Replace", (d, w) -> {
                        if (store.isActivelyRunning()) {
                            sendServiceCommand(SmsCampaignService.ACTION_PAUSE_SENDING);
                        }
                        store.stageCampaign(incoming, true);
                        Toast.makeText(this,
                                "Loaded " + incoming.items.size() + " personalized SMS messages!",
                                Toast.LENGTH_SHORT).show();
                    })
                    .setNegativeButton("Keep Existing", null)
                    .show();
            return;
        }

        store.stageCampaign(incoming, true);
        Toast.makeText(this,
                "Loaded " + incoming.items.size() + " personalized SMS messages!",
                Toast.LENGTH_SHORT).show();
    }

    // UI Helper Methods
    private LinearLayout createCard(String heading) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(roundedBox(COL_CARD, dp(12), dp(1), COL_BORDER));
        card.setPadding(dp(16), dp(14), dp(16), dp(16));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(14);
        card.setLayoutParams(lp);

        TextView title = new TextView(this);
        title.setText(heading);
        title.setTextColor(COL_TEXT);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(0, 0, 0, dp(8));
        card.addView(title);
        return card;
    }

    private TextView createLabel(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(COL_MUTED);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setPadding(0, 0, 0, dp(4));
        return tv;
    }

    private TextView createBodyText(String text, int color, float sp) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(color);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        tv.setLineSpacing(dp(2), 1.05f);
        return tv;
    }

    private LinearLayout createButtonRow() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        row.setLayoutParams(lp);
        return row;
    }

    private LinearLayout.LayoutParams weightedBtnParams(boolean addRightGap) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        if (addRightGap) lp.rightMargin = dp(8);
        return lp;
    }

    private Button createButton(String text, int bgColor, int textColor) {
        Button b = new Button(this);
        b.setAllCaps(false);
        b.setText(text);
        b.setTextColor(textColor);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setPadding(dp(12), dp(10), dp(12), dp(10));
        int strokeCol = bgColor == COL_CARD2 ? COL_BORDER : bgColor;
        b.setBackground(roundedBox(bgColor, dp(8), dp(1), strokeCol));
        return b;
    }

    private Spinner createStyledSpinner() {
        Spinner sp = new Spinner(this);
        sp.setBackground(roundedBox(COL_CARD2, dp(8), dp(1), COL_BORDER));
        sp.setPadding(dp(10), dp(6), dp(10), dp(6));
        return sp;
    }

    private ArrayAdapter<String> createSpinnerAdapter(List<String> items) {
        ArrayAdapter<String> adapter = new ArrayAdapter<String>(this, android.R.layout.simple_spinner_item, items) {
            @Override
            public View getView(int position, View convertView, ViewGroup parent) {
                TextView v = (TextView) super.getView(position, convertView, parent);
                v.setTextColor(COL_TEXT);
                v.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
                v.setPadding(dp(4), dp(6), dp(4), dp(6));
                return v;
            }

            @Override
            public View getDropDownView(int position, View convertView, ViewGroup parent) {
                TextView v = (TextView) super.getDropDownView(position, convertView, parent);
                v.setBackgroundColor(COL_CARD2);
                v.setTextColor(COL_TEXT);
                v.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
                v.setPadding(dp(14), dp(12), dp(14), dp(12));
                return v;
            }
        };
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        return adapter;
    }

    private TextView createKpiPill(LinearLayout parent, String label, int accentColor, boolean rightGap) {
        TextView tv = new TextView(this);
        tv.setText("0\n" + label);
        tv.setGravity(Gravity.CENTER);
        tv.setTextColor(accentColor);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setPadding(dp(6), dp(8), dp(6), dp(8));
        tv.setBackground(roundedBox(COL_CARD2, dp(8), dp(1), COL_BORDER));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        if (rightGap) lp.rightMargin = dp(6);
        parent.addView(tv, lp);
        return tv;
    }

    private GradientDrawable roundedBox(int fill, int radiusPx, int strokeWidthPx, int strokeColor) {
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(fill);
        gd.setCornerRadius(radiusPx);
        if (strokeWidthPx > 0) {
            gd.setStroke(strokeWidthPx, strokeColor);
        }
        return gd;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }
}
