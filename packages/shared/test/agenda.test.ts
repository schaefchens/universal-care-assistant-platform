/**
 * How appointments are said (docs/plan-m3.md, K7: "Everything read back from what was stored"), the plan's own
 * example first; weekly ones, whole days, the person's form of address and English.
 */
import { describe, expect, it } from 'vitest';
import { appointmentAloud, appointmentOnDay, appointmentPrompt, appointmentReadback, appointmentWhen, dayAloud, reminderWhen } from '../src/agenda.ts';

describe('appointments as they are said', () => {
  it('reads back what was stored, as the plan says it', () => {
    expect(appointmentReadback('de', 'du', { title: 'Zahnarzt', day: '2026-10-20', time: '10:00', weekdays: null, remindBefore: [60] }, { year: 2026 })).toBe(
      'Termin gespeichert: Dienstag, 20. Oktober, 10 Uhr: Zahnarzt. Ich erinnere dich eine Stunde vorher.',
    );
    expect(appointmentReadback('de', 'Sie', { title: 'Physiotherapie', day: '2026-10-26', time: '08:30', weekdays: [4, 1], place: 'Praxis Weber', remindBefore: [1440, 60] }, { year: 2026 })).toBe(
      'Termin gespeichert: jeden Montag und Donnerstag um 8:30 Uhr, ab Montag, 26. Oktober: Physiotherapie, Praxis Weber. Ich erinnere Sie eine Stunde vorher und einen Tag vorher.',
    );
    expect(appointmentReadback('de', 'du', { title: 'Geburtstag Oma', day: '2026-10-30', time: null, weekdays: null, remindBefore: [0, 1440] }, { year: 2026 })).toBe(
      'Termin gespeichert: Freitag, 30. Oktober, ganztägig: Geburtstag Oma. Ich erinnere dich am Morgen des Tages und einen Tag vorher.',
    );
    // Entered by a helper: the person is named, not the helper addressed.
    expect(appointmentReadback('de', 'Sie', { title: 'Zahnarzt', day: '2026-10-28', time: '10:00', weekdays: null, remindBefore: [60] }, { year: 2026, of: 'Clara' })).toBe(
      'Termin gespeichert: Mittwoch, 28. Oktober, 10 Uhr: Zahnarzt. Ich erinnere Clara eine Stunde vorher.',
    );
    // Without reminders nothing more is said; another year is named.
    expect(appointmentReadback('en', 'du', { title: 'Dentist', day: '2027-01-05', time: '10:30', weekdays: null, remindBefore: [] }, { year: 2026 })).toBe('Appointment saved: Tuesday, 5 January 2027, 10:30: Dentist.');
  });

  it('says a day from what is stored, the appointments by their time, and what is due', () => {
    const today = '2026-10-26';
    expect(
      dayAloud('de', {
        day: '2026-10-27',
        today,
        year: 2026,
        items: [
          { title: 'Geburtstag Oma', time: null },
          { title: 'Zahnarzt', time: '10:00', place: 'Praxis Weber' },
          { title: 'Physiotherapie', time: '15:30' },
        ],
        due: ['Rezept abholen', 'Brief einwerfen'],
      }),
    ).toBe('Morgen, Dienstag, 27. Oktober: den ganzen Tag Geburtstag Oma; um 10 Uhr Zahnarzt, Praxis Weber; um 15:30 Uhr Physiotherapie. Zu erledigen: Rezept abholen und Brief einwerfen.');
    expect(dayAloud('de', { day: today, today, items: [], due: [] })).toBe('Heute, Montag, 26. Oktober: keine Termine.');
    expect(dayAloud('en', { day: '2026-10-29', today, items: [{ title: 'Dentist', time: '10:30' }], due: [] })).toBe('Thursday 29 October: at 10:30 Dentist.');
    // Weekly ones on their weekdays from their first day on.
    const physio = { day: '2026-10-26', weekdays: [1, 4] };
    expect(['2026-10-19', '2026-10-26', '2026-10-27', '2026-10-29', '2026-11-02'].map((d) => appointmentOnDay(physio, d))).toEqual([false, true, false, true, true]);
  });

  it('says one appointment: when, where, and for a weekly one when it is next', () => {
    const o = { today: '2026-10-27', year: 2026 };
    expect(appointmentAloud('de', { title: 'Zahnarzt', day: '2026-10-28', time: '10:00', weekdays: null, place: 'Praxis Weber', remindBefore: [60], nextDay: '2026-10-28' }, o)).toBe(
      'Zahnarzt: Mittwoch, 28. Oktober, 10 Uhr, Praxis Weber.',
    );
    expect(appointmentAloud('de', { title: 'Physiotherapie', day: '2026-10-26', time: '08:30', weekdays: [1, 4], remindBefore: [], nextDay: '2026-10-29' }, o)).toBe(
      'Physiotherapie: jeden Montag und Donnerstag um 8:30 Uhr. Das nächste Mal: Donnerstag, 29. Oktober.',
    );
    expect(appointmentAloud('de', { title: 'Friseur', day: '2026-10-24', time: '10:00', weekdays: null, remindBefore: [], nextDay: null }, o)).toBe('Friseur: Samstag, 24. Oktober, 10 Uhr. Der Termin ist vorbei.');
  });

  it("says at a reminder's time how far off the appointment is", () => {
    const z = { time: '10:00', place: 'Praxis Weber' };
    expect([0, 15, 60, 120, 1440, 2880].map((b) => appointmentPrompt('de', z, b))).toEqual([
      'Der Termin ist jetzt, um 10 Uhr, Praxis Weber.',
      'Der Termin ist in 15 Minuten, um 10 Uhr, Praxis Weber.',
      'Der Termin ist in einer Stunde, um 10 Uhr, Praxis Weber.',
      'Der Termin ist in 2 Stunden, um 10 Uhr, Praxis Weber.',
      'Der Termin ist morgen um 10 Uhr, Praxis Weber.',
      'Der Termin ist in 2 Tagen um 10 Uhr, Praxis Weber.',
    ]);
    expect([0, 1440].map((b) => appointmentPrompt('de', { time: null }, b))).toEqual(['Der Termin ist heute.', 'Der Termin ist morgen.']);
    expect(appointmentPrompt('en', { time: '08:30' }, 60)).toBe('The appointment is in an hour, at 8:30.');
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
