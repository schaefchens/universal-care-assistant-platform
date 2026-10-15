package de.schaefchens.ucap.spike;

import android.app.Activity;
import android.app.role.RoleManager;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;

/**
 * Asks Android for the SMS role through its own dialog (`--es cmd role`), or opens the default-apps page
 * (`--es cmd defaultapps`): `adb shell am start -n de.schaefchens.ucap.spike/.MainActivity --es cmd role`.
 */
public class MainActivity extends Activity {
    private long asked;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        String cmd = getIntent().getStringExtra("cmd");
        RoleManager rm = getSystemService(RoleManager.class);
        if ("role".equals(cmd)) {
            Spike.log("role_before", "available", rm.isRoleAvailable(RoleManager.ROLE_SMS), "held", rm.isRoleHeld(RoleManager.ROLE_SMS));
            if (!rm.isRoleHeld(RoleManager.ROLE_SMS)) {
                asked = System.currentTimeMillis();
                startActivityForResult(rm.createRequestRoleIntent(RoleManager.ROLE_SMS), 1);
                return;
            }
        } else if ("defaultapps".equals(cmd)) {
            startActivity(new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS));
        }
        finish();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        RoleManager rm = getSystemService(RoleManager.class);
        Spike.log("role_result", "ok", result == RESULT_OK, "held", rm.isRoleHeld(RoleManager.ROLE_SMS), "ms", System.currentTimeMillis() - asked);
        finish();
    }
}
