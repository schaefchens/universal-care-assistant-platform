package de.schaefchens.ucap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The DND matrix measured in lookup (findings/android.md), plus the device's own switches. */
public class SilenceTest {
    private static final int HIGH = 4, DEFAULT = 3;

    @Test
    public void ringsWhereAlarmsMay() {
        assertFalse(Silence.silenced(true, HIGH, Silence.FILTER_ALL, false, false, 80));
        assertFalse(Silence.silenced(true, HIGH, Silence.FILTER_ALARMS, false, false, 80));
        // Priority only: alarms allowed (Android's default), or the channel may break through.
        assertFalse(Silence.silenced(true, HIGH, Silence.FILTER_PRIORITY, false, true, 80));
        assertFalse(Silence.silenced(true, HIGH, Silence.FILTER_PRIORITY, true, false, 80));
    }

    @Test
    public void isSilencedWhereItWouldNotBeHeard() {
        assertTrue(Silence.silenced(true, HIGH, Silence.FILTER_NONE, true, true, 80)); // total silence silences alarms too
        assertTrue(Silence.silenced(true, HIGH, Silence.FILTER_PRIORITY, false, false, 80));
        assertTrue(Silence.silenced(false, HIGH, Silence.FILTER_ALL, false, false, 80)); // notifications off
        assertTrue(Silence.silenced(true, DEFAULT, Silence.FILTER_ALL, false, false, 80)); // channel turned down
        assertTrue(Silence.silenced(true, HIGH, Silence.FILTER_ALL, false, false, 0)); // alarm volume zero
    }

    @Test
    public void namesTheDndMode() {
        assertEquals("off", Silence.dnd(Silence.FILTER_ALL));
        assertEquals("priority", Silence.dnd(Silence.FILTER_PRIORITY));
        assertEquals("none", Silence.dnd(Silence.FILTER_NONE));
        assertEquals("alarms", Silence.dnd(Silence.FILTER_ALARMS));
        assertEquals("off", Silence.dnd(0));
    }
}
