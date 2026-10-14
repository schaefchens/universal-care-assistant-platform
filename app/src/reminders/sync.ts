/**
 * The device's own reminder alarms (docs/plan.md, S6): the next 48 hours, handed to native code so reminders ring
 * with the app closed or the device offline (CONCEPT §16). Set again whenever a reminder changes or is answered, and
 * at every start. The server prompts as well; native code keeps the two from asking twice.
 */
import type { Session } from '../identity/account.ts';
import { has, type ReminderAlarm, Reminders } from '../native/plugins.ts';
import { type Occurrence, reminders } from './api.ts';

/** The prompts still to come for an occurrence: the next one at `at`, `repeats` more after it. */
export function alarmFor(o: Occurrence, promptText: (o: Occurrence) => string = (x) => x.prompt, titleText: (o: Occurrence) => string = (x) => x.title): ReminderAlarm | null {
  const total = 1 + o.repeatCount;
  const done = o.state === 'due' ? o.prompts : 0;
  const left = total - done;
  const at = Date.parse(o.state === 'due' ? (o.nextPromptAt ?? o.dueAt) : o.dueAt);
  if ((o.state !== 'scheduled' && o.state !== 'due') || left <= 0 || Number.isNaN(at)) return null;
  return { occurrenceId: o.id, at, title: titleText(o), prompt: promptText(o), category: o.category, repeatEveryMin: o.repeatEveryMin, repeats: left - 1, snoozeMin: o.snoozeMin, repeatCount: o.repeatCount };
}

/** `promptText` and `titleText` say them as this device would (the category's when the reminder has none). */
export async function syncDeviceAlarms(session: Session, promptText?: (o: Occurrence) => string, titleText?: (o: Occurrence) => string): Promise<{ count: number; exact: boolean } | null> {
  if (!has('Reminders')) return null;
  const { occurrences } = await reminders(session, session.ref.userId).upcoming();
  const items = occurrences.map((o) => alarmFor(o, promptText, titleText)).filter((x): x is ReminderAlarm => x !== null);
  return Reminders.schedule({ items });
}
