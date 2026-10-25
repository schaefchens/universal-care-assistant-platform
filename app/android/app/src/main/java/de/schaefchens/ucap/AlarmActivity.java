package de.schaefchens.ucap;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.content.ContextCompat;

/**
 * The full-screen alarm over the lock screen: whose request it is, and two large buttons. Native, not the WebView:
 * nothing of the app is visible on a locked phone. "Annehmen" first asks Android to unlock (it stops everyone else's
 * alarm, so a stranger holding the phone must not do it); "Kann nicht" works locked. White on black, 7:1 or more.
 */
public class AlarmActivity extends Activity {
    private String rid;
    private int ep;
    private String who;
    private TextView title;
    private TextView text;
    private BroadcastReceiver closed;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setBackgroundColor(Color.BLACK);
        int pad = dp(24);
        root.setPadding(pad, pad, pad, pad);
        title = label(34, true);
        text = label(22, false);
        root.addView(title);
        root.addView(text);
        root.addView(button(Texts.get(this, "action.accept"), 0xFF1B5E20, v -> accept()));
        root.addView(button(Texts.get(this, "action.decline"), 0xFF424242, v -> decline()));
        setContentView(root);

        closed = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                if (rid != null && rid.equals(i.getStringExtra(CareAlarm.EXTRA_RID))) finish();
            }
        };
        IntentFilter f = new IntentFilter(CareAlarm.ACTION_CLOSED);
        // Only UCAP's own broadcast closes it, on every Android (below 13 through a permission only UCAP holds).
        ContextCompat.registerReceiver(this, closed, f, ContextCompat.RECEIVER_NOT_EXPORTED);
        take(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        take(intent);
    }

    private void take(Intent i) {
        rid = i.getStringExtra(CareAlarm.EXTRA_RID);
        ep = i.getIntExtra("ep", 0);
        who = i.getStringExtra("who") != null ? i.getStringExtra("who") : "";
        if (rid == null) {
            finish();
            return;
        }
        String t = i.getStringExtra("title") != null ? i.getStringExtra("title") : Texts.format(this, "alert.title", who);
        title.setText(t);
        text.setText(i.getStringExtra("text") != null ? i.getStringExtra("text") : "");
        // The window's title is what TalkBack says first.
        setTitle(t);
        if (i.getBooleanExtra("accept", false)) accept();
    }

    @Override
    protected void onDestroy() {
        if (closed != null) unregisterReceiver(closed);
        super.onDestroy();
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private TextView label(int sp, boolean heading) {
        TextView t = new TextView(this);
        t.setTextColor(Color.WHITE);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        if (heading) {
            t.setTypeface(Typeface.DEFAULT_BOLD);
            if (Build.VERSION.SDK_INT >= 28) t.setAccessibilityHeading(true);
        }
        t.setPadding(0, 0, 0, dp(16));
        return t;
    }

    private Button button(String label, int color, android.view.View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        b.setTextColor(Color.WHITE);
        b.setBackgroundColor(color);
        b.setMinHeight(dp(120));
        b.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        b.setLayoutParams(lp);
        return b;
    }

    private void accept() {
        KeyguardManager km = getSystemService(KeyguardManager.class);
        if (km.isKeyguardLocked() && Build.VERSION.SDK_INT >= 26) {
            km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    doAccept();
                }
            });
        } else if (km.isKeyguardSecure() && km.isKeyguardLocked()) {
            // Android 7: no unlock request from here; the app opens behind the lock and accepts there.
            startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(CareAlarm.EXTRA_RID, rid));
            finish();
        } else {
            doAccept();
        }
    }

    private void doAccept() {
        String r = rid;
        Context app = getApplicationContext();
        CareAlarm.sending(app, r, who);
        new Thread(() -> Actions.send(app, r, ep, "accept", who), "ucap-action").start();
        // The helper is unlocked now: the app shows the request with its quick replies (the inbox, not the alarm
        // again: the answer is already on its way).
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(CareAlarm.EXTRA_RID, r)
            .putExtra(CareAlarm.EXTRA_AFTER, "accept"));
        finish();
    }

    private void decline() {
        String r = rid;
        Context app = getApplicationContext();
        CareAlarm.sending(app, r, who);
        new Thread(() -> Actions.send(app, r, ep, "decline", who), "ucap-action").start();
        finish();
    }
}
