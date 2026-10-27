# Milestone 3: acceptance

Where each exit check of [plan-m3.md](plan-m3.md)'s steps and each step of its acceptance script is checked: by an
automated test, in the browser walk, by a run on the Android emulator or by hand (recorded in
[decisions.md](decisions.md), M3, Measured, under the step), or not yet, and what it waits for. M1's checks are in
[acceptance.md](acceptance.md). State of 2026-10-27.

```sh
npm run typecheck && npm test        # 587 tests; opt-in: the Telegram test-DC suite, the email live suite (below)
npm run test:e2e                     # M1's and M3's acceptance scripts in browsers, axe on each M3 screen they open
tools/android/unit-test.sh           # the app's JVM tests: SMS events, MMS PDUs, previews (GRADLE_OFFLINE=1 offline)
node tools/android/axe.ts            # accessibility audit of the screen the emulator shows
node tools/backup/backup.ts check --with-connectors   # with the connector processes stopped (operator.md, Backups)
UCAP_EMAIL_TEST=1 npx vitest run --project connectors test/email-live.test.ts   # against the two Hetzner test mailboxes
npm run evals                        # the assistant against the dialogue model, K7's appointments and tasks among them
```

**Legend:** *test* = automated (file named); *e2e* = in the browser walk (`e2e/acceptance.spec.ts`, its step named);
*emulator* = run on the Android emulator, with the step it is recorded under; *by hand* = with the owner's own
account; *open* = not yet, with the reason.

**The browser walk** (`npm run test:e2e`, about twelve minutes, 30 steps): as in M1, a stack of its own with the
servers' clock moved where the script waits. Telegram, WhatsApp and email are played by `tools/dev/fake-services.ts`.
Clara's phone is simulated (`e2e/phone.ts`): UCAP its SMS app and Signal's previews, every report signed by its key.
The language model is scripted, so the walk checks what UCAP does with its answers, not the answers.

**What needs a real phone** (none is available, the owner, 2026-10-15) is listed at the end; WhatsApp ran against the
owner's own account by hand only, and nothing automated ever reaches it.

## K1 Messaging for many services

| Check | Where | State |
|---|---|---|
| Store, tool and protocol tests with two services | `server/test/messaging-services.test.ts` | test |
| Telegram's tests unchanged and green | `server/test/messaging.test.ts`, `connectors/test/connection.test.ts`, `mapping.test.ts` | test |
| The browser walk green | all steps | e2e |
| On the emulator, the messages screen with two services | Telegram and a Hetzner test mailbox (K3 on the emulator) | emulator |

## K2 WhatsApp

| Check | Where | State |
|---|---|---|
| Mapping tests on the recorded, stripped frames | `connectors/test/whatsapp-mapping.test.ts` (`fixtures/whatsapp-spike.json`) | test |
| The send states with the acknowledgement | `connectors/test/whatsapp-connection.test.ts` | test |
| Linked on its own page, the risk agreed to, the code said and shown | step 7b | e2e |
| With the stand-in: link, read, voice message, reply | K2 with the stand-in, on the emulator (2026-10-22) | emulator |
| With the owner's account: link, read, a voice message, one message to the owner's own chat | K2 by hand (2026-10-22) | by hand |
| Restored without its keys, it is linked again | `whatsapp-connection.test.ts` (K9); `backup.ts` with `--with-connectors` | test |

## K3 Email

| Check | Where | State |
|---|---|---|
| Parsing on `.eml` fixtures: multipart, HTML only, quoted replies, encodings, a bounce | `connectors/test/email-mail.test.ts` | test |
| The send and bounce states | `connectors/test/email-connection.test.ts`, `messaging-services.test.ts` | test |
| The two Hetzner mailboxes: one sends, the other receives over IDLE and replies, the thread kept | `email-live.test.ts` (2026-10-22) | test, opt-in |
| Connect, read, reply | K3 on the emulator (2026-10-22); step 7c | emulator, e2e |
| HTML made inert: scripts, frames, a page head, tracking pixels leave only words | `email-mail.test.ts` (K9) | test |

## K4 SMS: UCAP as the SMS app

| Check | Where | State |
|---|---|---|
| JVM tests: PDUs, threads, the outbox; MMS with sample PDUs | `SmsEventsTest`, `MmsPduTest` (`tools/android/unit-test.sh`) | test |
| The role, SMS both ways with their reports, the store, the way back with the history in Google Messages | K4 on the emulator (2026-10-22) | emulator |
| MMS through a stand-in MMS centre: text, pictures, a group | K4 on the emulator | emulator |
| A reply confirmed in the browser, sent by the phone, "Gesendet" at its report | step 7b | e2e |
| UCAP never deletes from Android's SMS store | `tools/test/sms-store.test.ts` (K9) | test |
| MMS from a carrier, RCS after the switch, a real SMS both ways, dual SIM | | open: no phone with a SIM |

