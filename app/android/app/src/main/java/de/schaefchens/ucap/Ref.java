package de.schaefchens.ucap;

import android.content.Context;
import android.content.SharedPreferences;
import java.net.URL;

/**
 * Who this device is, for native code that talks to the server while the app is closed: push receipts, the alarm's
 * actions, UnifiedPush endpoints. The app sets it when a session starts (Alerts.setRef) and clears it on sign-out or
 * revocation, so nothing rings for an account that is gone. Ids and addresses only, never a token.
 */
final class Ref {
    static final String PREFS = "ucap";

    final String serverUrl;
    final String serverId;
    final String deviceId;
    final String lang;

    private Ref(String serverUrl, String serverId, String deviceId, String lang) {
        this.serverUrl = serverUrl;
        this.serverId = serverId;
        this.deviceId = deviceId;
        this.lang = lang;
    }

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static Ref load(Context ctx) {
        SharedPreferences p = prefs(ctx);
        String url = p.getString("serverUrl", null), srv = p.getString("serverId", null), did = p.getString("deviceId", null);
        if (url == null || srv == null || did == null) return null;
        return new Ref(url, srv, did, p.getString("lang", "de"));
    }

    static void save(Context ctx, String serverUrl, String serverId, String deviceId, String lang, String form) {
        prefs(ctx).edit().putString("serverUrl", serverUrl.replaceAll("/+$", "")).putString("serverId", serverId).putString("deviceId", deviceId).putString("lang", lang)
            .putString("form", form).apply();
    }

    static void clear(Context ctx) {
        prefs(ctx).edit().remove("serverUrl").remove("serverId").remove("deviceId").apply();
    }

    static String lang(Context ctx) {
        return prefs(ctx).getString("lang", "de");
    }

    /** "du" or "Sie": how the texts address the helper, as chosen in the app. */
    static String form(Context ctx) {
        return prefs(ctx).getString("form", "du");
    }

    /** The origin the device addressed, as a browser writes it: the statement names it (`org`). */
    String org() {
        try {
            URL u = new URL(serverUrl);
            int port = u.getPort();
            boolean usual = port == -1 || port == u.getDefaultPort();
            return u.getProtocol() + "://" + u.getHost() + (usual ? "" : ":" + port);
        } catch (Exception e) {
            return serverUrl;
        }
    }
}
