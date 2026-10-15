package de.schaefchens.ucap.spike;

import android.app.Notification;
import android.app.Person;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Previews (docs/plan-m3.md, K5), in the process ":previews": conversation notifications (MessagingStyle) of the
 * watched apps. Each message is told once, although a messenger posts the whole conversation again with every new
 * one; a conversation is kept by its notification's key, so a reply goes back through it and never by its content.
 */
public class PreviewListener extends NotificationListenerService {
    static final Set<String> WATCH = new HashSet<>(Arrays.asList("de.schaefchens.ucap.spike.messenger", "com.google.android.apps.messaging"));
    static final Map<String, StatusBarNotification> LATEST = new ConcurrentHashMap<>();
    static final Set<String> SEEN = ConcurrentHashMap.newKeySet();
    static volatile String replyText;
    static volatile String replyKey;
    static volatile long replyAt;
    static volatile int posts;

    @Override
    public void onListenerConnected() {
        StatusBarNotification[] active = null;
        try {
            active = getActiveNotifications();
        } catch (Exception e) {
            active = null;
        }
        Spike.log("listener_connected", "active", active == null ? -1 : active.length);
        if (active != null) for (StatusBarNotification s : active) onNotificationPosted(s);
    }

    @Override
    public void onListenerDisconnected() {
        Spike.log("listener_disconnected");
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (!WATCH.contains(sbn.getPackageName())) return;
        long now = System.currentTimeMillis();
        posts++;
        Notification n = sbn.getNotification();
        Bundle x = n.extras;
        String pkg = sbn.getPackageName().substring(sbn.getPackageName().lastIndexOf('.') + 1);
        String conv = Spike.hash(sbn.getKey());
        Parcelable[] msgs = x.getParcelableArray(Notification.EXTRA_MESSAGES);
        if (msgs == null) {
            CharSequence text = x.getCharSequence(Notification.EXTRA_TEXT);
            Spike.log("preview_other", "pkg", pkg, "conv", conv, "category", n.category, "len", text == null ? 0 : text.length(), "digits", Spike.digits(text));
            return;
        }
        LATEST.put(sbn.getKey(), sbn);
        Person user = x.getParcelable(Notification.EXTRA_MESSAGING_PERSON);
        int fresh = 0;
        for (Parcelable p : msgs) {
            if (!(p instanceof Bundle)) continue;
            Bundle b = (Bundle) p;
            CharSequence text = b.getCharSequence("text");
            long time = b.getLong("time");
            Person sp = b.getParcelable("sender_person");
            CharSequence sender = sp != null ? sp.getName() : b.getCharSequence("sender");
            boolean self = sender == null || (user != null && sp != null && user.getKey() != null && user.getKey().equals(sp.getKey()));
            String key = sbn.getKey() + "|" + sender + "|" + time + "|" + text;
            if (!SEEN.add(key)) continue;
            fresh++;
            Spike.log("preview_msg", "pkg", pkg, "conv", conv, "self", self, "len", text == null ? 0 : text.length(), "textHash", Spike.hash(text),
                    "digits", Spike.digits(text), "lagMs", now - time, "group", x.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION));
            String waiting = replyText;
            if (self && waiting != null && sbn.getKey().equals(replyKey) && text != null && waiting.contentEquals(text)) {
                Spike.log("reply_confirmed", "conv", conv, "ms", now - replyAt);
                replyText = null;
            }
        }
        int replies = 0;
        int reads = 0;
        if (n.actions != null) {
            for (Notification.Action a : n.actions) {
                if (a.getRemoteInputs() != null && a.getRemoteInputs().length > 0) replies++;
                if (a.getSemanticAction() == Notification.Action.SEMANTIC_ACTION_MARK_AS_READ) reads++;
            }
        }
        Spike.log("preview_post", "pkg", pkg, "conv", conv, "messages", msgs.length, "fresh", fresh, "replyActions", replies, "readActions", reads,
                "titled", x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE) != null, "posts", posts);
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn, RankingMap ranking, int reason) {
        if (!WATCH.contains(sbn.getPackageName())) return;
        Spike.log("preview_removed", "conv", Spike.hash(sbn.getKey()), "reason", reason);
    }
}
