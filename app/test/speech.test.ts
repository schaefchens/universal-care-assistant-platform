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
});
