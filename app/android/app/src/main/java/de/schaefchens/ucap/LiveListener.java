package de.schaefchens.ucap;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * LIVE mode's listening on the device (docs/plan-m2.md, L2), 16 kHz mono as the microphone hands it over:
 *
 * - gate closed: the keyword spotter alone hears every sample, and nothing else is done with them. A keyword it is
 *   sure of opens the gate, and what was said with it in the same breath goes on as the first utterance (from just
 *   before the keyword, so the server hears "Lisa, wie spät ist es?" as it was said).
 * - gate open: utterances found by their loudness against the room's noise (the app's rule, app/src/voice/audio.ts:
 *   three loud frames start one, 700 ms of quiet end it, 300 ms kept before and 400 ms after its voice, 120 ms of
 *   loud sound or it is not passed on), each passed on whole; speech is told once 120 ms of it were heard (barge-in).
 *
 * The spotter's times count the samples it was fed since it was made (Vosk's own clock, which its reset does not
 * set back), so the keyword is found in the spotter's own last 15 seconds. Pure Java (LiveListenerTest).
 */
final class LiveListener {
    interface Spotter {
        /** The words of an utterance that ended with these samples (Vosk: at its own endpoint), "[unk]" left out. */
        List<KeywordSpotter.Hit> feed(short[] pcm, int n);
        void reset();
    }

    interface Events {
        /** The keyword; `following`: from just before it to the end of what was said with it, or null if nothing was. */
        void keyword(String word, short[] following);
        void utterance(short[] pcm);
        void speech();
    }

    static final int RATE = 16000;
    static final int FRAME = 320; // 20 ms
    private static final int RING = 15 * RATE;
    private static final int PRE_FRAMES = 15; // 300 ms before the first loud frame
    private static final int POST_FRAMES = 20; // 400 ms after the last
    private static final int MIN_VOICED = 6; // 120 ms of loud sound
    private static final int END_FRAMES = 35; // 700 ms of quiet
    private static final int MAX_FRAMES = 750; // 15 s
    /** The utterance with the keyword starts this long before it (its first sound is quiet). */
    private static final double BEFORE_KEYWORD_S = 0.2;

    private final Spotter spotter;
    private final List<String> keywords = new ArrayList<>();
    private final double threshold;
    private final Events events;
    private boolean open;

    /** The spotter's stream: how many samples it heard since it was made, the newest RING of them kept. */
    private final short[] ring = new short[RING];
    private long fed;

    private final short[] frame = new short[FRAME];
    private int inFrame;
    /** The room's level: measured in the first 200 ms, followed while nobody speaks. */
    private double floor = -1;
    private int seen;
    private int loudRun;
    private final ArrayDeque<short[]> before = new ArrayDeque<>();
    /** The utterance being heard with the gate open; null between utterances. */
    private List<short[]> utter;
    private int voiced;
    private int lastVoiced;

    LiveListener(Spotter spotter, List<String> keywords, double threshold, Events events) {
        this.spotter = spotter;
        for (String k : keywords) this.keywords.add(k.toLowerCase(Locale.ROOT));
        this.threshold = threshold;
        this.events = events;
    }

    boolean isOpen() {
        return open;
    }

    /** Opens or closes the gate. Opened, the last 300 ms the spotter heard start the first utterance. */
    void setGate(boolean open) {
        if (open == this.open) return;
        this.open = open;
        utter = null;
        loudRun = 0;
        before.clear();
        if (open) {
            int frames = (int) Math.min(PRE_FRAMES, Math.min(fed, RING) / FRAME);
            for (int i = frames; i > 0; i--) before.add(slice(fed - (long) i * FRAME, fed - (long) (i - 1) * FRAME));
        } else if (spotter != null) {
            spotter.reset();
        }
    }

