package de.schaefchens.ucap;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.media.AudioManager;
import android.view.accessibility.AccessibilityManager;
import android.content.res.Configuration;
import android.os.Build;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/** The device and its WebView, and the system's font scale and dark mode: the defaults for the app's own settings. */
@CapacitorPlugin(name = "Info")
public class InfoPlugin extends Plugin {
    @PluginMethod
    public void get(PluginCall call) {
        Configuration c = getContext().getResources().getConfiguration();
        JSObject r = new JSObject();
        r.put("model", Build.MODEL);
        r.put("manufacturer", Build.MANUFACTURER);
        r.put("release", Build.VERSION.RELEASE);
        r.put("sdk", Build.VERSION.SDK_INT);
        // API 26+; on 24 and 25 the user agent's Chrome version has to do.
        PackageInfo wv = Build.VERSION.SDK_INT >= 26 ? WebView.getCurrentWebViewPackage() : null;
        r.put("webViewVersion", wv != null ? wv.versionName : "");
        r.put("fontScale", c.fontScale);
        r.put("nightMode", (c.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
        // Whether it can place a phone call at all (K6: "a device that cannot make calls says so"): a tablet with mobile
        // data alone cannot.
        android.telephony.TelephonyManager tm = (android.telephony.TelephonyManager) getContext().getSystemService(android.content.Context.TELEPHONY_SERVICE);
        r.put("voiceCapable", tm != null && tm.isVoiceCapable());
        call.resolve(r);
    }

    /**
     * "Lauter" and "Leiser" by voice (docs/plan.md, S8). UCAP speaks with accessibility usage, which follows the media
     * volume unless a screen reader keeps an accessibility volume of its own; an app cannot change that one, so then
     * the person is pointed to the volume keys. Never down to silence: "Leiser" stops one step above it.
     */
    @PluginMethod
    public void volume(PluginCall call) {
        int step = call.getInt("step", 0);
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        AccessibilityManager a11y = (AccessibilityManager) getContext().getSystemService(Context.ACCESSIBILITY_SERVICE);
        JSObject r = new JSObject();
        if (a11y != null && a11y.isEnabled() && a11y.isTouchExplorationEnabled()) {
            r.put("changed", false);
            r.put("reason", "accessibility");
            call.resolve(r);
            return;
        }
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int cur = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        // About an eighth of the range per step: one raw step is hard to hear on a phone with 25 of them.
        int by = Math.max(1, Math.round(max / 8f));
        int next = Math.max(1, Math.min(max, cur + Integer.signum(step) * by));
        if (next != cur) am.setStreamVolume(AudioManager.STREAM_MUSIC, next, 0);
        r.put("changed", next != cur);
        r.put("level", next);
        r.put("max", max);
        if (next == cur) r.put("reason", step > 0 ? "max" : "min");
        call.resolve(r);
    }

    /** While the recovery words are on screen: no screenshots, no screen recording, nothing in the Recents preview. */
    @PluginMethod
    public void setSecure(PluginCall call) {
        boolean on = call.getBoolean("on", false);
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
            else getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
            call.resolve();
        });
    }

    /** The system bars' icons follow the app's theme: light icons on a dark theme, dark on a light one, so the time and
     *  battery stay readable for people with partial sight (the app draws edge to edge). */
    @PluginMethod
    public void setSystemBars(PluginCall call) {
        boolean dark = call.getBoolean("dark", false);
        getActivity().runOnUiThread(() -> {
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getActivity().getWindow(), getActivity().getWindow().getDecorView());
            c.setAppearanceLightStatusBars(!dark);
            c.setAppearanceLightNavigationBars(!dark);
            call.resolve();
        });
    }
}
