package com.spaxbutchery.sms;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.telephony.SmsManager;
import android.telephony.SubscriptionManager;

import com.spaxbutchery.sms.CampaignModels.CampaignState;
import com.spaxbutchery.sms.CampaignModels.Counts;
import com.spaxbutchery.sms.CampaignModels.RecipientItem;

import java.util.ArrayList;
import java.util.concurrent.atomic.AtomicInteger;

public final class SmsCampaignService extends Service {

    public static final String ACTION_START_BRIDGE = "com.spaxbutchery.sms.ACTION_START_BRIDGE";
    public static final String ACTION_START_SENDING = "com.spaxbutchery.sms.ACTION_START_SENDING";
    public static final String ACTION_PAUSE_SENDING = "com.spaxbutchery.sms.ACTION_PAUSE_SENDING";
    public static final String ACTION_STOP_SERVICE = "com.spaxbutchery.sms.ACTION_STOP_SERVICE";

    private static final String CHANNEL_PROGRESS = "spax_sms_progress";
    private static final String CHANNEL_ALERTS = "spax_sms_alerts";
    private static final int NOTIFICATION_ID = 4101;
    private static final int ALERT_NOTIFICATION_ID = 4102;
    private static final long MODEM_ACK_TIMEOUT_MS = 25_000L;
    private static final int MAX_CONSECUTIVE_FAILURES = 3;

    private static final Object MODEM_LOCK = new Object();
    private static String awaitingCampaignId = "";
    private static String awaitingItemId = "";
    private static String awaitingTerminalStatus = "";

    private final AtomicInteger piSeq = new AtomicInteger(1000);
    private final Object workerSync = new Object();

    private CampaignStore store;
    private LocalBridgeServer bridgeServer;
    private PowerManager.WakeLock wakeLock;
    private Thread workerThread;
    private volatile boolean pauseRequested = false;
    private volatile boolean serviceDestroyed = false;

