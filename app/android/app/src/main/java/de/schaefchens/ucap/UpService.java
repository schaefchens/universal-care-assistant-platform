package de.schaefchens.ucap;

import android.content.Context;
import java.nio.charset.StandardCharsets;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * UnifiedPush through ntfy (lookup/findings/android.md: 6 of 6 alarms in deep Doze). The connector decrypts the
 * RFC 8291 payload with keys only this app holds; a message it could not decrypt is dropped and never rings (AN-14),
 * because only the server can produce one that decrypts. The connector calls in on the main thread: the work runs on
 * its own thread.
 */
public class UpService extends PushService {
    static final String INSTANCE = "ucap";

    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        PublicKeySet keys = endpoint.getPubKeySet();
        Context ctx = getApplicationContext();
        String url = endpoint.getUrl();
        new Thread(() -> Endpoints.received(ctx, url, keys != null ? keys.getPubKey() : "", keys != null ? keys.getAuth() : ""), "ucap-endpoint").start();
    }

    @Override
    public void onMessage(PushMessage message, String instance) {
        onPush(getApplicationContext(), message.getContent(), message.getDecrypted());
    }

    /** Also the entry for debug builds' adb receiver (src/debug), so both take the same path. */
    static void onPush(Context ctx, byte[] content, boolean decrypted) {
        if (!decrypted) {
            Endpoints.prefs(ctx).edit().putInt("dropped", Endpoints.prefs(ctx).getInt("dropped", 0) + 1).apply();
            android.util.Log.w("UCAP", "dropped a push that did not decrypt");
            return;
        }
        String json = new String(content, StandardCharsets.UTF_8);
        new Thread(() -> PushHandler.handle(ctx, json), "ucap-push").start();
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) {
        Endpoints.prefs(this).edit().putString("error", "registration_" + reason.name().toLowerCase(java.util.Locale.ROOT)).apply();
        AlertsPlugin.emitPush();
    }

    @Override
    public void onUnregistered(String instance) {
        Context ctx = getApplicationContext();
        new Thread(() -> Endpoints.forget(ctx), "ucap-endpoint").start();
    }

    @Override
    public void onTempUnavailable(String instance) {
        Endpoints.prefs(this).edit().putLong("tempUnavailable", System.currentTimeMillis()).apply();
        AlertsPlugin.emitPush();
    }
}
