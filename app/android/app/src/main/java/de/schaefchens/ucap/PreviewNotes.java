package de.schaefchens.ucap;

import android.app.Notification;
import android.app.Person;
import android.os.Build;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.StatusBarNotification;
import java.util.ArrayList;
import java.util.List;

/**
 * A conversation notification (Notification.MessagingStyle) read out of Android's objects into PreviewLogic's plain
 * data (docs/plan-m3.md, K5). Android keeps a MessagingStyle's messages in the notification's extras as bundles
 * ("text", "time", "sender", and from Android 9 "sender_person"); the person's own messages have no sender, or the
 * person's own key. Not a conversation: a group's summary, and an app's notifications without messages (spike D:
 * Google Messages posts a "service" notification while it works).
 */
final class PreviewNotes {
    private PreviewNotes() {}

    @SuppressWarnings("deprecation")
    static PreviewLogic.Shown read(StatusBarNotification sbn) {
        Notification n = sbn.getNotification();
        if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0 || n.extras == null) return null;
        Bundle x = n.extras;
        Parcelable[] msgs = x.getParcelableArray(Notification.EXTRA_MESSAGES);
        if (msgs == null || msgs.length == 0) return null;
        String userKey = null;
        if (Build.VERSION.SDK_INT >= 28) {
            Person user = x.getParcelable(Notification.EXTRA_MESSAGING_PERSON);
            if (user != null) userKey = user.getKey();
        }
        List<PreviewLogic.Line> lines = new ArrayList<>();
        for (Parcelable p : msgs) {
            if (!(p instanceof Bundle)) continue;
            Bundle b = (Bundle) p;
            CharSequence text = b.getCharSequence("text");
            if (text == null) continue;
            String sender = null;
            String key = null;
            if (Build.VERSION.SDK_INT >= 28) {
                Person sp = b.getParcelable("sender_person");
                if (sp != null) {
                    sender = str(sp.getName());
                    key = sp.getKey();
                }
            }
            if (sender == null) sender = str(b.getCharSequence("sender"));
            boolean self = sender == null || (userKey != null && userKey.equals(key));
            lines.add(new PreviewLogic.Line(self ? null : sender, self ? null : key, b.getLong("time"), text.toString(), self));
        }
        if (lines.isEmpty()) return null;
        String title = str(x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE));
        boolean group = Build.VERSION.SDK_INT >= 28 ? x.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, title != null) : title != null;
        // The conversation, never its content: the app's own shortcut for it where it has one (Android 11+), else the
        // notification's key (its tag and id stay with the conversation).
        String shortcut = Build.VERSION.SDK_INT >= 30 ? n.getShortcutId() : null;
        String convKey = shortcut != null && !shortcut.isEmpty() ? "s:" + shortcut : "k:" + sbn.getKey();
        return new PreviewLogic.Shown(sbn.getPackageName(), convKey, title, group, lines, replyAction(n) != null, readAction(n) != null);
    }

    /** The action that takes typed words: the reply (Android 9+ says which), else the first with an input. */
    static Notification.Action replyAction(Notification n) {
        if (n.actions == null) return null;
        Notification.Action found = null;
        for (Notification.Action a : n.actions) {
            if (a.getRemoteInputs() == null || a.getRemoteInputs().length == 0) continue;
            if (Build.VERSION.SDK_INT >= 28 && a.getSemanticAction() == Notification.Action.SEMANTIC_ACTION_REPLY) return a;
            if (found == null) found = a;
        }
        return found;
    }

    /** The app's own "mark as read" (Android 9+ names it), or null. */
    static Notification.Action readAction(Notification n) {
        if (n.actions == null || Build.VERSION.SDK_INT < 28) return null;
        for (Notification.Action a : n.actions) if (a.getSemanticAction() == Notification.Action.SEMANTIC_ACTION_MARK_AS_READ) return a;
        return null;
    }

    private static String str(CharSequence s) {
        return s == null || s.length() == 0 ? null : s.toString();
    }
}
