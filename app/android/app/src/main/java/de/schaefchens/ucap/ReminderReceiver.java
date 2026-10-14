package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;

/** A reminder alarm went off (ReminderAlarms): the person is asked, unless it was answered meanwhile. */
public class ReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String oid = intent.getStringExtra(ReminderAlarms.EXTRA_OCCURRENCE);
        if (oid == null || Ref.load(ctx) == null) return;
        JSONObject o = ReminderAlarms.item(ctx, oid);
        if (o == null) return;
        ReminderAlarms.prompt(ctx.getApplicationContext(), oid, o.optString("title"), o.optString("prompt"));
    }
}
