/**
 * The person's voices (docs/plan.md, S7): the voices they may choose, their choice for answers and for reading
 * aloud, samples to choose by listening, and speech in the chosen voice. Clips play through HTMLAudioElement (not
 * Web Audio: lookup gotchas). Whenever the chosen voice may not or cannot speak, the device voice does, and the reason
 * is said once per session, never silently (Appendix I). With a screen reader, speech stays with the screen reader.
 * Care and system speech never come here: they are always the device's own voice.
 */
import { record } from '../debug.ts';
import type { Session } from '../identity/account.ts';
import { ceremony } from '../identity/ceremony.ts';

export interface VoiceOption {
  ref: string;
  label: string;
  provider: string | null;
  location: 'device' | 'server' | 'operator_lan' | 'external';
  langs: string[];
  /** What the operator lets it speak: answers (with reminders) and reading aloud. */
  usableFor: (keyof VoiceSettings)[];
  consentNeeded: boolean;
  sampleOnly: boolean;
}

export interface VoiceSettings {
  reply: string;
  reading: string;
}

export type Rendered = { device: false; segments: { url: string; ms: number | null }[] } | { device: false; pending: true } | { device: true; reason: string };

export function voicesApi(session: Session) {
  return {
    list: (lang: string) => session.call<{ voices: VoiceOption[]; settings: VoiceSettings; chosen: boolean }>(`/api/v1/speech/voices?lang=${lang}`),
    choose: (patch: Partial<VoiceSettings>, consent = false) => session.call<VoiceSettings>('/api/v1/speech/settings', { method: 'PUT', body: { ...patch, consent } }),
    sample: (ref: string) => session.call<Rendered>('/api/v1/speech/samples', { method: 'POST', body: { ref } }),
    render: (text: string, purpose: 'reply' | 'reading' | 'reminder', background = false) => session.call<Rendered>('/api/v1/speech/render', { method: 'POST', body: { text, purpose, background } }),
    consents: () => session.call<{ consents: { providerId: string; name: string; classes: string[]; grantedAt: string }[] }>('/api/v1/speech/consents'),
    revoke: (providerId: string) => session.call<void>(`/api/v1/speech/consents/${providerId}`, { method: 'DELETE' }),
  };
}

/** One clip at a time, in order; stopping drops the rest. */
export class ClipPlayer {
  private audio: HTMLAudioElement | null = null;
  private token = 0;

  /** Something is playing now (a clip of the person's voice, a recording). */
  get playing(): boolean {
    return this.audio !== null && !this.audio.paused && !this.audio.ended;
  }

  async play(urls: string[]): Promise<boolean> {
    this.stop();
    const mine = ++this.token;
    for (const url of urls) {
      if (mine !== this.token) return false;
      const a = new Audio(url);
      this.audio = a;
      const ended = await new Promise<boolean>((resolve) => {
        a.onended = () => resolve(true);
        a.onerror = () => resolve(false);
        void a.play().catch(() => resolve(false));
      });
      if (!ended) return false;
    }
    return mine === this.token;
  }

  stop() {
    this.token++;
    this.audio?.pause();
    this.audio = null;
  }
}

const said = new Set<string>();

/**
 * Says `text` in the person's voice for `purpose`; false when the device voice must say it instead (and then the
 * caller does). `notice` is told once per session why the chosen voice could not speak.
 */
export async function speakAs(o: { session: Session; text: string; purpose: 'reply' | 'reading' | 'reminder'; player: ClipPlayer; screenReader: boolean; notice: (reason: string) => void }): Promise<boolean> {
  // While recovery words are shown, nothing goes to a server voice (Appendix C: the ceremony is isolated).
  if (o.screenReader || ceremony.active) return false;
  let r: Rendered;
  try {
    r = await voicesApi(o.session).render(o.text, o.purpose);
  } catch {
    // Offline or the assistant stopped: the device voice, quietly, as when nothing was chosen.
    return false;
  }
  if (r.device) {
    if (r.reason !== 'device' && !said.has(r.reason)) {
      said.add(r.reason);
      o.notice(r.reason);
    }
    return false;
  }
  if (!('segments' in r)) return false;
  // Kept in the debug record as the device voice's speech is: what the person heard, in whichever voice.
  record('spoken', { channel: o.purpose, text: o.text });
  return o.player.play(r.segments.map((s) => `${o.session.ref.serverUrl}${s.url}`));
}