    public static void notifyModemResult(String campaignId, String itemId, String finalStatus) {
        if (!CampaignModels.ITEM_SENT.equals(finalStatus) && !CampaignModels.ITEM_FAILED.equals(finalStatus)) {
            return;
        }
        synchronized (MODEM_LOCK) {
            if (campaignId.equals(awaitingCampaignId) && itemId.equals(awaitingItemId)) {
                awaitingTerminalStatus = finalStatus;
                MODEM_LOCK.notifyAll();
            }
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        store = CampaignStore.getInstance(this);
        ensureNotificationChannels();
        bridgeServer = new LocalBridgeServer(store, staged -> {
            refreshForegroundNotification();
            postNewBatchNotification(staged);
        });
        bridgeServer.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Must promote to foreground immediately on Android 8+ / 12+ / 14+.
        promoteToForeground(buildCurrentNotification());

        if (bridgeServer != null && !bridgeServer.isRunning()) {
            bridgeServer.start();
        }

        String action = intent != null ? intent.getAction() : ACTION_START_BRIDGE;
        if (ACTION_STOP_SERVICE.equals(action)) {
            requestPauseInternal("Stopped by user.");
            if (bridgeServer != null) bridgeServer.stop();
            releaseWakeLock();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_PAUSE_SENDING.equals(action)) {
            requestPauseInternal("Paused by user. Tap Resume to continue.");
            refreshForegroundNotification();
            return START_STICKY;
        }

        if (ACTION_START_SENDING.equals(action)) {
            startSendingWorkerIfNeeded();
            return START_STICKY;
        }

        refreshForegroundNotification();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        serviceDestroyed = true;
        pauseRequested = true;
        synchronized (workerSync) {
            if (workerThread != null) {
                workerThread.interrupt();
            }
        }
        if (bridgeServer != null) {
            bridgeServer.stop();
        }
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startSendingWorkerIfNeeded() {
        if (checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            store.setCampaignStatus(CampaignModels.CAMPAIGN_PAUSED,
                    "SMS permission is not granted yet. Grant SMS permission in Spax SMS first.");
            refreshForegroundNotification();
            return;
        }

        CampaignState snap = store.snapshot();
        Counts counts = snap.computeCounts();
        if (counts.total == 0) {
            store.setCampaignStatus(CampaignModels.CAMPAIGN_IDLE, "No campaign loaded yet.");
            refreshForegroundNotification();
            return;
        }
        if (counts.pending == 0) {
            store.setCampaignStatus(CampaignModels.CAMPAIGN_COMPLETED,
                    "All " + counts.total + " messages processed (" + counts.sent + " sent, " + counts.failed + " failed).");
            refreshForegroundNotification();
            return;
        }

        synchronized (workerSync) {
            if (workerThread != null && workerThread.isAlive()) {
                return;
            }
            pauseRequested = false;
            acquireWakeLock();
            store.setCampaignStatus(CampaignModels.CAMPAIGN_RUNNING,
                    "Starting SIM campaign (" + counts.pending + " pending)…");
            refreshForegroundNotification();
            workerThread = new Thread(this::runSendLoop, "SpaxSmsSendWorker");
            workerThread.start();
        }
    }

    private void requestPauseInternal(String reason) {
        pauseRequested = true;
        synchronized (workerSync) {
            if (workerThread != null) {
                workerThread.interrupt();
            }
        }
        if (store.isActivelyRunning()) {
            store.setCampaignStatus(CampaignModels.CAMPAIGN_PAUSED, reason);
        }
        releaseWakeLock();
    }

    private void runSendLoop() {
        int consecutiveFailures = 0;
        try {
            while (!pauseRequested && !serviceDestroyed) {
                CampaignState beforeSnap = store.snapshot();
                String campaignId = beforeSnap.campaignId;
                RecipientItem item = store.claimNextPending();
                if (item == null) {
                    CampaignState doneSnap = store.snapshot();
                    Counts c = doneSnap.computeCounts();
                    store.setCampaignStatus(CampaignModels.CAMPAIGN_COMPLETED,
                            "Done! Sent: " + c.sent + "/" + c.total
                                    + (c.failed > 0 ? " · Failed: " + c.failed : "")
                                    + (c.unknown > 0 ? " · Unknown: " + c.unknown : ""));
                    postAlertNotification("Spax SMS Complete",
                            "Sent " + c.sent + " of " + c.total + " personalized messages.");
                    break;
                }

                Counts activeCounts = store.snapshot().computeCounts();
                int attemptedIdx = activeCounts.total - activeCounts.pending;
                store.updateStatusMessageOnly("Sending " + attemptedIdx + "/" + activeCounts.total
                        + " → " + item.name + " (" + item.to + ")");
                refreshForegroundNotification();

                synchronized (MODEM_LOCK) {
                    awaitingCampaignId = campaignId;
                    awaitingItemId = item.id;
                    awaitingTerminalStatus = "";
                }

                boolean dispatched = dispatchItemViaSim(campaignId, item);
                String outcome;
                if (!dispatched) {
                    outcome = CampaignModels.ITEM_FAILED;
                } else {
                    outcome = awaitModemOutcome(campaignId, item.id);
                }

                if (CampaignModels.ITEM_SENT.equals(outcome)) {
                    consecutiveFailures = 0;
                } else {
                    consecutiveFailures++;
                }

                Counts afterCounts = store.snapshot().computeCounts();
                if (afterCounts.pending == 0) {
                    store.setCampaignStatus(CampaignModels.CAMPAIGN_COMPLETED,
                            "Done! Sent: " + afterCounts.sent + "/" + afterCounts.total
                                    + (afterCounts.failed > 0 ? " · Failed: " + afterCounts.failed : "")
                                    + (afterCounts.unknown > 0 ? " · Unknown: " + afterCounts.unknown : ""));
                    postAlertNotification("Spax SMS Complete",
                            "Sent " + afterCounts.sent + " of " + afterCounts.total
                                    + (afterCounts.failed > 0 ? " (" + afterCounts.failed + " failed)" : ""));
                    break;
                }

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    pauseRequested = true;
                    String msg = "Auto-paused after " + consecutiveFailures
                            + " consecutive errors. Check your SMS bundle, SIM selection, or Android SMS limit prompt, then tap Retry Failed or Resume.";
                    store.setCampaignStatus(CampaignModels.CAMPAIGN_PAUSED, msg);
                    postAlertNotification("Spax SMS Auto-Paused", msg);
                    break;
                }

                if (pauseRequested || serviceDestroyed) {
                    break;
                }

                // Pace safely between messages so SIM carrier & Android rate monitors stay happy.
                int delaySecs = store.getDelaySeconds();
                for (int rem = delaySecs; rem > 0; rem--) {
                    if (pauseRequested || serviceDestroyed) break;
                    Counts tickCounts = store.snapshot().computeCounts();
                    store.updateStatusMessageOnly("Sent " + tickCounts.sent + "/" + tickCounts.total
                            + " · Next SMS in " + rem + "s (" + tickCounts.pending + " left)");
                    refreshForegroundNotification();
                    try {
                        Thread.sleep(1000L);
                    } catch (InterruptedException ie) {
                        if (pauseRequested || serviceDestroyed) break;
                    }
                }
            }
        } finally {
            synchronized (MODEM_LOCK) {
                awaitingCampaignId = "";
                awaitingItemId = "";
                awaitingTerminalStatus = "";
            }
            if (pauseRequested && store.isActivelyRunning()) {
                store.setCampaignStatus(CampaignModels.CAMPAIGN_PAUSED, "Paused. Tap Resume to continue.");
            }
            releaseWakeLock();
            refreshForegroundNotification();
        }
    }

    private String awaitModemOutcome(String campaignId, String itemId) {
        long deadline = System.currentTimeMillis() + MODEM_ACK_TIMEOUT_MS;
        synchronized (MODEM_LOCK) {
            while (awaitingTerminalStatus.isEmpty() && !serviceDestroyed) {
                long waitMs = deadline - System.currentTimeMillis();
                if (waitMs <= 0) break;
                try {
                    MODEM_LOCK.wait(waitMs);
                } catch (InterruptedException ie) {
                    if (serviceDestroyed) break;
                }
            }
            if (!awaitingTerminalStatus.isEmpty()) {
                return awaitingTerminalStatus;
            }
        }
        store.markTimedOutAsUnknown(campaignId, itemId);
        return CampaignModels.ITEM_UNKNOWN;
    }

    @SuppressWarnings("deprecation")
    private SmsManager resolveSmsManager() {
        int subId = store.getSubscriptionId();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            SmsManager base = getSystemService(SmsManager.class);
            if (base != null) {
                return subId != SubscriptionManager.INVALID_SUBSCRIPTION_ID
                        ? base.createForSubscriptionId(subId)
                        : base;
            }
        }
        if (subId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
            return SmsManager.getSmsManagerForSubscriptionId(subId);
        }
        return SmsManager.getDefault();
    }

