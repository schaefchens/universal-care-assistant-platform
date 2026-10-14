/**
 * Speech output in channels, so exploring never cuts off what matters (the safety review: labels flushed care
 * announcements in lookup's shell).
 *
 * | Channel | Priority | Rules |
 * |---|---|---|
 * | care | highest | queued, never cut by anything but an explicit "Stopp" |
 * | system | | confirmations, screen changes, "Wo bin ich?" |
 * | assistant | | replies; any touch interrupts it |
 * | label | lowest | area labels; a new label replaces the old one; dropped while something more important speaks |
 *
 * Backends:
 * - native: the device voice (DeviceTts, local installed voices only);
 * - browser: speechSynthesis with `localService` voices only (network voices send the text away);
 * - with a screen reader running: live regions, so TalkBack speaks it in its own voice and queue (TalkBack and the app
 *   share one TTS engine: measured, the app's replies were cut off).
 */
import { DeviceTts, has } from '../native/plugins.ts';

export type Channel = 'care' | 'system' | 'assistant' | 'label';
const PRIORITY: Record<Channel, number> = { care: 3, system: 2, assistant: 1, label: 0 };

export interface Utterance {
  text: string;
  lang: string;
  channel: Channel;
}

export interface SpeechBackend {
  readonly kind: 'device' | 'web' | 'live' | 'none';
  speak(u: Utterance, rate: number): Promise<void>;
  stop(): void;
}

function liveRegion(u: Utterance) {
  const el = document.getElementById(u.channel === 'care' || u.channel === 'system' ? 'live-assertive' : 'live-polite');
  if (!el) return;
  // Clearing first makes a repeated text count as new.
  el.textContent = '';
  setTimeout(() => (el.textContent = u.text), 30);
}

export const liveBackend: SpeechBackend = {
  kind: 'live',
  async speak(u) {
    liveRegion(u);
  },
  stop() {},
};

const BCP47: Record<string, string> = { de: 'de-DE', en: 'en-GB' };

export function deviceBackend(lang?: string): SpeechBackend {
  // The first utterance of a cold engine took 2.4 s on the emulator: load the voice before anyone waits for it.
  if (lang) void DeviceTts.warmup({ lang: BCP47[lang] ?? lang }).catch(() => {});
  return {
    kind: 'device',
    async speak(u, rate) {
      await DeviceTts.speak({ text: u.text, lang: BCP47[u.lang] ?? u.lang, rate });
    },
    stop() {
      void DeviceTts.stop().catch(() => {});
    },
  };
}

/** speechSynthesis restricted to local voices; null when the browser has none for the language. */
export function webBackend(lang: string): SpeechBackend | null {
  if (typeof speechSynthesis === 'undefined') return null;
  const pick = () =>
    speechSynthesis
      .getVoices()
      .filter((v) => v.localService && v.lang.toLowerCase().startsWith(lang))
      .sort((a, b) => Number(b.default) - Number(a.default))[0];
  if (!pick() && speechSynthesis.getVoices().length > 0) return null;
  return {
    kind: 'web',
    speak(u, rate) {
      return new Promise<void>((resolve) => {
        const voice = pick();
        if (!voice) return resolve();
        const utt = new SpeechSynthesisUtterance(u.text);
        utt.voice = voice;
        utt.lang = voice.lang;
        utt.rate = rate;
        utt.onend = () => resolve();
        utt.onerror = () => resolve();
        speechSynthesis.speak(utt);
      });
    },
    stop() {
      speechSynthesis.cancel();
    },
  };
}

export class SpeechOut {
  private backend: SpeechBackend;
  private current: Utterance | null = null;
  private readonly queue: Utterance[] = [];
  private rate = 1;

  constructor(backend: SpeechBackend) {
    this.backend = backend;
  }

  setBackend(b: SpeechBackend) {
    this.stopAll();
    this.backend = b;
  }

  setRate(rate: number) {
    this.rate = rate;
  }

  get kind() {
    return this.backend.kind;
  }

  say(text: string, lang: string, channel: Channel): void {
    const u: Utterance = { text, lang, channel };
    const cur = this.current;
    if (cur && PRIORITY[cur.channel] > PRIORITY[channel]) {
      if (channel !== 'label') this.enqueue(u); // labels are only useful while the finger is there
      return;
    }
    if (cur && (cur.channel === 'label' || PRIORITY[cur.channel] < PRIORITY[channel])) {
      this.interrupt();
    } else if (cur) {
      // Same priority: care and system queue behind each other, assistant text replaces assistant text.
      if (channel === 'care' || channel === 'system') {
        this.enqueue(u);
        return;
      }
      this.interrupt();
    }
    this.play(u);
  }

  /** Stops one channel's current utterance and its queue (e.g. the label when the finger moves on). */
  stop(channel: Channel): void {
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.channel === channel) this.queue.splice(i, 1);
    if (this.current?.channel === channel) {
      this.interrupt();
      this.next();
    }
  }

  /** "Stopp": everything, care included. */
  stopAll(): void {
    this.queue.length = 0;
    this.interrupt();
  }

  get speaking(): Channel | null {
    return this.current?.channel ?? null;
  }

  private enqueue(u: Utterance) {
    this.queue.push(u);
    this.queue.sort((a, b) => PRIORITY[b.channel] - PRIORITY[a.channel]);
  }

  private interrupt() {
    if (!this.current) return;
    this.current = null;
    this.backend.stop();
  }

  private play(u: Utterance) {
    this.current = u;
    void this.backend
      .speak(u, this.rate)
      .catch(() => {})
      .finally(() => {
        if (this.current === u) {
          this.current = null;
          this.next();
        }
      });
  }

  private next() {
    const u = this.queue.shift();
    if (u) this.play(u);
  }
}

export function pickBackend(o: { screenReader: boolean; lang: string }): SpeechBackend {
  if (o.screenReader) return liveBackend;
  if (has('DeviceTts')) return deviceBackend(o.lang);
  return webBackend(o.lang) ?? liveBackend;
}
