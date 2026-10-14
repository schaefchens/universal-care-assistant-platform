package de.schaefchens.ucap;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

/**
 * Signed requests from native code (SignedRequest): no session, the device key signs. Bodies go out in canonical
 * JSON, the bytes the signature covers. Nothing here logs a body or an answer; failures are reported by class only.
 */
final class Api {
    private Api() {}

    static final class Result {
        /** The HTTP status; 0 when the server was not reached (offline, timeout), -1 when this device is not set up. */
        final int status;
        final String body;

        Result(int status, String body) {
            this.status = status;
            this.body = body;
        }

        boolean ok() {
            return status >= 200 && status < 300;
        }

        /** Worth trying again later: not reached, or the server was unavailable. */
        boolean retry() {
            return status == 0 || status == 429 || status >= 500;
        }

        /** `error.params` of an error answer ({error: {code, params}}), or an empty object. */
        JSONObject params() {
            try {
                JSONObject p = new JSONObject(body).getJSONObject("error").optJSONObject("params");
                return p != null ? p : new JSONObject();
            } catch (Exception e) {
                return new JSONObject();
            }
        }
    }

    static String idem() {
        return UUID.randomUUID().toString();
    }

    static Result signed(Context ctx, String method, String path, Object body, String idem, int timeoutMs) {
        return signedJcs(ctx, method, path, body == null ? null : SignedRequest.jcs(body), idem, timeoutMs);
    }

    /** The same with a body already in canonical JSON (null: no body). */
    static Result signedJcs(Context ctx, String method, String path, String bodyJcs, String idem, int timeoutMs) {
        Ref ref = Ref.load(ctx);
        if (ref == null) return new Result(-1, "");
        HttpURLConnection c = null;
        try {
            String org = ref.org();
            byte[] stmt = SignedRequest.statement(SignedRequest.payloadForJcs(ref.serverId, org, method, path, bodyJcs == null ? "null" : bodyJcs, idem));
            String sig = DeviceSigner.sign(stmt);
            c = (HttpURLConnection) new URL(ref.serverUrl + path).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setRequestProperty("ucap-sig", SignedRequest.header(ref.deviceId, org, sig));
            c.setRequestProperty("idempotency-key", idem);
            if (bodyJcs != null) {
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json");
                try (OutputStream o = c.getOutputStream()) {
                    o.write(bodyJcs.getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            return new Result(status, in == null ? "" : read(in));
        } catch (IllegalStateException e) {
            return new Result(-1, ""); // no device key: signed out or wiped
        } catch (Exception e) {
            android.util.Log.w("UCAP", "signed " + method + " " + path.replaceAll("[0-9a-f-]{36}", ":id") + " failed: " + e.getClass().getSimpleName());
            return new Result(0, "");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String read(InputStream in) throws Exception {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            // Answers here are small (errors, ids); a cap keeps a confused server from filling memory.
            while ((n = s.read(buf)) > 0 && out.size() < 65536) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }
}
