package de.schaefchens.ucap;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/**
 * The rules of previews (docs/plan-m3.md, K5) over what a conversation notification showed, as plain data, so they are
 * unit-tested on the JVM (PreviewLogicTest); PreviewNotes reads that data out of Android's objects.
 *
 * - **Ids:** a conversation is its notification (its shortcut, or its key), never its content (lookup: "the latest
 *   notification containing X" sent replies to another conversation). A message's id is the app, the conversation,
 *   who wrote, when and what: a messenger posts the whole recent conversation again with every new message, and the
 *   same message always gets the same id, so the server keeps it once (spike D: "each message once belongs on the
 *   server").
 * - **People** in a preview are only the names its notifications show: never a contact by themselves.
 * - **A reply** counts as sent once the app shows it as the person's own message in that conversation.
 * - **Read:** the app's mark-as-read action is used once the person heard every message its notification shows.
 */
final class PreviewLogic {
    private PreviewLogic() {}

    /** One message a notification shows: who (null: the person), when, what. */
    static final class Line {
        final String sender;
        /** The sender's key where the app gives one (Person.getKey()), else null. */
        final String senderKey;
        final long time;
        final String text;
        final boolean self;

        Line(String sender, String senderKey, long time, String text, boolean self) {
            this.sender = sender;
            this.senderKey = senderKey;
            this.time = time;
            this.text = text == null ? "" : text;
            this.self = self;
        }
    }

    /** One conversation notification, as PreviewNotes read it. */
    static final class Shown {
        final String pkg;
        /** What keeps the conversation: "s:" and its shortcut id, else "k:" and the notification's key. */
        final String key;
        /** The conversation's title (a group's name), or null. */
        final String title;
        final boolean group;
        final List<Line> lines;
        final boolean canReply;
        final boolean canMarkRead;

        Shown(String pkg, String key, String title, boolean group, List<Line> lines, boolean canReply, boolean canMarkRead) {
            this.pkg = pkg;
            this.key = key;
            this.title = title;
            this.group = group;
            this.lines = lines;
            this.canReply = canReply;
            this.canMarkRead = canMarkRead;
        }
    }

    /** A short, stable digest: 24 hex characters of SHA-256. */
    static String hash(String s) {
        byte[] h = SignedRequest.sha256(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < 12; i++) out.append(String.format("%02x", h[i]));
        return out.toString();
    }

    static String conversationId(String pkg, String key) {
        return "c" + hash(pkg + "|" + key);
    }

    /** A person of the app, by their key where it has one, else by the name its notifications show. */
    static String personId(String pkg, Line l) {
        return "p" + hash(pkg + "|" + (l.senderKey != null && !l.senderKey.isEmpty() ? "k:" + l.senderKey : "n:" + (l.sender == null ? "" : l.sender)));
    }

    static String messageId(Shown s, Line l) {
        String who = l.self ? "self" : personId(s.pkg, l);
        return "m" + hash(s.pkg + "|" + s.key + "|" + who + "|" + l.time + "|" + l.text);
    }

    /** The conversation's name: a group's title, else the other person's name (the first who wrote), else the title. */
    static String title(Shown s) {
        if (s.group && s.title != null && !s.title.isEmpty()) return s.title;
        for (Line l : s.lines) if (!l.self && l.sender != null && !l.sender.isEmpty()) return l.sender;
        return s.title != null && !s.title.isEmpty() ? s.title : "?";
    }

    /** The other person of a private conversation, or null (a group, or only the person's own messages so far). */
    static Line peer(Shown s) {
        if (s.group) return null;
        for (Line l : s.lines) if (!l.self) return l;
        return null;
    }

    /**
     * The events for what is new in this notification (`seen`: message ids reported before; each new one is added to
     * it): the conversation and its people, then the messages, oldest first. `liveSince`: a message from before it
     * (when the person connected the app) is history, no news.
     */
    static List<JSONObject> events(Shown s, Set<String> seen, long liveSince) {
        List<JSONObject> out = new ArrayList<>();
        List<Line> fresh = new ArrayList<>();
        for (Line l : s.lines) if (seen.add(messageId(s, l))) fresh.add(l);
        if (fresh.isEmpty()) return out;
        String conv = conversationId(s.pkg, s.key);
        Set<String> people = new LinkedHashSet<>();
        for (Line l : s.lines) {
            if (l.self || !people.add(personId(s.pkg, l))) continue;
            out.add(SmsEvents.user(personId(s.pkg, l), l.sender == null || l.sender.isEmpty() ? "?" : l.sender, false));
        }
        Line peer = peer(s);
        out.add(SmsEvents.chat(conv, title(s), s.group, peer == null ? null : personId(s.pkg, peer)));
        for (Line l : fresh) {
            boolean live = !l.self && l.time >= liveSince;
            out.add(SmsEvents.message(conv, messageId(s, l), l.self ? null : personId(s.pkg, l), l.self, l.time, "text", l.text, live));
        }
        return out;
    }

    /**
     * Whether a reply handed to the app at `handedAt` now shows as the person's own message in this notification: the
     * same words (spaces aside), shown no earlier than a minute before it was handed over. Returns that line, or null.
     */
    static Line confirms(Shown s, String text, long handedAt) {
        String want = text == null ? "" : text.trim().replaceAll("\\s+", " ");
        for (Line l : s.lines) {
            if (!l.self || l.time < handedAt - 60_000) continue;
            if (l.text.trim().replaceAll("\\s+", " ").equals(want)) return l;
        }
        return null;
    }

    /**
     * Whether every message of others this notification shows is done (then it may be marked read): heard, or read
     * before (`readUpTo`, in milliseconds: a messenger may show messages it was told were read again with a new one).
     */
    static boolean allHeard(Shown s, Collection<String> heard, long readUpTo) {
        boolean any = false;
        for (Line l : s.lines) {
            if (l.self || l.time <= readUpTo) continue;
            any = true;
            if (!heard.contains(messageId(s, l))) return false;
        }
        return any;
    }

    /** The newest time of others' messages shown, in seconds: how far the conversation was read when the app read it. */
    static long newestIncoming(Shown s) {
        long t = -1;
        for (Line l : s.lines) if (!l.self) t = Math.max(t, l.time);
        return t < 0 ? -1 : t / 1000;
    }
}
