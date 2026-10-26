/**
 * One-time codes (docs/plan-m3.md, K8: "One-time codes are never said by themselves"): the codes services send, in
 * German and English, and what only looks like one.
 */
import { describe, expect, it } from 'vitest';
import { oneTimeCode } from '../src/messaging/codes.ts';

describe('one-time codes', () => {
  it('finds the codes services send', () => {
    for (const text of [
      'Dein WhatsApp-Code: 123-456. Du kannst auch auf diesen Link tippen, um deine Telefonnummer zu verifizieren.',
      'G-482913 ist dein Google-Bestätigungscode.',
      'Login code: 12345. Do not give this code to anyone, even if they say they are from Telegram!',
      'Ihre mTAN für die Überweisung an Max Muster über 120,00 EUR lautet: 482913',
      '123456 ist Ihr Amazon-Einmalkennwort. Geben Sie es nicht weiter.',
      'Your verification code is 482913',
      'PayPal: Ihr Sicherheitscode ist 123456. Ihr Code läuft in 10 Minuten ab.',
      'Ihre PIN lautet 4711',
      'Dein Apple-ID-Code lautet: 123 456. Teile ihn mit niemandem.',
      'Abholcode für Ihre Packstation: 815493',
      'Your one-time password is 482913',
      'OTP 4829 for your login',
      'Ihr Code: X7KQ9P',
      'Ihre pushTAN lautet 334198.',
      'Der Code für die Haustür ist 4711, komm einfach rein.',
    ])
      expect(oneTimeCode(text), text).toBe(true);
  });

  it('not what only looks like one', () => {
    for (const text of [
      'Ihre Bestellung 302-1234567-1234567 wurde versandt.',
      'Treffen wir uns um 1430 am Bahnhof?',
      'Kommst du morgen? Ruf mich an: 0170 1234567',
      'Scanne den QR-Code am Eingang, dein Tisch ist 1234.',
      'Der Gutscheincode SOMMER2026 gilt bis Sonntag.',
      'Fehlercode 4012: bitte später noch einmal versuchen.',
      'Please enter your zip code 10115 again.',
      'Der Termin ist am 26.10.2026 um 10:00 Uhr.',
      'Hallo, wie geht es dir? Ich bringe Kuchen mit.',
      'Die Rechnung über 1234,56 € ist bezahlt. Kundennummer 12345678.',
      'Code ohne Zahl',
      'Meine Tante kommt um 1500.',
    ])
      expect(oneTimeCode(text), text).toBe(false);
  });
});
