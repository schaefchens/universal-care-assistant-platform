/**
 * Where data may go (docs/plan.md, Appendix I). Every call to a provider carries the data classes of what it sends.
 * Public data may go anywhere. Personal data may go to the server and the operator's own machines; to an external
 * provider only when the operator's policy for that provider lists the class AND the person consented to it. A
 * provider over its monthly cap is refused. Nothing falls back silently: the caller learns why, and says it.
 */

/**
 * `live_audio`: what LIVE mode's open microphone hears (docs/plan-m2.md), the room and other people in it too; an
 * external recognition needs its own consent for it, beside `voice_audio` for push-to-talk.
 */
export const DATA_CLASSES = ['communication', 'care', 'health', 'personal', 'voice_audio', 'live_audio', 'ui_config', 'public'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** What speech of each purpose may hold. */
export const SPEECH_CLASSES = {
  /** A fixed sample sentence while choosing a voice. */
  sample: ['public'],
  /** The assistant's answers: anything the person has (notes, messages, plans). */
  reply: ['personal', 'communication', 'health'],
  /** Messages, notes, documents read aloud. */
  reading: ['communication', 'personal'],
  /** A reminder's question (medication, drinking). */
  reminder: ['health', 'personal'],
} as const satisfies Record<string, readonly DataClass[]>;
export type SpeechPurpose = keyof typeof SPEECH_CLASSES;

export type Location = 'server' | 'operator_lan' | 'external';

export type Refusal = 'disabled' | 'failing' | 'policy' | 'consent' | 'budget';

/** May this provider get data of these classes for this person? */
export function decide(p: {
  location: Location;
  enabled: boolean;
  health: 'unknown' | 'ok' | 'failing';
  allowedClasses: readonly string[];
  consented: readonly string[] | null;
  classes: readonly DataClass[];
  spentMicros: number;
  capMicros: number | null;
  costMicros: number;
}): { ok: true } | { ok: false; reason: Refusal } {
  if (!p.enabled) return { ok: false, reason: 'disabled' };
  if (p.health === 'failing') return { ok: false, reason: 'failing' };
  const personal = p.classes.filter((c) => c !== 'public');
  if (p.location === 'external' && personal.length) {
    if (!personal.every((c) => p.allowedClasses.includes(c))) return { ok: false, reason: 'policy' };
    if (!p.consented || !personal.every((c) => p.consented!.includes(c))) return { ok: false, reason: 'consent' };
  }
  if (p.capMicros !== null && p.spentMicros + p.costMicros > p.capMicros) return { ok: false, reason: 'budget' };
  return { ok: true };
}
