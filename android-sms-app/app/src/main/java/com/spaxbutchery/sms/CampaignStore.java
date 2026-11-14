package com.spaxbutchery.sms;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.telephony.SubscriptionManager;

import com.spaxbutchery.sms.CampaignModels.CampaignState;
import com.spaxbutchery.sms.CampaignModels.Counts;
import com.spaxbutchery.sms.CampaignModels.RecipientItem;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class CampaignStore {

    public interface Listener {
        void onCampaignUpdated();
    }

    private static final String PREFS_NAME = "spax_sms_prefs";
    private static final String KEY_RECEIVER_TOKEN = "receiver_token";
    private static final String KEY_DELAY_SECONDS = "delay_seconds";
    private static final String KEY_SUBSCRIPTION_ID = "subscription_id";
    private static final String KEY_CUSTOM_ORIGIN = "custom_origin";
    private static final String STATE_FILENAME = "campaign_state.json";

    private static volatile CampaignStore instance;

    public static CampaignStore getInstance(Context context) {
        if (instance == null) {
            synchronized (CampaignStore.class) {
                if (instance == null) {
                    instance = new CampaignStore(context.getApplicationContext());
                }
            }
        }
        return instance;
    }

    private final Context appContext;
    private final SharedPreferences prefs;
    private final Object lock = new Object();
    private final ExecutorService diskExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();

    private CampaignState state;
    private volatile boolean bridgeRunning = false;
    private final String receiverToken;

    private CampaignStore(Context appContext) {
        this.appContext = appContext;
        this.prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String tok = prefs.getString(KEY_RECEIVER_TOKEN, "");
        if (tok == null || tok.length() < 16) {
            tok = UUID.randomUUID().toString() + UUID.randomUUID().toString();
            prefs.edit().putString(KEY_RECEIVER_TOKEN, tok).apply();
        }
        this.receiverToken = tok;
        this.state = loadFromDisk();
    }

    public String getReceiverToken() {
        return receiverToken;
    }

    public int getDelaySeconds() {
        int d = prefs.getInt(KEY_DELAY_SECONDS, 12);
        return Math.max(3, Math.min(120, d));
    }

    public void setDelaySeconds(int seconds) {
        int clamped = Math.max(3, Math.min(120, seconds));
        prefs.edit().putInt(KEY_DELAY_SECONDS, clamped).apply();
        notifyListeners();
    }

    public int getSubscriptionId() {
        return prefs.getInt(KEY_SUBSCRIPTION_ID, SubscriptionManager.INVALID_SUBSCRIPTION_ID);
    }

    public void setSubscriptionId(int subId) {
        prefs.edit().putInt(KEY_SUBSCRIPTION_ID, subId).apply();
        notifyListeners();
    }

    public String getCustomOrigin() {
        String v = prefs.getString(KEY_CUSTOM_ORIGIN, "");
        return v == null ? "" : v.trim();
    }

    public void setCustomOrigin(String origin) {
        prefs.edit().putString(KEY_CUSTOM_ORIGIN, origin == null ? "" : origin.trim()).apply();
    }

    public boolean isBridgeRunning() {
        return bridgeRunning;
    }

    public void setBridgeRunning(boolean running) {
        this.bridgeRunning = running;
        notifyListeners();
    }

    public void addListener(Listener listener) {
        if (listener != null && !listeners.contains(listener)) {
            listeners.add(listener);
        }
    }

    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    private void notifyListeners() {
        mainHandler.post(() -> {
            for (Listener l : listeners) {
                try {
                    l.onCampaignUpdated();
                } catch (Exception ignored) {
                }
            }
        });
    }

    public CampaignState snapshot() {
        synchronized (lock) {
            CampaignState copy = new CampaignState();
            copy.campaignId = state.campaignId;
            copy.segmentLabel = state.segmentLabel;
            copy.createdAt = state.createdAt;
            copy.status = state.status;
            copy.statusMessage = state.statusMessage;
            copy.skippedInvalid = state.skippedInvalid;
            copy.skippedDuplicate = state.skippedDuplicate;
            copy.items = new ArrayList<>(state.items.size());
            for (RecipientItem src : state.items) {
                RecipientItem dst = new RecipientItem();
                dst.id = src.id;
                dst.name = src.name;
                dst.to = src.to;
                dst.message = src.message;
                dst.segments = src.segments;
                dst.encoding = src.encoding;
                dst.status = src.status;
                dst.detail = src.detail;
                dst.partsTotal = src.partsTotal;
                dst.partsAcked = src.partsAcked;
                dst.partsDelivered = src.partsDelivered;
                dst.updatedAt = src.updatedAt;
                copy.items.add(dst);
            }
            return copy;
        }
    }

    public JSONObject publicStatusJson() {
        synchronized (lock) {
            return CampaignModels.toPublicStatusJson(state, bridgeRunning);
        }
    }

    public boolean isActivelyRunning() {
        synchronized (lock) {
            return CampaignModels.CAMPAIGN_RUNNING.equals(state.status);
        }
    }

    public void stageCampaign(CampaignState next, boolean forceReplace) {
        synchronized (lock) {
            if (!forceReplace && CampaignModels.CAMPAIGN_RUNNING.equals(state.status)) {
                Counts c = state.computeCounts();
                throw new IllegalStateException(
                        "A campaign is currently sending (" + c.sent + "/" + c.total + "). Pause or finish it first.");
            }
            this.state = next;
            persistLocked();
        }
        notifyListeners();
    }

    public void clearCampaign() {
        synchronized (lock) {
            this.state = new CampaignState();
            persistLocked();
        }
        notifyListeners();
    }

    public void setCampaignStatus(String status, String statusMessage) {
        synchronized (lock) {
            state.status = status;
            if (statusMessage != null) {
                state.statusMessage = statusMessage;
            }
            persistLocked();
        }
        notifyListeners();
    }

    public void updateStatusMessageOnly(String statusMessage) {
        synchronized (lock) {
            state.statusMessage = statusMessage;
        }
        notifyListeners();
    }

    public int retryFailedOnly() {
        int reset = 0;
        synchronized (lock) {
            for (RecipientItem item : state.items) {
                if (CampaignModels.ITEM_FAILED.equals(item.status)) {
                    item.status = CampaignModels.ITEM_PENDING;
                    item.detail = "Queued for retry";
                    item.partsAcked = 0;
                    item.partsDelivered = 0;
                    item.updatedAt = System.currentTimeMillis();
                    reset++;
                }
            }
            if (reset > 0 && !CampaignModels.CAMPAIGN_RUNNING.equals(state.status)) {
                state.status = CampaignModels.CAMPAIGN_PAUSED;
                state.statusMessage = reset + " failed message(s) re-queued. Tap Resume to send.";
            }
            persistLocked();
        }
        notifyListeners();
        return reset;
    }

    public RecipientItem claimNextPending() {
        synchronized (lock) {
            for (RecipientItem item : state.items) {
                if (CampaignModels.ITEM_PENDING.equals(item.status)) {
                    item.status = CampaignModels.ITEM_SENDING;
                    item.detail = "Submitting to SIM…";
                    item.partsAcked = 0;
                    item.updatedAt = System.currentTimeMillis();
                    persistLocked();

                    RecipientItem copy = new RecipientItem();
                    copy.id = item.id;
                    copy.name = item.name;
                    copy.to = item.to;
                    copy.message = item.message;
                    copy.segments = item.segments;
                    copy.encoding = item.encoding;
                    copy.status = item.status;
                    copy.partsTotal = item.partsTotal;
                    return copy;
                }
            }
            return null;
        }
    }

    public void setItemPartsTotal(String campaignId, String itemId, int partsTotal) {
        synchronized (lock) {
            if (!state.campaignId.equals(campaignId)) return;
            RecipientItem item = findItemLocked(itemId);
            if (item != null) {
                item.partsTotal = Math.max(1, partsTotal);
            }
        }
    }

    public String recordPartSent(String campaignId, String itemId, boolean ok, String detail) {
        String resultingStatus = "";
        synchronized (lock) {
            if (!state.campaignId.equals(campaignId)) return "";
            RecipientItem item = findItemLocked(itemId);
            if (item == null) return "";
            item.updatedAt = System.currentTimeMillis();
            if (!ok) {
                item.status = CampaignModels.ITEM_FAILED;
                item.detail = (detail == null || detail.isEmpty()) ? "Failed" : detail;
                resultingStatus = CampaignModels.ITEM_FAILED;
            } else {
                item.partsAcked = Math.min(item.partsTotal, item.partsAcked + 1);
                if (item.partsAcked >= item.partsTotal) {
                    if (!CampaignModels.ITEM_DELIVERED.equals(item.status)) {
                        item.status = CampaignModels.ITEM_SENT;
                    }
                    item.detail = "Sent via SIM";
                    resultingStatus = CampaignModels.ITEM_SENT;
                } else {
                    item.detail = "Sent part " + item.partsAcked + "/" + item.partsTotal;
                    resultingStatus = CampaignModels.ITEM_SENDING;
                }
            }
            persistLocked();
        }
        notifyListeners();
        return resultingStatus;
    }

    public void recordPartDelivered(String campaignId, String itemId) {
        synchronized (lock) {
            if (!state.campaignId.equals(campaignId)) return;
            RecipientItem item = findItemLocked(itemId);
            if (item == null) return;
            item.partsDelivered = Math.min(item.partsTotal, item.partsDelivered + 1);
            if (item.partsDelivered >= item.partsTotal) {
                item.status = CampaignModels.ITEM_DELIVERED;
                item.detail = "Delivered to handset";
                item.updatedAt = System.currentTimeMillis();
                persistLocked();
            }
        }
        notifyListeners();
    }

    public boolean markTimedOutAsUnknown(String campaignId, String itemId) {
        boolean changed = false;
        synchronized (lock) {
            if (!state.campaignId.equals(campaignId)) return false;
            RecipientItem item = findItemLocked(itemId);
            if (item != null && CampaignModels.ITEM_SENDING.equals(item.status)) {
                item.status = CampaignModels.ITEM_UNKNOWN;
                item.detail = "No modem confirmation after 25s — check Messages app before retrying";
                item.updatedAt = System.currentTimeMillis();
                changed = true;
                persistLocked();
            }
        }
        if (changed) notifyListeners();
        return changed;
    }

    private RecipientItem findItemLocked(String itemId) {
        for (RecipientItem item : state.items) {
            if (item.id.equals(itemId)) return item;
        }
        return null;
    }

    private void persistLocked() {
        final String serialized;
        try {
            serialized = CampaignModels.toDiskJson(state).toString();
        } catch (Exception e) {
            return;
        }
        diskExecutor.execute(() -> writeAtomically(serialized));
    }

    private void writeAtomically(String json) {
        File dir = appContext.getFilesDir();
        File target = new File(dir, STATE_FILENAME);
        File tmp = new File(dir, STATE_FILENAME + ".tmp");
        try {
            try (FileOutputStream fos = new FileOutputStream(tmp, false)) {
                fos.write(json.getBytes(StandardCharsets.UTF_8));
                fos.getFD().sync();
            }
            if (!tmp.renameTo(target)) {
                try (FileOutputStream fos = new FileOutputStream(target, false)) {
                    fos.write(json.getBytes(StandardCharsets.UTF_8));
                    fos.getFD().sync();
                }
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        } catch (Exception ignored) {
        }
    }

    private CampaignState loadFromDisk() {
        File target = new File(appContext.getFilesDir(), STATE_FILENAME);
        if (!target.exists()) return new CampaignState();
        try (FileInputStream fis = new FileInputStream(target);
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = fis.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            String json = new String(bos.toByteArray(), StandardCharsets.UTF_8);
            return CampaignModels.fromDiskJson(json);
        } catch (Exception e) {
            return new CampaignState();
        }
    }
}
