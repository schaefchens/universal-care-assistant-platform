package de.schaefchens.ucap;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.SmsMessage;
import org.json.JSONArray;

/**
 * The network's reports on an SMS UCAP sent, per part (SmsSender), in the SMS process. Once every part has its sent
 * report: "sent" (written to the store as sent, and the message reported in its thread) or "failed" with the network's
 * code. Once every part was delivered: the delivery report, kept with the message. Then the reports go to the server.
 */
public class SmsReportReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        String kind = i.getStringExtra("kind");
        long id = i.getLongExtra("id", -1);
        int rc = getResultCode();
        boolean ok = rc == Activity.RESULT_OK;
        int status = -1;
        if ("delivered".equals(kind)) {
            byte[] pdu = i.getByteArrayExtra("pdu");
            if (pdu != null) {
                SmsMessage m = SmsMessage.createFromPdu(pdu, i.getStringExtra("format"));
                if (m != null) status = m.getStatus();
            }
        }
        final int deliveredStatus = status;
        PendingResult async = goAsync();
        new Thread(() -> {
            try {
                handle(ctx, kind, id, ok, rc, deliveredStatus);
                if (SmsSync.run(ctx)) SmsJob.retry(ctx);
            } catch (Exception e) {
                android.util.Log.w("UCAP", "sms: report not handled: " + e.getClass().getSimpleName());
            } finally {
                async.finish();
            }
        }, "ucap-sms-report").start();
    }

    static void handle(Context ctx, String kind, long id, boolean ok, int rc, int deliveredStatus) {
        SmsDb db = SmsDb.get(ctx);
        if (id < 0 || db.send(id) == null) return;
        if ("sent".equals(kind)) {
            SmsDb.Send s = db.sentPart(id, ok, ok ? null : SmsEvents.errorOf(rc));
            if (s == null || !s.reported()) return;
            JSONArray events = new JSONArray();
            if (s.failed == 0) {
                SmsStore.setType(ctx, id, SmsStore.SENT);
                if (s.requestId != null) events.put(SmsEvents.result(s.requestId, "sent", SmsEvents.smsId(id), null));
                // The message in its thread, as the store now has it.
                SmsStore.Row r = SmsStore.one(ctx, id);
                if (r != null) events.put(SmsEvents.message(s.thread, SmsEvents.smsId(id), null, true, r.date, "text", r.body, false));
                // Kept until the delivery reports came (or a week passed: SmsDb.forgetOldSends).
            } else {
                SmsStore.setType(ctx, id, SmsStore.FAILED);
                if (s.requestId != null) events.put(SmsEvents.result(s.requestId, "failed", null, s.error));
                db.dropSend(id);
            }
            db.queue(events);
            return;
        }
        // A delivery report: only one that says it was delivered counts; a pending or failed one keeps it "sent".
        if (!SmsEvents.deliveredStatus(deliveredStatus)) return;
        SmsDb.Send s = db.deliveredPart(id);
        if (s == null || s.delivered < s.parts) return;
        SmsStore.setDelivered(ctx, id);
        db.queue(new JSONArray().put(SmsEvents.delivered(s.thread, SmsEvents.smsId(id))));
        db.dropSend(id);
    }
}
