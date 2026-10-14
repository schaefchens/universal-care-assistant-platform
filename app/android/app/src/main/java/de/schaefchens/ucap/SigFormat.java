package de.schaefchens.ucap;

import java.math.BigInteger;

/**
 * Signature formats for the device key: the Android Keystore signs ECDSA P-256 in DER (SEQUENCE of two INTEGERs);
 * the server verifies P1363 (r || s, 32 bytes each), the format WebCrypto produces in browsers. Pure Java, so it is
 * unit-tested on the JVM (src/test): an INTEGER can be 33 bytes (a leading zero for a high bit) or shorter than 32.
 */
final class SigFormat {
    private SigFormat() {}

    /** The value as exactly 32 bytes, big-endian: leading zero bytes dropped or added. */
    static byte[] fixed32(BigInteger v) {
        byte[] b = v.toByteArray();
        byte[] out = new byte[32];
        int n = Math.min(32, b.length);
        System.arraycopy(b, b.length - n, out, 32 - n, n);
        return out;
    }

    /** DER SEQUENCE { INTEGER r, INTEGER s } → r || s, each 32 bytes. */
    static byte[] derToP1363(byte[] der) {
        if (der.length < 8 || der[0] != 0x30) throw new IllegalArgumentException("not a DER signature");
        int i = 2;
        if ((der[1] & 0x80) != 0) i = 2 + (der[1] & 0x7f);
        if (der[i] != 0x02) throw new IllegalArgumentException("not a DER signature");
        int rLen = der[i + 1];
        byte[] r = new byte[rLen];
        System.arraycopy(der, i + 2, r, 0, rLen);
        int j = i + 2 + rLen;
        if (der[j] != 0x02) throw new IllegalArgumentException("not a DER signature");
        int sLen = der[j + 1];
        byte[] s = new byte[sLen];
        System.arraycopy(der, j + 2, s, 0, sLen);
        byte[] out = new byte[64];
        System.arraycopy(fixed32(new BigInteger(1, r)), 0, out, 0, 32);
        System.arraycopy(fixed32(new BigInteger(1, s)), 0, out, 32, 32);
        return out;
    }
}
