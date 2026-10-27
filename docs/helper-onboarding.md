# For helpers

A helper supports a person who uses UCAP: answers their help requests, and, where the person allows it, sets up their
reminders, their device, their contacts and their appointments. The app's own words are German by default; they are quoted here as the app shows them.

## Joining

1. **The person invites you** on their device (Einstellungen → Helfer → "Einladung erstellen") and chooses what you
   may do. The invitation is a link or a ten-digit code the person can read out.
2. **You open the link**, or enter the code in UCAP ("Einladung prüfen"), on your phone, tablet or computer. You see
   what the person proposes.
3. **The person approves it on their own device**; UCAP reads out who you are and what you may and may not do. Until
   then nothing is shared with you.

What you may do is one permission each, and none implies another:

| In the app | What it allows |
|---|---|
| Hilferufe beantworten | getting the person's help requests, accepting, declining, quick replies, marking them resolved |
| Benachrichtigung bei Hilferufen einstellen | changing who is alerted when (the escalation plan) |
| Erinnerungen verwalten | making and changing the person's reminders |
| Antworten auf Erinnerungen sehen | seeing what the person answered ("Anna hat angegeben: getrunken") |
| Bedienung der Geräte einstellen | setting up the person's device: how it looks, touch, the home screen's areas |
| Kontakte verwalten | listing, adding, changing and deleting the person's saved contacts |
| Termine und Aufgaben verwalten | the person's appointments (with their reminders) and tasks: adding, changing, deleting, marking done |

No permission lets you read the person's messages or notes, or see their recovery words; contacts and appointments
never lead to them either. The person can see who may do what at any time ("Wer darf was?"), change it, or end it.
What you delete stays kept for undo until the person removes it for good; only they can.

## Alarms on your phone

Help requests ring like an alarm, also when your phone is locked or in Doze, through the **ntfy** app (UnifiedPush):

1. Install ntfy (F-Droid or Play) and UCAP.
2. In UCAP: Einstellungen → the alarm checklist: notifications, the full-screen alarm, the battery exemption, ntfy as
   the distributor.
3. **"Test-Alarm senden"**: your phone must ring. UCAP checks your phone every six hours and tells the person when no
   helper can be reached.

In a desktop browser, allow notifications for UCAP. **Chrome on Android alone is not reliable** for alarms when the
phone sleeps (measured): use the app.

## A help request

- The alarm says whose request it is, from which device and when ("(nicht bestätigt)" when the person's device could
  not confirm the request by voice).
- **"Annehmen"** (after unlocking) tells the person you accepted; the others' alarms stop. **"Kann nicht"** passes it
  on to the next helpers. A request nobody accepts goes to the next helpers after the plan's time.
- Quick replies are said to the person in your words: "Maria sagt: „Ich bin unterwegs.“" UCAP itself never says that
  someone is coming; only your own words do.
- When you are done, **mark it resolved**. The person can reopen it ("Ich brauche noch Hilfe") for half an hour.

## Who is alerted when

With "Benachrichtigung bei Hilferufen einstellen": Helfer → the person → **"Benachrichtigung bei Hilferufen
einstellen"**. For each helper who answers help requests: at once, or after 1, 2, 5 or 10 minutes in which nobody
accepted. At least one helper is alerted at once. A helper none of whose devices answered its last check is named, so
you can ask them to fix it. The person sees in their history that you changed it, and can change it back on their
Helfer page. A helper added later is alerted last until someone places them.

## Reminders

With "Erinnerungen verwalten": Helfer → "Erinnerungen von …" (the person's name): what, when (once, daily on chosen days, every few
hours), how often the device asks again, and whether you are told when the person did not answer. A follow-up never
rings like an alarm. What the person answers is shown as their own report, not as checked.

## Contacts

With "Kontakte verwalten": Helfer → the person → **"Kontakte von …"**. You see the person's saved contacts and can add
one (a name, phone numbers with a label such as "Handy" or "Praxis", email addresses), change one or delete one. Only
what is saved: the names UCAP suggests from the person's conversations ("dieselbe Person?") are the person's to answer,
and you never see them.

A number is kept as Germany writes it or with its country code; UCAP reads it back digit by digit when the person asks
for it. The same number or address is never two contacts. Each change is said on the person's device ("Maria hat den
Kontakt „Physiotherapie“ hinzugefügt.") and kept in their history. Right after a change, "Rückgängig" on your page
takes it back, and the device says that too.

## Appointments and tasks

