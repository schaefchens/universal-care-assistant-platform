# UCAP — Milestone 2: LIVE Assistance Mode

The second milestone of [plan.md](plan.md)'s roadmap: CONCEPT §19, built on Milestone 1. Departures from this plan go
into [decisions.md](decisions.md), as in M1.

## Context

CONCEPT §19, in the owner's words:

- "The user should be able to have a toggleble continous assistance mode where the system automatically reads out new
  incoming information and is lively thinking and handling information and talking to the user."
- "It should feel like a person is sitting next to the user and is handling and thinking and giving live assistence."
- "it listens mic all the time so the user does not have to click or activate it, might have a key word to unlock if
  the communicatino was silent for a while so its not disturbing and responding to watching tv or listening music.
  its live until disabled/paused."
- "it should not just dumbly listen out messages, but think what makes sense."

The examples: "Its 8 o clock, its time for your blood pressure medication"; "John wrote: 'Hello how are you doing
today?'"; "Maria asked how you are doing and if she should bring launch later this day."; "Its time to take a sip of
water."

M1 left room for it (plan.md, Appendix K): typed events with priorities and data classes; a matcher with a `mode`
("in LIVE, exact phrases also ask back and silence never sends"); a turn pipeline that does not depend on its
transport; speech output with priorities and `heard_seq`; "an always-on microphone implies local STT by default".

## Decisions (the owner, 2026-10-15)

