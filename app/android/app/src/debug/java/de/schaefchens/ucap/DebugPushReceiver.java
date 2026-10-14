package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.nio.charset.StandardCharsets;

/**
 * Debug builds only (src/debug): the push path driven from adb, as the ntfy app and the UnifiedPush connector would
 * drive it, for the emulator checks in tools/android (no distributor installed there). DEBUG_PUSH hands over a
 * payload the way the connector does after decrypting (extra `json` or `json64`; `decrypted=false` takes the AN-14
 * path);
 * DEBUG_ENDPOINT a new endpoint and its keys. The same code runs after that as for a real push.
 */
public class DebugPushReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        Context app = ctx.getApplicationContext();
        if ("de.schaefchens.ucap.DEBUG_PUSH".equals(intent.getAction())) {
            // json64: the payload base64-encoded, so no shell quoting can change it on the way.
            String b64 = intent.getStringExtra("json64");
            String json = b64 != null ? new String(android.util.Base64.decode(b64, android.util.Base64.DEFAULT), StandardCharsets.UTF_8) : intent.getStringExtra("json");
            if (json != null) UpService.onPush(app, json.getBytes(StandardCharsets.UTF_8), !"false".equals(intent.getStringExtra("decrypted")));
        } else if ("de.schaefchens.ucap.DEBUG_ENDPOINT".equals(intent.getAction())) {
            String url = intent.getStringExtra("endpoint"), p256dh = intent.getStringExtra("p256dh"), auth = intent.getStringExtra("auth");
            if (url != null && p256dh != null && auth != null) {
                PendingResult pending = goAsync();
                new Thread(() -> {
                    try {
                        Endpoints.received(app, url, p256dh, auth);
                    } finally {
                        pending.finish();
                    }
                }).start();
            }
        }
    }
}
