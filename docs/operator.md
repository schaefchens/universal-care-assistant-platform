# Running a UCAP server

For whoever runs UCAP for a person, a household or a care organisation. The plan behind it is
[docs/plan.md](plan.md); what departs from it is in [docs/decisions.md](decisions.md).

## What runs where

| Part | What it does | Where |
|---|---|---|
| **core** | identity and devices, people and permissions, help requests and their alarms, reminders, notes, device configurations | Docker |
| **assistant** | voice turns, language models, speech, the person's messages, AI administration, herde | Docker |
| **connectors** | TDLib for Telegram; no database credentials, talks only to the assistant | Docker |
| **whatsapp** | Baileys for WhatsApp, the same way: no database credentials; each person's keys sealed on its own volume `ucap-whatsapp` | Docker |
| **email** | imapflow and nodemailer for email accounts, the same way; it keeps UIDs and Message-IDs on its volume `ucap-email`, the passwords only in memory | Docker |
| **db** | Postgres 17 | Docker, named volume `pgdata` |
| **ntfy** | the push server Android devices listen to (UnifiedPush) | Docker |
| **caddy** | the one address everything uses | Docker |
| **Ollama, stt-mlx, herde** | the language model, speech recognition, speech output | natively on a Mac (Docker cannot use its GPU); on Linux with a GPU they may run in Docker |

**Help depends on nothing optional.** core imports no AI, speech or messaging code (a test checks it). With the
assistant, the connectors, Ollama and speech recognition all stopped, help by touch and by the help key, reminders
and the helpers' alarms keep working; voice says that voice input is not available and points to the help area.

## Setting up

Requirements: Docker, Node 24 or newer, and for the Mac's engines Ollama and Python 3.12 (`services/stt-mlx`).

```sh
npm run setup                  # once: the server's secrets, outside the repository
npm install
docker compose up -d --wait
npm run admin:invite           # the first administrator: an invitation valid for one hour, shown once
```

Further accounts are invited by an administrator in the app (Server und Konten), or with
`docker compose exec core node server/src/cli.ts account-invite` (an ordinary account, valid for a day).

- **The secrets** (`~/.config/ucap/dev-secrets`, or `UCAP_SECRETS_DIR`): `master_key` seals every stored credential
  (provider keys, Telegram's credentials and TDLib's keys, the push keys), `pepper` keys every code and token,
  `connectors_token` lets the connectors process in, `ntfy_token` lets core publish alarms. They are made once and never
  again: a new master key makes everything sealed unreadable, a new pepper ends every session and invitation. Keep a
  copy apart from the server (see Backups).
- **The address** apps use: `UCAP_PUBLIC_URL` (production: a domain, Caddy gets the certificate). Phones on the same
  network can use `tailscale serve`; the emulator and USB phones `adb reverse`.
- **The first administrator** opens the invitation in the app ("Ich habe eine Einladung") on their own device. Admin
  rights give no access to anyone's data: administrators manage the server, providers and accounts.
- **Browsers** (the helpers' and administrators' pages, and a basic experience for the person): in development Vite
  serves the app (`cd app && npx vite`, port 8812, the API passed on to the stack). Serving the built app (`app/dist`)
  from the server's own address is part of the release work; serve it unchanged: its index.html carries the app's
  security policy (scripts only from the app, Trusted Types), and a host may add `frame-ancestors 'none'` as a header,
  which a policy inside the page cannot set.

## Administration in the app

Settings → **Server und Konten**: whether the database and the notices to devices run, how many helper devices can be
reached for help requests, overdue and failed jobs, storage, whether the language model, speech recognition and the
messaging service answer; the accounts by name and devices; invitations for new accounts (shown once).

Settings → **KI und Stimmen verwalten**: speech and language-model providers with their keys (written, never shown
again), what each may receive (data classes), prices and monthly caps, this month's usage, herde invitations and
workers, and Telegram's credentials.

### Providers and privacy

A provider is the operator's own (on this server or the operator's machines) or external (OpenAI, Anthropic,
ElevenLabs, a herde worker lent by someone else). Personal data goes to an external provider only when its row allows
that class (personal, communication, health, voice) **and** the person agreed when choosing it. An external provider
never stands in silently for an own one that fails: then the person is told it is not available. Ollama from
`OLLAMA_URL` and speech recognition from `STT_URL` are set up as providers at the first start.

### Telegram

