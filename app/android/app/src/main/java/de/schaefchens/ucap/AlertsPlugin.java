package de.schaefchens.ucap;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.unifiedpush.android.connector.UnifiedPush;

/**
 * Help requests on this phone (docs/plan.md, S5): the readiness checklist's facts (notifications, the alarm
 * channel, Do Not Disturb, the full-screen grant, battery exemptions, ntfy and the endpoint), setting up UnifiedPush,
 * a local test alarm, the settings screens to fix what is missing, calling out without a server (A3b, "Notruf"), and
 * telling the app which request an alarm opened. The app hands over who this device is (setRef) for native code.
 */
@CapacitorPlugin(
    name = "Alerts",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "phone", strings = { Manifest.permission.CALL_PHONE }),
    })
public class AlertsPlugin extends Plugin {
    static final String NTFY = "io.heckel.ntfy";
    private static AlertsPlugin instance;
    private JSObject opened;

    @Override
    public void load() {
        instance = this;
        Intent i = getActivity().getIntent();
        if (i != null) opened = openedBy(i);
    }

    private static JSObject openedBy(Intent i) {
        String rid = i.getStringExtra(CareAlarm.EXTRA_RID);
        if (rid == null) return null;
        JSObject o = new JSObject().put("rid", rid);
        String after = i.getStringExtra(CareAlarm.EXTRA_AFTER);
        if (after != null) o.put("after", after);
        return o;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject o = openedBy(intent);
        if (o == null) return;
        opened = o;
        notifyListeners("opened", o);
    }

    /** From native code anywhere: an answer from the alarm reached the server (or did not). */
    static void emitAction(String rid, String action, String result) {
        AlertsPlugin p = instance;
        if (p != null) p.notifyListeners("action", new JSObject().put("rid", rid).put("action", action).put("result", result));
    }

    /** The push setup changed (endpoint, error): the checklist reads status() again. */
    static void emitPush() {
        AlertsPlugin p = instance;
        if (p != null) p.notifyListeners("push", new JSObject());
    }

