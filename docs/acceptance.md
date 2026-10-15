# Milestone 1: acceptance

Where each check of [docs/plan.md](plan.md), Appendix J, and each step of the acceptance script is checked: by an
automated test, by a run on the Android emulator or in Chrome (recorded in [decisions.md](decisions.md) under the step,
or here), or not yet, and what it waits for. State of 2026-10-15.

```sh
npm run typecheck && npm test        # 392 tests; the Telegram test-DC suite is opt-in (UCAP_TG_TEST=1)
npm run test:docker                  # the same suite inside the image
npm run test:e2e                     # the acceptance script in browsers, on a stack of its own (e2e/acceptance.spec.ts)
npm run evals                        # the assistant against the dialogue model (60 German utterances)
npm run backup:check                 # backup, restore into a scratch database, compare every table
npm run android:check                # on the emulator: AN-12, UI-08, UI-01, Help first, AN-08, the DND matrix (AN-02)
node tools/android/axe.ts            # accessibility audit of the screen the emulator shows (UI-01)
node tools/android/a11y-tree.ts --dom   # its accessibility tree and DOM, to compare TalkBack on and off (UI-02)
```

**Legend:** *test* = automated (file named); *e2e* = in the browser walk of the acceptance script
(`e2e/acceptance.spec.ts`, its step named); *emulator* / *Chrome* = run by hand, with the step it is recorded under;
*open* = not yet, with the reason.

**The browser walk** (`npm run test:e2e`, about two minutes): a stack of its own (compose profile `e2e`, a fresh
database `ucap_e2e` for every run, entry http://localhost:8815), the servers' clock moved forward where the script
waits (test mode, never in production), the AI engines replaced by stand-ins that speak their APIs (`e2e/engines.ts`),
Telegram by `tools/dev/fake-telegram.ts`, Tom's phone simulated (`e2e/phone.ts`: UnifiedPush through ntfy, receipts
and "Annehmen" signed by its key). Maria and Clara use the app in browsers of their own, with a fake microphone.

## Identity

| Id | Check | Where | State |
|---|---|---|---|
| ID-01 | account from an invitation; one entropy, the same key from German and English words | `server/test/identity.test.ts`, `packages/identity/test/phrase.test.ts` (BIP39 vectors) | test |
| ID-02 | the phrase canary: no phrase, in either rendering, in any table or in anything the server logged | `server/test/identity.test.ts`; in the browser walk, nothing the stand-ins received and nothing the e2e servers logged holds three words in a row of any account's phrase | test, e2e |
| ID-03 | the ceremony is isolated | `app/test/words.test.ts` (no list word in the debug record; no server voice while the words are open, added in S12); the microphone refuses during it (`app/src/voice/controller.ts`); FLAG_SECURE (AN-11) | test, emulator (S2) |
| ID-04 | verification quiz, checksum errors | `packages/identity/test/phrase.test.ts` (checksum, what is wrong and where); the quiz on the emulator | test, emulator (S2) |
| ID-05 | recovery, address variants, the other devices told | `server/test/identity.test.ts`; recovered with the English card on the emulator (S2, and twice on 2026-10-15); with the English rendering typed in a new browser, the tablet told (e2e step 10) | test, emulator, e2e |
| ID-06 | challenge replay, expiry, wrong origin | `server/test/identity.test.ts` | test |
| ID-08 | revocation: 401, socket closed within a second, endpoints removed, local wipe | `server/test/identity.test.ts`, `server/test/realtime-client.test.ts`; signed out from the new device, the old one shows its not-set-up screen within 3 s (e2e step 10) | test, e2e |
| ID-09 | token renewal; no bearer secret in storage | `server/test/identity.test.ts` | test |
| ID-10/11 | bootstrap and invitation brute force | `server/test/identity.test.ts`; limits on proofs and challenges in `server/test/hardening.test.ts` | test |
| ID-12 | words said to the assistant never reach the model | `packages/identity/test/leak.test.ts`, `server/test/turns.test.ts` | test |
| ID-13 | rotation | `server/test/identity.test.ts` | test |

## Care

