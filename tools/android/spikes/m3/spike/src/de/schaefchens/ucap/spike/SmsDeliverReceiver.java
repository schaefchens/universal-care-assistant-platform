package de.schaefchens.ucap.spike;

import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Telephony;
import android.telephony.SmsMessage;

/** SMS_DELIVER: only the SMS app gets it, and then it alone writes the message into Android's SMS store. */
public class SmsDeliverReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        long at = System.currentTimeMillis();
        SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(i);
        if (parts == null || parts.length == 0 || parts[0] == null) {
            Spike.log("sms_in", "parts", 0);
            return;
        }
        StringBuilder body = new StringBuilder();
        for (SmsMessage m : parts) if (m != null && m.getMessageBody() != null) body.append(m.getMessageBody());
        SmsMessage first = parts[0];
        int sub = i.getIntExtra("android.telephony.extra.SUBSCRIPTION_INDEX", i.getIntExtra("subscription", -1));
        ContentValues v = new ContentValues();
        v.put(Telephony.Sms.ADDRESS, first.getOriginatingAddress());
        v.put(Telephony.Sms.BODY, body.toString());
        v.put(Telephony.Sms.DATE, at);
        v.put(Telephony.Sms.DATE_SENT, first.getTimestampMillis());
        v.put(Telephony.Sms.READ, 0);
        v.put(Telephony.Sms.SEEN, 0);
        if (sub >= 0) v.put(Telephony.Sms.SUBSCRIPTION_ID, sub);
        Uri stored = null;
        String error = null;
        long thread = -1;
        try {
            stored = c.getContentResolver().insert(Telephony.Sms.Inbox.CONTENT_URI, v);
            if (stored != null) {
                try (Cursor cur = c.getContentResolver().query(stored, new String[] {Telephony.Sms.THREAD_ID}, null, null, null)) {
                    if (cur != null && cur.moveToFirst()) thread = cur.getLong(0);
                }
            }
        } catch (Exception e) {
            error = e.getClass().getSimpleName();
        }
        Spike.log("sms_in", "parts", parts.length, "len", body.length(), "textHash", Spike.hash(body), "from", Spike.shape(first.getOriginatingAddress()),
                "stored", stored != null, "error", error, "thread", thread, "subscription", sub, "messageClass", String.valueOf(first.getMessageClass()),
                "lagMs", at - first.getTimestampMillis());
    }
}
