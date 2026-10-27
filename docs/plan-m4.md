# UCAP — Milestone 4: Helper depth, devices, kiosk

The fourth milestone of [plan.md](plan.md)'s roadmap: CONCEPT §7, §8, §14 and §20, with §21's several devices,
built on Milestones 1 to 3. Departures from this plan go into [decisions.md](decisions.md), as before.

## Context

The owner's words:

- §8: "Authorized helpers should be able to configure a supported person's device from their own phone, tablet, or
  browser. This includes screen layouts, touch-area assignments, sounds, spoken explanations, voice preferences,
  reminders, activities, and care contacts." "Changes should be previewable, traceable, and reversible. Important
  controls—particularly help, navigation, and access to the familiar home screen—must be protected against accidental
  removal."
- §7: "The product should accommodate explicitly authorized representatives where someone cannot manage access
  independently. This must remain a separate, transparent arrangement rather than an automatic right granted to any
  helper." "Permission to provide care or configure a device must not automatically grant account-recovery
  authority."
- §14: "Normal access should rely on an authorized device with appropriate local unlocking options." "Optional
  trusted-person recovery arrangements should be explicitly established. Ordinary helper permissions must not silently
  provide the same authority."
- §20: "the user might add a few things to the external world, apps he might wanna use and can open but there must
  always be a mode to come back at the platform. also a kios mode should be possible so users cannot break out. this
  depends on what the user wants what capabilities he has and if others are managing care forh im or he uses the
  platform on his own."
- §21: "he also might use multiple devices at once, maybe in different rooms, maybe for different purposes. like a
  tablet next to the bed, and a mobile phone with camera to use it to see."

The roadmap (plan.md): "Remote setup of voice preferences, sounds, activities and care contacts. Device linking: a
6-digit code plus fingerprint words, approved only on the person's own devices. App lock with biometrics or PIN (a
second Keystore key; help never locked). Delayed key rotation. Representatives and trusted-person recovery, as explicit
arrangements. Kiosk mode: lock task or HOME role, an app allow-list, and a guaranteed way back."

M1 left room for it (plan.md, Appendix K): grants carry `granted_by_user` and `representation_ref`; "the enrolment
authority is generic: phrase, device, admin, or trusted k-of-n; identity keys rotate; nothing assumes one key per
user"; a device can be enrolled `via link`; sessions carry scopes, of which `personal` and `elevated` were kept for the
app lock; `recovery_state none` waits for helper-led setup; "help, back and home are in-app; no critical function
depends on system UI; MainActivity is singleTask"; `access.manage` and `recovery.trustee` are reserved scopes.

Parked for M4 on the way: "Adding and removing areas, other screens, sounds, and the voice settings" (decisions.md,
S11); "Wer hat angerufen? … fits with UCAP as the phone app beside kiosk mode (M4)" (plan-m3.md); "After a restart of
the device, the app has to be opened (kiosk mode in M4 keeps it in front)" (plan-m2.md); "Später einrichten" and an
operator identity reset (plan.md, Open points).

## Decisions (the owner, 2026-10-27)

