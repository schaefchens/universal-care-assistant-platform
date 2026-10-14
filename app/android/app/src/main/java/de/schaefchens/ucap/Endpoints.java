package de.schaefchens.ucap;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * This device's UnifiedPush endpoint and its registration with the server (PUT …/push-endpoints/unifiedpush, signed).
 * The distributor may hand out a new endpoint at any time, also while the app is closed, so native code registers it.
 * The server keeps only endpoints on its own ntfy; when the ntfy app points elsewhere (it starts with ntfy.sh), the
 * refusal names that server, and the readiness checklist tells the helper what to change.
 */
final class Endpoints {
    static final String PREFS = "ucap.push";
    private static final String PATH = "/api/v1/devices/current/push-endpoints/unifiedpush";

    private Endpoints() {}

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** A new endpoint from the distributor (off the main thread). */
    static void received(Context ctx, String url, String p256dh, String auth) {
        prefs(ctx).edit().putString("endpoint", url).putString("p256dh", p256dh).putString("auth", auth).remove("registered").remove("error").remove("errorServer").apply();
        register(ctx);
    }

    /** Registers the stored endpoint for the current account; again after a new sign-in (Alerts.setRef). */
    static void register(Context ctx) {
        SharedPreferences p = prefs(ctx);
        String url = p.getString("endpoint", null);
        Ref ref = Ref.load(ctx);
        if (url == null || ref == null) return;
        if ((ref.deviceId + " " + url).equals(p.getString("registered", null))) return;
        Map<String, Object> keys = new LinkedHashMap<>();
        keys.put("p256dh", p.getString("p256dh", ""));
        keys.put("auth", p.getString("auth", ""));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("endpoint", url);
        body.put("keys", keys);
        String idem = Api.idem();
        Api.Result r = Api.signed(ctx, "PUT", PATH, body, idem, 10_000);
        if (r.retry()) {
            JSONObject e = Outbox.entry("endpoint", "PUT", PATH, SignedRequest.jcs(body), idem);
            try {
                e.put("endpoint", url);
            } catch (JSONException ignored) {
                // A put with a string key and a string value does not fail.
            }
            Outbox.add(ctx, e);
            return;
        }
        outcome(ctx, url, r);
    }

    static void outcome(Context ctx, String url, Api.Result r) {
        Ref ref = Ref.load(ctx);
        SharedPreferences.Editor e = prefs(ctx).edit();
        if (r.ok() && ref != null) e.putString("registered", ref.deviceId + " " + url).remove("error").remove("errorServer");
        else if (r.status == 400 && "push_server".equals(r.params().optString("reason"))) e.putString("error", "push_server").putString("errorServer", r.params().optString("server"));
        else if (r.status == 503) e.putString("error", "unifiedpush_off");
        else e.putString("error", "refused_" + r.status);
        e.apply();
        AlertsPlugin.emitPush();
    }

    /** The distributor dropped this app's registration: the server forgets the endpoint too. */
    static void forget(Context ctx) {
        prefs(ctx).edit().remove("endpoint").remove("p256dh").remove("auth").remove("registered").apply();
        String idem = Api.idem();
        Api.Result r = Api.signed(ctx, "DELETE", PATH, null, idem, 10_000);
        if (r.retry()) Outbox.add(ctx, Outbox.entry("unregister", "DELETE", PATH, null, idem));
        AlertsPlugin.emitPush();
    }
}
