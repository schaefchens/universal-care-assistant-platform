package de.schaefchens.ucap.spike4;

import android.os.Process;
import android.util.Log;
import org.json.JSONObject;

/** One line of JSON per event under the tag UcapSpike4: names, states, counts and times, never content. */
final class Ev {
    private Ev() {}

    static void log(String e, Object... kv) {
        try {
            JSONObject o = new JSONObject();
            o.put("e", e);
            o.put("t", System.currentTimeMillis());
            o.put("pid", Process.myPid());
            for (int i = 0; i + 1 < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1] == null ? JSONObject.NULL : kv[i + 1]);
            Log.i("UcapSpike4", o.toString());
        } catch (Exception ex) {
            Log.i("UcapSpike4", "{\"e\":\"log_failed\"}");
        }
    }

    static String err(Throwable t) {
        return t.getClass().getSimpleName() + ": " + t.getMessage();
    }
}
