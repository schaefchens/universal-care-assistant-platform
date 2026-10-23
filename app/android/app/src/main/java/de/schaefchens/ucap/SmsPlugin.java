package de.schaefchens.ucap;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.provider.Telephony;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * UCAP as the SMS app (docs/plan-m3.md, K4), for the app's page: whether UCAP holds Android's SMS role and which app
 * does otherwise, Android's dialog to take it, the Default apps page to give it back, and the SMS process told to
 * report to the person's connection, take what waits for this phone, or mark SMS read. The SMS work itself runs in the
 * SMS process (SmsCommands); this plugin only asks it.
 */
@CapacitorPlugin(name = "Sms")
public class SmsPlugin extends Plugin {
    private Intent launch;

    @Override
    public void load() {
        launch = getActivity().getIntent();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject o = opened(intent);
        if (o != null) notifyListeners("opened", o);
    }

    /** What a notification or another app asked of UCAP as it opened: a conversation to read, or an SMS to write. */
    private static JSObject opened(Intent i) {
        if (i == null) return null;
        if (i.hasExtra(SmsNotify.EXTRA_THREAD)) return new JSObject().put("thread", String.valueOf(i.getLongExtra(SmsNotify.EXTRA_THREAD, -1)));
        String to = i.getStringExtra(SmsComposeActivity.EXTRA_TO);
        if (to != null) return new JSObject().put("compose", to).put("body", i.getStringExtra(SmsComposeActivity.EXTRA_TO + ".body"));
        return null;
    }

    /** What the app was opened for, once. */
    @PluginMethod
    public void launched(PluginCall call) {
        JSObject o = opened(launch);
        launch = null;
        call.resolve(o != null ? o : new JSObject());
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", SmsRole.available(getContext()));
        r.put("held", SmsRole.held(getContext()));
        r.put("other", SmsRole.otherApp(getContext()));
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    /** Android's own dialog: the person chooses UCAP (two choices, the current app is preselected). */
    @PluginMethod
    public void requestRole(PluginCall call) {
        if (SmsRole.held(getContext())) {
            call.resolve(new JSObject().put("held", true));
            return;
        }
        if (!SmsRole.available(getContext())) {
            call.resolve(new JSObject().put("held", false).put("reason", "unavailable"));
            return;
        }
        startActivityForResult(call, SmsRole.request(getContext()), "roleResult");
    }

    @ActivityCallback
    private void roleResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        call.resolve(new JSObject().put("held", SmsRole.held(getContext())));
    }

    /** Giving it back is Android's Default apps page (one tap there). */
    @PluginMethod
    public void openDefaultApps(PluginCall call) {
        getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    /** Reports to the person's SMS connection from now on (the server made it): 30 days of the store, then all that comes. */
    @PluginMethod
    public void connect(PluginCall call) {
        String id = call.getString("connectionId", "");
        if (!id.matches("^[0-9a-f-]{36}$")) {
            call.reject("connectionId");
            return;
        }
        Intent x = new Intent().putExtra("connectionId", id);
        SmsCommands.send(getContext(), "connect", x);
        call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        SmsCommands.send(getContext(), "disconnect", null);
        call.resolve();
    }

    /** Something waits for this phone to send (the app heard of it in its realtime channel). */
    @PluginMethod
    public void take(PluginCall call) {
        SmsCommands.send(getContext(), "take", null);
        call.resolve();
    }

    /**
     * Another app's "write an SMS" (`smsto:`): Android's thread for the number, found or made, and the events that tell
     * the server of it as the forwarding would (the person named from the address book). The app sends them, signed,
     * and gets the conversation to send into.
     */
    @PluginMethod
    public void compose(PluginCall call) {
        String to = call.getString("to", "").trim();
        if (to.isEmpty()) {
            call.reject("no number", "no_number");
            return;
        }
        Context ctx = getContext();
        if (!SmsRole.held(ctx)) {
            call.reject("not the SMS app", "not_sms_app");
            return;
        }
        new Thread(() -> {
            try {
                long thread = Telephony.Threads.getOrCreateThreadId(ctx, to);
                SmsStore.Person p = SmsStore.person(ctx, to, SmsStore.country(ctx));
                JSArray events = new JSArray();
                events.put(SmsEvents.user(p.id, p.name, p.contact));
                events.put(SmsEvents.chat(String.valueOf(thread), p.name, false, p.id));
                call.resolve(new JSObject().put("thread", String.valueOf(thread)).put("name", p.name).put("events", events));
            } catch (Exception e) {
                call.reject("not made: " + e.getClass().getSimpleName(), "failed");
            }
        }, "ucap-sms-compose").start();
    }

    /** SMS the person heard (on any of their devices): read in the store, as in any SMS app. */
    @PluginMethod
    public void markRead(PluginCall call) {
        JSArray ids = call.getArray("externalIds", new JSArray());
        String[] ext = new String[ids.length()];
        for (int i = 0; i < ids.length(); i++) ext[i] = ids.optString(i);
        Intent x = new Intent().putExtra("connectionId", call.getString("connectionId", "")).putExtra("externalIds", ext);
        SmsCommands.send(getContext(), "read", x);
        call.resolve();
    }
}