At [my.telegram.org](https://my.telegram.org) → "API development tools", create an application; enter its `api_id`
and `api_hash` under KI und Stimmen verwalten → Telegram. Each person then connects their own account on their own
device (Settings → Telegram): phone number and code, or a QR code scanned with Telegram on another device. Helpers get
no access to anyone's messages. Restart the connectors process by hand after an update
(`docker compose restart connectors`): TDLib holds its databases open.

### WhatsApp

WhatsApp allows no programs of others: UCAP links itself to a person's WhatsApp as a further device, the way WhatsApp
Web does, through Baileys, and **Meta may block that person's number for it**, even when they write little (it
happened to low-volume accounts in 2025). So it is off until an administrator allows it, under KI und Stimmen
verwalten → WhatsApp, after reading the risk; each person hears the risk again and agrees before they link
(Settings → Nachrichtendienste → WhatsApp). They give their number and type the 8 characters UCAP shows and says into
WhatsApp on their phone (Linked devices → "Link with phone number instead"); a code lives about three and a half
minutes. On the phone UCAP is listed as "Chrome (Mac OS)": with a name of its own WhatsApp refused the code.

UCAP keeps WhatsApp at a person's pace: never shown online, no statuses, no link previews fetched, sends one at a
time. "Gesendet" comes when WhatsApp's server acknowledged the message.

- **Updates:** Baileys is pinned exactly (`connectors/package.json`). When WhatsApp moves on, connections fail (a 405,
  or "Verbindung hat nicht geklappt" for everyone) until Baileys is updated: update it, run the tests, then
  `docker compose restart whatsapp`. The process fetches WhatsApp Web's current version once a day by itself.
- **Restarts** are by hand (`docker compose restart whatsapp`), never on every change: each one is a new connection.
- **Disconnecting** (by the person) removes UCAP from their linked devices and deletes its keys and copies; a person
  who unlinks it on the phone is shown "Neu verbinden".

### Email

