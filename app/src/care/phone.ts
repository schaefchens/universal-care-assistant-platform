/**
 * Calling without the server (docs/plan.md, Appendix D, A3b): the person's phone fallback, kept on the device so it
 * works offline, and the call itself. In the app a direct call where the person allowed it, else the dialler with the
 * number filled in; in a browser a tel: link (best effort). The emergency number always opens the dialler.
 */
import type { Session } from '../identity/account.ts';
import { Alerts, has, Phone } from '../native/plugins.ts';

export interface PhoneFallback {
  name: string;
  number: string;
  direct: boolean;
}

export interface Fallbacks {
  phoneFallback: PhoneFallback | null;
  sosNumber: string;
  /** A help question unanswered twice: sent marked unconfirmed, or not (docs/plan.md, Decisions "Other help"). */
  unconfirmedPolicy: 'send' | 'drop';
}

const KEY = 'ucap.care.fallback.v1';

export function loadFallbacks(): Fallbacks {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Fallbacks | null;
    if (v && typeof v.sosNumber === 'string') return { ...v, unconfirmedPolicy: v.unconfirmedPolicy === 'drop' ? 'drop' : 'send' };
  } catch {
    // Unreadable or no storage: the defaults below.
  }
  return { phoneFallback: null, sosNumber: '112', unconfirmedPolicy: 'send' };
}

function saveFallbacks(f: Fallbacks) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    // Without storage the fallback is known only while the server answers.
  }
}

/** Fetches the person's plan and keeps what is needed offline. */
export async function refreshFallbacks(session: Session): Promise<Fallbacks> {
  const plan = await session.call<{ phoneFallback: PhoneFallback | null; sosNumber: string; unconfirmedPolicy?: 'send' | 'drop' }>(`/api/v1/people/${session.ref.userId}/escalation-plan`);
  const f: Fallbacks = { phoneFallback: plan.phoneFallback, sosNumber: plan.sosNumber, unconfirmedPolicy: plan.unconfirmedPolicy === 'drop' ? 'drop' : 'send' };
  saveFallbacks(f);
  return f;
}

export async function call(number: string, direct = false): Promise<boolean> {
  return (await dial(number, direct)) !== null;
}

/** A call placed directly, the dialler (or a browser's tel: link) opened with the number, or neither (null). */
export async function dial(number: string, direct = false): Promise<'direct' | 'dialler' | null> {
  // As the phone app (G10) UCAP calls through its role, with no dialler in between; anything else opens the dialler,
  // which is then UCAP's own question (DialActivity): the emergency number is still called by the person's own choice.
  // Should the role refuse, nothing else is tried: the dialler would be UCAP again.
  if (direct && has('Phone') && (await Phone.state().catch(() => null))?.held) {
    return Phone.place({ number }).then(
      () => 'direct' as const,
      () => null,
    );
  }
  if (has('Alerts')) {
    try {
      return (await Alerts.call({ number, direct })).direct ? 'direct' : 'dialler';
    } catch {
      return null;
    }
  }
  if (typeof location === 'undefined') return null;
  location.href = `tel:${encodeURIComponent(number)}`;
  return 'dialler';
}
