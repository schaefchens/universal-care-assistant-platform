package de.schaefchens.ucap.spike4;

import android.os.Build;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

/** A second key, bound to the phone's own lock (spike A): made, used, inspected, removed. */
final class Keys {
    static final String ALIAS = "spike4-unlock";

    private Keys() {}

    static KeyStore store() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    static void create(int validityS) {
        try {
            KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true);
            if (Build.VERSION.SDK_INT >= 30) b.setUserAuthenticationParameters(validityS, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
            else b.setUserAuthenticationValidityDurationSeconds(validityS);
            KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            g.initialize(b.build());
            long t0 = SystemClock.elapsedRealtime();
            g.generateKeyPair();
            Ev.log("key.created", "validityS", validityS, "ms", SystemClock.elapsedRealtime() - t0);
        } catch (Throwable t) {
            Ev.log("key.create_failed", "error", Ev.err(t));
        }
    }

    static void sign(String why) {
        try {
            KeyStore ks = store();
            if (!ks.containsAlias(ALIAS)) {
                Ev.log("key.sign", "why", why, "result", "no_key");
                return;
            }
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initSign((PrivateKey) ks.getKey(ALIAS, null));
            s.update(new byte[] {1, 2, 3});
            s.sign();
            Ev.log("key.sign", "why", why, "result", "ok");
        } catch (Throwable t) {
            Ev.log("key.sign", "why", why, "result", "failed", "error", Ev.err(t));
        }
    }

    static void info() {
        try {
            KeyStore ks = store();
            if (!ks.containsAlias(ALIAS)) {
                Ev.log("key.info", "exists", false);
                return;
            }
            PrivateKey k = (PrivateKey) ks.getKey(ALIAS, null);
            KeyInfo i = KeyFactory.getInstance(k.getAlgorithm(), "AndroidKeyStore").getKeySpec(k, KeyInfo.class);
            Ev.log("key.info", "exists", true, "authRequired", i.isUserAuthenticationRequired(), "validityS", i.getUserAuthenticationValidityDurationSeconds(),
                "enforcedByHardware", i.isUserAuthenticationRequirementEnforcedBySecureHardware(), "invalidatedByBiometricEnrollment", i.isInvalidatedByBiometricEnrollment(),
                "securityLevel", Build.VERSION.SDK_INT >= 31 ? i.getSecurityLevel() : -9, "authType", Build.VERSION.SDK_INT >= 30 ? i.getUserAuthenticationType() : -9);
        } catch (Throwable t) {
            Ev.log("key.info", "error", Ev.err(t));
        }
    }

    static void delete() {
        try {
            KeyStore ks = store();
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
            Ev.log("key.deleted");
        } catch (Throwable t) {
            Ev.log("key.delete_failed", "error", Ev.err(t));
        }
    }
}
