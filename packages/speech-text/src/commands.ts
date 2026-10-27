/**
 * Commands by voice (docs/plan.md, S8; Appendix D "Voice help"). A whole utterance, normalised, is matched against the
 * phrases of the context it was said in, then against those that work everywhere. A partial match never acts (lookup:
 * no false trigger in 119 near misses per engine; "Ich brauche Hilfe beim Einkaufen" is not the help command).
 *
 * Help is the one that asks instead of staying silent: a help word inside a longer utterance ("Kann mir jemand beim
 * Anziehen helfen?"), or an utterance within one edit of a help phrase of up to five letters and two of a longer one
 * ("Hilde"), asks "Soll ich einen Hilferuf senden?" (A17), and never sends on its own. The exact help phrases act at
 * once (Decisions: "The hardware help key and exact help phrases act at once").
 */
import { distance, normalise } from './normalise.ts';

export type CommandLang = 'de' | 'en';

/**
 * Where the utterance was said: anywhere (`global`), while a yes-or-no question waits (`confirm`: the help ask-back,
 * the assistant's confirmations), on a reminder's question (`reminder`), as the words of a new note (`dictation`), or
 * as a reply to a message (`reply`). Dictation and replies are matched like `global`, so help and stop still work;
 * anything else is the note or the reply.
 */
export type CommandContext = 'global' | 'confirm' | 'reminder' | 'dictation' | 'reply';

export type Intent = 'help' | 'stop' | 'back' | 'home' | 'repeat' | 'louder' | 'quieter' | 'time' | 'whereAmI' | 'whatCanIDo' | 'yes' | 'no' | 'done' | 'later' | 'undo' | 'liveOn' | 'liveOff' | 'pause' | 'resume' | 'news' | 'slower' | 'faster' | 'shorter' | 'longer' | 'biggerText' | 'smallerText' | 'highContrast' | 'normalContrast' | 'lock' | 'calls';

export type Match = { kind: 'command'; intent: Intent } | { kind: 'ask'; reason: 'help_word' | 'help_near' } | { kind: 'none' };

/** The help phrases that send at once, in every context. */
export const HELP_PHRASES: Record<CommandLang, string[]> = {
  de: ['Hilfe', 'Ich brauche Hilfe', 'Hilferuf', 'Ich brauche noch Hilfe'],
  en: ['Help', 'I need help', 'Call for help', 'I still need help'],
};

/** Words that mean help inside a longer utterance: asked about, never acted on. Matched at a word's start. */
const HELP_WORDS: Record<CommandLang, RegExp> = {
  de: /^(hilf|helf|notfall|notruf)/,
  en: /^(help|emergency)/,
};

type Table = Partial<Record<Intent, string[]>>;

