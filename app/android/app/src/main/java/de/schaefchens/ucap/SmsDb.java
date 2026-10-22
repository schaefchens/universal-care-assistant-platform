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
 * - `sends`: the parts of each SMS in flight, until the network reported on all of them;
 * - `mms`: MMS a carrier announced, until they were fetched from its MMS centre (or expired); one fetched is kept until
 *   it expires there, so the same MMS announced again is not stored twice.
 * The messages themselves stay in Android's store, where they belong to the person.
 */
final class SmsDb extends SQLiteOpenHelper {
    private static SmsDb instance;

    static synchronized SmsDb get(Context ctx) {
        if (instance == null) instance = new SmsDb(ctx.getApplicationContext());
        return instance;
    }

    private SmsDb(Context ctx) {
        super(ctx, "ucap-sms.db", null, 3);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("create table state (k text primary key, v text)");
        db.execSQL("create table outq (id integer primary key autoincrement, events text not null, idem text not null, created integer not null)");
        db.execSQL("create table sends (sms_id integer primary key, request_id text, thread text not null, parts integer not null, sent integer not null default 0, "
            + "failed integer not null default 0, error text, delivered integer not null default 0, created integer not null)");
        mmsTable(db);
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int from, int to) {
        if (from < 2) mmsTable(db);
        else if (from < 3) db.execSQL("alter table mms add column fetched integer not null default 0");
    }

    private static void mmsTable(SQLiteDatabase db) {
        db.execSQL("create table mms (tx text primary key, location text not null, sender text, expiry integer not null, sub integer not null, tries integer not null default 0, "
            + "next_at integer not null, told integer not null default 0, created integer not null, fetched integer not null default 0)");
    }

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

    // —— MMS waiting to be fetched ——

    static final class Mms {
        final String tx;
        final String location;
        final String sender;
        final long expiry;
        final int sub;
        final int tries;
        final boolean told;
        final boolean fetched;

        Mms(Cursor c) {
            tx = c.getString(0);
            location = c.getString(1);
            sender = c.isNull(2) ? null : c.getString(2);
            expiry = c.getLong(3);
            sub = c.getInt(4);
            tries = c.getInt(5);
            told = c.getInt(6) != 0;
            fetched = c.getInt(7) != 0;
        }
    }

    private static final String MMS_COLS = "tx, location, sender, expiry, sub, tries, told, fetched";

    /**
     * An MMS a carrier announced; false when it was announced before: carriers repeat notifications, some with a new
     * transaction id for the same MMS (its address at the MMS centre).
     */
    boolean addMms(String tx, String location, String sender, long expiryS, int sub) {
        SQLiteDatabase db = getWritableDatabase();
        // Fetched ones that expired at the MMS centre are announced no more.
        db.delete("mms", "fetched = 1 and expiry < ?", new String[] {String.valueOf(System.currentTimeMillis() / 1000)});
        try (Cursor c = db.rawQuery("select 1 from mms where location = ? limit 1", new String[] {location})) {
            if (c.moveToFirst()) return false;
        }
        ContentValues cv = new ContentValues();
        cv.put("tx", tx);
        cv.put("location", location);
        cv.put("sender", sender);
        cv.put("expiry", expiryS);
        cv.put("sub", sub);
        cv.put("next_at", System.currentTimeMillis());
        cv.put("created", System.currentTimeMillis());
        return db.insertWithOnConflict("mms", null, cv, SQLiteDatabase.CONFLICT_IGNORE) != -1;
    }

    Mms mms(String tx) {
        try (Cursor c = getReadableDatabase().rawQuery("select " + MMS_COLS + " from mms where tx = ?", new String[] {tx})) {
            return c.moveToFirst() ? new Mms(c) : null;
        }
    }

    /** Those whose next try is due. */
    java.util.List<Mms> dueMms() {
        java.util.List<Mms> out = new java.util.ArrayList<>();
        try (Cursor c = getReadableDatabase().rawQuery("select " + MMS_COLS + " from mms where fetched = 0 and next_at <= ?", new String[] {String.valueOf(System.currentTimeMillis())})) {
            while (c.moveToNext()) out.add(new Mms(c));
        }
        return out;
    }

    /** The earliest next try, or -1 when nothing waits. */
    long nextMmsAt() {
        try (Cursor c = getReadableDatabase().rawQuery("select min(next_at) from mms where fetched = 0", null)) {
            return c.moveToFirst() && !c.isNull(0) ? c.getLong(0) : -1;
        }
    }

    /** A fetch that failed: the next try later (1, 5, 15 minutes, an hour, then every three hours). */
    void mmsFailed(String tx) {
        Mms m = mms(tx);
        if (m == null) return;
        long[] wait = {60_000, 5 * 60_000, 15 * 60_000, 3_600_000};
        long next = System.currentTimeMillis() + (m.tries < wait.length ? wait[m.tries] : 3 * 3_600_000L);
        getWritableDatabase().execSQL("update mms set tries = tries + 1, next_at = ? where tx = ?", new Object[] {next, tx});
    }

    /** A fetch on its way: not tried again before it reported (or ten minutes passed). */
    void mmsStarted(String tx) {
        getWritableDatabase().execSQL("update mms set next_at = ? where tx = ?", new Object[] {System.currentTimeMillis() + 10 * 60_000, tx});
    }

    void mmsTold(String tx) {
        getWritableDatabase().execSQL("update mms set told = 1 where tx = ?", new Object[] {tx});
    }

    /** Fetched and stored: kept until it expires at the MMS centre, against the same MMS announced again. */
    void mmsFetched(String tx) {
        getWritableDatabase().execSQL("update mms set fetched = 1 where tx = ?", new Object[] {tx});
    }

    void dropMms(String tx) {
        getWritableDatabase().delete("mms", "tx = ?", new String[] {tx});
    }

    /** Sends whose reports never all came (a week): forgotten, the server has long called them uncertain. */
    void forgetOldSends() {
        getWritableDatabase().delete("sends", "created < ?", new String[] {String.valueOf(System.currentTimeMillis() - 7 * 86_400_000L)});
    }
}
