import { t } from '@ucap/shared';
import { describe, expect, it } from 'vitest';
import { appsSentence, approvalSummary, overviewSummary } from '../src/people/summary.ts';

const tr = (lang: 'de' | 'en', form: 'du' | 'Sie' = 'du') => (key: string, params?: Record<string, string | number | Date>) => t(lang, key, params, form);

describe('what a helper may do, said the same way every time', () => {
  it('names the helper, what they may do, and that they may not read messages or notes', () => {
    expect(approvalSummary({ name: 'Maria', scopes: ['reminders.manage', 'care.respond'], lang: 'de', tr: tr('de') })).toBe(
      'Maria möchte dir helfen. Maria darf auf deine Hilferufe antworten und deine Erinnerungen anlegen und ändern. Maria darf nicht deine Nachrichten lesen oder deine Notizen lesen.',
    );
    expect(approvalSummary({ name: 'Maria', scopes: ['care.respond'], lang: 'de', tr: tr('de', 'Sie') })).toBe(
      'Maria möchte Ihnen helfen. Maria darf auf Ihre Hilferufe antworten. Maria darf nicht Ihre Nachrichten lesen oder Ihre Notizen lesen.',
    );
    expect(approvalSummary({ name: 'Maria', scopes: ['care.respond'], lang: 'en', tr: tr('en') })).toBe(
      'Maria would like to help you. Maria may respond to your help requests. Maria may not read your messages or read your notes.',
    );
  });

  it('reads the access overview: every helper, who waits, and what nobody may do', () => {
    expect(overviewSummary({ helpers: [{ name: 'Maria', scopes: ['care.respond'] }, { name: 'Tom', scopes: ['care.respond', 'device.configure'] }], pending: ['Lena'], lang: 'de', tr: tr('de') })).toBe(
      'Maria darf auf deine Hilferufe antworten. Tom darf auf deine Hilferufe antworten und die Bedienung deiner Geräte einstellen. Dafür sieht Tom, welche Apps auf deinen Geräten sind. Lena wartet auf deine Bestätigung. Niemand darf deine Nachrichten lesen oder deine Notizen lesen.',
    );
    expect(overviewSummary({ helpers: [], pending: [], lang: 'de', tr: tr('de') })).toBe('Noch hilft dir niemand. Niemand darf deine Nachrichten lesen oder deine Notizen lesen.');
  });

  it('names "Kontakte verwalten" (K6) among what a helper may do, and still that nobody reads messages', () => {
    expect(approvalSummary({ name: 'Maria', scopes: ['contacts.manage', 'care.respond'], lang: 'de', tr: tr('de') })).toBe(
      'Maria möchte dir helfen. Maria darf auf deine Hilferufe antworten und deine Kontakte anlegen und ändern. Maria darf nicht deine Nachrichten lesen oder deine Notizen lesen.',
    );
    expect(approvalSummary({ name: 'Maria', scopes: ['contacts.manage'], lang: 'de', tr: tr('de', 'Sie') })).toBe(
      'Maria möchte Ihnen helfen. Maria darf Ihre Kontakte anlegen und ändern. Maria darf nicht Ihre Nachrichten lesen oder Ihre Notizen lesen.',
    );
    expect(overviewSummary({ helpers: [{ name: 'Maria', scopes: ['contacts.manage'] }], pending: [], lang: 'en', tr: tr('en') })).toBe(
      'Maria may create and change your contacts. Nobody may read your messages or read your notes.',
    );
  });

  it('names "Termine und Aufgaben verwalten" (K7) too, and still that nobody reads messages or notes', () => {
    expect(approvalSummary({ name: 'Maria', scopes: ['agenda.manage', 'contacts.manage', 'care.respond'], lang: 'de', tr: tr('de') })).toBe(
      'Maria möchte dir helfen. Maria darf auf deine Hilferufe antworten, deine Kontakte anlegen und ändern und deine Termine und Aufgaben anlegen und ändern. Maria darf nicht deine Nachrichten lesen oder deine Notizen lesen.',
    );
    expect(approvalSummary({ name: 'Maria', scopes: ['agenda.manage'], lang: 'de', tr: tr('de', 'Sie') })).toBe(
      'Maria möchte Ihnen helfen. Maria darf Ihre Termine und Aufgaben anlegen und ändern. Maria darf nicht Ihre Nachrichten lesen oder Ihre Notizen lesen.',
    );
    expect(overviewSummary({ helpers: [{ name: 'Maria', scopes: ['agenda.manage'] }], pending: [], lang: 'en', tr: tr('en') })).toBe(
      'Maria may create and change your appointments and tasks. Nobody may read your messages or read your notes.',
    );
  });

  it('says that setting up the devices or the kiosk shows the person’s apps, wherever it is granted (the owner, 2026-10-28)', () => {
    expect(approvalSummary({ name: 'Maria', scopes: ['device.kiosk'], lang: 'de', tr: tr('de') })).toBe(
      'Maria möchte dir helfen. Maria darf deine Geräte im Kiosk-Modus sperren und wieder öffnen. Dafür sieht Maria, welche Apps auf deinen Geräten sind. Maria darf nicht deine Nachrichten lesen oder deine Notizen lesen.',
    );
    expect(approvalSummary({ name: 'Maria', scopes: ['device.configure', 'device.kiosk'], lang: 'de', tr: tr('de', 'Sie') })).toBe(
      'Maria möchte Ihnen helfen. Maria darf die Bedienung Ihrer Geräte einstellen und Ihre Geräte im Kiosk-Modus sperren und wieder öffnen. Dafür sieht Maria, welche Apps auf Ihren Geräten sind. Maria darf nicht Ihre Nachrichten lesen oder Ihre Notizen lesen.',
    );
    expect(approvalSummary({ name: 'Maria', scopes: ['device.configure'], lang: 'en', tr: tr('en') })).toBe(
      'Maria would like to help you. Maria may set up how your devices work. For that, Maria sees which apps are on your devices. Maria may not read your messages or read your notes.',
    );
    // A representative's news adds it to what the helper may do now; other permissions show no apps.
    expect(appsSentence({ name: 'Lena', scopes: ['care.respond', 'device.configure'], tr: tr('de') })).toBe('Dafür sieht Lena, welche Apps auf deinen Geräten sind.');
    expect(appsSentence({ name: 'Lena', scopes: ['care.respond', 'reminders.manage', 'contacts.manage', 'agenda.manage'], tr: tr('de') })).toBe('');
  });
});