| Topic | Decision |
|---|---|
| Kiosk mode | **A home screen and a lock.** UCAP can be Android's home screen: Home always comes back to it, it starts after a restart, and allowed apps open from its areas. "Locked" keeps the person inside UCAP: on a dedicated device (set up once from a reset device as its device owner) with the allowed apps inside; on any other device through Android's screen pinning, without other apps |
| Who locks it | **The person, and helpers given a new permission "Kiosk-Modus einstellen"** (`device.kiosk`). Every change is said on the device and kept in the person's history; help is never locked |
| App lock | The owner: "this is more complicated, because native unlocking might miss disability support. non seeing users might not unlock at all. could be a option that on some devices the system locking is disabled completely, might need to check this." Hence: **off by default and set per device** (a care tablet may have none). **The main unlock is UCAP's own code, entered on the large areas** (found by their sounds, pressed with the person's gesture; TalkBack, switches and keyboards too), checked by the server with limited tries. **Android's own lock** (fingerprint, face, PIN) **is an extra** where the person can use it, after G0 has checked it with TalkBack. **On a dedicated kiosk device UCAP can switch Android's lock screen off.** This replaces the roadmap's "App lock with biometrics or PIN (a second Keystore key …)" as the main way |
| Representatives | **The person, on their own device; when the person cannot, an administrator with a written reason** (a court's appointment, for example), never naming themselves. Said to the person, kept in their history, every act on their behalf told |
| Also in M4 | **"Später einrichten"** (an account a helper sets up starts without recovery words), **an operator identity reset**, and **UCAP as the phone app** ("Wer hat angerufen?", calls answered inside the kiosk). Not in M4: a person removing a protected control on their own device |
| Waiting period | **24 hours.** New recovery words without the old ones (from one of the person's devices, through trusted persons, or by the operator) take effect only after it; every device of the person says so at once and can stop it, and so can the old words. This is the roadmap's "delayed key rotation" |

## Principles

- **Help is never locked and never out of reach.** The app lock, the kiosk, Android's lock screen switched off, words
  being replaced, a device still being linked: help by touch, key and voice, reminders and care news work as before.
  Every screen keeps its help area (Appendix H); UCAP's own lock never stands before help.
- **What changes who can act for a person is the person's, and every device of theirs hears it.** A new device, a
  representative, a trusted person, new words, the kiosk: the person agrees on their own device. Only a
  representative, when the person cannot, may be named by an administrator, with a reason and never themselves.
- **Separate authorities** (§7, §14). Answering help, setting up a device, the kiosk, representing, recovering: each
  is its own grant or arrangement, and none implies another. No helper permission ever recovers an account; admin
  rights still grant no access to anyone's data.
- **A waiting period guards the identity.** Words replaced without the old words wait 24 hours; the person's devices
  and the old words can stop them. With the old words, nothing waits (M1).
- **Locks and approvals work without sight and without fine movements.** Codes on large areas with their sounds,
  fingerprint words said and shown, nothing that needs a quick reaction (§5: "Interaction should allow sufficient time
  to respond").
- **The server enforces, the screen only shows.** The app lock is a session scope the server checks on every route:
  a locked device's token reads no message. A kiosk is set in the device's configuration, versioned and reported, so a
  helper's page tells saved, received and applied apart (§8).
- **Changes from elsewhere keep M1's way**: previewed, versioned, said when they take effect, undone in one step;
  nothing moves under the person's finger (§6: "Familiar controls should not automatically move").
- **The app is first**; the browser does what it can and says what it cannot (a browser has no kiosk, no phone role
  and no Android lock).

## Architecture

```
 Person's devices                                                 core (no AI, no messaging code)
  app: areas (apps, calls, screens of areas)                       identity: links, unlock codes, waiting changes,
   lock screen of UCAP's own (code on areas) ──signed + code──►     trusted recoveries, operator resets
   Kiosk (Java): HOME role · screen pinning · device owner          people: grants (+ device.kiosk), representations,
     (lock task, allowed apps, keyguard off)                        trustees
   Phone (Java): dialer role, call screen in areas,                configs: screens, sounds, speech, kiosk; who may
     the call log ──signed──►                                       change which part
  new device ──6 digits──► link ◄── approve (fingerprint words) ── the person's other device
 Helpers' devices (browser, app)                                   assistant: "Wer hat angerufen?", calls in LIVE
  the person's page: devices, setup, care contacts, kiosk          (reads core's tables, as for SMS)
```

- **Sessions with two levels.** A device signs in with its key as now and gets `care`, `ui` and `status`. A device
  without the app lock gets `personal` and `elevated` with it, as in M1; a device with it gets them only after UCAP's
  code (or its Android key) proved the person is there. Every route is either open while locked (help, reminders'
  questions and answers, the configuration, push, the realtime channel, the time) or needs the unlock; a locked token
  gets 403 `locked`.
- **Changes that take a waiting period** are rows of one kind: the new identity key, who asked for it (a device,
  trusted persons, an administrator), when it takes effect, and who stopped it. A job makes it real at its time; the
  realtime channel and the start of every device tell the person.
- **The kiosk is part of the device's configuration** (S11): home screen, lock, the allowed apps, whether the person
  may end it. Changing that part needs `device.kiosk` (or being the person); the device applies it when nobody uses
  it, as every change, and reports what Android let it do (the role held, pinned, lock task as device owner).
- **The phone app** is native: an `InCallService` with UCAP's own call screen in large areas, and the call log read
  as the phone role allows. What the assistant needs (who called, when, missed) reaches the server signed by the
  phone, as SMS do (M3, K4).

## Data

- **`device_links`:** an offer (the code's MAC, the person, the device that offers, expiry), its claim (the new
  device's key, name and platform, the proof), the salt for the fingerprint words, the state (open, claimed, approved,
  declined, expired) and who approved.
- **`devices`:** `enrolled_via` gains `trusted` and `reset`; `linked_by` (the device that approved); `locked` (the app
  lock on or off); `unlock_jwk` (the Android key, when the person uses it); the apps the device can open, in its
  capabilities; what the kiosk is doing, in its configuration's state.
- **`unlock_codes`:** one code per person (the same on every device that locks), kept only as a slow hash with its
  salt; failed tries and the wait they caused.
- **`identity_changes`:** the person, the new identity key and its proof, the kind (device, trusted, reset, first
  words), who asked (user, device, administrator and reason), the new device where one comes with it, `effective_at`,
  the state (waiting, done, stopped) and who stopped it.
- **`representations`:** person, representative, made by (the person, or an administrator with the reason), started
  and ended (by whom). Grants made by a representative carry `representation_ref`.
- **`trustees`** and **`trusted_recoveries`:** who the person trusts (invited, accepted, ended) and how many must
  agree; a recovery (the new device's key, its code, each trustee's signed yes, the state).
- **Grants:** the scope `device.kiosk`. `access.manage` stays out of grants: it comes with a representation.
- **The device configuration:** screens of any size and number with every area's function (the app's screens, the
  assistant, a screen of areas, back, home, time, where, an app, a call); sounds per area from a larger set; `speech`
  (rate, guidance); `kiosk` (home, lock, allowed apps, who may end it, Android's lock screen off).
- **`calls`:** the phone's calls as UCAP keeps them: the number and the contact, in or out, answered, missed or
  declined, when and how long.

## Steps

Each step ends green: typecheck, tests, its check on the emulator (and in the browser where it applies), a commit.

| Step | Deliverables | Exit |
|---|---|---|
| **G0 Spikes** | On a scratch emulator of its own made from Android's plain image (no Google account), deleted afterwards; the shared emulator never gets a screen lock, a device owner or another phone app. **A, unlocking:** Android's lock screen and its unlock prompt (fingerprint and PIN) with TalkBack: can a TalkBack user unlock, how long it takes; a second Keystore key bound to it (validity, what removing the lock does to it); UCAP's code on areas, prototyped, with TalkBack and in explore mode. **B, the home screen:** the HOME role (Android's dialog with and without TalkBack), Home back to UCAP, starting after a restart, another app opened and the ways back (Home, a notification "Zurück zu UCAP", by voice from LIVE's service: may the home app come to the front by itself), the list of apps Android lets UCAP see. **C, the lock:** screen pinning (its question, what it blocks, how it ends with and without a PIN); lock task as device owner (`dpm set-device-owner` on the scratch emulator): allowed apps inside, Home and notifications as features, the keyguard switched off, an incoming call, and the owner removed again. **D, the phone role:** the dialer role's dialog; an `InCallService` with a screen of UCAP's own; an incoming call (`adb emu gsm call`) answered and ended; the call log; inside lock task. Reported in `docs/spikes/m4.md` | measured behaviour and a choice for each; what needs a real phone listed |
| **G1 Screens, areas and sounds** | The device editor (helpers with `device.configure`) and the person's own settings shape every screen, not only home: how many areas and how they are laid out (one, two, four, six, nine; rows and columns), areas added and removed, a new screen of areas and the area leading to it, each area's function, label, spoken description, sound (twelve distinct sounds, each to listen to), vibration and activation. The protected controls hold as in S11 (help on every screen, the way back, home at most two steps away) and the editor shows why a change cannot be saved. What the device says is built from the two versions, for the new kinds of change too ("Maria hat auf der Startseite das Feld „Radio“ hinzugefügt."); the preview shows any screen | config rules and diff goldens for every new kind; the browser walk: Maria makes a screen "Freizeit" with two areas and a way to it; on the emulator: applied when idle, said, undone; axe on the editor |
| **G2 Speech, guidance and care contacts; the helper's page** | **Voice preferences** (§5, §8) by helpers with `device.configure`: the voices for answers and reading aloud (only those that need no consent or that the person agreed to; otherwise "Dafür muss Clara selbst zustimmen"), the speaking speed (moved into the device's configuration), the length of answers, language and form of address, and **the amount of guidance** (new: full or short screen announcements and hints). Each said on the device ("Maria hat deine Stimme für Antworten auf Nova gestellt.") with undo, and in the history. **Care contacts** by helpers with `care.configure`: next to the order of helpers (S12), the phone fallback (who, which number, call at once or open the dialler) and what an unanswered help question does. **"Activities":** the activity screens (messages, notes, contacts, appointments, tasks; G8 adds apps); §10's activities come with M7 and get their remote setup there. **The helper's page per person:** what the helper may do for them in one place: the person's devices (last seen, setup applied or waiting, app lock and kiosk), open help requests, and the pages for reminders, contacts, appointments, care contacts and setup | the scope matrix for each setting; announcement goldens; the browser walk: Maria sets Clara's reading voice, speed and the phone fallback, and the tablet says it; on the emulator; axe on the helper's page |
| **G3 Device linking** | **On a signed-in device:** "Neues Gerät verbinden" (unlocked, if the app lock is on) gives a 6-digit code for ten minutes, said digit by digit and shown large, with the server's address; one code at a time. **On the new device:** "Mit einem anderen Gerät verbinden": the server, the code, a key of its own. **Both devices** then show and say four fingerprint words (simple things with their pictures: "Hund, Schlüssel, Regenschirm, Rakete"), from the new device's key and a salt the server draws after the claim. The person compares and says yes on the old device ("Ja, das ist mein neues Gerät"); no, a timeout or another claim end it. The new device is enrolled (`via link`) and signed in; every device hears "Ein neues Gerät wurde hinzugefügt: Tablet, verbunden über Telefon." **Never** by a helper or an administrator; the approving device must be one of the person's own. Limits: claims per address, failed claims server-wide, five wrong tries end a code | tests: codes and their limits, one claim per offer, a second claim refused, words differing per claim, decline, expiry, only the person's own device approves, a locked device must unlock first; the browser walk: a browser linked from the simulated phone; on the emulator: the tablet linked to Chrome and back |
| **G4 The app lock** | **Per device, off by default.** Switched on by the person on that device (and only there): first their **code** (one per person, the same on every device that locks): six presses on four large areas, each with its own sound and name ("oben links" …), or 1 to 4 on a keyboard; TalkBack and switches press the areas as buttons. The server keeps a slow hash only; five wrong tries make it wait (one minute, then longer); the code is never logged or spoken. **Android's lock as an extra** where G0 found it usable: a second Keystore key bound to the phone's own lock, registered with the server. **Locked:** help, the help question, reminders (questions and answers), care news, the time, "Wo bin ich?" and an "Entsperren" area work; everything else waits behind the code. New messages are said as "Eine neue Nachricht." without who or what; the assistant and LIVE's reading wait. **When it locks:** after the screen went off or UCAP left the front for the chosen while (at once, 1, 5 or 15 minutes), or by "Sperren" (voice or area). **A forgotten code:** a new one from another unlocked device of the person, or with the recovery words. **On a dedicated kiosk device** Android's own lock screen can be off (G9) | the route matrix: every route of core and the assistant named open or locked, a locked token refused on each locked one; code limits and waits; the log canary for codes; the browser walk (lock, wrong code, unlock); on the emulator with TalkBack and in explore mode; axe |
| **G5 New words, the waiting period, "Später einrichten", the operator reset** | **New words without the old ones** from one of the person's devices ("Ich habe meine Wörter verloren"), unlocked: the ceremony makes them, and they take effect after 24 hours. Every device says it at once and at every start until then ("Ab morgen, 14:05 Uhr, gelten neue Wiederherstellungswörter. Wenn das nicht von dir kommt, sag „Abbrechen“."); any device of the person or a recovery with the old words stops it. With the old words, at once (M1). **"Später einrichten":** an account set up with a `supported_person` invitation may start without words (`recovery_state none`): the device reminds the person, says that the account cannot be recovered without words yet, and offers words, device linking and trusted persons. The first words of such an account need no waiting period and are told to every device. **The operator reset:** for someone who lost words and devices and has no trusted persons. An administrator, with a reason, makes a reset code (a link and a spoken code, as invitations); the person's new device takes it, gets a key and new words, and becomes theirs after 24 hours, unless one of their devices or their old words stopped it. Audited with the reason, said on every device of the person at once; the administrator gets nothing of the person's | tests: the waiting period with the moved clock, a restart in between (the job), each way to stop it, a recovery with the old words meanwhile, first words, the reset never enrolling the administrator, codes single-use; the browser walk; on the emulator: the notice at start, stopped from the tablet |
| **G6 Representatives** | **An arrangement of its own**, not a permission: the person makes someone their representative on their own device, after hearing what it means ("Maria kann dann für dich entscheiden, wer dir helfen darf und was. Deine Nachrichten und Notizen sieht sie dadurch nicht."); an administrator can when the person cannot, with a written reason, never naming themselves. **A representative manages access for the person:** invites and approves helpers, sets and withdraws their permissions (never adds to their own), ends connections, signs out the person's devices; not messages or notes, not device linking, not recovery, not the person's consents to outside providers. **Transparent:** each act carries the arrangement, is said on the person's devices ("Maria hat als deine Vertretung Tom erlaubt, auf deine Hilferufe zu antworten.") and is in the history; the access overview names the representative first. Ending: the person on their own device, or the administrator who made it | the permission matrix with a representative (what they may and may not); the admin rules (reason required, never themselves); announcement goldens; the browser walk: an administrator names Maria for Tom's account, Maria approves a helper for Tom, Tom's device says it |
| **G7 Trusted persons** | **An arrangement of its own** (§14: "Optional trusted-person recovery arrangements should be explicitly established"): the person names trusted persons (accounts on this server, each agreeing on their own device: "Du siehst dadurch nichts von Claras Daten.") and how many must agree (one to all of them; two of three suggested). No helper permission implies it. **Recovery:** on a new device, "Mit Vertrauenspersonen wiederherstellen" shows a code; a trusted person enters it, hears whose account and the device's fingerprint words, and says yes; when enough did, the waiting period (G5) starts; afterwards the new device is the person's and makes new words. The person's devices and old words can stop it | tests: k of n, a trustee who ended, a second recovery while one waits, stopping it, the new words; the browser walk: Clara recovered by Maria and Tom; on the emulator |
| **G8 Home screen, apps and the way back** | **UCAP as Android's home screen** (the role, after UCAP explains Android's question; given back in one step): Home comes back to UCAP; after a restart UCAP starts by itself, LIVE with it. **Apps on areas** (§20: "apps he might wanna use and can open"): the apps the device can open, chosen by the person or a helper with `device.configure` in the editor; such an area says what it opens ("YouTube. Öffnet die App YouTube.") and opens it. **The way back** (§20: "there must always be a mode to come back"): Home; a notification "Zurück zu UCAP" while another app is in front; by voice in LIVE ("Lisa, zurück"), where G0 found that allowed; said as UCAP comes back ("Zurück in UCAP. Startseite."). A browser offers no apps and says so | the editor's app choice and rules (an app area needs the app on that device); on the emulator: the role, an app opened and each way back, a restart; the browser walk for the editor's part |
| **G9 The kiosk lock** | **"Kiosk" on and off** by the person and helpers with "Kiosk-Modus einstellen" (`device.kiosk`, a new permission, proposed and approved as the others and named in the spoken summary). Who may end it is part of the setting ("Beenden können: Clara und Maria" or "nur Maria"), said when it starts. **On a dedicated device** (device owner, set up once from a reset device by QR code or by computer; operator.md says how): lock task with the allowed apps inside, Home leading back to UCAP, notifications as chosen, Android's lock screen off where chosen (then UCAP's own lock, G4, is the device's). **On any other device:** screen pinning, with no other apps, and Android's own way out (which the page names). **In the kiosk:** help as always; UCAP's settings show only what the person may change; ending it from the device needs the person's code (G4) where the person may end it. Every change said and in the history | the permission matrix with `device.kiosk`; the config rules (a kiosk keeps help and home; the person's choice to end it); on the scratch emulator as device owner: locked, an allowed app and back, an app not allowed refused, Android's lock screen off, ended remotely by Maria; on the shared emulator: pinning and its end |
| **G10 UCAP as the phone app** | **Android's phone role** (the dialer), offered on a phone with telephony after UCAP explains it, given back in one step. **Calls in areas:** an incoming call says who (from the person's contacts, "nicht in deinen Kontakten" otherwise) with Annehmen, Ablehnen and Hilfe as large areas; during a call Auflegen, Lautsprecher, Lauter and Hilfe; inside the kiosk too. **Calls out** go straight through the role (K6's calls without the dialler). **The call log:** missed calls said ("Verpasster Anruf von Anna, 14:05.") and in LIVE; "Wer hat angerufen?" by voice and on a page; what the server keeps (who, when, how) reaches it signed by the phone. A tablet without telephony is never offered it | JVM tests (the call states, the log); on the emulator: an incoming call answered and ended, one declined, a missed one said, "Wer hat angerufen?", a call inside the kiosk, the role given back to the system's phone app |
| **G11 Hardening and acceptance** | **Logs:** the canary with codes, link codes, reset codes and fingerprint words (none in any log). **Retention:** expired offers, codes and recoveries. **Security and accessibility:** limits on every new code; audits of every new screen with TalkBack and axe. **Play:** the declarations for the phone role, device administration and the list of apps (play.md). **Tests and docs:** the browser walk extended to the acceptance script below; operator.md (dedicated devices, the operator reset, representatives named by an administrator); helper-onboarding.md (the person's page, the kiosk permission, representing, trusted persons); an M4 acceptance file | the acceptance script below, on the emulator and in Chrome; what needs a real phone listed as open |

## Acceptance script (M4)

Clara's tablet is the emulator; Maria and Tom use browsers; the dedicated device is the scratch emulator.

1. **Remote setup:** Maria, on her phone's browser, gives Clara's tablet a screen "Freizeit" with "Radio" and "Fotos",
   a softer sound for "Nachrichten", a slower voice and short guidance. The tablet applies it while nobody touches it,
   says each change, and "Rückgängig" puts the voice back.
2. **Care contacts:** Maria sets the phone fallback to Tom's number; Clara's tablet says it.
3. **A second device:** Clara's new phone asks for a code; the tablet gives "4 8 1 0 2 7"; both say "Hund, Schlüssel,
   Regenschirm, Rakete"; Clara says yes on the tablet, and the phone is hers.
4. **App lock:** on the phone, Clara switches the lock on and chooses her code. Locked, the help area still sends
   help; messages wait behind the code; a wrong code three times is said, the right one unlocks.
5. **New words:** Clara lost her card. On the phone, "Neue Wörter": the tablet says at once that new words take effect
   tomorrow; "Abbrechen" on the tablet stops it; done again, a day later the new words work and the old ones do not.
6. **Trusted persons:** Clara names Maria and Tom, two must agree. With every device gone, a new tablet shows a code;
   Maria and Tom say yes; a day later the tablet is Clara's, with new words.
7. **A representative:** an administrator names Maria as Tom's representative, with a reason. Maria approves a new
   helper for Tom; Tom's phone says that Maria did this as his representative.
8. **Home and apps:** the tablet is the home screen; "Radio" opens the radio app; Home and "Zurück zu UCAP" lead back,
   and UCAP says where Clara is.
9. **Kiosk:** Maria, with "Kiosk-Modus einstellen", locks the dedicated tablet: only UCAP and the radio app; Home leads
   back; the help area works; Maria ends it from her browser.
10. **Phone:** an incoming call from Anna is said and answered by the large area; a missed call is said; "Wer hat
    angerufen?" names both; inside the kiosk too.
11. **"Später einrichten" and the reset:** an account set up by Maria for Hans has no words, and his device says so;
    an administrator's reset for someone who lost everything becomes theirs after a day, and their old tablet heard it
    at once.
12. **Help needs none of it:** with the tablet locked, in the kiosk, during the waiting period, and with the assistant
    and connectors stopped, help by touch and key and the reminders work.

## Risks and open points

- **The emulator is shared.** Its test person holds the owner's real accounts. A screen lock, a device owner or a
  phone app is only ever set on a scratch emulator made for M4 and deleted afterwards; on the shared one, only what is
  undone in one step (the home role, screen pinning).
- **A device owner is hard to undo:** only the app itself or a factory reset removes it, and Android allows it only on
  a device without accounts. operator.md describes it for dedicated tablets; UCAP's settings can end it.
- **Screen pinning is no real lock:** Android always keeps its own way out (and asks for the phone's PIN only where one
  is set). The page says so; a real kiosk is a dedicated device.
- **UCAP's code is short** (six presses on four areas: 4096 possibilities), chosen so everyone can enter it; the
  server's limits make guessing slow, and only the device itself (with its key) can try at all.
- **The phone role** needs telephony; the emulator's calls come from its console. Calls on a real network, Bluetooth
  headsets, emergency calls and carriers' behaviour wait for a real phone. Play gives the call log only to the default
  phone app, which UCAP then is.
- **Play:** device administration and the phone role need declarations; listing other apps uses a `<queries>` entry
  for launchers, not `QUERY_ALL_PACKAGES`.
- **No real phone yet** (the owner, 2026-10-15): what needs one (biometrics, a SIM, the 24-hour waiting period on a
  phone in a pocket, a device owner set up by QR code) is listed in the acceptance file.

## New third-party code

None planned: the Android parts use the framework (BiometricPrompt, KeyguardManager, RoleManager, DevicePolicyManager,
InCallService); the server needs nothing new. A word list for the fingerprint words is written for UCAP.
