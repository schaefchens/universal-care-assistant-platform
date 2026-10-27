package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;

/**
 * An SMS arrived (SMS_DELIVER: only the SMS app gets it, and only it writes the store; spike C), in the SMS process. A
 * long SMS comes joined, its parts in one broadcast. Written to Android's store, unread; UCAP's notification says who
 * wrote and what (as the device is set); then it is reported to the server, which announces it on the person's
 * devices. Blocked numbers never get here: Android drops their SMS before the SMS app sees them.
 */
public class SmsDeliverReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        if (!Telephony.Sms.Intents.SMS_DELIVER_ACTION.equals(i.getAction())) return;
        SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(i);
        if (parts == null || parts.length == 0 || parts[0] == null) return;
        StringBuilder body = new StringBuilder();
        for (SmsMessage m : parts) if (m != null && m.getMessageBody() != null) body.append(m.getMessageBody());
        String from = parts[0].getOriginatingAddress();
        long sent = parts[0].getTimestampMillis();
        int sub = i.getIntExtra("android.telephony.extra.SUBSCRIPTION_INDEX", i.getIntExtra("subscription", -1));
        PendingResult async = goAsync();
        new Thread(() -> {
            try {
                long id = SmsStore.insertInbox(ctx, from, body.toString(), sent, sub);
                if (id > 0) {
                    SmsStore.Row r = SmsStore.one(ctx, id);
                    if (r != null) SmsNotify.newSms(ctx, r.thread, SmsStore.person(ctx, from, SmsStore.country(ctx)).name, body.toString());
                }
                if (SmsSync.run(ctx)) SmsJob.retry(ctx);
            } catch (Exception e) {
                android.util.Log.e("UCAP", "sms: an arriving SMS was not handled: " + e.getClass().getSimpleName());
            } finally {
                async.finish();
            }
        }, "ucap-sms-in").start();
    }
}
