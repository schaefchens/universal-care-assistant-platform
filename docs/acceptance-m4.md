# Milestone 4: acceptance

Where each exit check of [plan-m4.md](plan-m4.md)'s steps and each step of its acceptance script is checked: by an
automated test, in the browser walk, by a run on the Android emulator, or not yet, and what it waits for. The runs on
the emulator are recorded in [decisions.md](decisions.md), M4, under "Decided (within the plan)". M1's checks are in
[acceptance.md](acceptance.md), M3's in [acceptance-m3.md](acceptance-m3.md). State of 2026-10-27.

```sh
npm run typecheck && npm test        # 643 tests (M4: config, links, lock and its route matrix, changes, representatives,
                                     # trusted persons, kiosk, calls, LIVE's news, retention and limits)
npm run test:e2e                     # the browser walk: M1's, M3's and M4's scripts, axe on each new screen, the canaries
npm run test:android                 # the app's JVM tests (42, CallsTest among them)
node tools/android/axe.ts            # axe on the screen the emulator shows
node tools/android/a11y-tree.ts      # its accessibility tree, compared with TalkBack off and on (UI-02)
```

**Legend:** *test* = automated (file named); *e2e* = in the browser walk (`e2e/acceptance.spec.ts`, its step named);
*emulator* = run on the scratch emulator `ucap_m4_scratch` (the shared one never got a screen lock, a device owner or
another phone app); *open* = not yet, with the reason.

**The browser walk** (`npm run test:e2e`, about seventeen minutes, 42 steps): Clara's tablet, Maria's and Tom's
phones are browsers; Clara's phone is simulated (`e2e/phone.ts`), signing what its native code would send. The
servers' clock is moved where the script waits (a day for new words and recoveries).

**What needs a real phone** (none is available, the owner, 2026-10-15) is listed at the end.

## G0 Spikes

| Check | Where | State |
|---|---|---|
| Measured behaviour and a choice for each (keys, roles, lock task, pinning, calls) | docs/spikes/m4.md | done |
| What needs a real phone listed | below | done |

## G1 Screens, areas and sounds

| Check | Where | State |
|---|---|---|
| Config rules and diff goldens for every new kind | `packages/shared/test/config.test.ts` | test |
| Maria makes a screen "Freizeit" with two areas and a way to it | step G1 | e2e |
| Applied when idle, said, undone | step G1 (the browser); the person's own page on the emulator (G1, decisions) | e2e, emulator |
| axe on the editor | step G1 ("Gerät von Clara, screens and areas", "Bildschirme einrichten") | e2e |

## G2 Speech, guidance and care contacts; the helper's page

| Check | Where | State |
|---|---|---|
| The scope matrix for each setting | `server/test/helper-setup.test.ts` | test |
| Announcement goldens | `packages/shared/test/config.test.ts` | test |
| Maria sets Clara's reading voice, speed and the phone fallback; the tablet says it | step G2 | e2e |
| On the emulator | G2's changes are said and undone on the same screen as every remote change (M1, S11, checked on the emulator then); their sentences in step G2. A helper's change of speed on the emulator itself: open (it needs a helper account on the dev stack) | open |
| axe on the helper's page | step G2 ("Alles für Clara") | e2e |

## G3 Device linking

| Check | Where | State |
|---|---|---|
| Codes and their limits, one claim per offer, a second claim refused, words per claim, decline, expiry, only the person's own device approves, a locked device unlocks first | `server/test/links.test.ts` | test |
| A browser linked; signed out from the tablet, off at once | step G3 | e2e |
| The tablet linked to a browser and back | G3 on the emulator (decisions) | emulator |

## G4 The app lock

