package de.schaefchens.ucap;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Whether a message carries a one-time code: server/src/messaging/codes.ts in Java, for UCAP's SMS notification, which
 * shows a message's text but never a code (docs/plan-m3.md, K8: "One-time codes are never said by themselves"; TalkBack
 * reads a notification out as it comes). Both are checked against the same cases (server/test/fixtures/
 * one-time-codes.json): a code word near something shaped like a code, within 80 characters.
 */
final class OneTimeCode {
    private OneTimeCode() {}

    private static final int NOCASE = Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE;
    private static final Pattern WORD = Pattern.compile(
        "(?<![\\p{L}\\p{N}])(?:[\\p{L}-]*codes?|(?:m|sms|push|chip|photo|app|i|e)?-?tans?|pins?|otp|2fa|passcodes?|passwords?|[\\p{L}-]*passw(?:ort|örter)|[\\p{L}-]*kennw(?:ort|örter))(?![\\p{L}\\p{N}])",
        NOCASE);
    /** Compounds that name no one-time code: "QR-Code", "Gutscheincode", "Fehlercode". */
    private static final Pattern NOT_A_CODE_WORD = Pattern.compile(
        "^(?:qr|bar|strich|gutschein|rabatt|promo|aktions|fehler|quell|programm|farb|länder|status|html|zip|area|post|dress|source|error|country|discount|coupon|voucher)");
    /** The same as separate words before "code": "zip code", "error code", "QR Code". */
    private static final Pattern NOT_A_CODE_BEFORE = Pattern.compile(
        "(?:^|[^\\p{L}])(?:qr|bar|zip|area|error|source|promo|discount|coupon|voucher|dress|status|country)[ -]?\\z", NOCASE);
    /** Four to eight digits, alone or in two groups, never part of a longer number, a date, a time or a price. */
    private static final Pattern DIGITS = Pattern.compile(
        "(?<![\\p{L}\\p{N}.,:/+#€$]|[0-9][ -])(?:[0-9]{4,8}|[0-9]{2,4}[ -][0-9]{2,4})(?![\\p{L}\\p{N}%€$]|[.,:/][0-9]|[ -][0-9])");
    /** Capitals and digits: at least two digits and one capital. */
    private static final Pattern MIXED = Pattern.compile("(?<![\\p{L}\\p{N}])[A-Z0-9]{5,10}(?![\\p{L}\\p{N}])");
    private static final Pattern DIGIT = Pattern.compile("[0-9]");
    private static final int NEAR = 80;

    static boolean in(String text) {
        if (text == null || !DIGIT.matcher(text).find()) return false;
        List<int[]> words = new ArrayList<>();
        Matcher w = WORD.matcher(text);
        while (w.find()) {
            String word = w.group().toLowerCase(Locale.ROOT).replace("-", "");
            boolean before = word.matches("^codes?$") && NOT_A_CODE_BEFORE.matcher(text.substring(Math.max(0, w.start() - 12), w.start())).find();
            if (NOT_A_CODE_WORD.matcher(word).find() || before) continue;
            words.add(new int[] {w.start(), w.end()});
        }
        if (words.isEmpty()) return false;
        List<int[]> codes = new ArrayList<>();
        Matcher d = DIGITS.matcher(text);
        while (d.find()) codes.add(new int[] {d.start(), d.end()});
        Matcher m = MIXED.matcher(text);
        while (m.find()) {
            String c = m.group();
            if (c.replaceAll("[^0-9]", "").length() >= 2 && c.matches(".*[A-Z].*")) codes.add(new int[] {m.start(), m.end()});
        }
        for (int[] c : codes) {
            for (int[] x : words) {
                int gap = c[0] >= x[1] ? c[0] - x[1] : x[0] >= c[1] ? x[0] - c[1] : 0;
                if (gap <= NEAR) return true;
            }
        }
        return false;
    }
}
