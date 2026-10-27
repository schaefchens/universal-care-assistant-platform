package de.schaefchens.ucap.spike4;

import android.Manifest;
import android.app.ActivityManager;
import android.app.KeyguardManager;
import android.app.admin.DevicePolicyManager;
import android.app.role.RoleManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.hardware.biometrics.BiometricManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.CallLog;
import android.telecom.TelecomManager;
import java.util.List;

/** Commands that need no activity in front: `am broadcast -n …/.CommandReceiver --es cmd <name> [--es arg <value>]`. */
public class CommandReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        String cmd = intent.getStringExtra("cmd");
        String arg = intent.getStringExtra("arg");
        try {
            switch (String.valueOf(cmd)) {
                case "key-create": Keys.create(arg == null ? 30 : Integer.parseInt(arg)); break;
                case "key-sign": Keys.sign("command"); break;
                case "key-info": Keys.info(); break;
                case "key-delete": Keys.delete(); break;
                case "can-auth": {
                    BiometricManager bm = c.getSystemService(BiometricManager.class);
                    KeyguardManager km = c.getSystemService(KeyguardManager.class);
                    Ev.log("auth.can", "strong", bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG), "weak", bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK),
                        "credential", bm.canAuthenticate(BiometricManager.Authenticators.DEVICE_CREDENTIAL), "deviceSecure", km.isDeviceSecure(), "keyguardLocked", km.isKeyguardLocked());
                    break;
                }
                case "apps": {
                    List<ResolveInfo> l = c.getPackageManager().queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0);
                    StringBuilder pk = new StringBuilder();
                    for (ResolveInfo r : l) pk.append(pk.length() == 0 ? "" : ",").append(r.activityInfo.packageName);
                    Ev.log("apps", "count", l.size(), "packages", pk.toString());
                    break;
                }
                case "front":
                    c.startActivity(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    Ev.log("front.called");
                    break;
                case "front-later": {
                    // After the shell's broadcast stopped lending its own right to start activities (about ten seconds).
                    Context app = c.getApplicationContext();
                    int ms = arg == null ? 20000 : Integer.parseInt(arg);
                    new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                        try {
                            app.startActivity(new Intent(app, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                            Ev.log("front.later_called");
                        } catch (Throwable t) {
                            Ev.log("front.later_failed", "error", Ev.err(t));
                        }
                    }, ms);
                    Ev.log("front.later_scheduled", "ms", ms);
                    break;
                }
                case "roles": {
                    RoleManager rm = c.getSystemService(RoleManager.class);
                    Ev.log("roles", "home", rm.isRoleHeld(RoleManager.ROLE_HOME), "dialer", rm.isRoleHeld(RoleManager.ROLE_DIALER));
                    break;
                }
                case "perms": {
                    String[] all = {Manifest.permission.CALL_PHONE, Manifest.permission.READ_CALL_LOG, Manifest.permission.WRITE_CALL_LOG, Manifest.permission.READ_PHONE_STATE,
                        Manifest.permission.READ_CONTACTS, Manifest.permission.ANSWER_PHONE_CALLS, Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS};
                    StringBuilder g = new StringBuilder();
                    for (String p : all) if (c.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) g.append(p.substring(p.lastIndexOf('.') + 1)).append(' ');
                    Ev.log("perms", "granted", g.toString().trim());
                    break;
                }
                case "do-info": {
                    DevicePolicyManager dpm = c.getSystemService(DevicePolicyManager.class);
                    boolean owner = dpm.isDeviceOwnerApp(c.getPackageName());
                    Ev.log("do.info", "owner", owner, "permitted", dpm.isLockTaskPermitted(c.getPackageName()), "packages", owner ? dpm.getLockTaskPackages(Kiosk.admin(c)).length : -1,
                        "lockTask", c.getSystemService(ActivityManager.class).getLockTaskModeState());
                    break;
                }
                case "do-keyguard": {
                    DevicePolicyManager dpm = c.getSystemService(DevicePolicyManager.class);
                    Ev.log("do.keyguard", "disabled", "on".equals(arg), "ok", dpm.setKeyguardDisabled(Kiosk.admin(c), "on".equals(arg)));
                    break;
                }
                case "do-clear":
                    c.getSystemService(DevicePolicyManager.class).clearDeviceOwnerApp(c.getPackageName());
                    Ev.log("do.cleared");
                    break;
                case "call-log": {
                    try (Cursor cur = c.getContentResolver().query(CallLog.Calls.CONTENT_URI, new String[] {CallLog.Calls.TYPE, CallLog.Calls.DURATION, CallLog.Calls.DATE}, null, null, CallLog.Calls.DATE + " DESC")) {
                        StringBuilder t = new StringBuilder();
                        int n = 0;
                        while (cur != null && cur.moveToNext() && n++ < 5) t.append(cur.getInt(0)).append('/').append(cur.getInt(1)).append("s ");
                        Ev.log("call.log", "count", cur == null ? -1 : cur.getCount(), "latest", t.toString().trim());
                    }
                    break;
                }
                case "place-call":
                    c.getSystemService(TelecomManager.class).placeCall(Uri.parse("tel:" + arg), new Bundle());
                    Ev.log("call.placed");
                    break;
                case "answer": CallService.answer(); break;
                case "hangup": CallService.hangup(); break;
                case "reject": CallService.reject(); break;
                case "speaker": CallService.speaker(); break;
                default: Ev.log("command.unknown", "cmd", cmd);
            }
        } catch (Throwable t) {
            Ev.log("command.failed", "cmd", cmd, "error", Ev.err(t));
        }
    }
}