With "Termine und Aufgaben verwalten": Helfer → the person → **"Termine von …"** and **"Aufgaben von …"**.

- **An appointment:** what, the day, the time (or all day), how long, where, a note, weekly on chosen days, and when
  the person is reminded (an hour before, by default). Saving reads it back as stored ("Termin gespeichert: Dienstag,
  20. Oktober, 10 Uhr: Zahnarzt, Praxis Weber. Ich erinnere Clara eine Stunde vorher."). Its reminders are the person's
  usual ones: the device's alarm, with "Hilfe holen" among the answers.
- **A task:** what is to be done, by which day, and whether it is done.
- What came from a message shows as "aus einer Nachricht", never the message. What the person marked private is not
  shown to you at all.
- Each change is said on the person's device ("Maria hat den Termin „Zahnarzt“ eingetragen.") and kept in their
  history.

## Setting up the person's device

With "Bedienung der Geräte einstellen": Helfer → the person → **"Gerät einrichten"**:

- the colour scheme (also high contrast and soft colours), text size and borders; how touch works (explore then
  double-tap, tap once, hold) and how long before an area is named;
- the home screen's areas: their label, their place (another area swaps with it), their colour, and the description
  that is read out; "Anhören" lets you hear it. The help area always stays and is always called "Hilfe"; it can be
  moved;
- how the device tells of a new message: who wrote and what it says (the default), or who wrote alone ("Neue
  Nachrichten", "Sagen, was darin steht"): for a device in a room where others listen, for example. UCAP's notification
  of a new SMS on that phone follows it;
- a preview in the person's colours, and **what the device will say** when the change takes effect.

The device applies your change only when nobody is using it (30 seconds without a touch, nothing being said, no open
question or help request), then says what changed and offers to undo it. Your page shows the state: saved but not
yet received (the device is offline), received and waiting (and why), applied. The history lists every version with
who made it; "Wieder so einstellen" sets an earlier one again. A change that would remove help, the way back or the way
home cannot be saved.

## Everything for one person (M4)

Helfer → **"Alles für Clara"**: what you may do for the person, in one place, by permission: their devices (when they
were last reachable, whether your setup is applied or waiting, whether the app lock is on), their voices for answers
and for reading aloud (a voice that needs the person's consent is shown, but only the person can agree to it), how
long answers are, the language and the form of address, the help settings (who is alerted when, whom the device offers
to call without a connection, what an unanswered help question does), and the ways to their reminders, contacts,
appointments, tasks and the device's setup. Each change is said on the person's devices with "Rückgängig", and kept in
their history.

In the device's setup you can also shape **every screen**: how many areas and how they are laid out, new screens and
the areas leading to them, each area's function, words, sound and vibration, how fast the device speaks and how much
an area says when a finger rests on it. On a phone or tablet with UCAP, an area can **open an app** the device has.

## The kiosk (M4)

With **"Kiosk-Modus einstellen"** (a permission of its own, apart from setting up the device) you can lock a device into
UCAP and the apps you allow, and say who may end it there: the person (with their code) and you, or helpers only.
On a dedicated device (operator.md) it is a real lock; on any other phone or tablet it is Android's screen pinning,
which one gesture ends. A browser cannot be locked. Help always works inside it.

## Calls (M4)

On a phone, the person can make UCAP their phone app (Einstellungen → Telefon-App; only on the phone itself). Calls
then come to UCAP's own screen: who calls, said and shown, and large areas for Annehmen, Ablehnen and Hilfe. "Hilfe"
during a call reaches you as any help request, and the call goes on. Missed calls are said to the person once, and
"Wer hat angerufen?" tells them who called. You do not see their calls.

## Representing someone (M4)

A person can make you their **representative** (or the operator can, with a reason, when the person cannot). You then
decide for them who may help and with what: approve or decline helpers who asked, change and withdraw permissions,
end connections, invite a helper, sign out one of their devices (Helfer → "Als Vertretung von …"). You never see their
messages or notes because of it, never link devices or recover their account, and never give yourself more
permissions. Everything you do is said on their devices as your act as their representative, and is in their history.

## Being a trusted person (M4)

Someone may ask you to be one of their **trusted persons** (Helfer → "Du bist Vertrauensperson"): if they lose every
device and their words, you and the others confirm their new device. You see nothing of their data because of it.
When they ask you: their new device shows a six-digit code and four pictures; enter the code under Helfer, check that
you see the same four pictures, choose whose device it is, and say yes. When enough trusted persons agreed, the new
device becomes theirs **a day later**, and any of their devices can still stop it.
