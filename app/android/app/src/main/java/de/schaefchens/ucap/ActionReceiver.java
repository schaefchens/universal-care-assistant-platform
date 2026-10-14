package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * "Annehmen" / "Kann nicht" on the alarm, without opening the app. "Annehmen" reaches here only after the phone was
 * unlocked (setAuthenticationRequired, Android 12+; before that the alarm screen asks). The alarm says
 * "Wird übermittelt…" at once and stops ringing; the answer goes out while the receiver is kept alive (goAsync).
 */
public class ActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getStringExtra("action");
        // A reminder's "Erledigt" / "Später" from its notification: answered here, signed, kept when offline.
        String oid = intent.getStringExtra(ReminderAlarms.EXTRA_OCCURRENCE);
        if (oid != null && action != null && action.startsWith("rem.")) {
            Context app = ctx.getApplicationContext();
            PendingResult pending = goAsync();
            new Thread(() -> {
                try {
                    ReminderAlarms.respond(app, oid, action.substring(4), java.util.UUID.randomUUID().toString());
                } finally {
                    pending.finish();
                }
            }, "ucap-reminder").start();
            return;
        }
        String rid = intent.getStringExtra(CareAlarm.EXTRA_RID);
        if (rid == null || action == null) return;
        if ("stop".equals(action)) {
            CareAlarm.close(ctx, rid);
            return;
        }
        if (!"accept".equals(action) && !"decline".equals(action)) return;
        int ep = intent.getIntExtra("ep", 0);
        String who = intent.getStringExtra("who") != null ? intent.getStringExtra("who") : "";
        Context app = ctx.getApplicationContext();
        CareAlarm.sending(app, rid, who);
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                Actions.send(app, rid, ep, action, who);
            } finally {
                pending.finish();
            }
        }, "ucap-action").start();
    }
}
