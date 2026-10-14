package de.schaefchens.ucap;

import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;

/**
 * Signing with this device's Keystore key (DeviceKeyPlugin makes it): for the app through the plugin, and for native
 * code that sends signed requests with the app closed. The signature leaves as P1363, base64url (SigFormat).
 */
final class DeviceSigner {
    static final String ALIAS = "ucap-device-key-v1";

    private DeviceSigner() {}

    static KeyStore store() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    static boolean exists() {
        try {
            return store().containsAlias(ALIAS);
        } catch (Exception e) {
            return false;
        }
    }

    /** Raw P1363 signature (r || s) of the bytes; throws when this device has no key. */
    static byte[] signRaw(byte[] data) throws Exception {
        KeyStore ks = store();
        if (!ks.containsAlias(ALIAS)) throw new IllegalStateException("no device key");
        Signature sig = Signature.getInstance("SHA256withECDSA");
        sig.initSign((PrivateKey) ks.getKey(ALIAS, null));
        sig.update(data);
        return SigFormat.derToP1363(sig.sign());
    }

    static String sign(byte[] data) throws Exception {
        return SignedRequest.b64url(signRaw(data));
    }
}
