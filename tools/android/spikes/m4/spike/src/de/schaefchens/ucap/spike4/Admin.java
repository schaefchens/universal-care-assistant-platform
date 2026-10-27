package de.schaefchens.ucap.spike4;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;

/** The spike's device administrator: device owner only on the scratch emulator, removed again by `do-clear`. */
public class Admin extends DeviceAdminReceiver {
    @Override
    public void onEnabled(Context c, Intent i) {
        Ev.log("admin.enabled");
    }

    @Override
    public void onLockTaskModeEntering(Context c, Intent i, String pkg) {
        Ev.log("admin.locktask_entering", "pkg", pkg);
    }

    @Override
    public void onLockTaskModeExiting(Context c, Intent i) {
        Ev.log("admin.locktask_exiting");
    }
}
