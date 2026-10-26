package de.schaefchens.ucap;

import android.content.Context;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Previews of the apps the person chose (docs/plan-m3.md, K5): their conversation notifications, read in a process of
 * its own (":previews"), so a crash here never takes the app's help with it (spike D: the app's process ran on, and
 * Android started the listener again after about a second).
 *
 * - **Each message once:** a messenger posts the whole recent conversation again with every new message; what was
 *   reported is kept (PreviewDb), and the server keeps each message once by its id anyway.
 * - **History is no news:** what an app shows from before the person chose it is reported as history.
 * - **A reply** handed to an app (PreviewSender) is sent once the app shows it as the person's own message. It goes
 *   through the conversation's last notification, also once the app took it away: heard, a conversation is marked read
 *   through the app's own action, and a messenger then removes its notification, while its reply action stays good.
 *   That last notification is kept in this process's memory only.
 * - **Read in the app:** when the app takes its conversation notification away itself, it was read there.
 *
 * Nothing is logged but counts and classes: a notification's words go to the person's server only.
 */
public class PreviewListener extends NotificationListenerService {
    /** The listener while Android has it connected: replies and "read" go through the notifications it sees. */
    static volatile PreviewListener running;
    /** One thread for everything of the previews, in order: a message is reported before a reply to it is taken. */
    static final ExecutorService WORK = Executors.newSingleThreadExecutor((r) -> new Thread(r, "ucap-previews"));
    /** Each conversation's last notification, by conversation: a reply goes through it once the app took it away. */
    static final Map<String, StatusBarNotification> LAST = new ConcurrentHashMap<>();

    @Override
    public void onListenerConnected() {
        running = this;
        WORK.execute(() -> {
            try {
                PreviewSync.state(this, "ready", null);
                for (StatusBarNotification s : active(this)) take(this, s);
                PreviewSync.runOrRetry(this);
                if (!PreviewSender.take(this)) PreviewJob.retry(this);
            } catch (Exception e) {
                android.util.Log.w("UCAP", "previews: " + e.getClass().getSimpleName());
            }
        });
    }

    @Override
    public void onListenerDisconnected() {
        if (running == this) running = null;
        WORK.execute(() -> {
            // Taken away in Android's settings: the person's connections are off until it is allowed again.
            if (!PreviewSync.accessGranted(this)) {
                PreviewSync.state(this, "off", "access");
                PreviewSync.runOrRetry(this);
            }
        });
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        WORK.execute(() -> {
            try {
                if (take(this, sbn)) PreviewSync.runOrRetry(this);
            } catch (Exception e) {
                android.util.Log.w("UCAP", "previews: " + e.getClass().getSimpleName());
            }
        });
    }

    /** Android 8+ says why a notification went (before it, this is not known): taken away by the app, it was read there. */
    @Override
    public void onNotificationRemoved(StatusBarNotification sbn, RankingMap ranking, int reason) {
        if (reason != REASON_APP_CANCEL && reason != REASON_APP_CANCEL_ALL) return;
        WORK.execute(() -> {
            try {
                if (readInApp(this, sbn)) PreviewSync.runOrRetry(this);
            } catch (Exception e) {
                android.util.Log.w("UCAP", "previews: " + e.getClass().getSimpleName());
            }
        });
    }

    /** The notifications Android shows now (none when the listener is not connected). */
    static StatusBarNotification[] active(NotificationListenerService l) {
        try {
            StatusBarNotification[] a = l.getActiveNotifications();
            return a == null ? new StatusBarNotification[0] : a;
        } catch (RuntimeException e) {
            return new StatusBarNotification[0];
        }
    }

    /** The notification shown now under this key, or null. */
    static StatusBarNotification shownNow(String key) {
        PreviewListener l = running;
        if (l == null || key == null) return null;
        try {
            StatusBarNotification[] a = l.getActiveNotifications(new String[] {key});
            return a != null && a.length > 0 ? a[0] : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /**
     * One notification of a chosen app: what is new in it, and the replies it now shows as sent. True when something
     * waits for the server.
     */
    static boolean take(Context ctx, StatusBarNotification sbn) {
        PreviewDb db = PreviewDb.get(ctx);
        PreviewDb.App app = db.app(sbn.getPackageName());
        if (app == null) return false;
        PreviewLogic.Shown s = PreviewNotes.read(sbn);
        if (s == null) return false;
        String conv = PreviewLogic.conversationId(s.pkg, s.key);
        db.rememberConversation(conv, s.pkg, sbn.getKey(), PreviewLogic.newestIncoming(s));
        if (s.canReply) LAST.put(conv, sbn);
        Set<String> before = db.seen(conv);
        Set<String> seen = new HashSet<>(before);
        List<JSONObject> events = PreviewLogic.events(s, seen, app.since);
        for (PreviewDb.Reply r : db.replies(conv)) {
            PreviewLogic.Line shown = PreviewLogic.confirms(s, r.words, r.handed);
            if (shown == null) continue;
            events.add(SmsEvents.result(r.request, "sent", PreviewLogic.messageId(s, shown), null));
            db.dropReply(r.request);
        }
        seen.removeAll(before);
        db.addSeen(conv, seen);
        if (events.isEmpty()) return false;
        JSONArray batch = new JSONArray();
        for (JSONObject e : events) batch.put(e);
        db.queue(app.connection, batch);
        return true;
    }

    /** The app took its conversation notification away itself: read there, as far as it showed. */
    static boolean readInApp(Context ctx, StatusBarNotification sbn) {
        PreviewDb db = PreviewDb.get(ctx);
        PreviewDb.App app = db.app(sbn.getPackageName());
        String[] known = db.conversationOfNotification(sbn.getKey());
        if (app == null || known == null || Long.parseLong(known[2]) < 0) return false;
        db.readUpTo(known[0], Long.parseLong(known[2]) * 1000);
        db.queue(app.connection, new JSONArray().put(read(known[0], Long.parseLong(known[2]))));
        return true;
    }

    /** "Read up to" this time in seconds: a preview's messages are ordered by their time (server/src/messaging/device.ts). */
    static JSONObject read(String conv, long upToSeconds) {
        try {
            return new JSONObject().put("t", "chat.read").put("chatId", conv).put("inboxMaxId", String.valueOf(upToSeconds)).put("outboxMaxId", JSONObject.NULL);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
