package de.schaefchens.ucap.spike.messenger;

import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/** A reply from the notification: kept, and shown in the same notification as the person's own message. */
public class ReplyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        Bundle r = RemoteInput.getResultsFromIntent(i);
        CharSequence text = r == null ? null : r.getCharSequence("reply_text");
        String conv = i.getStringExtra("conv");
        if (text == null || conv == null) {
            Spike.log("messenger_reply_empty");
            return;
        }
        Messenger.add(c, conv, "Ich", text.toString(), true);
        Messenger.show(c, conv, i.getStringExtra("title"), i.getBooleanExtra("group", false));
        Spike.log("messenger_reply", "textHash", Spike.hash(text), "len", text.length());
    }
}
