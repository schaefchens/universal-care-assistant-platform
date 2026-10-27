package de.schaefchens.ucap;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;

/**
 * The kiosk (docs/plan-m4.md, G9; spikes/m4.md, C). On a dedicated device, where UCAP is the device owner (set up once
 * from a reset device, operator.md), it is lock task: UCAP and the allowed apps only, Home leading to UCAP, notifications
 * and Android's lock screen only where chosen. On any other device it is screen pinning, which Android asks for and one
 * gesture ends (the page says so). Help is never behind it: it is UCAP's own screen. UCAP's settings end the device
 * owner again, which only the app itself can.
 */
@CapacitorPlugin(name = "Kiosk")
public class KioskPlugin extends Plugin {
    static ComponentName admin(Context c) {
        return new ComponentName(c, UcapAdmin.class);
    }

    private DevicePolicyManager dpm() {
        return getContext().getSystemService(DevicePolicyManager.class);
    }

    private boolean owner() {
        DevicePolicyManager d = dpm();
        return d != null && d.isDeviceOwnerApp(getContext().getPackageName());
    }

    /** "off", "pinned" (screen pinning) or "locked" (lock task as device owner). */
    private String mode() {
        ActivityManager am = getContext().getSystemService(ActivityManager.class);
        int s = am == null ? ActivityManager.LOCK_TASK_MODE_NONE : am.getLockTaskModeState();
        return s == ActivityManager.LOCK_TASK_MODE_LOCKED ? "locked" : s == ActivityManager.LOCK_TASK_MODE_PINNED ? "pinned" : "off";
    }

    private JSObject state() {
        JSObject r = new JSObject();
        r.put("owner", owner());
        r.put("mode", mode());
        return r;
    }

    @PluginMethod
    public void state(PluginCall call) {
        call.resolve(state());
    }

    /**
     * The kiosk as the configuration says: `apps` (packages) allowed besides UCAP, `notifications`, `keyguardOff`
     * (Android's lock screen, only removable where it has no PIN). As device owner: lock task, no question. Otherwise:
     * screen pinning, Android's question first.
     */
    @PluginMethod
    public void start(PluginCall call) {
        Activity a = getActivity();
        if (a == null) {
            call.reject("no activity", "no_activity");
            return;
        }
        a.runOnUiThread(() -> {
            try {
                if (owner()) {
                    DevicePolicyManager d = dpm();
                    List<String> pk = new ArrayList<>();
                    pk.add(getContext().getPackageName());
                    JSArray apps = call.getArray("apps", new JSArray());
                    for (int i = 0; i < apps.length(); i++) pk.add(apps.getString(i));
                    d.setLockTaskPackages(admin(getContext()), pk.toArray(new String[0]));
                    if (Build.VERSION.SDK_INT >= 28) {
                        int f = DevicePolicyManager.LOCK_TASK_FEATURE_HOME | DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS;
                        if (Boolean.TRUE.equals(call.getBoolean("notifications", false))) f |= DevicePolicyManager.LOCK_TASK_FEATURE_NOTIFICATIONS;
                        d.setLockTaskFeatures(admin(getContext()), f);
                    }
                    // Home leads to UCAP, whatever was the home app before.
                    IntentFilter home = new IntentFilter(Intent.ACTION_MAIN);
                    home.addCategory(Intent.CATEGORY_HOME);
                    home.addCategory(Intent.CATEGORY_DEFAULT);
                    d.addPersistentPreferredActivity(admin(getContext()), home, new ComponentName(getContext(), MainActivity.class));
                    if (Build.VERSION.SDK_INT >= 23) d.setKeyguardDisabled(admin(getContext()), Boolean.TRUE.equals(call.getBoolean("keyguardOff", false)));
                }
                // Already pinned or locked (UCAP started again): Android would ask its pinning question anew (seen).
                if ("off".equals(mode())) a.startLockTask();
                call.resolve(state());
            } catch (RuntimeException | JSONException e) {
                call.reject("the kiosk did not start", "kiosk_failed", e);
            }
        });
    }

    /** Ends the kiosk (lock task or pinning); as device owner, Home and the lock screen are Android's again. */
    @PluginMethod
    public void stop(PluginCall call) {
        Activity a = getActivity();
        if (a == null) {
            call.reject("no activity", "no_activity");
            return;
        }
        a.runOnUiThread(() -> {
            try {
                a.stopLockTask();
            } catch (RuntimeException e) {
                // Not in lock task: nothing to end.
            }
            if (owner()) {
                DevicePolicyManager d = dpm();
                d.clearPackagePersistentPreferredActivities(admin(getContext()), getContext().getPackageName());
                d.setLockTaskPackages(admin(getContext()), new String[0]);
                if (Build.VERSION.SDK_INT >= 23) d.setKeyguardDisabled(admin(getContext()), false);
            }
            call.resolve(state());
        });
    }

    /** UCAP stops being the device owner (only the app itself can): the device is an ordinary one again. */
    @PluginMethod
    public void endOwner(PluginCall call) {
        if (!owner()) {
            call.resolve(state());
            return;
        }
        try {
            dpm().clearDeviceOwnerApp(getContext().getPackageName());
            call.resolve(state());
        } catch (RuntimeException e) {
            call.reject("could not end", "owner_failed", e);
        }
    }
}
