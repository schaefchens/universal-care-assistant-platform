package de.schaefchens.ucap;

import android.app.role.RoleManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.telecom.TelecomManager;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * UCAP as the phone app (docs/plan-m4.md, G10; spikes/m4.md, D), for the app: whether the phone can have one and UCAP
 * holds the role (asked for after UCAP explained it, given back in Android's settings), calling out through the role
 * without a dialler in between, and a number another app handed to the dialler. A tablet without telephony is never
 * offered it.
 */
@CapacitorPlugin(name = "Phone")
public class PhonePlugin extends Plugin {
    /** A number another app asked to dial (DialActivity), taken once by the app, which asks the person first. */
    static volatile String pendingDial;
    private static volatile PhonePlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** A call began or ended: the app shows its way back to the call while one lasts. */
    static void callsChanged() {
        PhonePlugin p = instance;
        if (p != null) p.notifyListeners("call", new JSObject().put("inCall", UcapCallService.current != null));
    }

    /** Back to the call's screen (from the app's "Zurück zum Anruf"). */
    @PluginMethod
    public void showCall(PluginCall call) {
        if (UcapCallService.current != null) CallActivity.open(getContext());
        call.resolve();
    }

    @PluginMethod
    public void takeDial(PluginCall call) {
        String n = pendingDial;
        pendingDial = null;
        JSObject r = new JSObject();
        if (n != null) r.put("number", n);
        call.resolve(r);
    }

    private static boolean telephony(Context c) {
        return c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY);
    }

    static boolean held(Context c) {
        if (Build.VERSION.SDK_INT < 29) return false;
        RoleManager rm = c.getSystemService(RoleManager.class);
        return rm != null && rm.isRoleAvailable(RoleManager.ROLE_DIALER) && rm.isRoleHeld(RoleManager.ROLE_DIALER);
    }

    private JSObject state() {
        JSObject r = new JSObject();
        r.put("available", telephony(getContext()) && Build.VERSION.SDK_INT >= 29);
        r.put("held", held(getContext()));
        r.put("inCall", UcapCallService.current != null);
        return r;
    }

    @PluginMethod
    public void state(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void requestRole(PluginCall call) {
        if (held(getContext()) || !telephony(getContext()) || Build.VERSION.SDK_INT < 29) {
            call.resolve(state());
            return;
        }
        RoleManager rm = getContext().getSystemService(RoleManager.class);
        startActivityForResult(call, rm.createRequestRoleIntent(RoleManager.ROLE_DIALER), "roleResult");
    }

    @ActivityCallback
    private void roleResult(PluginCall call, ActivityResult result) {
        if (call != null) call.resolve(state());
    }

    /** Giving the phone role back is Android's: its settings for default apps. */
    @PluginMethod
    public void roleSettings(PluginCall call) {
        try {
            getContext().startActivity(new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            getContext().startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    /** A call out through the role: no dialler in between (the person already said yes in UCAP). */
    @PluginMethod
    public void place(PluginCall call) {
        String number = call.getString("number", "").replaceAll("[\\s()/.-]", "");
        if (!held(getContext()) || !number.matches("^\\+?[0-9]{2,15}$")) {
            call.reject("not the phone app", "not_held");
            return;
        }
        TelecomManager tm = getContext().getSystemService(TelecomManager.class);
        try {
            tm.placeCall(Uri.fromParts("tel", number, null), null);
            call.resolve();
        } catch (SecurityException e) {
            call.reject("not allowed", "not_allowed", e);
        }
    }
}
