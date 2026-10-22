package de.schaefchens.ucap;

import android.Manifest;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import android.provider.Telephony;
import android.telephony.PhoneNumberUtils;
import android.telephony.TelephonyManager;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Android's SMS store (Telephony), which UCAP writes itself as the SMS app (spike C: SMS_DELIVER reaches the SMS app
 * only, and only it writes the store), and the person's address book for names (the role grants READ_CONTACTS).
 * Rows are read in order of their id: the store is the queue of what is still to be forwarded.
 */
final class SmsStore {
    private SmsStore() {}

    static final int INBOX = Telephony.Sms.MESSAGE_TYPE_INBOX;
    static final int SENT = Telephony.Sms.MESSAGE_TYPE_SENT;
    static final int OUTBOX = Telephony.Sms.MESSAGE_TYPE_OUTBOX;
    static final int FAILED = Telephony.Sms.MESSAGE_TYPE_FAILED;

    static final class Row {
        long id;
        long thread;
        String address;
        String body;
        long date;
        int type;
    }

    private static final String[] ROW = {Telephony.Sms._ID, Telephony.Sms.THREAD_ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE};

    private static Row row(Cursor c) {
        Row r = new Row();
        r.id = c.getLong(0);
        r.thread = c.getLong(1);
        r.address = c.isNull(2) ? "" : c.getString(2);
        r.body = c.isNull(3) ? "" : c.getString(3);
        r.date = c.getLong(4);
        r.type = c.getInt(5);
        return r;
    }

    /** SMS after an id, oldest first, at most `limit` (the cursor is walked, not cut: the provider's SQL stays its own). */
    static List<Row> after(Context ctx, long afterId, int limit) {
        List<Row> out = new ArrayList<>();
        try (Cursor c = ctx.getContentResolver().query(Telephony.Sms.CONTENT_URI, ROW, Telephony.Sms._ID + " > ?", new String[] {String.valueOf(afterId)}, Telephony.Sms._ID + " ASC")) {
            while (c != null && c.moveToNext() && out.size() < limit) out.add(row(c));
        }
        return out;
    }

    static Row one(Context ctx, long id) {
        try (Cursor c = ctx.getContentResolver().query(Telephony.Sms.CONTENT_URI, ROW, Telephony.Sms._ID + " = ?", new String[] {String.valueOf(id)}, null)) {
            return c != null && c.moveToFirst() ? row(c) : null;
        }
    }

    /** The newest SMS's id, or 0 for an empty store. */
    static long maxId(Context ctx) {
        try (Cursor c = ctx.getContentResolver().query(Telephony.Sms.CONTENT_URI, new String[] {Telephony.Sms._ID}, null, null, Telephony.Sms._ID + " DESC")) {
            return c != null && c.moveToFirst() ? c.getLong(0) : 0;
        }
    }

    /** The id before the first SMS since a time: forwarding from there brings that time's history. */
    static long idBefore(Context ctx, long sinceMs) {
        try (Cursor c = ctx.getContentResolver().query(Telephony.Sms.CONTENT_URI, new String[] {Telephony.Sms._ID}, Telephony.Sms.DATE + " >= ?", new String[] {String.valueOf(sinceMs)}, Telephony.Sms._ID + " ASC")) {
            return c != null && c.moveToFirst() ? c.getLong(0) - 1 : maxId(ctx);
        }
    }

    /** An SMS that arrived: written where it belongs, unread. Returns its id, or -1. */
    static long insertInbox(Context ctx, String address, String body, long sentMs, int subscription) {
        ContentValues v = new ContentValues();
        v.put(Telephony.Sms.ADDRESS, address);
        v.put(Telephony.Sms.BODY, body);
        // When it arrived: the centre's time is kept apart (an hour off on the emulator, spike C).
        v.put(Telephony.Sms.DATE, System.currentTimeMillis());
        v.put(Telephony.Sms.DATE_SENT, sentMs);
        v.put(Telephony.Sms.READ, 0);
        v.put(Telephony.Sms.SEEN, 0);
        if (subscription >= 0) v.put(Telephony.Sms.SUBSCRIPTION_ID, subscription);
        Uri u = ctx.getContentResolver().insert(Telephony.Sms.Inbox.CONTENT_URI, v);
        return u == null ? -1 : idOf(u);
    }

    /** An SMS about to go out: in the outbox until the network reports on it. Returns its id, or -1. */
    static long insertOutbox(Context ctx, String address, String body, long thread) {
        ContentValues v = new ContentValues();
        v.put(Telephony.Sms.ADDRESS, address);
        v.put(Telephony.Sms.BODY, body);
        v.put(Telephony.Sms.DATE, System.currentTimeMillis());
        v.put(Telephony.Sms.READ, 1);
        v.put(Telephony.Sms.SEEN, 1);
        if (thread > 0) v.put(Telephony.Sms.THREAD_ID, thread);
        Uri u = ctx.getContentResolver().insert(Telephony.Sms.Outbox.CONTENT_URI, v);
        return u == null ? -1 : idOf(u);
    }

