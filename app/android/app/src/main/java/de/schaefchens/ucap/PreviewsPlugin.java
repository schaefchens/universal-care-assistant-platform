package de.schaefchens.ucap;

import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Previews of other apps (docs/plan-m3.md, K5), for the app's page: whether Android lets UCAP read notifications,
 * which of the messengers UCAP knows are on the phone (Android shows them to UCAP because the manifest names them),
 * Android's notification access page and UCAP's own app info (where an app installed from a file first needs
 * "Eingeschränkte Einstellungen zulassen"), and the previews process told what to watch, take or mark read. The work
 * itself runs in the previews process (PreviewCommands); this plugin only asks it.
 */
@CapacitorPlugin(name = "Previews")
public class PreviewsPlugin extends Plugin {
    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("access", PreviewSync.accessGranted(getContext()));
        r.put("sdk", Build.VERSION.SDK_INT);
        // A debug build also offers the emulator checks' stand-in messenger.
        r.put("debug", (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        call.resolve(r);
    }

    /** Of these packages, which are installed, with the name the phone shows for them. */
    @PluginMethod
    public void apps(PluginCall call) {
        JSArray asked = call.getArray("packages", new JSArray());
        PackageManager pm = getContext().getPackageManager();
        JSArray out = new JSArray();
        for (int i = 0; i < asked.length(); i++) {
            String pkg = asked.optString(i);
            JSObject a = new JSObject().put("package", pkg);
            try {
                ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
                a.put("installed", true).put("name", String.valueOf(pm.getApplicationLabel(info)));
            } catch (PackageManager.NameNotFoundException e) {
                a.put("installed", false);
            }
            out.put(a);
        }
        call.resolve(new JSObject().put("apps", out));
    }

    /** Android's page where the person lets UCAP read notifications: UCAP's own entry where Android has one (11+). */
    @PluginMethod
    public void openAccess(PluginCall call) {
        Intent i;
        if (Build.VERSION.SDK_INT >= 30) {
            i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, new ComponentName(getContext(), PreviewListener.class).flattenToString());
        } else {
            i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        }
        try {
            getActivity().startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException e) {
            getActivity().startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    /** UCAP's own app info: its menu holds "Eingeschränkte Einstellungen zulassen" (Android 13+, an app from a file). */
    @PluginMethod
    public void openAppInfo(PluginCall call) {
        getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    /** The previews process watches this app for the person's connection from now on; what it shows now is history. */
    @PluginMethod
    public void connect(PluginCall call) {
        String id = call.getString("connectionId", "");
        String pkg = call.getString("package", "");
        if (!id.matches("^[0-9a-f-]{36}$") || pkg.isEmpty()) {
            call.reject("connectionId");
            return;
        }
        PreviewCommands.send(getContext(), "connect", new Intent().putExtra("connectionId", id).putExtra("package", pkg));
        call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        PreviewCommands.send(getContext(), "disconnect", new Intent().putExtra("connectionId", call.getString("connectionId", "")));
        call.resolve();
    }

    /** Something waits for this phone's previews to send (the app heard of it in its realtime channel). */
    @PluginMethod
    public void take(PluginCall call) {
        PreviewCommands.send(getContext(), "take", null);
        call.resolve();
    }

    /** Messages the person heard (on any of their devices): the app's own "read", once every one shown was heard. */
    @PluginMethod
    public void markRead(PluginCall call) {
        JSArray ids = call.getArray("externalIds", new JSArray());
        String[] ext = new String[ids.length()];
        for (int i = 0; i < ids.length(); i++) ext[i] = ids.optString(i);
        PreviewCommands.send(getContext(), "read", new Intent().putExtra("connectionId", call.getString("connectionId", "")).putExtra("chatId", call.getString("chatId", "")).putExtra("externalIds", ext));
        call.resolve();
    }
}
