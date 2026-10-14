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
- **`tools/dev/fake-telegram.ts`**, a stand-in for the connectors process for development: an invented account (code
  22222), sends that are confirmed, refused or never answered, voice messages from a file. Never reaches Telegram.

### Measured

- **The real TDLib, end to end short of a login:** on the emulator, Clara's "Telegram verbinden" started TDLib in the
  connectors container on Telegram's test servers; the phone step came back as Telegram's `API_ID_INVALID` for the
  deliberately invalid test credentials, said on her page. A login with an account needs the operator's api_id and
  api_hash (my.telegram.org), and then `connectors/test/testdc.test.ts` (opt-in, not run yet).
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
2. **A device whose app storage was lost signs in again by itself** when Android kept its key and who it is (the
   WebView's storage alone was lost; `pm clear` loses both, and then the words are needed). No words are asked: the
   key never left the device. Appendix C: "On Android the Keystore survives WebView eviction."
3. **The end-to-end tests run on the dev stack with its real clock and no fakes.** The plan's Verification: "Playwright
   with person and helper contexts, the fake providers and the fake clock." The help path they cover uses no
   provider; the fakes come when the e2e covers the assistant and timed escalation.

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
- **`npm run test:e2e`** (Playwright 1.63, its Chromium from the cache): "E2E Person" and "E2E Helfer", each in a
  browser profile of their own that keeps the device key, so their accounts are made once through the app's own
  onboarding (an invitation from the new `account-invite` CLI command, the twelve words and their check) and the
  helper is invited and approved through the app; then a help request from one browser is accepted and resolved in
  the other, and the person hears A1, A2 (or, within the reopen window, that the helpers are asked again), A6 and
  A12. It runs on the dev stack with its real clock: the plan's fake clock and fake providers are not built, since
  the help path uses no provider; they come when the e2e covers the assistant.
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
- **Still open:** the 48-hour push soak on a real phone, and the other checks on real phones (see acceptance.md); the
  ntfy app on the emulator (AN-01, AN-07).
