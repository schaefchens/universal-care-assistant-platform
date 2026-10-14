package de.schaefchens.ucap;

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
import android.service.notification.StatusBarNotification;
import java.text.DateFormat;
import java.util.Date;
import java.util.Locale;
import org.json.JSONObject;

/**
 * The helper's alarm (docs/plan.md, Appendix D "Receiver", lookup/findings/android.md "The alarm channel"):
 * - one notification per request (tag = request id), updated in place, never re-posted in a burst (Android 15
 *   quietens bursts); the server spaces re-alerts at least two minutes apart;
 * - insistent with alarm usage until someone acts; a full-screen alarm where Android grants it (AlarmActivity);
 * - "Annehmen" needs the phone unlocked (it stops everyone else's alarm), "Kann nicht" works from the lock screen;
 * - a ringing alarm that changes state (sending, accepted elsewhere, cancelled) is removed and posted again on the
 *   quiet channel, which is certain to stop the sound.
 * The person's name is shown on the lock screen: a helper must see at once whose request it is.
 */
final class CareAlarm {
    static final String CHANNEL = "care_alarm";
    static final String QUIET = "care_updates";
    /** Sent inside the app when an alarm ends, so a full-screen AlarmActivity closes too. */
    static final String ACTION_CLOSED = "de.schaefchens.ucap.ALARM_CLOSED";
    static final String EXTRA_RID = "ucap.rid";
    /** What the helper already did on the alarm before the app opened ("accept"). */
    static final String EXTRA_AFTER = "ucap.after";
    private static final int ID = 1;
    private static final String STATE = "ucap.alarms";

    private CareAlarm() {}

