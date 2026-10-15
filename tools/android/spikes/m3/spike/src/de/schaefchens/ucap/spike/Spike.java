package de.schaefchens.ucap.spike;

import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/**
 * One JSON line per event under the tag UcapSpike (read by drive.ts): ids, counts, times, lengths and a short hash of a
 * text, never the text itself.
 */
final class Spike {
    static final String TAG = "UcapSpike";

    private Spike() {}

    static void log(String event, Object... kv) {
        try {
            JSONObject o = new JSONObject();
            o.put("e", event);
            o.put("t", System.currentTimeMillis());
            o.put("pid", android.os.Process.myPid());
            for (int i = 0; i + 1 < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1] == null ? JSONObject.NULL : kv[i + 1]);
            Log.i(TAG, o.toString());
        } catch (Exception e) {
            Log.i(TAG, "{\"e\":\"log_failed\"}");
        }
    }

    /** The first 8 hex digits of SHA-256: tells texts apart without showing them. */
    static String hash(CharSequence s) {
        if (s == null) return null;
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.toString().getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (int i = 0; i < 4; i++) b.append(String.format("%02x", d[i]));
            return b.toString();
        } catch (Exception e) {
            return "?";
        }
    }

    static int digits(CharSequence s) {
        int n = 0;
        if (s != null) for (int i = 0; i < s.length(); i++) if (Character.isDigit(s.charAt(i))) n++;
        return n;
    }

    /** A number by its shape only: how many digits, and whether it starts with +. */
    static String shape(String number) {
        if (number == null) return null;
        return (number.startsWith("+") ? "+" : "") + digits(number) + " digits";
    }
}
