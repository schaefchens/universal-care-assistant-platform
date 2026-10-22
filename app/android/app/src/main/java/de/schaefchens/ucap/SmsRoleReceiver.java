package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The SMS role changed hands (Android tells the old and the new SMS app), in the SMS process. Given back: the server is
 * told "off", so what waited for this phone is not sent and kept as a draft. Android also ends UCAP's processes and
 * takes the role's permissions; reporting needs neither. Taken again: "ready".
 */
public class SmsRoleReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        PendingResult async = goAsync();
        new Thread(() -> {
            try {
                if (SmsSync.run(ctx)) SmsJob.retry(ctx);
            } catch (Exception e) {
                android.util.Log.w("UCAP", "sms role: " + e.getClass().getSimpleName());
            } finally {
                async.finish();
            }
        }, "ucap-sms-role").start();
    }
}