    private static NotificationManager nm(Context ctx) {
        return ctx.getSystemService(NotificationManager.class);
    }

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = nm(ctx);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, Texts.get(ctx, "channel.alarm"), NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription(Texts.get(ctx, "channel.alarm.desc"));
            ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[] { 0, 800, 400, 800, 400, 800 });
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            // Takes effect only where the helper allows it; the app never changes the phone's Do Not Disturb.
            ch.setBypassDnd(true);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(QUIET) == null) {
            NotificationChannel q = new NotificationChannel(QUIET, Texts.get(ctx, "channel.quiet"), NotificationManager.IMPORTANCE_LOW);
            q.setDescription(Texts.get(ctx, "channel.quiet.desc"));
            q.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(q);
        }
    }

    static boolean canFullScreen(Context ctx) {
        return Build.VERSION.SDK_INT < 34 || nm(ctx).canUseFullScreenIntent();
    }

    private static Notification.Builder builder(Context ctx, String channel) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, channel) : legacy(ctx, channel);
        return b.setSmallIcon(android.R.drawable.ic_dialog_alert).setShowWhen(true).setVisibility(Notification.VISIBILITY_PUBLIC);
    }

    @SuppressWarnings("deprecation")
    private static Notification.Builder legacy(Context ctx, String channel) {
        Notification.Builder b = new Notification.Builder(ctx);
        if (CHANNEL.equals(channel)) {
            b.setPriority(Notification.PRIORITY_MAX).setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
        } else {
            b.setPriority(Notification.PRIORITY_LOW);
        }
        return b;
    }

    /** Opens the app at the request (the helper's alert screen). */
    static PendingIntent openApp(Context ctx, String rid) {
        Intent i = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_RID, rid).setData(Uri.parse("ucap://alarm/" + rid + "/open"));
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent fullScreen(Context ctx, PushPayload p, String title, String text) {
        Intent i = new Intent(ctx, AlarmActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION)
            .putExtra(EXTRA_RID, p.rid).putExtra("ep", p.ep).putExtra("who", p.who).putExtra("title", title).putExtra("text", text)
            .setData(Uri.parse("ucap://alarm/" + p.rid + "/screen"));
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** One PendingIntent per request and action: the data URI keeps them apart (no hashCode collisions). */
    private static Notification.Action action(Context ctx, PushPayload p, String what, String label) {
        PendingIntent pi;
        boolean needsUnlock = "accept".equals(what);
        if (needsUnlock && Build.VERSION.SDK_INT < 31) {
            // Before Android 12 an action cannot ask for the unlock itself: the alarm screen asks, then accepts.
            Intent i = new Intent(ctx, AlarmActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(EXTRA_RID, p.rid).putExtra("ep", p.ep).putExtra("who", p.who)
                .putExtra("accept", true).setData(Uri.parse("ucap://alarm/" + p.rid + "/" + what));
            pi = PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        } else {
            Intent i = new Intent(ctx, ActionReceiver.class).putExtra(EXTRA_RID, p.rid).putExtra("ep", p.ep).putExtra("who", p.who).putExtra("action", what)
                .setData(Uri.parse("ucap://alarm/" + p.rid + "/" + what));
            pi = PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        }
        Notification.Action.Builder a = new Notification.Action.Builder(null, label, pi);
        if (needsUnlock && Build.VERSION.SDK_INT >= 31) a.setAuthenticationRequired(true);
        return a.build();
    }

    private static String clock(Context ctx, long atS) {
        Locale l = "en".equals(Ref.lang(ctx)) ? Locale.ENGLISH : Locale.GERMAN;
        return DateFormat.getTimeInstance(DateFormat.SHORT, l).format(new Date(atS > 0 ? atS * 1000 : System.currentTimeMillis()));
    }

    /** A help request: rings until someone acts, unless it arrived late (then shown, without sound). */
    static void alert(Context ctx, PushPayload p) {
        ensureChannels(ctx);
        String title = Texts.format(ctx, "alert.title", p.who.isEmpty() ? Texts.get(ctx, "someone") : p.who);
        StringBuilder text = new StringBuilder();
        if (!p.dev.isEmpty()) text.append(p.dev).append(" · ");
        text.append(clock(ctx, p.at));
        if (p.unconfirmed) text.append(' ').append(Texts.get(ctx, "alert.unconfirmed"));
        if (p.late) text.append(" · ").append(Texts.get(ctx, "alert.late"));
        Notification.Builder b = builder(ctx, p.late ? QUIET : CHANNEL)
            .setContentTitle(title)
            .setContentText(text)
            .setCategory(Notification.CATEGORY_ALARM)
            .setOngoing(!p.late)
            .setAutoCancel(false)
            .setContentIntent(openApp(ctx, p.rid))
            .addAction(action(ctx, p, "accept", Texts.get(ctx, "action.accept")))
            .addAction(action(ctx, p, "decline", Texts.get(ctx, "action.decline")));
        // Without the grant (Android 14+ asks the helper), sound and heads-up still work: degraded, not failed.
        if (!p.late && canFullScreen(ctx)) b.setFullScreenIntent(fullScreen(ctx, p, title, text.toString()), true);
        Notification n = b.build();
        if (!p.late) n.flags |= Notification.FLAG_INSISTENT;
        nm(ctx).notify(p.rid, ID, n);
        remember(ctx, p.rid, p.ep, p.who, p.late ? "shown" : "ringing");
    }

    /** The accepter's reminder after twenty minutes: one sound, no repeat. */
    static void watchdog(Context ctx, PushPayload p) {
        ensureChannels(ctx);
        nm(ctx).cancel(p.rid, ID);
        Notification n = builder(ctx, CHANNEL).setContentTitle(Texts.format(ctx, "watchdog", p.who)).setCategory(Notification.CATEGORY_REMINDER).setAutoCancel(true)
            .setContentIntent(openApp(ctx, p.rid)).build();
        nm(ctx).notify(p.rid, ID, n);
        remember(ctx, p.rid, p.ep, p.who, "reminded");
    }

    /** Someone else accepted, or it was resolved: the alarm stops, the helper reads why. */
    static void update(Context ctx, PushPayload p) {
        String text;
        if ("accepted".equals(p.status) && !p.by.isEmpty()) text = Texts.format(ctx, "update.accepted", p.by, p.who);
        else if ("open".equals(p.status)) text = Texts.format(ctx, "update.open", p.who);
        else text = Texts.format(ctx, "update.resolved", p.who);
        info(ctx, p.rid, text);
    }

    static void cancelled(Context ctx, PushPayload p) {
        info(ctx, p.rid, Texts.format(ctx, "cancelled", p.who));
    }

    /** "Wird übermittelt…" while an answer is on its way; the ringing stops at once. */
    static void sending(Context ctx, String rid, String who) {
        quiet(ctx, rid, Texts.format(ctx, "alert.title", who), Texts.get(ctx, "sending"), true);
        remember(ctx, rid, -1, who, "sending");
    }

    static void accepted(Context ctx, String rid, String who) {
        quiet(ctx, rid, Texts.format(ctx, "accepted.self", who), null, false);
        remember(ctx, rid, -1, who, "accepted");
        closeScreen(ctx, rid);
    }

    /** A quiet line about the request, which replaces the alarm (and stops it). */
    static void info(Context ctx, String rid, String text) {
        quiet(ctx, rid, text, null, false);
        remember(ctx, rid, -1, null, "done");
        closeScreen(ctx, rid);
    }

    private static void quiet(Context ctx, String rid, String title, String text, boolean ongoing) {
        ensureChannels(ctx);
        NotificationManager nm = nm(ctx);
        // Removing first is certain to stop an insistent sound; an update in place might not.
        if (active(ctx, rid)) nm.cancel(rid, ID);
        Notification.Builder b = builder(ctx, QUIET).setContentTitle(title).setOngoing(ongoing).setAutoCancel(!ongoing).setContentIntent(openApp(ctx, rid));
        if (text != null) b.setContentText(text);
        if (!ongoing && Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(30 * 60_000L);
        nm.notify(rid, ID, b.build());
    }

    static void close(Context ctx, String rid) {
        nm(ctx).cancel(rid, ID);
        remember(ctx, rid, -1, null, "done");
        closeScreen(ctx, rid);
    }

    private static void closeScreen(Context ctx, String rid) {
        ctx.sendBroadcast(new Intent(ACTION_CLOSED).setPackage(ctx.getPackageName()).putExtra(EXTRA_RID, rid));
    }

    /** The test alarm: the same channel, sound and screen as a real one, so the helper hears what a request does. */
    static void test(Context ctx, String tag) {
        ensureChannels(ctx);
        Intent stop = new Intent(ctx, ActionReceiver.class).putExtra(EXTRA_RID, tag).putExtra("action", "stop").setData(Uri.parse("ucap://alarm/" + tag + "/stop"));
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 0, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = builder(ctx, CHANNEL).setContentTitle(Texts.get(ctx, "test.title")).setContentText(Texts.get(ctx, "test.text")).setCategory(Notification.CATEGORY_ALARM)
            .setOngoing(true).setDeleteIntent(pi).addAction(new Notification.Action.Builder(null, Texts.get(ctx, "action.stop"), pi).build());
        if (Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(60_000L);
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT;
        nm(ctx).notify(tag, ID, n);
    }

    static boolean active(Context ctx, String rid) {
        for (StatusBarNotification s : nm(ctx).getActiveNotifications()) if (rid.equals(s.getTag()) && s.getId() == ID) return true;
        return false;
    }

    /** Per request: the newest episode seen and what the helper did, so an older or repeated push never rings again. */
    private static SharedPreferences state(Context ctx) {
        return ctx.getSharedPreferences(STATE, Context.MODE_PRIVATE);
    }

    static JSONObject recall(Context ctx, String rid) {
        try {
            String s = state(ctx).getString(rid, null);
            return s != null ? new JSONObject(s) : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static void remember(Context ctx, String rid, int ep, String who, String st) {
        try {
            JSONObject prev = recall(ctx, rid);
            JSONObject o = prev != null ? prev : new JSONObject();
            if (ep > 0) o.put("ep", ep);
            if (who != null) o.put("who", who);
            o.put("st", st).put("t", System.currentTimeMillis());
            SharedPreferences.Editor e = state(ctx).edit().putString(rid, o.toString());
            // A day of requests is plenty; older entries go.
            for (java.util.Map.Entry<String, ?> x : state(ctx).getAll().entrySet()) {
                try {
                    if (System.currentTimeMillis() - new JSONObject(String.valueOf(x.getValue())).optLong("t") > 86_400_000L) e.remove(x.getKey());
                } catch (Exception ignored) {
                    e.remove(x.getKey());
                }
            }
            e.apply();
        } catch (Exception ignored) {
            // The state only prevents repeats; the alarm itself never depends on it.
        }
    }

    /** Remembers a delivery as handled; false when it was handled before (the same push twice never rings twice). */
    static boolean firstTime(Context ctx, String dlv) {
        SharedPreferences p = ctx.getSharedPreferences(STATE + ".seen", Context.MODE_PRIVATE);
        if (p.contains(dlv)) return false;
        SharedPreferences.Editor e = p.edit().putLong(dlv, System.currentTimeMillis());
        for (java.util.Map.Entry<String, ?> x : p.getAll().entrySet()) if (x.getValue() instanceof Long && System.currentTimeMillis() - (Long) x.getValue() > 86_400_000L) e.remove(x.getKey());
        e.apply();
        return true;
    }
}
