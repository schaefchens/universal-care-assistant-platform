# Google Play: declarations and disclosures

What UCAP's Android app asks Android for since M3 (and, since M4, the phone role, device administration and the list
of apps), why, what Google Play requires for it, and what the app tells the person before each step. Prepared for the Play release (plan.md, M9: "Play release (closed test with 12 testers for 14
days, declarations, prominent disclosures)"); written in M3 as plan-m3.md, K9 asks ("the disclosures written (the SMS
role, notification access, contacts)").

The app's words are German by default; they are quoted as the app shows them, with the English the app shows in
English. Their source is `packages/shared/i18n/de.json` and `en.json`, under the keys named.

**Where the data goes.** UCAP is self-hosted: everything below goes to the person's own UCAP server, run by them, their
household or their care organisation (docs/operator.md), over HTTPS and signed by the phone's own key. Nobody else gets
it, the people who write UCAP included. Helpers see none of it: no permission lets a helper read messages
(helper-onboarding.md).

**Play's rules for a prominent disclosure**, followed in each flow below: shown in the app in normal use, not only in a
privacy policy. It names the data and what is done with it, comes right before the step it is about, and is followed by
an action of the person's own (a button that names what it does). Leaving the page is never consent.

## The SMS role (UCAP as the default SMS app)

**What it is for.** The person makes UCAP their phone's SMS app (plan-m3.md, K4, the owner's decision 1). UCAP then
receives their SMS and MMS, reads them aloud, and sends their replies by voice. Each reply is sent only after the
person confirmed it, and "Gesendet" is said only at the network's sent report. Everything stays in Android's SMS store
as before, so Google Messages finds it again when the role goes back.

**Permissions**, all granted by Android with the role and taken back with it (docs/spikes/m3.md, C):
`RECEIVE_SMS`, `READ_SMS`, `SEND_SMS`, `RECEIVE_MMS`, `RECEIVE_WAP_PUSH`, and `READ_CONTACTS` (see Contacts). Also the
parts the role requires: the `SMS_DELIVER` and `WAP_PUSH_DELIVER` receivers, the `RESPOND_VIA_MESSAGE` service (quick
replies to a call), and the screen other apps open with `smsto:`.

**Play's policy.** SMS permissions are allowed for the default SMS handler, with the Permissions Declaration Form.
Its core functionality is "Default SMS handler", and it needs a video of the core use. The app must work as the default
handler and ask for it through Android's role dialog, which UCAP does.

**For the declaration form:**

> UCAP is an assistive app for disabled people, who use it by voice, by large touch areas or with a screen reader. As
> the phone's default SMS app it receives and sends the person's SMS and MMS, reads each new message aloud, and lets
> the person reply by voice; every reply is read back and sent only after the person confirms it. Messages go to the
> person's own UCAP server (self-hosted by them or their care organisation) so they can hear and answer them on their
> other devices too. Android keeps every message in its SMS store; UCAP never deletes from it.

**The video** shows on a phone with a SIM:
- Einstellungen → Nachrichtendienste → "UCAP als SMS-App verwenden": the page's explanation and the note on Google
  Messages' chat features;
- Android's role dialog, with UCAP chosen;
- an SMS arriving and read aloud ("Anna schrieb per SMS: …");
- a reply dictated ("Antworte, dass ich später anrufe"), the confirmation question naming SMS, "Ja", and "Gesendet" at
  the network's report;
- the way back on the same page ("Google Messages wieder als SMS-App"), with the history in Google Messages.

**The disclosure**, on the SMS page (Einstellungen → Nachrichtendienste → UCAP als SMS-App), before its button:

