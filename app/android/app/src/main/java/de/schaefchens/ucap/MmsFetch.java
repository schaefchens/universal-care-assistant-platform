package de.schaefchens.ucap;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Telephony;
import android.telephony.SmsManager;
import android.telephony.TelephonyManager;
import androidx.core.content.FileProvider;
import com.android.messaging.mmslib.pdu.GenericPdu;
import com.android.messaging.mmslib.pdu.NotificationInd;
import com.android.messaging.mmslib.pdu.PduHeaders;
import com.android.messaging.mmslib.pdu.PduParser;
import com.android.messaging.mmslib.pdu.RetrieveConf;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONArray;

/**
 * MMS in (docs/plan-m3.md, K4: "text, pictures and group MMS received in full; an MMS that could not be fetched is told
 * and fetched again"), in the SMS process. A carrier announces an MMS with a WAP push (MmsPushReceiver): recorded once
 * (carriers repeat it), then fetched from the carrier's MMS centre by Android's MMS service into a file of UCAP's
 * (shared through the FileProvider), parsed with AOSP's PDU code, and written whole to Android's store (MmsStore); the
 * forwarding reports it. A fetch that fails is tried again later (SmsDb), until the MMS expires, and the person is
 * told once that an MMS came and is not loaded yet; when it is, that notice goes. The MMS centre is told the MMS was
 * retrieved, as AOSP's Messaging tells it after a fetch of its own.
 */
final class MmsFetch {
    private MmsFetch() {}

    /** A carrier's notification of an MMS. */
    static void announced(Context ctx, NotificationInd n, int sub) {
        if (n.getContentLocation() == null) return;
        // Byte for byte: the transaction id goes back to the MMS centre as it came.
        String location = new String(n.getContentLocation(), StandardCharsets.ISO_8859_1);
        String tx = n.getTransactionId() != null ? new String(n.getTransactionId(), StandardCharsets.ISO_8859_1) : location;
        String from = n.getFrom() != null ? n.getFrom().getString() : null;
        long expiry = n.getExpiry() > 0 ? n.getExpiry() : System.currentTimeMillis() / 1000 + 7 * 86_400;
        SmsDb db = SmsDb.get(ctx);
        if (!db.addMms(tx, location, from, expiry, sub)) return;
        start(ctx, db.mms(tx));
    }

    /** Fetches one MMS: Android's MMS service writes it to a file, and tells MmsFetchedReceiver. */
    static void start(Context ctx, SmsDb.Mms m) {
        if (m == null) return;
        SmsDb db = SmsDb.get(ctx);
        if (m.expiry < System.currentTimeMillis() / 1000) {
            // Gone at the MMS centre: told, never tried again.
            if (m.sender != null) db.queue(notice(ctx, m, "mms.expired"));
            db.dropMms(m.tx);
            return;
        }
        if (!SmsRole.held(ctx)) return;
        try {
            File f = file(ctx, m.tx);
            f.getParentFile().mkdirs();
            f.delete();
            f.createNewFile();
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            Intent done = new Intent(ctx, MmsFetchedReceiver.class).setData(Uri.parse("ucap-mms://fetched/" + key(m.tx))).putExtra("tx", m.tx);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pi = PendingIntent.getBroadcast(ctx, 0, done, flags);
            db.mmsStarted(m.tx);
            SmsSender.manager(ctx, m.sub).downloadMultimediaMessage(ctx, m.location, uri, null, pi);
        } catch (Exception e) {
            android.util.Log.w("UCAP", "mms: not fetched: " + e.getClass().getSimpleName());
            failed(ctx, m);
        }
    }

