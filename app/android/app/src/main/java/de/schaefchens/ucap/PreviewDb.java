package de.schaefchens.ucap;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;

/**
 * The previews' own small database, used in the previews process only (docs/plan-m3.md, K5):
 * - `apps`: the apps the person chose, each with the server connection it reports to and when it was connected;
 * - `outq`: what waits for the server, in order;
 * - `convs`: each conversation's last notification (its key), so a reply and "read" go back through it after a restart;
 * - `seen`: the messages reported, so a messenger's repeats are not sent again (the server keeps each once anyway);
 * - `replies`: replies handed to an app, until it shows them as the person's own;
 * - `heard`: messages the person heard (a day), so a conversation is marked read once every message it shows was.
 * What the notifications said is not kept here: it goes to the person's server, and lives on in the app that showed it.
 */
final class PreviewDb extends SQLiteOpenHelper {
    private static PreviewDb instance;

    static synchronized PreviewDb get(Context ctx) {
        if (instance == null) instance = new PreviewDb(ctx.getApplicationContext());
        return instance;
    }

    private PreviewDb(Context ctx) {
        super(ctx, "ucap-previews.db", null, 2);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("create table apps (pkg text primary key, connection text not null, since integer not null)");
        db.execSQL("create table outq (id integer primary key autoincrement, connection text not null, events text not null, idem text not null, created integer not null)");
        db.execSQL("create table convs (conv text primary key, pkg text not null, sbn_key text not null, newest_in integer not null default -1, read_upto integer not null default 0, updated integer not null)");
        db.execSQL("create table seen (msg text primary key, conv text not null, created integer not null)");
        db.execSQL("create table replies (request text primary key, conv text not null, words text not null, handed integer not null)");
        db.execSQL("create table heard (msg text primary key, conv text not null, created integer not null)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int from, int to) {
        if (from < 2) db.execSQL("alter table convs add column read_upto integer not null default 0");
    }

    // —— The apps the person chose ——

    static final class App {
        final String pkg;
        final String connection;
        final long since;

        App(String pkg, String connection, long since) {
            this.pkg = pkg;
            this.connection = connection;
            this.since = since;
        }
    }

    /** Watched from now on, for this connection; true when it is new (or its connection is). */
    boolean addApp(String pkg, String connection) {
        App had = app(pkg);
        if (had != null && had.connection.equals(connection)) return false;
        ContentValues cv = new ContentValues();
        cv.put("pkg", pkg);
        cv.put("connection", connection);
        cv.put("since", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict("apps", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
        return true;
    }

    App app(String pkg) {
        try (Cursor c = getReadableDatabase().rawQuery("select pkg, connection, since from apps where pkg = ?", new String[] {pkg})) {
            return c.moveToFirst() ? new App(c.getString(0), c.getString(1), c.getLong(2)) : null;
        }
    }

    App appOf(String connection) {
        try (Cursor c = getReadableDatabase().rawQuery("select pkg, connection, since from apps where connection = ?", new String[] {connection})) {
            return c.moveToFirst() ? new App(c.getString(0), c.getString(1), c.getLong(2)) : null;
        }
    }

    List<App> apps() {
        List<App> out = new ArrayList<>();
        try (Cursor c = getReadableDatabase().rawQuery("select pkg, connection, since from apps", null)) {
            while (c.moveToNext()) out.add(new App(c.getString(0), c.getString(1), c.getLong(2)));
        }
        return out;
    }

    /** No longer watched (the person disconnected it): its queue, conversations and replies go too. */
    void dropApp(String connection) {
        App a = appOf(connection);
        SQLiteDatabase db = getWritableDatabase();
        db.delete("apps", "connection = ?", new String[] {connection});
        db.delete("outq", "connection = ?", new String[] {connection});
        if (a == null) return;
        for (String conv : convsOf(a.pkg)) {
            PreviewListener.LAST.remove(conv);
            db.delete("seen", "conv = ?", new String[] {conv});
            db.delete("replies", "conv = ?", new String[] {conv});
            db.delete("heard", "conv = ?", new String[] {conv});
        }
        db.delete("convs", "pkg = ?", new String[] {a.pkg});
    }

    // —— What waits for the server ——

    void queue(String connection, JSONArray events) {
        if (events.length() == 0) return;
        ContentValues cv = new ContentValues();
        cv.put("connection", connection);
        cv.put("events", events.toString());
        cv.put("idem", Api.idem());
        cv.put("created", System.currentTimeMillis());
        getWritableDatabase().insert("outq", null, cv);
    }

    static final class Entry {
        final long id;
        final String connection;
        final String events;
        final String idem;

        Entry(long id, String connection, String events, String idem) {
            this.id = id;
            this.connection = connection;
            this.events = events;
            this.idem = idem;
        }
    }

    Entry first() {
        try (Cursor c = getReadableDatabase().rawQuery("select id, connection, events, idem from outq order by id limit 1", null)) {
            return c.moveToFirst() ? new Entry(c.getLong(0), c.getString(1), c.getString(2), c.getString(3)) : null;
        }
    }

    void done(long id) {
        getWritableDatabase().delete("outq", "id = ?", new String[] {String.valueOf(id)});
    }

    // —— Conversations ——

    void rememberConversation(String conv, String pkg, String sbnKey, long newestIn) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("pkg", pkg);
        cv.put("sbn_key", sbnKey);
        cv.put("newest_in", newestIn);
        cv.put("updated", System.currentTimeMillis());
        if (db.update("convs", cv, "conv = ?", new String[] {conv}) > 0) return;
        cv.put("conv", conv);
        db.insertWithOnConflict("convs", null, cv, SQLiteDatabase.CONFLICT_IGNORE);
    }

    /** The conversation was read up to this time (milliseconds), through UCAP or in the app itself. */
    void readUpTo(String conv, long ms) {
        getWritableDatabase().execSQL("update convs set read_upto = max(read_upto, ?) where conv = ?", new Object[] {ms, conv});
    }

    long readUpTo(String conv) {
        try (Cursor c = getReadableDatabase().rawQuery("select read_upto from convs where conv = ?", new String[] {conv})) {
            return c.moveToFirst() ? c.getLong(0) : 0;
        }
    }


    /** The key of the conversation's last notification, or null. */
    String notificationOf(String conv) {
        try (Cursor c = getReadableDatabase().rawQuery("select sbn_key from convs where conv = ?", new String[] {conv})) {
            return c.moveToFirst() ? c.getString(0) : null;
        }
    }

    /** The conversation a notification was last seen for, with the newest message of others it showed (seconds). */
    String[] conversationOfNotification(String sbnKey) {
        try (Cursor c = getReadableDatabase().rawQuery("select conv, pkg, newest_in from convs where sbn_key = ? order by updated desc limit 1", new String[] {sbnKey})) {
            return c.moveToFirst() ? new String[] {c.getString(0), c.getString(1), String.valueOf(c.getLong(2))} : null;
        }
    }

    private List<String> convsOf(String pkg) {
        List<String> out = new ArrayList<>();
        try (Cursor c = getReadableDatabase().rawQuery("select conv from convs where pkg = ?", new String[] {pkg})) {
            while (c.moveToNext()) out.add(c.getString(0));
        }
        return out;
    }

    // —— Messages reported, and heard ——

    Set<String> seen(String conv) {
        Set<String> out = new HashSet<>();
        try (Cursor c = getReadableDatabase().rawQuery("select msg from seen where conv = ?", new String[] {conv})) {
            while (c.moveToNext()) out.add(c.getString(0));
        }
        return out;
    }

    void addSeen(String conv, Set<String> ids) {
        SQLiteDatabase db = getWritableDatabase();
        long now = System.currentTimeMillis();
        for (String id : ids) {
            ContentValues cv = new ContentValues();
            cv.put("msg", id);
            cv.put("conv", conv);
            cv.put("created", now);
            db.insertWithOnConflict("seen", null, cv, SQLiteDatabase.CONFLICT_IGNORE);
        }
    }

    void addHeard(String conv, String[] ids) {
        SQLiteDatabase db = getWritableDatabase();
        long now = System.currentTimeMillis();
        for (String id : ids) {
            ContentValues cv = new ContentValues();
            cv.put("msg", id);
            cv.put("conv", conv);
            cv.put("created", now);
            db.insertWithOnConflict("heard", null, cv, SQLiteDatabase.CONFLICT_IGNORE);
        }
    }

    Set<String> heard(String conv) {
        Set<String> out = new HashSet<>();
        try (Cursor c = getReadableDatabase().rawQuery("select msg from heard where conv = ?", new String[] {conv})) {
            while (c.moveToNext()) out.add(c.getString(0));
        }
        return out;
    }

    // —— Replies handed to an app ——

    static final class Reply {
        final String request;
        final String words;
        final long handed;

        Reply(String request, String words, long handed) {
            this.request = request;
            this.words = words;
            this.handed = handed;
        }
    }

    void addReply(String request, String conv, String words) {
        ContentValues cv = new ContentValues();
        cv.put("request", request);
        cv.put("conv", conv);
        cv.put("words", words);
        cv.put("handed", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict("replies", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    List<Reply> replies(String conv) {
        List<Reply> out = new ArrayList<>();
        try (Cursor c = getReadableDatabase().rawQuery("select request, words, handed from replies where conv = ? order by handed", new String[] {conv})) {
            while (c.moveToNext()) out.add(new Reply(c.getString(0), c.getString(1), c.getLong(2)));
        }
        return out;
    }

    void dropReply(String request) {
        getWritableDatabase().delete("replies", "request = ?", new String[] {request});
    }

    /**
     * Forgotten after their while: messages reported (three days: a messenger shows a conversation's last few), what
     * was heard (a day), replies never shown as sent (an hour: the server calls them uncertain after ten minutes).
     */
    void prune() {
        long now = System.currentTimeMillis();
        SQLiteDatabase db = getWritableDatabase();
        db.delete("seen", "created < ?", new String[] {String.valueOf(now - 3 * 86_400_000L)});
        db.delete("heard", "created < ?", new String[] {String.valueOf(now - 86_400_000L)});
        db.delete("replies", "handed < ?", new String[] {String.valueOf(now - 3_600_000L)});
    }
}
