package com.spaxbutchery.sms;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.SmsManager;

public final class SmsStatusReceiver extends BroadcastReceiver {

    public static final String ACTION_SMS_SENT = "com.spaxbutchery.sms.ACTION_SMS_SENT";
    public static final String ACTION_SMS_DELIVERED = "com.spaxbutchery.sms.ACTION_SMS_DELIVERED";

    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_CAMPAIGN_ID = "campaign_id";
    public static final String EXTRA_ITEM_ID = "item_id";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || context == null) return;
        String action = intent.getAction();
        if (action == null) return;

        CampaignStore store = CampaignStore.getInstance(context);
        String suppliedToken = intent.getStringExtra(EXTRA_TOKEN);
        if (suppliedToken == null || !suppliedToken.equals(store.getReceiverToken())) {
            return;
        }

        String campaignId = intent.getStringExtra(EXTRA_CAMPAIGN_ID);
        String itemId = intent.getStringExtra(EXTRA_ITEM_ID);
        if (campaignId == null || itemId == null) return;

        int resultCode = getResultCode();
        if (ACTION_SMS_SENT.equals(action)) {
            boolean ok = (resultCode == Activity.RESULT_OK);
            String detail = ok ? "Sent via SIM" : describeSendFailure(resultCode, intent.getIntExtra("errorCode", -1));
            String finalStatus = store.recordPartSent(campaignId, itemId, ok, detail);
            SmsCampaignService.notifyModemResult(campaignId, itemId, finalStatus);
        } else if (ACTION_SMS_DELIVERED.equals(action)) {
            if (resultCode == Activity.RESULT_OK) {
                store.recordPartDelivered(campaignId, itemId);
            }
        }
    }

    private static String describeSendFailure(int resultCode, int radioErrorCode) {
        switch (resultCode) {
            case SmsManager.RESULT_ERROR_GENERIC_FAILURE:
                return "Generic failure — check SMS bundle/airtime or SIM selection"
                        + (radioErrorCode != -1 ? " (code " + radioErrorCode + ")" : "");
            case SmsManager.RESULT_ERROR_RADIO_OFF:
                return "Mobile radio is off (check Airplane mode)";
            case SmsManager.RESULT_ERROR_NULL_PDU:
                return "Invalid SMS PDU";
            case SmsManager.RESULT_ERROR_NO_SERVICE:
                return "No mobile network signal";
            case 5: // SmsManager.RESULT_ERROR_LIMIT_EXCEEDED
                return "Android SMS rate limit reached — allow prompt or use 32s pacing";
            case 6: // RESULT_ERROR_FDN_CHECK_FAILURE
                return "Blocked by SIM Fixed Dialing Numbers";
            case 7: // RESULT_ERROR_SHORT_CODE_NOT_ALLOWED
                return "Number blocked by user/system";
            case 8: // RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED
                return "Destination blocked";
            default:
                return "Send failed (code " + resultCode + ")";
        }
    }
}
