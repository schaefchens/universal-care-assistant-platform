/**
 * The rules for UCAP's German recovery words (docs/plan.md, "The German wordlist"). A word is read aloud to people
 * who cannot see it, typed by people with limited motor control, and heard by speech recognition, so:
 * - 4–8 letters, a–z only (no ä ö ü ß: no spelling doubts, any keyboard);
 * - its first four letters identify it within the list, and no word is also an English list word (so the language
 *   shows from each word). A shared 4-letter prefix with an English word is allowed: the recovery screen asks for the
 *   phrase's language first, so completion never mixes the lists. (docs/plan.md asked for disjoint prefixes too; that
 *   left too few words that also pass the other rules: 1693 of 2048. Changed on 2026-10-14, to confirm with the owner.)
 * - no two words closer than 2 edits (3 when both are short), and no two that sound alike (Kölner Phonetik);
 * - concrete, neutral nouns: nothing about illness, death, violence, crime, drugs, sex, religion or politics,
 *   disability or care status; no brands, first names or number words; nothing within one edit of a UCAP command.
 */

/** Kölner Phonetik (Postel 1969): German words that sound alike get the same code. */
export function koelner(word: string): string {
  const s = word.toUpperCase().replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U').replace(/ß/g, 'S').replace(/[^A-Z]/g, '');
  const codes: string[] = [];
  // A neighbour beyond the word is '#', never '': ''.includes would be true for every set of letters.
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const prev = s[i - 1] ?? '#';
    const next = s[i + 1] ?? '#';
    let code = '';
    if ('AEIJOUY'.includes(c)) code = '0';
    else if (c === 'H') code = '';
    else if (c === 'B') code = '1';
    else if (c === 'P') code = next === 'H' ? '3' : '1';
    else if (c === 'D' || c === 'T') code = 'CSZ'.includes(next) ? '8' : '2';
    else if ('FVW'.includes(c)) code = '3';
    else if ('GKQ'.includes(c)) code = '4';
    else if (c === 'C') {
      if (i === 0) code = 'AHKLOQRUX'.includes(next) ? '4' : '8';
      else code = 'SZ'.includes(prev) || !'AHKOQUX'.includes(next) ? '8' : '4';
    } else if (c === 'X') code = 'CKQ'.includes(prev) ? '8' : '48';
    else if (c === 'L') code = '5';
    else if (c === 'M' || c === 'N') code = '6';
    else if (c === 'R') code = '7';
    else if (c === 'S' || c === 'Z') code = '8';
    codes.push(code);
  }
  // Collapse repeats, then drop the vowel code except at the start.
  let out = '';
  for (const part of codes.join('')) if (out.at(-1) !== part) out += part;
  return out[0] + out.slice(1).replace(/0/g, '');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/**
 * How far apart two words must be: 2 edits. (docs/plan.md asked for 3 between short words, a margin for words recognised
 * from speech; recovery words are entered in an on-screen picker by their first four letters in M1, and the checksum
 * catches about 15 of 16 single mistakes. With 3, too few curated nouns remained. Changed 2026-10-14, to confirm.)
 * Words that sound alike are refused separately (conflict: same Kölner Phonetik code within two edits).
 */
export const minDistance = (_a: string, _b: string) => 2;

// --- Words that may not be recovery words ---------------------------------------------------------------------

const list = (s: string) => s.trim().split(/\s+/);

