package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.service.notification.StatusBarNotification;
import org.json.JSONArray;

/**
 * What the app's process asks of the previews process (explicit broadcasts within UCAP, never exported): watch an app
 * for the person's connection, stop watching it, take what waits for this phone's previews, mark heard messages read.
 * Run on the previews' one thread (PreviewListener.WORK), in order with what the notifications bring.
 */
public class PreviewCommands extends BroadcastReceiver {
    static void send(Context ctx, String cmd, Intent extras) {
        Intent i = new Intent(ctx, PreviewCommands.class).setAction("de.schaefchens.ucap.previews." + cmd);
        if (extras != null) i.putExtras(extras);
        ctx.sendBroadcast(i);
    }

    @Override
    public void onReceive(Context ctx, Intent i) {
        String action = i.getAction() == null ? "" : i.getAction();
        String cmd = action.substring(action.lastIndexOf('.') + 1);
        PendingResult async = goAsync();
        PreviewListener.WORK.execute(() -> {
            try {
                run(ctx.getApplicationContext(), cmd, i);
            } catch (Exception e) {
                android.util.Log.w("UCAP", "previews command " + cmd + ": " + e.getClass().getSimpleName());
            } finally {
                async.finish();
            }
        });
    }

    private static void run(Context ctx, String cmd, Intent i) {
        PreviewDb db = PreviewDb.get(ctx);
        String connection = i.getStringExtra("connectionId");
        boolean id = connection != null && connection.matches("^[0-9a-f-]{36}$");
        switch (cmd) {
            case "connect": {
                String pkg = i.getStringExtra("package");
                if (!id || pkg == null || !pkg.matches("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")) return;
                db.addApp(pkg, connection);
                boolean on = PreviewSync.accessGranted(ctx);
                db.queue(connection, new JSONArray().put(SmsEvents.state(on ? "ready" : "off", on ? null : "access")));
                // What the app shows now came before: history, no news.
                PreviewListener l = PreviewListener.running;
                if (l != null) for (StatusBarNotification s : PreviewListener.active(l)) if (pkg.equals(s.getPackageName())) PreviewListener.take(ctx, s);
                PreviewJob.periodic(ctx);
                break;
            }
            case "disconnect":
                if (!id) return;
                db.dropApp(connection);
                if (db.apps().isEmpty()) PreviewJob.cancel(ctx);
                return;
            case "take":
                // Asked as the app starts too: the jobs an update of the app cancelled come back with it.
                if (!db.apps().isEmpty()) PreviewJob.periodic(ctx);
                if (!PreviewSender.take(ctx)) PreviewJob.retry(ctx);
                break;
            case "read": {
                String conv = i.getStringExtra("chatId");
                if (!id || conv == null) return;
                PreviewSender.heard(ctx, connection, conv, i.getStringArrayExtra("externalIds"));
                break;
            }
            default:
                return;
        }
        PreviewSync.runOrRetry(ctx);
    }
}
