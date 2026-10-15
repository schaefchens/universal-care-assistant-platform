package de.schaefchens.ucap.spike;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/** The SMS role's quick reply to a ringing call (RESPOND_VIA_MESSAGE): here it only says that it was asked. */
public class RespondService extends Service {
    @Override
    public IBinder onBind(Intent i) {
        return null;
    }

    @Override
    public int onStartCommand(Intent i, int flags, int id) {
        Spike.log("respond_via_message", "scheme", i == null || i.getData() == null ? null : i.getData().getScheme(), "text", i != null && i.getStringExtra(Intent.EXTRA_TEXT) != null);
        stopSelf(id);
        return START_NOT_STICKY;
    }
}
