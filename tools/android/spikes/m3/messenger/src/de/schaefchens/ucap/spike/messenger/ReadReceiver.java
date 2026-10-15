package de.schaefchens.ucap.spike.messenger;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** "Gelesen" from the notification: the conversation's notification goes away, as messengers do it. */
public class ReadReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String conv = i.getStringExtra("conv");
        if (conv != null) c.getSystemService(NotificationManager.class).cancel(conv, 1);
        Spike.log("messenger_read");
    }
}
