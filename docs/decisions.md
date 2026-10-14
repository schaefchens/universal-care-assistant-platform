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
