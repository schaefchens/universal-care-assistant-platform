package de.schaefchens.ucap;

import android.content.Context;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The phone's SMS connection, reported to the server (docs/plan-m3.md, K4), signed with the device's key so it works
 * with the app closed. In the SMS process only.
 * - First what waits in SmsDb's queue (results of sends, delivery reports, states), in order.
 * - Then what is new in Android's store, in the order of its ids: the store itself is the queue, and a position in it
 *   says how far it was forwarded. At connecting, the position is set 30 days back: that history is no news (the
 *   server reads it as read), what comes after it is.
 * - The role gone (given back to Google Messages): "off", once; taken again: "ready".
 * A failure leaves everything where it was, for SmsJob to try again; a batch the server refuses is skipped, so one bad
 * message never holds back the rest. Nothing is logged but counts and classes.
 */
final class SmsSync {
    private SmsSync() {}

    static final String PATH = "/api/v1/messaging/device/events";
    static final long HISTORY_MS = 30L * 86_400_000L;
    private static final int BATCH = 50;
    private static final int TIMEOUT_MS = 15_000;
    private static final Object LOCK = new Object();

    /** The person connected SMS on the server (it made the connection): reported to from the last 30 days on. */
    static void connect(Context ctx, String connectionId) {
        synchronized (LOCK) {
            SmsDb db = SmsDb.get(ctx);
            if (!connectionId.equals(db.state("connection"))) {
                db.clear();
                db.setState("connection", connectionId);
                db.setState("cursor", String.valueOf(SmsStore.idBefore(ctx, System.currentTimeMillis() - HISTORY_MS)));
                // What is in the store now is history; what comes after it is news.
                db.setState("liveAfter", String.valueOf(SmsStore.maxId(ctx)));
            }
            db.setState("role", "held");
            db.queue(new JSONArray().put(SmsEvents.state("ready", null)));
        }
    }

    /** The person disconnected SMS: nothing more is reported. */
    static void disconnect(Context ctx) {
        synchronized (LOCK) {
            SmsDb.get(ctx).clear();
        }
    }

    static String connection(Context ctx) {
        return SmsDb.get(ctx).state("connection");
    }

    /** Reports what waits; true when something is left for a later try. */
    static boolean run(Context ctx) {
        synchronized (LOCK) {
            SmsDb db = SmsDb.get(ctx);
            String conn = db.state("connection");
            if (conn == null) return false;
            boolean held = SmsRole.held(ctx);
            String role = db.state("role");
            if (!held && !"gone".equals(role)) {
                db.setState("role", "gone");
                db.queue(new JSONArray().put(SmsEvents.state("off", "role")));
            } else if (held && "gone".equals(role)) {
                db.setState("role", "held");
                db.queue(new JSONArray().put(SmsEvents.state("ready", null)));
            }
            int left = drain(ctx, db, conn);
            if (left != 0) return left > 0;
            // Without the role the store may not be read (Android took the permission with it).
            if (!held) return false;
            try {
                return forward(ctx, db, conn);
            } catch (SecurityException e) {
                return false;
            }
        }
    }

    /** 0: all sent; 1: something left for later; -1: the connection is gone on the server. */
    private static int drain(Context ctx, SmsDb db, String conn) {
        while (true) {
            SmsDb.Entry e = db.first();
            if (e == null) return 0;
            JSONArray events;
            try {
                events = new JSONArray(e.events);
            } catch (Exception x) {
                db.done(e.id);
                continue;
            }
            Api.Result r = Api.signed(ctx, "POST", PATH, SmsEvents.batch(conn, events), e.idem, TIMEOUT_MS);
            if (r.retry()) return 1;
            if (r.status == -1) return 1; // signed out or the key is not there now: kept
            if (r.status == 404) {
                // The person disconnected SMS on the server (or another phone runs it): nothing more goes there.
                db.clear();
                return -1;
            }
            if (!r.ok()) android.util.Log.w("UCAP", "sms: a report was refused (" + r.status + ")");
            db.done(e.id);
        }
    }

    private static boolean forward(Context ctx, SmsDb db, String conn) {
        String country = SmsStore.country(ctx);
        Map<String, SmsStore.Person> people = new HashMap<>();
        Map<Long, List<String>> threads = new HashMap<>();
        while (true) {
            long cursor = db.stateLong("cursor", SmsStore.maxId(ctx));
            long liveAfter = db.stateLong("liveAfter", 0);
            List<SmsStore.Row> rows = SmsStore.after(ctx, cursor, BATCH);
            if (rows.isEmpty()) return false;
            JSONArray events = new JSONArray();
            Set<Long> chats = new HashSet<>();
            Set<String> users = new HashSet<>();
            for (SmsStore.Row r : rows) {
                // UCAP's own SMS on their way are reported by their sent report; what failed there is no message.
                if (r.type == SmsStore.OUTBOX || r.type == SmsStore.FAILED || r.type == 6 /* queued */) continue;
                for (JSONObject ev : describe(ctx, r, liveAfter, country, people, threads, chats, users)) events.put(ev);
            }
            if (events.length() > 0) {
                Api.Result res = Api.signed(ctx, "POST", PATH, SmsEvents.batch(conn, events), Api.idem(), TIMEOUT_MS);
                if (res.retry() || res.status == -1) return true;
                if (res.status == 404) {
                    db.clear();
                    return false;
                }
                if (!res.ok()) android.util.Log.w("UCAP", "sms: " + rows.size() + " messages refused (" + res.status + ")");
            }
            db.setState("cursor", String.valueOf(rows.get(rows.size() - 1).id));
        }
    }

    /** One SMS as events: its conversation and people once per batch, then the message. */
    static List<JSONObject> describe(Context ctx, SmsStore.Row r, long liveAfter, String country, Map<String, SmsStore.Person> people, Map<Long, List<String>> threads,
            Set<Long> chats, Set<String> users) {
        List<JSONObject> out = new java.util.ArrayList<>();
        String thread = String.valueOf(r.thread);
        if (chats.add(r.thread)) {
            List<String> rec = threads.get(r.thread);
            if (rec == null) {
                rec = SmsStore.recipients(ctx, r.thread);
                if (rec.isEmpty() && r.address != null && !r.address.isEmpty()) rec = java.util.Collections.singletonList(r.address);
                threads.put(r.thread, rec);
            }
            StringBuilder title = new StringBuilder();
            SmsStore.Person peer = null;
            for (String a : rec) {
                SmsStore.Person p = person(ctx, a, country, people);
                if (users.add(p.id)) out.add(SmsEvents.user(p.id, p.name, p.contact));
                if (title.length() > 0) title.append(", ");
                title.append(p.name);
                peer = p;
            }
            boolean group = rec.size() > 1;
            out.add(SmsEvents.chat(thread, title.length() > 0 ? title.toString() : thread, group, group || peer == null ? null : peer.id));
        }
        boolean outgoing = r.type != SmsStore.INBOX;
        SmsStore.Person from = outgoing ? null : person(ctx, r.address, country, people);
        if (from != null && users.add(from.id)) out.add(SmsEvents.user(from.id, from.name, from.contact));
        out.add(SmsEvents.message(thread, SmsEvents.smsId(r.id), from == null ? null : from.id, outgoing, r.date, "text", r.body, !outgoing && r.id > liveAfter));
        return out;
    }

    private static SmsStore.Person person(Context ctx, String address, String country, Map<String, SmsStore.Person> people) {
        SmsStore.Person p = people.get(address);
        if (p == null) {
            p = SmsStore.person(ctx, address, country);
            people.put(address, p);
        }
        return p;
    }
}
