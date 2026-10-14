package de.schaefchens.ucap;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * Requests this device signs instead of carrying a session (packages/identity/src/signed-request.ts): push receipts
 * and notification actions sent by native code, with the app closed. The statement is "UCAP1/req" 0x00 and the
 * canonical JSON (RFC 8785, for strings, integers, booleans and nested objects) of {srv, org, m, p, bh, idem}; bh is
 * the SHA-256 of the body's canonical JSON. The TypeScript code and this code must produce the same bytes:
 * SignedRequestTest checks this against the shared fixture packages/identity/test/fixtures/signed-requests.json.
 *
 * Pure Java (no Android classes), so it is unit-tested on the JVM.
 */
final class SignedRequest {
    private SignedRequest() {}

    static String jcs(Object v) {
        if (v == null) return "null";
        if (v instanceof Boolean) return v.toString();
        if (v instanceof Integer || v instanceof Long) return v.toString();
        if (v instanceof String) return quote((String) v);
        if (v instanceof Map) {
            // Keys in UTF-16 code unit order, which is String's own order.
            TreeMap<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) sorted.put((String) e.getKey(), e.getValue());
            StringBuilder b = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<String, Object> e : sorted.entrySet()) {
                if (!first) b.append(',');
                b.append(quote(e.getKey())).append(':').append(jcs(e.getValue()));
                first = false;
            }
            return b.append('}').toString();
        }
        if (v instanceof List) {
            StringBuilder b = new StringBuilder("[");
            boolean first = true;
            for (Object o : (List<?>) v) {
                if (!first) b.append(',');
                b.append(jcs(o));
                first = false;
            }
            return b.append(']').toString();
        }
        throw new IllegalArgumentException("signed payloads hold strings, integers, booleans, objects and arrays");
    }

    /** JSON.stringify's escaping: the short forms, other control characters as \\u00xx, everything else as is. */
    static String quote(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\b': b.append("\\b"); break;
                case '\f': b.append("\\f"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    private static final char[] B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

    /** Base64url without padding. Written out because java.util.Base64 needs API 26 and this runs from API 24. */
    static String b64url(byte[] bytes) {
        StringBuilder b = new StringBuilder((bytes.length * 4 + 2) / 3);
        for (int i = 0; i < bytes.length; i += 3) {
            int n = (bytes[i] & 0xff) << 16;
            if (i + 1 < bytes.length) n |= (bytes[i + 1] & 0xff) << 8;
            if (i + 2 < bytes.length) n |= bytes[i + 2] & 0xff;
            b.append(B64URL[(n >> 18) & 63]).append(B64URL[(n >> 12) & 63]);
            if (i + 1 < bytes.length) b.append(B64URL[(n >> 6) & 63]);
            if (i + 2 < bytes.length) b.append(B64URL[n & 63]);
        }
        return b.toString();
    }

    static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** The statement's payload; a body of null hashes as JSON null, as an absent body does in TypeScript. */
    static Map<String, Object> payload(String srv, String org, String method, String path, Object body, String idem) {
        return payloadForJcs(srv, org, method, path, jcs(body), idem);
    }

    /** The same for a body already in canonical JSON (a request kept for a retry is stored that way). */
    static Map<String, Object> payloadForJcs(String srv, String org, String method, String path, String bodyJcs, String idem) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("srv", srv);
        p.put("org", org);
        p.put("m", method.toUpperCase(Locale.ROOT));
        p.put("p", path);
        p.put("bh", b64url(sha256(bodyJcs.getBytes(StandardCharsets.UTF_8))));
        p.put("idem", idem);
        return p;
    }

    static byte[] statement(Map<String, Object> payload) {
        byte[] head = "UCAP1/req".getBytes(StandardCharsets.UTF_8);
        byte[] body = jcs(payload).getBytes(StandardCharsets.UTF_8);
        byte[] out = new byte[head.length + 1 + body.length];
        System.arraycopy(head, 0, out, 0, head.length);
        out[head.length] = 0;
        System.arraycopy(body, 0, out, head.length + 1, body.length);
        return out;
    }

    static String header(String deviceId, String org, String signature) {
        return "did=" + deviceId + "; org=" + org + "; sig=" + signature;
    }
}
