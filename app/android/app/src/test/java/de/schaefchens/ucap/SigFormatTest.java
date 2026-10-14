package de.schaefchens.ucap;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import org.junit.Test;

/** DER from the JVM's own ECDSA (as the Keystore produces it) must verify as P1363 after conversion, every time. */
public class SigFormatTest {
    @Test
    public void convertedSignaturesVerifyIncludingShortAndPaddedIntegers() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = g.generateKeyPair();
        SecureRandom rnd = new SecureRandom();
        int padded = 0, shortInts = 0;
        for (int n = 0; n < 2000; n++) {
            byte[] data = new byte[1 + rnd.nextInt(200)];
            rnd.nextBytes(data);
            Signature der = Signature.getInstance("SHA256withECDSA");
            der.initSign(pair.getPrivate());
            der.update(data);
            byte[] d = der.sign();
            int rLen = d[3];
            int sLen = d[5 + rLen];
            if (rLen == 33 || sLen == 33) padded++;
            if (rLen < 32 || sLen < 32) shortInts++;
            byte[] p = SigFormat.derToP1363(d);
            assertEquals(64, p.length);
            Signature p1363 = Signature.getInstance("SHA256withECDSAinP1363Format");
            p1363.initVerify(pair.getPublic());
            p1363.update(data);
            assertTrue("signature " + n + " does not verify after conversion", p1363.verify(p));
        }
        // The edge cases really occurred (about half pad an INTEGER, about 1 in 64 has one shorter than 32 bytes).
        assertTrue(padded > 100);
        assertTrue(shortInts > 0);
    }

    @Test
    public void fixed32PadsAndTrims() {
        assertArrayEquals(new byte[32], SigFormat.fixed32(BigInteger.ZERO));
        byte[] one = new byte[32];
        one[31] = 1;
        assertArrayEquals(one, SigFormat.fixed32(BigInteger.ONE));
        BigInteger high = new BigInteger(1, new byte[] { (byte) 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31 });
        assertEquals(33, high.toByteArray().length); // a sign byte in front
        assertEquals((byte) 0xff, SigFormat.fixed32(high)[0]);
    }
}
