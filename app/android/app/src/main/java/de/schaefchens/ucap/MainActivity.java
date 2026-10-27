package de.schaefchens.ucap;

import android.os.Bundle;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins register before the bridge starts, or JS calls them before they exist (lookup).
        registerPlugin(EarconsPlugin.class);
        registerPlugin(DeviceTtsPlugin.class);
        registerPlugin(A11yPlugin.class);
        registerPlugin(InfoPlugin.class);
        registerPlugin(DeviceKeyPlugin.class);
        registerPlugin(UnlockKeyPlugin.class);
        registerPlugin(AlertsPlugin.class);
        registerPlugin(KeysPlugin.class);
        registerPlugin(RemindersPlugin.class);
        registerPlugin(VoiceCapturePlugin.class);
        registerPlugin(SmsPlugin.class);
        registerPlugin(PhoneContactsPlugin.class);
        registerPlugin(PreviewsPlugin.class);
        registerPlugin(LauncherPlugin.class);
        registerPlugin(KioskPlugin.class);
        super.onCreate(savedInstanceState);
        // The app scales its own text (the person's setting times the system font scale, from the Info plugin).
        // A WebView that scaled it again would make text unpredictable, so its own zoom stays at 100 %.
        getBridge().getWebView().getSettings().setTextZoom(100);
    }

    /** The help key is read here, before the WebView or TalkBack's key handling in the page sees it. */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (KeysPlugin.onKey(event)) return true;
        return super.dispatchKeyEvent(event);
    }
}
