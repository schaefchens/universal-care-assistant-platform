/**
 * Earcons: short sounds for entering an area, activating, and the states of a help request. Natively through
 * SoundPool (measured 5 ms from touch to play()), in the browser through Web Audio buffers decoded at start-up.
 * Voice never goes through Web Audio (WebKit dropped words that way); earcons may.
 */
import { Earcons, has } from '../native/plugins.ts';

export const EARCON_NAMES = [
  'area-1', 'area-2', 'area-3', 'area-4', 'area-5', 'area-6', 'help', 'activate', 'screen', 'confirm',
  'listen-start', 'listen-stop', 'care-press', 'care-received', 'care-delivered', 'care-accepted', 'care-cancelled',
  'care-failed', 'error', 'message',
] as const;
export type EarconName = (typeof EARCON_NAMES)[number];

export interface EarconPlayer {
  load(): Promise<{ ok: number; failed: string[] }>;
  play(name: string): void;
  /** A Web Audio context starts suspended until a gesture; the first touch resumes it. */
  wake(): void;
  readonly path: 'soundpool' | 'webaudio' | 'none';
}

export function createEarcons(base = 'earcons/'): EarconPlayer {
  if (has('Earcons')) {
    return {
      path: 'soundpool',
      async load() {
        const r = await Earcons.load({ names: [...EARCON_NAMES] });
        return { ok: r.loaded, failed: r.failed };
      },
      play(name) {
        void Earcons.play({ name }).catch(() => {});
      },
      wake() {},
    };
  }
  if (typeof AudioContext === 'undefined') return { path: 'none', load: async () => ({ ok: 0, failed: [...EARCON_NAMES] }), play() {}, wake() {} };

  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const buffers = new Map<string, AudioBuffer>();
  return {
    path: 'webaudio',
    async load() {
      const failed: string[] = [];
      await Promise.all(
        EARCON_NAMES.map(async (name) => {
          try {
            const data = await fetch(`${base}${name}.wav`).then((r) => r.arrayBuffer());
            buffers.set(name, await ctx.decodeAudioData(data));
          } catch {
            failed.push(name);
          }
        }),
      );
      return { ok: buffers.size, failed };
    },
    play(name) {
      const buffer = buffers.get(name);
      if (!buffer) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
    },
    wake() {
      if (ctx.state !== 'running') void ctx.resume();
    },
  };
}

/** The default earcon for an area: its own, `help` for the help area, else by position. */
export function earconFor(area: { earcon?: string; role: string }, index: number): string {
  if (area.earcon) return area.earcon;
  if (area.role === 'help') return 'help';
  return `area-${(index % 6) + 1}`;
}
