package de.schaefchens.ucap;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;

/**
 * Android's own lock as an extra for UCAP's app lock (docs/plan-m4.md, G4; spikes/m4.md, A): a second key in the
 * Keystore, usable only for 30 seconds after the person unlocked with the phone's own lock (fingerprint, face, PIN,
 * pattern). It signs `session.unlock` for the server. Android refuses such a key on a phone without a screen lock, and
 * deletes it when the person removes that lock: then UCAP's own code is the way, as it always is. The device key
 * (DeviceKeyPlugin) never needs an unlock: help must never wait for one.
 */
@CapacitorPlugin(name = "UnlockKey")
public class UnlockKeyPlugin extends Plugin {
    private static final String ALIAS = "ucap-unlock-key-v1";
    private static final int FLAGS = Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING;
    private static final int VALIDITY_S = 30;

    private static KeyStore store() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    private boolean secure() {
        KeyguardManager km = getContext().getSystemService(KeyguardManager.class);
        return km != null && km.isDeviceSecure();
    }

    /** Whether this phone has a screen lock, and whether the key exists. */
    @PluginMethod
    public void state(PluginCall call) {
        JSObject r = new JSObject();
        r.put("secure", secure());
        boolean exists = false;
        try {
            exists = store().containsAlias(ALIAS);
        } catch (Exception e) {
            // A Keystore that cannot be opened has no key.
        }
        r.put("exists", exists);
        call.resolve(r);
    }

    /** Makes the key (removing an old one) and returns its public half; refused without a screen lock. */
    @PluginMethod
    public void create(PluginCall call) {
        if (!secure()) {
            call.reject("this phone has no screen lock", "no_screen_lock");
            return;
        }
        try {
            KeyStore ks = store();
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
            KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true);
            if (Build.VERSION.SDK_INT >= 30) b.setUserAuthenticationParameters(VALIDITY_S, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
            else b.setUserAuthenticationValidityDurationSeconds(VALIDITY_S);
            KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            g.initialize(b.build());
            ECPublicKey pub = (ECPublicKey) g.generateKeyPair().getPublic();
            JSObject jwk = new JSObject();
            jwk.put("kty", "EC");
            jwk.put("crv", "P-256");
            jwk.put("x", Base64.encodeToString(SigFormat.fixed32(pub.getW().getAffineX()), FLAGS));
            jwk.put("y", Base64.encodeToString(SigFormat.fixed32(pub.getW().getAffineY()), FLAGS));
            JSObject r = new JSObject();
            r.put("jwk", jwk);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("the unlock key could not be made", "key_store", e);
        }
    }

    /**
     * Signs the statement bytes; when the phone was not unlocked in the last 30 seconds, Android's own prompt comes
     * first (fingerprint, face or the phone's PIN). Rejects `cancelled` when the person leaves it, `key_gone` when the
     * phone's lock was removed (Android deleted the key).
     */
    @PluginMethod
    public void sign(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("no data", "bad_request");
            return;
        }
        try {
            call.resolve(signed(data));
        } catch (UserNotAuthenticatedException e) {
            // Android's prompt first, on the main thread. Whatever goes wrong there is this call's failure, never the
            // app's: an exception thrown here once ended the whole process (help with it).
            getActivity().runOnUiThread(() -> {
                try {
                    prompt(call);
                } catch (RuntimeException p) {
                    call.reject("Android's prompt failed", "prompt_failed", p);
                }
            });
        } catch (KeyPermanentlyInvalidatedException e) {
            call.reject("the unlock key is gone", "key_gone");
        } catch (Exception e) {
            if (e instanceof IllegalStateException && "no_key".equals(e.getMessage())) call.reject("the unlock key is gone", "key_gone");
            else call.reject("signing failed", "sign_failed", e);
        }
    }

    private JSObject signed(String data) throws Exception {
        KeyStore ks = store();
        if (!ks.containsAlias(ALIAS)) throw new IllegalStateException("no_key");
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign((PrivateKey) ks.getKey(ALIAS, null));
        s.update(Base64.decode(data, FLAGS));
        JSObject r = new JSObject();
        r.put("signature", Base64.encodeToString(SigFormat.derToP1363(s.sign()), FLAGS));
        return r;
    }

    private void prompt(PluginCall call) {
        String title = call.getString("title", "UCAP");
        String subtitle = call.getString("subtitle", "");
        Activity activity = getActivity();
        if (Build.VERSION.SDK_INT >= 30) {
            BiometricPrompt p = new BiometricPrompt.Builder(activity)
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build();
            p.authenticate(new CancellationSignal(), activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    afterUnlock(call);
                }

                @Override
                public void onAuthenticationError(int code, CharSequence message) {
                    call.reject("not unlocked", "cancelled");
                }
            });
            return;
        }
        // Android 7 to 10: the phone's own confirmation screen (PIN, pattern or password; fingerprint where it offers it).
        KeyguardManager km = getContext().getSystemService(KeyguardManager.class);
        Intent i = km == null ? null : km.createConfirmDeviceCredentialIntent(title, subtitle);
        if (i == null) {
            call.reject("this phone has no screen lock", "no_screen_lock");
            return;
        }
        startActivityForResult(call, i, "confirmed");
    }

    @ActivityCallback
    private void confirmed(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() == Activity.RESULT_OK) afterUnlock(call);
        else call.reject("not unlocked", "cancelled");
    }

    private void afterUnlock(PluginCall call) {
        try {
            call.resolve(signed(call.getString("data")));
        } catch (Exception e) {
            call.reject("signing failed", e instanceof KeyPermanentlyInvalidatedException ? "key_gone" : "sign_failed", e);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            KeyStore ks = store();
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
            call.resolve();
        } catch (Exception e) {
            call.reject("the unlock key could not be removed", "key_store", e);
        }
    }
}
