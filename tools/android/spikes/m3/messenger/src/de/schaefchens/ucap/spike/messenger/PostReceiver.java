package de.schaefchens.ucap.spike.messenger;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * adb's commands: a new message, or everything cleared.
 * `adb shell am broadcast -n de.schaefchens.ucap.spike.messenger/.PostReceiver --es cmd post --es conv anna --es sender "Anna Beispiel" --es text "…" [--ez group true --es title Familie]`.
 */
public class PostReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String cmd = String.valueOf(i.getStringExtra("cmd"));
        if ("clear".equals(cmd)) {
            c.getSystemService(NotificationManager.class).cancelAll();
            Messenger.prefs(c).edit().clear().commit();
            Spike.log("messenger_clear");
            return;
        }
        String conv = i.getStringExtra("conv");
        String sender = i.getStringExtra("sender");
        String text = i.getStringExtra("text");
        if (conv == null || sender == null || text == null) {
            Spike.log("messenger_post_incomplete");
            return;
        }
        boolean group = i.getBooleanExtra("group", false);
        Messenger.add(c, conv, sender, text, false);
        Messenger.show(c, conv, i.getStringExtra("title"), group);
        Spike.log("messenger_post", "textHash", Spike.hash(text), "len", text.length(), "digits", Spike.digits(text), "group", group);
    }
}
