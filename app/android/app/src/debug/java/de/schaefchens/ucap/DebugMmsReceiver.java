package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Debug builds only, guarded by DUMP: MMS on the emulator (tools/dev/mms-centre.ts), whose console cannot deliver a WAP
 * push and whose carrier configuration disables MMS, so its MMS service fetches nothing.
 * - DEBUG_MMS_PUSH: a notification PDU (hex), handled as a carrier's WAP push is (MmsPushReceiver).
 * - DEBUG_MMS_FETCHED: the MMS (hex) for a transaction, as Android's MMS service writes it after a fetch; then the
 *   fetch's result, as MmsFetchedReceiver gets it.
 * - DEBUG_SELF: whether the SIM carries the phone's own number (logged by its length only), which a group MMS's
 *   conversation needs (MmsFetch.self).
 */
public class DebugMmsReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        if ("de.schaefchens.ucap.DEBUG_SELF".equals(i.getAction())) {
            // Whether the SIM carries the phone's own number: its length only.
            String self = MmsFetch.self(ctx, -1);
            android.util.Log.i("UCAP", "self: " + (self == null ? "unknown" : "known, " + self.length() + " characters"));
            return;
        }
        String hex = i.getStringExtra("pdu");
        if (hex == null || hex.length() % 2 != 0 || !hex.matches("^[0-9A-Fa-f]+$")) return;
        byte[] data = new byte[hex.length() / 2];
        for (int k = 0; k < data.length; k++) data[k] = (byte) Integer.parseInt(hex.substring(2 * k, 2 * k + 2), 16);
        String tx = i.getStringExtra("tx");
        boolean fetched = "de.schaefchens.ucap.DEBUG_MMS_FETCHED".equals(i.getAction());
        if (fetched && tx == null) return;
        PendingResult async = goAsync();
        new Thread(() -> {
            try {
                if (fetched) {
                    MmsFetch.debugFetched(ctx, tx, data);
                    if (SmsSync.run(ctx)) SmsJob.retry(ctx);
                } else MmsPushReceiver.handle(ctx, data, -1);
            } finally {
                async.finish();
            }
        }, "ucap-debug-mms").start();
    }
}
