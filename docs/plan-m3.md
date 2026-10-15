# UCAP — Milestone 3: More connectors

The third milestone of [plan.md](plan.md)'s roadmap: CONCEPT §3, with §11's calendar and tasks, built on Milestones 1
and 2. Departures from this plan go into [decisions.md](decisions.md), as before.

## Context

CONCEPT §3, in the owner's words:

- "Communication integration is a central purpose of UCAP. Users should be able to participate in their existing
  conversations without needing to see, navigate, or precisely operate multiple messaging applications."
- "The intended services include WhatsApp, Telegram, email, and SMS. Instagram and Facebook Messenger remain possible
  additional integrations. Contacts and supported calling functions should also be accessible."
- "The platform should show what each connection actually supports. Access to notification previews must not be
  presented as access to a complete conversation history."
- "Where connected sources allow it, the user should not need to remember which application contains a conversation."
- "Before sending, the assistant should identify the recipient and communication service. It should report a confirmed
  send only after confirmation from the connected service."
- "A message can become a note, an agreed visit can become a calendar entry, and a request can become a task or
  reminder."
- "Personal communication must remain separate from care permissions."

§11: "A user should be able to extract an appointment from a conversation, add it to a calendar, and set a reminder
without separately operating several tools." §2's first example is the milestone's whole path: "Read my new messages,
tell me what Anna said in her voice message, help me answer her, and remind me about the appointment she mentioned."

The roadmap (plan.md): "WhatsApp through Baileys: a risk notice, and a pairing code instead of a QR scan. Email through
IMAP IDLE and SMTP. SMS through Android: Play allows SMS permissions mainly for the default SMS app, otherwise the
notification route. An Android notification-access connector, labelled as previews only. Unified contacts, calls
through the dialler, and conversations turned into notes, appointments and tasks."

M1 left room for it: one internal protocol for the connectors process (Appendix B), messages kept with sender,
service, time and conversation, honest sending (C1–C9), "capability descriptors per connection" (Appendix K). M2's
attention manager reads messages without knowing their service.

## Decisions (the owner, 2026-10-15)

