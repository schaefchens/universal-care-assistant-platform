package de.schaefchens.ucap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/**
 * LIVE mode's listening (docs/plan-m2.md, L2) with a scripted spotter: nothing comes out while the gate is closed but
 * a keyword the spotter is sure of; the keyword passes on what was said with it, or nothing for the name alone, or
 * lets the open gate finish an utterance still going on; with the gate open, utterances one by one, never a click.
 */
public class LiveListenerTest {
    private static final int MS = 16; // samples per millisecond

    /** Says `word` (with `conf`) at its endpoint: once `endAt` samples were fed, the keyword at `atS`–`endS`. */
    static final class Script implements LiveListener.Spotter {
        long fed;
        long endAt = Long.MAX_VALUE;
        String word = "lisa";
        double conf = 0.95, atS, endS;
        int resets;

        @Override
        public List<KeywordSpotter.Hit> feed(short[] pcm, int n) {
            long before = fed;
            fed += n;
            if (before < endAt && fed >= endAt) return Collections.singletonList(new KeywordSpotter.Hit(word, conf, atS, endS));
            return new ArrayList<>();
        }

        @Override
        public void reset() {
            resets++;
        }
    }

    static final class Heard implements LiveListener.Events {
        final List<String> log = new ArrayList<>();
        short[] following;
        final List<Integer> utterances = new ArrayList<>();

        @Override
        public void keyword(String word, short[] following) {
            this.following = following;
            log.add("keyword " + word + (following == null ? "" : " +" + following.length / MS + "ms"));
        }

        @Override
        public void utterance(short[] pcm) {
            utterances.add(pcm.length / MS);
            log.add("utterance " + pcm.length / MS + "ms");
        }

        @Override
        public void speech() {
            log.add("speech");
        }
    }

    private static short[] quiet(int ms) {
        short[] out = new short[ms * MS];
        java.util.Random r = new java.util.Random(ms);
        for (int i = 0; i < out.length; i++) out[i] = (short) ((r.nextDouble() * 2 - 1) * 60);
        return out;
    }

    private static short[] voice(int ms) {
        short[] out = new short[ms * MS];
        for (int i = 0; i < out.length; i++) out[i] = (short) (Math.sin(2 * Math.PI * 220 * i / 16000.0) * 6500);
        return out;
    }

    /** Fed in 100 ms pieces, as AudioRecord hands them over. */
    private static void feed(LiveListener l, short[]... parts) {
        for (short[] p : parts)
            for (int at = 0; at < p.length; at += 1600) {
                int n = Math.min(1600, p.length - at);
                short[] chunk = new short[n];
                System.arraycopy(p, at, chunk, 0, n);
                l.feed(chunk, n);
            }
    }

    private static LiveListener listener(Script s, Heard h) {
        return new LiveListener(s, Collections.singletonList("Lisa"), 0.5, h);
    }

    @Test
    public void closedNothingComesOutButTheKeyword() {
        Script s = new Script();
        Heard h = new Heard();
        LiveListener l = listener(s, h);
        feed(l, quiet(500), voice(1500), quiet(1500));
        assertEquals(Collections.emptyList(), h.log);
        assertFalse(l.isOpen());
        // Another word, or the keyword unsure: still closed.
        s.word = "liste";
        s.endAt = s.fed + 1600;
        feed(l, voice(800), quiet(800));
        s.word = "lisa";
        s.conf = 0.3;
        s.endAt = s.fed + 1600;
        feed(l, voice(800), quiet(800));
        assertEquals(Collections.emptyList(), h.log);
        assertFalse(l.isOpen());
    }

    @Test
    public void theKeywordPassesOnWhatWasSaidWithIt() {
        Script s = new Script();
        Heard h = new Heard();
        LiveListener l = listener(s, h);
        feed(l, quiet(1000));
        // "Lisa, wie spät ist es?": the keyword at 1.0–1.4 s, the question to 3.0 s, the endpoint at 3.6 s.
        s.atS = 1.0;
        s.endS = 1.4;
        s.endAt = 3600 * MS;
        feed(l, voice(2000), quiet(600));
        assertTrue(l.isOpen());
        assertNotNull(h.following);
        // From 0.2 s before the keyword to the endpoint.
        assertEquals(2800, h.following.length / MS, 100);
        assertEquals(1, h.log.size());
    }

    @Test
    public void theNameAloneOpensTheGateAndTheNextUtteranceFollows() {
        Script s = new Script();
        Heard h = new Heard();
        LiveListener l = listener(s, h);
        feed(l, quiet(1000));
        s.atS = 1.0;
        s.endS = 1.4;
        s.endAt = 2000 * MS;
        feed(l, voice(400), quiet(600));
        assertTrue(l.isOpen());
        assertNull(h.following);
        feed(l, quiet(300), voice(1200), quiet(1000));
        assertEquals(java.util.Arrays.asList("keyword lisa", "speech", "utterance " + h.utterances.get(0) + "ms"), h.log);
        // 300 ms before the voice, the voice, 400 ms after.
        assertEquals(1900, h.utterances.get(0), 120);
    }

    @Test
    public void stillSpeakingWhenTheSpotterAnswersTheOpenGateFinishesIt() {
        Script s = new Script();
        Heard h = new Heard();
        LiveListener l = listener(s, h);
        feed(l, quiet(1000));
        // The endpoint after "Lisa" came while the person had begun to speak again.
        s.atS = 1.0;
        s.endS = 1.4;
        s.endAt = 2400 * MS;
        feed(l, voice(400), quiet(500), voice(500));
        assertEquals(java.util.Arrays.asList("keyword lisa", "speech"), h.log);
        feed(l, voice(1000), quiet(1000));
        assertEquals(1, h.utterances.size());
        // From 0.2 s before the keyword (0.8 s) to 400 ms after the voice (3.4 s + 0.4 s).
        assertEquals(3000, h.utterances.get(0), 150);
    }

    @Test
    public void openUtterancesOneByOneNeverAClickAndClosedAgainTheSpotterStartsAfresh() {
        Script s = new Script();
        Heard h = new Heard();
        LiveListener l = listener(s, h);
        feed(l, quiet(500));
        l.setGate(true);
        feed(l, quiet(300), voice(800), quiet(1000), voice(60), quiet(1000), voice(600), quiet(1000));
        assertEquals(2, h.utterances.size());
        // A click is no speech either: it never stops UCAP's voice.
        assertEquals(2, h.log.stream().filter((x) -> x.equals("speech")).count());
        l.setGate(false);
        assertEquals(1, s.resets);
        feed(l, voice(800), quiet(1000));
        assertEquals(2, h.utterances.size());
    }
}