| Id | Check | Where | State |
|---|---|---|---|
| CR-01 | a press reaches the helpers; A1, A2, A4, A6 | `server/test/care.test.ts`; emulator and Chrome (S4, S5; again under the security policy, S12); e2e step 4 | test, emulator, e2e |
| CR-02 | exploring, sliding in, dwell and lift, two fingers, cancel: no request | `packages/touch/test/properties.test.ts` (P1–P9), `engine.test.ts` | test |
| CR-03 | keyboard and virtual clicks send | emulator, 2026-10-15: Enter and Space on the focused help area; TalkBack's tap then double tap (real touches through the emulator console) sent and cancelled a request | emulator (S12) |
| CR-04 | model and speech recognition down: help unaffected, A19 | `tools/test/import-graph.test.ts` (core imports nothing optional), the care suite runs on core alone, `server/test/turns.test.ts` (A19), `server/test/assistant.test.ts` (model down); whisper stopped on the emulator (S8); both stand-ins down in e2e step 9 | test, emulator, e2e |
| CR-05 | offline: A3, never A2, one request; A22 with a wrong clock | `app/test/care-outbox.test.ts`; `server/test/care.test.ts` (the wait measured on the device's own clock, S12); A22 and one request after a kill on the emulator (S5) | test, emulator |
| CR-06/07 | coalescing; twenty at once make one | `server/test/care.test.ts` | test |
| CR-08/09/10 | escalation, exhausted, nobody reachable within 10 s | `server/test/care.test.ts`; the escalation to Tom after two minutes, the receipt of Tom's phone (A4) and the accept, in e2e step 5 | test, e2e |
| CR-11 | accept race; the other alarm stops | `server/test/care.test.ts`; alarm updated in place on the emulator (S5) | test, emulator |
| CR-12 | cancel | `server/test/care.test.ts`; emulator (S5, S12); e2e step 9 (A13, A14) | test, emulator, e2e |
| CR-13 | core killed mid-escalation: each alert once | `server/test/care.test.ts` | test |
| CR-14 | silenced receipt | `server/test/care.test.ts`; total silence on the emulator (S5) | test, emulator |
| CR-15 | resolve and reopen | `server/test/care.test.ts` | test |
| CR-16 | quick replies quoted; the lint | `server/test/care.test.ts`, `app/test/care.test.ts`, `packages/shared/test/i18n.test.ts`; A7 and nothing else saying anyone is coming, in e2e step 4 | test, e2e |
| CR-17 | the voice help matrix | `packages/speech-text/test/commands.test.ts`, `server/test/turns.test.ts`; emulator (S8) | test, emulator |
| CR-18 | an injected message makes the model propose help: A17, silence, nothing sent | `server/test/assistant.test.ts`, `server/test/messaging.test.ts` | test |
| CR-19/20 | forged, replayed, duplicate receipts; ntfy's access control; undecryptable pushes | `server/test/care.test.ts`, `server/test/unifiedpush.test.ts`; AN-14 on the emulator | test, emulator |
| CR-21 | heartbeats and A21 | `server/test/care.test.ts` | test |

## Assistant

| Id | Check | Where | State |
|---|---|---|---|
| AS-01 | the send flow; C3 only after Telegram confirms | `server/test/messaging.test.ts`; emulator with the stand-in (S10); e2e step 7, with the stand-in holding Telegram's confirmation | test, emulator, e2e |
| AS-02/03/04 | stale hash; "ja" with nothing waiting or on another device; expiry | `server/test/assistant.test.ts` | test |
| AS-05 | the adversarial model | `server/test/assistant.test.ts` | test |
| AS-06 | originals byte for byte, framed | `server/test/assistant.test.ts`; e2e step 7 (the model's text is replaced by the message's) | test, e2e |
| AS-07 | a crash while attempting: C6, no resend | `server/test/assistant.test.ts`, `server/test/messaging.test.ts` | test |
| AS-08 | delete with undo | `server/test/assistant.test.ts` | test |
| AS-09 | reminder readback | `server/test/assistant.test.ts` | test |
| AS-10/11 | consent, no silent fallback; the log canary | `server/test/speech.test.ts` | test |

The evaluation (`npm run evals`): 58 of 60 with qwen3.6 (S10); the misses were arithmetic and Ollama pausing under the
Mac's memory pressure.

## UI

| Id | Check | Where | State |
|---|---|---|---|
| UI-01 | axe: no serious issue on any M1 screen | `tools/android/axe.ts`: every screen of the person's app on the emulator, the helper's and admin's pages in Chrome (S12) | emulator, Chrome |
| UI-02 | real buttons in every mode; the same DOM with TalkBack on and off | `tools/android/a11y-tree.ts`: the home screen's tree and DOM identical with TalkBack off and on (2026-10-15) | emulator (S12) |
| UI-03 | focus and announcements on a screen change; "Wo bin ich?" | every screen change says its name and what it holds ("Notizen. 3 Notizen. …"), with TalkBack through the live region; "Wo bin ich?" by voice: "Du bist auf: Notizen. Zur Startseite kommst du mit Zurück."; "Was kann ich hier tun?" names the areas by their place | emulator (S8, S12) |
| UI-04 | invariants: 422, and the device repairs | `packages/shared/test/config.test.ts`, `server/test/configs.test.ts`, `app/test/config-sync.test.ts` | test |
| UI-05 | idle apply, announcement, undo | `app/test/config-sync.test.ts`; emulator and Chrome (S11); e2e step 8 | test, emulator, e2e |
| UI-06 | the recommended timeout is used | with Android's "time to take action" at one minute, the help question waited 62 s before asking again (2026-10-15, after a fix: the first window ignored it) | emulator (S12) |
| UI-07 | care announcements survive exploring | `app/test/speech.test.ts` | test |
| UI-08 | security policy; inert rendering | `app/test/security.test.ts`; the built app on the emulator and in Chrome with no refusal (S12) | test, emulator, Chrome |

## Sync

| Id | Check | Where | State |
|---|---|---|---|
| SY-01 | socket drop during escalation: the accept said once | `server/test/realtime-client.test.ts` | test |
| SY-02 | resync | `server/test/realtime-client.test.ts` | test |
| SY-03 | dispatcher order under concurrency | `server/test/dispatcher.test.ts` | test |
| SY-04 | offline states of what was confirmed | a message confirmed while the connectors are away waits (C9): `server/test/messaging.test.ts`; a reminder answer says whether it has left the device: `app/test/reminders.test.ts`; a configuration "noch nicht beim Gerät angekommen" (S11). Notes are made through the assistant only, which says when it cannot be reached: there is no offline note in M1 | test, emulator |

## Android

| Id | Check | Where | State |
|---|---|---|---|
| AN-01 | 10 of 10 receipts in deep Doze | needs the ntfy app on the emulator (a download the owner has not yet allowed) or a real phone | open |
| AN-02 | DND matrix, `delivered_silenced` | `npm run android:check`: in each mode (off, alarms, priority, total silence) a heartbeat comes back and the phone reports the mode; the decision is `SilenceTest` (JVM); a real alert in total silence came back `delivered_silenced` (S5, again 2026-10-15). The makers' DND variants on a real phone | test, emulator; real phone open |
| AN-03 | one notification per request; no quietening at 120 s | emulator: the same notification from alarm to update (S5); on 2026-10-15 a re-alert 136 s after the first rang again in the same notification (a new alarm-usage sound), and the cancel moved it to the quiet channel | emulator (S5, S12) |
| AN-04 | "Annehmen" needs the unlock; "Wird übermittelt" while offline | the unlock needs a phone with a screen lock | open |
| AN-05 | killed after the press: exactly one request | emulator (S5) | emulator |
| AN-06 | `pm clear`: the not-set-up screen; the Keystore survives the WebView's storage | emulator, 2026-10-15: after `pm clear` the not-set-up screen with "Notruf 112"; with only the WebView's storage cleared, the device signed in again with its key, no words, and its helper alarm was delivered with a receipt (after two fixes, see decisions S12) | emulator (S12) |
| AN-07 | standby buckets | needs the ntfy app | open |
| AN-08 | earcons with accessibility usage | `dumpsys audio`: the app's SoundPool, and the device voice, play with `USAGE_ASSISTANCE_ACCESSIBILITY` (2026-10-15) | emulator (S1, S12) |
| AN-09 | TalkBack mode | TalkBack detected (S1); its gestures operate the areas and help (S12) | emulator |
| AN-10 | airplane mode, A3b, a deliberate call | emulator (S5) | emulator |
| AN-11 | FLAG_SECURE | emulator (S2) | emulator |
| AN-12 | backup flags | emulator (S2) | emulator |
| AN-13/15 | voice data removed: the ceremony blocked, care falls back to the bundled clips | the check is built and passes with the voices installed (S2); removing them needs Google's settings app | open |
| AN-14 | an undecryptable push does not ring | emulator (S5) | emulator |

## Manual, on real devices (Appendix J)

All open: they need real phones, which the owner provides: TalkBack, Switch Access and Voice Access with real fingers
and a Bluetooth switch; earcon latency with a 240 fps camera; the alarm in a pocket with the screen off; 24 h of real
Doze and the makers' battery managers; DND modes; the ceremony over Bluetooth headphones; tremor timings; voice help
with older speakers (recorded with consent).

**The 48-hour push soak** (S12) is ready to run on such a phone: `npm run push:soak -- <device id>`, then
`npm run push:soak-report -- <device id>`. Tried on the emulator for six minutes, a heartbeat a minute through the dev
stack's ntfy and the push stand-in: each heartbeat sent while the stand-in forwarded came back, median 0.9 s, the
slowest 3.7 s. Test: `server/test/care.test.ts`.

## The acceptance script

| Step | What | State |
|---|---|---|
| 1 | Operator setup | done on the dev stack (setup, compose, the CLI bootstrap; Ollama, stt-mlx, OpenAI and ElevenLabs keys); e2e step 1 (the CLI bootstrap, a voice service and Telegram's credentials on the admin page). **Owner:** joining herde; Telegram's api_id and api_hash on the dev stack's admin page |
| 2 | First identity on the tablet | emulator (S2, S7): invitation link, words spoken and shown, the quiz, the card, a voice chosen by listening, four areas; e2e step 2 |
| 3 | Inviting a helper by the spoken code | emulator and Chrome (S3); e2e step 3 (the 10-digit code, the scopes shown to Maria, the summary said on approval; the order of helpers set) and 3b (a helper allowed to set the order). Maria on a phone: owner's devices |
| 4 | Help request | emulator and Chrome (S4, S5): exploring sends nothing, A1, A2, A4, A6, A7, A12; e2e step 4 (A1, A2, A4, A6, A7, A12). **Owner's phone:** ringing in Doze, the unlock for "Annehmen" |
| 5 | Escalation to Tom | `server/test/care.test.ts`; the alarm updated in place on the emulator (S5); e2e step 5 (A9 after two minutes, Tom's phone alerted through ntfy, its receipt and accept; Maria told who took over). Two real phones: owner |
| 6 | Reminder "Trinken" | emulator (S6, S9): rings with the app closed and the server stopped; "Kann mir jemand Wasser bringen?" → A17 → "Ja" → a linked request; e2e step 6 (set by Maria for 15:00, the clock moved there) |
| 7 | Telegram | emulator with the stand-in (S10): summary labelled as one, the original framed, a voice message played and transcribed, C1 → "Ja" → C2 → C3; e2e step 7 (without the voice message). Telegram's test servers refuse their documented test code (2026-10-15, decisions.md S10). **Owner:** a login with a real account (the api_id and api_hash are in hand) |
| 8 | Remote change | emulator and Chrome (S11); e2e step 8 |
| 9 | No language model | the tests above (CR-04); whisper stopped on the emulator gave A19 (S8); e2e step 9 with both stand-ins down. Ollama is the Mac's shared app and was not stopped |
| 10 | Recovery on another device | emulator (S2, S12) with the English words; the other devices told and a revoked device cut off within a second: `server/test/identity.test.ts`; e2e step 10 |