Each person connects their own accounts on their own device (Settings → Nachrichtendienste → E-Mail verbinden), as
many as they have: the address and the password, with the servers filled in for GMX, WEB.DE, Telekom, Posteo,
mailbox.org, iCloud and Gmail by the address, chosen for Hetzner (domains of one's own), or typed. Nothing to set up
on the admin page.

- **Passwords:** Gmail and iCloud take an app password only (with two-step sign-in), Telekom an email password of its
  own; GMX and WEB.DE take the account's password once IMAP is switched on in their settings. The page says so, and the
  first connection checks the account, sending included, and says what went wrong.
- **Not yet:** Outlook.com, Hotmail and Microsoft 365, which need a sign-in at Microsoft (OAuth2).
- **What UCAP does with a mailbox:** reads the inbox (in IDLE, a new mail within about a second) and the Sent folder
  (every ten minutes), 30 days back from connecting; marks a mail read once the person heard it; puts a copy of each
  reply in the Sent folder (Gmail files its own). It never deletes or moves mail. "Gesendet" means the mail server
  accepted it; a mail that comes back is told to the person.
- **Only servers on the internet:** a server name that leads to this machine's network or the LAN is refused.
- **Restarts** are by hand after an update (`docker compose restart email`); imapflow and nodemailer are pinned.
- **The test mailboxes:** `UCAP_EMAIL_TEST=1 npx vitest run --project connectors test/email-live.test.ts` runs the
  connector against the two Hetzner mailboxes in `.secrets` (a mail one way, a reply and its answer back) and deletes
  what it sent.

### SMS

UCAP can become the SMS app of the person's phone (Settings → Nachrichtendienste → UCAP als SMS-App, on that phone):
it then receives and sends their SMS itself, and Android keeps them in its own store, where Google Messages finds them
again. Nothing to set up on the server.

- **Before:** the page asks to switch off Google Messages' chat features (RCS): chats sent there may stop arriving
  while UCAP is the SMS app. Android's own dialog takes two choices (the current app is preselected), which a helper
  may need to do with the person. An app installed from a file needs "Eingeschränkte Einstellungen zulassen" first
  (the app's info page, menu).
- **The way back** is on the same page: Android's Default apps page, SMS app. Android then ends UCAP's processes; the
  server is told, and replies that waited for the phone are not sent (kept as drafts).
- **Sending** a reply confirmed on another device needs the phone: it is woken by a push (the ntfy app as its
  UnifiedPush distributor), else it looks every 15 minutes, or at once when UCAP is opened there.
- **MMS** come in whole (text, pictures, groups) from the carrier's MMS centre, over mobile data, as with any SMS app.
  One that cannot be loaded is told, and fetched again until it expires there. A group shows everyone but the person
  when the SIM carries the phone's own number; where it does not, that number is among the members.
- **Another app's "write an SMS"** (a contact's message button, an `sms:` link) opens UCAP's screen for that number;
  the SMS is dictated and sent after the person's yes. **A quick reply to a call** is sent by Android's dialler itself
  and appears in UCAP within seconds.
- **Not yet:** sending MMS, a new SMS to a number by voice (with K6's contacts), and what only a real phone with a SIM
  shows (RCS after the switch, a carrier's MMS centre and reports, dual SIM).

### herde

KI und Stimmen verwalten → herde → invitation: the page shows `herde join <address> <code>`. On the machine that runs
herde, back up `~/.config/herde/config.toml`, run the join, and restart herde. Plain HTTP is accepted for localhost.

## Help requests and alarms

- Helpers' Android phones and the person's devices need the **ntfy** app as their UnifiedPush distributor (F-Droid or
  Play), then UCAP's alarm checklist (Settings) and "Test-Alarm senden". Android Chrome alone is not reliable for alarms
  in Doze (measured); desktop browsers get Web Push.
- ntfy accepts publishing from UCAP only (its token); devices subscribe to their own topics.
- A heartbeat every six hours checks each helper device; when none can be reached, the person is told.
- **A push soak** times a phone's alarms over days, as the phone lies idle (Doze, the maker's battery manager): a
  silent heartbeat every 15 minutes for 48 hours, each timed to the phone's signed receipt. The device id is in the
  `devices` table (or ask an administrator).

  ```sh
  npm run push:soak -- <device id> [--every <minutes>] [--hours <hours>]
  npm run push:soak-report -- <device id> [--hours <hours>]   # sent, confirmed, lost; median and 95 % receipt times
  ```

## Backups

```sh
npm run backup -- <dir>                     # the database (pg_dump) and the files volume, with a manifest
npm run backup -- <dir> --with-secrets      # also the secrets: a backup that opens everything, keep it safe
npm run backup:check                        # backup, restore into a scratch database, compare every table
node tools/backup/backup.ts restore <dir> --into <new database> [--files]
```

A restore goes into a new database, never over the live one; point `DATABASE_URL` at it once checked. Without the
master key the sealed values cannot be opened after a restore; the secrets never change, so one safe copy is enough.
Add `--with-tdlib` with the connectors stopped to keep the Telegram sessions. WhatsApp's keys (the volume
`ucap-whatsapp`) are not in a backup yet (docs/plan-m3.md, K9): restored without them, each person links WhatsApp again.
The email volume (`ucap-email`) needs none: without it, the email process fetches each account's 30 days again.

## What is kept, and for how long

- Voice turns: the audio only for recognition; the words are not stored; a turn's timings and outcome 30 days.
- A conversation's last exchanges (for follow-up questions) 30 minutes; what an assistant action held, a day after it
  ended; actions 30 days.
- Speech clips 7 days; voice-message copies 30 days (fetched again when played later); messages as long as the person
  stays connected (disconnecting deletes the copies; Telegram keeps its own).
- Events for devices 30 days; sign-in challenges a day after expiring; sessions a week after ending; invitations 30
  days after expiring; finished jobs a week.
- Logs never hold content: no words, message texts, recovery words, tokens or request bodies; Postgres logs no
  statements or values.

## Limits

Failed sign-in proofs, invitation codes, recovery starts, challenges without a session and failed WebSocket hellos are
limited per address. Help requests, alarm receipts and their actions are never limited: repeated presses join the open
request instead.

## When a device loses its app data

- **Android cleared the app's data** (`pm clear`, "Speicher löschen"): the app says the device is not set up, offers
  "Notruf 112", and the person recovers with their words. The old device stays in "Meine Geräte" until it is signed
  out there.
- **Only the app's web storage was lost** (Android kept the device's key): the device signs in again by itself, and a
  helper's alarms keep ringing meanwhile.
- **A device signs out only when it was removed** ("Meine Geräte", or its account deleted). A sign-in refused for
  anything else, such as a phone too busy or paused to sign in time, is tried again.

## Ports (development)

| Port | Service |
|---|---|
| 8810 | Caddy, the single entry |
| 8811 | ntfy |
| 8812 | Vite |
| 8813 | stt-mlx |
| 8816 / 8817 | core / assistant (debug, localhost only) |
| 55440 | Postgres |

## Troubleshooting

- **The database restarted:** core and the assistant reconnect by themselves (they log "database connection lost").
- **Voice says it is not available:** check Server und Konten (language model, speech recognition); help keeps working.
- **A Telegram login waits:** the connectors process must run (Server und Konten → Nachrichtendienst); Telegram may
  ask to wait after many tries ("Zu viele Versuche").
- **A device's settings do not change:** the helper's page says whether the version reached the device and why it
  waits (the device is in use, it is speaking, a question waits, a help request is open).
