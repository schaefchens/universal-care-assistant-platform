package de.schaefchens.ucap;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The person's reminders on the device itself (docs/plan.md, S6 "the Reminders plugin"): the app hands over the next
 * 48 hours (RemindersPlugin.schedule), and AlarmManager rings them with the app closed or the device offline
 * (CONCEPT §16). Exact where Android allows it, inexact otherwise. The server prompts too (realtime and push); one
 * notification per occurrence and a short window keep the two from asking twice.
 *
 * Answers go out signed, from here, and wait in the outbox when offline (Outbox). "Später" sets the alarms again
 * after the snooze, as the server does.
 */
final class ReminderAlarms {
    static final String CHANNEL = "reminders";
    static final String EXTRA_OCCURRENCE = "ucap.reminder";
    private static final String PREFS = "ucap.reminders";
    private static final int ID = 2;
    /** A prompt for the same occurrence within this time is the same prompt, from the other source. */
    private static final long SAME_PROMPT_MS = 90_000;

    private ReminderAlarms() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, Texts.get(ctx, "reminder.channel"), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(Texts.get(ctx, "reminder.channel.desc"));
        // A reminder asks; it is not an alarm: the notification sound, never the alarm tone.
        ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());
        ch.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(ch);
    }

    static boolean exactAllowed(Context ctx) {
        return Build.VERSION.SDK_INT < 31 || ctx.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    private static PendingIntent fire(Context ctx, String oid, int k) {
        Intent i = new Intent(ctx, ReminderReceiver.class).putExtra(EXTRA_OCCURRENCE, oid).putExtra("k", k).setData(Uri.parse("ucap://reminder/" + oid + "/" + k));
        return PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static JSONArray items(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString("items", "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static JSONObject item(Context ctx, String oid) {
        JSONArray a = items(ctx);
        for (int i = 0; i < a.length(); i++) if (oid.equals(a.optJSONObject(i).optString("occurrenceId"))) return a.optJSONObject(i);
        return null;
    }

    /** Replaces every alarm with these items' prompts; answered occurrences stay quiet. */
    static synchronized int schedule(Context ctx, JSONArray next) {
        cancelAll(ctx);
        prefs(ctx).edit().putString("items", next.toString()).apply();
        return arm(ctx);
    }

    /** Sets the stored items' alarms again (after a reboot, which clears them). */
    static synchronized int arm(Context ctx) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        JSONArray a = items(ctx);
        boolean exact = exactAllowed(ctx);
        int count = 0;
        long now = System.currentTimeMillis();
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            String oid = o.optString("occurrenceId");
            if (answered(ctx, oid)) continue;
            for (int k = 0; k <= o.optInt("repeats", 0); k++) {
                long at = o.optLong("at") + k * o.optInt("repeatEveryMin", 10) * 60_000L;
                if (at <= now) continue;
                PendingIntent pi = fire(ctx, oid, k);
                if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                count++;
            }
        }
        return count;
    }

    private static void cancelAll(Context ctx) {
        JSONArray a = items(ctx);
        for (int i = 0; i < a.length(); i++) cancel(ctx, a.optJSONObject(i));
    }

    private static void cancel(Context ctx, JSONObject o) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        for (int k = 0; k <= Math.max(6, o.optInt("repeats", 0)); k++) am.cancel(fire(ctx, o.optString("occurrenceId"), k));
    }

    /** The question as the app gave it for this occurrence (the category's, in the person's words, when the
     *  reminder has none of its own); the push's own text otherwise. */
    static String questionFor(Context ctx, String oid, String pushed) {
        if (pushed != null && !pushed.isEmpty()) return pushed;
        JSONObject o = item(ctx, oid);
        return o != null ? o.optString("prompt", "") : "";
    }

    static String titleFor(Context ctx, String oid, String pushed) {
        if (pushed != null && !pushed.isEmpty()) return pushed;
        JSONObject o = item(ctx, oid);
        String t = o != null ? o.optString("title", "") : "";
        return t.isEmpty() ? Texts.get(ctx, "reminder.title") : t;
    }

    static boolean answered(Context ctx, String oid) {
        return prefs(ctx).contains("answered:" + oid);
    }

    /** Answered here: its alarms stop, its notification goes. A snooze sets them again for later. */
    static synchronized void answeredLocally(Context ctx, String oid, String kind) {
        JSONObject o = item(ctx, oid);
        if (o != null) cancel(ctx, o);
        ctx.getSystemService(NotificationManager.class).cancel("rem-" + oid, ID);
        if (!"later".equals(kind)) {
            SharedPreferences.Editor e = prefs(ctx).edit().putLong("answered:" + oid, System.currentTimeMillis());
            // Old marks go after two days; the schedule only reaches 48 hours ahead.
            for (Map.Entry<String, ?> x : prefs(ctx).getAll().entrySet())
                if (x.getKey().startsWith("answered:") && x.getValue() instanceof Long && System.currentTimeMillis() - (Long) x.getValue() > 2 * 86_400_000L) e.remove(x.getKey());
            e.apply();
            return;
        }
        if (o == null) return;
        try {
            long at = System.currentTimeMillis() + o.optInt("snoozeMin", 15) * 60_000L;
            JSONArray a = items(ctx);
            for (int i = 0; i < a.length(); i++) {
                JSONObject x = a.optJSONObject(i);
                if (oid.equals(x.optString("occurrenceId"))) x.put("at", at).put("repeats", o.optInt("repeatCount", o.optInt("repeats", 0)));
            }
            prefs(ctx).edit().putString("items", a.toString()).apply();
            arm(ctx);
        } catch (Exception ignored) {
            // The server asks again after the snooze in any case.
        }
    }

    /** A prompt, from a local alarm or a push. False when it was just shown (the other source, same prompt). */
    static synchronized boolean prompt(Context ctx, String oid, String title, String text) {
        if (answered(ctx, oid)) return false;
        long last = prefs(ctx).getLong("shown:" + oid, 0);
        if (System.currentTimeMillis() - last < SAME_PROMPT_MS) return false;
        prefs(ctx).edit().putLong("shown:" + oid, System.currentTimeMillis()).apply();
        // In front, the app asks itself, with its voice and its areas.
        if (RemindersPlugin.emitDue(oid)) return true;
        ensureChannel(ctx);
        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_OCCURRENCE, oid)
            .setData(Uri.parse("ucap://reminder/" + oid + "/open"));
        PendingIntent content = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CHANNEL) : new Notification.Builder(ctx))
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(text)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(content)
            .addAction(action(ctx, oid, "done", Texts.get(ctx, "reminder.done")))
            .addAction(action(ctx, oid, "later", Texts.get(ctx, "reminder.later")));
        // Where Android allows it, the app opens with the question (and its four answers), also on a resting screen.
        if (CareAlarm.canFullScreen(ctx)) b.setFullScreenIntent(content, true);
        ctx.getSystemService(NotificationManager.class).notify("rem-" + oid, ID, b.build());
        return true;
    }

    private static Notification.Action action(Context ctx, String oid, String kind, String label) {
        Intent i = new Intent(ctx, ActionReceiver.class).putExtra(EXTRA_OCCURRENCE, oid).putExtra("action", "rem." + kind).setData(Uri.parse("ucap://reminder/" + oid + "/" + kind));
        return new Notification.Action.Builder(null, label, PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)).build();
    }

    /** The answer, signed here (off the main thread). sent / queued / refused, with the server's reason. */
    static Map<String, String> respond(Context ctx, String oid, String kind, String clientResponseId) {
        answeredLocally(ctx, oid, kind);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("clientResponseId", clientResponseId);
        body.put("kind", kind);
        String path = "/api/v1/reminders/occurrences/" + oid + "/responses";
        String idem = Api.idem();
        Api.Result r = Api.signed(ctx, "POST", path, body, idem, 8000);
        Map<String, String> out = new LinkedHashMap<>();
        if (r.ok()) {
            out.put("result", "sent");
        } else if (r.retry()) {
            Outbox.add(ctx, Outbox.entry("reminder", "POST", path, SignedRequest.jcs(body), idem));
            out.put("result", "queued");
        } else {
            out.put("result", "refused");
            String reason = r.params().optString("reason", "");
            out.put("reason", reason.isEmpty() ? "refused_" + r.status : reason);
        }
        return out;
    }

    /** To a helper: a reminder of someone went unanswered. Quiet, never an alarm (CONCEPT §9). */
    static void followUp(Context ctx, PushPayload p) {
        CareAlarm.ensureChannels(ctx);
        Notification n = (Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CareAlarm.QUIET) : new Notification.Builder(ctx))
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(Texts.format(ctx, "reminder.missed", p.who, p.title.isEmpty() ? Texts.get(ctx, "reminder.category." + p.category) : p.title))
            .setAutoCancel(true)
            .setContentIntent(CareAlarm.openApp(ctx, p.oid))
            .build();
        ctx.getSystemService(NotificationManager.class).notify("missed-" + p.oid, ID, n);
    }
}
