package de.schaefchens.ucap;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

/**
 * UCAP's own notification for a new SMS (docs/plan-m3.md, K4): as the SMS app it is the only one there is. It says who
 * wrote and what, as UCAP announces messages (the owner, 2026-10-27: "should say what, in general for all messages"),
 * or who alone where the device is set so; never a one-time code (K8), since TalkBack reads a notification out as it
 * comes. Private on a lock screen that hides what notifications say. It opens the messages screen; one per
 * conversation, updated in place.
 */
final class SmsNotify {
    private SmsNotify() {}

    static final String CHANNEL = "ucap.sms";
    static final String EXTRA_THREAD = "ucap.sms.thread";
    /** The device's setting, kept in the SMS process, which alone writes and reads it. */
    private static final String PREFS = "ucap.sms.notify";

    /** The device's setting (the app tells it as the configuration comes): what a message says, or who wrote alone. */
    static void setText(Context ctx, boolean on) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("text", on).apply();
    }

    static boolean text(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("text", true);
    }

    /** What the notification says of a message: its text, a code by what it is; nothing when set to who alone. */
    static String body(Context ctx, String text) {
        if (!text(ctx) || text == null || text.trim().isEmpty()) return null;
        return OneTimeCode.in(text) ? Texts.get(ctx, "sms.code") : text.trim();
    }

    /** An MMS: its text, a photo named as one; a code never. */
    static String mmsBody(Context ctx, String text, boolean picture) {
        if (!text(ctx)) return null;
        String t = text == null ? "" : text.trim();
        if (!t.isEmpty() && OneTimeCode.in(t)) return Texts.get(ctx, "sms.code");
        if (picture) return t.isEmpty() ? Texts.get(ctx, "mms.photo") : Texts.format(ctx, "mms.photo.text", t);
        return t.isEmpty() ? null : t;
    }

    static void newSms(Context ctx, long thread, String name, String text) {
        newMessage(ctx, thread, name, "sms.new", body(ctx, text));
    }

    /** `titleKey`: "sms.new" or "mms.new"; `body`: what it says, or null. */
    static void newMessage(Context ctx, long thread, String name, String titleKey, String body) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            // Made again each time: Android keeps the person's choices for it and takes its name and description (the
            // app's language, the wording of this version).
            NotificationChannel ch = new NotificationChannel(CHANNEL, Texts.get(ctx, "sms.channel"), NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription(Texts.get(ctx, "sms.channel.desc"));
            ch.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_THREAD, thread).setData(Uri.parse("ucap://sms/" + thread));
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CHANNEL) : new Notification.Builder(ctx);
        b.setSmallIcon(android.R.drawable.sym_action_email)
            .setContentTitle(Texts.format(ctx, titleKey, name))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setVisibility(Notification.VISIBILITY_PRIVATE);
        if (body != null) b.setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body));
        nm.notify("sms:" + thread, 1, b.build());
    }

    /** Read (heard) in UCAP: its notification goes. */
    static void read(Context ctx, long thread) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel("sms:" + thread, 1);
    }
}
