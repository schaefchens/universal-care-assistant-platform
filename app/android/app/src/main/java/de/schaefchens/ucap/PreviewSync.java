package de.schaefchens.ucap;

import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.provider.Settings;
import org.json.JSONArray;

/**
 * The previews reported to the server (docs/plan-m3.md, K5), signed with the device's key so it works with the app
 * closed, in order, each batch to the connection of the app it came from. A failure leaves everything where it was, for
 * PreviewJob to try again; a batch the server refuses is skipped; a connection the server no longer has is no longer
 * watched. In the previews process only. Nothing is logged but counts and classes.
 */
final class PreviewSync {
    private PreviewSync() {}

    static final String PATH = "/api/v1/messaging/device/events";
    private static final int TIMEOUT_MS = 15_000;

    /** Whether Android lets UCAP read notifications (the person allowed it in Android's settings). */
    static boolean accessGranted(Context ctx) {
        ComponentName me = new ComponentName(ctx, PreviewListener.class);
        if (Build.VERSION.SDK_INT >= 27) return ctx.getSystemService(NotificationManager.class).isNotificationListenerAccessGranted(me);
        String on = Settings.Secure.getString(ctx.getContentResolver(), "enabled_notification_listeners");
        return on != null && on.contains(me.flattenToString());
    }

    /** Every chosen app's connection: ready, or off (with why). */
    static void state(Context ctx, String state, String error) {
        PreviewDb db = PreviewDb.get(ctx);
        for (PreviewDb.App a : db.apps()) db.queue(a.connection, new JSONArray().put(SmsEvents.state(state, error)));
    }

    static void runOrRetry(Context ctx) {
        if (run(ctx)) PreviewJob.retry(ctx);
    }

    /** Reports what waits; true when something is left for a later try. */
    static boolean run(Context ctx) {
        PreviewDb db = PreviewDb.get(ctx);
        while (true) {
            PreviewDb.Entry e = db.first();
            if (e == null) return false;
            JSONArray events;
            try {
                events = new JSONArray(e.events);
            } catch (Exception x) {
                db.done(e.id);
                continue;
            }
            Api.Result r = Api.signed(ctx, "POST", PATH, SmsEvents.batch(e.connection, events), e.idem, TIMEOUT_MS);
            if (r.retry() || r.status == -1) return true;
            if (r.status == 404) {
                // The person disconnected it on the server (or another phone runs it): not watched any more.
                db.dropApp(e.connection);
                continue;
            }
            if (!r.ok()) android.util.Log.w("UCAP", "previews: a report was refused (" + r.status + ")");
            db.done(e.id);
        }
    }
}
