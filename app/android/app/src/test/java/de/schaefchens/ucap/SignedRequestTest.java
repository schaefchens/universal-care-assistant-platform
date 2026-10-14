package de.schaefchens.ucap;

import static org.junit.Assert.assertEquals;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** The TypeScript code made the fixture; this code must sign exactly the same bytes for every case in it. */
public class SignedRequestTest {
    private static Object plain(Object v) throws Exception {
        if (v == JSONObject.NULL) return null;
        if (v instanceof JSONObject) {
            Map<String, Object> m = new LinkedHashMap<>();
            JSONObject o = (JSONObject) v;
            for (Iterator<String> it = o.keys(); it.hasNext(); ) {
                String k = it.next();
                m.put(k, plain(o.get(k)));
            }
            return m;
        }
        if (v instanceof JSONArray) {
            List<Object> l = new ArrayList<>();
            for (int i = 0; i < ((JSONArray) v).length(); i++) l.add(plain(((JSONArray) v).get(i)));
            return l;
        }
        return v;
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    @Test
    public void base64urlMatchesTheJdk() {
        java.util.Random r = new java.util.Random(7);
        for (int n = 0; n < 70; n++) {
            byte[] b = new byte[n];
            r.nextBytes(b);
            assertEquals(java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b), SignedRequest.b64url(b));
        }
    }

    @Test
    public void statementsMatchTheTypeScriptFixture() throws Exception {
        Path file = Paths.get("../../../packages/identity/test/fixtures/signed-requests.json");
        JSONArray cases = new JSONObject(new String(Files.readAllBytes(file), StandardCharsets.UTF_8)).getJSONArray("cases");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            JSONObject in = c.getJSONObject("input");
            Object body = in.has("body") ? plain(in.get("body")) : null;
            Map<String, Object> payload = SignedRequest.payload(in.getString("srv"), in.getString("org"), in.getString("method"), in.getString("path"), body, in.getString("idem"));
            assertEquals("case " + i, c.getString("statementHex"), hex(SignedRequest.statement(payload)));
        }
    }
}
