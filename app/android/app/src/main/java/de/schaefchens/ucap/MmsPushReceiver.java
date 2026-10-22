package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * An MMS notification (WAP_PUSH_DELIVER, application/vnd.wap.mms-message), the SMS role's MMS part, in the SMS process.
 * The MMS itself is fetched from the carrier's MMS centre with it (docs/plan-m3.md, K4: MMS in), which comes in the
 * step after SMS; until then the notification is only counted.
 */
public class MmsPushReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        android.util.Log.i("UCAP", "mms: a notification came (" + (i.getByteArrayExtra("data") == null ? 0 : i.getByteArrayExtra("data").length) + " bytes)");
    }
}
