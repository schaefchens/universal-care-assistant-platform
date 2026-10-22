package de.schaefchens.ucap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * What the phone reports about its SMS connection, as server/src/messaging/device.ts checks it: the same fields, the
 * same kinds, ids that keep SMS and MMS apart, and a body the canonical JSON writer takes (signed requests).
 */
public class SmsEventsTest {
    @Test
    public void anSmsAndAnMmsShareAThreadButNotAnId() {
        assertEquals("s12", SmsEvents.smsId(12));
        assertEquals("m12", SmsEvents.mmsId(12));
        assertEquals(12, SmsEvents.smsOf("s12"));
        assertEquals(-1, SmsEvents.smsOf("m12"));
        assertEquals(-1, SmsEvents.smsOf("12"));
        assertEquals(-1, SmsEvents.smsOf("s12; drop"));
    }

    @Test
    public void aMessageAsTheServerChecksIt() throws Exception {
        JSONObject in = SmsEvents.message("7", "s12", "+4915112345678", false, 1_792_000_123_456L, "text", "Bis gleich", true);
        assertEquals("msg.upsert", in.getString("t"));
        assertTrue(in.getBoolean("live"));
        JSONObject m = in.getJSONObject("msg");
        assertEquals("7", m.getString("chatId"));
        assertEquals("s12", m.getString("externalId"));
        assertEquals("+4915112345678", m.getString("fromId"));
        assertFalse(m.getBoolean("outgoing"));
        assertEquals(1_792_000_123L, m.getLong("date"));
        assertTrue(m.isNull("editDate"));
        assertTrue(m.isNull("file"));
        assertEquals("text", m.getString("kind"));
        // The person's own: no sender, never "live" (nothing to announce to them).
        JSONObject out = SmsEvents.message("7", "s13", "+4915112345678", true, 1_792_000_200_000L, "text", "Ok", false);
        assertTrue(out.getJSONObject("msg").isNull("fromId"));
        assertFalse(out.has("live"));
    }

    @Test
    public void aConversationIsPrivateWithItsPeerOrAGroupWithout() throws Exception {
        JSONObject one = SmsEvents.chat("7", "Anna Beispiel", false, "+4915112345678").getJSONObject("chat");
        assertEquals("private", one.getString("kind"));
        assertEquals("+4915112345678", one.getString("userId"));
        assertTrue(one.isNull("readInboxMaxId"));
        JSONObject group = SmsEvents.chat("8", "Anna Beispiel, Bernd", true, "+4915112345678").getJSONObject("chat");
        assertEquals("group", group.getString("kind"));
        assertTrue(group.isNull("userId"));
    }

    @Test
    public void resultsDeliveriesAndStates() throws Exception {
        JSONObject sent = SmsEvents.result("r", "sent", "s9", null);
        assertEquals("send.result", sent.getString("t"));
        assertEquals("r", sent.getString("requestId"));
        assertEquals("sent", sent.getString("state"));
        assertEquals("s9", sent.getString("externalId"));
        assertFalse(sent.has("error"));
        assertEquals("sms_no_service", SmsEvents.result("r", "failed", null, SmsEvents.errorOf(4)).getString("error"));
        assertEquals("sms_42", SmsEvents.errorOf(42));
        assertEquals("[\"s9\"]", SmsEvents.delivered("7", "s9").getJSONArray("externalIds").toString());
        assertEquals("role", SmsEvents.state("off", "role").getString("error"));
        // TP-Status: 0–31 delivered, 32–63 still trying, 64 and above failed.
        assertTrue(SmsEvents.deliveredStatus(0));
        assertFalse(SmsEvents.deliveredStatus(32));
        assertFalse(SmsEvents.deliveredStatus(64));
        assertFalse(SmsEvents.deliveredStatus(-1));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void aBatchIsWhatTheSignedRequestTakes() throws Exception {
        JSONArray events = new JSONArray().put(SmsEvents.chat("7", "Anna", false, "+49151")).put(SmsEvents.message("7", "s12", "+49151", false, 1_000_000L, "text", "Hallo \"du\"", false));
        Map<String, Object> b = SmsEvents.batch("0190f000-0000-7000-8000-000000000001", events);
        String jcs = SignedRequest.jcs(b);
        assertTrue(jcs.startsWith("{\"connectionId\":\"0190f000-0000-7000-8000-000000000001\",\"events\":[{\"chat\":{"));
        assertTrue(jcs.contains("\"userId\":\"+49151\""));
        assertTrue(jcs.contains("\"file\":null"));
        assertTrue(jcs.contains("\"text\":\"Hallo \\\"du\\\"\""));
        List<Object> list = (List<Object>) b.get("events");
        assertEquals(2, list.size());
    }
}
