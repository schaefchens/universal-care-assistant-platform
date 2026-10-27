package de.schaefchens.ucap;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Telephony;
import com.android.messaging.mmslib.pdu.CharacterSets;
import com.android.messaging.mmslib.pdu.EncodedStringValue;
import com.android.messaging.mmslib.pdu.PduBody;
import com.android.messaging.mmslib.pdu.PduHeaders;
import com.android.messaging.mmslib.pdu.PduPart;
import com.android.messaging.mmslib.pdu.RetrieveConf;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Android's MMS store (Telephony.Mms), which UCAP writes itself as the SMS app (docs/plan-m3.md, K4: "Everything is
 * written to Android's SMS store, so the history stays when the role goes back"): an MMS fetched from the MMS centre
 * goes in whole, with its parts (text, pictures) and its addresses, as AOSP's persister writes it; read back for the
 * server by its text and whether it holds a picture.
 */
final class MmsStore {
    private MmsStore() {}

    static final int ADDR_FROM = PduHeaders.FROM;
    static final int ADDR_TO = PduHeaders.TO;
    static final int ADDR_CC = PduHeaders.CC;

    private static String str(EncodedStringValue v) {
        return v == null ? null : v.getString();
    }

    /** A header's bytes as AOSP's PduPersister stores them (toIsoString): one character per byte. */
    private static String iso(byte[] b) {
        return b == null ? null : new String(b, StandardCharsets.ISO_8859_1);
    }

    /**
     * A subject or address read back from the store: AOSP's PduPersister keeps their bytes as ISO-8859-1 characters
     * beside their charset, and AOSP's Messaging decodes them that way. A value with a character beyond one byte was
     * stored as text, and is taken as it is.
     */
    static String decoded(String stored, int charset) {
        if (stored == null || charset <= 0) return stored;
        for (int i = 0; i < stored.length(); i++) if (stored.charAt(i) > 0xff) return stored;
        try {
            return new String(stored.getBytes(StandardCharsets.ISO_8859_1), CharacterSets.getMimeName(charset));
        } catch (Exception e) {
            return stored;
        }
    }

    /**
     * An MMS fetched from the MMS centre: into the inbox of its thread, a group's when it went to others besides the
     * person. The person's own number may be unknown (no number on the SIM): an MMS to one address went to them.
     */
    static long persist(Context ctx, RetrieveConf r, String self, int subscription) {
        String from = str(r.getFrom());
        // Each address with its type (from, to, cc), stored as AOSP's PduPersister stores it.
        List<EncodedStringValue> addrs = new ArrayList<>();
        List<Integer> types = new ArrayList<>();
        if (from != null) {
            addrs.add(r.getFrom());
            types.add(ADDR_FROM);
        }
        List<String> recipients = new ArrayList<>();
        for (EncodedStringValue v : nonNull(r.getTo())) if (v.getString() != null) {
            addrs.add(v);
            types.add(ADDR_TO);
            recipients.add(v.getString());
        }
        for (EncodedStringValue v : nonNull(r.getCc())) if (v.getString() != null) {
            addrs.add(v);
            types.add(ADDR_CC);
            recipients.add(v.getString());
        }
        Set<String> others = new HashSet<>();
        if (from != null) others.add(from);
        others.addAll(othersThan(recipients, self));
        long thread = Telephony.Threads.getOrCreateThreadId(ctx, others);
        PduBody body = r.getBody();
        boolean textOnly = true;
        for (int i = 0; body != null && i < body.getPartsNum(); i++) if (!"text/plain".equalsIgnoreCase(iso(body.getPart(i).getContentType()))) textOnly = false;

        ContentValues v = new ContentValues();
        v.put(Telephony.Mms.THREAD_ID, thread);
        long date = r.getDate() > 0 ? r.getDate() : System.currentTimeMillis() / 1000;
        // Ordered by when it came, as SMS are (the sender's clock is kept apart).
        v.put(Telephony.Mms.DATE, System.currentTimeMillis() / 1000);
        v.put(Telephony.Mms.DATE_SENT, date);
        v.put(Telephony.Mms.MESSAGE_BOX, Telephony.Mms.MESSAGE_BOX_INBOX);
        v.put(Telephony.Mms.READ, 0);
        v.put(Telephony.Mms.SEEN, 0);
        v.put(Telephony.Mms.MESSAGE_TYPE, PduHeaders.MESSAGE_TYPE_RETRIEVE_CONF);
        v.put(Telephony.Mms.MMS_VERSION, r.getMmsVersion());
        if (r.getMessageId() != null) v.put(Telephony.Mms.MESSAGE_ID, iso(r.getMessageId()));
        if (r.getTransactionId() != null) v.put(Telephony.Mms.TRANSACTION_ID, iso(r.getTransactionId()));
        if (r.getContentType() != null) v.put(Telephony.Mms.CONTENT_TYPE, iso(r.getContentType()));
        if (r.getSubject() != null) {
            // Its bytes and charset, as AOSP's PduPersister stores it: Messaging apps decode it that way ("Grüße").
            v.put(Telephony.Mms.SUBJECT, iso(r.getSubject().getTextString()));
            v.put(Telephony.Mms.SUBJECT_CHARSET, r.getSubject().getCharacterSet());
        }
        v.put(Telephony.Mms.TEXT_ONLY, textOnly ? 1 : 0);
        if (subscription >= 0) v.put(Telephony.Mms.SUBSCRIPTION_ID, subscription);
        Uri u = ctx.getContentResolver().insert(Telephony.Mms.Inbox.CONTENT_URI, v);
        if (u == null) return -1;
        long id = Long.parseLong(u.getLastPathSegment());

        for (int i = 0; body != null && i < body.getPartsNum(); i++) persistPart(ctx, id, i, body.getPart(i));
        Uri addrUri = Uri.parse("content://mms/" + id + "/addr");
        for (int i = 0; i < addrs.size(); i++) {
            ContentValues av = new ContentValues();
            av.put(Telephony.Mms.Addr.ADDRESS, iso(addrs.get(i).getTextString()));
            av.put(Telephony.Mms.Addr.TYPE, types.get(i));
            av.put(Telephony.Mms.Addr.CHARSET, addrs.get(i).getCharacterSet());
            ctx.getContentResolver().insert(addrUri, av);
        }
        return id;
    }

