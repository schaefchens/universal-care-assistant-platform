# For helpers

A helper supports a person who uses UCAP: answers their help requests, and, where the person allows it, sets up their
reminders and their device. The app's own words are German by default; they are quoted here as the app shows them.

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

No permission lets you read the person's messages or notes, or see their recovery words. The person can see who may
do what at any time ("Wer darf was?"), change it, or end it.

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

## Reminders

With "Erinnerungen verwalten": Helfer → "Erinnerungen von …" (the person's name): what, when (once, daily on chosen days, every few
hours), how often the device asks again, and whether you are told when the person did not answer. A follow-up never
rings like an alarm. What the person answers is shown as their own report, not as checked.

## Setting up the person's device

With "Bedienung der Geräte einstellen": Helfer → the person → **"Gerät einrichten"**:

- the colour scheme (also high contrast and soft colours), text size and borders; how touch works (explore then
  double-tap, tap once, hold) and how long before an area is named;
- the home screen's areas: their label, their place (another area swaps with it), their colour, and the description
  that is read out; "Anhören" lets you hear it. The help area always stays and is always called "Hilfe"; it can be
  moved;
- a preview in the person's colours, and **what the device will say** when the change takes effect.

The device applies your change only when nobody is using it (30 seconds without a touch, nothing being said, no open
question or help request), then says what changed and offers to undo it. Your page shows the state: saved but not
yet received (the device is offline), received and waiting (and why), applied. The history lists every version with
who made it; "Wieder so einstellen" sets an earlier one again. A change that would remove help, the way back or the way
home cannot be saved.
