/**
 * Commands by voice: CR-17 (the voice help matrix, Appendix D), the contexts, and lookup's corpora (what whisper heard
 * of the owner's recordings and of a synthetic set): no near miss, number or dictation may act.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type CommandContext, holdsHelpWord, match, phrases } from '../src/commands.ts';
import { judgeTranscript } from '../src/filters.ts';
import { normalise } from '../src/normalise.ts';
import { PHRASES } from './lookup-phrases.ts';

const act = (text: string, lang: 'de' | 'en' = 'de', ctx: CommandContext = 'global') => match(text, lang, ctx);

describe('CR-17: the voice help matrix', () => {
  it('the exact help phrases send at once, in every context', () => {
    for (const ctx of ['global', 'confirm', 'reminder'] as const) {
      for (const t of ['Hilfe', 'Hilfe!', 'Ich brauche Hilfe.', 'Hilferuf', 'Ich brauche noch Hilfe']) expect(act(t, 'de', ctx)).toEqual({ kind: 'command', intent: 'help' });
      for (const t of ['Help!', 'I need help', 'Call for help', 'I still need help.']) expect(act(t, 'en', ctx)).toEqual({ kind: 'command', intent: 'help' });
    }
  });

  it('a help word in a longer utterance asks, and so does a near match; nothing sends', () => {
    for (const t of ['Kann mir jemand beim Anziehen helfen?', 'Hilf mir', 'Helft mir bitte', 'Notfall!', 'Ich brauche Hilfe beim Einkaufen', 'Helferuf'])
      expect(act(t)).toEqual({ kind: 'ask', reason: 'help_word' });
    expect(act('Hilde')).toEqual({ kind: 'ask', reason: 'help_near' });
    expect(act('Hilve')).toEqual({ kind: 'ask', reason: 'help_near' });
    for (const t of ['Help me, please', 'This is an emergency', 'I need help with the shopping']) expect(act(t, 'en')).toEqual({ kind: 'ask', reason: 'help_word' });
  });

  it('look-alikes of other words do nothing', () => {
    for (const t of ['Halt mir bitte die Tür auf', 'Lauter Unsinn heute im Fernsehen', 'Ja, aber erst später', 'Zurück vom Arzt bin ich gegen Mittag', 'Hallo', 'Elfe'])
      expect(act(t)).toEqual({ kind: 'none' });
    // Two edits from "help" would have asked after "Hello" (lookup): one is the tolerance for short phrases.
    for (const t of ['Hello', 'Stop by the bakery later', 'Back from the doctor at noon', 'Yes, but later']) expect(act(t, 'en')).toEqual({ kind: 'none' });
  });

  it('no command but help holds a help word ("Was kann ich hier tun?")', () => {
    for (const lang of ['de', 'en'] as const)
      for (const ctx of ['global', 'confirm', 'reminder'] as const)
        for (const p of phrases(lang, ctx).filter((x) => x.intent !== 'help')) expect(holdsHelpWord(p.phrase, lang), `${lang} ${p.phrase}`).toBe(false);
  });
});

describe('contexts', () => {
  it('yes and no mean something only where a question waits', () => {
    expect(act('Ja')).toEqual({ kind: 'none' });
    expect(act('Ja.', 'de', 'confirm')).toEqual({ kind: 'command', intent: 'yes' });
    expect(act('Nein, danke', 'de', 'confirm')).toEqual({ kind: 'command', intent: 'no' });
    expect(act('Yes please', 'en', 'confirm')).toEqual({ kind: 'command', intent: 'yes' });
  });

  it('a reminder is answered by voice: Erledigt, Später, Nein, Hilfe holen', () => {
    expect(act('Ja', 'de', 'reminder')).toEqual({ kind: 'command', intent: 'done' });
    expect(act('Erledigt!', 'de', 'reminder')).toEqual({ kind: 'command', intent: 'done' });
    expect(act('Später', 'de', 'reminder')).toEqual({ kind: 'command', intent: 'later' });
    expect(act('Nein', 'de', 'reminder')).toEqual({ kind: 'command', intent: 'no' });
    expect(act('Hilfe holen', 'de', 'reminder')).toEqual({ kind: 'command', intent: 'help' });
    expect(act('Später')).toEqual({ kind: 'none' });
  });

  it('LIVE mode is switched and paused by voice, in either language, everywhere', () => {
    for (const ctx of ['global', 'confirm', 'reminder'] as const) {
      expect(act('LIVE an', 'de', ctx)).toEqual({ kind: 'command', intent: 'liveOn' });
      expect(act('Live-Modus aus.', 'de', ctx)).toEqual({ kind: 'command', intent: 'liveOff' });
      expect(act('Pause', 'de', ctx)).toEqual({ kind: 'command', intent: 'pause' });
      expect(act('Mach weiter', 'de', ctx)).toEqual({ kind: 'command', intent: 'resume' });
    }
    expect(act('Live mode on', 'en')).toEqual({ kind: 'command', intent: 'liveOn' });
    expect(act('Go on', 'en')).toEqual({ kind: 'command', intent: 'resume' });
    // Only the whole utterance: talking about a break does not pause anything.
    expect(act('Wir machen gleich eine Pause')).toEqual({ kind: 'none' });
  });

  it('what works everywhere works in every context', () => {
    for (const ctx of ['global', 'confirm', 'reminder'] as const) {
      expect(act('Wie spät ist es?', 'de', ctx)).toEqual({ kind: 'command', intent: 'time' });
      expect(act('Stopp!', 'de', ctx)).toEqual({ kind: 'command', intent: 'stop' });
      expect(act('Wie bitte?', 'de', ctx)).toEqual({ kind: 'command', intent: 'repeat' });
      expect(act('Was kann ich hier tun?', 'de', ctx)).toEqual({ kind: 'command', intent: 'whatCanIDo' });
    }
  });
});

describe("lookup's corpora (what whisper heard)", () => {
  const { rows } = JSON.parse(readFileSync(new URL('./fixtures/heard.json', import.meta.url), 'utf8')) as { rows: { id: string; set: string; condition: string; heard: string }[] };
  const byId = new Map(PHRASES.map((p) => [p.id, p]));
  const results = rows.map((r) => {
    const p = byId.get(r.id)!;
    const ctx: CommandContext = p.intent === 'yes' || p.intent === 'no' ? 'confirm' : 'global';
    return { r, p, m: match(r.heard, p.lang as 'de' | 'en', ctx) };
  });

  it('no near miss, number or dictation acts', () => {
    const acted = results.filter((x) => x.p.kind !== 'command' && x.m.kind === 'command');
    expect(acted.map((x) => `${x.r.id}: ${x.r.heard}`)).toEqual([]);
    expect(results.filter((x) => x.p.kind !== 'command').length).toBeGreaterThan(250);
  });

  it('every help utterance sends or asks', () => {
    const help = results.filter((x) => x.p.intent === 'help');
    expect(help.length).toBeGreaterThan(20);
    for (const x of help) expect(x.m.kind === 'ask' || (x.m.kind === 'command' && x.m.intent === 'help'), x.r.heard).toBe(true);
  });

  it('commands are recognised, but for the miss lookup measured', () => {
    const missed = results.filter((x) => x.p.kind === 'command' && x.p.intent !== 'help' && !(x.m.kind === 'command' && x.m.intent === x.p.intent));
    // The synthetic English "Quieter" came back as "Quater"; every recorded German command is right.
    expect([...new Set(missed.map((x) => x.r.id))]).toEqual(['en-cmd-quieter-1']);
  });
});

describe('normalising and filtering', () => {
  it('a time is a time, a date stays a date', () => {
    expect(normalise('Um 14.30 Uhr', 'de')).toBe('um 14:30 uhr');
    expect(normalise('Am 14.10.2026 um 9:05', 'de')).toBe('am 14 10 2026 um 9:05');
    expect(normalise('Zurück!', 'de')).toBe('zuruck');
  });

  it('drops what whisper writes into silence and noise, keeps what was said', () => {
    expect(judgeTranscript({ text: 'Untertitel im Auftrag des ZDF für funk, 2017' }, 'de')).toBe('hallucination');
    expect(judgeTranscript({ text: 'Thanks for watching!' }, 'en')).toBe('hallucination');
    expect(judgeTranscript({ text: '' }, 'de')).toBe('silence');
    expect(judgeTranscript({ text: 'ja ja ja ja ja ja ja', segments: [{ compression_ratio: 3.1 }] }, 'de')).toBe('hallucination');
    expect(judgeTranscript({ text: 'Hilfe', segments: [{ no_speech_prob: 0.9, avg_logprob: -1.4 }] }, 'de')).toBe('silence');
    expect(judgeTranscript({ text: 'Vielen Dank.', segments: [{ no_speech_prob: 0.4, avg_logprob: -0.5 }] }, 'de')).toBe('hallucination');
    expect(judgeTranscript({ text: 'Vielen Dank.', segments: [{ no_speech_prob: 0.01, avg_logprob: -0.2 }] }, 'de')).toBe('speech');
    expect(judgeTranscript({ text: 'Hilfe', segments: [{ no_speech_prob: 0.02, avg_logprob: -0.3, compression_ratio: 0.6 }] }, 'de')).toBe('speech');
  });
});