    /**
     * Android's MMS service reported on a fetch. One report at a time: a fetch that took longer than ten minutes is
     * started again, and both may report.
     */
    static synchronized void fetched(Context ctx, String tx, int resultCode) {
        SmsDb db = SmsDb.get(ctx);
        SmsDb.Mms m = db.mms(tx);
        File f = file(ctx, tx);
        // A report on one stored already changes nothing.
        if (m == null || m.fetched) {
            f.delete();
            return;
        }
        try {
            if (resultCode == Activity.RESULT_OK && f.length() > 0) {
                GenericPdu pdu = new PduParser(Io.readAll(f), true).parse();
                if (pdu instanceof RetrieveConf) {
                    RetrieveConf r = (RetrieveConf) pdu;
                    int status = r.getRetrieveStatus();
                    if (status == 0 || status == PduHeaders.RETRIEVE_STATUS_OK) {
                        long id = MmsStore.persist(ctx, r, self(ctx, m.sub), m.sub);
                        if (id > 0) {
                            db.mmsFetched(tx);
                            retrieved(ctx, m);
                            // The notice that it was not loaded yet goes.
                            if (m.told) db.queue(new JSONArray().put(SmsEvents.deleted(String.valueOf(senderThread(ctx, m)), noticeId(tx))));
                            long thread = MmsStore.threadOf(ctx, id);
                            String name = m.sender == null ? "" : SmsStore.person(ctx, m.sender, SmsStore.country(ctx)).name;
                            if (thread > 0) SmsNotify.newMessage(ctx, thread, name, "mms.new");
                            return;
                        }
                    }
                }
            }
            failed(ctx, m);
        } catch (Exception e) {
            android.util.Log.w("UCAP", "mms: a fetched MMS was not stored: " + e.getClass().getSimpleName());
            failed(ctx, m);
        } finally {
            f.delete();
        }
    }

    /**
     * Debug builds: an MMS as Android's MMS service writes it after a fetch, handed in from adb (DebugMmsReceiver): the
     * emulator's carrier configuration disables MMS, so its MMS service fetches nothing.
     */
    static void debugFetched(Context ctx, String tx, byte[] pdu) {
        try {
            File f = file(ctx, tx);
            f.getParentFile().mkdirs();
            Io.writeAll(f, pdu);
            fetched(ctx, tx, Activity.RESULT_OK);
        } catch (Exception e) {
            android.util.Log.w("UCAP", "mms debug: " + e.getClass().getSimpleName());
        }
    }

    /**
     * Tells the MMS centre the MMS was retrieved (M-NotifyResp.ind, status Retrieved), through Android's MMS service:
     * otherwise a carrier may announce it again, or tell its sender it never arrived. Once; to the MMS's own address
     * where the carrier's configuration asks for that (AOSP's Messaging does the same).
     */
    private static void retrieved(Context ctx, SmsDb.Mms m) {
        File f = new File(new File(ctx.getCacheDir(), "mms"), key(m.tx) + ".resp");
        try {
            Io.writeAll(f, notifyResp(m.tx));
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            Intent done = new Intent(ctx, MmsFetchedReceiver.class).setData(Uri.parse("ucap-mms://retrieved/" + key(m.tx))).putExtra("retrieved", key(m.tx));
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            SmsManager sm = SmsSender.manager(ctx, m.sub);
            android.os.Bundle config = sm.getCarrierConfigValues();
            String to = config != null && config.getBoolean(SmsManager.MMS_CONFIG_NOTIFY_WAP_MMSC_ENABLED, false) ? m.location : null;
            sm.sendMultimediaMessage(ctx, uri, to, null, PendingIntent.getBroadcast(ctx, 0, done, flags));
        } catch (Exception e) {
            f.delete();
            android.util.Log.w("UCAP", "mms: the MMS centre was not told: " + e.getClass().getSimpleName());
        }
    }

    /** Android's MMS service reported on telling the MMS centre (retrieved): its file goes. */
    static void told(Context ctx, String key, int resultCode) {
        if (!key.matches("^[0-9a-f]+$")) return;
        new File(new File(ctx.getCacheDir(), "mms"), key + ".resp").delete();
        if (resultCode != Activity.RESULT_OK) android.util.Log.w("UCAP", "mms: the MMS centre was not told (" + resultCode + ")");
    }

