package de.schaefchens.ucap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.telecom.DisconnectCause;
import java.util.Arrays;
import java.util.Collections;
import java.util.Map;
import java.util.TreeSet;
import org.junit.Test;

/**
 * The calls UCAP sees as the phone app (docs/plan-m4.md, G10): how a call ended, and what goes to the server, as
 * server/src/core/routes/calls.ts takes it (signed, so nothing more and nothing it would refuse).
 */
public class CallsTest {
    @Test
    public void howACallEnded() {
        assertEquals("answered", Calls.outcome(true, DisconnectCause.LOCAL, true));
        assertEquals("answered", Calls.outcome(true, DisconnectCause.REMOTE, false));
        assertEquals("declined", Calls.outcome(false, DisconnectCause.REJECTED, true));
        assertEquals("missed", Calls.outcome(false, DisconnectCause.MISSED, true));
        // Whatever else ended an incoming call before anyone answered: the person did not get it.
        assertEquals("missed", Calls.outcome(false, DisconnectCause.ERROR, true));
        assertEquals("missed", Calls.outcome(false, DisconnectCause.REMOTE, true));
        // A call out nobody took.
        assertEquals("unanswered", Calls.outcome(false, DisconnectCause.REMOTE, false));
        assertEquals("unanswered", Calls.outcome(false, DisconnectCause.LOCAL, false));
    }

    @Test
    public void whatTheServerTakes() {
        Map<String, Object> o = Calls.entry("c-1", "+4915112345678", "Anna", true, "missed", 1_793_121_900_000L, 0);
        assertEquals(new TreeSet<>(Arrays.asList("at", "dir", "durationS", "id", "name", "number", "outcome")), new TreeSet<>(o.keySet()));
        assertEquals("in", o.get("dir"));
        assertEquals("out", Calls.entry("c-2", "030123456", null, false, "answered", 0, 5).get("dir"));
        // No name: no field (the server takes an absent name, not null).
        assertFalse(Calls.entry("c-2", "030123456", null, false, "answered", 0, 5).containsKey("name"));
        assertFalse(Calls.entry("c-2", "030123456", "", false, "answered", 0, 5).containsKey("name"));
        // What the server would refuse is cut to what it takes.
        StringBuilder long1 = new StringBuilder();
        for (int i = 0; i < 50; i++) long1.append('1');
        assertEquals(40, ((String) Calls.entry("c-3", long1.toString(), null, true, "missed", 0, 0).get("number")).length());
        assertEquals(86_400, Calls.entry("c-4", "1", null, true, "answered", 0, 100_000).get("durationS"));
        assertEquals(0, Calls.entry("c-5", "1", null, true, "answered", 0, -3).get("durationS"));
        // The canonical JSON the signature covers.
        String jcs = SignedRequest.jcs(Collections.singletonMap("calls", Collections.singletonList(o)));
        assertTrue(jcs, jcs.startsWith("{\"calls\":[{\"at\":1793121900000,\"dir\":\"in\",\"durationS\":0,\"id\":\"c-1\",\"name\":\"Anna\""));
    }
}
