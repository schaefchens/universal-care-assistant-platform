import { t } from '@ucap/shared';
import { describe, expect, it } from 'vitest';
import type { Occurrence, ResponseRow } from '../src/reminders/api.ts';
import { alarmFor } from '../src/reminders/sync.ts';
import { afterAnswer, clockFor, promptOf, question, responseText, scheduleText } from '../src/reminders/words.ts';

const de = (form: 'du' | 'Sie' = 'du') => (key: string, params?: Record<string, string | number | Date>) => t('de', key, params, form);
const en = (key: string, params?: Record<string, string | number | Date>) => t('en', key, params, 'du');

const occ = (o: Partial<Occurrence> = {}): Occurrence => ({
  id: 'o',
  reminderId: 'r',
  personId: 'p',
  dueAt: '2026-10-14T13:00:00.000Z',
  state: 'scheduled',
  prompts: 0,
  snoozes: 0,
  nextPromptAt: '2026-10-14T13:00:00.000Z',
  title: 'Trinken',
  prompt: '',
  category: 'drink',
  repeatEveryMin: 10,
  repeatCount: 2,
  snoozeMin: 15,
  ...o,
});

describe('what a reminder says', () => {
  it('asks its question, or the category’s in the person’s own form of address', () => {
    expect(question(de(), { ...occ(), prompts: 1 })).toBe('Erinnerung: Trinken. Hast du etwas getrunken?');
    expect(question(de('Sie'), { ...occ(), prompts: 1 })).toBe('Erinnerung: Trinken. Haben Sie etwas getrunken?');
    expect(question(de(), { ...occ({ prompt: 'Wasser oder Tee?' }), prompts: 2 })).toBe('Noch einmal: Trinken. Wasser oder Tee?');
    expect(promptOf(en, occ({ category: 'medication' }))).toBe('Have you taken your medication?');
    // An appointment's (K7): how far off it is, said by the device in its own language.
    const dentist = { time: '10:00', place: 'Praxis Weber', before: 60 };
    expect(question(de(), { ...occ({ title: 'Zahnarzt', category: 'appointment', appointment: dentist }), prompts: 1 })).toBe('Erinnerung: Zahnarzt. Der Termin ist in einer Stunde, um 10 Uhr, Praxis Weber.');
    expect(promptOf(en, occ({ title: 'Dentist', category: 'appointment', appointment: { ...dentist, before: 1440 } }))).toBe('The appointment is tomorrow at 10:00, Praxis Weber.');
    // In LIVE mode an appointment is said at its reminder, the time first (K8; CONCEPT §19: "Its 8 o clock, …").
    expect(question(de(), { ...occ({ title: 'Zahnarzt', category: 'appointment', appointment: dentist }), prompts: 1 }, new Date(2026, 9, 27, 9, 0))).toBe(
      'Es ist 09:00 Uhr. Erinnerung: Zahnarzt. Der Termin ist in einer Stunde, um 10 Uhr, Praxis Weber.',
    );
    // Its alarm a moment early (96 ms on the emulator): the reminder's own time, never the minute before it. Late, or
    // opened long before, it is the clock's.
    const due = { dueAt: '2026-10-26T19:50:00.000Z' };
    expect(clockFor(due, Date.parse('2026-10-26T19:49:59.904Z')).toISOString()).toBe('2026-10-26T19:50:00.000Z');
    expect(clockFor(due, Date.parse('2026-10-26T19:52:10.000Z')).toISOString()).toBe('2026-10-26T19:52:10.000Z');
    expect(clockFor(due, Date.parse('2026-10-26T19:45:00.000Z')).toISOString()).toBe('2026-10-26T19:45:00.000Z');
  });

  it('says what was recorded, and whether it has left the device', () => {
    const o = { category: 'drink' as const, snoozeMin: 15 };
    expect(afterAnswer(de(), 'done', { result: 'sent' }, o)).toBe('Danke. Ich habe notiert: getrunken.');
    expect(afterAnswer(de(), 'done', { result: 'queued' }, o)).toBe('Danke. Ich habe notiert: getrunken. Dieses Gerät sendet es, sobald es wieder Verbindung hat.');
    expect(afterAnswer(de(), 'later', { result: 'sent' }, o)).toBe('In Ordnung. Ich frage in 15 Minuten noch einmal.');
    expect(afterAnswer(de(), 'no', { result: 'sent' }, o)).toBe('In Ordnung, ich habe es notiert.');
    expect(afterAnswer(de('Sie'), 'later', { result: 'refused', reason: 'snooze_limit' }, o)).toBe('Später geht nicht mehr. Bitte wählen Sie Erledigt, Nein oder Hilfe holen.');
    expect(afterAnswer(de(), 'done', { result: 'refused', reason: 'cancelled' }, o)).toBe('Diese Erinnerung ist nicht mehr offen.');
  });

  it('reads schedules as people say them', () => {
    expect(scheduleText(de(), 'de', { kind: 'daily', times: ['08:00', '15:00'], days: [1, 2, 3, 4, 5, 6, 7] })).toBe('Täglich um 08:00 und 15:00');
    expect(scheduleText(de(), 'de', { kind: 'daily', times: ['09:00'], days: [5, 1, 3] })).toBe('Mo, Mi und Fr um 09:00');
    expect(scheduleText(de(), 'de', { kind: 'interval', everyMinutes: 120, from: '08:00', until: '20:00', days: [1, 2, 3, 4, 5, 6, 7] })).toBe('Täglich alle 2 Stunden von 08:00 bis 20:00');
    expect(scheduleText(de(), 'de', { kind: 'interval', everyMinutes: 60, from: '09:00', until: '17:00', days: [6, 7] })).toBe('Sa und So jede Stunde von 09:00 bis 17:00');
    expect(scheduleText(de(), 'de', { kind: 'once', date: '2026-10-15', time: '15:00' })).toBe('Einmal am 15. Oktober 2026 um 15:00');
    expect(scheduleText(en, 'en', { kind: 'daily', times: ['08:00'], days: [1, 3] })).toBe('Mon and Wed at 08:00');
  });

  it('tells helpers what the person reported, never as fact (CONCEPT §9)', () => {
    const row = (r: Partial<ResponseRow>): ResponseRow => ({ occurrenceId: 'o', title: 'Trinken', category: 'drink', dueAt: '', state: 'answered', kind: 'done', info: null, at: '', careRequestId: null, source: 'user_reported', ...r });
    expect(responseText(de(), 'Anna', row({}))).toBe('Anna hat angegeben: getrunken');
    expect(responseText(de(), 'Anna', row({ kind: 'no' }))).toBe('Anna hat angegeben: nein');
    expect(responseText(de(), 'Anna', row({ kind: 'help' }))).toBe('Anna hat einen Hilferuf gesendet');
    expect(responseText(de(), 'Anna', row({ kind: null, state: 'missed' }))).toBe('keine Antwort');
    expect(responseText(de('Sie'), null, row({}))).toBe('Sie haben angegeben: getrunken');
    expect(responseText(en, 'Anna', row({ category: 'medication' }))).toBe('Anna reported: taken');
  });
});

describe('the device’s own alarms', () => {
  it('rings the prompts still to come: all for a scheduled one, the rest for one already asking', () => {
    expect(alarmFor(occ())).toMatchObject({ at: Date.parse('2026-10-14T13:00:00.000Z'), repeats: 2, repeatEveryMin: 10, snoozeMin: 15 });
    // Asked once already, the next prompt at 13:10: two more prompts in all.
    expect(alarmFor(occ({ state: 'due', prompts: 1, nextPromptAt: '2026-10-14T13:10:00.000Z' }))).toMatchObject({ at: Date.parse('2026-10-14T13:10:00.000Z'), repeats: 1 });
    // The last prompt was asked: what is left is the server's "missed", not a ring.
    expect(alarmFor(occ({ state: 'due', prompts: 3, nextPromptAt: '2026-10-14T13:30:00.000Z' }))).toBeNull();
    expect(alarmFor(occ({ state: 'answered' }))).toBeNull();
    expect(alarmFor(occ(), (o) => promptOf(de(), o))?.prompt).toBe('Hast du etwas getrunken?');
  });
});
