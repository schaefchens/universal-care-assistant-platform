package de.schaefchens.ucap;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Map;
import org.json.JSONArray;

/**
 * The person's reminders on this device (ReminderAlarms): the app hands over the next 48 hours, answers go out signed
 * from native code, and an alarm while the app is in front is handed to the app, which asks with its own voice.
 */
@CapacitorPlugin(name = "Reminders")
public class RemindersPlugin extends Plugin {
    private static RemindersPlugin instance;
    private String opened;
    private boolean inFront;

    @Override
    public void load() {
        instance = this;
        Intent i = getActivity().getIntent();
        if (i != null) opened = i.getStringExtra(ReminderAlarms.EXTRA_OCCURRENCE);
    }

    @Override
    protected void handleOnResume() {
        inFront = true;
    }

    @Override
    protected void handleOnPause() {
        inFront = false;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        String oid = intent.getStringExtra(ReminderAlarms.EXTRA_OCCURRENCE);
        if (oid == null) return;
        opened = oid;
        notifyListeners("opened", new JSObject().put("occurrenceId", oid));
    }

    /** True when the app is in front and took the prompt. */
    static boolean emitDue(String oid) {
        RemindersPlugin p = instance;
        if (p == null || !p.inFront || !p.hasListeners("due")) return false;
        p.notifyListeners("due", new JSObject().put("occurrenceId", oid));
        return true;
    }

    @PluginMethod
    public void schedule(PluginCall call) {
        JSONArray items = call.getArray("items", new com.getcapacitor.JSArray());
        int count = ReminderAlarms.schedule(getContext(), items);
        call.resolve(new JSObject().put("count", count).put("exact", ReminderAlarms.exactAllowed(getContext())));
    }

    @PluginMethod
    public void respond(PluginCall call) {
        String oid = call.getString("occurrenceId"), kind = call.getString("kind"), id = call.getString("clientResponseId");
        if (oid == null || kind == null || id == null) {
            call.reject("missing fields", "bad_request");
            return;
        }
        new Thread(() -> {
            Map<String, String> r = ReminderAlarms.respond(getContext(), oid, kind, id);
            JSObject o = new JSObject();
            for (Map.Entry<String, String> e : r.entrySet()) o.put(e.getKey(), e.getValue());
            call.resolve(o);
        }, "ucap-reminder").start();
    }

    @PluginMethod
    public void takeOpened(PluginCall call) {
        JSObject r = new JSObject();
        if (opened != null) r.put("occurrenceId", opened);
        opened = null;
        call.resolve(r);
    }

    @PluginMethod
    public void exactAllowed(PluginCall call) {
        call.resolve(new JSObject().put("exact", ReminderAlarms.exactAllowed(getContext())));
    }

    @PluginMethod
    public void openExactSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < 31) {
            call.resolve();
            return;
        }
        getActivity().startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getContext().getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }
}