- `sms.intro`: „Hier wird UCAP die SMS-App dieses Telefons. Dann empfängt und sendet UCAP deine SMS selbst: Wer schreibt,
  wann und was, geht an deinen UCAP-Server, damit UCAP es dir vorliest und du antworten kannst. Wer dir schreibt, nennt
  UCAP mit dem Namen aus dem Adressbuch dieses Telefons. Android bewahrt deine SMS auf wie bisher: Auch Google Messages
  findet sie wieder, wenn du es später wieder nimmst. Deine Helfer bekommen dadurch keinen Zugriff auf deine SMS."
  ("Here UCAP becomes this phone's SMS app. Then UCAP receives and sends your text messages itself: who writes, when and
  what goes to your UCAP server, so UCAP can read it to you and you can reply. UCAP names whoever writes to you by the
  name in this phone's address book. Android keeps your text messages as before: Google Messages finds them again if
  you switch back to it later. Your helpers get no access to your text messages through this.")
- `sms.rcs`: the request to switch off Google Messages' chat features first, as chats may stop arriving otherwise.
- `sms.dialog`: „Android fragt dann selbst: Wähle in der Liste UCAP und dann „Als Standard festlegen“.“
- The consent: the button „UCAP als SMS-App verwenden“ (`sms.take`), which opens Android's dialog; then
  „Mit meinem Konto verbinden“ (`sms.connect`) before anything goes to the server.

**What goes to the server:** each SMS's number and the name the address book gives it, its time and text, and an MMS's
parts (text, pictures), from 30 days before connecting on. Also the person's replies with their sent and delivery
reports. It is kept while the person stays connected; disconnecting deletes UCAP's copies on the server and the phone's
own small queue, never a message in Android's store (tools/test/sms-store.test.ts).

## Notification access (previews from other apps)

**What it is for.** For apps UCAP cannot connect to (Signal, Threema, Instagram, Facebook Messenger, and WhatsApp for
people without its link), UCAP reads what their message notifications show and reads it aloud as a preview. It replies
through the notification's own reply action and marks a conversation read through its own action, once heard
(plan-m3.md, K5). It reads only the apps the person chose, in a process of its own.

**Permission:** `BIND_NOTIFICATION_LISTENER_SERVICE`, switched on by the person in Android's own settings page. For an
app installed from a file, "Eingeschränkte Einstellungen zulassen" comes first.

**Play's policy.** Notification access has no Permissions Declaration Form. The messages it reads are personal and
sensitive data under the User Data policy, so it needs the prominent disclosure and consent before access. The Data
safety form lists them as messages.

**The disclosure**, on the previews page (Einstellungen → Nachrichtendienste → Vorschauen anderer Apps), before
anything is switched on:

- `previews.intro`: „UCAP kann die Benachrichtigungen von Apps lesen, die du hier auswählst, zum Beispiel Signal oder
  Threema. Was eine Benachrichtigung zeigt, also wer schreibt, wann und was, geht dann an deinen UCAP-Server: So liest
  UCAP es dir vor, und du kannst darauf antworten. Von diesen Apps kennt UCAP nur, was ihre Benachrichtigungen
  zeigen, keinen Verlauf. Andere Apps liest UCAP nicht, und deine Helfer sehen nichts davon."
- `previews.access.ask`: what Android's page asks and what to do there.
- The consent: „Einverstanden: weiter zu Android“ (`previews.access.button`), then Android's own switch. After that,
  each app is chosen on its own („Signal lesen“, `previews.app.on`), and can be stopped the same way.
- `previews.redacted`: codes Android hides in notifications stay hidden.

**What goes to the server:** for the chosen apps only, the name a notification shows for the sender, its time and text,
the app's name, and the person's replies. Nothing of other apps, no history beyond what a notification shows. It is
kept while the app stays chosen; disconnecting it deletes UCAP's copies and the phone's own record of it
(PreviewDb.dropApp).

## Contacts

**What it is for.** UCAP's contacts are the person's own, kept on their server (plan-m3.md, K6). The phone's address book
is used in two ways. While UCAP is the SMS app, it names who sent an SMS: the address book's name, never the sender's
own claim. And when the person presses „Kontakte vom Telefon übernehmen“, UCAP copies the address book into their
contacts.

**Permission:** `READ_CONTACTS`, granted by Android with the SMS role only. UCAP never asks for it on its own. Without the
role, Android's contact picker gives the one contact the person picks, which needs no permission
(PhoneContactsPlugin).

**Play's policy.** From 27 January 2027, an app targeting API 37 needs a declaration for `READ_CONTACTS` unless the
system's contact picker suffices (plan-m3.md, Risks). For SMS senders it does not suffice: naming a sender needs a
lookup by number, which is part of the default SMS handler's core function. The declaration:

> UCAP reads the address book only while it is the phone's default SMS app (Android grants the permission with the
> role): to name who sent an SMS by the person's own contact, and, when the person presses "Take the contacts from the
> phone", to copy names, numbers and email addresses into the person's contacts on their own UCAP server.

**The disclosure**, on the contacts page (Einstellungen → Kontakte), right above the button that imports everything:

