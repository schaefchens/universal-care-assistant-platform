package de.schaefchens.ucap;

import android.app.ActivityOptions;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.role.RoleManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

/**
 * UCAP as the home screen, and the apps its areas open (docs/plan-m4.md, G8; spikes/m4.md, B). The home role is
 * Android's: asked for after UCAP explained the question, given back in Android's settings in one step. The apps are
 * those Android lets a launcher see (a <queries> entry for MAIN/LAUNCHER, never QUERY_ALL_PACKAGES). While another app
 * is in front, a notification "Zurück zu UCAP" leads back; as the home app UCAP may also come to the front by itself
 * (LIVE's "zurück"), which Android refuses to any other app.
 */
@CapacitorPlugin(name = "Launcher")
public class LauncherPlugin extends Plugin {
    static final String CHANNEL = "ucap-back";
    static final int BACK_ID = 4201;

    static boolean homeHeld(Context ctx) {
        if (Build.VERSION.SDK_INT >= 29) {
            RoleManager rm = ctx.getSystemService(RoleManager.class);
            return rm != null && rm.isRoleAvailable(RoleManager.ROLE_HOME) && rm.isRoleHeld(RoleManager.ROLE_HOME);
        }
        ResolveInfo r = ctx.getPackageManager().resolveActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY);
        return r != null && r.activityInfo != null && ctx.getPackageName().equals(r.activityInfo.packageName);
    }

    private JSObject home() {
        JSObject r = new JSObject();
        r.put("home", homeHeld(getContext()));
        return r;
    }

    @PluginMethod
    public void state(PluginCall call) {
        JSObject r = home();
        // Android 7 to 9 have no role to ask for: their settings choose the home app.
        r.put("askable", Build.VERSION.SDK_INT >= 29);
        call.resolve(r);
    }

    /** Android's question to make UCAP the home screen; UCAP's page explains it first. */
    @PluginMethod
    public void requestHome(PluginCall call) {
        if (homeHeld(getContext()) || Build.VERSION.SDK_INT < 29) {
            if (!homeHeld(getContext())) openHomeSettings();
            call.resolve(home());
            return;
        }
        RoleManager rm = getContext().getSystemService(RoleManager.class);
        startActivityForResult(call, rm.createRequestRoleIntent(RoleManager.ROLE_HOME), "homeResult");
    }

    @ActivityCallback
    private void homeResult(PluginCall call, ActivityResult result) {
        if (call != null) call.resolve(home());
    }

    /** Giving the home screen back is Android's: its settings for the default home app. */
    @PluginMethod
    public void homeSettings(PluginCall call) {
        openHomeSettings();
        call.resolve();
    }

    private void openHomeSettings() {
        try {
            getContext().startActivity(new Intent(Settings.ACTION_HOME_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            getContext().startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
    }

    /** The apps this device can open, by their names. */
    @PluginMethod
    public void apps(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        List<ResolveInfo> found = pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0);
        List<JSObject> out = new ArrayList<>();
        for (ResolveInfo r : found) {
            String pkg = r.activityInfo.packageName;
            if (pkg.equals(getContext().getPackageName())) continue;
            JSObject a = new JSObject();
            a.put("package", pkg);
            a.put("label", String.valueOf(r.loadLabel(pm)));
            out.add(a);
        }
        out.sort((a, b) -> a.getString("label", "").compareToIgnoreCase(b.getString("label", "")));
        JSArray list = new JSArray();
        for (JSObject a : out) list.put(a);
        JSObject r = new JSObject();
        r.put("apps", list);
        call.resolve(r);
    }

    /** Opens an app; while it is in front, "Zurück zu UCAP" waits in the notifications. */
    @PluginMethod
    public void open(PluginCall call) {
        String pkg = call.getString("package");
        Intent i = pkg == null ? null : getContext().getPackageManager().getLaunchIntentForPackage(pkg);
        if (i == null) {
            call.reject("this app is not on the device", "app_missing");
            return;
        }
        try {
            showBack(getContext(), call.getString("title", "UCAP"), call.getString("text", ""));
            getContext().startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception e) {
            hideBack(getContext());
            call.reject("the app did not open", "open_failed", e);
        }
    }

    /** UCAP is in front again: its way back is not needed any more. */
    @PluginMethod
    public void cameBack(PluginCall call) {
        hideBack(getContext());
        call.resolve();
    }

    /** LIVE's "zurück": UCAP to the front. Android allows it to the home app only (spikes/m4.md, B). */
    @PluginMethod
    public void toFront(PluginCall call) {
        if (!homeHeld(getContext())) {
            call.reject("only the home app comes to the front by itself", "not_home");
            return;
        }
        try {
            getContext().startActivity(new Intent(getContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
            call.resolve();
        } catch (Exception e) {
            call.reject("not allowed", "not_allowed", e);
        }
    }

    private static void showBack(Context ctx, String title, String text) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(new NotificationChannel(CHANNEL, title, NotificationManager.IMPORTANCE_DEFAULT));
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        // Android 15 starts the activity from a notification only when the PendingIntent's creator allows it.
        Bundle options = null;
        if (Build.VERSION.SDK_INT >= 35) {
            ActivityOptions o = ActivityOptions.makeBasic();
            o.setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
            options = o.toBundle();
        }
        PendingIntent pi = PendingIntent.getActivity(ctx, BACK_ID, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT, options);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CHANNEL) : new Notification.Builder(ctx);
        b.setSmallIcon(android.R.drawable.ic_menu_revert).setContentTitle(title).setContentText(text).setContentIntent(pi).setOngoing(true).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PUBLIC);
        nm.notify(BACK_ID, b.build());
    }

    static void hideBack(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(BACK_ID);
    }
}