## K5 Previews from other apps

| Check | Where | State |
|---|---|---|
| JVM tests: MessagingStyle, duplicates, the reply's confirmation, read only when all was heard | `PreviewLogicTest` | test |
| With a stand-in messenger: read, a reply confirmed, a stopped app's reply failed, the labels said and shown | K5 on the emulator (2026-10-26) | emulator |
| A crash in the listener's process leaves help working | K5 on the emulator | emulator |
| A preview said as one; a reply "Gesendet" only once the app shows it | step 8c | e2e |
| Real messengers, Android 15's hiding of codes, "Eingeschränkte Einstellungen zulassen" for an app from a file | | open: a real phone |

## K6 Contacts and calls

| Check | Where | State |
|---|---|---|
| The permission matrix with both new scopes | `server/test/people.test.ts`, `contacts.test.ts`, `agenda.test.ts` | test |
| Merging; recipients across services; the stranger warning on each service | `contacts.test.ts`, `messaging-services.test.ts`; steps 7e and 12 | test, e2e |
| Contacts by voice, numbers read back digit by digit, a call asked first | `server/test/contact-tools.test.ts` | test |
| Goldens for the spoken summary | `app/test/people.test.ts` (both new permissions, both forms of address) | test |
| Contacts by voice, one added by a helper, a call dialled | K6 part 3 on the emulator (2026-10-23); steps 7d, 7e | emulator, e2e |
| axe on the new pages | K6 on the emulator; steps 7d and 7e (K9) | emulator, e2e |

## K7 Calendar and tasks

| Check | Where | State |
|---|---|---|
| Schedules, time zones and summer time; reminders made and moved with their appointment; undo | `server/test/agenda.test.ts`, `packages/shared/test/schedule.test.ts` | test |
| The scope matrix; sources; what is private | `agenda.test.ts` | test |
| Goldens for readbacks | `packages/shared/test/agenda.test.ts` | test |
| The evaluations: appointments, tasks, things made from messages | `npm run evals`: 72 of 74 with qwen3.6 (2026-10-26) | test |
| §2's sentence end to end | K7 on the emulator (2026-10-26); step 7h | emulator, e2e |
| Maria adds a doctor's appointment and the tablet says so | step 7f | e2e |

## K8 LIVE across services

| Check | Where | State |
|---|---|---|
| Judgement tests with a scripted model | `server/test/live-news.test.ts`, `app/test/news.test.ts` | test |
| What came in said by itself with its service; codes named, never read; strangers' mail named; newsletters only when asked | step L2; K8 on the emulator, two runs (2026-10-26) | e2e, emulator |

## K9 Hardening

| Check | Where | State |
|---|---|---|
| Logs: Baileys, imapflow and nodemailer at their loudest write no content and no password | `connectors/test/log-canary.test.ts` | test |
| No message text in the servers' logs | `messaging.test.ts`, `messaging-services.test.ts`; ID-02 and L-02 in the walk | test, e2e |
| Retention: what each disconnect deletes, service by service | `messaging-services.test.ts`, `messaging.test.ts`; step 13 | test, e2e |
| Backups with the connectors' volumes; restored without them, WhatsApp is linked again | `backup.ts check --with-connectors` (2026-10-26); `whatsapp-connection.test.ts` | emulator stack, test |
| Email text inert; nothing handed to the page as HTML | `email-mail.test.ts`, `tools/test/inert-text.test.ts` | test |
| Limits: pairing codes, email tries and accounts | `messaging-services.test.ts` | test |
| Accessibility of the new screens | axe in steps 1, 7b–7h, 8b, L2 (14 screens, the person's and the helpers'); on the emulator in K5, K6, K8 and K9 (the SMS page, the contacts page with its disclosure, the appointment form) | e2e, emulator |
| What was deleted kept until the person removes it for good (item 20) | `server/test/deleted.test.ts`; step 15 | test, e2e |
| Through all messages, "Nächste" stops at the last one (decided item 12); the appointments and tasks screens too (item 22) | `app/test/messages-list.test.ts`, `app/test/agenda-screen.test.ts`; steps 8c and 8b | test, e2e |
| The rest marked read, in UCAP only, by voice and on the messages screen (decided item 13) | `messaging-services.test.ts`; step 8c; the phone's own SMS notifications cleared, its store unread, on the emulator | test, e2e, emulator |
| Play's disclosures | `docs/play.md`; the texts on the SMS, previews and contacts pages, shown on the emulator (K5, K9) | written; the Play Console with M9 |

## The owner's answers of 2026-10-27 (decisions.md, M3, To confirm 6, 8, 9, 11, 19)

