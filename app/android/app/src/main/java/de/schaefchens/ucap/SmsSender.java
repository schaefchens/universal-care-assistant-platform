package de.schaefchens.ucap;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.telephony.SmsManager;
import android.telephony.SubscriptionManager;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Sending SMS as the SMS app (docs/plan-m3.md, K4): the replies the person confirmed on any of their devices, taken
 * from the server (signed: what waits for this phone), new SMS to a number of one of the person's contacts (K6), and
 * SMS the phone itself is asked to send (a quick reply to a call). In the SMS process.
 * - Written to Android's store as outgoing first, then handed to the network: "pending" for the server.
 * - "Sent" at the network's report on every part (a long SMS goes in parts); "failed" with the network's code. The
 *   delivery report, where the network sends one, is kept too (SmsReportReceiver).
 * - On the SIM Android uses for SMS. Never sent again by itself.
 */
final class SmsSender {
    private SmsSender() {}

    private static final String OUTBOUND = "/api/v1/messaging/device/outbound";

    /** Takes what waits for this phone and sends it; false when the server could not be asked (try again later). */
    static boolean take(Context ctx) {
        if (SmsSync.connection(ctx) == null || !SmsRole.held(ctx)) return true;
        Api.Result r = Api.signed(ctx, "POST", OUTBOUND, new java.util.LinkedHashMap<String, Object>(), Api.idem(), 15_000);
        if (!r.ok()) return !r.retry();
        JSONArray sends;
        try {
            sends = new JSONObject(r.body).optJSONArray("sends");
        } catch (Exception e) {
            return true;
        }
        if (sends == null) return true;
        for (int i = 0; i < sends.length(); i++) {
            JSONObject s = sends.optJSONObject(i);
            if (s == null) continue;
            String to = s.optString("to");
            // A new SMS (K6): no thread yet; Android finds or makes the one for its number.
            if (s.optString("chatId").isEmpty() && !to.isEmpty()) sendNew(ctx, s.optString("id"), to, s.optString("text"));
            else send(ctx, s.optString("id"), s.optString("chatId"), s.optString("text"));
        }
        return true;
    }

    /** One reply into a thread there is: to its one other side (a group MMS reply is not possible yet). */
    static void send(Context ctx, String requestId, String chatId, String text) {
        SmsDb db = SmsDb.get(ctx);
        long thread;
        try {
            thread = Long.parseLong(chatId);
        } catch (NumberFormatException e) {
            db.queue(new JSONArray().put(SmsEvents.result(requestId, "failed", null, "no_recipient")));
            return;
        }
        List<String> to = SmsStore.recipients(ctx, thread);
        if (to.size() != 1 || text == null || text.isEmpty()) {
            db.queue(new JSONArray().put(SmsEvents.result(requestId, "failed", null, to.size() > 1 ? "group" : "no_recipient")));
            return;
        }
        sendTo(ctx, requestId, to.get(0), text, thread);
    }

    /** A new SMS to a number the server took from the person's contacts: one number (E.164) or a short number. */
    static void sendNew(Context ctx, String requestId, String to, String text) {
        if (!to.matches("^(\\+[0-9]{6,15}|[1-9][0-9]{2,5})$") || text == null || text.isEmpty()) {
            SmsDb.get(ctx).queue(new JSONArray().put(SmsEvents.result(requestId, "failed", null, "no_recipient")));
            return;
        }
        sendTo(ctx, requestId, to, text, 0);
    }

    /** An SMS to a number, its thread found or made by Android; `requestId` null when the server did not ask for it. */
    static void sendTo(Context ctx, String requestId, String address, String text, long thread) {
        SmsDb db = SmsDb.get(ctx);
        if (thread <= 0) thread = android.provider.Telephony.Threads.getOrCreateThreadId(ctx, address);
        long id = SmsStore.insertOutbox(ctx, address, text, thread);
        if (id < 0) {
            if (requestId != null) db.queue(new JSONArray().put(SmsEvents.result(requestId, "failed", null, "store")));
            return;
        }
        SmsManager sm = manager(ctx);
        ArrayList<String> parts = sm.divideMessage(text);
        db.addSend(id, requestId, String.valueOf(thread), parts.size());
        if (requestId != null) db.queue(new JSONArray().put(SmsEvents.result(requestId, "pending_service", null, null)));
        ArrayList<PendingIntent> sent = new ArrayList<>();
        ArrayList<PendingIntent> delivered = new ArrayList<>();
        for (int p = 0; p < parts.size(); p++) {
            sent.add(report(ctx, "sent", id, p));
            delivered.add(report(ctx, "delivered", id, p));
        }
        try {
            if (parts.size() == 1) sm.sendTextMessage(address, null, parts.get(0), sent.get(0), delivered.get(0));
            else sm.sendMultipartTextMessage(address, null, parts, sent, delivered);
        } catch (Exception e) {
            // Not handed to the network at all (no service, a bad number): failed now, never sent again by itself.
            SmsStore.setType(ctx, id, SmsStore.FAILED);
            db.dropSend(id);
            if (requestId != null) db.queue(new JSONArray().put(SmsEvents.result(requestId, "failed", null, "sms_refused")));
            android.util.Log.w("UCAP", "sms: not handed to the network: " + e.getClass().getSimpleName());
        }
    }

    /** The SIM Android uses for SMS (dual SIM: the one chosen there). */
    static SmsManager manager(Context ctx) {
        return manager(ctx, SubscriptionManager.getDefaultSmsSubscriptionId());
    }

    /** The SIM a message came in on (an MMS is fetched through the network that announced it), else the default. */
    static SmsManager manager(Context ctx, int sub) {
        if (sub < 0) sub = SubscriptionManager.getDefaultSmsSubscriptionId();
        if (Build.VERSION.SDK_INT >= 31) {
            SmsManager base = ctx.getSystemService(SmsManager.class);
            return sub != SubscriptionManager.INVALID_SUBSCRIPTION_ID ? base.createForSubscriptionId(sub) : base;
        }
        return sub != SubscriptionManager.INVALID_SUBSCRIPTION_ID ? SmsManager.getSmsManagerForSubscriptionId(sub) : SmsManager.getDefault();
    }

    /** Explicit and mutable: only UCAP's receiver gets it, and the radio adds its code and the report's PDU. */
    private static PendingIntent report(Context ctx, String kind, long id, int part) {
        Intent i = new Intent(ctx, SmsReportReceiver.class)
            .setData(Uri.parse("ucap-sms://" + kind + "/" + id + "/" + part))
            .putExtra("kind", kind)
            .putExtra("id", id)
            .putExtra("part", part);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        return PendingIntent.getBroadcast(ctx, 0, i, flags);
    }
}
