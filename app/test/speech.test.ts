/**
 * UI-07 (docs/plan.md, Appendix J): a care announcement survives exploration. Labels never cut care or system speech;
 * only an explicit "Stopp" stops care.
 */
import { describe, expect, it } from 'vitest';
import { type SpeechBackend, SpeechOut, type Utterance } from '../src/audio/speech.ts';

function fakeBackend() {
  const log: string[] = [];
  let finish: (() => void) | null = null;
  const backend: SpeechBackend = {
    kind: 'device',
    speak(u: Utterance) {
      log.push(`start ${u.channel}: ${u.text}`);
      return new Promise<void>((resolve) => {
        finish = () => {
          log.push(`end ${u.channel}: ${u.text}`);
          resolve();
        };
      });
    },
    stop() {
      log.push('stop');
      const f = finish;
      finish = null;
      f?.();
    },
  };
  return { backend, log, done: async () => {
    const f = finish;
    finish = null;
    f?.();
    await new Promise((r) => setTimeout(r, 0));
  } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('a new action of the person', () => {
  it('drops what was said about the last ones, queued or being said, and says the new one at once', async () => {
    const f = fakeBackend();
    const s = new SpeechOut(f.backend);
    s.say('Einstellungen. 12 Felder.', 'de', 'system');
    s.say('Gespeichert.', 'de', 'system');
    s.say('Das ist die Antwort.', 'de', 'assistant');
    s.acted();
    s.say('Startseite. 4 Felder.', 'de', 'system');
    await tick();
    expect(f.log).toEqual(['start system: Einstellungen. 12 Felder.', 'stop', 'end system: Einstellungen. 12 Felder.', 'start system: Startseite. 4 Felder.']);
  });

  it('keeps help requests and news from elsewhere: said to their end, then what the person does now', async () => {
    const f = fakeBackend();
    const s = new SpeechOut(f.backend);
    s.say('Neue Nachricht von Anna.', 'de', 'notice');
    s.say('Dein Hilferuf wurde gesendet.', 'de', 'care');
    s.say('Notizen. 3 Notizen.', 'de', 'system');
    s.acted();
    s.say('Startseite. 4 Felder.', 'de', 'system');
    await tick();
    // Care first (it took over from the news, which waits), then the news again, then the present.
    for (let i = 0; i < 3; i++) await f.done();
    expect(f.log.filter((l) => l.startsWith('start'))).toEqual([
      'start notice: Neue Nachricht von Anna.',
      'start care: Dein Hilferuf wurde gesendet.',
      'start notice: Neue Nachricht von Anna.',
      'start system: Startseite. 4 Felder.',
    ]);
  });
});

describe('speech channels', () => {
  it('drops a label while care speaks, and care is never cut by exploring', async () => {
    const f = fakeBackend();
    const s = new SpeechOut(f.backend);
    s.say('Dein Hilferuf wurde gesendet.', 'de', 'care');
    s.say('Nachrichten.', 'de', 'label');
    s.stop('label');
    await tick();
    expect(s.speaking).toBe('care');
    expect(f.log).toEqual(['start care: Dein Hilferuf wurde gesendet.']);
  });

  it('a care announcement interrupts a label at once', async () => {
    const f = fakeBackend();
    const s = new SpeechOut(f.backend);
    s.say('Nachrichten.', 'de', 'label');
    s.say('Maria hat deinen Hilferuf angenommen.', 'de', 'care');
    await tick();
    expect(f.log).toEqual(['start label: Nachrichten.', 'stop', 'end label: Nachrichten.', 'start care: Maria hat deinen Hilferuf angenommen.']);
  });

  it('care queues behind care, and system behind care', async () => {
    const f = fakeBackend();
    const s = new SpeechOut(f.backend);
    s.say('A', 'de', 'care');
    s.say('B', 'de', 'care');
    s.say('C', 'de', 'system');
    await f.done();
    await f.done();
    await f.done();
    expect(f.log.filter((l) => l.startsWith('start'))).toEqual(['start care: A', 'start care: B', 'start system: C']);
  });

  it('a new label replaces the previous label; the assistant is interrupted by touch, not by labels it outranks', async () => {
    const f = fakeBackend();
    const s = new SpeechOut(f.backend);
    s.say('Nachrichten.', 'de', 'label');
    s.say('Assistent.', 'de', 'label');
    await tick();
    expect(f.log.filter((l) => l.startsWith('start'))).toEqual(['start label: Nachrichten.', 'start label: Assistent.']);
    s.say('Hier ist die Antwort.', 'de', 'assistant');
    s.say('Notizen.', 'de', 'label');
    await tick();
    expect(s.speaking).toBe('assistant');
    s.stop('assistant');
    await tick();
    expect(s.speaking).toBeNull();
  });

  it('"Stopp" stops everything, care included, and clears the queue', async () => {
    const f = fakeBackend();
    const s = new SpeechOut(f.backend);
    s.say('A', 'de', 'care');
    s.say('B', 'de', 'care');
    s.stopAll();
    await tick();
    expect(s.speaking).toBeNull();
    expect(f.log.filter((l) => l.startsWith('start'))).toEqual(['start care: A']);
  });

  it('says when an utterance ended, or was cut off, so an answer\'s parts go out one after another', async () => {
    const f = fakeBackend();
    const out = new SpeechOut(f.backend);
    const first = out.sayAndWait('Erster Satz.', 'de', 'assistant');
    await tick();
    await f.done();
    expect(await first).toBe(true);
    const second = out.sayAndWait('Zweiter Satz.', 'de', 'assistant');
    await tick();
    // A touch interrupts the assistant: the part was cut off.
    out.stop('assistant');
    expect(await second).toBe(false);
    // A label while care speaks is dropped, and says so.
    void out.sayAndWait('Hilferuf wird gesendet.', 'de', 'care');
    await tick();
    expect(await out.sayAndWait('Nachrichten', 'de', 'label')).toBe(false);
  });
});
