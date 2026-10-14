import { t } from '@ucap/shared';
import { describe, expect, it } from 'vitest';
import { announcements, type CareView } from '../src/care/client.ts';

const tr = (form: 'du' | 'Sie' = 'du') => (key: string, params?: Record<string, string | number | Date>) => t('de', key, params, form);
let id = 0;
const ev = (type: string, actor: string | null, data: Record<string, unknown> = {}, episode = 1) => ({ id: ++id, episode, type, at: '', actor: actor ? { id: actor, displayName: actor } : null, data });
const view = (events: ReturnType<typeof ev>[]): CareView => ({ id: 'r', status: 'open', episode: 1, acceptedBy: null, receivedAt: '', delayMs: 0, resolvedAt: null, sosNumber: '112', events });

describe('what the person hears about a help request', () => {
  it('says every step once, in order, in the words of the plan', () => {
    id = 0;
    const v = view([
      ev('created', 'Anna'),
      ev('alerted', null, { tier: 1 }),
      ev('delivered', 'Maria', { silenced: false, more: true }),
      ev('seen', 'Maria'),
      ev('declined', 'Maria', { more: true }),
      ev('escalated', null, { tier: 2, helperNames: ['Tom', 'Lena'] }),
      ev('accepted', 'Tom'),
      ev('message', 'Tom', { quick: 'minutes', minutes: 10 }),
      ev('resolved', 'Tom'),
    ]);
    expect(announcements(v, 2, { tr: tr(), lang: 'de', gesture: tr()('care.gesture.explore'), selfCancelled: () => false }).map((a) => a.text)).toEqual([
      'Das Gerät von Maria hat deinen Hilferuf erhalten.',
      'Maria hat deinen Hilferuf gesehen.',
      'Maria kann gerade nicht helfen. Ich frage weitere Helfer.',
      'Noch hat niemand angenommen. Ich benachrichtige jetzt auch Tom und Lena.',
      'Tom hat deinen Hilferuf angenommen.',
      'Tom sagt: „Ich bin in 10 Minuten da.“',
      'Tom hat deinen Hilferuf als erledigt markiert. Wenn du noch Hilfe brauchst, tippe zweimal auf das Hilfe-Feld.',
    ]);
  });

  it('promises no further helpers when there are none, and names the emergency number when nobody comes', () => {
    id = 0;
    const v = view([ev('declined', 'Maria', { more: false }), ev('exhausted', null), ev('delivered', 'Tom', { silenced: true, more: false })]);
    expect(announcements(v, 0, { tr: tr('Sie'), lang: 'de', gesture: '', selfCancelled: () => false }).map((a) => a.text)).toEqual([
      'Maria kann gerade nicht helfen.',
      'Bisher hat niemand Ihren Hilferuf angenommen. Er bleibt offen, und ich erinnere Ihre Helfer weiter. Im Notfall wählen Sie 112.',
      'Das Gerät von Tom hat Ihren Hilferuf erhalten, ist aber stummgeschaltet.',
    ]);
  });

  it('does not repeat a cancellation this device said itself, but tells of one from another device', () => {
    id = 0;
    const v = view([ev('cancelled', 'Anna')]);
    expect(announcements(v, 0, { tr: tr(), lang: 'de', gesture: '', selfCancelled: () => true })).toEqual([]);
    expect(announcements(v, 0, { tr: tr(), lang: 'de', gesture: '', selfCancelled: () => false }).map((a) => a.text)).toEqual(['Hilferuf abgebrochen. Ich sage deinen Helfern Bescheid.']);
  });

  it('never says that anyone is coming in its own words (CONCEPT §4): only a helper’s quoted reply may', () => {
    id = 0;
    const all = ['delivered', 'seen', 'accepted', 'declined', 'released', 'escalated', 'exhausted', 'unreachable', 'no_helpers', 'resolved', 'cancelled'].map((type) => ev(type, 'Maria', { helperNames: ['Tom'] }));
    const said = announcements(view(all), 0, { tr: tr(), lang: 'de', gesture: 'x', selfCancelled: () => false }).map((a) => a.text);
    for (const s of said) expect(s).not.toMatch(/\b(kommt|unterwegs|gleich da)\b/i);
    const quoted = announcements(view([ev('message', 'Maria', { quick: 'on_the_way' })]), 0, { tr: tr(), lang: 'de', gesture: '', selfCancelled: () => false });
    expect(quoted[0]!.text).toBe('Maria sagt: „Ich bin unterwegs.“');
  });
});
