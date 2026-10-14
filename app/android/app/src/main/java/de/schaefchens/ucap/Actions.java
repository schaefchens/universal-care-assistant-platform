package de.schaefchens.ucap;

import android.content.Context;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The alarm's answers, "Annehmen" and "Kann nicht", sent by native code with the device's signature
 * (POST /api/v1/push/actions). The alarm says "Wird übermittelt…" until the server answered; offline, the answer
 * waits in the outbox and the alarm keeps saying so. Never "accepted" before the server says so (I1).
 */
final class Actions {
    private Actions() {}

    /** Off the main thread. */
    static void send(Context ctx, String rid, int ep, String action, String who) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("rid", rid);
        body.put("ep", ep);
        body.put("action", action);
        String idem = Api.idem();
        Api.Result r = Api.signed(ctx, "POST", "/api/v1/push/actions", body, idem, 8000);
        if (r.retry()) {
            JSONObject e = Outbox.entry("action", "POST", "/api/v1/push/actions", SignedRequest.jcs(body), idem);
            try {
                e.put("rid", rid).put("action", action).put("who", who);
            } catch (JSONException ignored) {
                // A put with a string key and a string value does not fail.
            }
            Outbox.add(ctx, e);
            return;
        }
        outcome(ctx, rid, action, who, r);
    }

    /** The server's answer, now or after a retry; null when the answer expired unsent. */
    static void outcome(Context ctx, String rid, String action, String who, Api.Result r) {
        if (r != null && r.ok()) {
            if ("accept".equals(action)) CareAlarm.accepted(ctx, rid, who);
            else CareAlarm.close(ctx, rid);
            AlertsPlugin.emitAction(rid, action, "ok");
            return;
        }
        String by = r != null && r.status == 409 ? r.params().optString("acceptedBy", "") : "";
        CareAlarm.info(ctx, rid, by.isEmpty() ? Texts.get(ctx, "ended") : Texts.format(ctx, "already", by));
        AlertsPlugin.emitAction(rid, action, r == null ? "expired" : "refused");
    }
}
