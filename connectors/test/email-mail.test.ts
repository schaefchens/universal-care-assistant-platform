/**
 * Emails as the connector reads them (docs/plan-m3.md, K3 "Text"; docs/spikes/m3.md, B), on invented .eml fixtures
 * (fixtures/email): the new text apart from the quote and the signature as each client writes them, HTML said UCAP's
 * own way, threads, newsletters, DMARC, attachments, old charsets, and a mail server's report that a mail came back.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMail, topicOf } from '../src/email/mail.ts';
import { htmlToText, quoteHeader, split } from '../src/email/text.ts';

const eml = (name: string) => readFileSync(new URL(`./fixtures/email/${name}.eml`, import.meta.url));

describe('an email, read', () => {
  it('a reply from each client: its new text, apart from the quote, in one thread', async () => {
    const fresh = { 'gmail-de': 'Samstag passt gut.', 'apple-de': 'Ja, gerne.', 'thunderbird-de': 'Okay, bis dann.', 'gmail-en': 'Saturday works.', 'outlook-en': 'Fine with me.', 'outlook-de-html-only': 'Gerne, bis Samstag.' };
    for (const [name, text] of Object.entries(fresh)) {
      const m = await parseMail(eml(name));
      expect(m.fresh, name).toBe(text);
      expect(m.quoted, name).not.toBe('');
      // The thread is the mail it answers: its first Reference.
      expect(m.threadRoot, name).toBe('anfrage@example.org');
      expect(m.messageId, name).toBe(`${name}@example.org`);
    }
    expect(quoteHeader((await parseMail(eml('gmail-de'))).quoted)).toBe('Am Mo., 12. Okt. 2026 um 10:00 Uhr schrieb Anna Beispiel');
    // Outlook's HTML-only reply: no line of dashes left from its rule.
    expect((await parseMail(eml('outlook-de-html-only'))).quoted).toMatch(/^> Von: Anna Beispiel/);
  });

  it('a signature after "-- " is kept apart', async () => {
    const m = await parseMail(eml('plain-signature'));
    expect(m.fresh).toBe('Hallo Clara,\n\nich komme am Samstag um 15 Uhr vorbei.\n\nLiebe Grüße\nAnna');
    expect(m.signature).toBe('Anna Beispiel\nTel. 0171 0000000');
  });

  it('a forward is said whole: what was sent on is the message', async () => {
    const m = await parseMail(eml('forward-de'));
    expect(m.fresh).toBe('Schau mal, das betrifft dich.\n\nBetreff: Termin\nDatum: Mon, 12 Oct 2026 10:00:00 +0200\nVon: Praxis Dr. Klein\nAn: Anna\n\nIhr Termin am Dienstag fällt aus.');
    expect(m.quoted).toBe('');
  });

  it("a newsletter's HTML: no hidden preheader, no address of anything, cells apart, links by their words; known as a list", async () => {
    const m = await parseMail(eml('newsletter-html-only'));
    expect(m.list).toBe(true);
    expect(m.fresh).not.toMatch(/Nur heute|https?:|example\.org|Angebote<|\.x\{/);
    expect(m.fresh).toContain('Tulpen · 3,49 €\n\nNarzissen · 2,99 €');
    expect(m.fresh).toContain('Jetzt ansehen');
    expect(m.fresh.split('\n')[0]).toBe('Gartenmarkt');
  });

  it('attachments by name and kind; a picture inside the HTML is none', async () => {
    const m = await parseMail(eml('attachments'));
    expect(m.attachments).toEqual([
      { name: 'Plan Samstag.pdf', kind: 'pdf' },
      { name: 'Einkauf.xlsx', kind: 'spreadsheet' },
    ]);
  });

  it('a sender whose domain failed DMARC at the provider is known as such', async () => {
    expect((await parseMail(eml('dmarc-fail'))).dmarcFail).toBe(true);
    expect((await parseMail(eml('gmail-de'))).dmarcFail).toBe(false);
  });

  it('old charsets and encoded words', async () => {
    const m = await parseMail(eml('latin1-encoded-words'));
    expect(m.from).toEqual({ address: 'juergen@example.org', name: 'Jürgen Müller' });
    expect(m.subject).toBe('Grüße aus der Straße');
    expect(m.fresh).toContain('die Straße ist wieder frei, wir können am Samstag kommen.');
  });

  it("a mail server's report: which mail came back, and why", async () => {
    expect((await parseMail(eml('bounce'))).bounce).toEqual({ original: 'sent-1@example.org', status: '5.1.1', action: 'failed' });
    expect((await parseMail(eml('gmail-de'))).bounce).toBeNull();
  });

  it("a thread's topic without what replies and forwards add", () => {
    expect(['Re: AW: Fwd: Termin', 'RE: Visit', 'Re[2]: Termin', 'Antwort: Besuch', 'WG: [Garten] Termin'].map(topicOf)).toEqual(['Termin', 'Visit', 'Termin', 'Besuch', '[Garten] Termin']);
  });

  it('HTML said: pictures by alt text, hidden parts gone, a link that is its own address unsaid', () => {
    expect(htmlToText('<p>Hallo <img src="x.png" alt="ein Herz"> <span style="display: none">versteckt</span><a href="https://x.example">https://x.example</a></p><p hidden>weg</p>')).toBe('Hallo ein Herz');
    expect(split('Neu\n\n___________\nVon: A\nGesendet: B\n\nAlt')).toEqual({ fresh: 'Neu', quoted: '___________\nVon: A\nGesendet: B\n\nAlt', signature: '' });
  });
});
