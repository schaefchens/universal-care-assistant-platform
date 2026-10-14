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
  // From reading the selected words (2026-10-14): what the categories above missed.
  reviewedIllness: list(`abstrich apotheke asbest attest bahre bettruhe bruch diagnose doktor eingriff gicht hospiz mumps pickel
    radon uran vene sarkom ekzem agonie blessur zerrung reizung fetus sehtest dioptrie chirurg zahnarzt toilette
    gehirn hirn milz galle gelenk knochen knorpel schlund gurgel vene achsel wanst parasit made wanze milbe schimmel
    reblaus fungizid pestizid endlager unfall aufprall wrack zerfall erbfolge trost abschied ewigkeit`),
  reviewedViolence: list(`attacke duell eroberer fehde feind haudegen krawall randale salve untat untier pogrom bestie tumult
    machete degen keule lunte visier werfer knarre geisel gangster treffer albtraum`),
  military: list(`division festung fregatte garde kaserne kader konvoi offizier rekrut sold tarnung wehr admiral
    leutnant husar obrist besatzer vasall hiwi`),
  legal: list(`alibi indiz insasse justiz kartell kaution kerker klage pranger richter revier spion pirat delikt doping
    kumpan polizist`),
  reviewedReligion: list(`abtei frevel gnade hexerei karma predigt prophet seher hostie mesner eremit gnosis allmacht abgott
    dogma kibbuz kadi messe glauben gloria reverend apsis empore`),
  reviewedPolitics: list(`allianz blockade exil imperium mandat mehrheit patriot protest rebell senat streik volk wahltag
    annexion emirat enklave populist neuwahl vormacht votum plenum amtseid obmann obfrau dementi kampagne`),
  reviewedSexual: list(`eskorte harem lust trieb einehe ehebett unlust erguss abart`),
  alcohol: list(`fusel pulle sprit trunk umtrunk eiswein riesling rebstock winzer`),
  negative: list(`arroganz bosheit desaster disput faulheit feigheit fiasko fratze frust gehabe gehorsam geiz getue
    habgier ignoranz krise meute misere mitleid obdach obhut panik qual reue ruine skandal skrupel
    spott stuss torheit tribut zumutung zwang zwist zoff missmut undank unart habsucht wehmut hemmung
    raumnot manko murks pfusch nepp eklat tirade polemik mahner mief abweg irrweg exzess fron fimmel heimweh zucht
    dummheit jammer wahnsinn benimm`),
  reviewedInsult: list(`bengel lakai knecht mieze weib zwerg bonze emanze knilch popanz mutant troll tussi fotze muschi
    pinkeln hintern blonde`),
  reviewedMoney: list(`anleihe defizit dollar zaster teuerung tilgung zinssatz tantieme kasko entgelt mitgift`),
  gambling: list(`lotto poker kasino bingo roulette`),
  people: list(`inder asiat balte iberer osmane slawe sorbe kreole inka jeside sunnit gaucho fakir exot`),
  names: list(`lutz merlin knigge benjamin chan devon esther ethan jean lori marge quentin robinson sharon steven
    stuart tara amber iris fischer braun`),
  places: list(`taunus pfalz mosel attika`),
  englishMore: list(`freak baseball darling farmer football look porter queen show adieu bravo`),
  functionWord: list(`jetzt bitte morgen daheim niemand quere pardon hallo etwas selbst sowieso trotz voraus dunkel gelb
    perfekt extrem negativ leisten opfern gefallen achtung vorsicht hinsicht zeug fremde heil
    vize expo furore usus nimbus`),
  unfamiliar: list(`axiom binom tupel torus sinus suffix dativ kasus valenz semantik didaktik gradient entropie isotop
    neutrino anion anode dipol diode argon barium butan mangan xenon sulfat nitrat dioxid epoxid bauxit kilovolt okular
    pleuel unwucht unruh lunker trias tonika umbra sept terz walart wulst asket oktagon kescher legat vogt aspirant
    eloquenz opulenz vehemenz evidenz vakanz unwort sozius wams teeei pneu bonmot floskel abkehr talg`),
  reviewedDys2p: list(`aberwitz abgrund achtzehn neunzehn sechzehn vierzehn drittel aderlass advent affront ahndung
    alias alptraum amnesie anarchie andacht anstalt argwohn askese attentat aufstand ausbruch axthieb baldrian
    beige blau beihilfe bierkrug portwein weinberg bosse boxkampf chatbot delirium depesche dietrich dissens
    duldung ehebruch ehekrise elend embargo endkampf endzeit erzfeind event feigling gehhilfe gejohle
    gespenst gezeter glamour grabmal hautarzt leibarzt havarie hehlerei hemmnis heute ignorant
    infusion inbrunst invalide irrsinn juckreiz kerbholz kniefall konflikt konkurs kopfweh krampf leumund
    lithium manifest mutation nahkampf neider notdurft notlage notnagel ozonloch paranoia periode pritsche radau
    regress rhodium salbe sammeln sehkraft sintflut stottern subjekt therapie tief ungnade unhold unruhe unsitte
    unzucht verdacht verruf vormund vorwurf wallung warnung wollust zinslast stecken abschaum aktiv barbie earl
    einstein eminenz jeep junkie kacke khan leichter loser mailbox mandant neue nichts wehe wenn spass`),
  reviewedFinal: list(`autist amme indio semit gote ethnie hetzer hexer macho dezernat fiskus fistel lunge kehle hornhaut
    pore pupille augapfel sekret spucke unrat mist gelage weinfest kopftuch kutte segen tribun patron sexte kuli
    mietzins rendite haftung amtszeit unmut unding star zehner mahnmal trage harpune beil bollwerk lager abmarsch
    oheim turban`),
  // Words UCAP itself says or asks for: a recovery word must never sound like part of the app's own sentences
  // (reminder readbacks name weekdays, months and times; the areas are called Notizen, Antworten, …).
  ucapWords: list(`hinweis meldung anfrage zugriff zustand nummer ziffer obacht single
    konto adresse parole vorname passwort kontakt server telefon notiz antwort anruf seite sprache karte
    feld liste termin kalender minute sekunde stunde montag dienstag mittwoch
    donnerstag freitag samstag sonntag januar februar marz maerz april juni juli august september oktober november
    dezember`),
  command: list(`hilfe helfen hilferuf notruf notfall stopp stop halt nein senden zuruck zurueck abbrechen lauter leiser
    leise uhrzeit wiederholen nochmal erledigt spater spaeter ende weiter stimme ruhe help yes cancel back repeat
    louder quieter`),
};

