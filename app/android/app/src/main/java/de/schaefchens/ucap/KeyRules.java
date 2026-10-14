package de.schaefchens.ucap;

/**
 * Which keys may become the help key (docs/plan.md, S5 "the Keys plugin"). A help key sends at once, so it must be a
 * key that is never pressed for anything else: not the volume keys (TalkBack's shortcut is both of them), not the keys
 * that move between and press areas (arrows, Enter, Space, Tab, Escape, F1 for "Was kann ich hier tun?"), not
 * system keys, and not keys that type (letters, digits, punctuation), which recovery words and codes need. Bluetooth
 * buttons usually send media keys or the camera key, and those are allowed.
 *
 * Key codes are Android's KeyEvent constants. Pure Java, unit-tested on the JVM (KeyRulesTest).
 */
final class KeyRules {
    private KeyRules() {}

    static final int KEYCODE_HOME = 3, KEYCODE_BACK = 4, KEYCODE_CALL = 5, KEYCODE_ENDCALL = 6;
    static final int KEYCODE_0 = 7, KEYCODE_9 = 16, KEYCODE_STAR = 17, KEYCODE_POUND = 18;
    static final int KEYCODE_DPAD_UP = 19, KEYCODE_DPAD_CENTER = 23, KEYCODE_VOLUME_UP = 24, KEYCODE_VOLUME_DOWN = 25, KEYCODE_POWER = 26;
    static final int KEYCODE_CAMERA = 27, KEYCODE_A = 29, KEYCODE_Z = 54, KEYCODE_COMMA = 55, KEYCODE_PERIOD = 56;
    static final int KEYCODE_ALT_LEFT = 57, KEYCODE_SHIFT_RIGHT = 60, KEYCODE_TAB = 61, KEYCODE_SPACE = 62, KEYCODE_SYM = 63;
    static final int KEYCODE_ENTER = 66, KEYCODE_DEL = 67, KEYCODE_GRAVE = 68, KEYCODE_AT = 77, KEYCODE_NUM = 78;
    static final int KEYCODE_HEADSETHOOK = 79, KEYCODE_MENU = 82, KEYCODE_SEARCH = 84, KEYCODE_MEDIA_PLAY_PAUSE = 85;
    static final int KEYCODE_PLUS = 81, KEYCODE_MUTE = 91, KEYCODE_ESCAPE = 111, KEYCODE_FORWARD_DEL = 112;
    static final int KEYCODE_CTRL_LEFT = 113, KEYCODE_META_RIGHT = 118, KEYCODE_FUNCTION = 119;
    static final int KEYCODE_F1 = 131, KEYCODE_F12 = 142, KEYCODE_NUMPAD_0 = 144, KEYCODE_NUMPAD_RIGHT_PAREN = 163;
    static final int KEYCODE_VOLUME_MUTE = 164, KEYCODE_APP_SWITCH = 187, KEYCODE_ASSIST = 219, KEYCODE_SLEEP = 223, KEYCODE_WAKEUP = 224;
    static final int KEYCODE_SYSTEM_NAVIGATION_UP = 280, KEYCODE_SYSTEM_NAVIGATION_RIGHT = 283, KEYCODE_ALL_APPS = 284;
    static final int KEYCODE_DPAD_UP_LEFT = 268, KEYCODE_DPAD_DOWN_RIGHT = 271;

    private static boolean between(int code, int a, int b) {
        return code >= a && code <= b;
    }

    /** Why a key cannot be the help key, or null when it can: "volume", "navigation", "system", "typing". */
    static String reserved(int code) {
        if (code == KEYCODE_VOLUME_UP || code == KEYCODE_VOLUME_DOWN || code == KEYCODE_VOLUME_MUTE || code == KEYCODE_MUTE) return "volume";
        if (between(code, KEYCODE_DPAD_UP, KEYCODE_DPAD_CENTER) || between(code, KEYCODE_DPAD_UP_LEFT, KEYCODE_DPAD_DOWN_RIGHT) || code == KEYCODE_ENTER
            || code == 160 /* NUMPAD_ENTER */ || code == KEYCODE_SPACE || code == KEYCODE_TAB || code == KEYCODE_ESCAPE || code == KEYCODE_F1 || code == KEYCODE_DEL
            || code == KEYCODE_FORWARD_DEL || between(code, 92, 93) /* PAGE_UP/DOWN */ || between(code, 122, 123) /* MOVE_HOME/END */) return "navigation";
        if (code == KEYCODE_HOME || code == KEYCODE_BACK || code == KEYCODE_POWER || code == KEYCODE_MENU || code == KEYCODE_APP_SWITCH || code == KEYCODE_SLEEP
            || code == KEYCODE_WAKEUP || code == KEYCODE_ENDCALL || code == KEYCODE_ALL_APPS || between(code, KEYCODE_SYSTEM_NAVIGATION_UP, KEYCODE_SYSTEM_NAVIGATION_RIGHT)
            || code == 0 /* UNKNOWN */) return "system";
        if (between(code, KEYCODE_0, KEYCODE_POUND) || between(code, KEYCODE_A, KEYCODE_PERIOD) || between(code, KEYCODE_GRAVE, KEYCODE_AT) || code == KEYCODE_PLUS
            || between(code, KEYCODE_NUMPAD_0, KEYCODE_NUMPAD_RIGHT_PAREN) || between(code, KEYCODE_ALT_LEFT, KEYCODE_SHIFT_RIGHT) || code == KEYCODE_SYM
            || code == KEYCODE_NUM || between(code, KEYCODE_CTRL_LEFT, KEYCODE_FUNCTION) || code == 143 /* NUM_LOCK */) return "typing";
        return null;
    }
}