/** What works everywhere. No phrase here holds a help word ("Was kann ich hier tun?", never "Hilfe zur Bedienung"). */
const GLOBAL: Record<CommandLang, Table> = {
  de: {
    stop: ['Stopp', 'Stop', 'Halt', 'Hör auf', 'Abbrechen', 'Ruhe'],
    back: ['Zurück', 'Geh zurück'],
    home: ['Startseite', 'Zur Startseite', 'Nach Hause'],
    repeat: ['Wiederholen', 'Wiederhole', 'Noch einmal', 'Nochmal', 'Wie bitte'],
    louder: ['Lauter'],
    // whisper heard "Leiser" as "leise" once (lookup).
    quieter: ['Leiser', 'Leise'],
    time: ['Wie spät ist es?', 'Uhrzeit', 'Wie viel Uhr ist es?'],
    whereAmI: ['Wo bin ich?'],
    whatCanIDo: ['Was kann ich hier tun?', 'Was kann ich tun?'],
    undo: ['Rückgängig', 'Rückgängig machen', 'Mach das rückgängig'],
    // LIVE mode (docs/plan-m2.md): on and off, and a pause in it until "Weiter".
    liveOn: ['LIVE an', 'LIVE-Modus an', 'LIVE einschalten', 'LIVE-Modus einschalten'],
    liveOff: ['LIVE aus', 'LIVE-Modus aus', 'LIVE ausschalten', 'LIVE-Modus ausschalten'],
    pause: ['Pause', 'Mach Pause', 'Mach mal Pause'],
    resume: ['Weiter', 'Mach weiter', 'Hör wieder zu'],
    // What came in since (docs/plan-m2.md, L4: "Was gibt's Neues?").
    news: ["Was gibt's Neues?", 'Was gibt es Neues?', "Gibt's was Neues?", 'Gibt es was Neues?', 'Gibt es etwas Neues?', 'Neuigkeiten'],
    // Speech and the screen by voice (docs/plan-m2.md, L5; CONCEPT §6: "Mach die Schrift größer"), read back with undo.
    slower: ['Langsamer', 'Sprich langsamer', 'Bitte langsamer'],
    faster: ['Schneller', 'Sprich schneller', 'Bitte schneller'],
    shorter: ['Kürzer', 'Antworte kürzer', 'Fass dich kürzer'],
    longer: ['Ausführlicher', 'Antworte ausführlicher', 'Mehr Einzelheiten'],
    biggerText: ['Mach die Schrift größer', 'Schrift größer', 'Größere Schrift'],
    smallerText: ['Mach die Schrift kleiner', 'Schrift kleiner', 'Kleinere Schrift'],
    highContrast: ['Hoher Kontrast', 'Mehr Kontrast', 'Kontrast an', 'Mach den Kontrast höher'],
    normalContrast: ['Normaler Kontrast', 'Kontrast normal', 'Kontrast aus'],
    // The app lock (docs/plan-m4.md, G4): this device locked now; help stays.
    lock: ['Sperren', 'App sperren', 'UCAP sperren', 'Sperre die App'],
    // The calls (docs/plan-m4.md, G10): who called, what was missed.
    calls: ['Wer hat angerufen?', 'Wer hat mich angerufen?', 'Verpasste Anrufe'],
  },
  en: {
    stop: ['Stop', 'Cancel', 'Enough', 'Quiet'],
    back: ['Back', 'Go back'],
    home: ['Home', 'Go home', 'Home screen'],
    repeat: ['Repeat', 'Say that again', 'Again', 'Pardon'],
    louder: ['Louder'],
    quieter: ['Quieter'],
    time: ['What time is it?', 'What is the time?'],
    whereAmI: ['Where am I?'],
    whatCanIDo: ['What can I do here?', 'What can I do?'],
    undo: ['Undo', 'Undo that'],
    liveOn: ['LIVE on', 'LIVE mode on', 'Turn LIVE on'],
    liveOff: ['LIVE off', 'LIVE mode off', 'Turn LIVE off'],
    pause: ['Pause', 'Take a break'],
    resume: ['Resume', 'Continue', 'Go on', 'Listen again'],
    news: ["What's new?", 'What is new?', 'Any news?', 'Anything new?'],
    slower: ['Slower', 'Speak slower'],
    faster: ['Faster', 'Speak faster'],
    shorter: ['Shorter', 'Be brief', 'Shorter answers'],
    longer: ['More detail', 'Longer answers'],
    biggerText: ['Bigger text', 'Make the text bigger', 'Larger text'],
    smallerText: ['Smaller text', 'Make the text smaller'],
    highContrast: ['High contrast', 'More contrast'],
    normalContrast: ['Normal contrast'],
    lock: ['Lock', 'Lock the app', 'Lock UCAP'],
    calls: ['Who called?', 'Who called me?', 'Missed calls'],
  },
};

const CONTEXTS: Record<Exclude<CommandContext, 'global' | 'dictation' | 'reply'>, Record<CommandLang, Table>> = {
  confirm: {
    de: { yes: ['Ja', 'Ja bitte', 'Jawohl', 'Genau', 'Senden', 'Ja senden'], no: ['Nein', 'Nein danke', 'Lieber nicht', 'Nicht senden'] },
    en: { yes: ['Yes', 'Yes please', 'Yeah', 'Send it', 'Send'], no: ['No', 'No thanks', "Don't send it", "Don't send"] },
  },
  // The reminder's question ("Hast du getrunken?"): "Ja" is done. "Hilfe holen" is its fourth answer (S6).
  reminder: {
    de: { done: ['Erledigt', 'Ja', 'Gemacht', 'Fertig', 'Habe ich', 'Hab ich'], later: ['Später', 'Nachher', 'Gleich'], no: ['Nein', 'Nein habe ich nicht'], help: ['Hilfe holen'] },
    en: { done: ['Done', 'Yes', 'Finished', 'I did'], later: ['Later', 'Not now'], no: ['No', 'I did not'], help: ['Get help'] },
  },
};

