# Decisions made during implementation

Where the build departs from the approved plan (`docs/plan.md`), or decides something the plan left open, it is
listed here with what the plan said, what was built and why. Items marked **to confirm** wait for the owner; until
then they stay as built, and nothing here is frozen.

## S2: identity and devices (2026-10-14)

### To confirm

1. **German word list: 4-letter prefixes may repeat English ones.**
   - Plan: “disjoint from BIP39 English, so the language is detected per word”, with unique 4-letter prefixes.
   - Built: German words are unique among themselves (including their 4-letter prefixes) and never equal an English
     word. A German word may, however, start with the same four letters as an English one.
   - Why: with prefix disjointness across both lists, too few curated nouns remained (1693 of 2048). Recovery asks
     for the language first, so typing never mixes the lists.
2. **German word list: two edits apart for every word.**
   - Plan: “Levenshtein distance ≥ 2 between any two words (≥ 3 if both have ≤ 5 letters)”.
   - Built: ≥ 2 for all words.
   - Why: with 3 for short words, too few curated nouns remained. The checksum still catches about 15 of 16 single
     mistakes, and the in-app picker never lets a person type a word that is not on the list.
3. **German word list: the speech check flags, it does not remove.**
   - Plan: “A word that does not come back as itself is removed.”
   - Built: only real confusions are removed (heard as another list word or a command: 4 of 2168 words). Words heard
     as something else (547) go to your listening list, with what was heard.
   - Why: whisper on a single word is noisy (“Apfel” came back as “Atschü”); removing those would drop about a third
     of plain words.
4. **New words when the first were never confirmed (“reissue”).**
   - Plan: rotation needs the old words.
   - Built: as long as an account's words were never confirmed (the ceremony was interrupted: app closed, battery),
     the device that created the account may replace them without the old words. Once confirmed, only a rotation
     with the old words changes them. Audited as `identity.reissued`.
   - Why: otherwise an interrupted ceremony leaves an account whose words nobody holds and that can never get new
     ones. Risk: someone holding that unlocked device in that window could set words of their own; they already
     control the device itself.
5. **The words are only an English rendering on real servers until the German list is frozen.**
   - Plan: “`de-dev` refuses to register against a production server.”
   - Built: on a production server the app gives the words in English instead; English words keep working after the
     German list is frozen. The server says whether it is a development server (`GET /api/v1/server` →
     `development`).
6. **Recovery-word detector: partial phrases are only reported.**
   - Plan: a transcript is dropped “on a match, or a checksum-valid run”.
   - Built as planned (`packages/identity/src/leak.ts`). Nine or more list words without a valid run are reported as
     “suspicious” and not dropped, because shopping lists contain many nouns. But 9 of 12 words leave only about
     2³³ possibilities, which a computer can search. Should a suspicious transcript also be dropped (and the person
     warned), at the cost of some shopping-list notes? This matters from S8 on.
7. **The German list was rebuilt stricter, with a new source and a reading by Claude** (714 of 2048 words changed).
   - Why: the speech check and the first ceremonies showed words that break the plan's “concrete, familiar nouns”:
     *jetzt* (not a noun), *Gebote* (plural; religion), *Kunz* (a name), *Wesir* (unfamiliar).
   - Now every word is a singular noun with a grammatical gender in Wiktionary's noun list. Words come in tiers:
     1. curated (the BIP39 proposals, and dys2p's German lists, Unlicense/CC0) and common (in the 50 000 most
        frequent words): 1469;
     2. curated but rarer (Dattel, Saite, Windrad): 418;
     3. Wiktionary alone, only words Claude read and found fit (`REVIEWED_FILL`): 161. That pool is mostly names,
        English, slang and slurs, so nothing from it enters unread.
   - Claude read all 2048 and excluded, by category in `tools/wordlist/rules.ts`: illness and the body's organs,
     death, violence, military, legal and crime, religion, politics, sexual, alcohol, money, gambling, ethnic and
     national groups, names, places, English, negative feelings, function words (das Jetzt, das Bitte), unfamiliar
     jargon, and words UCAP's own sentences use (weekdays, months, minutes and hours, Notiz, Antwort, Konto,
     Telefon, Server).
   - To confirm: the exclusion of time words (*Montag*, *Juni*, *Minute*) is Claude's addition. It keeps reminder
     readbacks (“Erinnerung gespeichert: Dienstag, …”) apart from recovery words.
   - Development accounts made with the old German list can still recover with the English rendering.

### Decided (within the plan)

- **Successful recovery confirms the words.** Recovering with the words proves the person holds them, so the
  account's recovery state becomes `confirmed`.
- **Word entry is a grid of large areas, not a keyboard.** Only letters that continue a list word are offered, so the
  grid shrinks as the word narrows; with four or fewer words left, they are offered as choices. Twelve German words
  took 48 activations on the emulator (about four per word). A physical keyboard types letters, Backspace deletes,
  Enter takes the word.
- **A new device starts reading events after its enrolment.** Account creation and recovery return the person's
  current event position, so a new device is not told about devices added before it existed.
- **Device names say which device it is**: “Telefon (Pixel 8)”, “Browser (Chrome)”; they can be renamed.
- **The recovery card** has the server's address as text and as a QR code (black on white in every theme, so it
  scans), the server's name and id, the numbered words, and “Diese Wörter stellen deinen Zugang wieder her, nicht
  deine Daten.” It does not claim backups: those are the operator's (S12).
- **AN-13** (voice data removed blocks the ceremony with TalkBack): the check is built and passes on the emulator,
  whose German voices are installed. Removing them needs Google's settings app; the test runs in S5 together with
  the bundled care clips that the same test covers.

## S3: people and permissions (2026-10-14)

### To confirm

1. **Only administrators prepare accounts for supported persons** (helper-led setup, invitation kind
   `supported_person`). The plan leaves open who may do this; an account on the server is a decision of whoever runs
   it. The person still approves that helper on their own device.
2. **A helper invitation can also create the helper's account.** Someone without an account enters the code on the
   onboarding screen and becomes a helper of the person who invited them, still pending until that person approves.
   Without this, every new helper would first need an account invitation from an administrator.

### Decided (within the plan)

- **Codes go in request bodies.** The plan names `GET /invites/preview`; it is `POST /invites/preview {code}`, so a code
  never reaches an access log through a query string.
- **Approval takes the proposed scopes as a whole**, on a screen of large areas (Erlauben, Ablehnen, Noch einmal
  anhören, Später); the person can change them afterwards under Helfer. A helper can give scopes back, never take
  more.
- **The spoken summary names what the helper may do, and that they may not read messages or notes.** Other scopes
  that were not given are not listed: read aloud, a long list with commas inside its items was hard to follow. The
  sentences use the helper's name, never a pronoun.
- **Relationship events carry who acted**, so whoever acted is not told again what they just did.

## S4: help requests (2026-10-14)

### To confirm

1. **A12 points to the help area until voice input exists.** The plan's text ends “Wenn du noch Hilfe brauchst, sag:
   Ich brauche noch Hilfe.” Until S8 nobody can say it, so A12 ends “… tippe zweimal auf das Hilfe-Feld” (in the
   person's gesture), and **a press within the reopen window reopens the request** (a new episode, the last accepter
   asked first), as the spoken phrase will.
2. **Browsers show a quiet notice for heartbeats.** Browsers require a visible notification for every push, so a
   heartbeat to a browser shows a silent “Hilferufe erreichen diesen Browser.” under one tag, replaced each time.
   Without it the browser drops the subscription.

### Decided (within the plan)

- **“Ich frage weitere Helfer” only when someone is left.** A8 and A4b have short forms (“Maria kann gerade nicht
  helfen.”) when the server records that no further tier remains, so the person is never promised helpers that do
  not exist.
- **A new alert always takes the helper's screen** (Annehmen, Kann nicht, Zur Liste); seeing it, or the request in the
  list, tells the person (A5).
- **Browser notifications carry no buttons**; tapping one opens the inbox. Signed accept and decline from a
  notification come with the Android alarm (S5).
- **After a restart with an open request**, the person hears “Dein Hilferuf ist offen.”, then only what is new.
- **Not tried live:** Web Push in a real browser needs the notification permission granted in that browser. The
  sending, encryption, receipts and heartbeats are tested against a fake push service and a simulated browser.

## S5: help requests on Android (2026-10-14)

### To confirm

1. **JobScheduler instead of WorkManager.** The plan names WorkManager for the native retries of receipts and the
   alarm's answers. WorkManager is not in the offline Gradle cache here, and the framework's JobScheduler does the
   same job without a dependency. Measured on the emulator (Android 16): an ordinary job was still not run four
   minutes after its 10 s backoff had passed. So the native outbox first tries again within the process (2, 4, 8,
   15, 30, 60 s), and the job is expedited where Android has it (12+). An offline "Annehmen" reached the server
   29 s after the tap, with the server back after 21 s.
2. **No VAPID key at UnifiedPush registration.** The plan says "registration with VAPID". The server publishes only
   to its own ntfy, with a token in the Authorization header; the token, not VAPID, is what lets it publish (ntfy's
   access control). Measured with ntfy 2.29: a request with a VAPID header and no token is refused; with the token,
   ntfy does not check VAPID at all. A key passed at registration would let a later ntfy start to require VAPID
   while UCAP's pushes carry none, and alarms would stop.

### Decided (within the plan)

- **ntfy's access control as planned**, declared in docker/ntfy-start.sh: deny-all, everyone may read `up*`, the
  `ucap` user (a token in the new secret `ntfy_token`, made by `npm run setup`) may only write `up*`. Checked against
  the dev stack's ntfy in server/test/unifiedpush.test.ts (CR-20).
