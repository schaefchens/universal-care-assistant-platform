package de.schaefchens.ucap;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioManager;
import android.os.Build;
import android.os.PowerManager;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONObject;

/**
 * What happens to a decrypted push (docs/plan.md, Appendix D "Receiver"): the signed receipt goes out first, with
 * what decides "silenced", so "received" means this phone has it; then the alarm or its update. A receipt that cannot
 * be sent within three seconds waits in the outbox, and the alarm rings anyway. Runs off the main thread.
 */
final class PushHandler {
    private static final int RECEIPT_TIMEOUT_MS = 3000;

    private PushHandler() {}

    static void handle(Context ctx, String json) {
        PushPayload p = PushPayload.parse(json, System.currentTimeMillis() / 1000);
        // Not ours, or this device is signed out: nothing rings for an account that is gone.
        if (p == null || Ref.load(ctx) == null) return;
        if (!CareAlarm.firstTime(ctx, p.dlv)) return;
        PowerManager.WakeLock wl = ctx.getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ucap:push");
        wl.acquire(15_000);
        try {
            if (p.care() && stale(ctx, p)) return;
            CareAlarm.ensureChannels(ctx);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("dlv", p.dlv);
            body.put("n", p.nonce);
            Map<String, Object> state = new LinkedHashMap<>();
            boolean silenced = readState(ctx, state);
            if (p.late) state.put("late", true);
            body.put("silenced", silenced && p.rings());
            body.put("state", state);
            String idem = Api.idem();
            Api.Result r = Api.signed(ctx, "POST", "/api/v1/push/receipts", body, idem, RECEIPT_TIMEOUT_MS);
            if (r.retry()) Outbox.add(ctx, Outbox.entry("receipt", "POST", "/api/v1/push/receipts", SignedRequest.jcs(body), idem));
            show(ctx, p);
        } finally {
            if (wl.isHeld()) wl.release();
        }
    }

    /** An alert for an episode older than one already seen, or for a request this helper already answered. */
    private static boolean stale(Context ctx, PushPayload p) {
        JSONObject s = CareAlarm.recall(ctx, p.rid);
        if (s == null) return false;
        int ep = s.optInt("ep", 0);
        if (p.ep < ep) return true;
        // A new alert in the same episode after the helper accepted is the watchdog's business, not a new ring.
        return "care.alert".equals(p.type) && p.ep == ep && "accepted".equals(s.optString("st"));
    }

    private static void show(Context ctx, PushPayload p) {
        switch (p.type) {
            case "care.alert": CareAlarm.alert(ctx, p); break;
            case "care.watchdog": CareAlarm.watchdog(ctx, p); break;
            case "care.update": CareAlarm.update(ctx, p); break;
            case "care.cancel": CareAlarm.cancelled(ctx, p); break;
            case "test": if (!p.late) CareAlarm.test(ctx, "test-" + p.dlv); break;
            default: break; // a heartbeat needs no notification: the receipt is the answer
        }
    }

    /** Fills the receipt's state and says whether an alarm would go unheard (Silence). */
    static boolean readState(Context ctx, Map<String, Object> out) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        boolean on = nm.areNotificationsEnabled();
        int importance = Silence.IMPORTANCE_HIGH;
        boolean bypass = false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = nm.getNotificationChannel(CareAlarm.CHANNEL);
            if (ch != null) {
                importance = ch.getImportance();
                bypass = ch.canBypassDnd();
            }
        }
        int filter = nm.getCurrentInterruptionFilter();
        boolean alarms = Build.VERSION.SDK_INT >= 28 && (nm.getNotificationPolicy().priorityCategories & NotificationManager.Policy.PRIORITY_CATEGORY_ALARMS) != 0;
        AudioManager am = ctx.getSystemService(AudioManager.class);
        int max = Math.max(1, am.getStreamMaxVolume(AudioManager.STREAM_ALARM));
        int volume = Math.round(100f * am.getStreamVolume(AudioManager.STREAM_ALARM) / max);
        out.put("permission", on ? "granted" : "denied");
        out.put("dnd", Silence.dnd(filter));
        out.put("channel", importance >= Silence.IMPORTANCE_HIGH ? "high" : "low");
        out.put("volume", volume);
        return Silence.silenced(on, importance, filter, bypass, alarms, volume);
    }
}