/** Normalised phrase → intent, per language and context; a phrase belongs to one intent only. */
function build(lang: CommandLang, tables: Table[]): Map<string, Intent> {
  const set = new Map<string, Intent>();
  for (const table of tables)
    for (const [intent, phrases] of Object.entries(table) as [Intent, string[]][])
      for (const p of phrases) {
        const key = normalise(p, lang);
        const other = set.get(key);
        if (other && other !== intent) throw new Error(`commands ${lang}: "${p}" is ${other} and ${intent}`);
        set.set(key, intent);
      }
  return set;
}

const SETS = new Map<string, Map<string, Intent>>();
for (const lang of ['de', 'en'] as const) {
  const help: Table = { help: HELP_PHRASES[lang] };
  SETS.set(`${lang}:global`, build(lang, [help, GLOBAL[lang]]));
  for (const ctx of ['confirm', 'reminder'] as const) SETS.set(`${lang}:${ctx}`, build(lang, [help, CONTEXTS[ctx][lang], GLOBAL[lang]]));
}

/** The help phrases short enough for a tolerance of one edit, and the longer ones (two). */
const NEAR = new Map((['de', 'en'] as const).map((lang) => [lang, HELP_PHRASES[lang].map((p) => normalise(p, lang))]));

/**
 * How the utterance came: by push-to-talk, or heard in LIVE mode (docs/plan-m2.md), where the microphone is always
 * open and a television can say "Hilfe": there an exact help phrase asks too, and silence never sends.
 */
export type MatchMode = 'push' | 'live';

/** What an utterance asks for in this context: a command, the help question, or nothing (then the assistant, S9). */
export function match(transcript: string, lang: CommandLang, context: CommandContext = 'global', mode: MatchMode = 'push'): Match {
  const n = normalise(transcript, lang);
  if (!n) return { kind: 'none' };
  const set = SETS.get(`${lang}:${context === 'dictation' || context === 'reply' ? 'global' : context}`)!;
  const intent = set.get(n) ?? longNear(set, n);
  if (intent === 'help' && mode === 'live') return { kind: 'ask', reason: 'help_word' };
  if (intent) return { kind: 'command', intent };
  if (n.split(' ').some((w) => HELP_WORDS[lang].test(w))) return { kind: 'ask', reason: 'help_word' };
  if (NEAR.get(lang)!.some((p) => distance(n, p) <= (p.length <= 5 ? 1 : 2))) return { kind: 'ask', reason: 'help_near' };
  return { kind: 'none' };
}

/**
 * A long command one edit off ("Macht die Schrift größer", whisper on a short utterance): still that command. Only
 * phrases of twelve letters or more, where one letter cannot make another command; never help, whose near matches ask.
 */
function longNear(set: Map<string, Intent>, n: string): Intent | undefined {
  if (n.length < 12) return undefined;
  for (const [phrase, intent] of set) if (intent !== 'help' && phrase.length >= 12 && distance(n, phrase) <= 1) return intent;
  return undefined;
}

/** Every phrase of a context, for "Was kann ich hier tun?" and the tests. */
export function phrases(lang: CommandLang, context: CommandContext): { intent: Intent; phrase: string }[] {
  const tables = [{ help: HELP_PHRASES[lang] }, ...(context === 'global' || context === 'dictation' || context === 'reply' ? [] : [CONTEXTS[context][lang]]), GLOBAL[lang]];
  return tables.flatMap((t) => (Object.entries(t) as [Intent, string[]][]).flatMap(([intent, ps]) => ps.map((phrase) => ({ intent, phrase }))));
}

/** Whether any non-help phrase holds a help word (it must not: help is never a side effect of another command). */
export function holdsHelpWord(phrase: string, lang: CommandLang): boolean {
  return normalise(phrase, lang)
    .split(' ')
    .some((w) => HELP_WORDS[lang].test(w));
}
