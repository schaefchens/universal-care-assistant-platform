package de.schaefchens.ucap.spike4;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.KeyguardManager;
import android.app.role.RoleManager;
import android.content.Intent;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.SystemClock;
import android.widget.TextView;

/**
 * The spike's one screen, and what needs an activity in front: role requests, screen pinning and lock task, Android's
 * unlock prompt, opening another app. Started by `am start … --es cmd <name> [--es arg <value>]`.
 */
public class MainActivity extends Activity {
    private long promptAt;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        TextView v = new TextView(this);
        v.setTextSize(28);
        v.setText("UCAP Spike 4");
        v.setContentDescription("UCAP Spike 4");
        setContentView(v);
        handle(getIntent(), "create");
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        handle(i, "new");
    }

    @Override
    protected void onResume() {
        super.onResume();
        Ev.log("main.resume", "lockTask", lockTaskState());
    }

    int lockTaskState() {
        return getSystemService(ActivityManager.class).getLockTaskModeState();
    }

    private void handle(Intent i, String how) {
        Ev.log("main.intent", "how", how, "action", i.getAction(), "home", i.hasCategory(Intent.CATEGORY_HOME), "tel", i.getData() != null);
        String cmd = i.getStringExtra("cmd");
        if (cmd == null) return;
        i.removeExtra("cmd");
        run(cmd, i.getStringExtra("arg"), i.getStringExtra("features"));
    }

    private void run(String cmd, String arg, String features) {
        try {
            switch (cmd) {
                case "role-home":
                    requestRole(RoleManager.ROLE_HOME, 1);
                    break;
                case "role-dialer":
                    requestRole(RoleManager.ROLE_DIALER, 2);
                    break;
                case "pin":
                    startLockTask();
                    Ev.log("pin.called", "lockTask", lockTaskState());
                    break;
                case "unpin":
                    stopLockTask();
                    Ev.log("unpin.called", "lockTask", lockTaskState());
                    break;
                case "prompt":
                    prompt();
                    break;
                case "confirm": {
                    Intent c = getSystemService(KeyguardManager.class).createConfirmDeviceCredentialIntent("UCAP Spike", "Entsperren");
                    if (c == null) Ev.log("confirm.no_lock");
                    else {
                        promptAt = SystemClock.elapsedRealtime();
                        startActivityForResult(c, 3);
                    }
                    break;
                }
                case "open": {
                    Intent l = getPackageManager().getLaunchIntentForPackage(arg);
                    if (l == null) Ev.log("open.none", "pkg", arg);
                    else {
                        startActivity(l.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                        Ev.log("open.called", "pkg", arg, "lockTask", lockTaskState());
                    }
                    break;
                }
                case "kiosk-on":
                    Kiosk.on(this, arg, features);
                    break;
                case "kiosk-off":
                    Kiosk.off(this);
                    break;
                case "mic-start":
                    startForegroundService(new Intent(this, MicService.class));
                    Ev.log("mic.start_called");
                    break;
                case "mic-stop":
                    stopService(new Intent(this, MicService.class));
                    Ev.log("mic.stop_called");
                    break;
                case "notify-back":
                    Notes.back(this);
                    break;
                default:
                    Ev.log("main.unknown", "cmd", cmd);
            }
        } catch (Throwable t) {
            Ev.log("main.failed", "cmd", cmd, "error", Ev.err(t));
        }
    }

    private void requestRole(String role, int code) {
        RoleManager rm = getSystemService(RoleManager.class);
        boolean held = rm.isRoleHeld(role);
        Ev.log("role.state", "role", role, "available", rm.isRoleAvailable(role), "held", held);
        if (!held) startActivityForResult(rm.createRequestRoleIntent(role), code);
    }

    private void prompt() {
        BiometricManager bm = getSystemService(BiometricManager.class);
        int both = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        Ev.log("prompt.can", "strong", bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG), "credential",
            bm.canAuthenticate(BiometricManager.Authenticators.DEVICE_CREDENTIAL), "both", bm.canAuthenticate(both));
        BiometricPrompt.Builder b = new BiometricPrompt.Builder(this).setTitle("UCAP entsperren").setSubtitle("Mit der Sperre dieses Telefons");
        if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(both);
        else b.setDeviceCredentialAllowed(true);
        promptAt = SystemClock.elapsedRealtime();
        b.build().authenticate(new CancellationSignal(), getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                Ev.log("prompt.ok", "type", Build.VERSION.SDK_INT >= 30 ? r.getAuthenticationType() : -9, "ms", SystemClock.elapsedRealtime() - promptAt);
                Keys.sign("after-prompt");
            }

            @Override
            public void onAuthenticationError(int code, CharSequence msg) {
                Ev.log("prompt.error", "code", code, "ms", SystemClock.elapsedRealtime() - promptAt);
            }

            @Override
            public void onAuthenticationFailed() {
                Ev.log("prompt.failed");
            }
        });
        Ev.log("prompt.shown");
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        Ev.log("activity.result", "request", request, "ok", result == RESULT_OK, "ms", request == 3 ? SystemClock.elapsedRealtime() - promptAt : -1);
        if (request == 3 && result == RESULT_OK) Keys.sign("after-confirm");
        if (request == 1 || request == 2) {
            RoleManager rm = getSystemService(RoleManager.class);
            Ev.log("role.after", "home", rm.isRoleHeld(RoleManager.ROLE_HOME), "dialer", rm.isRoleHeld(RoleManager.ROLE_DIALER));
        }
    }
}
