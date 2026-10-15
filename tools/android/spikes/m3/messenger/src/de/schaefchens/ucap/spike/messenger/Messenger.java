package de.schaefchens.ucap.spike.messenger;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.drawable.Icon;
import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;

/** A conversation's history (kept across processes) and its notification, posted as messengers post theirs. */
final class Messenger {
    private Messenger() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("history", Context.MODE_PRIVATE);
    }

    static JSONArray history(Context c, String conv) {
        try {
            return new JSONArray(prefs(c).getString(conv, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static void add(Context c, String conv, String sender, String text, boolean self) {
        JSONArray h = history(c, conv);
        try {
            JSONObject m = new JSONObject();
            m.put("sender", sender);
            m.put("text", text);
            m.put("time", System.currentTimeMillis());
            m.put("self", self);
            h.put(m);
        } catch (Exception e) {
            return;
        }
        prefs(c).edit().putString(conv, h.toString()).commit();
    }

    /** The last seven messages of the conversation, again, with a reply action and a mark-as-read action. */
    static void show(Context c, String conv, String title, boolean group) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel("messages") == null) nm.createNotificationChannel(new NotificationChannel("messages", "Nachrichten", NotificationManager.IMPORTANCE_HIGH));
        Person me = new Person.Builder().setName("Ich").setKey("me").build();
        Notification.MessagingStyle style = new Notification.MessagingStyle(me);
        if (group) {
            style.setConversationTitle(title);
            style.setGroupConversation(true);
        }
        JSONArray h = history(c, conv);
        for (int k = Math.max(0, h.length() - 7); k < h.length(); k++) {
            JSONObject m = h.optJSONObject(k);
            if (m == null) continue;
            Person sender = m.optBoolean("self") ? null : new Person.Builder().setName(m.optString("sender")).setKey("p:" + m.optString("sender")).build();
            style.addMessage(new Notification.MessagingStyle.Message(m.optString("text"), m.optLong("time"), sender));
        }
        Intent ri = new Intent(c, ReplyReceiver.class).setData(Uri.parse("standin://reply/" + conv)).putExtra("conv", conv).putExtra("title", title).putExtra("group", group);
        PendingIntent replyPi = PendingIntent.getBroadcast(c, 1, ri, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        Notification.Action reply = new Notification.Action.Builder(Icon.createWithResource(c, android.R.drawable.ic_menu_send), "Antworten", replyPi)
                .addRemoteInput(new RemoteInput.Builder("reply_text").setLabel("Antworten").build())
                .setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY)
                .setAllowGeneratedReplies(false)
                .build();
        Intent di = new Intent(c, ReadReceiver.class).setData(Uri.parse("standin://read/" + conv)).putExtra("conv", conv);
        PendingIntent readPi = PendingIntent.getBroadcast(c, 2, di, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Action read = new Notification.Action.Builder(Icon.createWithResource(c, android.R.drawable.ic_menu_view), "Gelesen", readPi)
                .setSemanticAction(Notification.Action.SEMANTIC_ACTION_MARK_AS_READ)
                .build();
        Notification n = new Notification.Builder(c, "messages")
                .setSmallIcon(android.R.drawable.sym_action_chat)
                .setStyle(style)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .addAction(reply)
                .addAction(read)
                .setShowWhen(true)
                .build();
        nm.notify(conv, 1, n);
    }
}
