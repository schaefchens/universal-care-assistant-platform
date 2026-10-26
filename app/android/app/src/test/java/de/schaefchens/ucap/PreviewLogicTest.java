package de.schaefchens.ucap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Previews (docs/plan-m3.md, K5) as a messenger posts them (spike D): the whole recent conversation again with every
 * new message, each message reported once, history no news, a reply confirmed only by the app showing it as the
 * person's own, and "read" only once every message shown was heard.
 */
public class PreviewLogicTest {
    private static final String PKG = "org.thoughtcrime.securesms";
    private static final PreviewLogic.Line ANNA_1 = new PreviewLogic.Line("Anna", "p:anna", 1_000_000L, "Kommst du heute?", false);
    private static final PreviewLogic.Line ANNA_2 = new PreviewLogic.Line("Anna", "p:anna", 1_060_000L, "Gegen fünf?", false);

    private static PreviewLogic.Shown shown(PreviewLogic.Line... lines) {
        return new PreviewLogic.Shown(PKG, "s:thread-7", null, false, Arrays.asList(lines), true, true);
    }

    private static List<String> kinds(List<JSONObject> events) {
        List<String> out = new ArrayList<>();
        for (JSONObject e : events) out.add(e.optString("t"));
        return out;
    }

    @Test
    public void eachMessageOnceAlthoughTheConversationComesAgain() {
        Set<String> seen = new HashSet<>();
        List<JSONObject> first = PreviewLogic.events(shown(ANNA_1), seen, 0);
        assertEquals(Arrays.asList("user.upsert", "chat.upsert", "msg.upsert"), kinds(first));
        List<JSONObject> second = PreviewLogic.events(shown(ANNA_1, ANNA_2), seen, 0);
        assertEquals(Arrays.asList("user.upsert", "chat.upsert", "msg.upsert"), kinds(second));
        assertEquals("Gegen fünf?", second.get(2).optJSONObject("msg").optString("text"));
        assertTrue(PreviewLogic.events(shown(ANNA_1, ANNA_2), seen, 0).isEmpty());
        // The same message in another conversation of the same app is another message.
        PreviewLogic.Shown other = new PreviewLogic.Shown(PKG, "s:thread-8", null, false, Arrays.asList(ANNA_1), true, true);
        assertNotEquals(PreviewLogic.messageId(shown(ANNA_1), ANNA_1), PreviewLogic.messageId(other, ANNA_1));
    }

    @Test
    public void aConversationIsItsNotificationAndItsPeopleOnlyWhatItShows() throws Exception {
        List<JSONObject> e = PreviewLogic.events(shown(ANNA_1), new HashSet<>(), 0);
        JSONObject user = e.get(0).getJSONObject("user");
        JSONObject chat = e.get(1).getJSONObject("chat");
        JSONObject msg = e.get(2).getJSONObject("msg");
        assertEquals("Anna", user.getString("name"));
        assertFalse(user.getBoolean("isContact"));
        assertEquals(PreviewLogic.conversationId(PKG, "s:thread-7"), chat.getString("externalId"));
        assertEquals("private", chat.getString("kind"));
        assertEquals(user.getString("externalId"), chat.getString("userId"));
        assertEquals("Anna", chat.getString("title"));
        assertEquals(user.getString("externalId"), msg.getString("fromId"));
        assertEquals(1000, msg.getLong("date"));
        // Ids the server takes (device.ts: at most 200 characters).
        assertTrue(chat.getString("externalId").length() < 40 && msg.getString("externalId").length() < 40);
        // A group is named by its title; the person's own messages have no sender.
        PreviewLogic.Line mine = new PreviewLogic.Line(null, null, 1_100_000L, "Ich bringe Salat mit.", true);
        PreviewLogic.Shown family = new PreviewLogic.Shown(PKG, "k:0|" + PKG + "|5|null|10123", "Familie", true, Arrays.asList(ANNA_1, mine), true, false);
        List<JSONObject> g = PreviewLogic.events(family, new HashSet<>(), 0);
        JSONObject gchat = g.get(1).getJSONObject("chat");
        assertEquals("Familie", gchat.getString("title"));
        assertEquals("group", gchat.getString("kind"));
        assertTrue(gchat.isNull("userId"));
        JSONObject own = g.get(3).getJSONObject("msg");
        assertTrue(own.getBoolean("outgoing"));
        assertTrue(own.isNull("fromId"));
    }

    @Test
    public void whatCameBeforeTheAppWasConnectedIsNoNews() {
        List<JSONObject> e = PreviewLogic.events(shown(ANNA_1, ANNA_2), new HashSet<>(), 1_030_000L);
        assertFalse(e.get(2).optBoolean("live"));
        assertTrue(e.get(3).optBoolean("live"));
    }

    @Test
    public void aReplyIsSentOnlyOnceTheAppShowsItAsThePersonsOwn() {
        long handed = 1_200_000L;
        assertNull(PreviewLogic.confirms(shown(ANNA_1, ANNA_2), "Ja, gegen fünf.", handed));
        // Someone else's words, the same as the reply's, are no confirmation.
        assertNull(PreviewLogic.confirms(shown(ANNA_1, new PreviewLogic.Line("Anna", "p:anna", handed + 500, "Ja, gegen fünf.", false)), "Ja, gegen fünf.", handed));
        PreviewLogic.Line mine = new PreviewLogic.Line(null, null, handed + 214, "Ja,  gegen fünf.", true);
        assertEquals(mine, PreviewLogic.confirms(shown(ANNA_1, ANNA_2, mine), "Ja, gegen fünf.", handed));
        // The same words sent long before are not this reply.
        PreviewLogic.Line old = new PreviewLogic.Line(null, null, handed - 3_600_000L, "Ja, gegen fünf.", true);
        assertNull(PreviewLogic.confirms(shown(old, ANNA_1), "Ja, gegen fünf.", handed));
    }

    @Test
    public void readOnlyOnceEveryMessageShownWasHeard() {
        PreviewLogic.Shown s = shown(ANNA_1, ANNA_2);
        Set<String> heard = new HashSet<>();
        assertFalse(PreviewLogic.allHeard(s, heard, 0));
        heard.add(PreviewLogic.messageId(s, ANNA_2));
        assertFalse(PreviewLogic.allHeard(s, heard, 0));
        heard.add(PreviewLogic.messageId(s, ANNA_1));
        assertTrue(PreviewLogic.allHeard(s, heard, 0));
        // Nothing of others to hear: nothing to mark.
        assertFalse(PreviewLogic.allHeard(shown(new PreviewLogic.Line(null, null, 5L, "Hallo", true)), heard, 0));
        assertEquals(1060, PreviewLogic.newestIncoming(s));
        // A messenger that shows read messages again with a new one: those count as done (measured on the emulator).
        PreviewLogic.Line next = new PreviewLogic.Line("Anna", "p:anna", 1_120_000L, "Bist du da?", false);
        PreviewLogic.Shown again = shown(ANNA_1, ANNA_2, next);
        Set<String> onlyNew = new HashSet<>(Arrays.asList(PreviewLogic.messageId(again, next)));
        assertFalse(PreviewLogic.allHeard(again, onlyNew, 0));
        assertTrue(PreviewLogic.allHeard(again, onlyNew, 1_060_000L));
        assertFalse(PreviewLogic.allHeard(again, new HashSet<>(), 1_060_000L));
    }
}
