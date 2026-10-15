package de.schaefchens.ucap.spike;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** WAP_PUSH_DELIVER: the notice of an MMS (the MMS itself is then fetched from the carrier). */
public class MmsPushReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        byte[] data = i.getByteArrayExtra("data");
        Spike.log("wap_push", "mime", i.getType(), "bytes", data == null ? 0 : data.length, "subscription", i.getIntExtra("android.telephony.extra.SUBSCRIPTION_INDEX", -1));
    }
}
