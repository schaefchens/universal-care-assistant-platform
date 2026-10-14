package de.schaefchens.ucap;

import android.content.Context;
import android.content.SharedPreferences;
import android.view.KeyEvent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * A hardware help key (docs/plan.md, S5): a Bluetooth button or another key the person chose, read in the activity's
 * dispatchKeyEvent before the WebView sees it. One press sends help at once, like an exact help phrase (Appendix D):
 * the key is deliberate by choice. Repeats while held are ignored. The key is learned by pressing it once; keys that
 * mean something else are refused with the reason (KeyRules). Works while the app is in front.
 */
@CapacitorPlugin(name = "Keys")
public class KeysPlugin extends Plugin {
    private static final String PREFS = "ucap.keys";
    private static KeysPlugin instance;
    private PluginCall learning;

    @Override
    public void load() {
        instance = this;
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** From MainActivity: true when the key was the help key (or was being learned) and is used up. */
    static boolean onKey(KeyEvent e) {
        KeysPlugin p = instance;
        return p != null && p.handle(e);
    }

    private boolean handle(KeyEvent e) {
        int code = e.getKeyCode();
        if (learning != null) {
            if (e.getAction() != KeyEvent.ACTION_DOWN) return true;
            PluginCall call = learning;
            learning = null;
            String why = KeyRules.reserved(code);
            JSObject r = new JSObject().put("code", code).put("name", KeyEvent.keyCodeToString(code));
            if (why != null) r.put("reserved", why);
            call.resolve(r);
            return true;
        }
        int help = prefs().getInt("help", -1);
        if (help < 0 || code != help) return false;
        if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) notifyListeners("help", new JSObject().put("code", code));
        return true;
    }

    @PluginMethod
    public void get(PluginCall call) {
        int help = prefs().getInt("help", -1);
        JSObject r = new JSObject();
        if (help >= 0) r.put("code", help).put("name", KeyEvent.keyCodeToString(help));
        call.resolve(r);
    }

    @PluginMethod
    public void setHelpKey(PluginCall call) {
        Integer code = call.getInt("code");
        if (code == null || code < 0) {
            prefs().edit().remove("help").apply();
        } else if (KeyRules.reserved(code) != null) {
            call.reject("this key means something else", "reserved");
            return;
        } else {
            prefs().edit().putInt("help", code).apply();
        }
        call.resolve();
    }

    /** Resolves with the next key pressed, never acting on it. */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void learn(PluginCall call) {
        if (learning != null) learning.reject("replaced", "cancelled");
        learning = call;
    }

    @PluginMethod
    public void cancelLearn(PluginCall call) {
        if (learning != null) learning.reject("cancelled", "cancelled");
        learning = null;
        call.resolve();
    }
}
