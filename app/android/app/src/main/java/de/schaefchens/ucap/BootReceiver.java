package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** A restart clears every alarm: the reminders of the next 48 hours are set again, and waiting answers sent. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && !"android.intent.action.MY_PACKAGE_REPLACED".equals(intent.getAction())) return;
        Context app = ctx.getApplicationContext();
        if (Ref.load(app) == null) return;
        ReminderAlarms.arm(app);
        Outbox.schedule(app);
    }
}
