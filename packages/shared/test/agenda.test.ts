/**
 * How appointments are said (docs/plan-m3.md, K7: "Everything read back from what was stored"), the plan's own
 * example first; weekly ones, whole days, the person's form of address and English.
 */
import { describe, expect, it } from 'vitest';
import { appointmentReadback, appointmentWhen, reminderWhen } from '../src/agenda.ts';

describe('appointments as they are said', () => {
  it('reads back what was stored, as the plan says it', () => {
    expect(appointmentReadback('de', 'du', { title: 'Zahnarzt', day: '2026-10-20', time: '10:00', weekdays: null, remindBefore: [60] }, 2026)).toBe(
      'Termin gespeichert: Dienstag, 20. Oktober, 10 Uhr: Zahnarzt. Ich erinnere dich eine Stunde vorher.',
    );
    expect(appointmentReadback('de', 'Sie', { title: 'Physiotherapie', day: '2026-10-26', time: '08:30', weekdays: [4, 1], place: 'Praxis Weber', remindBefore: [1440, 60] }, 2026)).toBe(
      'Termin gespeichert: jeden Montag und Donnerstag um 8:30 Uhr, ab Montag, 26. Oktober: Physiotherapie, Praxis Weber. Ich erinnere Sie eine Stunde vorher und einen Tag vorher.',
    );
    expect(appointmentReadback('de', 'du', { title: 'Geburtstag Oma', day: '2026-10-30', time: null, weekdays: null, remindBefore: [0, 1440] }, 2026)).toBe(
      'Termin gespeichert: Freitag, 30. Oktober, ganztägig: Geburtstag Oma. Ich erinnere dich am Morgen des Tages und einen Tag vorher.',
    );
    // Entered by a helper: the person is named, not the helper addressed.
    expect(appointmentReadback('de', 'Sie', { title: 'Zahnarzt', day: '2026-10-28', time: '10:00', weekdays: null, remindBefore: [60] }, 2026, 'Clara')).toBe(
      'Termin gespeichert: Mittwoch, 28. Oktober, 10 Uhr: Zahnarzt. Ich erinnere Clara eine Stunde vorher.',
    );
    // Without reminders nothing more is said; another year is named.
    expect(appointmentReadback('en', 'du', { title: 'Dentist', day: '2027-01-05', time: '10:30', weekdays: null, remindBefore: [] }, 2026)).toBe('Appointment saved: Tuesday, 5 January 2027, 10:30: Dentist.');
  });

  it('says when and how long before', () => {
    expect(appointmentWhen('de', { day: '2026-11-02', time: null, weekdays: [1] }, 2026)).toBe('jeden Montag, ab Montag, 2. November');
    expect([0, 15, 60, 120, 1440, 2880].map((m) => reminderWhen('de', m, false))).toEqual([
      'zur Zeit des Termins',
      '15 Minuten vorher',
      'eine Stunde vorher',
      '2 Stunden vorher',
      'einen Tag vorher',
      '2 Tage vorher',
    ]);
  });
});
