package com.spaxbutchery.sms;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

public final class CampaignModels {

    private CampaignModels() {}

    public static final String ITEM_PENDING = "PENDING";
    public static final String ITEM_SENDING = "SENDING";
    public static final String ITEM_SENT = "SENT";
    public static final String ITEM_DELIVERED = "DELIVERED";
    public static final String ITEM_FAILED = "FAILED";
    public static final String ITEM_UNKNOWN = "UNKNOWN";

    public static final String CAMPAIGN_IDLE = "IDLE";
    public static final String CAMPAIGN_READY = "READY";
    public static final String CAMPAIGN_RUNNING = "RUNNING";
    public static final String CAMPAIGN_PAUSED = "PAUSED";
    public static final String CAMPAIGN_COMPLETED = "COMPLETED";

    private static final String GSM7_BASIC =
            "@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !\"#\u00a4%&'()*+,-./0123456789:;<=>?\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0";
    private static final String GSM7_EXT = "^{}\\[~]|\u20ac";

    public static final class SmsEstimate {
        public final int units;
        public final int segments;
        public final String encoding;

        public SmsEstimate(int units, int segments, String encoding) {
            this.units = units;
            this.segments = segments;
            this.encoding = encoding;
        }
    }

    public static final class RecipientItem {
        public String id;
        public String name;
        public String to;
        public String message;
        public int segments;
        public String encoding;
        public String status;
        public String detail;
        public int partsTotal;
        public int partsAcked;
        public int partsDelivered;
        public long updatedAt;
    }

    public static final class Counts {
        public int total;
        public int pending;
        public int sending;
        public int sent;
        public int delivered;
        public int failed;
        public int unknown;
        public int totalSegments;
        public boolean hasUnicode;
    }

    public static final class CampaignState {
        public String campaignId = "";
        public String segmentLabel = "";
        public String createdAt = "";
        public String status = CAMPAIGN_IDLE;
        public String statusMessage = "No campaign loaded yet.";
        public int skippedInvalid = 0;
        public int skippedDuplicate = 0;
        public List<RecipientItem> items = new ArrayList<>();

        public Counts computeCounts() {
            Counts c = new Counts();
            c.total = items.size();
            for (RecipientItem item : items) {
                c.totalSegments += Math.max(1, item.segments);
                if ("UCS-2".equals(item.encoding)) {
                    c.hasUnicode = true;
                }
                if (ITEM_PENDING.equals(item.status)) c.pending++;
                else if (ITEM_SENDING.equals(item.status)) c.sending++;
                else if (ITEM_SENT.equals(item.status)) c.sent++;
                else if (ITEM_DELIVERED.equals(item.status)) {
                    c.sent++;
                    c.delivered++;
                } else if (ITEM_FAILED.equals(item.status)) c.failed++;
                else if (ITEM_UNKNOWN.equals(item.status)) c.unknown++;
            }
            return c;
        }
    }

    public static String normalizeKenyanPhone(String raw) {
        if (raw == null) return "";
        String p = raw.trim();
        if (p.isEmpty() || p.contains("*")) return "";
        for (int i = 0; i < p.length(); i++) {
            char ch = p.charAt(i);
            boolean ok = (ch >= '0' && ch <= '9')
                    || (ch == '+' && i == 0)
                    || ch == ' ' || ch == '-' || ch == '(' || ch == ')';
            if (!ok) return "";
        }
        StringBuilder digits = new StringBuilder(16);
        for (int i = 0; i < p.length(); i++) {
            char ch = p.charAt(i);
            if (ch >= '0' && ch <= '9') digits.append(ch);
        }
        String d = digits.toString();
        String local;
        if (d.startsWith("254") && d.length() == 12) {
            local = "0" + d.substring(3);
        } else if (d.length() == 9 && (d.charAt(0) == '7' || d.charAt(0) == '1')) {
            local = "0" + d;
        } else {
            local = d;
        }
        if (local.length() == 10 && local.charAt(0) == '0' && (local.charAt(1) == '7' || local.charAt(1) == '1')) {
            return "+254" + local.substring(1);
        }
        return "";
    }