    private boolean dispatchItemViaSim(String campaignId, RecipientItem item) {
        try {
            SmsManager smsManager = resolveSmsManager();
            if (smsManager == null) {
                store.recordPartSent(campaignId, item.id, false, "SmsManager unavailable on this device");
                return false;
            }
            ArrayList<String> parts = smsManager.divideMessage(item.message);
            if (parts == null || parts.isEmpty()) {
                store.recordPartSent(campaignId, item.id, false, "Empty SMS message");
                return false;
            }
            int partCount = parts.size();
            store.setItemPartsTotal(campaignId, item.id, partCount);

            int mutableFlag = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | mutableFlag;

            if (partCount == 1) {
                PendingIntent sentPi = buildStatusPendingIntent(
                        SmsStatusReceiver.ACTION_SMS_SENT, campaignId, item.id, piFlags);
                PendingIntent deliveredPi = buildStatusPendingIntent(
                        SmsStatusReceiver.ACTION_SMS_DELIVERED, campaignId, item.id, piFlags);
                smsManager.sendTextMessage(item.to, null, item.message, sentPi, deliveredPi);
            } else {
                ArrayList<PendingIntent> sentIntents = new ArrayList<>(partCount);
                ArrayList<PendingIntent> deliveredIntents = new ArrayList<>(partCount);
                for (int i = 0; i < partCount; i++) {
                    sentIntents.add(buildStatusPendingIntent(
                            SmsStatusReceiver.ACTION_SMS_SENT, campaignId, item.id, piFlags));
                    deliveredIntents.add(buildStatusPendingIntent(
                            SmsStatusReceiver.ACTION_SMS_DELIVERED, campaignId, item.id, piFlags));
                }
                smsManager.sendMultipartTextMessage(item.to, null, parts, sentIntents, deliveredIntents);
            }
            return true;
        } catch (SecurityException se) {
            store.recordPartSent(campaignId, item.id, false, "SMS permission denied — allow in App Settings");
            return false;
        } catch (Exception e) {
            String msg = e.getMessage();
            store.recordPartSent(campaignId, item.id, false,
                    "Dispatch error" + (msg != null ? ": " + msg : ""));
            return false;
        }
    }

    private PendingIntent buildStatusPendingIntent(String action, String campaignId, String itemId, int flags) {
        Intent intent = new Intent(this, SmsStatusReceiver.class);
        intent.setAction(action);
        intent.putExtra(SmsStatusReceiver.EXTRA_TOKEN, store.getReceiverToken());
        intent.putExtra(SmsStatusReceiver.EXTRA_CAMPAIGN_ID, campaignId);
        intent.putExtra(SmsStatusReceiver.EXTRA_ITEM_ID, itemId);
        int reqCode = piSeq.incrementAndGet();
        return PendingIntent.getBroadcast(this, reqCode, intent, flags);
    }