    private static EncodedStringValue[] nonNull(EncodedStringValue[] v) {
        return v == null ? new EncodedStringValue[0] : v;
    }

    /**
     * Everyone the MMS went to but the person. Without the person's own number, one recipient is the person, and of
     * several none can be told apart from them: they all stay (a group MMS then names the person too).
     */
    static List<String> othersThan(List<String> recipients, String self) {
        List<String> out = new ArrayList<>();
        if (self == null || self.isEmpty()) {
            if (recipients.size() > 1) out.addAll(recipients);
            return out;
        }
        String own = digits(self);
        for (String a : recipients) if (!sameNumber(digits(a), own)) out.add(a);
        return out;
    }

    private static String digits(String a) {
        return a == null ? "" : a.replaceAll("[^0-9]", "");
    }

    /** The same number, written with or without its country code: the last nine digits decide (as Android compares). */
    static boolean sameNumber(String a, String b) {
        if (a.isEmpty() || b.isEmpty()) return false;
        int n = Math.min(9, Math.min(a.length(), b.length()));
        return a.endsWith(b.substring(b.length() - n)) && b.endsWith(a.substring(a.length() - n));
    }

    private static void persistPart(Context ctx, long id, int seq, PduPart p) {
        String type = iso(p.getContentType());
        ContentValues v = new ContentValues();
        v.put(Telephony.Mms.Part.SEQ, seq);
        v.put(Telephony.Mms.Part.CONTENT_TYPE, type);
        if (p.getName() != null) v.put(Telephony.Mms.Part.NAME, iso(p.getName()));
        if (p.getFilename() != null) v.put(Telephony.Mms.Part.FILENAME, iso(p.getFilename()));
        if (p.getContentLocation() != null) v.put(Telephony.Mms.Part.CONTENT_LOCATION, iso(p.getContentLocation()));
        if (p.getContentId() != null) v.put(Telephony.Mms.Part.CONTENT_ID, iso(p.getContentId()));
        boolean text = type != null && type.toLowerCase(java.util.Locale.ROOT).startsWith("text/plain");
        if (text) {
            int cs = p.getCharset() > 0 ? p.getCharset() : CharacterSets.UTF_8;
            v.put(Telephony.Mms.Part.CHARSET, cs);
            v.put(Telephony.Mms.Part.TEXT, decode(p.getData(), cs));
        }
        Uri partUri = ctx.getContentResolver().insert(Uri.parse("content://mms/" + id + "/part"), v);
        if (text || partUri == null || p.getData() == null) return;
        try (OutputStream out = ctx.getContentResolver().openOutputStream(partUri)) {
            if (out != null) out.write(p.getData());
        } catch (Exception e) {
            android.util.Log.w("UCAP", "mms: a part was not stored: " + e.getClass().getSimpleName());
        }
    }

    private static String decode(byte[] data, int charset) {
        if (data == null) return "";
        try {
            return new String(data, CharacterSets.getMimeName(charset));
        } catch (Exception e) {
            return new String(data, StandardCharsets.UTF_8);
        }
    }

    // —— Read back for the server ——

    static final class Row {
        long id;
        long thread;
        long dateMs;
        boolean outgoing;
        String subject;
        String from;
        String text = "";
        boolean picture;
    }

