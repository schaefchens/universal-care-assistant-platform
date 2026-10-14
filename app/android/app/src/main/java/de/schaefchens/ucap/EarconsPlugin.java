package de.schaefchens.ucap;

import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.SoundPool;
import android.os.SystemClock;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Earcons through a SoundPool (lookup measured 5 ms from touch to play()). They use the accessibility audio usage:
 * a person who finds their way by sound must not lose it when the ringer is silent (to verify on devices, AN-08).
 */
@CapacitorPlugin(name = "Earcons")
public class EarconsPlugin extends Plugin {
    private SoundPool pool;
    private final Map<String, Integer> ids = new HashMap<>();

    private static double now() {
        return SystemClock.elapsedRealtimeNanos() / 1e6;
    }

    @PluginMethod
    public void load(PluginCall call) {
        JSArray names = call.getArray("names");
        if (names == null || names.length() == 0) {
            call.reject("no names", "bad_request");
            return;
        }
        double t0 = now();
        releasePool();
        pool = new SoundPool.Builder()
            .setMaxStreams(4)
            .setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build())
            .build();
        Map<Integer, String> byId = new HashMap<>();
        List<String> failed = new ArrayList<>();
        int[] pending = { 0 };
        for (int i = 0; i < names.length(); i++) {
            String name;
            try {
                name = names.getString(i);
            } catch (Exception e) {
                continue;
            }
            // aapt stores .wav uncompressed, so the asset can be opened as a file descriptor.
            try (AssetFileDescriptor fd = getContext().getAssets().openFd("public/earcons/" + name + ".wav")) {
                int id = pool.load(fd, 1);
                ids.put(name, id);
                byId.put(id, name);
                pending[0]++;
            } catch (Exception e) {
                failed.add(name);
            }
        }
        if (pending[0] == 0) {
            resolveLoad(call, 0, failed, t0);
            return;
        }
        int[] loaded = { 0 };
        pool.setOnLoadCompleteListener((p, id, status) -> {
            if (status == 0) loaded[0]++;
            else {
                String name = byId.get(id);
                if (name != null) {
                    failed.add(name);
                    ids.remove(name);
                }
            }
            if (--pending[0] == 0) resolveLoad(call, loaded[0], failed, t0);
        });
    }

    private void resolveLoad(PluginCall call, int loaded, List<String> failed, double t0) {
        JSObject r = new JSObject();
        r.put("loaded", loaded);
        r.put("failed", new JSArray(failed));
        r.put("ms", now() - t0);
        call.resolve(r);
    }

    @PluginMethod
    public void play(PluginCall call) {
        Integer id = ids.get(call.getString("name", ""));
        if (pool == null || id == null) {
            call.reject("not loaded", "not_loaded");
            return;
        }
        float volume = call.getFloat("volume", 1f);
        pool.play(id, volume, volume, 1, 0, 1f);
        JSObject r = new JSObject();
        r.put("at", now());
        call.resolve(r);
    }

    @PluginMethod
    public void release(PluginCall call) {
        releasePool();
        call.resolve();
    }

    private void releasePool() {
        if (pool != null) pool.release();
        pool = null;
        ids.clear();
    }

    @Override
    protected void handleOnDestroy() {
        releasePool();
    }
}
