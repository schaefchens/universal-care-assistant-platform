package de.schaefchens.ucap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Only keys that mean nothing else may send help. Codes are Android's KeyEvent constants. */
public class KeyRulesTest {
    @Test
    public void bluetoothButtonsAndSpareKeysAreAllowed() {
        assertNull(KeyRules.reserved(79)); // HEADSETHOOK
        assertNull(KeyRules.reserved(85)); // MEDIA_PLAY_PAUSE
        assertNull(KeyRules.reserved(126)); // MEDIA_PLAY
        assertNull(KeyRules.reserved(27)); // CAMERA
        assertNull(KeyRules.reserved(132)); // F2
        assertNull(KeyRules.reserved(142)); // F12
        assertNull(KeyRules.reserved(96)); // BUTTON_A
    }

    @Test
    public void keysThatMeanSomethingElseAreRefusedWithTheReason() {
        assertEquals("volume", KeyRules.reserved(24));
        assertEquals("volume", KeyRules.reserved(25));
        assertEquals("navigation", KeyRules.reserved(66)); // ENTER
        assertEquals("navigation", KeyRules.reserved(62)); // SPACE
        assertEquals("navigation", KeyRules.reserved(61)); // TAB
        assertEquals("navigation", KeyRules.reserved(21)); // DPAD_LEFT
        assertEquals("navigation", KeyRules.reserved(131)); // F1: "Was kann ich hier tun?"
        assertEquals("navigation", KeyRules.reserved(160)); // NUMPAD_ENTER
        assertEquals("system", KeyRules.reserved(4)); // BACK
        assertEquals("system", KeyRules.reserved(3)); // HOME
        assertEquals("system", KeyRules.reserved(26)); // POWER
        assertEquals("typing", KeyRules.reserved(29)); // A
        assertEquals("typing", KeyRules.reserved(54)); // Z
        assertEquals("typing", KeyRules.reserved(7)); // 0
        assertEquals("typing", KeyRules.reserved(150)); // NUMPAD_6
        assertEquals("typing", KeyRules.reserved(59)); // SHIFT_LEFT
        assertEquals("typing", KeyRules.reserved(115)); // CAPS_LOCK
    }
}