| Check | Where | State |
|---|---|---|
| The route matrix: every route of core and the assistant named open or locked | `server/test/lock-routes.test.ts` | test |
| Code limits and waits | `server/test/lock.test.ts`; the kiosk's check counts the same (`kiosk.test.ts`) | test |
| The log canary for codes | step M4-01 (below) | e2e |
| Lock, wrong code, unlock; help while locked | step G4 | e2e |
| On the emulator in explore mode | G4 on the emulator (decisions) | emulator |
| With TalkBack | the code screen's tree identical with TalkBack off and on, six real buttons; axe clean (G11). TalkBack's own gestures over the WebView: open (below) | emulator |
| axe | step G4 ("Neuer Code", "Gesperrt"); on the emulator ("Neuer Code") | e2e, emulator |

## G5 New words, the waiting period, "Später einrichten", the operator's reset

| Check | Where | State |
|---|---|---|
| The waiting period with the moved clock, a restart in between (the job), each way to stop it, a recovery with the old words meanwhile, first words, the reset never enrolling the administrator, codes single-use | `server/test/changes.test.ts` | test |
| Reset codes limited per address | `server/test/changes.test.ts` (G11) | test |
| The browser walk | steps G5, G5b, G5c | e2e |
| On the emulator: the notice at start, stopped from the tablet | G11's run (decisions) | emulator |

## G6 Representatives

| Check | Where | State |
|---|---|---|
| The permission matrix with a representative | `server/test/representatives.test.ts` | test |
| The admin rules (a reason, never themselves) | `server/test/representatives.test.ts` | test |
| An administrator names Maria for Tom; Maria approves a helper for Tom; Tom's device says it | step G6 | e2e |

## G7 Trusted persons

| Check | Where | State |
|---|---|---|
| k of n, a trustee who ended, a second recovery while one waits, stopping it, the new words | `server/test/trusted.test.ts` | test |
| Wrong codes count against the trusted person | `server/test/trusted.test.ts` (G11) | test |
| Clara recovered by Maria and Tom | step G7 | e2e |
| On the emulator | a waiting change's notice and "Abbrechen" on the tablet, checked with new words from the browser (G5's run); a whole recovery through trusted persons with the emulator as one of the devices: open | open |

## G8 Home screen, apps and the way back

| Check | Where | State |
|---|---|---|
| The editor's app choice and rules (an app area needs the app on that device) | `packages/shared/test/config.test.ts`, `server/test/kiosk.test.ts` | test |
| The role, an app opened and each way back, a restart | G8 on the emulator (decisions) | emulator |
| The editor's part | step G1, G9 (the editor) | e2e |
| The list of apps only while a helper may see it (setting up the devices or the kiosk), gone with the last such permission and in the daily sweep; said wherever they are granted (the owner, 2026-10-28) | `server/test/kiosk.test.ts`, `app/test/people.test.ts`; step 3 (the approval question says it) | test, e2e |
| On the emulator: no list without such a helper; sent once one is allowed, gone when helping ends | the shared emulator, 2026-10-28 (decisions, "The list of apps, bound to the permissions that show it") | emulator |

## G9 The kiosk lock

