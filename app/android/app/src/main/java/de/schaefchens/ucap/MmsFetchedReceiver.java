package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Android's MMS service reported, in the SMS process: on a fetch (MmsFetch), stored and reported or tried again later;
 * on telling the MMS centre an MMS was retrieved.
 */
public class MmsFetchedReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        int rc = getResultCode();
        String retrieved = i.getStringExtra("retrieved");
        if (retrieved != null) {
            MmsFetch.told(ctx, retrieved, rc);
            return;
        }
        String tx = i.getStringExtra("tx");
        if (tx == null) return;
        PendingResult async = goAsync();
        new Thread(() -> {
            try {
                MmsFetch.fetched(ctx, tx, rc);
                if (SmsSync.run(ctx)) SmsJob.retry(ctx);
            } catch (Exception e) {
                android.util.Log.w("UCAP", "mms fetched: " + e.getClass().getSimpleName());
            } finally {
                async.finish();
            }
        }, "ucap-mms-fetched").start();
    }
}
