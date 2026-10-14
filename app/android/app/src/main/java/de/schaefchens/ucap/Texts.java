package de.schaefchens.ucap;

import android.content.Context;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * What native code shows a helper, in the language chosen in the app (Ref.lang), not the system's: the alarm, its
 * actions and its updates (docs/plan.md, Appendix D "Helper texts"). Names come from the server; nothing here says
 * that someone is coming (CONCEPT §4).
 */
final class Texts {
    private Texts() {}

    private static final Map<String, String> DE = new HashMap<>();
    private static final Map<String, String> EN = new HashMap<>();

    private static void put(String key, String de, String en) {
        DE.put(key, de);
        EN.put(key, en);
    }

    static {
        put("channel.alarm", "Hilferufe", "Help requests");
        put("channel.alarm.desc", "Hilferufe der Menschen, für die du da bist. Klingt wie ein Wecker.", "Help requests from the people you support. Sounds like an alarm clock.");
        put("channel.quiet", "Hilferufe: Hinweise", "Help requests: updates");
        put("channel.quiet.desc", "Was aus einem Hilferuf geworden ist, ohne Ton.", "What happened to a help request, without sound.");
        put("alert.title", "Hilferuf von %s", "Help request from %s");
        put("alert.unconfirmed", "(nicht bestätigt)", "(not confirmed)");
        put("alert.late", "verspätet empfangen", "received late");
        put("action.accept", "Annehmen", "Accept");
        put("action.decline", "Kann nicht", "Can't help");
        put("action.stop", "Beenden", "Stop");
        put("action.open", "Öffnen", "Open");
        put("sending", "Wird übermittelt…", "Sending…");
        put("accepted.self", "Du hast den Hilferuf von %s angenommen.", "You have accepted the help request from %s.");
        DE.put("accepted.self@Sie", "Sie haben den Hilferuf von %s angenommen.");
        put("update.accepted", "%1$s kümmert sich um den Hilferuf von %2$s.", "%1$s is taking care of the help request from %2$s.");
        put("update.resolved", "Der Hilferuf von %s ist erledigt.", "The help request from %s is resolved.");
        put("update.open", "Der Hilferuf von %s ist wieder offen.", "The help request from %s is open again.");
        put("cancelled", "%s hat den Hilferuf abgebrochen.", "%s has cancelled the help request.");
        put("already", "%s hat bereits angenommen.", "%s has already accepted.");
        put("ended", "Dieser Hilferuf ist nicht mehr offen.", "This help request is no longer open.");
        put("watchdog", "Du hast den Hilferuf von %s vor 20 Minuten angenommen. Bitte markiere ihn als erledigt, wenn alles gut ist.", "You accepted the help request from %s 20 minutes ago. Please mark it as resolved when all is well.");
        DE.put("watchdog@Sie", "Sie haben den Hilferuf von %s vor 20 Minuten angenommen. Bitte markieren Sie ihn als erledigt, wenn alles gut ist.");
        put("test.title", "Test-Alarm", "Test alarm");
        put("test.text", "So klingt ein Hilferuf auf diesem Gerät.", "This is how a help request sounds on this device.");
        put("someone", "jemandem", "someone");
        put("reminder.channel", "Erinnerungen", "Reminders");
        put("reminder.channel.desc", "Deine Erinnerungen, zur eingestellten Zeit.", "Your reminders, at their time.");
        DE.put("reminder.channel.desc@Sie", "Ihre Erinnerungen, zur eingestellten Zeit.");
        put("reminder.done", "Erledigt", "Done");
        put("reminder.later", "Später", "Later");
        put("reminder.missed", "%1$s hat auf die Erinnerung „%2$s“ nicht geantwortet.", "%1$s has not answered the reminder “%2$s”.");
        put("reminder.title", "Erinnerung", "Reminder");
        put("reminder.category.drink", "Trinken", "Drinking");
        put("reminder.category.meal", "Essen", "Meal");
        put("reminder.category.medication", "Medikamente", "Medication");
        put("reminder.category.movement", "Bewegung", "Movement");
        put("reminder.category.wellbeing", "Befinden", "Wellbeing");
        put("reminder.category.appointment", "Termin", "Appointment");
        put("reminder.category.other", "Sonstiges", "Other");
    }

    static String get(String lang, String key) {
        String s = ("en".equals(lang) ? EN : DE).get(key);
        return s != null ? s : key;
    }

    /** In the app's language and the helper's form of address (du or Sie), as the app set them (Ref). */
    static String get(Context ctx, String key) {
        String lang = Ref.lang(ctx);
        if ("Sie".equals(Ref.form(ctx)) && !"en".equals(lang) && DE.containsKey(key + "@Sie")) return DE.get(key + "@Sie");
        return get(lang, key);
    }

    static String format(Context ctx, String key, Object... args) {
        return String.format(Locale.ROOT, get(ctx, key), args);
    }
}
