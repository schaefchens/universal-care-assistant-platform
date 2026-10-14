/**
 * The phrases: what speakers read into the recorder, and what the bench checks transcripts against.
 *
 * - `command`: every phrase of the command table, which must map to its intent.
 * - `near-miss`: utterances that contain or sound like a command word and must map to none.
 * - `number`: numbers, times and dates; right if the transcript equals one of `accept` after normalising.
 * - `dictation`: notes and messages for the word error rate; written without digits, which whisper
 *   spells either way.
 *
 * The Arabic phrases are Modern Standard Arabic. They are marked `checked: false` until a native
 * speaker has read them: none is recorded before that.
 */

export type Lang = 'de' | 'en' | 'ar';
export type Kind = 'command' | 'near-miss' | 'number' | 'dictation';
export type Intent = 'help' | 'stop' | 'back' | 'repeat' | 'louder' | 'quieter' | 'time' | 'whereAmI' | 'yes' | 'no';

export interface Phrase {
  id: string;
  lang: Lang;
  kind: Kind;
  text: string;
  intent?: Intent;
  /** Other spellings that count as right, for numbers, times and dates. */
  accept?: string[];
  checked?: false;
}

/** The command phrase sets. Each phrase belongs to one intent only. */
export const FAST_PATH: Record<Lang, Record<Intent, string[]>> = {
  de: {
    help: ['Hilfe', 'Ich brauche Hilfe', 'Hilferuf'],
    stop: ['Stopp', 'Halt', 'Hör auf', 'Abbrechen'],
    back: ['Zurück'],
    repeat: ['Wiederholen', 'Noch einmal'],
    louder: ['Lauter'],
    quieter: ['Leiser', 'Leise'],
    time: ['Wie spät ist es?', 'Uhrzeit'],
    whereAmI: ['Wo bin ich?'],
    yes: ['Ja', 'Senden'],
    no: ['Nein'],
  },
  en: {
    help: ['Help', 'I need help', 'Call for help'],
    stop: ['Stop', 'Cancel', 'Enough'],
    back: ['Back', 'Go back'],
    repeat: ['Repeat', 'Say that again'],
    louder: ['Louder'],
    quieter: ['Quieter'],
    time: ['What time is it?'],
    whereAmI: ['Where am I?'],
    yes: ['Yes', 'Send it'],
    no: ['No'],
  },
  ar: {
    help: ['مساعدة', 'أحتاج مساعدة', 'النجدة'],
    stop: ['توقف', 'كفى', 'إلغاء'],
    back: ['رجوع', 'ارجع'],
    repeat: ['كرر', 'أعد', 'مرة أخرى'],
    louder: ['أعلى'],
    quieter: ['أخفض'],
    time: ['كم الساعة؟'],
    whereAmI: ['أين أنا؟'],
    yes: ['نعم', 'أجل'],
    no: ['لا'],
  },
};

const NEAR_MISSES: Record<Lang, string[]> = {
  de: [
    'Ich brauche Hilfe beim Einkaufen',
    'Hilde',
    'Halt mir bitte die Tür auf',
    'Lauter Unsinn heute im Fernsehen',
    'Ja, aber erst später',
    'Zurück vom Arzt bin ich gegen Mittag',
  ],
  en: [
    'I need help with the shopping',
    'Hello',
    'Stop by the bakery later',
    'Back from the doctor at noon',
    'Yes, but later',
  ],
  ar: ['أحتاج مساعدة في التسوق', 'توقف المطر', 'نعم، ولكن لاحقًا'],
};

const NUMBERS: Record<Lang, { text: string; accept: string[] }[]> = {
  de: [
    { text: 'Dreiundzwanzig', accept: ['23'] },
    { text: 'Um halb drei', accept: ['um halb 3', 'um 2:30', 'um 14:30', 'um 2:30 uhr', 'um 14:30 uhr'] },
    { text: 'Am vierzehnten Oktober', accept: ['am 14 oktober'] },
    { text: 'Viertel vor acht', accept: ['viertel vor 8', '7:45', '7:45 uhr'] },
    { text: 'Neunzehnhundertvierundvierzig', accept: ['1944'] },
    { text: 'Zimmer zweihundertvierzehn', accept: ['zimmer 214'] },
    { text: 'Erinnere mich in zwanzig Minuten', accept: ['erinnere mich in 20 minuten'] },
    { text: 'Am Dienstag um acht Uhr', accept: ['am dienstag um 8 uhr', 'am dienstag um 8:00 uhr', 'am dienstag um 8:00'] },
  ],
  en: [
    { text: 'Twenty-three', accept: ['23', 'twenty three'] },
    { text: 'At half past two', accept: ['at half past 2', 'at 2:30'] },
    { text: 'On the fourteenth of October', accept: ['on the 14th of october', 'on 14 october', 'on october 14th', 'on october 14'] },
    { text: 'A quarter to eight', accept: ['a quarter to 8', 'quarter to eight', 'quarter to 8', '7:45'] },
    { text: 'Nineteen forty-four', accept: ['1944', 'nineteen forty four'] },
    { text: 'Room two hundred and fourteen', accept: ['room 214', 'room two hundred fourteen'] },
    { text: 'Remind me in twenty minutes', accept: ['remind me in 20 minutes'] },
    { text: "On Tuesday at eight o'clock", accept: ["on tuesday at 8 o'clock", 'on tuesday at 8:00', 'on tuesday at 8'] },
  ],
  ar: [
    { text: 'ثلاثة وعشرون', accept: ['23'] },
    { text: 'الساعة الثالثة والنصف', accept: ['الساعة 3:30', '3:30'] },
    { text: 'الرابع عشر من أكتوبر', accept: ['14 أكتوبر', '14 من أكتوبر'] },
    { text: 'بعد عشرين دقيقة', accept: ['بعد 20 دقيقة'] },
    { text: 'يوم الثلاثاء في الساعة الثامنة', accept: ['يوم الثلاثاء في الساعة 8', 'يوم الثلاثاء في الساعة 8:00'] },
    { text: 'ثلاث حبات في اليوم', accept: ['3 حبات في اليوم'] },
  ],
};