| Check | Where | State |
|---|---|---|
| A reply to an email goes to its sender; "Allen antworten" (by voice, and an area on the messages screen) to everyone, the person's addresses never; C1 names them as the person knows them | `connectors/test/email-connection.test.ts`, `messaging-services.test.ts` (the area's dictated reply too); step 8d: the area and its hint, the reply to all by voice, sent from the right address | test, e2e |
| Senders per email account: added, changed, made the default and removed on the account's page; a reply goes out as the one the mail came to, a new mail as the default, or one the person names; C1 names it when there are several; mail from any of them is the person's own | `email-connection.test.ts`, `messaging-services.test.ts`; step 8d (axe on the page) | test, e2e |
| A mail that came back: "konnte nicht zugestellt werden und kam zurück", with its reason where the report gives one | `messaging-services.test.ts` | test |
| New messages announced with what they say (a short text word for word, a longer one by how it begins, an email by its subject, a photo with its caption, a preview as one, a code never); who alone where the device is set so | `messaging.test.ts`, `messaging-services.test.ts`, `packages/shared/test/config.test.ts`; steps 7–7e, 8c, 8d and 12 (axe on the settings) | test, e2e |
| A message announced whole and heard to its end is read, on its service and the phone too; how a long one begins is not (To confirm 23) | `messaging-services.test.ts` (which announcements say all); on the emulator (decisions.md, M3, Measured, 2026-10-27). The walk's browser cuts every utterance as stalled, so nothing counts as heard there | test, emulator |
| UCAP's SMS notification with the text, an MMS's text or photo; a code never; who alone where set so | `OneTimeCodeTest.java` against the server's cases; on the emulator (decisions.md, M3, Measured, 2026-10-27) | test, emulator |
| Someone in an app's notifications suggested for a contact whose name fits; "Ja" keeps them with it, named by it, no warning before a reply | `messaging-services.test.ts`; step 8d | test, e2e |

## The acceptance script (plan-m3.md)

| Step | What | State |
|---|---|---|
| 1 | The operator allows WhatsApp after the risk | step 1; on the dev stack (K2) |
| 2 | SMS: the role after the RCS note; Anna's SMS read; a reply, "Gesendet" at the network's report | K4 on the emulator; step 7b (the phone simulated). A real SIM: open |
| 3 | WhatsApp: the risk agreed to, the 8 characters said and shown, typed on the phone, 30 days arrive | step 7b with the stand-in; by hand with the owner's account (K2) |
| 4 | Email with an app password; Anna's mail announced, a newsletter not | step 7c and L2; K3 on the emulator with a test mailbox |
| 5 | "Lies meine neuen Nachrichten" across services; "Was hat Michael heute geschickt?" | steps 7b and 7i (Bernd: the stand-in's people); K8 on the emulator |
| 6 | §2's sentence in turns, C1 naming WhatsApp, the appointment from the voice message | step 7h; K7 on the emulator |
| 7 | An email reply with its subject; a mail to a wrong address comes back | step 7c; the reply in its thread with the two test mailboxes (`email-live.test.ts`); the bounce matched and told (C13) in `email-connection.test.ts` and `messaging-services.test.ts` |
| 8 | A Signal preview read; a reply confirmed once Signal shows it | steps 8c and 8d (simulated); K5 on the emulator with a stand-in messenger. Signal itself: open |
| 9 | Anna as one contact across services; Maria adds "Physiotherapie"; the call asked, then dialled | steps 7d and 7e; K6 on the emulator |
| 10 | Maria enters a doctor's appointment; its reminder; "Was muss ich heute noch erledigen?" | steps 7f, 8b and L2; K7 on the emulator |
| 11 | A note with its source; "Lies die Nachricht dazu" | step 7g |
| 12 | Strangers: "Maria (Tochter)" on WhatsApp, "Maria" by email from another address | step 12; `messaging-services.test.ts` |
| 13 | Disconnecting WhatsApp and email deletes UCAP's copies; the SMS role goes back with the history | step 13; K4 on the emulator (the history in Google Messages); the linked device gone on a real phone: K2 by hand |
| 14 | Help with every connector stopped and the SMS code crashed: help by touch and key, reminders | step 14 (the stand-in stopped; Maria accepts and resolves; an appointment's reminder at its time); K9 on the emulator (the dev stack's three connector processes stopped, ":sms" crashed: help by touch and by key sent and cancelled, an appointment's reminder at its time). A helper's phone ringing: M1's real-device checks |

## Open until a real phone

- **A phone with a SIM:** MMS from a carrier, RCS after the switch to UCAP and back, a real SMS both ways with the
  network's reports, dual SIM, the role dialog with TalkBack under real fingers.
- **Real messengers' notifications** as previews (Signal, Threema, WhatsApp's own), Android 15's hiding of codes in
  them, and "Eingeschränkte Einstellungen zulassen" for an app installed from a file.
- **WhatsApp's linked device gone from the phone** after disconnecting: Baileys' logout is tested with a fake socket;
  with the owner's account it is the owner's to try, by hand.
- M1's open items on real devices (acceptance.md) hold for M3's screens too.