- **Endpoints only on this server's ntfy.** An endpoint elsewhere is refused and the server named (the ntfy app starts
  with ntfy.sh), so the checklist can say what to change. The server publishes to the same topic at ntfy's internal
  address.
- **The alarm over the lock screen is a native screen** (AlarmActivity), not the WebView: nothing of the app shows on
  a locked phone. "Annehmen" asks Android to unlock first (on the notification itself from Android 12, through the
  alarm screen before); "Kann nicht" works locked. After "Annehmen" the app opens at the inbox.
- **A ringing alarm that changes state is removed and posted again on a quiet channel** ("Wird übermittelt…",
  "Maria kümmert sich um den Hilferuf von Anna.", "Anna hat den Hilferuf abgebrochen."): certain to stop the sound.
  Updates now say who took over (`st`, `by` in the encrypted payload).
- **Late alarms:** ntfy keeps messages for hours, so a phone that was off can get an alarm long after it was sent. One
  older than its time to live (15 min, plus a minute for clocks) is shown without sound, marked "verspätet
  empfangen"; its receipt shows the device is reachable but is not told to the person.
- **Silenced** means: notifications off, the alarm channel turned below "high", Do Not Disturb in total silence,
  priority-only DND that lets neither alarms nor the channel through, or the alarm volume at zero. On the emulator:
  total silence gave `delivered_silenced` and the request escalated. With the app open in front, its realtime
  acknowledgement counts first: the app itself alerts with accessibility-usage sound.
- **The person is never a helper of their own request** (I1). `can()` grants a person every scope for themselves; the
  helper actions now refuse the person. This was open in S4 through the session routes too.
- **The test alarm** rings like a real one (same channel and screen) with "Beenden", stops after a minute, and its
  receipt comes back to the device that asked ("Der Test-Alarm ist angekommen, nach einer Sekunde.").
