package de.schaefchens.ucap;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;

/**
 * The keyword gate on the device (docs/plan-m2.md, the owner's decision): Vosk's small German model, restricted by a
 * grammar to the keyword, ordinary words beside it and "[unk]" (with nothing else to choose, the decoder forces any
 * word onto the keyword: docs/spikes/m2.md). While the gate is closed it alone hears the microphone, and only a
 * keyword it is sure of opens it; nothing it hears leaves the device.
 */
final class KeywordSpotter implements LiveListener.Spotter, AutoCloseable {
    /** A word heard: which, how sure (Vosk's confidence, 0–1), and where in the stream (seconds since its start). */
    static final class Hit {
        final String word;
        final double conf;
        final double at;
        final double end;

        Hit(String word, double conf, double at, double end) {
            this.word = word;
            this.conf = conf;
            this.at = at;
            this.end = end;
        }
    }

    private final Recognizer rec;

    /** `keywords` null: the model's whole vocabulary (its own language model competes with the keyword). */
    KeywordSpotter(Model model, List<String> keywords) throws Exception {
        if (keywords == null) {
            rec = new Recognizer(model, 16000f);
        } else {
            JSONArray grammar = new JSONArray();
            for (String k : keywords) grammar.put(k.toLowerCase());
            grammar.put("[unk]");
            rec = new Recognizer(model, 16000f, grammar.toString());
        }
        rec.setWords(true);
    }

    /** Feeds 16-bit samples; the words of an utterance that ended with them (often none), "[unk]" left out. */
    @Override
    public List<Hit> feed(short[] pcm, int n) {
        return rec.acceptWaveForm(pcm, n) ? hits(rec.getResult()) : new ArrayList<>();
    }

    /** What remains at the end of the stream. */
    List<Hit> finish() {
        return hits(rec.getFinalResult());
    }

    /** Ready for a new stream, keeping its grammar (building one takes seconds with many words). */
    @Override
    public void reset() {
        rec.reset();
    }

    private static List<Hit> hits(String json) {
        List<Hit> out = new ArrayList<>();
        try {
            JSONArray words = new JSONObject(json).optJSONArray("result");
            if (words == null) return out;
            for (int i = 0; i < words.length(); i++) {
                JSONObject w = words.getJSONObject(i);
                String word = w.optString("word");
                if (!word.isEmpty() && !word.equals("[unk]")) out.add(new Hit(word, w.optDouble("conf", 0), w.optDouble("start", 0), w.optDouble("end", 0)));
            }
        } catch (Exception e) {
            // A result that does not parse holds no keyword.
        }
        return out;
    }

    @Override
    public void close() {
        rec.close();
    }
}
