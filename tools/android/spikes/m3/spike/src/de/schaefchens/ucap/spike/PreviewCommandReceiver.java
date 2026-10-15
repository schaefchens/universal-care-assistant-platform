package de.schaefchens.ucap.spike;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;

/**
 * adb's commands to the ":previews" process:
 * `adb shell am broadcast -n de.schaefchens.ucap.spike/.PreviewCommandReceiver --es cmd ping|reply|markread|crash [--es text …]`.
 * A reply and "read" go to the newest conversation, through its own notification's actions.
 */
public class PreviewCommandReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String cmd = String.valueOf(i.getStringExtra("cmd"));
        if ("ping".equals(cmd)) {
            Spike.log("ping_previews", "conversations", PreviewListener.LATEST.size(), "seen", PreviewListener.SEEN.size());
            return;
        }
        if ("crash".equals(cmd)) {
            Spike.log("crash_now");
            throw new IllegalStateException("spike: the previews process fails on purpose");
        }
        StatusBarNotification sbn = newest();
        if (sbn == null) {
            Spike.log(cmd + "_nothing");
            return;
        }
        if ("reply".equals(cmd)) reply(c, sbn, i.getStringExtra("text"));
        else if ("markread".equals(cmd)) markRead(c, sbn);
        else Spike.log("unknown_command", "cmd", cmd);
    }

    static StatusBarNotification newest() {
        StatusBarNotification best = null;
        for (StatusBarNotification s : PreviewListener.LATEST.values()) if (best == null || s.getPostTime() > best.getPostTime()) best = s;
        return best;
    }

    static void reply(Context c, StatusBarNotification sbn, String text) {
        Notification.Action reply = null;
        Notification.Action[] actions = sbn.getNotification().actions;
        if (actions != null) {
            for (Notification.Action a : actions) {
                if (a.getRemoteInputs() == null || a.getRemoteInputs().length == 0) continue;
                if (reply == null || a.getSemanticAction() == Notification.Action.SEMANTIC_ACTION_REPLY) reply = a;
            }
        }
        String conv = Spike.hash(sbn.getKey());
        if (reply == null || text == null) {
            Spike.log("reply_impossible", "conv", conv);
            return;
        }
        Intent fill = new Intent();
        Bundle results = new Bundle();
        for (RemoteInput ri : reply.getRemoteInputs()) results.putCharSequence(ri.getResultKey(), text);
        RemoteInput.addResultsToIntent(reply.getRemoteInputs(), fill, results);
        RemoteInput.setResultsSource(fill, RemoteInput.SOURCE_FREE_FORM_INPUT);
        PreviewListener.replyText = text;
        PreviewListener.replyKey = sbn.getKey();
        PreviewListener.replyAt = System.currentTimeMillis();
        long t = System.currentTimeMillis();
        try {
            reply.actionIntent.send(c, 0, fill);
            Spike.log("reply_handed", "conv", conv, "ms", System.currentTimeMillis() - t, "textHash", Spike.hash(text));
        } catch (PendingIntent.CanceledException e) {
            PreviewListener.replyText = null;
            Spike.log("reply_failed", "conv", conv, "reason", "canceled");
        }
    }

    static void markRead(Context c, StatusBarNotification sbn) {
        Notification.Action[] actions = sbn.getNotification().actions;
        String conv = Spike.hash(sbn.getKey());
        if (actions != null) {
            for (Notification.Action a : actions) {
                if (a.getSemanticAction() != Notification.Action.SEMANTIC_ACTION_MARK_AS_READ) continue;
                try {
                    a.actionIntent.send(c, 0, new Intent());
                    Spike.log("markread_handed", "conv", conv);
                } catch (PendingIntent.CanceledException e) {
                    Spike.log("markread_failed", "conv", conv, "reason", "canceled");
                }
                return;
            }
        }
        Spike.log("markread_impossible", "conv", conv);
    }
}
