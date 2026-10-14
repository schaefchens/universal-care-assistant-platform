package de.schaefchens.ucap;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.os.Build;
import android.view.accessibility.AccessibilityManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

/**
 * Which assistive technology runs, and a change event, so the app switches modes at once (lookup: TalkBack's touch
 * exploration was reported 2.8 s after accessibility was switched on). Beyond lookup's shell it also reports
 * spoken feedback and services that dispatch real gestures (Switch Access point scanning, Voice Access' grid), so
 * those users get direct taps instead of an engine they cannot drive. And Android's recommended timeout, which
 * every response window respects.
 */
@CapacitorPlugin(name = "A11y")
public class A11yPlugin extends Plugin {
    private AccessibilityManager manager;
    private AccessibilityManager.TouchExplorationStateChangeListener touchListener;
    private AccessibilityManager.AccessibilityStateChangeListener stateListener;
    private Object servicesListener;

    @Override
    public void load() {
        manager = (AccessibilityManager) getContext().getSystemService(Context.ACCESSIBILITY_SERVICE);
        touchListener = enabled -> notifyListeners("change", snapshot());
        stateListener = enabled -> notifyListeners("change", snapshot());
        manager.addTouchExplorationStateChangeListener(touchListener);
        manager.addAccessibilityStateChangeListener(stateListener);
        if (Build.VERSION.SDK_INT >= 33) {
            AccessibilityManager.AccessibilityServicesStateChangeListener l = m -> notifyListeners("change", snapshot());
            manager.addAccessibilityServicesStateChangeListener(getContext().getMainExecutor(), l);
            servicesListener = l;
        }
    }

    private JSObject snapshot() {
        boolean spoken = false;
        boolean gestures = false;
        List<AccessibilityServiceInfo> services = manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
        if (services != null) {
            for (AccessibilityServiceInfo s : services) {
                if ((s.feedbackType & AccessibilityServiceInfo.FEEDBACK_SPOKEN) != 0) spoken = true;
                else if ((s.getCapabilities() & AccessibilityServiceInfo.CAPABILITY_CAN_PERFORM_GESTURES) != 0) gestures = true;
            }
        }
        JSObject r = new JSObject();
        r.put("enabled", manager.isEnabled());
        r.put("touchExploration", manager.isTouchExplorationEnabled());
        r.put("spokenFeedback", spoken);
        r.put("gestureDispatch", gestures);
        return r;
    }

    @PluginMethod
    public void state(PluginCall call) {
        call.resolve(snapshot());
    }

    @PluginMethod
    public void recommendedTimeout(PluginCall call) {
        int ms = call.getInt("ms", 10000);
        int flags = 0;
        if (call.getBoolean("controls", true)) flags |= AccessibilityManager.FLAG_CONTENT_CONTROLS;
        if (call.getBoolean("text", true)) flags |= AccessibilityManager.FLAG_CONTENT_TEXT;
        JSObject r = new JSObject();
        r.put("ms", Build.VERSION.SDK_INT >= 29 ? manager.getRecommendedTimeoutMillis(ms, flags) : ms);
        call.resolve(r);
    }

    @Override
    protected void handleOnDestroy() {
        manager.removeTouchExplorationStateChangeListener(touchListener);
        manager.removeAccessibilityStateChangeListener(stateListener);
        if (Build.VERSION.SDK_INT >= 33 && servicesListener != null) {
            manager.removeAccessibilityServicesStateChangeListener((AccessibilityManager.AccessibilityServicesStateChangeListener) servicesListener);
        }
    }
}
