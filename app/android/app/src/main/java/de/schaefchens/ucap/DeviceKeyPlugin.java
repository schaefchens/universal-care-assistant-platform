package de.schaefchens.ucap;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;

/**
 * This device's key: ECDSA P-256 in the Android Keystore (StrongBox where the phone has one). It never leaves the
 * device and is not part of any backup or device transfer (data_extraction_rules.xml): a new device is added by
 * recovery, never by copying (docs/plan.md, Appendix C). It needs no unlock, because the help path must never
 * require one; the optional app lock (M4) will use a second key.
 *
 * Signatures come out of the Keystore as DER and go to the server as P1363 (r || s, 64 bytes), the format WebCrypto
 * produces in browsers, so the server verifies one format.
 */
@CapacitorPlugin(name = "DeviceKey")
public class DeviceKeyPlugin extends Plugin {
    private static final String ALIAS = DeviceSigner.ALIAS;
    private static final int FLAGS = Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING;

    private static KeyStore store() throws Exception {
        return DeviceSigner.store();
    }

    private static void generate(boolean strongBox) throws Exception {
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256);
        if (strongBox) spec.setIsStrongBoxBacked(true);
        KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        g.initialize(spec.build());
        g.generateKeyPair();
    }

    private static JSObject jwk(ECPublicKey key) {
        JSObject j = new JSObject();
        j.put("kty", "EC");
        j.put("crv", "P-256");
        j.put("x", Base64.encodeToString(SigFormat.fixed32(key.getW().getAffineX()), FLAGS));
        j.put("y", Base64.encodeToString(SigFormat.fixed32(key.getW().getAffineY()), FLAGS));
        return j;
    }

    /** The key's public half as a JWK; creates the key first if this device has none. */
    @PluginMethod
    public void ensure(PluginCall call) {
        try {
            KeyStore ks = store();
            boolean created = false;
            if (!ks.containsAlias(ALIAS)) {
                // StrongBox exists from Android 9; where it is missing or refuses, the Keystore's usual hardware.
                try {
                    if (Build.VERSION.SDK_INT >= 28) generate(true);
                    else generate(false);
                } catch (Exception e) {
                    generate(false);
                }
                created = true;
            }
            Certificate cert = store().getCertificate(ALIAS);
            JSObject r = new JSObject();
            r.put("jwk", jwk((ECPublicKey) cert.getPublicKey()));
            r.put("created", created);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("the device key could not be created", "key_store", e);
        }
    }

    @PluginMethod
    public void exists(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("exists", store().containsAlias(ALIAS));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("the key store is unavailable", "key_store", e);
        }
    }

    /** Signs bytes the app built (a statement); returns the P1363 signature, base64url. */
    @PluginMethod
    public void sign(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("no data", "bad_request");
            return;
        }
        try {
            if (!store().containsAlias(ALIAS)) {
                call.reject("this device has no key", "no_key");
                return;
            }
            JSObject r = new JSObject();
            r.put("signature", Base64.encodeToString(DeviceSigner.signRaw(Base64.decode(data, FLAGS)), FLAGS));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("signing failed", "sign_failed", e);
        }
    }

    /** Removes the key: after the device was revoked, or when the person resets the app. */
    @PluginMethod
    public void remove(PluginCall call) {
        try {
            KeyStore ks = store();
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
            call.resolve();
        } catch (Exception e) {
            call.reject("the key could not be removed", "key_store", e);
        }
    }
}