    private void promoteToForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void refreshForegroundNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && !serviceDestroyed) {
            nm.notify(NOTIFICATION_ID, buildCurrentNotification());
        }
    }

    private Notification buildCurrentNotification() {
        CampaignState snap = store.snapshot();
        Counts c = snap.computeCounts();

        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPi = PendingIntent.getActivity(
                this, 10, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String title;
        String text;
        if (CampaignModels.CAMPAIGN_RUNNING.equals(snap.status)) {
            title = "Spax SMS: Sending " + c.sent + "/" + c.total;
            text = snap.statusMessage;
        } else if (CampaignModels.CAMPAIGN_READY.equals(snap.status)) {
            title = "Spax SMS: " + c.total + " personalized messages ready";
            text = "Tap to review SIM & start sending (" + snap.segmentLabel + ")";
        } else if (CampaignModels.CAMPAIGN_PAUSED.equals(snap.status)) {
            title = "Spax SMS Paused (" + c.sent + "/" + c.total + " sent)";
            text = snap.statusMessage;
        } else if (CampaignModels.CAMPAIGN_COMPLETED.equals(snap.status) && c.total > 0) {
            title = "Spax SMS Complete (" + c.sent + "/" + c.total + " sent)";
            text = snap.statusMessage;
        } else {
            title = "Spax SMS Bridge Ready";
            text = store.isBridgeRunning()
                    ? "Listening on 127.0.0.1:" + LocalBridgeServer.PORT + " for SpaxButchery Outreach"
                    : "Open Spax SMS to configure";
        }

        Notification.Builder b = new Notification.Builder(this, CHANNEL_PROGRESS)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(openPi)
                .setOnlyAlertOnce(true)
                .setOngoing(true);

        if (c.total > 0 && CampaignModels.CAMPAIGN_RUNNING.equals(snap.status)) {
            b.setProgress(c.total, c.sent + c.failed + c.unknown, false);
        }

        if (CampaignModels.CAMPAIGN_RUNNING.equals(snap.status)) {
            b.addAction(buildServiceAction(21, "Pause", ACTION_PAUSE_SENDING));
        } else if (c.pending > 0 && (CampaignModels.CAMPAIGN_PAUSED.equals(snap.status)
                || CampaignModels.CAMPAIGN_READY.equals(snap.status))) {
            b.addAction(buildServiceAction(22, "Start / Resume", ACTION_START_SENDING));
        }
        b.addAction(buildServiceAction(23, "Stop", ACTION_STOP_SERVICE));

        return b.build();
    }

    private Notification.Action buildServiceAction(int reqCode, String label, String action) {
        Intent i = new Intent(this, SmsCampaignService.class);
        i.setAction(action);
        PendingIntent pi;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            pi = PendingIntent.getForegroundService(
                    this, reqCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        } else {
            pi = PendingIntent.getService(
                    this, reqCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }
        Icon icon = Icon.createWithResource(this, R.drawable.ic_notification);
        return new Notification.Action.Builder(icon, label, pi).build();
    }

    private void postNewBatchNotification(CampaignState staged) {
        postAlertNotification(
                "Campaign Ready: " + staged.items.size() + " personalized SMS",
                "Tap to open Spax SMS and start sending (" + staged.segmentLabel + ").");
    }

    private void postAlertNotification(String title, String body) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPi = PendingIntent.getActivity(
                this, 30, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new Notification.Builder(this, CHANNEL_ALERTS)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(openPi)
                .setAutoCancel(true)
                .build();
        nm.notify(ALERT_NOTIFICATION_ID, n);
    }

    private void ensureNotificationChannels() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel progress = new NotificationChannel(
                CHANNEL_PROGRESS,
                "SMS Campaign Progress & Local Bridge",
                NotificationManager.IMPORTANCE_LOW);
        progress.setDescription("Live progress while sending personalized SMS in the background");
        nm.createNotificationChannel(progress);

        NotificationChannel alerts = new NotificationChannel(
                CHANNEL_ALERTS,
                "Campaign Ready & Completion Alerts",
                NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Alerts when a batch arrives, finishes, or pauses on error");
        nm.createNotificationChannel(alerts);
    }

    @SuppressLint("WakelockTimeout")
    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm == null) return;
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SpaxSms::CampaignWakeLock");
        wakeLock.setReferenceCounted(false);
        // Bounded 6-hour safety timeout so a wake lock can never stay held indefinitely.
        wakeLock.acquire(6L * 60L * 60L * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {
            }
        }
    }
}