    /** Samples from the microphone. */
    void feed(short[] pcm, int n) {
        if (!open && spotter != null && !keywords.isEmpty()) {
            for (int i = 0; i < n; i++) ring[(int) ((fed + i) % RING)] = pcm[i];
            fed += n;
            List<KeywordSpotter.Hit> hits = spotter.feed(pcm, n);
            for (KeywordSpotter.Hit h : hits) {
                if (!keywords.contains(h.word.toLowerCase(Locale.ROOT)) || h.conf < threshold) continue;
                long start = Math.max(fed - RING, Math.max(0, (long) ((h.at - BEFORE_KEYWORD_S) * RATE)));
                long end = Math.max(start, Math.min(fed, (long) (h.end * RATE)));
                int after = loudFrames(end, fed);
                boolean ongoing = fed - start >= 3L * FRAME && loudFrames(fed - 3L * FRAME, fed) == 3;
                inFrame = 0;
                setGate(true);
                if (ongoing) {
                    // Still speaking when the spotter answered: the utterance goes on through the open gate, from
                    // just before the keyword, and is passed on when it ends.
                    utter = new ArrayList<>();
                    for (long at = start; at + FRAME <= fed; at += FRAME) utter.add(slice(at, at + FRAME));
                    voiced = after + 1;
                    lastVoiced = utter.size() - 1;
                    events.keyword(h.word, null);
                    events.speech();
                } else {
                    // Said and done ("Lisa, wie spät ist es?"), or the name alone (null).
                    events.keyword(h.word, after >= MIN_VOICED ? slice(start, fed) : null);
                }
                return;
            }
        }
        for (int i = 0; i < n; i++) frameSample(pcm[i]);
    }

    /** How many 20 ms frames of the spotter's stream between `from` and `to` are loud. */
    private int loudFrames(long from, long to) {
        int loud = 0;
        for (long at = from; at + FRAME <= to; at += FRAME) if (rms(slice(at, at + FRAME)) > loudLevel()) loud++;
        return loud;
    }

    private short[] slice(long from, long to) {
        short[] out = new short[(int) Math.max(0, to - from)];
        for (int i = 0; i < out.length; i++) out[i] = ring[(int) ((from + i) % RING)];
        return out;
    }

    private void frameSample(short s) {
        frame[inFrame++] = s;
        if (inFrame < FRAME) return;
        inFrame = 0;
        onFrame(frame.clone());
    }

    private double loudLevel() {
        return Math.max(floor * 3, 0.012);
    }

    private void onFrame(short[] f) {
        double level = rms(f);
        if (seen < 10) {
            floor = floor < 0 ? level : (floor * seen + level) / (seen + 1);
            seen++;
            keep(f);
            return;
        }
        boolean loud = level > loudLevel();
        boolean quiet = level <= Math.max(floor * 2, 0.008);
        if (utter == null) {
            if (loud) loudRun++;
            else {
                loudRun = 0;
                // Nobody speaking: the noise may change (a fan, a television); quieter at once, louder slowly.
                if (level < floor) floor = floor * 0.9 + level * 0.1;
                else if (level < floor * 1.5) floor = floor * 0.95 + level * 0.05;
            }
            keep(f);
            if (open && loudRun >= 3) {
                utter = new ArrayList<>(before);
                voiced = loudRun;
                lastVoiced = utter.size() - 1;
                loudRun = 0;
            }
            return;
        }
        utter.add(f);
        int n = utter.size() - 1;
        if (loud) {
            // Speech once it is more than a click or a knock: then UCAP stops talking (barge-in).
            if (++voiced == MIN_VOICED) events.speech();
            lastVoiced = n;
        } else if (!quiet) {
            lastVoiced = n;
        }
        if (n - lastVoiced >= END_FRAMES || utter.size() >= MAX_FRAMES) end();
    }

    private void keep(short[] f) {
        before.add(f);
        while (before.size() > PRE_FRAMES) before.removeFirst();
    }

    private void end() {
        List<short[]> frames = utter;
        utter = null;
        before.clear();
        if (voiced < MIN_VOICED) return;
        int to = Math.min(frames.size(), lastVoiced + 1 + POST_FRAMES);
        short[] out = new short[to * FRAME];
        for (int i = 0; i < to; i++) System.arraycopy(frames.get(i), 0, out, i * FRAME, FRAME);
        events.utterance(out);
    }

    static double rms(short[] f) {
        double sum = 0;
        for (short s : f) {
            double x = s / 32768.0;
            sum += x * x;
        }
        return f.length == 0 ? 0 : Math.sqrt(sum / f.length);
    }
}
