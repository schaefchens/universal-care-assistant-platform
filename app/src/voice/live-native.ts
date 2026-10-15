/**
 * LIVE mode's capture in the app (docs/plan-m2.md, L2): VoiceCapturePlugin.java, a foreground service with the keyword
 * spotter on the device. Its model (Vosk's small German one) comes from the UCAP server once, checked by its digest;
 * a server without it leaves the gate to touch alone, and that is said.
 */
import type { PluginListenerHandle } from '@capacitor/core';
import { CATALOGS } from '@ucap/shared';
import { keywordGrammar } from '@ucap/speech-text';
import type { Session } from '../identity/account.ts';
import { VoiceCapture } from '../native/plugins.ts';
import type { CaptureEvents, LiveCapture } from './live.ts';

/**
 * How sure the spotter must be of the keyword, and how many ordinary words stand beside it in its grammar (docs/spikes/
 * m2.md: at 0.6 with 1000 words "Hanna" was heard in 42 of 45 recordings and woke nobody in an hour of speech).
 */
export const KEYWORD_THRESHOLD = 0.6;
export const GRAMMAR_WORDS = 1000;

const fromBase64 = (b64: string): Uint8Array<ArrayBuffer> => {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/** The keyword model on this device, fetched from the server if needed; null when the server has none. */
async function model(session: Session, lang: 'de' | 'en'): Promise<string | null> {
  const list = await session.call<{ models: { id: string; lang: string; dir: string; sha256: string }[] }>('/api/v1/assistant/keyword-models');
  const m = list.models.find((x) => x.lang === lang) ?? null;
  if (!m) return null;
  const r = await VoiceCapture.prepare({ id: m.id, url: `${session.ref.serverUrl}/api/v1/assistant/keyword-models/${m.id}`, sha256: m.sha256, token: await session.accessToken(), dir: m.dir });
  return r.path;
}

export function nativeLiveCapture(o: { session: () => Session | null; lang: () => 'de' | 'en'; notice: () => { title: string; text: string }; onNoModel: () => void }): LiveCapture {
  let handles: PluginListenerHandle[] = [];
  const drop = () => {
    for (const h of handles) void h.remove();
    handles = [];
  };
  return {
    spotsKeyword: true,
    async start({ keywords }, on: CaptureEvents) {
      drop();
      const session = o.session();
      if (!session) throw new Error('no session');
      // German only for now: the spotter's model is German (an English one would come the same way).
      let path: string | null = null;
      if (keywords.length) {
        path = await model(session, o.lang()).catch(() => null);
        if (!path) o.onNoModel();
      }
      const words = path ? keywords : [];
      let ready: (ok: boolean) => void = () => {};
      let listening = false;
      const started = new Promise<boolean>((r) => (ready = r));
      handles = await Promise.all([
        VoiceCapture.addListener('listening', () => {
          listening = true;
          ready(true);
        }),
        VoiceCapture.addListener('keyword', (e) => on.keyword({ word: e.word, wav: e.wav ? fromBase64(e.wav) : null })),
        VoiceCapture.addListener('utterance', (e) => on.utterance({ wav: fromBase64(e.wav), ms: e.ms })),
        VoiceCapture.addListener('speech', () => on.speech()),
        VoiceCapture.addListener('stopped', (e) => {
          // Before it listened, the start itself fails (and says so); after, the controller is told.
          if (!listening) return ready(false);
          on.stopped(e.reason === 'unavailable' ? 'unavailable' : 'ended');
        }),
      ]);
      const { title, text } = o.notice();
      const grammar = words.length ? keywordGrammar(words[0]!, Object.values(CATALOGS.de), { words: GRAMMAR_WORDS }) : [];
      try {
        await VoiceCapture.start({ keywords: words, grammar, model: path, threshold: KEYWORD_THRESHOLD, title, text });
      } catch (e) {
        drop();
        throw e;
      }
      // Building the grammar takes seconds with many words; the microphone is open once it is ready.
      const ok = await Promise.race([started, new Promise<boolean>((r) => setTimeout(() => r(false), 20_000))]);
      if (!ok) {
        drop();
        void VoiceCapture.stop();
        throw new Error('not listening');
      }
    },
    setGate(open) {
      void VoiceCapture.setGate({ open });
    },
    stop() {
      drop();
      void VoiceCapture.stop();
    },
  };
}