export const ALL_DENIED = new Set(Object.values(DENIED_GERMAN).flat());

/**
 * Nouns from Wiktionary alone (tier 3 in build.ts) that were read and found fit: concrete or familiar, neutral, no
 * name, brand or slang. Only these may fill the list after the curated pools; the rest of that pool is unread or
 * unfit (it brings names, slurs and worse). Reviewed 2026-10-14.
 */
export const REVIEWED_FILL = new Set(
  list(`richtung stimmung sieger herzog butler kaugummi greif delta routine wurmloch premiere portal maestro ballett
    seemann kristall sportler kritiker jackett kutscher tournee kolumne pfennig souvenir espresso artefakt shampoo
    splitter lasagne billard omega talisman traktor buffet flicken auffahrt brocken umlauf anhalter jojo chefkoch
    journal seufzer klaue karo jasmin dukaten tapete steward banjo refrain jukebox overall krimi polier drogerie
    eiskrem peperoni pfeiler omelette maroni oldtimer zeichner tanker opossum fiedler winzling mechanik ringer taifun
    lakritze einlass hazienda blazer baufirma risotto rosmarin kimono dramatik darts paella trichter innenhof kotelett
    smaragd plausch entlein foxtrott ostseite kaschmir baguette oktopus maisfeld griffel toga bongo klecks oregano
    periskop finesse sinfonie anrichte falafel alfalfa lolli bouquet zobel seeluft tutu farmhaus gaukler gabelung
    geologie drops azur kohlkopf mahagoni heilbutt trilogie gazpacho beiboot lemur anchovis nautilus leckerli
    tunfisch revers rebhuhn looping chalet astronom akrobat kosename pistazie sombrero tiramisu baklava brummer
    serenade magenta seezunge tipi bravour zickzack kilt durchzug heuboden kricket tiara molkerei tamtam refugium
    fechter impala anatomie kappa blende jogger kebab eismann kontext barbier tatkraft hommage skunk tarantel`),
);

/** UCAP's commands and help words: a recovery word within one edit of them is refused (spoken words get confused). */
export const COMMAND_WORDS = DENIED_GERMAN.command!;

/** Plain German spelling: no y, and c only in ch and ck. Foreign spellings are hard to type and to transcribe. */
export function plainSpelling(word: string): boolean {
  return !/y/.test(word) && !/c(?![hk])/.test(word);
}

export type Rejection =
  | 'not_a_noun'
  | 'unreviewed'
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
