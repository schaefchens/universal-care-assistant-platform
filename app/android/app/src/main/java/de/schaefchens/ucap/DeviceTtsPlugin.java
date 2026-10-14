package de.schaefchens.ucap;

import android.media.AudioAttributes;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The device voice (from lookup's shell). The Android WebView has no speechSynthesis, so UCAP's own speech goes
 * through TextToSpeech, and only through a local, installed voice: for a language whose voice data is missing,
 * Google's engine synthesises on its servers without asking, so the text would leave the device (measured).
 *
 * Changes for UCAP: the chosen voice is cached per language and checked again when it fails (a Play update once
 * removed the installed voices); a null voice list is handled; the engine is warmed up (the first utterance took
 * about 600 ms cold, later ones 65 ms); speech uses the accessibility audio usage; errors carry codes, not text.
 */
@CapacitorPlugin(name = "DeviceTts")
public class DeviceTtsPlugin extends Plugin {
    private TextToSpeech tts;
    private Integer initStatus = null;
    private final List<Runnable> waiting = new ArrayList<>();
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private final Map<String, Voice> chosen = new HashMap<>();

    private static final class Pending {
        double t0, range = -1;
        PluginCall call;
    }

    private static double now() {
        return SystemClock.elapsedRealtimeNanos() / 1e6;
    }

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            synchronized (waiting) {
                initStatus = status;
                for (Runnable r : waiting) r.run();
                waiting.clear();
            }
        });
        tts.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build());
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String id) {}

            @Override
            public void onRangeStart(String id, int start, int end, int frame) {
                // onStart only means the engine accepted the text; this is when speech is heard (measured).
                Pending p = pending.get(id);
                if (p != null && p.range < 0) p.range = now();
            }

            @Override
            public void onDone(String id) {
                finish(id, false);
            }

            @Override
            public void onStop(String id, boolean interrupted) {
                finish(id, true);
            }

            @Override
            public void onError(String id) {
                Pending p = pending.remove(id);
                if (p != null) {
                    chosen.clear(); // the voice may have gone: choose again next time
                    p.call.reject("the engine reported an error", "engine");
                }
            }
        });
    }

    private void finish(String id, boolean stopped) {
        Pending p = pending.remove(id);
        if (p == null) return;
        JSObject r = new JSObject();
        r.put("stopped", stopped);
        r.put("rangeMs", p.range < 0 ? -1 : p.range - p.t0);
        Voice v = tts.getVoice();
        r.put("voice", v != null ? v.getName() : "");
        p.call.resolve(r);
    }

    private void whenReady(PluginCall call, Runnable r) {
        synchronized (waiting) {
            Runnable guarded = () -> {
                if (initStatus == null || initStatus != TextToSpeech.SUCCESS) call.reject("no speech engine", "no_engine");
                else r.run();
            };
            if (initStatus == null) waiting.add(guarded);
            else guarded.run();
        }
    }

    private static boolean local(Voice v) {
        Set<String> features = v.getFeatures();
        return !v.isNetworkConnectionRequired() && (features == null || !features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
    }

    /** A local, installed voice for the language (or the one named), the same one every time; null when none. */
    private Voice pick(String lang, String named) {
        Locale want = Locale.forLanguageTag(lang);
        Set<Voice> voices = tts.getVoices();
        if (voices == null) return null;
        // The engine's own default for the language comes first: the voice the person hears elsewhere on the device.
        Voice preferred = null;
        if (tts.isLanguageAvailable(want) >= TextToSpeech.LANG_AVAILABLE) {
            tts.setLanguage(want);
            preferred = tts.getVoice();
        }
        Voice best = null;
        for (Voice v : voices) {
            if (!local(v)) continue;
            if (named != null) {
                if (v.getName().equals(named)) return v;
                continue;
            }
            if (!v.getLocale().getLanguage().equals(want.getLanguage())) continue;
            if (preferred != null && v.getName().equals(preferred.getName())) return v;
            boolean country = want.getCountry().isEmpty() || want.getCountry().equals(v.getLocale().getCountry());
            boolean bestCountry = best != null && (want.getCountry().isEmpty() || want.getCountry().equals(best.getLocale().getCountry()));
            if (best == null
                || (country && !bestCountry)
                || (country == bestCountry && (v.getQuality() > best.getQuality() || (v.getQuality() == best.getQuality() && v.getName().compareTo(best.getName()) < 0)))) {
                best = v;
            }
        }
        return best;
    }

    private Voice voiceFor(String lang, String named) {
        String key = lang + "|" + (named == null ? "" : named);
        Voice v = chosen.get(key);
        if (v != null && local(v)) return v;
        v = pick(lang, named);
        if (v != null) chosen.put(key, v);
        return v;
    }

    @PluginMethod
    public void check(PluginCall call) {
        String lang = call.getString("lang", "de-DE");
        whenReady(call, () -> {
            Voice v = pick(lang, null);
            JSObject r = new JSObject();
            r.put("local", v != null);
            r.put("voice", v != null ? v.getName() : null);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("lang", "de-DE");
        float rate = call.getFloat("rate", 1f);
        float pitch = call.getFloat("pitch", 1f);
        String named = call.getString("voice");
        whenReady(call, () -> {
            Voice v = voiceFor(lang, named);
            if (v == null) {
                call.reject("no local voice: install its voice data", "no_local_voice");
                return;
            }
            tts.setVoice(v);
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            String id = UUID.randomUUID().toString();
            Pending p = new Pending();
            p.t0 = now();
            p.call = call;
            pending.put(id, p);
            // QUEUE_FLUSH: the app decides what may interrupt what (speech channels in src/audio/speech.ts).
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id);
        });
    }

    /** Loads the voice for a language with an inaudible utterance, so the first real one starts at once. */
    @PluginMethod
    public void warmup(PluginCall call) {
        String lang = call.getString("lang", "de-DE");
        whenReady(call, () -> {
            Voice v = voiceFor(lang, null);
            if (v != null) {
                tts.setVoice(v);
                android.os.Bundle params = new android.os.Bundle();
                params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 0f);
                tts.speak(" ", TextToSpeech.QUEUE_ADD, params, "warmup");
            }
            JSObject r = new JSObject();
            r.put("local", v != null);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    @PluginMethod
    public void voices(PluginCall call) {
        whenReady(call, () -> {
            JSArray list = new JSArray();
            Set<Voice> voices = tts.getVoices();
            if (voices != null) {
                for (Voice v : voices) {
                    JSObject o = new JSObject();
                    o.put("name", v.getName());
                    o.put("locale", v.getLocale().toLanguageTag());
                    o.put("quality", v.getQuality());
                    o.put("network", v.isNetworkConnectionRequired());
                    Set<String> features = v.getFeatures();
                    o.put("installed", features == null || !features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
                    list.put(o);
                }
            }
            JSObject r = new JSObject();
            r.put("engine", tts.getDefaultEngine());
            r.put("voices", list);
            call.resolve(r);
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
    }
}
