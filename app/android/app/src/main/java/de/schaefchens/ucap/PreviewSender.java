package de.schaefchens.ucap;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Replies through another app's notification (docs/plan-m3.md, K5): what the person confirmed on any of their devices,
 * taken from the server (signed: what waits for this phone's previews), handed to the app through its conversation
 * notification's own reply action, never by its content. Then "pending" for the server, and "sent" once the app shows
 * it as the person's own message (PreviewListener; spike D: 214 ms). It goes through the conversation's notification,
 * or, once the app took that away (marked read, say), through the last one this process saw. Not sent: there is none
 * ("gone"), it offers no reply ("no_reply"), the app was stopped and its actions with it ("app_stopped", spike D), or
 * UCAP may no longer read the notifications ("off"). Never handed over twice. In the previews process.
 */
final class PreviewSender {
    private PreviewSender() {}

    private static final String OUTBOUND = "/api/v1/messaging/device/outbound";

    /** Takes what waits for this phone's previews and hands it over; false when that has to wait (try again later). */
    static boolean take(Context ctx) {
        PreviewDb db = PreviewDb.get(ctx);
        if (db.apps().isEmpty()) return true;
        // Only the running listener sees the notifications: after a restart Android connects it within a second or so.
        if (PreviewListener.running == null) return !PreviewSync.accessGranted(ctx);
        java.util.Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("service", "notifications");
        Api.Result r = Api.signed(ctx, "POST", OUTBOUND, body, Api.idem(), 15_000);
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
            if (s != null) reply(ctx, s.optString("id"), s.optString("connectionId"), s.optString("chatId"), s.optString("text"));
        }
        PreviewSync.runOrRetry(ctx);
        return true;
    }

    static void reply(Context ctx, String requestId, String connectionId, String conv, String text) {
        PreviewDb db = PreviewDb.get(ctx);
        String error = null;
        StatusBarNotification sbn = null;
        Notification.Action action = null;
        PreviewDb.App app = db.appOf(connectionId);
        if (PreviewListener.running == null) error = "off";
        else if (app != null && stopped(ctx, app.pkg)) error = "app_stopped";
        else {
            // Taken away by the app (marked read, say): its last notification's reply still reaches it.
            sbn = PreviewListener.shownNow(db.notificationOf(conv));
            if (sbn == null) sbn = PreviewListener.LAST.get(conv);
            if (sbn == null) error = "gone";
            else if ((action = PreviewNotes.replyAction(sbn.getNotification())) == null) error = "no_reply";
        }
        if (error == null) {
            // Kept before it is handed over: the app may show it as sent before this returns.
            db.addReply(requestId, conv, text);
            try {
                action.actionIntent.send(ctx, 0, filled(action, text));
            } catch (PendingIntent.CanceledException e) {
                db.dropReply(requestId);
                PreviewListener.LAST.remove(conv);
                error = app != null && stopped(ctx, app.pkg) ? "app_stopped" : "gone";
            }
        }
        JSONObject result = error == null ? SmsEvents.result(requestId, "pending_service", null, null) : SmsEvents.result(requestId, "failed", null, error);
        db.queue(connectionId, new JSONArray().put(result));
    }

    /**
     * Whether the app was stopped (a force stop, spike D: its notifications and their actions gone with it): Android keeps
     * it so until it is opened again.
     */
    static boolean stopped(Context ctx, String pkg) {
        try {
            return (ctx.getPackageManager().getApplicationInfo(pkg, 0).flags & ApplicationInfo.FLAG_STOPPED) != 0;
        } catch (PackageManager.NameNotFoundException e) {
            return true;
        }
    }

    /** The reply's words in the action's input, as a keyboard would put them there. */
    private static Intent filled(Notification.Action action, String text) {
        RemoteInput[] inputs = action.getRemoteInputs();
        Bundle results = new Bundle();
        for (RemoteInput ri : inputs) {
            if (!ri.getAllowFreeFormInput()) continue;
            results.putCharSequence(ri.getResultKey(), text);
            break;
        }
        Intent fill = new Intent();
        RemoteInput.addResultsToIntent(inputs, fill, results);
        if (Build.VERSION.SDK_INT >= 28) RemoteInput.setResultsSource(fill, RemoteInput.SOURCE_FREE_FORM_INPUT);
        return fill;
    }

    /** The person heard these messages: once every message of others the notification shows was heard, it is read. */
    static void heard(Context ctx, String connectionId, String conv, String[] ids) {
        PreviewDb db = PreviewDb.get(ctx);
        PreviewDb.App app = db.appOf(connectionId);
        if (app == null || ids == null || ids.length == 0) return;
        db.addHeard(conv, ids);
        StatusBarNotification sbn = PreviewListener.shownNow(db.notificationOf(conv));
        if (sbn == null || !app.pkg.equals(sbn.getPackageName())) return;
        PreviewLogic.Shown s = PreviewNotes.read(sbn);
        Notification.Action read = PreviewNotes.readAction(sbn.getNotification());
        if (s == null || read == null || !PreviewLogic.allHeard(s, db.heard(conv), db.readUpTo(conv))) return;
        try {
            read.actionIntent.send(ctx, 0, new Intent());
            db.readUpTo(conv, PreviewLogic.newestIncoming(s) * 1000);
        } catch (PendingIntent.CanceledException e) {
            // The app was stopped: its notification goes with it, and the conversation stays unread there.
        }
    }
}