    /**
     * M-NotifyResp.ind (OMA-TS-MMS_ENC 1.3, 6.2): the message type, the transaction id (a text string, quoted where it
     * starts with a byte of 0x80 or more), the MMS version (1.2, as AOSP's) and the status Retrieved.
     */
    static byte[] notifyResp(String tx) {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        out.write(PduHeaders.MESSAGE_TYPE);
        out.write(PduHeaders.MESSAGE_TYPE_NOTIFYRESP_IND);
        out.write(PduHeaders.TRANSACTION_ID);
        byte[] id = tx.getBytes(StandardCharsets.ISO_8859_1);
        if (id.length > 0 && (id[0] & 0xff) >= 0x80) out.write(0x7f);
        out.write(id, 0, id.length);
        out.write(0);
        out.write(PduHeaders.MMS_VERSION);
        out.write(0x80 | PduHeaders.CURRENT_MMS_VERSION);
        out.write(PduHeaders.STATUS);
        out.write(PduHeaders.STATUS_RETRIEVED);
        return out.toByteArray();
    }

    private static void failed(Context ctx, SmsDb.Mms m) {
        SmsDb db = SmsDb.get(ctx);
        db.mmsFailed(m.tx);
        if (!m.told && m.sender != null) {
            db.queue(notice(ctx, m, "mms.pending"));
            db.mmsTold(m.tx);
        }
        SmsJob.mmsRetry(ctx, db.nextMmsAt());
    }

    /** Fetches what is due again (SmsJob). */
    static void retryDue(Context ctx) {
        for (SmsDb.Mms m : SmsDb.get(ctx).dueMms()) start(ctx, m);
    }

    /** "Eine MMS von Anna …": a notice in the conversation with its sender, in the person's words. */
    private static JSONArray notice(Context ctx, SmsDb.Mms m, String textKey) {
        SmsStore.Person p = SmsStore.person(ctx, m.sender, SmsStore.country(ctx));
        String thread = String.valueOf(senderThread(ctx, m));
        return new JSONArray()
            .put(SmsEvents.user(p.id, p.name, p.contact))
            .put(SmsEvents.chat(thread, p.name, false, p.id))
            .put(SmsEvents.message(thread, noticeId(m.tx), p.id, false, System.currentTimeMillis(), "service", Texts.format(ctx, textKey, p.name), true));
    }

    private static long senderThread(Context ctx, SmsDb.Mms m) {
        return Telephony.Threads.getOrCreateThreadId(ctx, m.sender);
    }

    private static String noticeId(String tx) {
        return "mx" + key(tx).substring(0, 16);
    }

    /**
     * The phone's own number, so a group MMS's thread holds everyone but the person: the SIM's line number, which the
     * role's READ_SMS allows reading (measured; Android's other source, the subscription's number, needs
     * READ_PHONE_NUMBERS, which the role does not grant). Null where the SIM carries none: a group MMS then keeps all
     * its members, the person's own number among them, as AOSP's Messaging does.
     */
    static String self(Context ctx, int sub) {
        try {
            TelephonyManager tm = ctx.getSystemService(TelephonyManager.class);
            if (tm == null) return null;
            int id = sub >= 0 ? sub : android.telephony.SubscriptionManager.getDefaultSmsSubscriptionId();
            if (id != android.telephony.SubscriptionManager.INVALID_SUBSCRIPTION_ID) tm = tm.createForSubscriptionId(id);
            String n = tm.getLine1Number();
            return n == null || n.trim().isEmpty() ? null : n.trim();
        } catch (SecurityException e) {
            return null; // the role is gone
        } catch (RuntimeException e) {
            return null; // a phone without telephony
        }
    }

    private static File file(Context ctx, String tx) {
        return new File(new File(ctx.getCacheDir(), "mms"), key(tx) + ".pdu");
    }

    /** A transaction id as a file name: its hash (ids are the carrier's, any characters). */
    private static String key(String tx) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(tx.getBytes(StandardCharsets.UTF_8));
            StringBuilder s = new StringBuilder();
            for (int i = 0; i < 16; i++) s.append(String.format("%02x", h[i]));
            return s.toString();
        } catch (Exception e) {
            return Integer.toHexString(tx.hashCode());
        }
    }
}