    public static SmsEstimate estimateSmsInfo(String text) {
        String t = text == null ? "" : text;
        int units = 0;
        boolean gsm7 = true;
        int i = 0;
        while (i < t.length()) {
            int cp = t.codePointAt(i);
            i += Character.charCount(cp);
            if (cp > 0xFFFF) {
                gsm7 = false;
                break;
            }
            char ch = (char) cp;
            if (GSM7_EXT.indexOf(ch) >= 0) {
                units += 2;
            } else if (GSM7_BASIC.indexOf(ch) >= 0) {
                units += 1;
            } else {
                gsm7 = false;
                break;
            }
        }
        if (gsm7) {
            int segs = units <= 160 ? 1 : (int) Math.ceil(units / 153.0);
            return new SmsEstimate(units, Math.max(1, segs), "GSM-7");
        }
        int ucs2Units = t.length(); // UTF-16 code units
        int segs = ucs2Units <= 70 ? 1 : (int) Math.ceil(ucs2Units / 67.0);
        return new SmsEstimate(ucs2Units, Math.max(1, segs), "UCS-2");
    }

    public static CampaignState parseIncomingBatch(String rawJson) throws JSONException {
        if (rawJson == null || rawJson.trim().isEmpty()) {
            throw new JSONException("Empty batch JSON");
        }
        String trimmed = rawJson.trim();
        JSONArray arr;
        String campaignId = "";
        String segmentLabel = "Outreach Batch";
        String createdAt = isoNow();
        int preSkippedInvalid = 0;
        int preSkippedDuplicate = 0;

        if (trimmed.startsWith("[")) {
            arr = new JSONArray(trimmed);
        } else {
            JSONObject root = new JSONObject(trimmed);
            campaignId = root.optString("campaignId", "");
            segmentLabel = root.optString("segmentLabel", root.optString("segment", "Outreach Batch"));
            createdAt = root.optString("createdAt", createdAt);
            JSONObject stats = root.optJSONObject("stats");
            if (stats != null) {
                preSkippedInvalid = Math.max(0, stats.optInt("skippedInvalid", 0));
                preSkippedDuplicate = Math.max(0, stats.optInt("skippedDuplicate", 0));
            }
            if (root.has("messages")) {
                arr = root.getJSONArray("messages");
            } else if (root.has("rows")) {
                arr = root.getJSONArray("rows");
            } else {
                throw new JSONException("Missing 'messages' array in campaign JSON");
            }
        }

        if (campaignId.isEmpty()) {
            campaignId = "spax-" + UUID.randomUUID().toString().substring(0, 8);
        }

        CampaignState state = new CampaignState();
        state.campaignId = campaignId;
        state.segmentLabel = segmentLabel.isEmpty() ? "Outreach Batch" : segmentLabel;
        state.createdAt = createdAt;
        state.skippedInvalid = preSkippedInvalid;
        state.skippedDuplicate = preSkippedDuplicate;

        Set<String> seenPhones = new HashSet<>();
        for (int idx = 0; idx < arr.length(); idx++) {
            JSONObject obj = arr.optJSONObject(idx);
            if (obj == null) {
                state.skippedInvalid++;
                continue;
            }
            String rawPhone = obj.optString("to", obj.optString("phone", obj.optString("contact", "")));
            String to = normalizeKenyanPhone(rawPhone);
            String message = obj.optString("message", obj.optString("body", "")).trim();
            if (to.isEmpty() || message.isEmpty() || message.length() > 1500) {
                state.skippedInvalid++;
                continue;
            }
            if (!seenPhones.add(to)) {
                state.skippedDuplicate++;
                continue;
            }
            String name = obj.optString("name", "Customer").trim();
            if (name.isEmpty()) name = "Customer";
            SmsEstimate est = estimateSmsInfo(message);

            RecipientItem item = new RecipientItem();
            item.id = String.format(Locale.US, "m-%04d", state.items.size() + 1);
            item.name = name;
            item.to = to;
            item.message = message;
            item.segments = est.segments;
            item.encoding = est.encoding;
            item.status = ITEM_PENDING;
            item.detail = "";
            item.partsTotal = est.segments;
            item.partsAcked = 0;
            item.partsDelivered = 0;
            item.updatedAt = System.currentTimeMillis();
            state.items.add(item);
        }

        if (state.items.isEmpty()) {
            throw new JSONException("No valid Kenyan mobile recipients (+2547… / +2541…) with messages <= 1500 chars found in batch.");
        }

        state.status = CAMPAIGN_READY;
        state.statusMessage = "Loaded " + state.items.size() + " personalized SMS messages. Review SIM & pacing, then tap Start Sending.";
        return state;
    }

