package de.schaefchens.ucap.spike4;

import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;

/** Lock task as device owner (spike C): the allowed apps, the features, the spike as the home screen. */
final class Kiosk {
    private Kiosk() {}

    static ComponentName admin(Context c) {
        return new ComponentName(c, Admin.class);
    }

    static int features(String list) {
        int f = DevicePolicyManager.LOCK_TASK_FEATURE_NONE;
        if (list == null) return DevicePolicyManager.LOCK_TASK_FEATURE_HOME | DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS;
        for (String s : list.split(",")) {
            switch (s.trim()) {
                case "home": f |= DevicePolicyManager.LOCK_TASK_FEATURE_HOME; break;
                case "overview": f |= DevicePolicyManager.LOCK_TASK_FEATURE_OVERVIEW; break;
                case "notifications": f |= DevicePolicyManager.LOCK_TASK_FEATURE_NOTIFICATIONS; break;
                case "sysinfo": f |= DevicePolicyManager.LOCK_TASK_FEATURE_SYSTEM_INFO; break;
                case "global": f |= DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS; break;
                case "keyguard": f |= DevicePolicyManager.LOCK_TASK_FEATURE_KEYGUARD; break;
                default: break;
            }
        }
        return f;
    }

    static void on(Activity a, String extra, String featureList) {
        DevicePolicyManager dpm = a.getSystemService(DevicePolicyManager.class);
        if (!dpm.isDeviceOwnerApp(a.getPackageName())) {
            Ev.log("kiosk.not_owner");
            return;
        }
        String[] pk = (a.getPackageName() + (extra == null || extra.isEmpty() ? "" : "," + extra)).split(",");
        dpm.setLockTaskPackages(admin(a), pk);
        int f = features(featureList);
        dpm.setLockTaskFeatures(admin(a), f);
        IntentFilter home = new IntentFilter(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);
        home.addCategory(Intent.CATEGORY_DEFAULT);
        dpm.addPersistentPreferredActivity(admin(a), home, new ComponentName(a, MainActivity.class));
        a.startLockTask();
        Ev.log("kiosk.on", "packages", pk.length, "features", f, "permitted", dpm.isLockTaskPermitted(a.getPackageName()));
    }

    static void off(Activity a) {
        DevicePolicyManager dpm = a.getSystemService(DevicePolicyManager.class);
        try {
            a.stopLockTask();
        } catch (Throwable t) {
            Ev.log("kiosk.stop_failed", "error", Ev.err(t));
        }
        if (dpm.isDeviceOwnerApp(a.getPackageName())) {
            dpm.clearPackagePersistentPreferredActivities(admin(a), a.getPackageName());
            dpm.setLockTaskPackages(admin(a), new String[0]);
        }
        Ev.log("kiosk.off");
    }
}
