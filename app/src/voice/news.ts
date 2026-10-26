/**
 * LIVE mode's announcements of what came in (docs/plan-m2.md, L4): when a new message arrives, the device waits a
 * moment for more (several are said together), then until it may speak (LIVE on and not paused, no quiet time,
 * nobody talking, UCAP silent), and asks the assistant what to say: a short message word for word, a long one summed
 * up, what else came (live-news.ts). "Was gibt's Neues?" asks at once. Said on the notice channel: a touch does not
 * drop it, care cuts it and it comes again after.
 */
import { type LiveConfig, liveSkips } from '@ucap/shared';

/** Whether `now` falls in one of the quiet times ("22:00"–"07:00" across midnight too), in the device's own time. */
export function inQuietTime(quietTimes: LiveConfig['quietTimes'], now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const at = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h! * 60 + m!;
  };
  return quietTimes.some(({ from, to }) => {
    const a = at(from);
    const b = at(to);
    return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
  });
}

/**
 * Whether LIVE mode says a new message by itself (docs/plan-m3.md, K8): not one the server keeps for when the person
 * asks (an email from someone they do not know), nor one on a service this device leaves to the person.
 */
export function saysByItself(live: LiveConfig, e: { service?: unknown; liveQuiet?: unknown }): boolean {
  return e.liveQuiet !== true && !(liveSkips(live) as string[]).includes(String(e.service ?? ''));
}

export interface NewsSegment {
  kind: 'original' | 'summary' | 'system';
  text: string;
  source?: { message: string };
}

export interface NewsHost {
  now(): number;
  later(fn: () => void, ms: number): () => void;
  /** LIVE is on and not paused, its settings say messages, and no quiet time: it may announce by itself. */
  allowed(): boolean;
  /** Nobody talking and UCAP silent: it may announce now. */
  free(): boolean;
  fetch(asked: boolean): Promise<NewsSegment[]>;
  /** Says one part; true when it was said to its end. */
  say(s: NewsSegment): Promise<boolean>;
  /** The originals heard to their end: now they count as read (CONCEPT §3). */
  heard(ids: string[]): void;
}

/** More messages within this while are said together. */
export const GATHER_MS = 4_000;
/** How long an announcement waits for the person to stop talking before it gives up (the next message brings it). */
const WAIT_MS = 120_000;

export class NewsAnnouncer {
  private readonly h: NewsHost;
  private timer: (() => void) | null = null;
  private since = 0;
  private busy = false;

  constructor(h: NewsHost) {
    this.h = h;
  }

  /** Whether LIVE mode announces by itself now (else the app says "Neue Nachricht von …" as without it). */
  allowed(): boolean {
    return this.h.allowed();
  }

  /** A new message arrived (to be announced, by the server's rules). */
  arrived(): void {
    if (!this.h.allowed()) return;
    if (!this.timer) this.since = this.h.now();
    this.schedule(GATHER_MS);
  }

  /** "Was gibt's Neues?": at once, also what was not announced by itself. */
  async ask(): Promise<void> {
    this.cancel();
    await this.run(true);
  }

  cancel(): void {
    this.timer?.();
    this.timer = null;
  }

  private schedule(ms: number) {
    this.timer?.();
    this.timer = this.h.later(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private async tick() {
    if (!this.h.allowed()) return;
    if (!this.h.free() || this.busy) {
      if (this.h.now() - this.since < WAIT_MS) this.schedule(1_000);
      return;
    }
    await this.run(false);
  }

  private async run(asked: boolean) {
    if (this.busy) return;
    this.busy = true;
    try {
      const segments = await this.h.fetch(asked).catch(() => [] as NewsSegment[]);
      const heard: string[] = [];
      for (const s of segments) {
        if (!(await this.h.say(s))) break;
        if (s.source) heard.push(s.source.message);
      }
      if (heard.length) this.h.heard(heard);
    } finally {
      this.busy = false;
    }
  }
}
