package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.util.ArrayList;
import java.util.List;

/**
 * What the app's process asks of the SMS process (explicit broadcasts within UCAP, never exported): connect to the
 * server's connection, disconnect, take what waits for this phone (a push woke it, or the app heard of it), mark SMS
 * read that the person heard. The SMS process keeps its own state (SmsDb), so nothing is shared across processes but
 * these commands.
 */
public class SmsCommands extends BroadcastReceiver {
    static void send(Context ctx, String cmd, Intent extras) {
        Intent i = new Intent(ctx, SmsCommands.class).setAction("de.schaefchens.ucap.sms." + cmd);
        if (extras != null) i.putExtras(extras);
        ctx.sendBroadcast(i);
    }

    @Override
    public void onReceive(Context ctx, Intent i) {
        String action = i.getAction() == null ? "" : i.getAction();
        String cmd = action.substring(action.lastIndexOf('.') + 1);
        PendingResult async = goAsync();
        new Thread(() -> {
            try {
                run(ctx, cmd, i);
            } catch (Exception e) {
                android.util.Log.w("UCAP", "sms command " + cmd + ": " + e.getClass().getSimpleName());
            } finally {
                async.finish();
            }
        }, "ucap-sms-cmd").start();
    }

    private static void run(Context ctx, String cmd, Intent i) {
        switch (cmd) {
            case "connect": {
                String id = i.getStringExtra("connectionId");
                if (id == null || !id.matches("^[0-9a-f-]{36}$")) return;
                SmsSync.connect(ctx, id);
                SmsJob.periodic(ctx);
                SmsJob.watchStore(ctx);
                break;
            }
            case "disconnect":
                SmsSync.disconnect(ctx);
                SmsJob.cancel(ctx);
                return;
            case "take":
                // Asked as the app starts too: the jobs an update of the app cancelled come back with it.
                if (SmsSync.connection(ctx) != null) SmsJob.ensure(ctx);
                if (!SmsSender.take(ctx)) SmsJob.retry(ctx);
                break;
            case "read": {
                // Only this phone's connection, and only its SMS and MMS ids ("s12", "m3").
                if (!String.valueOf(i.getStringExtra("connectionId")).equals(SmsSync.connection(ctx))) return;
                List<Long> sms = new ArrayList<>();
                List<Long> mms = new ArrayList<>();
                String[] ext = i.getStringArrayExtra("externalIds");
                if (ext != null) {
                    for (String e : ext) {
                        if (SmsEvents.smsOf(e) > 0) sms.add(SmsEvents.smsOf(e));
                        else if (SmsEvents.mmsOf(e) > 0) mms.add(SmsEvents.mmsOf(e));
                    }
                }
                if (!SmsRole.held(ctx)) return;
                SmsStore.markRead(ctx, sms);
                MmsStore.markRead(ctx, mms);
                // Heard: its notification goes too.
                for (long id : sms) {
                    SmsStore.Row r = SmsStore.one(ctx, id);
                    if (r != null) SmsNotify.read(ctx, r.thread);
                }
                for (long id : mms) {
                    long thread = MmsStore.threadOf(ctx, id);
                    if (thread > 0) SmsNotify.read(ctx, thread);
                }
                return;
            }
            default:
                break;
        }
        if (SmsSync.run(ctx)) SmsJob.retry(ctx);
    }
}