| Check | Where | State |
|---|---|---|
| The permission matrix with `device.kiosk`; the config rules | `server/test/kiosk.test.ts`, `packages/shared/test/config.test.ts` | test |
| As device owner: locked, an allowed app and back, an app not allowed refused, ended | G9 on the emulator (decisions) | emulator |
| Android's lock screen off | the setting is passed to Android (`setKeyguardDisabled`); the emulator's test person has no screen lock to remove | open |
| Ended remotely by Maria | step G9 (the browser's kiosk on and off by Maria) | e2e |
| Pinning and its end | the scratch emulator (G9, G10 and G11 runs): "angeheftet" said only once Android pinned UCAP | emulator |

## G10 UCAP as the phone app

| Check | Where | State |
|---|---|---|
| JVM tests: the call states, the log | `CallsTest.java` | test |
| The calls on the server, once each; read by the person only; a missed call said once; LIVE's news | `server/test/calls.test.ts`, `server/test/live-news.test.ts`, `packages/shared/test/calls.test.ts` | test |
| An incoming call answered and ended, one declined, a missed one said, "Wer hat angerufen?", a call inside the kiosk, the role given back | G10 on the emulator (decisions) | emulator |
| "Wer hat angerufen?" from the phone's signed report | step G10 | e2e |
| Under TalkBack: the call answered and ended by touch and double tap | G11's run | emulator |

## G11 Hardening and acceptance

| Check | Where | State |
|---|---|---|
| The canary: no link, lock, reset or recovery code and no four pictures in a row in any log or in what the stand-ins received | step M4-01 | e2e |
| Retention: offers, codes, recoveries, changes, calls | `server/test/hardening.test.ts` | test |
| Limits on every new code | links, lock (and the kiosk's check), reset, trusted recovery: their tests above | test |
| axe on every new screen | the browser walk's screens; on the emulator the device-only ones: Einstellungen (home, kiosk, phone), Kiosk-Modus, Anrufe, "Anrufen?", a page with "Zurück zum Anruf" | e2e, emulator |
| TalkBack | trees identical with TalkBack off and on: Einstellungen, Kiosk-Modus, Anrufe, "Anrufen?", the code screen; the native call screen under TalkBack | emulator |
| Play's declarations | docs/play.md (the phone role, device administration, the list of apps) | done |
| operator.md, helper-onboarding.md | the sections marked M4 | done |

## The acceptance script (plan-m4.md)

| # | Item | Where |
|---|---|---|
| 1 | Remote setup: a screen "Freizeit", a softer sound, a slower voice, short guidance; applied while nobody touches, said, "Rückgängig" | steps G1 and G2; on the emulator the person's own page (G1) |
| 2 | Care contacts: the phone fallback to Tom's number, said | step G2 |
| 3 | A second device by a code and four pictures | step G3; G3 on the emulator |
| 4 | App lock: the code chosen, help while locked, messages behind the code, wrong codes said, unlocked | step G4; G4 on the emulator |
| 5 | New words: said at once on the tablet, "Abbrechen", a day later the new ones work | steps G5 and G5c; the notice and stop on the emulator (G11) |
| 6 | Trusted persons: two of two, a day later the tablet is Clara's | step G7 |
| 7 | A representative named by an administrator; Tom's phone says Maria's act | step G6 |
| 8 | Home and apps: "Radio" opens, Home and "Zurück zu UCAP" lead back | G8 on the emulator (Clock as the app) |
| 9 | Kiosk: only UCAP and the allowed app, Home back, help works, ended by Maria | G9 on the emulator (as device owner, ended with the person's code); Maria's part in step G9 |
| 10 | Phone: a call said and answered by the large area; a missed call said; "Wer hat angerufen?"; inside the kiosk | G10 on the emulator; step G10 |
| 11 | "Später einrichten" and the reset | step G5b |
| 12 | Help needs none of it: locked, in the kiosk, while words wait, with the assistant and connectors stopped | steps G4, G5 and 14 (assistant and every connector stopped); inside a pinned kiosk on the emulator (G11's run: sent, said once the server had it) |

## Open until a real phone

- **Calls on a real network:** the earpiece and the proximity sensor (the emulator has only the speaker), a second call
  during a call, Bluetooth headsets, carriers' behaviour and emergency numbers (never tried on the emulator).
- **TalkBack under real fingers** on UCAP's WebView screens: on the emulator, TalkBack answered the console's touches on
  the native call screen, but not on the WebView after it (its focus stayed on the closed call screen). The trees are
  identical with TalkBack on and off, and M1's real-device checks cover the area grid.
- **Biometrics** with a real sensor, the 24-hour waiting period on a phone in a pocket (Doze), and a device owner set up
  by QR code on a new device.
- **Android's lock screen switched off** by a dedicated device's setting, on a device that has one.
- M1's and M3's open items on real devices (acceptance.md, acceptance-m3.md) hold for M4's screens too.
