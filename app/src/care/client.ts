/**
 * The person's side of a help request (docs/plan.md, Appendix D "Client outbox" and the announcements A1–A22).
 *
 * - A press is kept in IndexedDB first (durability strict), then A1 is said and it is sent at once, signed by the
 *   device: no session, no token renewal on the way. Retries back off 0, 1, 2, 4, 8 s, then every 10 s; A3 after
 *   5 s without an answer, a short A3 every minute after that. Nothing that implies the server has it is said before
 *   it answers (I2): then A2, or A22 when the press waited more than 30 s.
 * - With a phone fallback set up (opt-in), A3b after 15 s offers a call; the next deliberate activation of help places
 *   it, and the press keeps being sent meanwhile.
 * - What happens next comes from the server's events for the request, each said once, on the care channel (never
 *   cut by exploring): delivered (A4/A4b), seen (A5), accepted (A6), a helper's words (A7), declined or released
 *   (A8), the next tier (A9), nobody yet (A10), unreachable (A11), nobody set up (A11b), resolved (A12), cancelled.
 * - While a request is open and the realtime connection is down, the request is fetched every 3 s.
 */
import { uuidv7 } from '@ucap/shared';
import type { DeviceRef, Session } from '../identity/account.ts';
import type { PhoneFallback } from './phone.ts';
import { ApiError } from '../net/api.ts';
import { signedCall } from '../net/signed.ts';

export interface CareEvent {
  id: number;
  episode: number;
  type: string;
  at: string;
  actor: { id: string; displayName: string | null } | null;
  data: Record<string, unknown>;
}

export interface CareView {
  id: string;
  status: 'open' | 'accepted' | 'resolved' | 'cancelled';
  episode: number;
  acceptedBy: { id: string; displayName: string | null } | null;
  receivedAt: string;
  delayMs: number | null;
  resolvedAt: string | null;
  sosNumber: string;
  events: CareEvent[];
}

interface Pending {
  cid: string;
  createdAt: number;
  source: string;
  /** "Hilfe holen" on a reminder: the request answers it. */
  reminderOccurrenceId?: string;
}

export interface CareState {
  /** A press not yet answered by the server. */
  pending: boolean;
  request: CareView | null;
}

type Tr = (key: string, params?: Record<string, string | number | Date>) => string;

const DB = 'ucap-care';
const STORE = 'outbox';

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode, { durability: 'strict' });
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}
const loadPending = () => idb<Pending | undefined>('readonly', (s) => s.get('pending') as IDBRequest<Pending | undefined>).catch(() => undefined);
const savePending = (p: Pending | null) =>
  (p ? idb<IDBValidKey>('readwrite', (s) => s.put(p, 'pending')) : idb<undefined>('readwrite', (s) => s.delete('pending'))).catch(() => undefined);

