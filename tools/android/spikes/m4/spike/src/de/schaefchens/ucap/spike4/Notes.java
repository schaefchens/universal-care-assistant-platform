package de.schaefchens.ucap.spike4;

import android.app.ActivityOptions;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** The way back by notification (spike B): an ongoing "Zurück zu UCAP" whose tap brings the spike to the front. */
final class Notes {
    private Notes() {}

    static void back(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("back", "Zurück", NotificationManager.IMPORTANCE_DEFAULT));
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ActivityOptions o = ActivityOptions.makeBasic();
        if (Build.VERSION.SDK_INT >= 35) o.setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
        PendingIntent pi = PendingIntent.getActivity(c, 7, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT, o.toBundle());
        Notification n = new Notification.Builder(c, "back").setContentTitle("Zurück zu UCAP Spike").setSmallIcon(android.R.drawable.ic_menu_revert).setContentIntent(pi).setOngoing(true).build();
        nm.notify(7, n);
        Ev.log("back.posted");
    }
}
