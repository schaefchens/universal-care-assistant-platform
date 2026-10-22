package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import com.android.messaging.mmslib.pdu.GenericPdu;
import com.android.messaging.mmslib.pdu.NotificationInd;
import com.android.messaging.mmslib.pdu.PduParser;

/**
 * A carrier's WAP push for an MMS (WAP_PUSH_DELIVER, application/vnd.wap.mms-message), the SMS role's MMS part, in the
 * SMS process: a notification of an MMS is fetched (MmsFetch). Reports on MMS the person sent are not UCAP's yet: it
 * sends no MMS.
 */
public class MmsPushReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        if (!Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION.equals(i.getAction())) return;
        byte[] data = i.getByteArrayExtra("data");
        int sub = i.getIntExtra("android.telephony.extra.SUBSCRIPTION_INDEX", i.getIntExtra("subscription", -1));
        if (data == null) return;
        PendingResult async = goAsync();
        new Thread(() -> {
            try {
                handle(ctx, data, sub);
            } finally {
                async.finish();
            }
        }, "ucap-mms-push").start();
    }

    /** The push's MMS PDU (debug builds also feed it from adb: the emulator's console cannot deliver a WAP push). */
    static void handle(Context ctx, byte[] data, int sub) {
        try {
            GenericPdu pdu = new PduParser(data, true).parse();
            if (pdu instanceof NotificationInd) MmsFetch.announced(ctx, (NotificationInd) pdu, sub);
            if (SmsSync.run(ctx)) SmsJob.retry(ctx);
        } catch (Exception e) {
            android.util.Log.w("UCAP", "mms: a push was not handled: " + e.getClass().getSimpleName());
        }
    }
}
