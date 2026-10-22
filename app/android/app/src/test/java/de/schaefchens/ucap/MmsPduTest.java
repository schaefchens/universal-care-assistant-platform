package de.schaefchens.ucap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import com.android.messaging.mmslib.pdu.EncodedStringValue;
import com.android.messaging.mmslib.pdu.GenericPdu;
import com.android.messaging.mmslib.pdu.NotificationInd;
import com.android.messaging.mmslib.pdu.NotifyRespInd;
import com.android.messaging.mmslib.pdu.PduBody;
import com.android.messaging.mmslib.pdu.PduHeaders;
import com.android.messaging.mmslib.pdu.PduParser;
import com.android.messaging.mmslib.pdu.RetrieveConf;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

/**
 * MMS as a carrier sends them, parsed by AOSP's PDU code (vendored, com.android.messaging.mmslib): the fixtures are
 * written by tools/dev/mms-centre.ts, the emulator's stand-in MMS centre, so the two implementations check each other.
 */
public class MmsPduTest {
    private static byte[] fixture(String name) throws Exception {
        try (InputStream in = MmsPduTest.class.getResourceAsStream("/mms/" + name)) {
            assertNotNull(name, in);
            return in.readAllBytes();
        }
    }

    @Test
    public void aNotificationSaysWhereTheMmsIsAndWhoSentIt() throws Exception {
        GenericPdu pdu = new PduParser(fixture("notification-ind.pdu"), true).parse();
        assertTrue(pdu instanceof NotificationInd);
        NotificationInd n = (NotificationInd) pdu;
        assertEquals("http://10.0.2.2:8826/m/t1", new String(n.getContentLocation(), StandardCharsets.US_ASCII));
        assertEquals("t1", new String(n.getTransactionId(), StandardCharsets.US_ASCII));
        // The parser takes the address type off: the number alone.
        assertEquals("+15551234", n.getFrom().getString());
        assertEquals("Grüße", n.getSubject().getString());
        assertEquals(2048, n.getMessageSize());
        // A relative expiry (a day) comes back as a time: now and a day.
        long day = System.currentTimeMillis() / 1000 + 86_400;
        assertTrue(Math.abs(n.getExpiry() - day) < 60);
    }

    @Test
    public void anMmsHasItsSenderRecipientsAndParts() throws Exception {
        GenericPdu pdu = new PduParser(fixture("retrieve-conf.pdu"), true).parse();
        assertTrue(pdu instanceof RetrieveConf);
        RetrieveConf r = (RetrieveConf) pdu;
        assertEquals(PduHeaders.MESSAGE_TYPE_RETRIEVE_CONF, r.getMessageType());
        assertEquals("+15551234", r.getFrom().getString());
        assertEquals(1, r.getTo().length);
        assertEquals("Grüße", r.getSubject().getString());
        assertEquals(1_792_000_000L, r.getDate());
        PduBody body = r.getBody();
        assertEquals(2, body.getPartsNum());
        assertEquals("text/plain", new String(body.getPart(0).getContentType(), StandardCharsets.US_ASCII));
        assertEquals("Schöne Grüße vom See!", new String(body.getPart(0).getData(), StandardCharsets.UTF_8));
        assertEquals("image/png", new String(body.getPart(1).getContentType(), StandardCharsets.US_ASCII));
        assertEquals("see.png", new String(body.getPart(1).getContentLocation(), StandardCharsets.US_ASCII));
        assertEquals(0x89, body.getPart(1).getData()[0] & 0xff); // a PNG
    }

    @Test
    public void aGroupMmsNamesEveryoneItWentTo() throws Exception {
        RetrieveConf r = (RetrieveConf) new PduParser(fixture("retrieve-conf-group.pdu"), true).parse();
        EncodedStringValue[] to = r.getTo();
        assertEquals(2, to.length);
        assertEquals("+15550002", to[1].getString());
        assertEquals(1, r.getBody().getPartsNum());
    }

    @Test
    public void aSubjectIsStoredAsAospStoresIt() throws Exception {
        RetrieveConf r = (RetrieveConf) new PduParser(fixture("retrieve-conf.pdu"), true).parse();
        // AOSP's PduPersister keeps the subject's bytes as ISO-8859-1 characters beside its charset; read back, "Grüße".
        String stored = new String(r.getSubject().getTextString(), StandardCharsets.ISO_8859_1);
        assertEquals("Grüße", MmsStore.decoded(stored, r.getSubject().getCharacterSet()));
        // A value another app stored as text (a character beyond one byte) stays as it is; so does one without charset.
        assertEquals("Grüße 日", MmsStore.decoded("Grüße 日", 106));
        assertEquals("Grüße", MmsStore.decoded("Grüße", 0));
    }

    @Test
    public void theMmsCentreIsToldTheMmsWasRetrieved() throws Exception {
        GenericPdu pdu = new PduParser(MmsFetch.notifyResp("t1"), true).parse();
        assertTrue(pdu instanceof NotifyRespInd);
        NotifyRespInd n = (NotifyRespInd) pdu;
        assertEquals("t1", new String(n.getTransactionId(), StandardCharsets.ISO_8859_1));
        assertEquals(PduHeaders.STATUS_RETRIEVED, n.getStatus());
        assertEquals(PduHeaders.MMS_VERSION_1_2, n.getMmsVersion());
        // A transaction id is given back byte for byte, even one that starts with a byte the encoding must quote.
        String odd = new String(new byte[] {(byte) 0xe4, 'x', '1'}, StandardCharsets.ISO_8859_1);
        NotifyRespInd q = (NotifyRespInd) new PduParser(MmsFetch.notifyResp(odd), true).parse();
        assertEquals(odd, new String(q.getTransactionId(), StandardCharsets.ISO_8859_1));
    }

    @Test
    public void theWapPushFitsOneSms() throws Exception {
        String hex = new String(fixture("wap-push.hex"), StandardCharsets.US_ASCII).trim();
        // The service centre (7 octets after its length), DELIVER with a user data header, then the ports 2948 and 9200.
        assertTrue(hex.startsWith("0791"));
        assertTrue(hex.contains("0605040B8423F0"));
        assertTrue(hex.length() / 2 <= 8 + 1 + 2 + 5 + 2 + 7 + 1 + 140);
    }
}