const announcedKey = (id: string) => `ucap.care.announced.${id}`;
function lastAnnounced(id: string): number | null {
  try {
    const v = localStorage.getItem(announcedKey(id));
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}
function setAnnounced(id: string, eventId: number) {
  try {
    localStorage.setItem(announcedKey(id), String(eventId));
  } catch {
    // Without storage an announcement may repeat after a restart; it is never lost.
  }
}

const BACKOFF_MS = [0, 1000, 2000, 4000, 8000];

export class CareClient {
  private readonly o: {
    ref: DeviceRef;
    session: Session;
    lang: string;
    tr: Tr;
    gesture: () => string;
    say: (text: string) => void;
    onState: (s: CareState) => void;
    onRevoked: () => void;
    /** Whom to call without the server (A3b), if anyone. */
    fallback?: () => PhoneFallback | null;
    dial?: (f: PhoneFallback) => void;
  };
  private pending: Pending | null = null;
  private request: CareView | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private realtimeOpen = false;
  private selfCancelled = new Set<string>();
  /** A3 five seconds after a press still unanswered, a short A3 every minute after that, whatever the network does. */
  private unsentTimer: ReturnType<typeof setTimeout> | null = null;
  /** A3b fifteen seconds after a press still unanswered; once said, the next activation of help calls. */
  private callTimer: ReturnType<typeof setTimeout> | null = null;
  private callOffered: PhoneFallback | null = null;

  constructor(o: CareClient['o']) {
    this.o = o;
  }

  get state(): CareState {
    return { pending: !!this.pending, request: this.request };
  }

  private publish() {
    this.o.onState(this.state);
    this.updatePolling();
  }

  /** At start: an unsent press is sent again; an open request is picked up without repeating its old news. */
  async start() {
    this.pending = (await loadPending()) ?? null;
    // A press left unsent is sent again; its answer (A2 or A22) speaks for the request, not the line below.
    const resending = !!this.pending;
    if (this.pending) {
      this.remindUnsent(true);
      this.offerCallLater();
      void this.send();
    }
    try {
      const r = await this.o.session.call<{ requests: CareView[] }>('/api/v1/care/requests?role=person');
      const cur = r.requests.find((x) => x.status === 'open' || x.status === 'accepted') ?? null;
      if (cur && lastAnnounced(cur.id) === null) setAnnounced(cur.id, Math.max(0, ...cur.events.map((e) => e.id)));
      // The resend may have answered first and already holds the request.
      if (this.request && cur?.id === this.request.id) return this.publish();
      this.request = cur;
      if (cur) {
        // After a restart: the person hears that their request is still open, then whatever is new.
        if (!resending) this.o.say(this.o.tr('care.status.open'));
        this.announceNew(cur);
      }
    } catch {
      // Offline at start: the outbox still works; the state comes with the first answer.
    }
    this.publish();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poller) clearInterval(this.poller);
    if (this.unsentTimer) clearTimeout(this.unsentTimer);
    this.withdrawCall();
  }

  /** A3b: "Keine Verbindung zum Server. Tippe zweimal auf das Hilfe-Feld, um Maria anzurufen." */
  private offerCallLater() {
    this.withdrawCall();
    const f = this.o.fallback?.();
    if (!f || !this.o.dial || !this.pending) return;
    this.callTimer = setTimeout(
      () => {
        if (!this.pending || this.stopped) return;
        const g = this.o.gesture();
        this.callOffered = f;
        this.o.say(this.o.tr('care.A3b', { name: f.name, gesture: g.charAt(0).toLocaleUpperCase(this.o.lang) + g.slice(1) }));
      },
      Math.max(0, 15_000 - (Date.now() - this.pending.createdAt)),
    );
  }

  private withdrawCall() {
    if (this.callTimer) clearTimeout(this.callTimer);
    this.callTimer = null;
    this.callOffered = null;
  }

  private remindUnsent(first: boolean) {
    if (this.unsentTimer) clearTimeout(this.unsentTimer);
    this.unsentTimer = setTimeout(
      () => {
        if (!this.pending || this.stopped) return;
        this.o.say(this.o.tr(first ? 'care.A3' : 'care.A3.short'));
        this.remindUnsent(false);
      },
      first ? Math.max(0, 5_000 - (Date.now() - (this.pending?.createdAt ?? Date.now()))) : 60_000,
    );
  }

  setRealtimeOpen(open: boolean) {
    this.realtimeOpen = open;
    this.updatePolling();
  }

  /** The help area, the help key, an exact phrase: one press. */
  async press(source: 'touch' | 'key' | 'voice_exact' | 'voice_confirmed' | 'voice_unconfirmed' | 'assistant' | 'reminder' = 'touch', o: { reminderOccurrenceId?: string } = {}) {
    if (this.pending && this.callOffered && this.o.dial) {
      // A3b offered the call: this deliberate activation places it. The press itself keeps being sent.
      const f = this.callOffered;
      this.o.say(this.o.tr(f.direct ? 'care.calling.direct' : 'care.calling.dialer', { name: f.name }));
      this.o.dial(f);
      return;
    }
    this.o.say(this.o.tr('care.A1'));
    if (this.pending) return; // still sending the first press: this one is the same request
    this.pending = { cid: uuidv7(), createdAt: Date.now(), source, ...(o.reminderOccurrenceId ? { reminderOccurrenceId: o.reminderOccurrenceId } : {}) };
    await savePending(this.pending);
    this.attempt = 0;
    this.remindUnsent(true);
    this.offerCallLater();
    this.publish();
    void this.send();
  }

  private async send() {
    const p = this.pending;
    if (!p || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    try {
      const r = await signedCall<{ request: CareView; coalesced: boolean; realerted: boolean; reopened?: boolean }>(this.o.ref, '/api/v1/care/requests', {
        clientRequestId: p.cid,
        source: p.source,
        delayMs: Math.max(0, Date.now() - p.createdAt),
        ...(p.reminderOccurrenceId ? { reminderOccurrenceId: p.reminderOccurrenceId } : {}),
      });
      if (this.pending?.cid !== p.cid) return;
      this.pending = null;
      if (this.unsentTimer) clearTimeout(this.unsentTimer);
      this.withdrawCall();
      await savePending(null);
      const delayMin = Math.round((Date.now() - p.createdAt) / 60_000);
      const first = r.coalesced ? (r.realerted ? 'care.A16' : 'care.A16b') : r.reopened ? 'care.reopened' : Date.now() - p.createdAt > 30_000 ? 'care.A22' : 'care.A2';
      this.o.say(this.o.tr(first, { n: Math.max(1, delayMin) }));
      // Only what happens from now on is news; for a request just made that includes "nobody set up".
      const before = r.coalesced || r.reopened ? Math.max(0, ...r.request.events.map((e) => e.id)) : (r.request.events.find((e) => e.type === 'created')?.id ?? 0);
      if (lastAnnounced(r.request.id) === null || !r.coalesced) setAnnounced(r.request.id, Math.max(before, lastAnnounced(r.request.id) ?? 0));
      this.request = r.request;
      this.announceNew(r.request);
      this.publish();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return this.o.onRevoked();
      const delay = BACKOFF_MS[this.attempt] ?? 10_000;
      this.attempt++;
      this.timer = setTimeout(() => void this.send(), delay);
    }
  }

  /** The request changed on the server (a realtime event, or a poll). */
  async refresh(requestId?: string) {
    const id = requestId ?? this.request?.id;
    if (!id) return;
    try {
      const v = await this.o.session.call<CareView>(`/api/v1/care/requests/${id}`);
      if (lastAnnounced(v.id) === null) setAnnounced(v.id, Math.max(0, ...v.events.map((e) => e.id)));
      this.request = v;
      this.announceNew(v);
      this.publish();
    } catch {
      // Next poll or event.
    }
  }

  /** "Hilferuf wirklich abbrechen?" was answered yes. */
  async cancel() {
    if (this.pending) {
      // Never left this device: nobody has to be told.
      this.pending = null;
      await savePending(null);
      if (this.timer) clearTimeout(this.timer);
      if (this.unsentTimer) clearTimeout(this.unsentTimer);
      this.withdrawCall();
      this.o.say(this.o.tr('care.A14b'));
      this.publish();
      return;
    }
    const r = this.request;
    if (!r || (r.status !== 'open' && r.status !== 'accepted')) return;
    this.selfCancelled.add(`${r.id}:${r.episode}`);
    for (let i = 0; ; i++) {
      try {
        await signedCall(this.o.ref, `/api/v1/care/requests/${r.id}/cancel`, { episode: r.episode });
        this.o.say(this.o.tr('care.A14'));
        await this.refresh(r.id);
        return;
      } catch (e) {
        if (e instanceof ApiError && e.status !== 0) {
          await this.refresh(r.id);
          return;
        }
        if (i === 0) this.o.say(this.o.tr('care.A15'));
        await new Promise((res) => setTimeout(res, Math.min(10_000, 1000 * 2 ** i)));
        if (this.stopped) return;
      }
    }
  }

  /** What to say for each new event, once. */
  private announceNew(v: CareView) {
    const after = lastAnnounced(v.id) ?? 0;
    const said = announcements(v, after, { tr: this.o.tr, lang: this.o.lang, gesture: this.o.gesture(), selfCancelled: (ep) => this.selfCancelled.has(`${v.id}:${ep}`) });
    for (const a of said) this.o.say(a.text);
    const last = Math.max(after, ...v.events.map((e) => e.id));
    if (last > after) setAnnounced(v.id, last);
  }

  private updatePolling() {
    const open = this.request && (this.request.status === 'open' || this.request.status === 'accepted');
    const want = !!open && !this.realtimeOpen && !this.stopped;
    if (want && !this.poller) this.poller = setInterval(() => void this.refresh(), 3_000);
    else if (!want && this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }
}

/**
 * The person's announcements for the events after `after` (docs/plan.md, Appendix D, A4–A14): pure, so the words
 * are tested. A helper's quick reply is quoted as theirs (A7); "Ich frage weitere Helfer" only when the server says
 * someone is left to ask.
 */
export function announcements(v: CareView, after: number, c: { tr: Tr; lang: string; gesture: string; selfCancelled: (episode: number) => boolean }): { eventId: number; text: string }[] {
  const out: { eventId: number; text: string }[] = [];
  const name = (e: CareEvent) => e.actor?.displayName ?? '';
  const list = (names: unknown) => new Intl.ListFormat(c.lang, { type: 'conjunction' }).format((Array.isArray(names) ? names : []).map(String).filter(Boolean));
  const endsSearch = (e: CareEvent) => e.data.more === false;
  for (const e of v.events) {
    if (e.id <= after) continue;
    let text: string | null = null;
    switch (e.type) {
      case 'delivered':
        text = c.tr(e.data.silenced ? (endsSearch(e) ? 'care.A4b.short' : 'care.A4b') : 'care.A4', { name: name(e) });
        break;
      case 'seen':
        text = c.tr('care.A5', { name: name(e) });
        break;
      case 'accepted':
        text = c.tr('care.A6', { name: name(e) });
        break;
      case 'message':
        text = c.tr('care.A7', { name: name(e), text: c.tr(`quick.${String(e.data.quick)}`, { n: Number(e.data.minutes ?? 0) }) });
        break;
      case 'declined':
      case 'released':
        text = c.tr(endsSearch(e) ? 'care.A8.short' : 'care.A8', { name: name(e) });
        break;
      case 'escalated':
        text = c.tr('care.A9', { names: list(e.data.helperNames) });
        break;
      case 'exhausted':
        text = c.tr('care.A10', { sos: v.sosNumber });
        break;
      case 'unreachable':
        text = c.tr('care.A11', { sos: v.sosNumber });
        break;
      case 'no_helpers':
        text = c.tr('care.A11b', { sos: v.sosNumber });
        break;
      case 'resolved':
        text = e.actor ? c.tr('care.A12', { name: name(e), gesture: c.gesture }) : null;
        break;
      case 'cancelled':
        // From another of the person's devices; this device said A14 itself.
        text = c.selfCancelled(e.episode) ? null : c.tr('care.A14');
        break;
    }
    if (text) out.push({ eventId: e.id, text });
  }
  return out;
}
