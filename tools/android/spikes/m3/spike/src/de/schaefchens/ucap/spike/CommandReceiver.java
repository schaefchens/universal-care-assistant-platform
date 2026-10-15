package de.schaefchens.ucap.spike;

import android.Manifest;
import android.app.PendingIntent;
import android.app.role.RoleManager;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Telephony;
import android.telephony.SmsManager;
import android.telephony.TelephonyManager;
import java.util.ArrayList;
import org.json.JSONObject;

/**
 * adb's commands to the main process (the stand-in for UCAP's app process):
 * `adb shell am broadcast -n de.schaefchens.ucap.spike/.CommandReceiver --es cmd ping|perms|query|number|send [--es to … --es text …]`.
 */
public class CommandReceiver extends BroadcastReceiver {
    static final String[] PERMS = {
        Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_MMS,
        Manifest.permission.RECEIVE_WAP_PUSH, Manifest.permission.READ_CONTACTS, Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.READ_PHONE_NUMBERS, Manifest.permission.CALL_PHONE, Manifest.permission.READ_CALL_LOG,
        Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA,
    };

    @Override
    public void onReceive(Context c, Intent i) {
        String cmd = String.valueOf(i.getStringExtra("cmd"));
        boolean held = c.getSystemService(RoleManager.class).isRoleHeld(RoleManager.ROLE_SMS);
        switch (cmd) {
            case "ping":
                Spike.log("ping_main", "role", held);
                break;
            case "perms":
                try {
                    JSONObject o = new JSONObject();
                    for (String p : PERMS) o.put(p.substring(p.lastIndexOf('.') + 1), c.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED);
                    Spike.log("perms", "role", held, "granted", o);
                } catch (Exception e) {
                    Spike.log("perms_failed", "error", e.getClass().getSimpleName());
                }
                break;
            case "query":
                query(c);
                break;
            case "number":
                // The emulator's own number (synthetic), for an SMS to itself.
                String n = null;
                try {
                    n = c.getSystemService(TelephonyManager.class).getLine1Number();
                } catch (SecurityException e) {
                    Spike.log("number_refused");
                    break;
                }
                Spike.log("number", "value", n);
                break;
            case "send":
                send(c, i.getStringExtra("to"), i.getStringExtra("text"));
                break;
            case "clean":
                // Every SMS the spike made carries "UCAP-Spike": deleted again (only the SMS app may write the store).
                try {
                    int deleted = c.getContentResolver().delete(Telephony.Sms.CONTENT_URI, Telephony.Sms.BODY + " LIKE ?", new String[] {"%UCAP-Spike%"});
                    Spike.log("cleaned", "deleted", deleted);
                } catch (Exception e) {
                    Spike.log("clean_refused", "error", e.getClass().getSimpleName());
                }
                break;
            default:
                Spike.log("unknown_command", "cmd", cmd);
        }
    }

    static void send(Context c, String to, String text) {
        if (to == null || text == null) {
            Spike.log("sms_send_failed", "error", "missing to or text");
            return;
        }
        SmsManager sm = c.getSystemService(SmsManager.class);
        String id = Long.toString(System.currentTimeMillis(), 36);
        ArrayList<String> parts = sm.divideMessage(text);
        ArrayList<PendingIntent> sent = new ArrayList<>();
        ArrayList<PendingIntent> delivered = new ArrayList<>();
        long started = System.currentTimeMillis();
        for (int p = 0; p < parts.size(); p++) {
            sent.add(report(c, "sent", id, p, parts.size(), to, text, started));
            delivered.add(report(c, "delivered", id, p, parts.size(), to, text, started));
        }
        try {
            if (parts.size() == 1) sm.sendTextMessage(to, null, text, sent.get(0), delivered.get(0));
            else sm.sendMultipartTextMessage(to, null, parts, sent, delivered);
            Spike.log("sms_send", "id", id, "parts", parts.size(), "len", text.length(), "textHash", Spike.hash(text), "to", Spike.shape(to));
        } catch (Exception e) {
            Spike.log("sms_send_failed", "id", id, "error", e.getClass().getSimpleName());
        }
    }

    /** Mutable, so the radio can add its error code and the delivery report's PDU; explicit, so only ours gets it. */
    static PendingIntent report(Context c, String kind, String id, int part, int of, String to, String text, long started) {
        Intent x = new Intent(c, ResultReceiver.class)
                .setData(Uri.parse("ucap-spike://sms/" + id + "/" + kind + "/" + part))
                .putExtra("kind", kind).putExtra("id", id).putExtra("part", part).putExtra("of", of)
                .putExtra("to", to).putExtra("text", text).putExtra("started", started);
        return PendingIntent.getBroadcast(c, 0, x, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
    }

    static void query(Context c) {
        ContentResolver cr = c.getContentResolver();
        int[] byType = new int[8];
        int total = 0;
        int unread = 0;
        long newestThread = -1;
        try (Cursor cur = cr.query(Telephony.Sms.CONTENT_URI, new String[] {Telephony.Sms.TYPE, Telephony.Sms.READ, Telephony.Sms.THREAD_ID}, null, null, Telephony.Sms.DEFAULT_SORT_ORDER)) {
            if (cur != null) {
                while (cur.moveToNext()) {
                    int t = cur.getInt(0);
                    if (t >= 0 && t < byType.length) byType[t]++;
                    if (cur.getInt(1) == 0) unread++;
                    if (total == 0) newestThread = cur.getLong(2);
                    total++;
                }
            }
        } catch (Exception e) {
            Spike.log("store_refused", "error", e.getClass().getSimpleName());
            return;
        }
        int threads;
        try (Cursor cur = cr.query(Uri.parse("content://mms-sms/conversations?simple=true"), new String[] {"_id"}, null, null, null)) {
            threads = cur == null ? -1 : cur.getCount();
        } catch (Exception e) {
            threads = -1;
        }
        Spike.log("store", "total", total, "inbox", byType[1], "sent", byType[2], "draft", byType[3], "outbox", byType[4], "failed", byType[5], "queued", byType[6],
                "unread", unread, "threads", threads, "newestThread", newestThread);
    }
}
