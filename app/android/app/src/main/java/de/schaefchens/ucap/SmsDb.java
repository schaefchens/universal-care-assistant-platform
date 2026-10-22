package de.schaefchens.ucap;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;

/**
 * The SMS connection's own small database, used in the SMS process only (docs/plan-m3.md, K4):
 * - `state`: which connection it reports to, and how far Android's SMS store has been forwarded;
 * - `outq`: what waits for the server, in order (results of sends, delivery reports, states, a sent message);
 * - `sends`: the parts of each SMS in flight, until the network reported on all of them.
 * The messages themselves stay in Android's store, where they belong to the person.
 */
final class SmsDb extends SQLiteOpenHelper {
    private static SmsDb instance;

    static synchronized SmsDb get(Context ctx) {
        if (instance == null) instance = new SmsDb(ctx.getApplicationContext());
        return instance;
    }

    private SmsDb(Context ctx) {
        super(ctx, "ucap-sms.db", null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("create table state (k text primary key, v text)");
        db.execSQL("create table outq (id integer primary key autoincrement, events text not null, idem text not null, created integer not null)");
        db.execSQL("create table sends (sms_id integer primary key, request_id text, thread text not null, parts integer not null, sent integer not null default 0, "
            + "failed integer not null default 0, error text, delivered integer not null default 0, created integer not null)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int from, int to) {}

    String state(String k) {
        try (Cursor c = getReadableDatabase().rawQuery("select v from state where k = ?", new String[] {k})) {
            return c.moveToFirst() ? c.getString(0) : null;
        }
    }

    long stateLong(String k, long fallback) {
        String v = state(k);
        try {
            return v == null ? fallback : Long.parseLong(v);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    void setState(String k, String v) {
        if (v == null) {
            getWritableDatabase().delete("state", "k = ?", new String[] {k});
            return;
        }
        ContentValues cv = new ContentValues();
        cv.put("k", k);
        cv.put("v", v);
        getWritableDatabase().insertWithOnConflict("state", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    /** Everything of the connection gone (the person disconnected SMS): nothing more is reported. */
    void clear() {
        SQLiteDatabase db = getWritableDatabase();
        db.delete("state", null, null);
        db.delete("outq", null, null);
        db.delete("sends", null, null);
    }

    // —— What waits for the server ——

    void queue(JSONArray events) {
        if (events.length() == 0) return;
        ContentValues cv = new ContentValues();
        cv.put("events", events.toString());
        cv.put("idem", Api.idem());
        cv.put("created", System.currentTimeMillis());
        getWritableDatabase().insert("outq", null, cv);
    }

    static final class Entry {
        final long id;
        final String events;
        final String idem;

        Entry(long id, String events, String idem) {
            this.id = id;
            this.events = events;
            this.idem = idem;
        }
    }

    Entry first() {
        try (Cursor c = getReadableDatabase().rawQuery("select id, events, idem from outq order by id limit 1", null)) {
            return c.moveToFirst() ? new Entry(c.getLong(0), c.getString(1), c.getString(2)) : null;
        }
    }

    void done(long id) {
        getWritableDatabase().delete("outq", "id = ?", new String[] {String.valueOf(id)});
    }

    int waiting() {
        try (Cursor c = getReadableDatabase().rawQuery("select count(*) from outq", null)) {
            return c.moveToFirst() ? c.getInt(0) : 0;
        }
    }

    // —— Sends in flight ——

    void addSend(long smsId, String requestId, String thread, int parts) {
        ContentValues cv = new ContentValues();
        cv.put("sms_id", smsId);
        cv.put("request_id", requestId);
        cv.put("thread", thread);
        cv.put("parts", parts);
        cv.put("created", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict("sends", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    static final class Send {
        final long smsId;
        final String requestId;
        final String thread;
        final int parts;
        final int sent;
        final int failed;
        final String error;
        final int delivered;

        Send(Cursor c) {
            smsId = c.getLong(0);
            requestId = c.isNull(1) ? null : c.getString(1);
            thread = c.getString(2);
            parts = c.getInt(3);
            sent = c.getInt(4);
            failed = c.getInt(5);
            error = c.isNull(6) ? null : c.getString(6);
            delivered = c.getInt(7);
        }

        boolean reported() {
            return sent + failed >= parts;
        }
    }

    Send send(long smsId) {
        try (Cursor c = getReadableDatabase().rawQuery("select sms_id, request_id, thread, parts, sent, failed, error, delivered from sends where sms_id = ?", new String[] {String.valueOf(smsId)})) {
            return c.moveToFirst() ? new Send(c) : null;
        }
    }

    /** One part's sent report; the send as it is after it. */
    Send sentPart(long smsId, boolean ok, String error) {
        SQLiteDatabase db = getWritableDatabase();
        if (ok) db.execSQL("update sends set sent = sent + 1 where sms_id = ?", new Object[] {smsId});
        else db.execSQL("update sends set failed = failed + 1, error = coalesce(error, ?) where sms_id = ?", new Object[] {error, smsId});
        return send(smsId);
    }

    /** One part's delivery report; the send as it is after it. */
    Send deliveredPart(long smsId) {
        getWritableDatabase().execSQL("update sends set delivered = delivered + 1 where sms_id = ?", new Object[] {smsId});
        return send(smsId);
    }

    void dropSend(long smsId) {
        getWritableDatabase().delete("sends", "sms_id = ?", new String[] {String.valueOf(smsId)});
    }

    /** Sends whose reports never all came (a week): forgotten, the server has long called them uncertain. */
    void forgetOldSends() {
        getWritableDatabase().delete("sends", "created < ?", new String[] {String.valueOf(System.currentTimeMillis() - 7 * 86_400_000L)});
    }
}
