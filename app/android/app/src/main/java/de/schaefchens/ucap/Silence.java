package de.schaefchens.ucap;

/**
 * Whether an alarm would be heard (docs/plan.md, Appendix D "delivered_silenced"): notifications off, the alarm
 * channel turned below "high", Do Not Disturb in total silence, priority-only DND that lets neither alarms nor this
 * channel through, or the alarm volume at zero (lookup/findings/android.md: alarms only and priority only with alarms
 * still ring; total silence does not). A silenced receipt is told to the person (A4b) and escalates.
 *
 * Pure Java, unit-tested on the JVM (SilenceTest). Constants are Android's own values.
 */
final class Silence {
    private Silence() {}

    static final int FILTER_ALL = 1;
    static final int FILTER_PRIORITY = 2;
    static final int FILTER_NONE = 3;
    static final int FILTER_ALARMS = 4;
    static final int IMPORTANCE_HIGH = 4;

    static boolean silenced(boolean notificationsOn, int channelImportance, int filter, boolean channelBypassesDnd, boolean alarmsInPriority, int alarmVolume) {
        if (!notificationsOn || channelImportance < IMPORTANCE_HIGH || alarmVolume <= 0) return true;
        if (filter == FILTER_NONE) return true;
        return filter == FILTER_PRIORITY && !alarmsInPriority && !channelBypassesDnd;
    }

    static String dnd(int filter) {
        switch (filter) {
            case FILTER_PRIORITY: return "priority";
            case FILTER_NONE: return "none";
            case FILTER_ALARMS: return "alarms";
            default: return "off";
        }
    }
}
