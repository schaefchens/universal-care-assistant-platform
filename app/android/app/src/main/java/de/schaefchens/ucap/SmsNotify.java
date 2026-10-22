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
 * wrote, never what (as UCAP announces messages), so the lock screen shows no SMS text; it opens the messages screen,
 * where it is read. One per conversation, updated in place.
 */
final class SmsNotify {
    private SmsNotify() {}

    static final String CHANNEL = "ucap.sms";
    static final String EXTRA_THREAD = "ucap.sms.thread";

    static void newSms(Context ctx, long thread, String name) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
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
            .setContentTitle(Texts.format(ctx, "sms.new", name))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setVisibility(Notification.VISIBILITY_PRIVATE);
        nm.notify("sms:" + thread, 1, b.build());
    }

    /** Read (heard) in UCAP: its notification goes. */
    static void read(Context ctx, long thread) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel("sms:" + thread, 1);
    }
}
