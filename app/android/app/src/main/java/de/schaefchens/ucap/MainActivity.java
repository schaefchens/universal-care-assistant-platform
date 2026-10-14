package de.schaefchens.ucap;

import android.os.Bundle;
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
        super.onCreate(savedInstanceState);
        // The app scales its own text (the person's setting times the system font scale, from the Info plugin).
        // A WebView that scaled it again would make text unpredictable, so its own zoom stays at 100 %.
        getBridge().getWebView().getSettings().setTextZoom(100);
    }
}
