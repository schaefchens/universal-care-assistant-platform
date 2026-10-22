package de.schaefchens.ucap;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What the phone reports about its SMS connection (packages/shared DeviceEvent; server/src/messaging/device.ts checks
 * each): conversations, the people in them, messages, the results of sends, delivery reports and the connection's
 * state. Pure Java over org.json, so it is unit-tested on the JVM (SmsEventsTest).
 *
 * - A conversation is Android's thread: its id is the thread's.
 * - An SMS and an MMS share a thread but not an id sequence, so their ids are "s12" and "m3"; the server orders them by
 *   time.
 * - A person is their number in E.164 where it can be made one, else as it came ("DHL").
 */
final class SmsEvents {
    private SmsEvents() {}

    static String smsId(long id) {
        return "s" + id;
    }

    static String mmsId(long id) {
        return "m" + id;
    }

    /** The store's id behind an external id ("s12" → 12), or -1 for one that is not an SMS's. */
    static long smsOf(String externalId) {
        if (externalId == null || !externalId.matches("^s\\d{1,18}$")) return -1;
        return Long.parseLong(externalId.substring(1));
    }

    static JSONObject chat(String threadId, String title, boolean group, String peerId) {
        try {
            JSONObject c = new JSONObject()
                .put("externalId", threadId)
                .put("title", title)
                .put("kind", group ? "group" : "private")
                .put("userId", group || peerId == null ? JSONObject.NULL : peerId)
                .put("muted", false)
                .put("unread", 0)
                .put("readInboxMaxId", JSONObject.NULL)
                .put("readOutboxMaxId", JSONObject.NULL);
            return new JSONObject().put("t", "chat.upsert").put("chat", c);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static JSONObject user(String id, String name, boolean contact) {
        try {
            JSONObject u = new JSONObject().put("externalId", id).put("name", name).put("isContact", contact).put("isBot", false);
            return new JSONObject().put("t", "user.upsert").put("user", u);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * A message: `live` when it just arrived (not fetched from the store's history), so the server announces it.
     * `kind` is "text", or "photo" for an MMS with a picture (named, never sent on: no vision model until M5).
     */
    static JSONObject message(String threadId, String externalId, String fromId, boolean outgoing, long dateMs, String kind, String text, boolean live) {
        try {
            JSONObject m = new JSONObject()
                .put("chatId", threadId)
                .put("externalId", externalId)
                .put("fromId", outgoing || fromId == null ? JSONObject.NULL : fromId)
                .put("outgoing", outgoing)
                .put("date", Math.max(0, dateMs / 1000))
                .put("editDate", JSONObject.NULL)
                .put("kind", kind)
                .put("text", text == null ? "" : text)
                .put("file", JSONObject.NULL)
                .put("fileName", JSONObject.NULL);
            JSONObject e = new JSONObject().put("t", "msg.upsert").put("msg", m);
            if (live) e.put("live", true);
            return e;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** A send's fate: handed to the network (pending_service), sent (the network's report), or failed. */
    static JSONObject result(String requestId, String state, String externalId, String error) {
        try {
            JSONObject e = new JSONObject().put("t", "send.result").put("requestId", requestId).put("state", state);
            if (externalId != null) e.put("externalId", externalId);
            if (error != null) e.put("error", error);
            return e;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static JSONObject delivered(String threadId, String externalId) {
        try {
            return new JSONObject().put("t", "msg.delivered").put("chatId", threadId).put("externalIds", new JSONArray().put(externalId));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** "ready" while UCAP is the SMS app, "off" once the role went back (the error says why). */
    static JSONObject state(String state, String error) {
        try {
            JSONObject e = new JSONObject().put("t", "conn.state").put("state", state);
            if (error != null) e.put("error", error);
            return e;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * Why the network refused an SMS (SmsManager's result codes), as a short word for the server: never the number or
     * the text.
     */
    static String errorOf(int resultCode) {
        switch (resultCode) {
            case 1: return "sms_failed";      // RESULT_ERROR_GENERIC_FAILURE
            case 2: return "sms_radio_off";   // RESULT_ERROR_RADIO_OFF
            case 3: return "sms_null_pdu";    // RESULT_ERROR_NULL_PDU
            case 4: return "sms_no_service";  // RESULT_ERROR_NO_SERVICE
            case 5: return "sms_limit";       // RESULT_ERROR_LIMIT_EXCEEDED
            default: return "sms_" + Math.max(0, Math.min(resultCode, 999));
        }
    }

    /** A delivery report's status (TP-Status, 3GPP 23.040): 0–31 is a completed delivery, 64 and above failed. */
    static boolean deliveredStatus(int status) {
        return status >= 0 && status < 32;
    }

    /** One batch for the server: the events of a connection, as the signed body takes it (SignedRequest.jcs). */
    static Map<String, Object> batch(String connectionId, JSONArray events) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("connectionId", connectionId);
        b.put("events", plain(events));
        return b;
    }

    /** org.json's values as the canonical JSON writer takes them: maps, lists, strings, integers, booleans, null. */
    static Object plain(Object v) {
        if (v == null || v == JSONObject.NULL) return null;
        if (v instanceof JSONObject) {
            JSONObject o = (JSONObject) v;
            Map<String, Object> m = new LinkedHashMap<>();
            for (Iterator<String> k = o.keys(); k.hasNext(); ) {
                String key = k.next();
                m.put(key, plain(o.opt(key)));
            }
            return m;
        }
        if (v instanceof JSONArray) {
            JSONArray a = (JSONArray) v;
            List<Object> l = new ArrayList<>();
            for (int i = 0; i < a.length(); i++) l.add(plain(a.opt(i)));
            return l;
        }
        return v;
    }
}