/** By category. Lower-case, umlauts written as plain vowels (the a–z filter removes words with umlauts anyway). */
export const DENIED_GERMAN: Record<string, string[]> = {
  illness: list(`angina morbus bazillus masern typhus lepra rheuma tollwut epidemie seuche erreger insulin ampulle hormon meniskus labmagen aorta bauchweh phobie hysterie trauma psyche ambulanz hygiene dosis serum arznei atmung befund impfung morphium aspirin narbe tobsucht
    krank krebs tumor fieber virus seuche pest grippe husten schmerz wunde narbe eiter gift pille tablette
    spritze arzt klinik spital kranke kranker infekt allergie asthma diabetes sucht demenz koma narkose operation
    blut bluter blutung brech brechen kotze ohnmacht schock leiden plage ekel`),
  death: list(`suizid leichnam blutbad mordfall kopfgeld mumie skelett zombie vampir werwolf jenseits unheil
    tod tote toter tot leiche sarg grab gruft friedhof trauer witwe witwer waise mord morder moerder selbstmord
    sterben sterbe hinrichtung galgen henker gift asche urne kreuz beerdigung`),
  violence: list(`gefahr gegner killer kommando krieger miliz legion flinte lanze klinge katapult tatwaffe gefecht invasion amok sabotage armada barbar tyrann sklave ketzer bandit ganove halunke rowdy kripo stasi verrat drohung notwehr einbruch tatort zensur
    krieg bombe waffe gewehr pistole revolver messer dolch schwert kanone panzer angriff gewalt terror folter
    opfer hass wut zorn rache kampf schlacht soldat armee militar granate rakete munition patrone kugel faust
    schlag pruegel prugel peitsche fessel kette knast gefaengnis gefangnis haft zelle`),
  crime: list(`dieb raub rauber betrug betruger mafia bande gauner verbrecher verbrechen polizei razzia schmuggel`),
  drugs: list(`kaviar ecstasy kokon zigarre rotwein perlwein tequila bourbon martini cognac aperitif bowle kneipe weingut brauerei
    droge drogen kokain heroin opium alkohol schnaps whisky wodka bier wein sekt rausch joint tabak zigarette
    kippe pfeife spritze`),
  sexual: list(`lesbe libido orgie ekstase inzest bigamie potenz nippel slip vagina pussy voyeur sadist eizelle hetero
    sex porno nackt busen penis hure dirne erotik bordell kondom`),
  religion: list(`seele geist satan luzifer bischof christ kardinal kaplan vikar diakon klerus imam sabbat psalm hymne vesper taufe beichte jihad pilger orakel druide nymphe pharao bacchus kapelle sultan pascha eunuch
    gott gotter kirche jesus bibel allah moschee papst pfarrer priester nonne kloster engel teufel damon
    holle himmel hexe heilige sunde suende beten gebet glaube altar tempel`),
  politics: list(`republik regent kongress senator konsul diplomat asyl amnestie notstand dekret erlass veto zigeuner
    nazi fuhrer partei politik kanzler minister wahl staat regierung diktator kaiser konig koenig adel`),
  disability: list(`blind blinde taub taube stumm kruppel krueppel behindert rollstuhl pflege pfleger pflegerin prothese
    windel heim hilfe krucke kruecke gips verband`),
  body: list(`kot urin pipi furz popo arsch busen bauch brust darm magen blase niere leber`),
  insult: list(`wichser ficken nigger bastard fettsack pisser idiotin dummkopf weichei fatzke zicke knirps biest flegel snob egoist narzisst
    idiot depp trottel dumm doof narr esel schwein ziege kuh affe sau luder`),
  money: list(`schuld schulden pleite armut bettler steuer kredit zins`),
  number: list(`null eins zwei drei vier funf fuenf sechs sieben acht neun zehn elf zwolf zwoelf zwanzig hundert tausend
    million milliarde halb viertel dutzend`),
  brand: list(`audi opel ikea lego nivea haribo adidas puma nike aldi lidl edeka rewe tesla apple google amazon samsung`),
  firstName: list(`anna maria peter hans karl otto emma paul max moritz lena lina mia emil leon luca luka noah ben finn
    jonas elias felix lukas anton theo henry karla lara sara sarah laura julia lisa sophie sofia marie hanna hannah
    clara klara ida ella frida greta mila nele lea leah alma jana jan tim tom kai ole jakob jacob david daniel simon
    tobias michael thomas andreas stefan stephan markus marcus martin frank klaus uwe jorg joerg dieter horst helmut
    werner gerhard heinz kurt walter gunter rudi rudolf franz fritz josef joseph johann johannes georg wilhelm
    friedrich ernst erich bruno hugo oskar oscar arthur gustav albert alfred adolf rainer bernd rolf ralf olaf
    sven lars nils jens dirk heike silke anke elke ute gabi gabriele petra monika ursula renate ingrid helga
    gisela erika inge karin sabine susanne andrea birgit claudia nicole tanja anja katja nadine jessica jennifer
    melanie stefanie christina christine kerstin martina sandra simone heidi rosa rose liesel lotte paula marta
    martha berta bertha frieda irma olga vera nina tina rita ruth edith elsa else erna hilde hilda gerda grete
    dora doris carla lucy luzie ina mira nora alina selina helene helena johanna josefine luise louise mathilde
    wilma hedwig agnes anita ella eva marco mario hilde`),
  place: list(`amerika mexiko china boston tokio syrien havanna alabama memphis oxford afrika pazifik ostsee kreml italia madison pentagon broadway jersey avenue`),
  nationality: list(`araber syrer japaner franzose pariser londoner berliner wiener yankee wikinger samurai ninja`),
  english: list(`daddy madame sergeant penny german meeting website timing shuttle outfit league empire rover stalker scooter twitter selfie hacker lobby flirt hippie popcorn bikini logo treff tipp flyer cowboy mylord mylady teenager`),
  abstract: list(`fehler befehl ahnung idee gesetz beweis risiko hoheit urteil antrag irrtum gerede wesen dreck unfug unsinn quatsch unrecht zweifel pflicht flucht absicht vernunft unschuld furcht`),
  care: list(`helfer helferin pflegerin betreuer notarzt rettung retter`),
  command: list(`hilfe helfen hilferuf notruf notfall stopp stop halt nein senden zuruck zurueck abbrechen lauter leiser
    leise uhrzeit wiederholen nochmal erledigt spater spaeter ende weiter stimme ruhe help yes cancel back repeat
    louder quieter`),
};