- `contacts.phone.disclosure`: „„Kontakte vom Telefon übernehmen“ kopiert die Namen, Telefonnummern und
  E-Mail-Adressen aus dem Adressbuch dieses Telefons in deine Kontakte auf deinem UCAP-Server. Damit nennt UCAP, wer
  dir schreibt, und schreibt oder ruft an, wen du nennst. Deine Helfer sehen sie nur, wenn du ihnen „Kontakte
  verwalten“ erlaubst.“ ("“Take the contacts from the phone” copies the names, phone numbers and email addresses in
  this phone's address book into your contacts on your UCAP server. UCAP then names who writes to you, and writes to
  or calls whom you name. Your helpers see them only if you let them “Manage contacts”.")
- The consent: the button „Kontakte vom Telefon übernehmen“ (`contacts.phone.all`).
- The SMS page's disclosure (above) names the address book's use for senders.

**What goes to the server:** on the import, each contact's name, numbers and email addresses with their labels. With an
SMS, the sender's name from the address book.

## The phone role (UCAP as the default phone app, M4)

**What it is for.** The person makes UCAP their phone app (plan-m4.md, G10; the owner's choice of 2026-10-27). Calls then
come to UCAP's own screen with large areas, over the lock screen and inside the kiosk, and UCAP says who is calling;
calls out go straight through the role; missed calls are said once, and "Wer hat angerufen?" answers by voice.

**Permissions and parts**, granted by Android with the role (`RoleManager.ROLE_DIALER`, asked through Android's own
dialog): `CALL_PHONE` (UCAP already asked for it in M1 for direct calls to a helper), `READ_CONTACTS` (see Contacts),
`POST_NOTIFICATIONS`. The parts the role requires: an `InCallService` (`UcapCallService`, bound only by the system
through `BIND_INCALL_SERVICE`) and an activity for `android.intent.action.DIAL` with and without `tel:`
(`DialActivity`, which asks the person before anything is called). UCAP asks for **no call log permission**
(`READ_CALL_LOG`, `WRITE_CALL_LOG`, `PROCESS_OUTGOING_CALLS`): it keeps its own record of the calls it handled.

**Play's policy.** Without the call log group, the Permissions Declaration Form is not required for the role itself.
The role is offered only on a phone with telephony; a tablet never sees it. The declaration text, should Play ask
(also for `READ_CONTACTS` from 2027, see Contacts):

> UCAP is an assistive app for disabled people. As the phone's default phone app it shows calls on its own screen
> with large areas and says who is calling, by the name in the person's contacts or the number, so people who cannot
> see the screen or use small buttons can answer, decline or ask for help. It records who called and whom the person
> called, when and how it ended, on the person's own UCAP server, so it can tell them about missed calls on any of
> their devices; never what was said.

**The video** shows on a phone with a SIM: Einstellungen → Telefon-App, the page's text and "UCAP als Telefon-App";
Android's role dialog with UCAP chosen; an incoming call said and answered on the large area; a missed call said
("Verpasster Anruf von Anna, heute um 14:05 Uhr."); "Wer hat angerufen?"; the way back ("Telefon-App zurückgeben",
Android's default apps).

**The disclosure**, on the settings page's section Telefon-App, before its button:

- `phone.intro`: „UCAP kann deine Telefon-App sein: Anrufe kommen dann auf UCAPs eigenen Bildschirm mit großen
  Flächen, und UCAP sagt, wer anruft, auch über dem Sperrbildschirm und im Kiosk-Modus. Wer dich anruft und wen du
  anrufst, wann und wie lange, geht mit dem Namen aus deinen Kontakten an deinen UCAP-Server, damit UCAP dir verpasste
  Anrufe sagt und weiß, wer angerufen hat. Was gesprochen wird, nie. Deine Helfer sehen deine Anrufe nicht.“ ("UCAP can
  be your phone app: calls then come to UCAP's own screen with large areas, and UCAP says who is calling, over the lock
  screen and in kiosk mode too. Who calls you and whom you call, when and for how long, goes with the name in your
  contacts to your UCAP server, so UCAP can tell you about missed calls and knows who called. Never what is said. Your
  helpers do not see your calls.")
- `phone.explain`: what Android will ask, said before it asks.
- The consent: the button „UCAP als Telefon-App“ (`phone.ask`), which opens Android's dialog.

**What goes to the server:** per call the number, the name the phone's contacts give it, in or out, answered, missed or
declined, its time and length, signed by the phone. Kept 90 days (docs/operator.md, "What is kept").

## Device administration (dedicated kiosk devices, M4)

**What it is for.** A tablet that should stay in UCAP and a few allowed apps (plan-m4.md, G9) is set up once by an
operator as a dedicated device, with UCAP as its device owner (`adb shell dpm set-device-owner …`, docs/operator.md).
UCAP then uses lock task mode with the allowed apps, makes itself the home app, and may switch off Android's lock
screen where the setting asks for it. On every other device the kiosk is Android's screen pinning, without device
administration.

**Parts:** a `DeviceAdminReceiver` (`UcapAdmin`, `BIND_DEVICE_ADMIN`) with no policies of its own
(`res/xml/ucap_device_admin.xml`). The app never asks a person to activate it, and it is inactive unless an operator
made UCAP the device owner. UCAP's settings end it ("Kiosk-Gerät wieder normal machen").

**Play's policy.** Device administration may not be used to stop the app's removal or to take control of a person's
device; the kiosk is set up by whoever runs the device for the person and ended by the person (with their code) or
their helpers, as the person chose. The declaration:

> UCAP can turn a dedicated tablet into a kiosk for a disabled person: it stays in UCAP and the apps the person or
> their helper allowed, and help is always one touch away. Only an operator can make UCAP the device owner, on a
> device without accounts, with adb; UCAP never asks for device administration and uses no policies besides lock
> task, its home screen and, if chosen, switching off Android's lock screen. It is ended in UCAP's settings.

## The list of apps (areas that open apps, M4)

**What it is for.** An area can open another app (plan-m4.md, G8): the person or a helper who may set the device up
chooses it from the apps the device reports.

**How:** a `<queries>` entry for `MAIN`/`LAUNCHER` activities, so UCAP sees only what a launcher sees; **no
`QUERY_ALL_PACKAGES`**. The home role (`ROLE_HOME`) is asked for through Android's own question.

**What goes to the server:** whether UCAP is the home screen and the kiosk's state, at every start and after a change;
the names and package names of those apps **only while a helper of the person holds "Bedienung der Geräte einstellen"
or "Kiosk-Modus einstellen"**, the two permissions that show them (the owner, 2026-10-28: "it should be bound to
that"). The server's answer to each report says whether to send the list; it removes the lists when the last such
permission ends (and a daily sweep any left over). Shown only to helpers with one of them; the person's own setup reads
the list on the device.

**Disclosure and consent** (Play's User Data policy counts the "inventory of other apps on the device" as personal and
sensitive data): wherever one of the two is granted, the person hears it before anything is sent, in the app's normal
use. On the approval screen: "Maria möchte dir helfen. Maria darf … die Bedienung deiner Geräte einstellen. Dafür
sieht Maria, welche Apps auf deinen Geräten sind. Maria darf nicht deine Nachrichten lesen …", then "Erlauben" or
"Ablehnen"; under the choice of permissions; and in a representative's news to the person. The person's "Erlauben"
(or their representative's, G6) is the explicit yes; leaving the screen grants nothing.

## Data safety form (M3's part)

What the app sends off the phone since M3. M1's and M2's (voice, help requests, device data) are listed with M9.
Check each line against Play's guidance at the release: whether data sent to a server the person controls counts as
"collected" there.

| Data type (Play's names) | When | Shared with third parties | Purpose | Optional | Encrypted in transit | Deleted |
|---|---|---|---|---|---|---|
| Messages: SMS or MMS | UCAP is the SMS app and connected | no | app functionality | yes | yes | when the person disconnects SMS |
| Messages: other in-app messages | previews of the apps the person chose | no | app functionality | yes | yes | when the person stops an app |
| Contacts | an SMS sender's name; the import on the person's press | no | app functionality | yes | yes | the person deletes a contact and removes it for good (Einstellungen → Gelöschtes), or their account |

Telegram, WhatsApp and email are connected by the person's server, not by the app; the app shows and sends what the
server holds.

M4 adds (check the type names against Play's list at the release):

| Data type (Play's names) | When | Shared with third parties | Purpose | Optional | Encrypted in transit | Deleted |
|---|---|---|---|---|---|---|
| Calls (who, when, how long; nearest: Contacts / App activity) | UCAP is the phone app | no | app functionality | yes | yes | after 90 days |
| App activity: Installed apps | while a helper may set up the devices or the kiosk (the apps a launcher shows) | no | app functionality | yes | yes | when no helper may see them any more, or with the device |

## Open until a real phone with a SIM

The role dialog with TalkBack under real fingers, the SMS role on a phone with a carrier, and WhatsApp's own
notifications as previews: listed in docs/acceptance-m3.md. For M4: calls on a real network, the earpiece and the
proximity sensor, a second call during a call, Bluetooth headsets, and a device owner set up by QR code: listed in
docs/acceptance-m4.md.