| Topic | Decision |
|---|---|
| SMS | **UCAP becomes the SMS app** (Android's SMS role) on the phone with the person's SIM: it receives, keeps and sends SMS and MMS itself, in Android's own SMS store. This replaces the roadmap's "otherwise the notification route" for SMS; previews stay for other apps. RCS chats most likely stop while UCAP holds the role (measured in K0); giving it back to Google Messages is always one step away |
| Calendar and tasks | **In M3:** appointments and tasks as lists of their own, with screens and voice; a message becomes a note, an appointment, a task or a reminder, and keeps it as its source. Moved from M5's roadmap entry ("Calendar, tasks, shopping lists, alarms"), which keeps shopping lists, alarms and outside calendars |
| Email sign-in | **IMAP and SMTP with a password or an app password** (Gmail: an app password, with 2-step verification). Outlook.com and Microsoft 365 require OAuth2: not in M3, and the page says so |
| Contacts | **Unified contacts, which helpers may manage by a new permission:** "Kontakte verwalten" (`contacts.manage`), granted and withdrawn by the person |
| Appointments and tasks for helpers | **One new permission, "Termine und Aufgaben verwalten"** (`agenda.manage`): a helper sees, adds and changes the person's appointments and tasks, never messages or notes |
| WhatsApp in development | **The owner's own account, connected by hand**: there is no spare number, and nothing automated runs against it ("we might connect it, but not do automated testing on it"). Every automated test uses the stand-in |
| New third-party code | **Allowed**: the list at the end of this plan ("we need those") |

## What the research found (2026-10-15)

From npm, the libraries' repositories and docs, WhatsApp's terms, Google Play's policies, and Android's CDD and
behaviour changes.

- **WhatsApp:**
  - `baileys` 7.0.0-rc14 (2026-07-29) is MIT and ESM-only, but its `libsignal` is GPL-3.0. 7.0 is still a release
    candidate, and v8 will change the key store. A critical spoofing flaw (CVE-2026-48063) is fixed from rc12.
  - Pairing gives an 8-character code, typed in WhatsApp under Linked devices → "Link with phone number instead".
  - Baileys raises no event when WhatsApp's server accepts a message, only for errors and the recipient's receipts.
  - `markOnlineOnConnect` must be off, or the phone stops showing WhatsApp's notifications.
  - WhatsApp's terms forbid unofficial clients ("we may also modify, suspend, or terminate your access to or use of
    our Services anytime for suspicious or unlawful conduct"). Low-volume, reply-only accounts got warnings and bans
    in 2025 (whatsmeow #810, Baileys #1869).
- **Email:**
  - imapflow 2.4 (MIT) never reconnects by itself. mailparser 3.9 is MIT, nodemailer 10.1 MIT-0. imapflow and
    nodemailer were rewritten in September 2026 and release often.
  - Gmail accepts app passwords with 2-step verification. Outlook.com has needed OAuth2 since 16 September 2024;
    Microsoft 365 needs it for IMAP, and its SMTP passwords are off by default from the end of 2026.
  - A send is accepted at the server's 250 (RFC 5321), nothing more. Gmail copies sent mail into its Sent folder
    itself.
- **SMS and Play:**
  - Play gives SMS permissions only to the default SMS, phone or assistant app, or for listed exceptions; there is no
    exception for accessibility. Getting SMS data by "alternative methods" is forbidden.
  - The default SMS app must handle SMS and MMS and write Android's SMS store. Google Messages most likely needs the
    role for RCS (K0 measures it).
- **Android:**
  - Since Android 15, notifications holding one-time codes are redacted for listeners such as UCAP.
  - An app installed from a file must first be allowed "restricted settings" for notification access or the SMS role
    (Android 15 CDD).
  - From 27 January 2027, an app targeting API 37 needs a declaration for READ_CONTACTS; otherwise it uses the
    system's contact picker.
- **Instagram and Facebook Messenger** have no API for a personal account's messages: previews only.

## Principles

- **Every connection says what it can do** (Appendix K). A capability descriptor per connection says:
  - how much history it has: all of it, from a date, or previews only;
  - whom it can send to: anyone, or only into conversations that wrote;
  - what "gesendet" means for it;
  - whether it has voice messages, read states and groups.

  It is shown on the connection's page and said when asked ("Was kann WhatsApp hier?"). The assistant gets it too,
  and never answers from a history that is not there.
- **"Gesendet" only once the service said so.** Before that it is "Wird gesendet", slow (C5) or uncertain (C6).
  - Telegram: as in M1.
  - WhatsApp: WhatsApp's server acknowledged the message; the spike finds where Baileys shows it.
  - Email: the mail server accepted it (250). A bounce that comes later is matched to the message and told.
  - SMS: the network accepted it (Android's sent report). A delivery report, where the carrier sends one, is kept.
  - A reply through another app's notification: once that app shows it as the person's own message (measured in
    lookup).
- **One person, many services, no remembering where** (§3).
  - Reading, searching, "Was hat Michael heute geschickt?" and "Welche Unterhaltungen warten auf eine Antwort?" span
    every connection, and every item keeps its sender, service, time and conversation.
  - A reply goes back where the conversation is. A new message to a contact goes where they last wrote; when that is
    not clear, UCAP asks which service (§2: "a focused clarification rather than a guess").
- **Names come from the person's contacts, never from the sender.** A WhatsApp push name, an email's display name or
  a Telegram name ("Maria (Tochter)") is the sender's own claim. On every service, whoever is not in the person's
  contacts is named as such before anything is sent to them (Appendix E).
- **Personal communication stays the person's own** (§3).
  - The two new permissions give a helper the saved contacts, the appointments and the tasks. They never give
    messages, who wrote to the person, or the message an appointment came from.
  - The connector processes still hold no database credentials, and core imports none of their code.
- **Content is data, never instructions** (§2).
  - Emails, SMS and previews are untrusted data, as Telegram's messages are: the turn is tainted and actions ask first.
  - An email's HTML is never rendered and its remote content never fetched; attachments are never opened by
    themselves.
- **No content in logs.** At their debug levels Baileys, imapflow and nodemailer log content and credentials, so
  their loggers are off and the log canary (AS-11) covers them. The phone's SMS and notification code logs counts and
  codes only.
- **The help path stays as it is.** The new connectors run outside core. On the phone, the SMS and notification code
  runs in a process of its own where Android allows, so a crash there never takes the app's help with it (K0 checks).

## Architecture

```
 Person's phone (holds the SIM)                              Server
  UCAP, the SMS app (SMS role): SMS and MMS in, the            assistant
   SMS store, sending, delivery reports ──signed──►            messaging: one store for every service,
  previews: the notification listener (chosen apps),            capabilities, sending, tools, LIVE news
   replies through it ───────────────────signed──►              connector hub ◄─WS─ connectors (TDLib: Telegram)
  ◄── "send this": realtime, or a push that wakes it ──                     ◄─WS─ whatsapp (Baileys, own volume)
  calls: ACTION_CALL where allowed, else the dialler                        ◄─WS─ email (imapflow, nodemailer)
                                                              core (no AI, no messaging code)
 Helpers' devices (browser, app)                               contacts, calendar, tasks: with their scopes;
  contacts.manage, agenda.manage ─────────────────────────►    an appointment's reminder is an M1 reminder
```

- **A connector process per service:** Telegram stays in `connectors`; WhatsApp and email get processes of their own.
  - Each dials the assistant with the connectors token and names its service. The hub keeps one per service: a crash
    or a restart of one never ends another.
  - WhatsApp's GPL-3.0 code stays in a process and package of its own.
- **Device connections** (SMS, previews) run on the person's phone. Native code forwards what came in with the
  device's key (as care commands are signed), through the native outbox, so it works with the app closed.
  - A send confirmed on any of the person's devices reaches the phone in the realtime channel, or as a push that
    carries only its id (as an alarm's note is fetched when it is opened).
  - The phone fetches the text, sends it and reports each state.
- **Contacts, the calendar and tasks live in core's domain,** next to notes and reminders. An appointment rings with
  the assistant stopped, as reminders do. The assistant's tools use them as they use notes and reminders.

## Data

- **`messaging_connections`:**
  - `service` adds `whatsapp`, `email`, `sms` and `notifications`.
  - `device_id`: the phone that runs SMS and previews.
  - `account`: an address or a number, so a person can connect several email accounts.
  - `capabilities` (Appendix K).
  - `secret_sealed`, in place of `db_key_sealed`: TDLib's key, WhatsApp's store key, an email password.
  - `app`: for previews, the app's package and name.
- **Conversations and messages:** a `subject` (email threads); an email's quoted part kept apart from what is new;
  delivery and read states where the service has them; a mark for one-time codes.
- **`messaging_participants`:** an `address` (a number in E.164, an email address), to find the contact.
- **`contacts`** and **`contact_handles`:**
  - A contact holds a name (the person's own), phone numbers, email addresses, and its handles on Telegram and
    WhatsApp.
  - It has versions for undo, and `created_by`.
- **`appointments`:**
  - title, day and time (or all day) in the person's time zone, duration, place and note;
  - once or weekly on chosen days;
  - reminders before it, `private`, `source`, `created_by`;
  - versions for undo.
- **`tasks`:** title, note, a due day, done or open, `private`, `source`, `created_by`, versions.
- **`notes` and `reminders`** get a `source`: the message they came from (service, sender, time, its id). Reminders
  also get `appointment_id`.
- **Grants:** the scopes `contacts.manage` and `agenda.manage`.

## Steps

Each step ends green: typecheck, tests, its check on the emulator (and in the browser where it applies), a commit.

| Step | Deliverables | Exit |
|---|---|---|
| **K0 Spikes** | **A, WhatsApp:** Baileys rc14 in its own container, with the owner's own account, by hand and at human pace; nothing automated runs against it. Seen: the pairing code; the history WhatsApp sends at linking (how many chats, how far back, how long); WhatsApp's server acknowledgement (the raw ack frames) for a message to the owner's own chat; a voice message; a restart with the stored keys, and the key store's size; a link that lasts a day with `markOnlineOnConnect` off. The frames are recorded for tests and stripped of every text, name and number before they enter the repository. **B, email:** imapflow and nodemailer against the two Hetzner test mailboxes. Measure: IDLE (how fast new mail arrives); a dropped connection and the new client after it; UIDVALIDITY and CONDSTORE (read states both ways); a send (250); the Sent folder; threading headers; a bounce. Also mailparser and HTML to text on real newsletters (quotes, signatures). **C, the SMS role on the emulator:** Android's role dialog, with and without TalkBack; what the role grants (contacts?); SMS in (`adb emu sms send`) and out (to the emulator's own number, or to a second emulator when memory allows), with the sent report and the delivery report where the emulator gives one; writing the SMS store; giving the role back, with the history in Google Messages. The emulator is shared with the owner: the role goes back to Google Messages after every run. **D, previews in UCAP's app:** lookup's measurements again in the product, with a stand-in messenger that posts its notifications as messengers do; Android 16's redaction of codes; a crash in the listener's process leaves help working. Reported in `docs/spikes/m3.md` | measured numbers and a choice for each; the hook that tells WhatsApp's acknowledgement; what only a real phone can show, listed as open |
| **K1 Messaging for many services** | **Connections:** a service per connection, several per person where that makes sense (email accounts; SMS and previews per phone), the capability descriptor, secrets sealed per connection. **Protocol:** `start` per service with its own secrets; the hub with one process per service; the device path (signed forwards, sends to the phone, its receipts). **Speech:** frames with the service ("… auf WhatsApp", "… per E-Mail", "… per SMS", "Vorschau von Signal: …"); C1 per service (an email's subject read back). **Screens and tools:** the messages screen, overview and search across services; the assistant's tools with the service ("auf WhatsApp", "per SMS"). **Settings:** Einstellungen → Nachrichtendienste, a page per service; on the admin page, Telegram's credentials and WhatsApp allowed or not. **Stand-ins:** `tools/dev/fake-telegram.ts` becomes a stand-in for every server service, and `e2e/phone.ts` gains a simulated phone that forwards SMS. Telegram itself is unchanged | store, tool and protocol tests with two services; Telegram's tests unchanged and green; the browser walk green; on the emulator, the messages screen with two services |
| **K2 WhatsApp** | **Process:** Baileys, pinned exactly, in its own process; its key store sealed per connection on its own volume. **Allowing and linking:** the operator allows WhatsApp on the admin page; before linking, the person hears the risk in plain words and agrees. Linking by pairing code: the person's number, then the 8 characters said one by one and shown large, and where to type them in WhatsApp. **Content:** 30 days of history, as with Telegram; text, voice messages (fetched and transcribed as Telegram's), photos, documents, stickers, groups and their names; LIDs. Names come from the person's saved contacts, never push names. **Sending:** pending until WhatsApp's server acknowledged it (then C3); delivered and read states kept; marked read only after the person heard the original. Human pace: no bulk, no status, no presence, `markOnlineOnConnect` off. **Disconnecting** unlinks the device and deletes UCAP's copies | mapping tests on the recorded, stripped frames; the send states with the acknowledgement; on the emulator with the stand-in: link, read, voice message, reply; once by hand with the owner's account: link, read, a voice message, one message to the owner's own chat |
| **K3 Email** | **Process:** imapflow (IDLE; a new client after every drop; CONDSTORE), mailparser and nodemailer in their own process. **Connecting:** address and password or app password, with servers filled in for known providers (GMX, web.de, T-Online, Posteo, mailbox.org, iCloud, Gmail, Hetzner) and typed for others; Outlook and Microsoft 365 named as not possible yet. The password is sealed and goes out only in `start`. **Mail kept:** the inbox and the Sent folder, 30 days at connecting. Conversations are threads (Message-ID, References) with their subject. **Text:** plain text, or HTML turned into text (never rendered, nothing fetched). The new part, the quoted part ("Darunter zitiert: …") and the signature are kept apart. **Never announced by itself:** mail from lists and newsletters (List-Id, List-Unsubscribe, Precedence), shown as muted chats are. **Warnings and attachments:** a sender whose domain failed DMARC (the provider's Authentication-Results) is named as unconfirmed; attachments are named by name and kind. **Sending:** a reply carries In-Reply-To, References and the same subject; a new mail gets a subject (proposed by the model, read back in C1). "Gesendet" at the server's 250; a copy in the Sent folder (Gmail makes its own); a bounce is matched and told. **Read state:** marked read on the server (\Seen) once heard | parsing tests on `.eml` fixtures (multipart, HTML only, quoted replies, encodings, a bounce); the send and bounce states; an opt-in suite with the two Hetzner mailboxes (`UCAP_EMAIL_TEST=1`: one sends, the other receives over IDLE and replies, the thread kept); on the emulator: connect, read, reply |
| **K4 SMS: UCAP as the SMS app** | **Taking and giving back the role:** Android's dialog; before it, the setup explains RCS and asks to switch off Google Messages' chat features. The way back is always in Einstellungen → SMS ("Google Messages wieder als SMS-App"). **The role's parts:** SMS in, and MMS in (WAP push and the MMS download); the compose screen other apps open (`smsto:`); quick replies to a call (RESPOND_VIA_MESSAGE). Everything is written to Android's SMS store, so the history stays when the role goes back. **On the phone:** UCAP's own notifications for new SMS (its earcon, the person's settings); blocked numbers respected; long SMS in parts. **Sending:** an SMS confirmed on any of the person's devices is sent by the phone. "Gesendet" at the network's sent report; delivery reports kept. **MMS:** text, pictures and group MMS received in full; an MMS that could not be fetched is told and fetched again. Replying into a group MMS is said as not possible yet, until it can be checked on a real phone. **History:** 30 days at the start, then everything new. Dual SIM: the SIM Android uses for SMS | JVM tests (PDUs, threads, the outbox; MMS with sample PDUs); on the emulator: the role, SMS both ways with their reports, the store, and the way back with the history in Google Messages. Open until a real phone with a SIM is available: MMS from a carrier, RCS after the switch, a real SMS both ways |
| **K5 Previews from other apps** | **Choosing and allowing:** the notification listener runs in a process of its own. The person chooses the apps: Signal, Threema, Instagram, Facebook Messenger, and WhatsApp's own notifications for people without the Baileys link. First UCAP's own disclosure (Play's "prominent disclosure"), then Android's page, and "Eingeschränkte Einstellungen zulassen" for an app installed from a file. UCAP explains each step and checks the result itself. **Reading:** conversation notifications (MessagingStyle): sender, time, text; each message kept once, although it comes many times. A conversation is known by its notification, never by its content. **Replying:** through the notification's reply action. "Gesendet" once the app shows the reply as the person's own message; failed when the app was stopped. Marked read through its mark-as-read action, once heard. **Labels:** everywhere "Vorschau" ("Von Signal kenne ich nur, was seine Benachrichtigungen zeigen."). Codes Android redacts stay redacted | JVM tests (MessagingStyle, duplicates, the reply's confirmation); on the emulator, with a stand-in messenger: read, a reply confirmed, a stopped app's reply failed; the labels said and shown; a crash in the listener leaves help working |
| **K6 Contacts and calls** | **Contacts (core):** a name of the person's own, phone numbers (E.164), email addresses, and the handles on Telegram and WhatsApp. **Merging:** the same number or address merges by itself; other matches are suggested to the person ("Anna Beispiel auf Telegram und Anna auf WhatsApp: dieselbe Person?"), never merged by name alone. **The phone's address book:** imported where the person allows (through the SMS role if it grants contacts, otherwise the system's contact picker). **Names everywhere:** in every frame and for recipients; "nicht in deinen Kontakten" for anyone else, on every service. **By voice and on screens:** "Speichere diese Nummer als Anna", with numbers read back digit by digit; "Wie ist Annas Nummer?"; areas, and a page for screen readers. **"Kontakte verwalten" (`contacts.manage`):** proposed and approved like the other permissions, and named in the spoken summary and the access overview. The helper's page lists, adds, renames and deletes saved contacts, never suggestions drawn from conversations. Each change is audited, said on the device and kept in the history ("Maria hat den Kontakt „Physiotherapie“ hinzugefügt."). **Calls:** "Ruf Anna an": which number, when she has several; asked first ("Anna anrufen, Handy?"). Then dialled directly where the person allowed calls (the phone fallback's setting), or in the dialler otherwise. A device that cannot make calls says so; WhatsApp and Telegram calls are named as not possible | the permission matrix with both new scopes; merging; recipients across services; the stranger warning on each service; goldens for the spoken summary; on the emulator: contacts by voice, one added by a helper in Chrome, a call dialled; axe on the new pages |
| **K7 Calendar and tasks** | **In core, without AI:** appointments (once or weekly, reminders before them, a place) and tasks (a due day, open or done). An appointment's reminders are M1's reminders: the device's alarm, offline, the answers ("Hilfe holen" included). Versions with undo. Everything read back from what was stored ("Termin gespeichert: Dienstag, 20. Oktober, 10 Uhr: Zahnarzt. Ich erinnere dich eine Stunde vorher."). **By voice:** "Was steht morgen an?", "Trag … ein", "Verschieb den Zahnarzt auf 11 Uhr", "Was muss ich noch erledigen?", "Erledigt: Rezept abholen". **Screens:** "Termine" and "Aufgaben" in areas (Nächster, Wiederholen, Erledigt, Zurück, Hilfe), and pages for screen readers; the device editor offers them as areas for the home screen. **From conversations** (§3, §11), each with its source: "Speichere das als Notiz", "Trag den Besuch ein, den Anna vorgeschlagen hat" (the day and time read back as parsed, asked first because the turn read a message), "Setz das auf meine Liste", "Erinnere mich daran". "Lies die Nachricht dazu" reads the original while it is still kept, and says so when it is not. **"Termine und Aufgaben verwalten" (`agenda.manage`):** the helper's pages for the person's appointments and tasks. A source shows as "aus einer Nachricht", never the message; what the person marks private is not shown. Audited, said on the device, in the history | schedules, time zones and summer time; reminders made and moved with their appointment; undo; the scope matrix; sources; goldens for readbacks; the evaluations extended (appointments, tasks, things made from messages); on the emulator, §2's sentence end to end; in Chrome, Maria adds a doctor's appointment and the tablet says so |
| **K8 LIVE across services** | **Messages and SMS:** what came in on any service is said as M2 says Telegram's ("Anna schrieb auf WhatsApp: „…“"), naming the service when the person has more than one. **Emails:** from contacts, summed up with their subject. Lists and newsletters are never said by themselves, only counted when asked. One-time codes are never said by themselves. **Previews and the calendar:** previews are labelled; appointments are said at their reminder, tasks due today when asked. **Settings and asking:** what LIVE says by itself, per service; "Was gibt's Neues?" covers everything | judgement tests with a scripted model; on the emulator with the stand-ins |
| **K9 Hardening and acceptance** | **Logs:** the canary with Baileys, imapflow and nodemailer at their loudest levels (no content, no password in any log). **Retention:** what each disconnect deletes; Android's SMS store is the person's and UCAP never deletes from it. **Backups:** `--with-connectors` for WhatsApp's keys; restored without them, WhatsApp is linked again. **Security and accessibility:** email text rendered inert; limits; accessibility audits of the new screens. **Play:** the disclosures written (the SMS role, notification access, contacts). **Tests and docs:** the browser walk extended (WhatsApp, email and SMS stand-ins, contacts, calendar, a helper with both new permissions). operator.md covers WhatsApp's risk and switch, email providers and app passwords; helper-onboarding.md the two new permissions; plus an M3 acceptance file | the acceptance script below, on the emulator and in Chrome; what needs a real phone listed as open in the M3 acceptance file |

## Acceptance script (M3)

Clara's phone is the emulator. WhatsApp runs against the stand-in in the browser walk, and once by hand with the
owner's own account. What needs a real phone with a SIM (MMS from a carrier, RCS) stays open until one is available.

1. **The operator** allows WhatsApp on the admin page after reading the risk. Telegram is set up as in M1.
2. **SMS:**
   - On her phone, Clara makes UCAP her SMS app, after the note on RCS.
   - Anna's SMS is announced and read ("Anna schrieb per SMS: …").
   - "Antworte, dass ich später anrufe": C1 names SMS, and "Gesendet" comes at the network's report.
3. **WhatsApp:**
   - Clara hears the risk and agrees, gives her number, and hears and sees the 8 characters.
   - She types them in WhatsApp on her phone: "Verbunden", and 30 days of history arrive.
4. **Email:** Clara connects her email with an app password. Anna's mail is announced; a newsletter is not.
5. **Across services:**
   - "Lies meine neuen Nachrichten": WhatsApp, Telegram, email and SMS together, each with its service.
   - "Was hat Michael heute geschickt?": from wherever he wrote.
6. **§2's sentence**, in turns:
   - "Lies meine neuen Nachrichten." "Was hat Anna in ihrer Sprachnachricht gesagt?" "Antworte ihr, dass Samstag
     passt."
   - C1 names WhatsApp; after "Ja", "Gesendet" comes at WhatsApp's acknowledgement.
   - "Erinnere mich an den Termin, den sie erwähnt hat": the appointment and its reminder are read back, with the
     voice message as their source.
7. **An email reply** with "per E-Mail": the subject is read back, "Gesendet" comes at the server's acceptance, and the
   reply sits in the thread. A mail to a wrong address comes back, and Clara is told.
8. **Previews:** a Signal message is read as "Vorschau von Signal: …"; a reply is confirmed once Signal shows it.
9. **Contacts and a call:**
   - "Anna" is one contact, with her number, WhatsApp, Telegram and email.
   - Maria, who may manage contacts, adds "Physiotherapie" from her phone, and Clara's tablet says so.
   - "Ruf die Physiotherapie an": asked, then dialled.
10. **Calendar and tasks:**
    - Maria, who may manage appointments and tasks, enters a doctor's appointment, and the tablet says so.
    - At its reminder, LIVE says it.
    - "Was muss ich heute noch erledigen?" lists the tasks.
11. **A note with its source:**
    - "Speichere das als Notiz" after Anna's message: the note names where it came from.
    - "Lies die Nachricht dazu" reads the original.
12. **Strangers:** before C1, UCAP says that neither is in Clara's contacts:
    - someone on WhatsApp calling themselves "Maria (Tochter)";
    - a mail from "Maria" at another address.
13. **Disconnecting:**
    - Disconnecting WhatsApp and email deletes UCAP's copies, and the linked device is gone from WhatsApp on the phone.
    - The SMS role goes back to Google Messages, with the history there.
14. **Help needs none of it:** with every connector process stopped and the phone's SMS code crashed on purpose, help
    by touch and key, reminders and appointment reminders still work.

## Risks and open points

- **WhatsApp may ban the person's number.** Its terms forbid unofficial clients, and low-volume accounts were warned
  and banned in 2025.
  - It is opt-in for the operator and for the person, after the risk is said in plain words, and it runs at human
    pace.
  - In development the only account is the owner's own. It is connected by hand, its test messages go to the owner's
    own chat, and nothing automated ever runs against it.
  - People who decline it still get WhatsApp's notifications as previews (K5).
- **Baileys is unstable ground:**
  - 7.0 is a release candidate, and v8 will change the key store (a migration).
  - When WhatsApp Web's version moves, connections fail with 405 errors until Baileys is updated.
  - So it is pinned exactly and runs in its own process and volume, and operator.md gets an update path.
- **Licence.** Baileys is MIT, but its `libsignal` is GPL-3.0. Running it is fine; distributing images with it touches
  the repository's licence, which is still open (plan.md). Its own process and package keep the boundary clear until
  the owner decides.
- **The SMS role:**
  - RCS chats most likely stop while UCAP is the SMS app.
  - Play allows SMS permissions to the default SMS app, with a declaration and a video of the core use.
  - An app installed from a file needs "Eingeschränkte Einstellungen zulassen" first.
  - Changing the SMS app is Android's own dialog, which a helper may need to do with the person.
  - **No real phone yet** (the owner has none). The emulator has no carrier, so MMS from a carrier and what happens to
    RCS stay unchecked. As the SMS app, UCAP holds every message the person receives, and a lost MMS is a lost
    message. So UCAP is offered as the SMS app on real people's phones only after a real phone with a SIM has passed
    K4's open checks.
- **Notification access:**
  - It is switched on in Android's own settings page, after "Eingeschränkte Einstellungen zulassen" for an app
    installed from a file. Both are technical prompts the person may need help with.
  - One-time codes are redacted since Android 15.
  - A conversation open in its own app posts nothing (measured in lookup).
- **Contacts and Play:** from 27 January 2027, targeting API 37 needs a declaration for READ_CONTACTS, unless the
  system's contact picker suffices.
- **Email:**
  - Outlook.com and Microsoft 365 need OAuth2: a later step, if wanted.
  - Providers' servers and limits differ, hence the presets.
  - imapflow and nodemailer change often, so they are pinned.
- **"Wer hat angerufen?"** needs the call log, which Play gives to the phone app (and the assistant role), not to the
  SMS app. It fits with UCAP as the phone app beside kiosk mode (M4), not M3.
- **Describing a photo** (§3: "Images should be describable") needs a vision model. It comes with M5's camera
  assistance; until then a photo is named as a photo, with its caption.
- **The Mac's memory:** M3 adds no model. Email summaries and LIVE's judgements use the dialogue model already loaded.
- **Android 17 (API 37)** adds a permission for reaching a server on the local network. It matters for the app's
  target, not for M3.

## New third-party code (allowed by the owner, 2026-10-15)

| What | Licence | For |
|---|---|---|
| `baileys` 7.0.0-rc14, exact, with its `libsignal` (GPL-3.0) and `whatsapp-rust-bridge` (MIT, WebAssembly); `sharp` only if Baileys cannot run without it (K0) | MIT | WhatsApp |
| `imapflow`, exact | MIT | email: IMAP IDLE |
| `mailparser` (with its HTML-to-text step) | MIT | email: parsing |
| `nodemailer`, exact | MIT-0 | email: SMTP |
| `libphonenumber-js` | MIT | numbers in E.164 (contacts, SMS) |
| AOSP's MMS PDU code, vendored into the app | Apache 2.0 | MMS |
| a local IMAP and SMTP server image for tests, chosen in K0 | open source | tests |

## Needs the owner

- **The owner's WhatsApp**, connected by hand for K0 and K2 only, at human pace, with test messages to the owner's
  own chat. It is never used by an automated test; there is no spare number.
- **The two Hetzner test mailboxes:** already in `.secrets`; nothing to do.
- **No Android phone is available** (the owner, 2026-10-15). What needs one stays open, as M1's real-device checks do,
  until a tester's phone or M9's closed test: MMS from a carrier, RCS after the switch, a real SMS, the role dialog
  with TalkBack under real fingers, and WhatsApp's own notifications as previews.