    private boolean installed(String pkg) {
        try {
            getContext().getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    @PluginMethod
    public void setRef(PluginCall call) {
        Context ctx = getContext();
        String url = call.getString("serverUrl"), srv = call.getString("serverId"), did = call.getString("deviceId");
        if (url == null || srv == null || did == null) {
            // Signed out or revoked: nothing may ring for this account any more.
            Ref.clear(ctx);
            Outbox.clear(ctx);
            ctx.getSystemService(NotificationManager.class).cancelAll();
            call.resolve();
            return;
        }
        Ref.save(ctx, url, srv, did, call.getString("lang", "de"), call.getString("form", "du"));
        CareAlarm.ensureChannels(ctx);
        new Thread(() -> {
            Endpoints.register(ctx);
            Outbox.drain(ctx);
        }, "ucap-ref").start();
        call.resolve();
    }

    /**
     * Who this device is, as native code keeps it: when the WebView's storage is lost, the Keystore key and this
     * survive, and the app signs in again with them (AN-06). Empty when the device is not set up.
     */
    @PluginMethod
    public void getRef(PluginCall call) {
        Context ctx = getContext();
        Ref r = Ref.load(ctx);
        JSObject o = new JSObject();
        if (r != null) {
            o.put("serverUrl", r.serverUrl);
            o.put("serverId", r.serverId);
            o.put("deviceId", r.deviceId);
            o.put("lang", r.lang);
            o.put("form", Ref.form(ctx));
        }
        call.resolve(o);
    }

    @PluginMethod
    public void status(PluginCall call) {
        Context ctx = getContext();
        CareAlarm.ensureChannels(ctx);
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        PowerManager pm = ctx.getSystemService(PowerManager.class);
        JSObject r = new JSObject();
        Map<String, Object> state = new LinkedHashMap<>();
        boolean silenced = PushHandler.readState(ctx, state);
        r.put("silenced", silenced);
        r.put("notifications", nm.areNotificationsEnabled());
        r.put("permission", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = nm.getNotificationChannel(CareAlarm.CHANNEL);
            if (ch != null) {
                r.put("channelImportance", ch.getImportance());
                r.put("channelBypassDnd", ch.canBypassDnd());
                r.put("channelSound", ch.getSound() != null);
            }
        }
        r.put("dnd", state.get("dnd"));
        r.put("alarmVolume", state.get("volume"));
        r.put("fullScreen", CareAlarm.canFullScreen(ctx));
        r.put("batteryExempt", pm.isIgnoringBatteryOptimizations(ctx.getPackageName()));
        r.put("ntfyInstalled", installed(NTFY));
        r.put("ntfyBatteryExempt", installed(NTFY) && pm.isIgnoringBatteryOptimizations(NTFY));
        r.put("callPhone", getPermissionState("phone") == PermissionState.GRANTED);
        List<String> ds = UnifiedPush.getDistributors(ctx);
        r.put("distributors", new JSArray(ds));
        r.put("distributor", UnifiedPush.getAckDistributor(ctx));
        android.content.SharedPreferences p = Endpoints.prefs(ctx);
        r.put("endpoint", p.getString("endpoint", null) != null);
        Ref ref = Ref.load(ctx);
        String reg = p.getString("registered", null);
        r.put("registered", ref != null && reg != null && reg.startsWith(ref.deviceId + " "));
        r.put("error", p.getString("error", null));
        r.put("errorServer", p.getString("errorServer", null));
        r.put("dropped", p.getInt("dropped", 0));
        r.put("waiting", Outbox.size(ctx));
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            CareAlarm.ensureChannels(getContext());
            call.resolve(new JSObject().put("granted", getContext().getSystemService(NotificationManager.class).areNotificationsEnabled()));
        } else {
            requestPermissionForAlias("notifications", call, "notificationsResult");
        }
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        boolean granted = getPermissionState("notifications") == PermissionState.GRANTED;
        if (granted) CareAlarm.ensureChannels(getContext());
        call.resolve(new JSObject().put("granted", granted));
    }

    /** UnifiedPush with ntfy as the distributor; the endpoint arrives in UpService and is registered from there. */
    @PluginMethod
    public void registerPush(PluginCall call) {
        Context ctx = getContext();
        List<String> ds = UnifiedPush.getDistributors(ctx);
        if (!ds.contains(NTFY)) {
            call.reject("ntfy is not installed", "no_distributor");
            return;
        }
        Endpoints.prefs(ctx).edit().remove("error").remove("errorServer").apply();
        UnifiedPush.saveDistributor(ctx, NTFY);
        // No VAPID key: the server publishes to its own ntfy with a token, and ntfy does not check VAPID.
        UnifiedPush.register(ctx, UpService.INSTANCE, null, null);
        call.resolve(new JSObject().put("distributor", NTFY));
    }

    @PluginMethod
    public void unregisterPush(PluginCall call) {
        UnifiedPush.unregister(getContext(), UpService.INSTANCE);
        call.resolve();
    }

    /** The same alarm a request rings, without the server: sound, Do Not Disturb, full screen. */
    @PluginMethod
    public void testLocal(PluginCall call) {
        CareAlarm.test(getContext(), "test-local");
        call.resolve();
    }

    /** Which request an alarm opened the app for, once (a cold start from the alarm). */
    @PluginMethod
    public void takeOpened(PluginCall call) {
        JSObject r = opened != null ? opened : new JSObject();
        opened = null;
        call.resolve(r);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String what = call.getString("what", "app");
        String pkg = getContext().getPackageName();
        Intent i;
        switch (what) {
            case "channel":
                i = Build.VERSION.SDK_INT >= 26 ? new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg).putExtra(Settings.EXTRA_CHANNEL_ID, CareAlarm.CHANNEL) : null;
                break;
            case "fullscreen":
                i = Build.VERSION.SDK_INT >= 34 ? new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + pkg)) : null;
                break;
            case "dnd":
                // Do Not Disturb's own settings, where the helper decides what may break through.
                i = new Intent(Build.VERSION.SDK_INT >= 26 ? Settings.ACTION_ZEN_MODE_PRIORITY_SETTINGS : Settings.ACTION_SOUND_SETTINGS);
                break;
            case "battery":
                i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                break;
            case "ntfy":
                i = getContext().getPackageManager().getLaunchIntentForPackage(NTFY);
                break;
            case "app":
            default:
                i = Build.VERSION.SDK_INT >= 26 ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg) : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
        }
        if (i == null) {
            call.reject("not on this Android version", "unsupported");
            return;
        }
        getActivity().startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    /** Asked when the person chooses direct calls for the phone fallback, so the call itself is never held up. */
    @PluginMethod
    public void requestCallPermission(PluginCall call) {
        if (getPermissionState("phone") == PermissionState.GRANTED) call.resolve(new JSObject().put("granted", true));
        else requestPermissionForAlias("phone", call, "callPermissionResult");
    }

    @PermissionCallback
    private void callPermissionResult(PluginCall call) {
        call.resolve(new JSObject().put("granted", getPermissionState("phone") == PermissionState.GRANTED));
    }

    /** Calls without a server: directly where the person allowed it once (CALL_PHONE), else the dialler, filled in. */
    @PluginMethod
    public void call(PluginCall call) {
        boolean direct = Boolean.TRUE.equals(call.getBoolean("direct", false));
        // An emergency number goes to the dialler at once: no permission question may stand in its way.
        if (direct && !emergency(call.getString("number", "")) && getPermissionState("phone") != PermissionState.GRANTED) {
            requestPermissionForAlias("phone", call, "phoneResult");
            return;
        }
        dial(call, direct);
    }

    /** Short numbers (112, 110, 911, 999 …): Android places those calls itself, from the dialler. */
    private static boolean emergency(String number) {
        return number.replaceAll("[^0-9]", "").length() <= 3;
    }

    @PermissionCallback
    private void phoneResult(PluginCall call) {
        dial(call, getPermissionState("phone") == PermissionState.GRANTED);
    }

    private void dial(PluginCall call, boolean direct) {
        String number = call.getString("number", "");
        if (!number.matches("^\\+?[0-9]{2,15}$")) {
            call.reject("not a phone number", "bad_number");
            return;
        }
        boolean now = direct && !emergency(number) && getPermissionState("phone") == PermissionState.GRANTED;
        Intent i = new Intent(now ? Intent.ACTION_CALL : Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number)));
        try {
            getActivity().startActivity(i);
            call.resolve(new JSObject().put("direct", now));
        } catch (Exception e) {
            call.reject("no app can call", "no_dialer");
        }
    }
}
