package de.schaefchens.ucap;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.ContactsContract;
import android.telecom.Call;
import android.telecom.DisconnectCause;
import java.text.DateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * The calls UCAP sees as the phone app (docs/plan-m4.md, G10): as each one ends, who (the number, and the name the
 * phone's contacts give it), in or out, answered, missed or declined, when and how long go to the server, signed with
 * the device's key, so it works with the app closed; offline, the outbox sends it later. A missed call also waits in the
 * notifications; the app says it once, through the server. Nothing of a call is logged.
 */
final class Calls {
    private Calls() {}

    static final String PATH = "/api/v1/devices/current/calls";
    static final String CHANNEL = "ucap-calls";
    /** Per call: when it began, when it was answered (0: never), whether it came in. */
    private static final Map<Call, long[]> times = new HashMap<>();

    static String number(Call call) {
        Uri h = call.getDetails().getHandle();
        return h == null ? "" : h.getSchemeSpecificPart();
    }

    /** The name the phone's contacts give the number, if UCAP may read them (the phone role grants it). */
    static String name(Context c, String number) {
        if (number.isEmpty() || c.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) return null;
        Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
        try (Cursor cur = c.getContentResolver().query(uri, new String[] { ContactsContract.PhoneLookup.DISPLAY_NAME }, null, null, null)) {
            return cur != null && cur.moveToFirst() ? cur.getString(0) : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** A call came to UCAP: an incoming one rings first (Call.Details' direction needs Android 10). */
    @SuppressWarnings("deprecation")
    static synchronized void started(Call call) {
        times.put(call, new long[] { System.currentTimeMillis(), 0, call.getState() == Call.STATE_RINGING ? 1 : 0 });
    }

    static synchronized void answered(Call call) {
        long[] t = times.get(call);
        if (t != null && t[1] == 0) t[1] = System.currentTimeMillis();
    }

    /** How a call ended: answered once it was active; else as Android says; an incoming one nobody answered was missed. */
    static String outcome(boolean answered, int cause, boolean incoming) {
        if (answered) return "answered";
        if (cause == DisconnectCause.REJECTED) return "declined";
        if (incoming || cause == DisconnectCause.MISSED) return "missed";
        return "unanswered";
    }

    /**
     * One call as the server takes it (server/src/core/routes/calls.ts): these fields only, a name only if there is one;
     * a Map, as the canonical JSON of a signed request takes it.
     */
    static Map<String, Object> entry(String id, String number, String name, boolean incoming, String outcome, long at, int durationS) {
        Map<String, Object> o = new HashMap<>();
        o.put("id", id);
        o.put("number", number.length() > 40 ? number.substring(0, 40) : number);
        o.put("dir", incoming ? "in" : "out");
        o.put("outcome", outcome);
        o.put("at", at);
        o.put("durationS", Math.max(0, Math.min(durationS, 86_400)));
        if (name != null && !name.isEmpty()) o.put("name", name.length() > 100 ? name.substring(0, 100) : name);
        return o;
    }

    /** A call ended: told to the server; a missed one also in the notifications. */
    static synchronized void ended(Context c, Call call) {
        long[] t = times.remove(call);
        if (t == null) return;
        boolean in = t[2] == 1;
        DisconnectCause dc = call.getDetails().getDisconnectCause();
        String outcome = outcome(t[1] != 0, dc == null ? DisconnectCause.UNKNOWN : dc.getCode(), in);
        String number = number(call);
        String name = name(c, number);
        int duration = t[1] == 0 ? 0 : (int) ((System.currentTimeMillis() - t[1]) / 1000);
        Map<String, Object> body = new HashMap<>();
        body.put("calls", Collections.singletonList(entry(UUID.randomUUID().toString(), number, name, in, outcome, t[0], duration)));
        report(c, body);
        if ("missed".equals(outcome)) notifyMissed(c, name != null ? name : number, t[0]);
    }

    /** At once where there is a network; otherwise the outbox tries again, with the same idempotency key. */
    private static void report(Context c, Map<String, Object> body) {
        Context app = c.getApplicationContext();
        String jcs = SignedRequest.jcs(body);
        String idem = Api.idem();
        new Thread(() -> {
            Api.Result r = Api.signedJcs(app, "POST", PATH, jcs, idem, 10_000);
            if (r.retry()) Outbox.add(app, Outbox.entry("call", "POST", PATH, jcs, idem));
        }, "ucap-call").start();
    }

    private static void notifyMissed(Context c, String who, long at) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(new NotificationChannel(CHANNEL, Texts.get(c, "calls.channel"), NotificationManager.IMPORTANCE_DEFAULT));
        PendingIntent open = PendingIntent.getActivity(c, 4301, new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String time = DateFormat.getTimeInstance(DateFormat.SHORT, "en".equals(Ref.lang(c)) ? Locale.ENGLISH : Locale.GERMAN).format(new Date(at));
        @SuppressWarnings("deprecation")
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
        b.setSmallIcon(android.R.drawable.sym_call_missed).setContentTitle(Texts.get(c, "calls.missed")).setContentText(who + ", " + time).setContentIntent(open).setAutoCancel(true).setShowWhen(true).setWhen(at);
        nm.notify((int) (at % 100000) + 5000, b.build());
    }
}
