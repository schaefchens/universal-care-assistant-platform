package de.schaefchens.ucap.spike4;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

/** A microphone foreground service like LIVE mode's (it records nothing): may its app come to the front by itself? */
public class MicService extends Service {
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("mic", "Spike", NotificationManager.IMPORTANCE_LOW));
        Notification n = new Notification.Builder(this, "mic").setContentTitle("UCAP Spike hört zu").setSmallIcon(android.R.drawable.ic_btn_speak_now).build();
        try {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            Ev.log("mic.started");
        } catch (Throwable t) {
            Ev.log("mic.failed", "error", Ev.err(t));
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