const DICTATION: Record<Lang, string[]> = {
  de: [
    'Erinnere mich morgen früh an meine Tabletten.',
    'Schreib Anna, dass ich heute etwas später komme.',
    'Ich habe heute Nachmittag einen Termin beim Hausarzt.',
    'Bitte sag meinem Sohn, dass der Arzt angerufen hat.',
    'Notiz: Brot, Milch und Äpfel einkaufen.',
    'Die Heizung im Schlafzimmer wird nicht richtig warm.',
    'Frau Berger kommt am Donnerstag zum Kaffee.',
    'Ich habe schlecht geschlafen und bin heute sehr müde.',
    'Kannst du mir die Nachricht von gestern noch einmal vorlesen?',
    'Schreib Peter: Vielen Dank für die schönen Blumen.',
    'Ich möchte nächste Woche meine Schwester in Hamburg besuchen.',
    'Mein Rücken tut seit gestern Abend weh.',
    'Erinnere mich am Freitag an den Geburtstag von Klara.',
    'Der Fernseher ist zu laut, ich verstehe nichts.',
    'Bitte schreib auf, dass der Wasserhahn in der Küche tropft.',
    'Wir treffen uns nach dem Mittagessen vor der Apotheke.',
    'Ich habe meine Brille im Wohnzimmer liegen lassen.',
    'Sag Maria, sie soll mir beim Einkaufen helfen.',
    'Heute war ein schöner Tag im Garten.',
    'Lies mir bitte die Wettervorhersage für morgen vor.',
  ],
  en: [
    'Remind me tomorrow morning to take my tablets.',
    'Tell Anna I will be a little late today.',
    'I have an appointment with the doctor this afternoon.',
    'Please tell my son that the doctor called.',
    'Note: buy bread, milk and apples.',
    'The heating in the bedroom is not getting warm.',
    'Mrs Berger is coming for coffee on Thursday.',
    'I slept badly and I am very tired today.',
    "Can you read yesterday's message to me again?",
    'Tell Peter: thank you for the lovely flowers.',
    'I would like to visit my sister in Hamburg next week.',
    'My back has been hurting since last night.',
    "Remind me about Clara's birthday on Friday.",
    "The television is too loud, I can't understand anything.",
    'Please write down that the kitchen tap is dripping.',
    'We are meeting outside the pharmacy after lunch.',
    'I left my glasses in the living room.',
    'Ask Maria to help me with the shopping.',
    'It was a lovely day in the garden today.',
    "Please read me tomorrow's weather forecast.",
  ],
  ar: [
    'ذكّرني صباح الغد بتناول دوائي.',
    'أخبر سارة أنني سأتأخر قليلًا اليوم.',
    'لديّ موعد مع الطبيب بعد الظهر.',
    'من فضلك اقرأ لي الرسالة مرة أخرى.',
    'التدفئة في غرفة النوم لا تعمل جيدًا.',
    'اشترِ الخبز والحليب والتفاح.',
    'لم أنم جيدًا الليلة الماضية.',
    'أريد أن أزور أختي في الأسبوع القادم.',
    'صوت التلفاز مرتفع جدًا ولا أفهم شيئًا.',
    'كان يومًا جميلًا في الحديقة.',
  ],
};

function build(): Phrase[] {
  const out: Phrase[] = [];
  for (const lang of ['de', 'en', 'ar'] as const) {
    const arabic = lang === 'ar' ? { checked: false as const } : {};
    for (const [intent, texts] of Object.entries(FAST_PATH[lang]) as [Intent, string[]][]) {
      texts.forEach((text, i) => out.push({ id: `${lang}-cmd-${intent}-${i + 1}`, lang, kind: 'command', text, intent, ...arabic }));
    }
    NEAR_MISSES[lang].forEach((text, i) => out.push({ id: `${lang}-near-${i + 1}`, lang, kind: 'near-miss', text, ...arabic }));
    NUMBERS[lang].forEach((n, i) => out.push({ id: `${lang}-num-${i + 1}`, lang, kind: 'number', text: n.text, accept: n.accept, ...arabic }));
    DICTATION[lang].forEach((text, i) => out.push({ id: `${lang}-dict-${i + 1}`, lang, kind: 'dictation', text, ...arabic }));
  }
  return out;
}

export const PHRASES: Phrase[] = build();