- **The help key** may be any key that means nothing else: not the volume keys (TalkBack's shortcut), not the keys
  that move between areas (arrows, Enter, Space, Tab, Escape, F1), not system keys, not keys that type. It is learned
  by pressing it, works while the app is in front, and sends at once (source `key`).
- **The phone fallback is part of the escalation plan** (Appendix A), set by the person on the Helfer page, kept on
  the device for offline use. A3b comes 15 s after an unanswered press; the next activation of help calls, while the
  press keeps being sent. Direct calls ask for Android's phone permission when they are chosen; an emergency number
  always opens the dialler, without asking anything.
- **A plan may name no tiers**: everyone with care.respond is then one tier, as without a plan. So a fallback can be
  saved before tiers are.
- **Not set up:** the setup and welcome screens say that no help request can leave this device yet, with "Notruf 112"
  opening the dialler.

### Measured on the emulator, and what is still open

- Through the dev stack's real ntfy, with the phone's side simulated (tools/android/fake-distributor.ts, debug builds
  only): alarm 180 ms after the press, native signed receipt accepted, insistent alarm on the alarm channel with
  alarm-usage sound, the full-screen alarm waking the phone from sleep, "Kann nicht" and "Annehmen" from the
  notification and the alarm screen, quiet updates on cancel and resolve, a push that did not decrypt dropped
  (AN-14), the server's test alarm, the help key (learned, a reserved key refused, one press sends), A3b and the
  dialler, A22 after the server came back, one request after a kill during an offline press (AN-05).
- **Needs the ntfy app on the emulator** (a download from F-Droid, which the owner has not yet allowed): the real
  distributor, its decryption, deep Doze (AN-01), standby buckets (AN-07).
- **Needs a phone with a screen lock**: that "Annehmen" asks for the unlock (the emulator has no lock screen).
- **Not yet run:** re-alerts two minutes apart are not quietened (AN-03, second half); `pm clear` (AN-06); the voice
  data checks AN-13/AN-15 (the bundled clips come with S7).

## S6: interactive reminders (2026-10-14)

### To confirm

1. **"Später" at most six times per reminder.** CONCEPT §9: "The user should retain control over ordinary reminders
   and voluntary routines." Without a limit, a medication reminder could be put off forever without anyone hearing of
   it, since "later" is an answer and only silence leads to a follow-up. After six snoozes "Später" is refused ("Später
   geht nicht mehr. Bitte wähle Erledigt, Nein oder Hilfe holen."). The person can still change, pause or delete the
   reminder.
2. **Who hears of a missed reminder:** the helpers who may read the person's answers (reminders.responses.read), if
   the reminder says so (a switch, on by default). CONCEPT §9 asks for "agreed rules"; this is the one rule M1 has.
   It is quiet everywhere (a spoken line in the app, a silent notification), never an alarm and never a help request.

### Decided (within the plan)

- **Answers are signed by the person's device**, so the app's native code can answer from the notification with the
  app closed, and an offline answer waits in the native outbox. "Hilfe holen" is a help request carrying the
  reminder's occurrence: it goes through the help path and its outbox, and records the answer "help", linked to it.
- **A late answer still counts**: after a reminder was missed, what the person says is recorded.
- **An empty title or question is the category's own**, said by the person's device in their language and form of
  address. Otherwise a helper writing in English, or with "du", would set the words a German person addressed with
  "Sie" hears.
- **Every reminder of the person is theirs to change**, also those a helper made (CONCEPT §9); a helper needs
  reminders.manage, and every change by a helper is audited.
- **The device's own alarms:** exact where the person allowed them in Android's settings (Android 12+ asks), inexact
  otherwise; set again after a restart. The notification uses the notification sound, never the alarm tone, hides its
  text on a locked screen, and has "Erledigt" and "Später"; the app has all four answers. A reminder never takes the
  screen from a help request or a helper's alert: it is asked again at its next prompt.
- **Time zones without Temporal**: Intl arithmetic with Temporal's "compatible" rule, so the code runs on every
  Node and WebView UCAP supports. It agrees with Temporal (Node 26.11) at every quarter hour around every 2026
  transition in eight zones, Lord Howe's half-hour shift included.
- **No "provide additional information" by touch yet**: it comes with voice (S9); the screen has the plan's four
  answers.

### Measured on the emulator

- A reminder made on the phone, read back ("Erinnerung „Trinken“ gespeichert: Einmal am 14. Oktober 2026 um
  17:31."); the phone's alarms exact after the person allowed them (before: windows of 1.5 and 9 minutes).
- At its time, with the app open: the question spoken; "Erledigt" recorded as `user_reported` from the phone.
- With the app closed and the server stopped: the phone's own alarm asked at 17:34; "Erledigt" on the notification
  waited in the outbox and reached the server 3 s after it came back.
- After a restart of the phone (no connection, the app never opened): the alarm rang; the answer arrived 3 s after
  the connection came back.
- "Später": the server's next question and the phone's alarm 15 minutes later. "Hilfe holen": a help request linked
  to the reminder, alerted in Maria's browser.
- In Maria's browser: Clara's reminders and answers ("Clara reported: taken"), a reminder made for Clara; left
  unanswered, it was missed after its last question, Maria heard "Clara has not answered the reminder …", and no
  help request was made.

## S7: providers and speech output (2026-10-14)

### To confirm

1. **The device voice is the only fallback for speech.** Appendix A has `routing_rules` with "ordered chain of
   explicit fallbacks". For speech, the person's chosen voice is the route: when it may not or cannot speak (no
   consent, over the cap, failing, herde not claiming within 1.5 s), the device voice speaks, and the app says why
   once per session. Speech never moves to another provider the person did not choose. Chains may come for speech
   recognition and language models (S8, S9).
2. **The first start offers one voice for both answers and reading aloud.** The owner: "this should be configurable
   by users"; the plan: "Chosen during onboarding by listening to samples". The voice heard and taken at the first
   start speaks both, as far as the operator allows it to; the settings page chooses them separately. The first
   start is offered once per person, not per device: who has chosen (or said "Später", which keeps the device voice)
   is not asked again on the next device.

### Decided (within the plan)

- **Consent is asked when an external voice is chosen**, for what that choice sends: answers (with reminder
  questions) hold personal, communication and health data; reading aloud communication and personal data. The person
  gives it on their own device, in the settings or, in large areas, at the first start; it is withdrawn in the
  settings, and every voice that needed it goes back to the device voice. A sample needs none: its sentence is the
  same for everyone.
- **What the operator allows decides what a voice is offered for**: a voice whose provider may not receive all of a
  purpose's data classes is not offered for it ("dafür nicht erlaubt"); one that may receive none is for listening
  only.
- **"On this server" and "on own machines" need an address there** (loopback, private, Tailscale's 100.64/10,
  `host.docker.internal`, one-label and `.local`/`.lan`/`.internal` names). These locations skip the consent question,
  so a misclicked location would otherwise send personal speech outside unasked. A provider pointed at another address
  or location loses the consents given to it, and people are asked again.
- **Reminder questions are said in the voice for answers**, rendered ahead for the next ten reminders. Help requests,
  their announcements and system speech stay with the device voice.
- **One adapter for OpenAI and local servers**: speaches with Piper voices or Kokoro speak OpenAI's speech API; on
  this server or the operator's machines they need no consent.
- **A provider refused for its key or its credits** (401, 402, 403, ElevenLabs below 500 characters left) is marked
  failing and no longer offered until a check finds it working; a passing failure (timeout, 5xx) keeps it offered.
  The admin page says why in words ("Guthaben aufgebraucht").
- **Retries against stalls**: four seconds to the first byte, three attempts. Measured on 2026-10-14: OpenAI's
  gpt-4o-mini-tts never answered six of ten requests while the others took one to two seconds; tts-1 answered five of
  five, and the dev stack uses tts-1.
- **Prices per 1000 characters in euros**, kept in millionths of a euro; caps per calendar month. A voice over its cap
  is refused out loud, never replaced.
- **herde: only the operator's own workers** (trust own, active, profile ok) get personal speech; a lender may say a
  sample's fixed sentence. The admin page creates the invitation and shows `herde join …` once.
- **The cache keeps a sentence in a voice for seven days** (Retention), keyed by a hash; older clips are deleted from
  the database and the disk every six hours.

### Measured on the emulator and in the browser

- Clara (admin): the admin page listed OpenAI (working, 0.0016 € of 2.00 €) and ElevenLabs ("funktioniert nicht
  (Guthaben aufgebraucht)", the free tier used up); "Prüfen" said the result; a herde invitation showed
  `herde join http://localhost:8810/api/worker/v2 <code>`; a provider "on this server" without an address was refused
  with the reason shown at the form.
- Signed out and recovered with the English rendering of her words: the first start offered the device voice and the
  four OpenAI voices (ElevenLabs hidden while failing); samples played (4 s), again from the cache; with her consent on
  file, Onyx was taken for both purposes; without it, the consent question came in areas and Shimmer was taken after
  "Ja, einverstanden" (consent recorded as given by Clara herself). Recovered again: not asked again. With no voice
  chosen: "Später" kept the device voice and said where the voices are.
- A reminder's question rendered ahead in Nova (two sentences, 0.66 ct) and played from the cache when it was due.
- After the recovery: push registered for the new device; a help request reached Maria's device and was cancelled.
- Settings: consent withdrawn (both voices back to the device voice); choosing an external voice asks in place, next
  to the choice, focused.
- Maria in Chrome: the voices listed, a sample played, the consent question asked in place, "Nein" gave the focus
  back, "Ja, einverstanden" chose Alloy for reading; withdrawn again.
- Still open: herde joined by the owner and a reminder spoken by Sohee (the fake herde worker passes the real
  protocol in the tests); the admin page in a browser (needs an administrator signed in there).

## S8: voice input and commands (2026-10-14)

### To confirm

1. **The plan's tolerance for near matches stays, although a synthetic "Hilfe" slipped through.** Appendix D:
   "within one edit for phrases of up to 5 characters, two for longer ones". macOS voices saying "Hilfe" alone were
   heard by whisper as "Hilsen" and "Heße" (two and three edits: nothing happened), as "Hilf" and "Hilfse" (help words:
   asked). The owner's own recordings were 9 of 9 in lookup. Two edits for "Hilfe" would have caught "Hilsen" and
   would ask after words like "Hülle" or "Halte". Voice help stays a convenience on top of the help area and the help
   key; a listening test with real voices on a real phone decides.
2. **An answer to the help question that is neither yes nor no counts as unanswered.** Decisions: "unanswered twice in
   push-to-talk, it is sent marked 'unconfirmed'". "Was?" or anything else asks again, and after the second question
   the person's choice applies (sent marked unconfirmed by default, or not sent). Silence counts the same way.
3. **The pause that ends an utterance is 0.9 s.** Measured on the emulator: "Wie spät ist es?" was answered 0.46 s
   after the recording ended (whisper 0.41 s), about 1.4 s after the last word, where the plan says "about 1 s".
   0.7 s would gain 0.2 s and cut off people who pause; it can become a per-person setting.

### Decided (within the plan)

- **One turn is one POST with the audio as its body** (16 kHz mono WAV), its id, context and language in the query:
  names only, never words. The plan said multipart; nothing else rides along, so the body is the file.
- **Contexts:** what works everywhere (help, stop, back, home, repeat, louder, quieter, time, where am I, what can I
  do here), the help question's yes and no, and the reminder's answers ("Ja" and "Erledigt" are done there). A help
  word inside a longer utterance asks, also in dictation ("Sag Maria, sie soll mir beim Einkaufen helfen" asks once):
  lookup's corpora gave no false action in 288 near misses, numbers and dictations.
- **Voice where areas are:** the area screens (the Assistent area is the talk area), the reminder's question and the
  help question have the talk button; the settings pages, made for screen readers and keyboards, do not.
- **Tap or hold:** a tap starts listening, and the pause or a second tap ends it; held, only the release ends it.
  Pressed while an answer is on its way, that answer is dropped and listening starts again. UCAP falls silent before
  the microphone opens; a help announcement is let finish first.
- **Recognition:** the person's choice, else the operator's own (the whisper server from `STT_URL` is set up as a
  provider the admin sees); an external provider only with the operator's policy for voice recordings and the
  person's consent, and never in place of an own one that fails: then A19. A failing own server is still tried on
  the next turn, and A19 is said at once for 30 s instead of recording in vain.
- **No transcripts are kept.** A turn is recorded by its timings, context and outcome; the audio lives in memory for
  the recognition call. The plan allows 30 days of transcripts; the assistant's history (S9) decides what it needs.
- **Before anything acts:** silence and whisper's television credits are "nothing heard"; recovery words are dropped
  before the transcript reaches even the app, and new words are offered.
- **Louder and quieter** move the media volume, which UCAP's accessibility audio follows, an eighth of the range at a
  time and never to silence. With TalkBack on, its own accessibility volume cannot be set by an app: the person is
  pointed to the volume keys.
- **Until the assistant (S9),** anything else gets "Das kann ich noch nicht. Sag zum Beispiel: …".

### Measured on the emulator and in the browser

- The real microphone path: the app announced Android's question, Android asked, it was allowed; the emulator's
  microphone (host audio off) gave silence, and after six seconds "Ich habe nichts gehört."
- With recorded speech fed to the WebView in place of the microphone: "Wie spät ist es?" answered (whisper 414 ms,
  the turn 425 ms); "Hilde" asked A17 with the confirmation earcon, "Ja" by voice sent a help request marked
  voice_confirmed (Maria's browser alerted); left unanswered, A17 came twice, 17.5 s apart, and the request went out
  marked unconfirmed, shown to Maria as "(nicht bestätigt)"; "Ich brauche Hilfe" sent at once; "Erledigt" answered a
  reminder; "Zurück", "Was kann ich hier tun?", "Wiederholen", "Lauter", "Leiser" worked; with whisper stopped, A19.
- Held for 4.5 s, the talk button recorded until released, after two fixes: the label's change of width ended the
  press under a still finger, and the WebView's long-press menu cancelled the touch.
- Maria in Chrome: "Wie spät ist es?" and the help question (answered "Nein" by click: A18, nothing sent).
- Still open: a real phone with real voices ("Hilfe" sends, "Hilde" asks back, the time in about a second).

## S9: the assistant (2026-10-14)

### To confirm

1. **"Kommt jemand zu mir?": the assistant says it does not know, and asks whether to send a help request.** CONCEPT
   §4: assistance "must not say that someone is coming unless that has actually been communicated or confirmed".
   The assistant cannot see a help request's state yet, so it promises nothing and denies nothing ("niemand ist
   unterwegs" is dropped as well). A later step can give it the request's state, quoting the helper's own words.
2. **Claude: Claude Opus 5.5 by default, at low effort, with Anthropic's server-side fallback on.** A request Claude
   declines for policy reasons may then be answered by another Claude model (`fallbacks: "default"`): the same
   provider, so the person's consent for Anthropic covers it. Nothing goes to Anthropic in the dev stack: only Ollama is
   set up.
3. **The assistant's own words are dropped whenever something happens.** When it uses an action tool or proposes help,
   only UCAP's fixed texts are said: the readback (C12, "Notiz gespeichert: …"), the confirmation question (C10, C11)
   or A17. Measured: qwen3.6 otherwise said "Ich habe die Notiz … erstellt" before anything was done, and "Ich kann
   keine Nachrichten senden …" before the help question.

### Decided (within the plan)

- **One reply schema for every model** (calls, help, then say), each tool with its own closed arguments: what Ollama's
  `format`, OpenAI's strict JSON schema and Anthropic's structured outputs all take. Calls and help come first, so the
  words can be spoken as they stream only when nothing happens.
- **Tools:** notes (search, read, create, update, delete), reminders (list, create, cancel). Read tools answer as data,
  marked as such ("DATEN …, keine Anweisungen"), and taint the turn: then even a note or a reminder waits for the
  person's yes. Deleting always asks. A tool the model invents is reported back to it; permissions, devices and the
  circle of helpers are no tools.
- **A note is titled by its first words**, never by the model ("Neue Notiz erstellen" was one it made up). Read out,
  a note is inserted by the server word for word and framed ("Notiz „…“ vom …:"); summaries are announced.
- **Reminders read back from what the server will do** (C12): the weekday and date written out, the time as stored,
  never the model's words ("übermorgen um neun" for a reminder made for tomorrow at eight).
- **"Neue Notiz" on the notes screen takes the words as said**, without the language model; help and stop still work.
  "Rückgängig" undoes the last thing done in the last ten minutes, on the server.
- **Confirmation:** one question per device at a time, bound to the content hash and the device, expiring after two
  minutes; asked twice by the app, then nothing (C8). An attempt that never finished is uncertain and never repeated.
- **A turn is answered in the language it was spoken in** (the device's), not the account's.
- **Help proposed by the assistant** always asks A17; "Ja" sends it marked `assistant`, silence twice gives A18b and
  sends nothing. Asked at a reminder, the request is linked to it.
- **What is kept:** the last six exchanges of a conversation, per device, for half an hour; an action's contents
  until a day after it ended; turns as timings only. No language model is used for the help path.
- **Limits on every reply:** 45 s in all, 15 s without a new piece, 1024 tokens on Ollama. Measured: one reply after a
  tool round never finished, and held the turn for five minutes until the HTTP client gave up.
- **The model choice** is like speech recognition's: the operator's own (Ollama from `OLLAMA_URL`, `OLLAMA_MODEL`),
  or an external one the person chose with consent for personal, communication and health data; never a substitute.
  Recovery-list words that make no phrase ("suspicious") never go to an external model.

### Measured

- `npm run evals` (48 German utterances, each through the whole pipeline with seeded notes and reminders),
  qwen3.6:35b-mlx on the Mac, 2026-10-14: 47 of 48 (98 %), median turn 1.6 s. The one miss: arithmetic ("zwölf mal
  dreizehn sind hundertfünfzig"). Earlier runs that day, before the prompt's last changes: 44 and 46 of 48.
- On the emulator, by voice (synthesized speech fed to the WebView): a note dictated and read back; deleted after
  "Ja" (C10), and "Rückgängig"; "Kann mir jemand Wasser bringen?" → A17 → "Ja" → a help request marked `assistant`;
  left unanswered, A18b and nothing sent; a reminder for tomorrow at eight read back from the schedule; a joke said in
  the person's OpenAI voice, two clips in order; at a reminder, "Noch nicht. Kann mir jemand Wasser bringen?" → A17 →
  "Ja" → a help request linked to the reminder (answered "help"); the notes screen read, went on, and took a dictated
  note.
- In Maria's browser: a note dictated through the assistant, the notes screen.


## S10: Telegram (2026-10-14)

### To confirm

1. **Disconnecting deletes UCAP's copies.** "Telegram trennen" logs out of Telegram, then deletes the messages kept on
   the server, the voice-message recordings and TDLib's database; Telegram keeps its own. The page says so before it
   asks. The plan does not say what disconnecting keeps; export comes in M8.
2. **A new message is announced by who sent it, never by what it says** ("Neue Nachricht von Anna Beispiel."), after a
   new earcon `message`; once per conversation in 20 s; muted chats and channels not (Appendix F only says muted chats
   are not announced).
3. **Every screen has its help area, the notes and messages screens too** (Appendix H: "Every screen has a help path
   that needs no speech"). The plan names the messages screen's areas "Nächste / Wiederholen / Antworten / Zurück";
   Hilfe is a fifth, across the bottom. The notes screen (S9) had none: added. Both screens also got the talk button.
4. **A reply dictated on the messages screen is taken word for word**, without the language model (like "Neue Notiz"),
   and asked about as C1. Through the assistant, a message is written as the person would write it, in the first
   person ("Antworte Anna, dass morgen passt" → „Morgen passt.“).
5. **What was not sent is kept as the conversation's draft for a day**, so C4, C7 and C8 ("Der Entwurf ist
   gespeichert") are true. The assistant sees the draft; there is no draft screen yet.

### Decided (within the plan)

- **The connectors process dials the assistant** (`/internal/connectors`): the token in its first frame, a newer process
  replaces an older one, a request with an Origin or through a proxy is refused before the upgrade. Events are handled
  in order; while the assistant is away they wait in the connectors process (up to 10 000). After a restart the
  assistant starts every connection that was logged in or logging in; TDLib's own session brings it back ready.
- **TDLib:** `tdl` 8.1.0 and `prebuilt-tdlib` (TDLib 1.8.67), one client per connection, one directory per connection
  on the volume `ucap-tdlib`, its database key 32 random bytes sealed in the assistant's database. The test servers are
  an admin setting for new connections.
- **Login** on the person's device: phone, code (where it went, its length, a new one), the password with its hint, or
  a QR code; one step at a time (TDLib refuses a second: "Another authorization query has started"). Errors are said
  by TDLib's name for them (`phone_code_invalid`) or how long to wait (`flood_wait_N`); a login left waiting ends after
  ten minutes; a number without an account is told, never registered.
- **Messages** are kept with their sender, service, time and conversation; edits fetched whole; deletions only when
  permanent and not from TDLib's cache; read states from the chat's read positions (the history fetched at login is
  mostly read). The last 50 messages of chats active in 30 days are fetched at login.
- **Sending:** the row is written before the connectors are asked; pending until Telegram confirms (sent, C3) or
  refuses (failed, C4); results are matched by request or by TDLib's temporary id (TDLib still sends what was pending
  after a restart); a result that comes before sendMessage's own answer is held, not lost. C5 after 15 s; uncertain
  (C6) after 60 s without Telegram accepting it or 10 minutes without a result, and a confirmation that still comes is
  told (C3). Never sent again on its own. Without the connectors process: confirmed and waiting (C9), sent when the
  connection is back, not sent after a day (C4).
- **Recipients:** by the conversation's ref or id, its exact name, the whole name among other words, or a first name;
  two that fit are named back to the model, never guessed; a chat with someone not in the person's contacts is named as
  such before C1 ("Achtung: … ist nicht in deinen Kontakten."); channels are never written to.
- **Tools:** `messages.overview`, `messages.read` (one conversation, or all of them: "Lies meine neuen Nachrichten" in
  one round), `messages.search` (words, and whose messages: a name in the wrong place is taken as meant),
  `messages.send` (always asks). Offered only to a person with a connection.
- **Speech:** an original is inserted by the server and framed ("Anna Beispiel schrieb heute um 14:02 auf Telegram:",
  "… in „Familie“ …", "Du hast … an Anna geschrieben:"); a voice message's original is its recording; its transcript is
  announced as automatic ("Automatisch abgeschrieben:"); summaries as summaries. Only an original heard to its end is
  marked read on Telegram, on the screen and from the assistant.
- **Voice messages** up to 5 MB are fetched at once and kept 30 days (fetched again when played later), transcribed in
  the background on the operator's own recognition (data classes `voice_audio` and `communication`: an external one
  only with policy and consent), in pieces of at most 30 s cut where it is quietest, filtered like turns, and **without
  a language hint**: measured, German speech with the hint "en" (Maria's account) came back as an English translation.
- **The messages screen:** unread first, oldest first, then the newest message of each other conversation; UCAP's frame,
  then the original in the voice for reading; a voice message's recording follows the frame (when it was said, or after
  as long as it takes: Chrome never ends speech in a hidden tab). A refresh keeps the message in front.
- **The assistant never ends a turn in silence:** rounds that end without words, a question or an action say that it did
  not work. Help is proposed only for what the person says about themself, never for what a message says.
- **Logs:** a tool's refusal by the tool's name and the error's code only (a reason may name people).
- **`tools/dev/fake-telegram.ts`** (since M3 `tools/dev/fake-services.ts`), a stand-in for the connectors process for development: an invented account (code
  22222), sends that are confirmed, refused or never answered, voice messages from a file. Never reaches Telegram.

### Measured

- **The real TDLib, end to end short of a login:** on the emulator, Clara's "Telegram verbinden" started TDLib in the
  connectors container on Telegram's test servers; the phone step came back as Telegram's `API_ID_INVALID` for the
  deliberately invalid test credentials, said on her page. A login with an account needs the operator's api_id and
  api_hash (my.telegram.org), and then `connectors/test/testdc.test.ts` (opt-in).
- **The opt-in suite with the owner's api_id and api_hash (2026-10-15):** TDLib reached Telegram's test servers
  (149.154.175.10, then 149.154.167.40 after `PHONE_MIGRATE_2`), and the code was asked for (5 digits, by SMS). The
  documented test code was refused as `PHONE_CODE_INVALID`: 22222 and 222222 for numbers +99966 2 YYYY, 11111 and
  111111 for +99966 1 YYYY, with numbers drawn at random. The login, a send confirmed by Telegram and the message's
  arrival are therefore still to be seen on a real account (the owner's own login, through the app). The suite now
  logs in from wherever a stored session stopped, stops at a refusal with Telegram's code, and draws its own numbers.
  The MTProto keys and server addresses from my.telegram.org are not needed: TDLib has them built in.
- **The owner's own account (2026-10-15)**, logged in on the emulator through the app, on Telegram's real servers (the
  api_id and api_hash stored on the dev server as the admin page stores them): 62 conversations, 9 active in the last
  30 days. Found and fixed:
  - **The history came one message at a time.** The backfill made one `getChatHistory` call per chat, and TDLib's first
    answer held the newest message alone: 9 messages for 9 chats. It now asks again from the oldest message until it
    has 50: 401 messages, and the voice messages among them (45 under the 5 MB limit) transcribed by the Mac's whisper
    in the background.
  - **A restart of the connectors ended every connection.** Stopping, they close their TDLib clients; TDLib reports
    each as closed, and the assistant took that for an ended connection, to wait for the person's "Neu verbinden". A
    close while the process stops is no longer passed on: after `docker compose restart connectors` the owner's
    connection came back by itself.
  - **TDLib's own error lines quote content** (a link in a message's preview, at level 1, the plan's "TDLib verbosity
    ≤ 1"): it now logs fatal errors only (level 0), and the container was made again, which dropped the old log.
  - **By voice on the emulator, every turn was heard as "Vielen Dank!"**: the emulator recorded near silence (its
    microphone is the Mac's only after `adb emu avd hostmicon`), and the one burst it took for speech, three frames
    (60 ms, a click), whisper turned into "Vielen Dank!" with full confidence, so the filter for whisper's phantoms
    let it through. An utterance now needs 120 ms of loud sound to be sent (S8's endpointing; "Ja" has about twice
    that); less is "Ich habe nichts gehört."
- **With the stand-in, on the emulator:** login by phone, a wrong code ("Der Code stimmt nicht."), the password with
  its hint, "Verbunden als …"; on the home screen "Neue Nachricht von Anna Beispiel."; the messages screen ("Nachrichten.
  Eine neue Nachricht." and the message framed); a voice message fetched, transcribed by whisper word for word, played
  (Range requests) and only then marked read; a reply dictated → C1 → "Ja" → C2, C3 only after the stand-in confirmed,
  the answer announced; a refused message (C4) with its draft; "Nein" (C7); silence twice (C8); a stranger named; from
  the assistant: "Lies meine neuen Nachrichten" as a summary, "Lies sie genau vor" as the original, the transcript, the
  recording.
- **In Maria's browser:** the login (typed), a new code by SMS, the messages screen, a voice message played to its end.
- **Evaluation** (`npm run evals`, now 60 cases with 12 for messages, seeded with unread messages, a voice message, a
  stranger and an injected instruction): the messaging cases 12 of 12, median 3.5 s, after the prompt said to look
  before answering, to write messages in the first person and not to propose help for what a message says.
- **Ollama stalls under memory pressure:** one of ten identical requests paused 23.7 s in the middle of its answer, with
  no thinking; three turns of a full evaluation failed at the 15 s limit. The Mac was swapping (Docker's VM 13 GB, the
  emulator 8 GB, the model 22 GB, 15 GB in swap). The limit stays; the plan's memory budget did not count the emulator.

## S11: remote configuration (2026-10-14)

### To confirm

1. **A change from someone else is announced on a page of its own** ("Neue Einstellungen", with "Behalten",
   "Rückgängig" and Hilfe), shown only when nobody used the device for 30 s. No answer within a minute keeps the
   change (the helper meant it, and it stays reversible from the helper's page). CONCEPT §6: "Changes should be
   explained and confirmed where appropriate."
2. **The person's own settings win.** When the person changed a setting on the device while someone else saved, the
   person's changed settings are put on top of the other version (the device is theirs).
3. **The help area's minimum size is a ninth of its screen**, and its word is kept when a label contains "Hilfe" or
   "Help" ("Hilfe holen" is allowed). Appendix H says "a minimum size" without a number.
4. **The editor of M1 changes how the screen looks, touch, and the home screen's areas** (label, place, colour, spoken
   description). Adding and removing areas, other screens, sounds, and the voice settings come later (M4 in the plan's
   roadmap: "Remote setup of voice preferences, sounds, activities and care contacts").

### Decided (within the plan)

- **One configuration per device**, revisioned in core (migration 0013): a version is made from the current one or
  refused as stale (409); every change by someone else is audited; setting an earlier version again is a new version.
  A device without one makes version 1 from what it has. Templates for new devices are in the data model, unused.
- **The protected controls are one set of rules** (`packages/shared/src/config-rules.ts`) for the server (422), the
  device (repairs with the protected defaults and reports which screens) and the editor (shown while editing): a help
  area on every screen with its function, word, sound and size; a way back on every other screen and home at most two
  activations away; the grid sound.
- **Warnings** are saved only when acknowledged, and the acknowledgement is kept with the version. Measured: with the
  label in black or white chosen for the colour, every colour reaches 4.6:1, so 4.5:1 can never warn; the warning is
  for the high-contrast themes' 7:1.
- **The device applies a version** when there was no touch or key for 30 s, nothing is being said or played, no
  question waits, no help request is open; until then the helper's page says why it waits. "Rückgängig" works by
  touch and by voice on that page (on a screen that asks, "Rückgängig" is that screen's answer, not the assistant's
  undo).
- **What the person hears is built from the two versions** (`config-diff.ts`, golden tests), never from what the author
  typed: a moved help area first and always, then at most three changes, then "Dazu weitere Einstellungen." The editor
  shows it before saving.
- **The editor** (Helfer → "Gerät einrichten", with `device.configure`): the person's devices, the state (saved,
  received, waiting and why, applied, repaired), how it looks, touch, the home screen's areas with "Anhören" in the
  helper's own voice, a preview in the person's colours (described for screen readers), what will be said, the history
  with notes and "Wieder so einstellen". A newer version from elsewhere replaces the draft (unsaved edits are told to be
  lost), so a save never puts back what was changed meanwhile.
- **The person's own Settings** are versions too, sent 1.5 s after the last change.

### Measured on the emulator and in the browser

- Clara granted Maria "Bedienung der Geräte einstellen" on her tablet. Maria, in Chrome, switched the tablet to high
  contrast and swapped Nachrichten and Notizen (acceptance step 8): saved as version 2, "wartet: das Gerät wird gerade
  benutzt" while Clara kept touching, applied 30 s after her last touch, announced ("Maria hat den Bildschirm auf hohen
  Kontrast, dunkel umgestellt. Maria hat das Feld „Nachrichten“ verschoben. Es ist jetzt unten links. …"), and Maria's
  page said "angewendet".
- "Rückgängig" by voice and "Behalten" by touch on the tablet; a version set again from Maria's history; Clara's own
  theme change on the tablet as version "von Clara", in Maria's editor at once; the app closed: "gespeichert, aber noch
  nicht beim Gerät angekommen", then received and applied after the start; the help area moved: said first, undone.
- Found and fixed while trying it: the editor kept its draft over a newer version, and Maria's next save put back a text
  size Clara had undone.

## S12: hardening and acceptance (2026-10-15)

### To confirm

1. **"Server und Konten" lists each account by name, its number of devices, when it was made and when one of its
   devices was last seen**, nothing else. "Zuletzt aktiv" helps an operator find accounts nobody uses; it also tells an
   administrator when someone last used UCAP. CONCEPT §7: "Admin rights grant no access to anyone's data."
   **Confirmed by the owner, 2026-10-15.**
2. **A device whose app storage was lost signs in again by itself** when Android kept its key and who it is (the
   WebView's storage alone was lost; `pm clear` loses both, and then the words are needed). No words are asked: the
   key never left the device. Appendix C: "On Android the Keystore survives WebView eviction."
   **Confirmed by the owner, 2026-10-15:** "asking a disabled person about this is most of the time no good situation."
3. **The end-to-end tests run on the dev stack with its real clock and no fakes.** The plan's Verification: "Playwright
   with person and helper contexts, the fake providers and the fake clock." The help path they cover uses no
   provider; the fakes come when the e2e covers the assistant and timed escalation.
   **The owner chose the plan's version, 2026-10-15; built** (see "The browser walk" below).
4. **A helper added after the order was set is notified last**, after the order's steps, until someone places them
   (the server's rule since S4: a responder the stored plan does not name goes into a last tier, two minutes on, so
   nobody who answers help requests is ever left out). The order screen now shows it. The other choice: notify them at
   once. **Confirmed by the owner, 2026-10-15:** last.

### Decided (within the plan)

- **Retention** (`server/src/lib/retention.ts`), beside what earlier steps clear: sign-in challenges a day after they
  expired, sessions a week after they ended, invitations 30 days after they expired, finished jobs after a week and
  dead ones after 30 days; a conversation's exchanges (the person's own words, for follow-up questions) once it was
  quiet for 30 minutes, its focus after a day; turns (timings and outcomes, never words) and finished actions after
  30 days.
- **Limits per address**, never on help (care commands, receipts and their actions are signed and coalesce instead):
  challenges asked without a session 200 in ten minutes, failed session proofs 50 an hour, failed WebSocket hellos 50
  in five minutes (then 429 on the upgrade), beside the invitation (10 an hour) and recovery (30 an hour) limits of S2.
  A household or a care home behind one address stays far below them (a device renews its session every 13 minutes).
- **The database restarting is an event, not a crash.** An idle connection the server ends made node-postgres throw
  outside any query, and core (the help path) exited; the pool now logs "database connection lost" and reconnects.
- **Postgres logs no statements and no values** (`log_statement=none`, `log_min_duration_statement=-1`,
  `log_parameter_max_length_on_error=0`, Appendix I).
- **Backups** (`tools/backup/backup.ts`): the database (`pg_dump`), the files volume and a manifest of row counts and
  checksums; the secrets only with `--with-secrets`, TDLib's databases with `--with-tdlib`. A restore goes into a new
  database, never over the live one. `npm run backup:check` makes a backup, restores it and compares every table.
- **Administration in the app** (Einstellungen → "Server und Konten", administrators only): whether the database and
  the notices to devices run, helper devices that can be reached, accounts and devices, overdue and failed jobs,
  storage, the language model, speech recognition, the connectors and herde; account invitations, shown once.
- **The app's security policy** (`app/src/csp.ts`, put into the built index.html): scripts only from the app, never
  inline or from strings; Trusted Types with one policy that makes the app's own two script URLs (the service worker,
  the microphone's worklet); requests and media to any HTTPS server, since the server is chosen at setup, and over
  plain HTTP to this computer in development. React Aria's one inline style is allowed by its hash; a test reads the
  installed React Aria and fails when an update changes it. No source file turns a string into markup.
- **Recovery words isolate server voices too**: while a word screen is open, nothing is spoken by a server voice
  (the microphone already refused).
- **The help question and the confirmation wait as long as the person's "time to take action"**: Android's setting
  arrives after the question is asked, and the window now starts again with it (before, the first window was always
  15 s).
- **A new device always gets a new key.** A key left by an earlier setup (the Keystore outlives the WebView's storage)
  is removed first; the server refused it as known (409), and the device could not be set up again.
- **Native code keeps who the device is until a real sign-out** (signing out, revocation, a missing key), not merely
  because the WebView's storage is empty: helper alarms keep ringing and being confirmed meanwhile.
- **The push soak** (`npm run push:soak -- <device id>`): core sends the device a silent heartbeat every 15 minutes for
  48 hours as a job that survives restarts, and `push:soak-report` gives sent, confirmed, lost and the receipt times.
  The rounds are ordinary heartbeats, so they keep the device's readiness too; an older heartbeat that went
  unanswered no longer marks a device degraded when it answered a later one.
- **The browser walk, `npm run test:e2e`** (the plan's Verification: "Playwright with person and helper contexts, the
  fake providers and the fake clock"): the acceptance script, steps 1 to 10, in `e2e/acceptance.spec.ts`, and the
  phrase canary (ID-02), in about two minutes.
  - **A stack of its own** (compose profile `e2e`, entry http://localhost:8815, as Appendix G's port table has it):
    core, assistant, the Telegram stand-in and Caddy, with a database `ucap_e2e` dropped and made again for every run
    and files of their own; Postgres and ntfy are the dev stack's. The app comes from Vite on the host through that
    entry (a development build: the security policy is checked on the emulator and in Chrome, UI-08).
  - **The fake clock is test mode** (`server/src/lib/test-mode.ts`): with `UCAP_TEST_MODE=1`, and never with
    `NODE_ENV=production`, core and the assistant take a clock the tests move forward through `/__test/clock` and
    `/__test/assistant/clock`; everywhere else those paths answer 404, and Caddy's production routes have none.
  - **The fake providers are outside the product**: the plan put them behind `/__test/*`; they are HTTP servers in
    the test process (`e2e/engines.ts`, port 8824) speaking Ollama's chat API, the transcription API UCAP's whisper
    server speaks, and OpenAI's speech API, so the assistant's own adapters run against them. Only the clock needed a
    hook in the product.
  - **Telegram** is `tools/dev/fake-telegram.ts` (since M3 `fake-services.ts`; control on 8825), which can now hold a send unconfirmed and keeps
    the moved clock's time (a message stamped with the real time looked hours old and was not announced). **Tom's
    phone** is simulated (`e2e/phone.ts`): an account made as the app makes one, UnifiedPush through the stack's
    ntfy, each alert decrypted and confirmed with a signed receipt, "Annehmen" signed by the device.
  - **What the person heard** is the app's debug record, kept by the test across reloads; it now holds speech in a
    server voice too (before, only the device voice's). Recovery words are never in it (the record masks them, and
    no server voice speaks while they are shown).
  - Not in it: what needs the native app or a real phone (Doze, the lock screen, alarms with the app closed, TalkBack
    by touch): the emulator and the owner's phones.
- **The order of helpers for help requests** (Appendix D: "The plan editor warns about helpers without a reachable
  device"; S4's escalation plans had no screen): on the Helfer page, for each helper who answers help requests, "sofort"
  or after 1, 2, 5 or 10 minutes in which nobody accepted, saved as the plan's tiers and read back ("Gespeichert. Bei
  einem Hilferuf benachrichtige ich sofort Maria. Hat nach 2 Minuten niemand angenommen, auch Tom."). An order in
  which nobody is notified at once is refused (the first tier is always notified at the press). A helper none of whose
  devices answered its last check is named; a device never checked (a browser without push) is not. With one helper
  there is nothing to order.
- **A helper allowed to set the order** (care.configure, "einstellen, wer bei deinen Hilferufen benachrichtigt wird",
  a scope with no screen until now) opens it from the people they help. The plan now comes with its helpers' names and
  whether each can be reached.
- **Changes to the help-request settings are in the person's history** ("Maria hat die Einstellungen für Hilferufe
  geändert"): the order, the phone fallback and what happens to an unanswered question had left no entry, also when a
  helper made them. Counts and switches only, no names or numbers.
- **The notice of a change by someone else is said once**: in development, React's double effects said it twice.
- **A new action drops what was said about the last ones** (the owner, 2026-10-15: "it keeps it in a long backlog.
  i think its better to cancel talking when the user did something, so the current thing should be said, and the old
  thing dropped"). Pressing an area or any other control stops confirmations, screen announcements, replies and
  labels, being said or waiting, and stops a clip in a server voice; what the press brings is said at once. Kept, as
  the plan has it: help-request speech (care), cut by nothing but "Stopp". Kept too, in a new channel `notice`: news
  from elsewhere ("Neue Nachricht von …", "Gesendet an …", a device added with the recovery words, the test alarm's
  answer), said to its end, and said again when a help request cut it off. On the emulator a second press cut the
  first screen's announcement and the next one was said at once (DeviceTts: speak, stop, speak).
  Touching an area to explore it is not acting: an answer in the device voice stops (the plan: "any touch interrupts
  it"), screen announcements and readbacks go on, and meanwhile an explored area gives its earcon without its name.
  The other choice, exploring dropping them too, was put to the owner: **left as it is for now (the owner,
  2026-10-15).** The same in a server voice since: touching an area stops an answer played as a clip, as it stops one
  in the device voice (a reminder's question and a voice message's recording play on, in either).
- **`npm run android:check`** runs on the emulator what can be checked there by itself: backups off, the security
  policy, axe, Help first in focus order, earcon usage, and Do Not Disturb in each mode through real heartbeats (a
  heartbeat never rings, so the phone reports the mode rather than "silenced"). Doze stays with the ntfy app.
- **`npm run test:docker` runs the whole suite in the image**, the ntfy tests included (at ntfy's internal address,
  with the mounted secrets).
- **Docs:** [operator.md](operator.md) (running a server), [helper-onboarding.md](helper-onboarding.md) (for helpers),
  [acceptance.md](acceptance.md) (where each check of Appendix J and each step of the acceptance script stands).

### Measured on the emulator and in the browser

- **Accessibility (UI-01):** axe found no serious issue on the person's screens on the emulator (home, messages,
  notes, settings, Helfer, Erinnerungen, Meine Geräte, Telegram, Stimmen, KI und Stimmen, Server und Konten, the help
  request and its cancel question) or on the pages in Chrome (Hilferufe, Startseite, Einstellungen, Helfer, Gerät von
  Clara). **UI-02:** the accessibility tree and the DOM of the home screen were identical with TalkBack off and on.
- **Under the security policy**, no refusal on the emulator: every settings page, the messages and notes screens, a
  voice turn (the microphone's worklet loaded as a TrustedScriptURL), answers and samples in server voices, a help
  request and its cancellation; in Chrome, the built app with no refusal.
- **CR-03:** Enter and Space on the focused help area, and TalkBack's tap then double tap (real touches through the
  emulator console, `adb emu event mouse`; `sendevent` is refused on this image), sent help and cancelled it.
- **UI-06:** with "time to take action" at one minute, the help question asked again after 62 s; "Nein" sent nothing.
- **AN-03:** a re-alert 136 s after the first alarm rang again (a new alarm-usage sound) in the same notification;
  Bob's cancel moved it to the quiet channel. **AN-08:** earcons and the device voice play with accessibility usage.
- **AN-06:** after `pm clear`, the not-set-up screen with "Notruf 112", the key and permissions gone. With only the
  WebView's storage cleared: before the fixes, the app cleared the native record at start (the next alarm reached the
  phone and did not ring), and recovery with the words was refused (409); after them, the device signed in again with
  its key, no words, and Bob's next alarm was delivered with its receipt.
- **The database restarted** with core and the assistant running: both stayed ready (before the fix, core exited).
- **Backup check:** 50 tables, 2314 rows, all equal after the restore; 14 migrations; 23 files.
- **Push soak, six minutes on the emulator** (a heartbeat a minute, through ntfy and the push stand-in): each one sent
  while the stand-in forwarded was confirmed, median 0.9 s, the slowest 3.7 s.
- **The browser walk** passed in full three times in a row, the last two through `npm run test:e2e` (2.2 and 2.1 min).
  Found on the way: the two settings screens above; the change notice said twice; speech in a server voice missing
  from the debug record.
- **The order of helpers on the emulator** (a second helper made with the simulated phone on the dev stack, then ended
  again): hidden with one helper; shown once the second was allowed; "sofort" for both saved as one tier and read
  back; an order with nobody at once refused ("Mindestens ein Helfer muss sofort benachrichtigt werden."); the history
  entries; axe found nothing serious on the page. Ending the second helper first left the section showing two; it now
  follows the page's relationships.
- **Still open:** the 48-hour push soak on a real phone, and the other checks on real phones (see acceptance.md); the
  ntfy app on the emulator (AN-01, AN-07).

## M2: LIVE Assistance Mode (planned 2026-10-15)

The plan: [plan-m2.md](plan-m2.md).

### Decided by the owner (2026-10-15)

1. **The keyword gate is on the device**: an offline German keyword spotter in the app (Vosk's small German model)
   while the gate is closed, so nothing leaves the device until the keyword is said. plan.md's roadmap said "The
   keyword gate after quiet periods starts as a transcript match and moves to an on-device wake word once measured";
   the owner chose the device from the start.
2. **The person names the assistant, and the name is the keyword**; the person may choose a keyword of their own
   ("person names the assistant and potentially a own selected keyword").
3. **Helpers switch LIVE on directly**: helpers with `device.configure` switch it on and off as other device settings.
   As every remote change in M1, it is announced on the device and kept in the person's history.

### To confirm

1. **"Pause" closes the gate and silences what UCAP says by itself, but the name still opens it.** plan-m2.md:
   "Pause: nothing is said until 'Weiter' or a touch"; CONCEPT §19: "its live until disabled/paused". Built: paused,
   the microphone hears only the keyword spotter, as with the gate closed, so "Lisa, weiter" (or a touch) ends the
   pause. The other choice: the microphone off during a pause, ended by a touch alone.
2. **What was said before the name in the same breath stays on the device.** The decision says "until the keyword is
   said, nothing leaves the device". Built: an utterance that holds the name is sent from 0.2 s before the name, so
   "Sag mal, Lisa, was steht heute an?" reaches the server as "Lisa, was steht heute an?". The other choice: the whole
   utterance, its start included.
3. **Messages are said in reported speech without "Zusammenfassung:"** when LIVE sums them up: "Maria fragt, wie es
   dir geht und ob sie heute Mittag Essen bringen soll." CONCEPT §19's own example ("Maria asked how you are doing and if
   she should bring launch later this day"); M1 announces every summary as one (Appendix E). A short message is read
   word for word with its sender ("Anna schrieb: „…“"). The other choice: "Zusammenfassung:" first here too.
4. **Reminders keep their time in quiet times.** The settings say "Stille Zeiten: Dann sage ich nichts von selbst.
   Über Hilferufe immer."; LIVE's own announcements (messages) wait out a quiet time, a reminder a helper set for 22:00
   still comes at 22:00 (plan-m2.md: "in the night's quiet times only care and marked reminders": a reminder is marked
   by its time). The other choice: a mark per reminder, and the others held until the quiet time ends.
5. **A question opens the gate for 30 seconds** (a reminder's, the help question, a confirmation), and an answer turns
   it into a conversation with the person's quiet while. A "Ja" from a television in those 30 seconds would answer it;
   help asks back in LIVE mode and silence sends nothing, but a confirmation of a message would be taken. The other
   choice: confirmations by touch or after the name only, in LIVE mode.

### Decided (within the plan)

- **The keyword spotter's grammar: the keyword and 400 ordinary words** (the most frequent of UCAP's own texts),
  measured in L0 (docs/spikes/m2.md): the keyword alone in the grammar wakes 250–900 times an hour of speech (the
  decoder forces every word onto it); the model's whole vocabulary hears the names hardly at all (Hanna 0 of 45, Lisa
  5 of 45), so no second stage can confirm them; the keyword with ordinary words heard 49–87 % of the names and woke
  0–5 times an hour. The spotter hears every sample while the gate is closed (its real-time factor is 0.04), not only
  what a voice detector passes: a quiet voice over the television is not lost.
- **Voice activity is the app's energy rule, not Silero**: both called the synthetic music and noise silence and
  every speech speech, and the open gate's utterances need no more; ONNX Runtime (33 MB of native code per ABI) is
  gone, the app is 17 MB instead of 50.
- **What LIVE mode hears is a data class of its own, `live_audio`**: the room and others in it, not only the person.
  An external recognition the person consented to for push-to-talk (`voice_audio`) does not hear LIVE mode; the
  operator's own does (plan-m2.md: "a recognition on the operator's own machines unless the person consented to an
  external one for LIVE").
- **What the open microphone heard without the name is judged before anything is said**: a command or a help word is
  meant; otherwise the dialogue model decides first whether it was said to UCAP (`addressed` in the reply's schema,
  LIVE only); what was not is dropped without a word, kept nowhere (the turn's record says `ignored`), and is not part
  of the conversation's history. Its transcript reaches the app only once it was meant.
- **Barge-in only with the gate open**: with it closed the television would cut every announcement short; then the
  name stops UCAP (it opens the gate). Speech counts once 120 ms of it were heard, never a click.
- **A note's words and a reply are dictated by a press**: in LIVE mode a touch on "Neue Notiz" or "Antworten" opens
  the gate for them; what the open microphone merely heard never becomes one.
- **In a browser LIVE mode opens by touch**: no keyword spotter there, so the microphone is open only with the gate;
  a touch opens both, and the conversation goes on without touching until the quiet while has passed; said when it is
  switched on.
- **What was heard without the name is judged in a call of its own**, before the turn: the dialogue model gets the
  sentence and what the assistant said last, and only "addressed" comes back. Within the whole turn's prompt it let the
  tools win: three of seventeen sentences of a radio sports report became notes (measured on the emulator). Since:
  16 of 16 dropped. An action after overheard speech asks first (as a turn that read untrusted data), and the utterance
  after the name said alone is judged too (a television may speak first), with the hint that the person just called.
- **LIVE never sends a help request unconfirmed**: the help question unanswered twice ends with A18b in LIVE mode
  (Appendix D: "never in LIVE mode"); found on the emulator, fixed before anything was sent.
- **Paused, in a quiet time, or with messages not to be said, LIVE says nothing about new messages**, not even M1's
  "Neue Nachricht von …"; with LIVE off M1's announcement is unchanged.
- **The suggested names are Mathilda, Theodor, Hanna, Leopold** (docs/spikes/m2.md: three syllables are heard far more
  reliably; Paul and Emma woke ten times an hour on everyday speech); a helper's name is never suggested.
- **"Kürzer" and "Ausführlicher" are a person setting** (`answers`: short, normal, detailed) in the assistant's prompt;
  "Langsamer", "Schneller" the device's speech rate; text size and contrast the device configuration (versioned, as a
  change in the settings). Each is read back; "Rückgängig" within two minutes puts it back.
- **The keyword model is served by the assistant process** (`/api/v1/assistant/keyword-models`), from the models
  directory with its pinned SHA-256 (`tools/live/models.ts` downloads it); the app checks the digest again before it
  unpacks it into its own storage.

## M3: More connectors (planned 2026-10-15)

The plan: [plan-m3.md](plan-m3.md).

### Decided by the owner (2026-10-15)

1. **UCAP becomes the SMS app.** It takes Android's SMS role on the phone with the person's SIM, and receives, keeps
   and sends SMS and MMS itself.
   - plan.md's roadmap said "SMS through Android: Play allows SMS permissions mainly for the default SMS app, otherwise
     the notification route".
   - The owner chose the SMS app over two other routes: the notification route, and the Assistant role the research
     found, which grants SMS permissions while Google Messages stays the SMS app.
   - RCS chats most likely stop while UCAP holds the role.
2. **A calendar and tasks come in M3**, moved from M5's roadmap entry ("Calendar, tasks, shopping lists, alarms").
   - M5 keeps shopping lists, alarms and outside calendars.
   - A message can become a note, an appointment, a task or a reminder, and each keeps it as its source.
3. **Email connects with a password or an app password** (IMAP and SMTP). OAuth2 for Google and Microsoft is not in
   M3, so Outlook.com and Microsoft 365 cannot connect yet.
4. **Helpers may manage contacts by a new permission**, "Kontakte verwalten" (`contacts.manage`), granted and withdrawn
   by the person. It never reaches messages.
5. **Helpers may manage appointments and tasks by a new permission**, "Termine und Aufgaben verwalten"
   (`agenda.manage`). It never reaches messages or notes.
6. **WhatsApp in development is the owner's own account, connected by hand.** There is no spare number, and nothing
   automated runs against it ("we might connect it, but not do automated testing on it"). Every automated test uses
   the stand-in.
7. **The new third-party code is allowed** (plan-m3.md's list: "ok to new 3rd party code, we need those").
8. **The repository's licence is AGPL-3.0-or-later**, settling plan.md's open point ("Repository licence: to be
   decided").
   - `packages/herde-project` stays Apache-2.0, as vendored.
   - The font stays under the SIL Open Font License (NOTICE).
   - It combines with Baileys' `libsignal` (GPL-3.0), so the WhatsApp connector needs no licence of its own.
9. **What a service sends from before the person connected it is no news** (the owner, 2026-10-22, after the
   hand check: "clicking through 5000 messages on connect isnt something the user shoud do. when he connects i
   think its better to only show new messages from that time onwards, basically marking all as read"; "how are we
   doing this in telegram, they should behave equal").
   - Built for every service, in the store: a message that did not just arrive and is from before the connection
     was made is read in UCAP, whatever the service counts as unread. Only what comes after is new, also when it
     arrives late (after a gap).
   - Nothing is marked read on the service for it: no read receipts, the phone's own unread state stays.
   - Before, the history copied the service's own unread state (Telegram's backfill too): after linking WhatsApp
     the owner had 26 "new" messages, and many more while the history was still coming.
10. **On WhatsApp, someone not in the address book is named by the name they gave themselves**, as a stranger (the
    owner, 2026-10-22: "self given names are better than numbers, no one knows numbers"; To confirm, item 3).
    plan-m3.md, K2, said "never push names".

### To confirm

1. **K1's check on the emulator, the messages screen with two services, waits for K3.** plan-m3.md's K1 exit: "on the
   emulator, the messages screen with two services". The emulator's app is signed in to the owner's account on the dev
   stack, which holds the owner's real Telegram; a second service there would be a connection on the owner's account.
   Built: the screen with two services is covered by the store, tool and route tests and by the browser walk with the
   stand-ins; on the emulator it is checked in K3, with a Hetzner test mailbox, after asking the owner. The other
   choice: a second account on the emulator now, which signs the owner's account out of the app there.
   **Confirmed by the owner, 2026-10-21:** "sure you can do the mailboxes i added to .secrets, thats what they are
   there for".
2. **A new message is announced with its service once the person has more than one**: "Neue Nachricht von Anna
   Beispiel auf WhatsApp.", "… per SMS.", "… per E-Mail.". Appendix E says "Neue Nachricht von {name}.", written for
   Telegram alone; plan-m3.md has LIVE name the service "when the person has more than one" (K8). With one service it
   stays as it was. The other choice: the announcement without the service, which is then said when the message is
   read.
3. **On WhatsApp, people are named from the address book, else by their number, else "Unbekannt"; never by the name
   they gave themselves.**
   - plan-m3.md, K2: "Names come from the person's saved contacts, never push names". plan.md, Appendix E, names a
     stranger by the service's name: "Achtung: {Telegram-Name} ist nicht in deinen Kontakten."
   - Built: on WhatsApp the self-given name is never used. Someone calling themselves "Maria (Tochter)" is "+49 176 …,
     nicht in deinen Kontakten".
   - Where WhatsApp shows a person only by their LID (group members whose number it hides), they are "Unbekannt".
     Spike A found 142 contacts with the owner's own name among 1,752.
   - The other choice: the self-given name, always with "nicht in deinen Kontakten", as Telegram's.
   - Seen with the owner's account (2026-10-22): in a community group, 24 people were "Unbekannt" and 17 only a
     number WhatsApp masks ("+49 … 55"), so its messages hardly say who wrote them.
   - **The owner chose the other choice, 2026-10-22:** "self given names are better than numbers, no one knows
     numbers". Built: someone not in the address book is named by the name they gave themselves, and stays a stranger
     ("Achtung: … ist nicht in deinen Kontakten." before anything is sent to them), as on Telegram; then their number,
     the part of it WhatsApp shows, or "Unbekannt".
4. **WhatsApp's "delivered" is not kept yet; "read" is.**
   - plan-m3.md, K2: "delivered and read states kept".
   - Built: the other side's read receipts mark the person's messages read, as Telegram's do. "Delivered" has no place
     in the store or the connector protocol yet, and nothing tells the person either state so far.
   - It comes with K4, where SMS delivery reports need the same: one "delivered" for both.

### Decided (within the plan)

- **History is said from a day on.** plan-m3.md: "how much history it has: all of it, from a date, or previews only".
  UCAP fetches 30 days when a service is linked (Telegram: the last 50 messages of each conversation active in that
  time) and keeps all that comes after, so Telegram, WhatsApp, email and SMS say "hat Nachrichten ab dem 15. September";
  "all of it" waits for a service whose whole history UCAP can reach. The model gets the day too.
- **A connection keeps only what differs from its service's capabilities** (migration 0018); the service's own come
  from the code. Each connection had held a copy, Telegram's with "all of it".
- **A new message to a name on several services** goes to the service where that person wrote last, if that was in
  the last 14 days and later than on the others; otherwise UCAP asks which service ("Per SMS oder auf Telegram?").
  plan-m3.md: "goes where they last wrote; when that is not clear, UCAP asks".
- **Services are named in the person's language** ("E-Mail", "Email"); a preview by its app ("Signal").
- **The messages tools are offered once a connection has been ready**; one still being linked has nothing to read.
- **Einstellungen → Nachrichtendienste lists each connection with its state and what it can do**, said as the page
  opens ("Telegram: verbunden."). Each service's own page comes with its step: Telegram's now, WhatsApp's in K2,
  email's in K3, SMS in K4, previews in K5.
- **A phone that is signed out runs nothing any more.** Its SMS and preview connections are turned off by the next
  sweep; what waited for it is not sent (C4: "das Telefon, das sie senden sollte, ist abgemeldet") and kept as a
  draft, as when the SMS role goes back.
- **The messaging stand-in plays every server service**: `tools/dev/fake-services.ts` (was `fake-telegram.ts`), with
  Telegram, WhatsApp (the pairing code UCAP2026) and email; `UCAP_FAKE_SERVICES` picks them. The browser walk's
  simulated phone (`e2e/phone.ts`) joins the person's account with their words and is UCAP the SMS app.
- **Spike A was run by the owner, by hand** (2026-10-21): Claude Code's auto mode refused to start a step that reaches
  the owner's account, so the owner ran each step in a terminal of their own. Measurements in docs/spikes/m3.md, A.
- **UCAP is "Chrome (Mac OS)" in the person's linked devices**: WhatsApp refused the pairing code for a device named
  by UCAP ("Chrome (UCAP)", spike A), and Baileys' README allows a name of one's own for QR codes only. The page says
  how UCAP is listed there.
- **The pairing code is shown large, in two halves ("ABCD-1234"), and said one character at a time** ("U, C, A, P, …"),
  with where to type it: WhatsApp, Einstellungen, Verknüpfte Geräte, Gerät hinzufügen, "Stattdessen mit Telefonnummer
  verknüpfen". WhatsApp waits about three and a half minutes for it (spike A: 210 s); then the page says so and offers
  a new one.
- **"Gesendet" comes at WhatsApp's `ack` frame**, which the connector reads itself (Baileys reports such frames only
  when they carry an error). An error in it fails the send, never sent again by itself; 463 is said as an account
  restriction ("WhatsApp lässt dein Konto gerade keine neuen Unterhaltungen beginnen").
- **30 days of WhatsApp's history are kept**, of the years it sends at linking; chats with nothing in that time are left
  out until they have news. Older messages are not fetched from the phone later (`history` does nothing).
- **One id per person on WhatsApp**: their number when it comes first or together with their LID, else the LID; every
  other address of theirs points to it. Two ids that turn out to be one person are counted, never merged.
- **What WhatsApp itself sends (`0@s.whatsapp.net`) is a channel named "WhatsApp"**: kept, never announced, never
  written to. Statuses, broadcast lists, WhatsApp channels and bots are no conversations and are skipped.
- **A gap in the WhatsApp connection shorter than 30 seconds is no news**: it reconnects by itself, and a send in the
  gap waits for it. Longer, the connection is "wird verbunden" until it is back.
- **WhatsApp's read states are times**: its message ids have no order, so the store sorts them by time (K1), and
  "read up to" is a time too.
- **No native image library**: a private workspace package named `sharp` (`packages/no-sharp`) satisfies Baileys' peer
  and throws when imported; Baileys makes no thumbnails then, and UCAP sends no pictures through it.
- **The Telegram and WhatsApp processes share their frame** (`connectors/src/process.ts`: dialing the assistant, hello,
  events kept while it is away, the health check, SIGTERM); Telegram's behaviour is unchanged.
- **The WhatsApp process prints nothing through the console**: libsignal writes session records with private keys
  there (spike A), so the console is replaced and its lines counted once an hour, by their wording.
- **The person's own chat ("Message yourself") is named by the name they gave themselves on WhatsApp** (or their number)
  and counts as known: a message to oneself is no stranger's ("Achtung: … ist nicht in deinen Kontakten").

### Measured

- **K2 with the stand-in, on the emulator (2026-10-22)**, with a person of its own ("Wanda Test", English, an
  administrator by her invitation):
  - **Linking:** the risk said and agreed to, the number, the code said ("U, C, A, P, 2, 0, 2, 6") and shown
    ("UCAP-2026"), then "Connected as Clara Test. UCAP has your messages of the last 30 days and all new ones."
  - **Reading:** "New message from Anna Beispiel."; the messages screen read it "on WhatsApp".
  - **A voice message:** fetched through the connector protocol, transcribed by whisper word for word, and played
    with its frame ("Voice message from Anna Beispiel, today at 10:07 on WhatsApp, 3 seconds:").
  - **A reply:** dictated; C1 named WhatsApp; after "Yes", "Sent to Anna Beispiel." came at the stand-in's
    confirmation (outbound `sent`, C3).
  - **Disconnecting:** through the page, after its question; UCAP's copies gone.
  - Push-to-talk heard nothing until the emulator's host microphone access was on and the Mac's sound output was
    not muted: the reply was played by the Mac's `say` through its speaker.
  - Whisper, hearing German from a person whose language is English, translated it ("Ja, ich komme gern." became
    "Yes, I'll come."), as CLAUDE.md says.
  - Found and fixed: the person's own chat was named as a stranger's; the risk was said again right after
    disconnecting.
- **The browser walk** (2026-10-21): 15 of 15, WhatsApp linked on its own page.
- **By hand, with the owner's own account, on the emulator (2026-10-22)**, the person "Wanda Test":
  - **Linked** with the code typed on the owner's phone; 36 chats of the last 30 days.
  - **Read** on the messages screen; the voice message the owner recorded in their own chat played.
  - **One message to the owner's own chat**: "Sent to Schäfchen." came 0.42 s after it went out, at WhatsApp's
    acknowledgement; it was on the phone.
  - **Found and fixed: the history lost most of its messages.** WhatsApp's first part named the chats, and its later
    parts brought thousands of their messages without naming the chats again; those were dropped (612 of about 5,000
    from the last 30 days kept). Every message of the last 30 days now counts, whichever part brings it, and a chat's
    read part follows all its incoming messages seen so far, once WhatsApp has said how many are unread.
  - **Found and fixed: "Next" never reached the end of a long list.** Each refresh of the messages screen (a
    transcript done, a message arrived) started it over at the first unread message, and the history's voice
    messages were transcribed one after another in the background. It now leads on past what was shown on this
    visit; the messages skipped come at the end.
  - Clicking through quickly to reach the own chat, one group message was read to its end and marked read on
    WhatsApp.
  - **Found and fixed: numbers WhatsApp masks were taken for saved names.** For a community's members WhatsApp sends
    "+49∙∙∙∙∙∙∙∙∙55" in a contact's name; 17 such people counted as the owner's contacts, so no stranger warning.
    A masked number is never a saved name now: the person is a stranger, said as "+49 … 55".
  - **Found and fixed: "30 neue Nachrichten" when there were more.** The screen counted the 30 it holds; the server now
    says how many there are.
  - The owner's data on the dev server was brought in line with both fixes and the new rule by hand (12 messages read
    in UCAP, 17 people no longer contacts), instead of a third link.
