package de.schaefchens.ucap;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * A decrypted push from the server (server/src/domain/care/push.ts): {v, t, dlv, n, at, ttl} and, for care, {rid, ep,
 * who, dev, u, st, by}; a wake names only what waits ({w: "sms"}: a reply for the SMS app to send). Anything else is not UCAP's and is dropped before anything rings. `late`: ntfy keeps messages
 * for hours, so a phone that was off may get an alarm long after it was sent; that one is shown, never rung.
 *
 * Pure Java over org.json, so it is unit-tested on the JVM (PushPayloadTest).
 */
final class PushPayload {
    static final Set<String> TYPES = new HashSet<>(Arrays.asList("care.alert", "care.update", "care.cancel", "care.watchdog", "hb", "test", "reminder.due", "reminder.followup", "wake"));
    private static final Pattern ID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    /** Grace for clocks that differ a little between server and phone. */
    static final long SKEW_S = 60;

    final String type;
    final String dlv;
    final String nonce;
    final String rid;
    final int ep;
    final String who;
    final String dev;
    final boolean unconfirmed;
    final String status;
    final String by;
    final long at;
    final int ttl;
    final boolean late;
    /** Reminders: the occurrence, the prompt's number, its words. */
    final String oid;
    final int prompt;
    final String title;
    final String text;
    final String category;
    /** A wake: what waits on the device ("sms"). */
    final String what;

    private PushPayload(JSONObject o, String type, long nowS) {
        this.type = type;
        dlv = o.optString("dlv");
        nonce = o.optString("n");
        rid = str(o, "rid", 36);
        ep = o.optInt("ep", 0);
        who = str(o, "who", 80);
        dev = str(o, "dev", 80);
        unconfirmed = o.optInt("u", 0) == 1;
        status = str(o, "st", 20);
        by = str(o, "by", 80);
        at = o.optLong("at", 0);
        ttl = o.optInt("ttl", 900);
        late = at > 0 && nowS - at > ttl + SKEW_S;
        oid = str(o, "oid", 36);
        prompt = o.optInt("p", 0);
        title = str(o, "title", 80);
        text = str(o, "prompt", 240);
        category = str(o, "cat", 20);
        what = str(o, "w", 20);
    }

    private static String str(JSONObject o, String key, int max) {
        if (!o.has(key) || o.isNull(key)) return "";
        String s = o.optString(key, "").trim();
        return s.length() > max ? s.substring(0, max) : s;
    }

    /** The payload, or null when it is not a valid UCAP push. */
    static PushPayload parse(String json, long nowS) {
        try {
            JSONObject o = new JSONObject(json);
            if (o.optInt("v", 0) != 1) return null;
            String t = o.optString("t", "");
            if (!TYPES.contains(t)) return null;
            PushPayload p = new PushPayload(o, t, nowS);
            if (!ID.matcher(p.dlv).matches() || p.nonce.length() < 10 || p.nonce.length() > 40) return null;
            if (p.care() && (!ID.matcher(p.rid).matches() || p.ep < 1)) return null;
            if (p.type.startsWith("reminder.") && !ID.matcher(p.oid).matches()) return null;
            return p;
        } catch (Exception e) {
            return null;
        }
    }

    boolean care() {
        return type.startsWith("care.");
    }

    /** Whether this push is meant to sound: an alert, a test or a reminder's question, none of them late. */
    boolean rings() {
        return ("care.alert".equals(type) || "test".equals(type) || "reminder.due".equals(type)) && !late;
    }
}