| Topic | Decision |
|---|---|
| Keyword gate | **On the device.** An offline German keyword spotter in the app (Vosk's small German model, about 45 MB, listening only for the keyword) while the gate is closed: until the keyword is said, nothing leaves the device, and the TV or a conversation is transcribed nowhere. This replaces the roadmap's "starts as a transcript match" (plan.md, Roadmap, M2) |
| Keyword | **The person names the assistant**, with a suggestion, in onboarding and in the settings; the name is the keyword. The person may choose a keyword of their own instead |
| Who switches LIVE on | **The person, and helpers directly**: helpers with `device.configure` switch it on and off remotely, as other device settings. As every remote change in M1, it is announced on the device and in the person's history |

## Principles

- **The help path stays as it is.** LIVE never sends help unasked: in LIVE an exact help phrase asks back too, and
  silence never sends (Appendix D's "unconfirmed" sending is push-to-talk only). Care announcements keep their
  channel and their place (first, never cut but by "Stopp").
- **Nothing leaves the device while the gate is closed.** Audio is never stored. While the gate is open, an utterance
  goes to the person's speech recognition like a push-to-talk turn; in LIVE that is a recognition on the operator's
  own machines unless the person consented to an external one *for LIVE* (Appendix I).
- **The state is always told.** Opening and closing the gate have earcons of their own; LIVE on, paused and off are
  said and shown; on Android a notification says "UCAP hört zu" while the microphone is open (the system's microphone
  indicator shows it too).
- **Thinking what makes sense** (§19) is the language model's judgement inside the server's rules: what is said now,
  later, together, word for word or summed up; the rules decide what may never wait (care), what is never said aloud
  (recovery words, a muted chat) and what needs the person's confirmation (M1's actions, unchanged).
- **The app is first** (the native microphone in a foreground service); the browser does what it can while its tab is
  visible, and says what it cannot.

## Architecture

```
 Android app                                                         assistant (server)
  VoiceCapture (Java, foreground service "microphone")                turns (mode live): STT (local) → matcher
   AudioRecord 16 kHz, VOICE_COMMUNICATION + echo canceller            (LIVE) → assistant → speech
   VAD (voice activity) ──► gate closed: keyword spotter (Vosk)       attention manager: events (messages,
                         └─► gate open: utterances ──► LiveController   reminders, care, helpers) → judgement
  LiveController (TS): mode, gate, timers, barge-in ──► POST turns      (rules + model) → announcements
  speech output: care › notice › system › assistant › label  ◄──────── speech.announce (realtime)
```

- **`VoiceCapture`** (Java plugin): a foreground service of type `microphone` (Android 14+: started while the app is in
  front, then it keeps listening). Capture with the platform's echo canceller, noise suppression and gain control;
  voice activity detection on the device; while the gate is closed, the keyword spotter alone hears the audio; while
  it is open, each utterance (from its start to a pause) goes to the app as a WAV. Events: state, gate opened by the
  keyword, utterance, speech started (for barge-in).
- **`LiveController`** (app): LIVE off / on / paused; the gate closes after a quiet while (default three minutes,
  set per person) and opens with the keyword or a touch on the talk area; utterances become turns of mode `live`;
  barge-in: when the person speaks while UCAP talks, the speech of channels below care stops.
- **The turn in LIVE** (server): the same turn endpoint, `mode=live`: recognition on local providers, the matcher's
  LIVE mode, follow-ups without the keyword while the gate is open, listening right after a question (a reminder's,
  the help question, a confirmation).
- **The attention manager** (assistant process): it follows the person's events and decides what to say and when: a
  short message word for word with its sender ("Anna schrieb: …"), a long one summed up ("Maria fragt, …"), several
  together, a reminder at its time; never while the person speaks, never in quiet times (care and reminders marked so
  excepted); what was said is recorded (`heard_seq`) so nothing is said twice; "Was gibt's Neues?" asks for what is
  pending.
- **Settings** in the device configuration (S11): LIVE on/off, the assistant's name and keyword, the quiet while,
  quiet times, what is said by itself; changed by the person and by helpers with `device.configure`, announced,
  revisioned and reversible as in M1.

## Steps

Each step ends green: typecheck, tests, its check on the emulator (and in the browser where it applies), a commit.

| Step | Deliverables | Exit |
|---|---|---|
| **L0 Spikes** | **A:** a microphone foreground service on the emulator; how much of UCAP's own speech (device voice, a server voice through the WebView) reaches the capture with and without the echo canceller. **B:** voice activity detection (WebRTC's model and Silero's) on speech, music and silence: false triggers, CPU. **C:** Vosk's small German model with only the keyword in its grammar: load time, memory, CPU, keywords missed (several voices) and false wakes in an hour of German speech without the keyword. Reported in `docs/spikes/m2.md` | measured numbers and a choice for each; what needs the owner's phone named |
| **L1 Settings and the switch** | the device configuration's `live` part (schema, invariants, diff announcements); the assistant's name and keyword in onboarding and settings; LIVE on/off by touch, by voice ("LIVE an", "Pause", "Weiter", "LIVE aus") and by helpers; announcements ("Maria hat den LIVE-Modus eingeschaltet. Ich höre jetzt zu."), history | config tests (schema, diff, invariants), announcement goldens; the switch on the emulator and in the browser |
| **L2 Listening** | `VoiceCapture` (service, notification, capture, VAD, keyword spotter, utterances); `LiveController` (gate, timers, earcons); the browser's version while visible (no keyword spotter: it says so) | unit tests (gate and timers with an injected clock); on the emulator: the gate opens on the keyword and closes after the quiet while; nothing reaches the server while it is closed |
| **L3 Conversation** | turns of mode `live`; the matcher's LIVE mode (help asks back; silence never sends); follow-ups while open; listening right after a question; barge-in | matcher tests (LIVE help matrix), turn tests; on the emulator: a conversation without the keyword after the first turn, barge-in |
| **L4 The attention manager** | events into judgements into announcements; the examples of §19; batching; quiet times; nothing twice; "Was gibt's Neues?" | judgement tests with a scripted model (what is said, how, when; never in quiet times; care first); evaluations with the dialogue model; on the emulator with the Telegram stand-in |
| **L5 Voice for speech and look** | "Kürzer", "Langsamer", "Schneller", and the screen by voice (§6: "Mach die Schrift größer", "Hoher Kontrast"), read back with undo | command tests; on the emulator |
| **L6 Hardening and acceptance** | the privacy canary (no audio stored; nothing heard with the gate closed in any table, log or request); CPU and battery on the emulator; the e2e walk extended with LIVE (a fake capture stream and the stand-ins); docs | the M2 acceptance script below, on the emulator and in the browser; on the owner's phone where it needs one |

## Acceptance script (M2)

1. Maria switches LIVE on for Clara's tablet from her page; the tablet says that Maria switched it on and that it
   listens now.
2. "Lisa, wie spät ist es?" is answered; "Und wann kommt die Erinnerung?" right after, without the name, too.
3. After three quiet minutes the gate closes (its earcon). Ten minutes of radio speech: nothing happens, and nothing
   reached the server.
4. Anna writes "Hallo, wie geht's?": "Anna schrieb: „Hallo, wie geht's?“". Maria writes a long message: it is summed
   up, said as a summary.
5. At 15:00 the reminder: "Es ist 15 Uhr, Zeit für einen Schluck Wasser." Clara answers without the name; the answer
   is recorded.
6. "Hilfe": asked back, "Ja", the request is sent (A1, A2).
7. "Pause": nothing is said until "Weiter" or a touch; in the night's quiet times only care and marked reminders.
8. Clara speaks while UCAP reads a long message: it stops.
9. "Langsamer", "Kürzer", "Mach die Schrift größer": done, read back, undoable.

## Risks and open points

- **Echo cancellation differs between devices**: where UCAP's own voice reaches the capture, barge-in is weaker
  (the fallback: while UCAP speaks, only a louder voice or the keyword interrupts it). Measured on the emulator in L0,
  on the owner's phone later.
- **The keyword spotter's model** (Vosk, Apache 2.0, about 45 MB): served to the app by the UCAP server, so a device
  needs no other server; downloaded once for the repository's tools (with the owner's OK, as with every download of a
  third-party file).
- **Android starts a microphone service only while the app is in front**: switched on remotely while the app is in
  the background, LIVE starts when the app comes to the front, and the helper's page says so. After a restart of the
  device, the app has to be opened (kiosk mode in M4 keeps it in front).
- **Battery** on a phone (a bedside tablet is usually charging); measured in L6.
- **The Mac's memory** (the dialogue model, whisper, Docker, the emulator): LIVE adds turns, not models.
