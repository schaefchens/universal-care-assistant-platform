package de.schaefchens.ucap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Debug builds only, guarded by DUMP: the previews process (docs/plan-m3.md, K5) fails on purpose, so a check on the
 * emulator sees the app's help live on and Android start the listener again (spike D).
 * `adb shell am broadcast -a de.schaefchens.ucap.DEBUG_PREVIEWS_CRASH -n de.schaefchens.ucap/.DebugPreviewReceiver`
 */
public class DebugPreviewReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        if ("de.schaefchens.ucap.DEBUG_PREVIEWS_CRASH".equals(i.getAction())) throw new IllegalStateException("previews: fails on purpose (debug)");
    }
}
