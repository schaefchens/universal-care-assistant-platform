package de.schaefchens.ucap;

import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.IBinder;

/**
 * A quick reply to a call ("Kann gerade nicht sprechen", the dialler's RESPOND_VIA_MESSAGE), the SMS role's fourth
 * part: the person chose it in the dialler, so it is sent at once, kept in the store and reported like any other SMS.
 * In the SMS process.
 */
public class SmsRespondService extends Service {
    @Override
    public int onStartCommand(Intent i, int flags, int startId) {
        Uri data = i == null ? null : i.getData();
        String to = data == null ? null : data.getSchemeSpecificPart();
        String text = i == null ? null : i.getStringExtra(Intent.EXTRA_TEXT);
        if (to != null && !to.isEmpty() && text != null && !text.isEmpty() && SmsRole.held(this)) {
            new Thread(() -> {
                try {
                    SmsSender.sendTo(this, null, to.split("[?;,]")[0].trim(), text, 0);
                } catch (Exception e) {
                    android.util.Log.w("UCAP", "sms quick reply: " + e.getClass().getSimpleName());
                } finally {
                    stopSelf(startId);
                }
            }, "ucap-sms-respond").start();
            return START_NOT_STICKY;
        }
        stopSelf(startId);
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