    public static JSONObject toDiskJson(CampaignState state) throws JSONException {
        JSONObject root = new JSONObject();
        root.put("campaignId", state.campaignId);
        root.put("segmentLabel", state.segmentLabel);
        root.put("createdAt", state.createdAt);
        root.put("status", state.status);
        root.put("statusMessage", state.statusMessage);
        root.put("skippedInvalid", state.skippedInvalid);
        root.put("skippedDuplicate", state.skippedDuplicate);
        JSONArray arr = new JSONArray();
        for (RecipientItem item : state.items) {
            JSONObject o = new JSONObject();
            o.put("id", item.id);
            o.put("name", item.name);
            o.put("to", item.to);
            o.put("message", item.message);
            o.put("segments", item.segments);
            o.put("encoding", item.encoding);
            o.put("status", item.status);
            o.put("detail", item.detail);
            o.put("partsTotal", item.partsTotal);
            o.put("partsAcked", item.partsAcked);
            o.put("partsDelivered", item.partsDelivered);
            o.put("updatedAt", item.updatedAt);
            arr.put(o);
        }
        root.put("items", arr);
        return root;
    }

    public static CampaignState fromDiskJson(String raw) throws JSONException {
        JSONObject root = new JSONObject(raw);
        CampaignState state = new CampaignState();
        state.campaignId = root.optString("campaignId", "");
        state.segmentLabel = root.optString("segmentLabel", "");
        state.createdAt = root.optString("createdAt", "");
        state.status = root.optString("status", CAMPAIGN_IDLE);
        state.statusMessage = root.optString("statusMessage", "");
        state.skippedInvalid = root.optInt("skippedInvalid", 0);
        state.skippedDuplicate = root.optInt("skippedDuplicate", 0);
        JSONArray arr = root.optJSONArray("items");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                RecipientItem item = new RecipientItem();
                item.id = o.optString("id", "m-" + (i + 1));
                item.name = o.optString("name", "Customer");
                item.to = o.optString("to", "");
                item.message = o.optString("message", "");
                item.segments = Math.max(1, o.optInt("segments", 1));
                item.encoding = o.optString("encoding", "GSM-7");
                item.status = o.optString("status", ITEM_PENDING);
                // If process died mid-send without radio confirmation, treat as UNKNOWN (never blindly resend).
                if (ITEM_SENDING.equals(item.status)) {
                    item.status = ITEM_UNKNOWN;
                    item.detail = "App restarted while sending — verify before retrying";
                } else {
                    item.detail = o.optString("detail", "");
                }
                item.partsTotal = Math.max(1, o.optInt("partsTotal", item.segments));
                item.partsAcked = o.optInt("partsAcked", 0);
                item.partsDelivered = o.optInt("partsDelivered", 0);
                item.updatedAt = o.optLong("updatedAt", 0L);
                state.items.add(item);
            }
        }
        if (CAMPAIGN_RUNNING.equals(state.status)) {
            state.status = CAMPAIGN_PAUSED;
            state.statusMessage = "Paused after app restart. Tap Resume to continue remaining pending messages.";
        }
        return state;
    }

    public static JSONObject toPublicStatusJson(CampaignState state, boolean bridgeActive) {
        JSONObject out = new JSONObject();
        try {
            Counts c = state.computeCounts();
            out.put("app", "spax-sms-companion");
            out.put("version", "1.0.0");
            out.put("bridgeActive", bridgeActive);
            out.put("campaignId", state.campaignId);
            out.put("segmentLabel", state.segmentLabel);
            out.put("status", state.status);
            out.put("statusMessage", state.statusMessage);
            out.put("total", c.total);
            out.put("pending", c.pending);
            out.put("sending", c.sending);
            out.put("sent", c.sent);
            out.put("delivered", c.delivered);
            out.put("failed", c.failed);
            out.put("unknown", c.unknown);
            out.put("totalSegments", c.totalSegments);
            out.put("skippedInvalid", state.skippedInvalid);
            out.put("skippedDuplicate", state.skippedDuplicate);
        } catch (JSONException ignored) {
        }
        return out;
    }

    private static String isoNow() {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        return fmt.format(new Date());
    }
}
