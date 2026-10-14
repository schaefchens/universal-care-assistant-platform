package de.schaefchens.ucap;

import android.content.pm.PackageInfo;
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
        call.resolve(r);
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