    /** MMS after an id, oldest first: the ones that are messages (fetched or sent), not notifications of them. */
    static List<Row> after(Context ctx, long afterId, int limit) {
        List<Row> out = new ArrayList<>();
        String[] cols = {Telephony.Mms._ID, Telephony.Mms.THREAD_ID, Telephony.Mms.DATE, Telephony.Mms.MESSAGE_BOX, Telephony.Mms.SUBJECT, Telephony.Mms.MESSAGE_TYPE, Telephony.Mms.SUBJECT_CHARSET};
        try (Cursor c = ctx.getContentResolver().query(Telephony.Mms.CONTENT_URI, cols, Telephony.Mms._ID + " > ?", new String[] {String.valueOf(afterId)}, Telephony.Mms._ID + " ASC")) {
            while (c != null && c.moveToNext() && out.size() < limit) {
                int type = c.getInt(5);
                Row r = new Row();
                r.id = c.getLong(0);
                r.thread = c.getLong(1);
                r.dateMs = c.getLong(2) * 1000;
                r.outgoing = c.getInt(3) == Telephony.Mms.MESSAGE_BOX_SENT;
                r.subject = c.isNull(4) ? null : decoded(c.getString(4), c.isNull(6) ? 0 : c.getInt(6));
                // A notification of an MMS not fetched (m-notification-ind) is no message yet: kept as a position only.
                if (type != PduHeaders.MESSAGE_TYPE_RETRIEVE_CONF && type != PduHeaders.MESSAGE_TYPE_SEND_REQ) {
                    r.text = null;
                }
                out.add(r);
            }
        }
        for (Row r : out) if (r.text != null) fill(ctx, r);
        return out;
    }

    private static void fill(Context ctx, Row r) {
        StringBuilder text = new StringBuilder();
        try (Cursor c = ctx.getContentResolver().query(Uri.parse("content://mms/part"), new String[] {Telephony.Mms.Part.CONTENT_TYPE, Telephony.Mms.Part.TEXT},
                Telephony.Mms.Part.MSG_ID + " = ?", new String[] {String.valueOf(r.id)}, Telephony.Mms.Part.SEQ + " ASC")) {
            while (c != null && c.moveToNext()) {
                String ct = c.isNull(0) ? "" : c.getString(0).toLowerCase(java.util.Locale.ROOT);
                if (ct.startsWith("image/")) r.picture = true;
                else if (ct.startsWith("text/plain") && !c.isNull(1)) {
                    if (text.length() > 0) text.append('\n');
                    text.append(c.getString(1));
                }
            }
        }
        r.text = text.toString().trim();
        if (r.text.isEmpty() && r.subject != null) r.text = r.subject;
        try (Cursor c = ctx.getContentResolver().query(Uri.parse("content://mms/" + r.id + "/addr"), new String[] {Telephony.Mms.Addr.ADDRESS, Telephony.Mms.Addr.CHARSET},
                Telephony.Mms.Addr.TYPE + " = ?", new String[] {String.valueOf(ADDR_FROM)}, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) r.from = decoded(c.getString(0), c.isNull(1) ? 0 : c.getInt(1));
        }
    }

    /** One MMS with its text and whether it has a picture (its notification says them). */
    static Row one(Context ctx, long id) {
        List<Row> rows = after(ctx, id - 1, 1);
        return rows.isEmpty() || rows.get(0).id != id ? null : rows.get(0);
    }

    static long maxId(Context ctx) {
        try (Cursor c = ctx.getContentResolver().query(Telephony.Mms.CONTENT_URI, new String[] {Telephony.Mms._ID}, null, null, Telephony.Mms._ID + " DESC")) {
            return c != null && c.moveToFirst() ? c.getLong(0) : 0;
        }
    }

    /** The id before the first MMS since a time (MMS dates are seconds). */
    static long idBefore(Context ctx, long sinceMs) {
        try (Cursor c = ctx.getContentResolver().query(Telephony.Mms.CONTENT_URI, new String[] {Telephony.Mms._ID}, Telephony.Mms.DATE + " >= ?", new String[] {String.valueOf(sinceMs / 1000)},
                Telephony.Mms._ID + " ASC")) {
            return c != null && c.moveToFirst() ? c.getLong(0) - 1 : maxId(ctx);
        }
    }

    static long threadOf(Context ctx, long id) {
        try (Cursor c = ctx.getContentResolver().query(Telephony.Mms.CONTENT_URI, new String[] {Telephony.Mms.THREAD_ID}, Telephony.Mms._ID + " = ?", new String[] {String.valueOf(id)}, null)) {
            return c != null && c.moveToFirst() ? c.getLong(0) : -1;
        }
    }

    static int markRead(Context ctx, List<Long> ids) {
        if (ids.isEmpty()) return 0;
        ContentValues v = new ContentValues();
        v.put(Telephony.Mms.READ, 1);
        v.put(Telephony.Mms.SEEN, 1);
        StringBuilder in = new StringBuilder();
        String[] args = new String[ids.size()];
        for (int i = 0; i < ids.size(); i++) {
            in.append(i == 0 ? "?" : ",?");
            args[i] = String.valueOf(ids.get(i));
        }
        return ctx.getContentResolver().update(Telephony.Mms.CONTENT_URI, v, Telephony.Mms._ID + " in (" + in + ")", args);
    }
}
