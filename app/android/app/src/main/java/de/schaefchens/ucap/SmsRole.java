package de.schaefchens.ucap;

import android.app.role.RoleManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Telephony;

/**
 * Android's SMS role (docs/plan-m3.md, K4; spike C): whether UCAP holds it, Android's own dialog to take it (two choices:
 * the current SMS app is preselected), and which app has it otherwise. Giving it back is Android's Default apps page,
 * one tap, and Android then ends UCAP's processes and takes every permission the role granted.
 */
final class SmsRole {
    private SmsRole() {}

    static boolean available(Context ctx) {
        PackageManager pm = ctx.getPackageManager();
        if (!pm.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)) return false;
        if (Build.VERSION.SDK_INT >= 29) {
            RoleManager rm = ctx.getSystemService(RoleManager.class);
            return rm != null && rm.isRoleAvailable(RoleManager.ROLE_SMS);
        }
        return true;
    }

    static boolean held(Context ctx) {
        if (Build.VERSION.SDK_INT >= 29) {
            RoleManager rm = ctx.getSystemService(RoleManager.class);
            return rm != null && rm.isRoleAvailable(RoleManager.ROLE_SMS) && rm.isRoleHeld(RoleManager.ROLE_SMS);
        }
        return ctx.getPackageName().equals(Telephony.Sms.getDefaultSmsPackage(ctx));
    }

    /** Android's dialog that asks the person. */
    static Intent request(Context ctx) {
        if (Build.VERSION.SDK_INT >= 29) return ctx.getSystemService(RoleManager.class).createRequestRoleIntent(RoleManager.ROLE_SMS);
        return new Intent(Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT).putExtra(Telephony.Sms.Intents.EXTRA_PACKAGE_NAME, ctx.getPackageName());
    }

    /** The app that holds it otherwise (Google Messages), by the name the phone shows; null when there is none. */
    static String otherApp(Context ctx) {
        String pkg = Telephony.Sms.getDefaultSmsPackage(ctx);
        if (pkg == null || pkg.equals(ctx.getPackageName())) return null;
        try {
            PackageManager pm = ctx.getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(ai));
        } catch (Exception e) {
            return pkg;
        }
    }
}