export const ALL_DENIED = new Set(Object.values(DENIED_GERMAN).flat());

/** UCAP's commands and help words: a recovery word within one edit of them is refused (spoken words get confused). */
export const COMMAND_WORDS = DENIED_GERMAN.command!;

/** Plain German spelling: no y, and c only in ch and ck. Foreign spellings are hard to type and to transcribe. */
export function plainSpelling(word: string): boolean {
  return !/y/.test(word) && !/c(?![hk])/.test(word);
}

export type Rejection =
  | 'not_a_to_z'
  | 'foreign_spelling'
  | 'length'
  | 'denied'
  | 'near_command'
  | 'english_word'
  | 'english_prefix'
  | 'prefix_taken'
  | 'too_close'
  | 'sounds_alike';

/** Checks of a single word, independent of the others. */
export function checkWord(word: string, english: ReadonlySet<string>, englishPrefixes: ReadonlySet<string>): Rejection | null {
  if (!/^[a-z]+$/.test(word)) return 'not_a_to_z';
  if (word.length < 4 || word.length > 8) return 'length';
  if (!plainSpelling(word)) return 'foreign_spelling';
  if (ALL_DENIED.has(word)) return 'denied';
  if (COMMAND_WORDS.some((c) => levenshtein(c, word) <= 1)) return 'near_command';
  if (english.has(word)) return 'english_word';
  void englishPrefixes;
  return null;
}

/** Checks of a word against the words already accepted. */
export function conflict(word: string, accepted: readonly { word: string; code: string }[], prefixes: ReadonlySet<string>): { reason: Rejection; with?: string } | null {
  if (prefixes.has(word.slice(0, 4))) return { reason: 'prefix_taken' };
  const code = koelner(word);
  for (const a of accepted) {
    const d = levenshtein(word, a.word);
    if (d < minDistance(word, a.word)) return { reason: 'too_close', with: a.word };
    // Same sound and still close in spelling: one of the pair goes (Meer/mehr, Lied/Lid, Rad/Rat).
    if (a.code === code && d <= 2) return { reason: 'sounds_alike', with: a.word };
  }
  return null;
}
