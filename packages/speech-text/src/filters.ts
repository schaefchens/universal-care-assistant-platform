/**
 * What speech recognition hands over, judged before anything acts on it (docs/plan.md, S8: "the hallucination
 * filter"). whisper writes words into silence and noise, mostly the credits of the subtitled television it learnt from
 * ("Untertitel im Auftrag des ZDF", "Thanks for watching"), and loops on noise. Such a transcript is dropped: the app
 * says it heard nothing, and nothing is matched, sent to a language model or kept.
 */
import { normalise } from './normalise.ts';

export interface SttSegment {
  text?: string;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
}

export type Heard = 'speech' | 'silence' | 'hallucination';

/** Never said to an assistant: subtitle credits and sign-offs of videos. */
const CREDITS = [/untertitel/, /im auftrag des (zdf|ard|br|ndr|wdr|swr|hr|mdr)/, /\bamara org\b/, /\bcopyright\b/, /\b(swr|wdr|ndr|br|mdr) \d{4}\b/, /\bsubtitles? by\b/, /furs zuschauen/, /for watching/, /zum nachsten mal/];

/** Could be said, and is also what whisper writes into silence: dropped only when whisper itself doubts it heard speech. */
const DOUBTFUL = new Set(['vielen dank', 'danke', 'danke schon', 'tschuss', 'thank you', 'thanks', 'you', 'bye', 'okay', 'ok', 'so']);

export function judgeTranscript(r: { text: string; segments?: SttSegment[] }, lang: 'de' | 'en'): Heard {
  const n = normalise(r.text, lang);
  if (!n) return 'silence';
  if (CREDITS.some((re) => re.test(n))) return 'hallucination';
  const segs = r.segments ?? [];
  // A repetition loop ("ja ja ja ja …") compresses far better than speech.
  if (segs.some((s) => (s.compression_ratio ?? 0) > 2.4)) return 'hallucination';
  // whisper's own doubt: no speech likely, and the words improbable.
  const doubt = segs.length > 0 && segs.every((s) => (s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1);
  if (doubt) return 'silence';
  const unsure = segs.some((s) => (s.no_speech_prob ?? 0) > 0.2 || (s.avg_logprob ?? 0) < -0.7);
  if (DOUBTFUL.has(n) && unsure) return 'hallucination';
  return 'speech';
}
