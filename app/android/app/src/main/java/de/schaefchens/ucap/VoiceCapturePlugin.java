package de.schaefchens.ucap;

import android.Manifest;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Debug;
import android.os.SystemClock;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONArray;
import org.json.JSONObject;
import org.vosk.Model;

/**
 * LIVE mode's microphone (docs/plan-m2.md, L2), for the app's LiveController (app/src/voice/live-native.ts):
 *
 * - `prepare`: the keyword model from the UCAP server, once: downloaded with the session's token, its SHA-256 checked
 *   before it is unpacked into the app's own storage (never anywhere else);
 * - `start` / `stop`: VoiceCaptureService with the keyword, the words beside it and the confidence it needs;
 *   `setGate`: open or closed;
 * - events: `listening`, `keyword` (with what was said with it, as WAV), `utterance` (WAV), `speech` (barge-in),
 *   `stopped` (the microphone denied or taken, a start from the background refused).
 *
 * `bench` (debug builds only) measures the spotter over recordings in the app's storage (tools/live/bench.ts).
 */
@CapacitorPlugin(
    name = "VoiceCapture",
    permissions = {
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone"),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications"),
    }
)
public class VoiceCapturePlugin extends Plugin {
    private static final int RATE = 16000;

    @Override
    public void load() {
        VoiceCaptureService.sink = new VoiceCaptureService.Sink() {
            @Override
            public void listening() {
                notifyListeners("listening", new JSObject());
            }

            @Override
            public void keyword(String word, short[] following) {
                JSObject o = new JSObject();
                o.put("word", word);
                if (following != null) o.put("wav", wavBase64(following));
                notifyListeners("keyword", o);
            }

            @Override
            public void utterance(short[] pcm) {
                JSObject o = new JSObject();
                o.put("wav", wavBase64(pcm));
                o.put("ms", pcm.length / 16);
                notifyListeners("utterance", o);
            }

            @Override
            public void speech() {
                notifyListeners("speech", new JSObject());
            }

            @Override
            public void stopped(String reason) {
                JSObject o = new JSObject();
                o.put("reason", reason);
                notifyListeners("stopped", o);
            }
        };
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicrophone");
            return;
        }
        afterMicrophone(call);
    }

    @PermissionCallback
    private void afterMicrophone(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("microphone denied", "mic_denied");
            return;
        }
        // The notification that says it listens: asked for once; without it Android still lists the service.
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") == PermissionState.PROMPT) {
            requestPermissionForAlias("notifications", call, "afterNotifications");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void afterNotifications(PluginCall call) {
        launch(call);
    }

    private void launch(PluginCall call) {
        Intent i = new Intent(getContext(), VoiceCaptureService.class);
        i.putStringArrayListExtra("keywords", new ArrayList<>(toList(call.getArray("keywords"))));
        i.putStringArrayListExtra("grammar", new ArrayList<>(toList(call.getArray("grammar"))));
        String model = call.getString("model");
        if (model != null) i.putExtra("model", new File(getContext().getFilesDir(), "models/" + model).getAbsolutePath());
        i.putExtra("threshold", call.getDouble("threshold", 0.5));
        i.putExtra("title", call.getString("title", "UCAP"));
        i.putExtra("text", call.getString("text", ""));
        try {
            ContextCompat.startForegroundService(getContext(), i);
        } catch (Exception e) {
            call.reject("not started: " + e.getClass().getSimpleName(), "background");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        VoiceCaptureService.stopAll();
        call.resolve();
    }

    @PluginMethod
    public void setGate(PluginCall call) {
        VoiceCaptureService.setGate(Boolean.TRUE.equals(call.getBoolean("open", false)));
        call.resolve();
    }

    /** Whether the model `dir` is unpacked with this digest (the marker is written last, after unpacking). */
    @PluginMethod
    public void modelReady(PluginCall call) {
        JSObject o = new JSObject();
        o.put("ready", ready(call.getString("id", ""), call.getString("sha256", "")));
        call.resolve(o);
    }

    private boolean ready(String id, String sha256) {
        File marker = new File(getContext().getFilesDir(), "models/" + id + ".ok");
        try {
            return marker.isFile() && new String(Io.readAll(marker), StandardCharsets.UTF_8).trim().equals(sha256);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Downloads model `id` from `url` (with the session's `token`), checks `sha256`, and unpacks it into
     * files/models/<id>/; resolves with the model's directory (`dir`, inside the archive) relative to files/models.
     */
    @PluginMethod
    public void prepare(PluginCall call) {
        String id = call.getString("id", "");
        String url = call.getString("url", "");
        String sha256 = call.getString("sha256", "");
        String token = call.getString("token", "");
        String dir = call.getString("dir", "");
        if (!id.matches("[a-z0-9.-]{1,40}") || !dir.matches("[A-Za-z0-9._-]{1,80}") || !sha256.matches("[0-9a-f]{64}")) {
            call.reject("bad model", "bad_request");
            return;
        }
        new Thread(() -> {
            try {
                if (!ready(id, sha256)) fetchModel(id, url, sha256, token);
                JSObject o = new JSObject();
                o.put("path", id + "/" + dir);
                call.resolve(o);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "model failed" : e.getMessage(), "model_failed");
            }
        }, "ucap-model").start();
    }

    private void fetchModel(String id, String url, String sha256, String token) throws Exception {
        File models = new File(getContext().getFilesDir(), "models");
        if (!models.isDirectory() && !models.mkdirs()) throw new Exception("no storage");
        File zip = new File(models, id + ".zip.part");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        if (c.getResponseCode() != 200) throw new Exception("http_" + c.getResponseCode());
        long total = c.getContentLengthLong();
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        long got = 0, told = 0;
        try (InputStream in = new BufferedInputStream(c.getInputStream()); OutputStream out = new FileOutputStream(zip)) {
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) {
                out.write(buf, 0, n);
                md.update(buf, 0, n);
                got += n;
                if (got - told >= 2_000_000 || got == total) {
                    told = got;
                    JSObject p = new JSObject();
                    p.put("bytes", got);
                    p.put("total", total);
                    notifyListeners("model", p);
                }
            }
        } finally {
            c.disconnect();
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : md.digest()) hex.append(String.format("%02x", b));
        if (!hex.toString().equals(sha256)) {
            zip.delete();
            throw new Exception("digest");
        }
        File target = new File(models, id);
        File tmp = new File(models, id + ".unpacking");
        deleteTree(tmp);
        deleteTree(target);
        String root = tmp.getCanonicalPath() + File.separator;
        try (ZipInputStream in = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            byte[] buf = new byte[64 * 1024];
            for (ZipEntry e; (e = in.getNextEntry()) != null; ) {
                File f = new File(tmp, e.getName());
                // Nothing outside the model's own directory ("zip slip").
                if (!f.getCanonicalPath().startsWith(root)) throw new Exception("bad archive");
                if (e.isDirectory()) {
                    f.mkdirs();
                    continue;
                }
                File parent = f.getParentFile();
                if (parent != null) parent.mkdirs();
                try (OutputStream out = new FileOutputStream(f)) {
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                }
            }
        }
        zip.delete();
        if (!tmp.renameTo(target)) throw new Exception("no storage");
        try (Writer w = new OutputStreamWriter(new FileOutputStream(new File(models, id + ".ok")), StandardCharsets.UTF_8)) {
            w.write(sha256);
        }
    }

    private static void deleteTree(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        f.delete();
    }

    /** 16-bit mono WAV at 16 kHz, base64, for the bridge. */
    static String wavBase64(short[] pcm) {
        ByteBuffer b = ByteBuffer.allocate(44 + pcm.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + pcm.length * 2).put("WAVE".getBytes(StandardCharsets.US_ASCII));
        b.put("fmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1).putInt(RATE).putInt(RATE * 2).putShort((short) 2).putShort((short) 16);
        b.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(pcm.length * 2);
        for (short s : pcm) b.putShort(s);
        return Base64.encodeToString(b.array(), Base64.NO_WRAP);
    }

    private static List<String> toList(JSArray a) {
        List<String> out = new ArrayList<>();
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) out.add(a.optString(i));
        return out;
    }

    // ---- Measurements and tests (docs/spikes/m2.md): debug builds only. ----

    private boolean debuggable() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    /** Plays files/bench/<path> into the running capture instead of the microphone (tools/live/drive.ts). */
    @PluginMethod
    public void inject(PluginCall call) {
        if (!debuggable()) {
            call.reject("debug builds only", "forbidden");
            return;
        }
        String path = call.getString("path", "");
        if (path.contains("..")) {
            call.reject("bad path", "bad_request");
            return;
        }
        try {
            short[] pcm = readWav(new File(getContext().getFilesDir(), "bench/" + path));
            VoiceCaptureService.inject(pcm);
            JSObject o = new JSObject();
            o.put("ms", pcm.length / 16);
            call.resolve(o);
        } catch (Exception e) {
            call.reject("no such recording", "not_found");
        }
    }

    /**
     * Runs each keyword's spotter variants over the recordings in files/bench/<dirs>: `variants` are
     * {id, words} (words beside the keyword; null: the keyword alone; "free": the whole vocabulary). Writes one JSON
     * line per recording to files/bench-results.jsonl.
     */
    @PluginMethod
    public void bench(PluginCall call) {
        if (!debuggable()) {
            call.reject("debug builds only", "forbidden");
            return;
        }
        JSArray dirs = call.getArray("dirs");
        JSArray keywords = call.getArray("keywords");
        JSArray variants = call.getArray("variants");
        new Thread(() -> {
            try {
                call.resolve(runBench(toList(dirs), toList(keywords), variants));
            } catch (Throwable e) {
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage(), "bench_failed");
            }
        }, "ucap-bench").start();
    }

    private JSObject runBench(List<String> dirs, List<String> keywords, JSArray variants) throws Exception {
        File base = getContext().getFilesDir();
        long heap0 = Debug.getNativeHeapAllocatedSize();
        long t0 = SystemClock.elapsedRealtime();
        // The tools' own copy (tools/live/bench.ts), apart from the one the app fetched from its server.
        Model model = new Model(new File(base, "bench-model").getAbsolutePath());
        long modelMs = SystemClock.elapsedRealtime() - t0;
        long heapModel = Debug.getNativeHeapAllocatedSize() - heap0;
        List<File> files = new ArrayList<>();
        for (String d : dirs) collect(new File(base, "bench/" + d), files);
        Collections.sort(files);
        // Each spotter once, reset between recordings: a grammar of many words takes seconds to build.
        Map<String, KeywordSpotter> spotters = new HashMap<>();
        Map<String, Long> ms = new HashMap<>();
        List<String> ids = new ArrayList<>();
        for (int v = 0; v < variants.length(); v++) {
            JSONObject variant = variants.getJSONObject(v);
            String id = variant.getString("id");
            ids.add(id);
            Object words = variant.opt("words");
            for (String k : keywords) {
                List<String> grammar = null;
                if (!"free".equals(words)) {
                    grammar = new ArrayList<>();
                    grammar.add(k);
                    if (words instanceof JSONArray) for (int i = 0; i < ((JSONArray) words).length(); i++) {
                        String w = ((JSONArray) words).getString(i);
                        if (!w.equalsIgnoreCase(k)) grammar.add(w);
                    }
                }
                spotters.put(id + "/" + k, new KeywordSpotter(model, grammar));
            }
            ms.put(id, 0L);
        }
        double audioS = 0;
        File out = new File(base, "bench-results.jsonl");
        try (Writer w = new OutputStreamWriter(new FileOutputStream(out), StandardCharsets.UTF_8)) {
            for (File f : files) {
                short[] pcm = readWav(f);
                double seconds = pcm.length / (double) RATE;
                audioS += seconds;
                JSONObject r = new JSONObject();
                r.put("f", f.getAbsolutePath().substring(new File(base, "bench").getAbsolutePath().length() + 1));
                r.put("s", Math.round(seconds * 100) / 100.0);
                for (String id : ids) {
                    JSONObject heard = new JSONObject();
                    long a = SystemClock.elapsedRealtime();
                    for (String k : keywords) heard.put(k, heardIn(spot(spotters.get(id + "/" + k), pcm), k));
                    ms.put(id, ms.get(id) + (SystemClock.elapsedRealtime() - a) / Math.max(1, keywords.size()));
                    r.put(id, heard);
                }
                w.write(r.toString());
                w.write('\n');
                w.flush();
            }
        }
        for (KeywordSpotter ks : spotters.values()) ks.close();
        model.close();
        JSObject res = new JSObject();
        res.put("files", files.size());
        res.put("audioS", Math.round(audioS));
        res.put("modelLoadMs", modelMs);
        res.put("modelNativeMB", Math.round(heapModel / 1e5) / 10.0);
        JSObject rtf = new JSObject();
        for (String id : ids) rtf.put(id, audioS == 0 ? 0 : Math.round(ms.get(id) / audioS) / 1000.0);
        res.put("rtf", rtf);
        res.put("results", out.getAbsolutePath());
        return res;
    }

    /** A spotter over a whole recording, a tenth of a second at a time as the microphone hands it over; reset after. */
    private static List<KeywordSpotter.Hit> spot(KeywordSpotter ks, short[] pcm) {
        List<KeywordSpotter.Hit> hits = new ArrayList<>();
        short[] chunk = new short[1600];
        for (int at = 0; at < pcm.length; at += chunk.length) {
            int n = Math.min(chunk.length, pcm.length - at);
            System.arraycopy(pcm, at, chunk, 0, n);
            hits.addAll(ks.feed(chunk, n));
        }
        hits.addAll(ks.finish());
        ks.reset();
        return hits;
    }

    private static JSONArray heardIn(List<KeywordSpotter.Hit> hits, String k) throws Exception {
        JSONArray out = new JSONArray();
        for (KeywordSpotter.Hit h : hits) if (h.word.equalsIgnoreCase(k)) out.put(new JSONArray().put(Math.round(h.conf * 1000) / 1000.0).put(Math.round(h.at * 100) / 100.0));
        return out;
    }

    private static void collect(File dir, List<File> into) {
        File[] list = dir.listFiles();
        if (list == null) return;
        for (File f : list) {
            if (f.isDirectory()) collect(f, into);
            else if (f.getName().endsWith(".wav")) into.add(f);
        }
    }

    /** The samples of a 16-bit mono WAV: its data chunk, wherever it is. */
    private static short[] readWav(File f) throws Exception {
        ByteBuffer b = ByteBuffer.wrap(Io.readAll(f)).order(ByteOrder.LITTLE_ENDIAN);
        int at = 12;
        while (at + 8 <= b.limit()) {
            String id = new String(new byte[] { b.get(at), b.get(at + 1), b.get(at + 2), b.get(at + 3) }, StandardCharsets.US_ASCII);
            int size = b.getInt(at + 4);
            if (id.equals("data")) {
                short[] out = new short[size / 2];
                for (int i = 0; i < out.length; i++) out[i] = b.getShort(at + 8 + i * 2);
                return out;
            }
            at += 8 + size + (size % 2);
        }
        throw new IllegalArgumentException("no data chunk");
    }
}
