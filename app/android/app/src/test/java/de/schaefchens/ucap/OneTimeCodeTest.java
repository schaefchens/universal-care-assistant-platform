package de.schaefchens.ucap;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** The same cases as the server's detector (server/test/codes.test.ts): the notification and the server agree. */
public class OneTimeCodeTest {
    private static JSONObject cases() throws Exception {
        return new JSONObject(new String(Files.readAllBytes(Paths.get("../../../server/test/fixtures/one-time-codes.json")), StandardCharsets.UTF_8));
    }

    @Test
    public void findsTheCodesServicesSend() throws Exception {
        JSONArray codes = cases().getJSONArray("codes");
        for (int i = 0; i < codes.length(); i++) assertTrue(codes.getString(i), OneTimeCode.in(codes.getString(i)));
    }

    @Test
    public void notWhatOnlyLooksLikeOne() throws Exception {
        JSONArray not = cases().getJSONArray("notCodes");
        for (int i = 0; i < not.length(); i++) assertFalse(not.getString(i), OneTimeCode.in(not.getString(i)));
        assertFalse(OneTimeCode.in(null));
        assertFalse(OneTimeCode.in(""));
    }
}
