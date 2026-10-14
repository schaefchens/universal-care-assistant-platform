package de.schaefchens.ucap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/** Payloads as server/src/domain/care/push.ts writes them; anything else never rings. */
public class PushPayloadTest {
    private static final String RID = "01a13a89-5c32-7fe2-910b-9ad519edd569";
    private static final String DLV = "01a13a89-5c33-7000-8000-000000000001";
    private static final long NOW = 1_792_000_000L;

    private static JSONObject alert() throws Exception {
        return new JSONObject().put("v", 1).put("t", "care.alert").put("rid", RID).put("ep", 2).put("dlv", DLV).put("n", "AbCdEfGhIjKlMnOpQrStUv")
            .put("who", "Anna").put("dev", "Tablet").put("u", 1).put("at", NOW - 5).put("ttl", 900).put("pad", "   ");
    }

    @Test
    public void readsAnAlert() throws Exception {
        PushPayload p = PushPayload.parse(alert().toString(), NOW);
        assertNotNull(p);
        assertEquals("care.alert", p.type);
        assertEquals(RID, p.rid);
        assertEquals(2, p.ep);
        assertEquals("Anna", p.who);
        assertEquals("Tablet", p.dev);
        assertTrue(p.unconfirmed);
        assertFalse(p.late);
        assertTrue(p.rings());
    }

    @Test
    public void anAlertLongAfterItsTtlIsLateAndDoesNotRing() throws Exception {
        PushPayload p = PushPayload.parse(alert().put("at", NOW - 900 - 61).toString(), NOW);
        assertTrue(p.late);
        assertFalse(p.rings());
        // Within the grace for clock differences it still rings.
        assertTrue(PushPayload.parse(alert().put("at", NOW - 900 - 59).toString(), NOW).rings());
    }

    @Test
    public void refusesWhatIsNotAValidUcapPush() throws Exception {
        assertNull(PushPayload.parse("not json", NOW));
        assertNull(PushPayload.parse(alert().put("v", 2).toString(), NOW));
        assertNull(PushPayload.parse(alert().put("t", "care.party").toString(), NOW));
        assertNull(PushPayload.parse(alert().put("dlv", "x").toString(), NOW));
        assertNull(PushPayload.parse(alert().put("n", "short").toString(), NOW));
        assertNull(PushPayload.parse(alert().put("rid", "../../x").toString(), NOW));
        assertNull(PushPayload.parse(alert().put("ep", 0).toString(), NOW));
        JSONObject noRid = alert();
        noRid.remove("rid");
        assertNull(PushPayload.parse(noRid.toString(), NOW));
    }

    @Test
    public void aHeartbeatNeedsNoRequest() throws Exception {
        JSONObject hb = new JSONObject().put("v", 1).put("t", "hb").put("dlv", DLV).put("n", "AbCdEfGhIjKlMnOpQrStUv").put("at", NOW).put("ttl", 1800);
        PushPayload p = PushPayload.parse(hb.toString(), NOW);
        assertNotNull(p);
        assertFalse(p.care());
        assertFalse(p.rings());
    }

    @Test
    public void clipsLongNamesAndReadsNullsAsEmpty() throws Exception {
        StringBuilder longName = new StringBuilder();
        for (int i = 0; i < 200; i++) longName.append('x');
        PushPayload p = PushPayload.parse(alert().put("who", longName.toString()).put("dev", JSONObject.NULL).toString(), NOW);
        assertEquals(80, p.who.length());
        assertEquals("", p.dev);
    }
}
