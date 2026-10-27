package de.schaefchens.ucap;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.telecom.Call;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityManager;
import android.widget.Button;
import android.widget.GridLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.lang.ref.WeakReference;

/**
 * UCAP's own call screen (docs/plan-m4.md, G10; spikes/m4.md, D): native, so it shows over the lock screen and inside
 * the kiosk, whether the app runs or not. Who calls (the phone's contact, or "nicht in deinen Kontakten" and the
 * number) is said and shown; ringing: Annehmen, Ablehnen, Hilfe; in the call: Auflegen, Lautsprecher, Lauter, Hilfe.
 * Large areas, each a real button for TalkBack, switches and keyboards. "Hilfe" sends help as anywhere in UCAP.
 */
public class CallActivity extends Activity {
    private static WeakReference<CallActivity> shown = new WeakReference<>(null);
    private TextToSpeech tts;
    private boolean voiced;
    private boolean ending;
    private final Runnable close = this::finish;
    private TextView who;
    private GridLayout grid;
    private int drawnState = -1;
    private PowerManager.WakeLock ear;

    /** The call changed: the screen follows, or goes when the call ended. */
    static void refresh() {
        CallActivity a = shown.get();
        if (a != null) a.runOnUiThread(a::draw);
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        shown = new WeakReference<>(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        // As the alarm screen: white on black.
        root.setBackgroundColor(Color.BLACK);
        root.setPadding(24, 48, 24, 24);
        who = new TextView(this);
        who.setTextSize(32);
        who.setTypeface(Typeface.DEFAULT_BOLD);
        who.setTextColor(Color.WHITE);
        who.setGravity(Gravity.CENTER);
        who.setPadding(0, 24, 0, 48);
        if (Build.VERSION.SDK_INT >= 28) who.setAccessibilityHeading(true);
        root.addView(who, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        grid = new GridLayout(this);
        grid.setColumnCount(2);
        root.addView(grid, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // Over the lock screen: the manifest's attributes from Android 8.1, the window's flags before (as AlarmActivity).
        if (Build.VERSION.SDK_INT < 27) addLegacyLockFlags();
        tts = new TextToSpeech(this, (status) -> {
            if (status != TextToSpeech.SUCCESS) return;
            // The person's language and speed, and only a local voice, as everywhere in UCAP (DeviceTtsPlugin): a
            // caller's name never leaves the phone. Without one the screen is shown, not said.
            SharedPreferences p = getSharedPreferences(DeviceTtsPlugin.PREFS, MODE_PRIVATE);
            Voice v = DeviceTtsPlugin.pick(tts, p.getString("lang", "en".equals(Ref.lang(this)) ? "en-GB" : "de-DE"), null);
            if (v == null) return;
            tts.setVoice(v);
            tts.setSpeechRate(p.getFloat("rate", 1f));
            voiced = true;
            drawnState = -1;
            draw();
        });
        tts.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
        draw();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // A new call while the last one's screen was closing.
        ending = false;
        grid.removeCallbacks(close);
        drawnState = -1;
        draw();
    }

    @Override
    protected void onDestroy() {
        atEar(false);
        if (shown.get() == this) shown = new WeakReference<>(null);
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private void addLegacyLockFlags() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
    }

    /** Call.Details' state needs Android 12; the phone role is offered from Android 10. */
    @SuppressWarnings("deprecation")
    private static int stateOf(Call call) {
        return Build.VERSION.SDK_INT >= 31 ? call.getDetails().getState() : call.getState();
    }

    private String callerOf;
    private String[] caller;

    /** Who: the contact's name, else the number (said digit by digit) or that it is withheld; [shown, said, note]. */
    private String[] caller(Call call) {
        String number = Calls.number(call);
        if (caller != null && number.equals(callerOf)) return caller;
        callerOf = number;
        if (number.isEmpty()) {
            String hidden = Texts.get(this, "calls.hidden");
            caller = new String[] { hidden, hidden, "" };
        } else {
            String name = Calls.name(this, number);
            caller = name != null ? new String[] { name, name, "" } : new String[] { number, spell(number), " " + Texts.get(this, "calls.notContact") };
        }
        return caller;
    }

    /** A number said digit by digit. */
    private static String spell(String number) {
        StringBuilder b = new StringBuilder();
        for (char ch : number.toCharArray()) if (Character.isDigit(ch) || ch == '+') b.append(ch).append(' ');
        return b.toString().trim();
    }

    private void draw() {
        if (ending) return;
        Call call = UcapCallService.current;
        int state = call == null ? Call.STATE_DISCONNECTED : stateOf(call);
        if (state == Call.STATE_DISCONNECTED) {
            // Said, then gone (the app says a missed call itself as it comes back).
            ending = true;
            atEar(false);
            grid.removeAllViews();
            who.setText(Texts.get(this, "calls.ended"));
            say(Texts.get(this, "calls.ended"));
            grid.postDelayed(close, 1500);
            return;
        }
        boolean ringing = state == Call.STATE_RINGING;
        boolean active = state == Call.STATE_ACTIVE || state == Call.STATE_HOLDING;
        atEar(!ringing && !UcapCallService.onSpeaker());
        String[] c = caller(call);
        who.setText(ringing ? Texts.format(this, "calls.ringing", c[0]) : active ? c[0] : Texts.format(this, "calls.dialing", c[0]));
        grid.removeAllViews();
        if (ringing) {
            area(Texts.get(this, "calls.answer"), 0xff1b7f3b, UcapCallService::answer, false);
            area(Texts.get(this, "calls.decline"), 0xff37474f, UcapCallService::decline, false);
            area(Texts.get(this, "calls.help"), 0xffb3261e, this::help, true);
        } else {
            area(Texts.get(this, "calls.hangup"), 0xffb3261e, UcapCallService::hangup, false);
            // Named by what a press does, not by the state it is in.
            area(Texts.get(this, UcapCallService.onSpeaker() ? "calls.speakerOff" : "calls.speakerOn"), 0xff37474f, () -> {
                boolean on = !UcapCallService.onSpeaker();
                UcapCallService.speaker(on);
                say(Texts.get(this, on ? "calls.speakerOnSaid" : "calls.speakerOffSaid"));
                grid.postDelayed(this::draw, 300);
            }, false);
            area(Texts.get(this, "calls.louder"), 0xff37474f, () -> {
                AudioManager am = getSystemService(AudioManager.class);
                if (am != null) am.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI);
            }, false);
            area(Texts.get(this, "calls.help"), 0xffb3261e, this::help, false);
        }
        // Said once per change: who calls, whom UCAP calls, and "Verbunden" only once Android says the call is active.
        if (state != drawnState && (voiced || screenReader()) && state != Call.STATE_HOLDING) {
            drawnState = state;
            say(ringing ? Texts.format(this, "calls.ringingSaid", c[1], c[2]) : Texts.format(this, active ? "calls.activeSaid" : "calls.dialingSaid", c[1]));
        }
    }

    /** TalkBack (or another screen reader that explores by touch) is on. */
    private boolean screenReader() {
        AccessibilityManager am = getSystemService(AccessibilityManager.class);
        return am != null && am.isEnabled() && am.isTouchExplorationEnabled();
    }

    /** Said by UCAP's voice; with a screen reader on, by the screen reader, as the app does: never two voices at once. */
    @SuppressWarnings("deprecation")
    private void say(String text) {
        if (screenReader()) who.announceForAccessibility(text);
        else if (voiced) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "call");
    }

    /** A large area, a real button; `wide` fills its row, so no corner is left empty. */
    private void area(String label, int color, Runnable action, boolean wide) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(28);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(Color.WHITE);
        b.setBackgroundColor(color);
        b.setAllCaps(false);
        b.setOnClickListener((v) -> action.run());
        GridLayout.LayoutParams lp = new GridLayout.LayoutParams(GridLayout.spec(GridLayout.UNDEFINED, 1f), GridLayout.spec(GridLayout.UNDEFINED, wide ? 2 : 1, 1f));
        lp.width = 0;
        lp.height = 0;
        lp.setMargins(12, 12, 12, 12);
        grid.addView(b, lp);
    }

    /** At the ear the screen goes dark, so a cheek presses nothing ("Auflegen" is large); on the speaker it stays on. */
    private void atEar(boolean on) {
        if (ear == null) {
            PowerManager pm = getSystemService(PowerManager.class);
            if (pm == null || !pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return;
            ear = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "ucap:call");
        }
        // Released when the call ends or goes to the speaker; the timeout only cleans up after a screen that died.
        if (on && !ear.isHeld()) ear.acquire(6 * 3_600_000L);
        if (!on && ear.isHeld()) ear.release();
    }

    /** Help during a call: UCAP sends it as for its help key (the app takes it as soon as it runs). */
    private void help() {
        KeysPlugin.requestHelp(this);
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
    }

    /** The call's screen in front: the one there is (below the app after "Hilfe"), else a new one. */
    static void open(Context c) {
        c.startActivity(new Intent(c, CallActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
    }
}
