package de.schaefchens.ucap.spike;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;

/**
 * The sent and delivery reports of an SMS the spike sent. As the SMS app, it writes a sent message into Android's SMS
 * store itself (the system does that only for other apps).
 */
public class ResultReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String kind = i.getStringExtra("kind");
        int part = i.getIntExtra("part", 0);
        int of = i.getIntExtra("of", 1);
        int rc = getResultCode();
        long ms = System.currentTimeMillis() - i.getLongExtra("started", 0);
        String status = null;
        if ("delivered".equals(kind)) {
            byte[] pdu = i.getByteArrayExtra("pdu");
            if (pdu != null) {
                SmsMessage m = SmsMessage.createFromPdu(pdu, i.getStringExtra("format"));
                if (m != null) status = String.valueOf(m.getStatus());
            }
        }
        boolean stored = false;
        if ("sent".equals(kind) && rc == Activity.RESULT_OK && part == of - 1) {
            ContentValues v = new ContentValues();
            v.put(Telephony.Sms.ADDRESS, i.getStringExtra("to"));
            v.put(Telephony.Sms.BODY, i.getStringExtra("text"));
            v.put(Telephony.Sms.DATE, System.currentTimeMillis());
            v.put(Telephony.Sms.READ, 1);
            v.put(Telephony.Sms.SEEN, 1);
            try {
                stored = c.getContentResolver().insert(Telephony.Sms.Sent.CONTENT_URI, v) != null;
            } catch (Exception e) {
                stored = false;
            }
        }
        Spike.log("sms_" + kind, "id", i.getStringExtra("id"), "part", part, "of", of, "result", rc == Activity.RESULT_OK ? "ok" : String.valueOf(rc),
                "errorCode", i.getIntExtra("errorCode", -1), "status", status, "storedAsSent", stored, "ms", ms);
    }
}
