package de.schaefchens.ucap.spike4;

import android.app.Activity;
import android.app.ActivityManager;
import android.os.Bundle;
import android.widget.TextView;

/** The spike's own call screen: shown when the in-call service hears of a call, also over the lock screen. */
public class CallActivity extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        TextView v = new TextView(this);
        v.setTextSize(32);
        v.setText("Anruf");
        setContentView(v);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Ev.log("call.screen_resumed", "lockTask", getSystemService(ActivityManager.class).getLockTaskModeState());
    }
}