    static void setType(Context ctx, long id, int type) {
        ContentValues v = new ContentValues();
        v.put(Telephony.Sms.TYPE, type);
        if (type == SENT) v.put(Telephony.Sms.DATE_SENT, System.currentTimeMillis());
        ctx.getContentResolver().update(Telephony.Sms.CONTENT_URI, v, Telephony.Sms._ID + " = ?", new String[] {String.valueOf(id)});
    }

    /** The delivery report: the other side's phone has it. */
    static void setDelivered(Context ctx, long id) {
        ContentValues v = new ContentValues();
        v.put(Telephony.Sms.STATUS, Telephony.Sms.STATUS_COMPLETE);
        ctx.getContentResolver().update(Telephony.Sms.CONTENT_URI, v, Telephony.Sms._ID + " = ?", new String[] {String.valueOf(id)});
    }

    /** Read once the person heard them (Appendix E), here as in any SMS app. */
    static int markRead(Context ctx, List<Long> ids) {
        if (ids.isEmpty()) return 0;
        ContentValues v = new ContentValues();
        v.put(Telephony.Sms.READ, 1);
        v.put(Telephony.Sms.SEEN, 1);
        StringBuilder in = new StringBuilder();
        String[] args = new String[ids.size()];
        for (int i = 0; i < ids.size(); i++) {
            in.append(i == 0 ? "?" : ",?");
            args[i] = String.valueOf(ids.get(i));
        }
        return ctx.getContentResolver().update(Telephony.Sms.CONTENT_URI, v, Telephony.Sms._ID + " in (" + in + ")", args);
    }

    private static long idOf(Uri u) {
        try {
            return Long.parseLong(u.getLastPathSegment());
        } catch (Exception e) {
            return -1;
        }
    }

    /** The thread's other side: one number, or several for a group. */
    static List<String> recipients(Context ctx, long thread) {
        List<String> out = new ArrayList<>();
        String ids = null;
        try (Cursor c = ctx.getContentResolver().query(Uri.parse("content://mms-sms/conversations?simple=true"), new String[] {Telephony.Threads._ID, Telephony.Threads.RECIPIENT_IDS},
                Telephony.Threads._ID + " = ?", new String[] {String.valueOf(thread)}, null)) {
            if (c != null && c.moveToFirst()) ids = c.getString(1);
        }
        if (ids == null || ids.trim().isEmpty()) return out;
        for (String rid : ids.trim().split("\\s+")) {
            try (Cursor c = ctx.getContentResolver().query(Uri.parse("content://mms-sms/canonical-address/" + rid), new String[] {"address"}, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) out.add(c.getString(0));
            } catch (Exception e) {
                // An id without its address: left out.
            }
        }
        return out;
    }

    /** A person as the server keeps them: their number in E.164 where it can be one, and the name the person gave. */
    static final class Person {
        final String id;
        final String name;
        final boolean contact;

        Person(String id, String name, boolean contact) {
            this.id = id;
            this.name = name;
            this.contact = contact;
        }
    }

    static String country(Context ctx) {
        TelephonyManager tm = ctx.getSystemService(TelephonyManager.class);
        String iso = tm == null ? null : tm.getSimCountryIso();
        if (iso == null || iso.isEmpty()) iso = tm == null ? null : tm.getNetworkCountryIso();
        return iso == null || iso.isEmpty() ? "DE" : iso.toUpperCase(Locale.ROOT);
    }

    static String idOf(String address, String country) {
        String e164 = address == null ? null : PhoneNumberUtils.formatNumberToE164(address, country);
        return e164 != null ? e164 : address == null ? "" : address.trim();
    }

    /** Named from the address book (never the sender's own claim); else the number as people write it. */
    static Person person(Context ctx, String address, String country) {
        String id = idOf(address, country);
        String name = null;
        if (address != null && !address.isEmpty() && ctx.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED) {
            Uri u = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(address));
            try (Cursor c = ctx.getContentResolver().query(u, new String[] {ContactsContract.PhoneLookup.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
            } catch (Exception e) {
                name = null;
            }
        }
        if (name != null && !name.trim().isEmpty()) return new Person(id, name.trim(), true);
        String shown = address == null ? "" : PhoneNumberUtils.formatNumber(id, country);
        return new Person(id, shown == null || shown.isEmpty() ? id : shown, false);
    }
}
