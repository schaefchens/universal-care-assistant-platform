/**
 * Who is who on WhatsApp (docs/plan-m3.md, K2: "LIDs"). WhatsApp addresses a person by their number
 * (…@s.whatsapp.net) or by a LID (…@lid), an id without the number, and one chat can arrive under either: a message
 * sent to the owner's own number came back under their LID (docs/spikes/m3.md, A). UCAP keeps one id per person, the
 * one it learned first, preferring the number when both come together, and every other address of that person points
 * to it.
 *
 * Names: what the person saved for a contact in their address book; for anyone else the name they gave themselves on
 * WhatsApp, as a stranger (the owner, 2026-10-22: "self given names are better than numbers, no one knows numbers";
 * decisions.md, M3), then their number, the part of it WhatsApp shows, or unknown. Only a saved name makes a contact.
 */
import { isJidGroup, isLidUser, isPnUser, jidDecode, jidNormalizedUser } from 'baileys';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export interface IdsState {
  /** Any address of a person → the address UCAP knows them by. */
  aliases: Record<string, string>;
  /** That address → the name the person saved for them. */
  names: Record<string, string>;
  /** That address → their number, digits only, when WhatsApp told it. */
  numbers: Record<string, string>;
  /** A group → its name. */
  subjects: Record<string, string>;
  /** That address → its number as WhatsApp shows it masked ("+49 … 55"), where it hides the rest. */
  masked?: Record<string, string>;
  /** That address → the name the person gave themselves on WhatsApp (a "push name"). */
  own?: Record<string, string>;
}

/** WhatsApp itself: its notices come from this account. */
export const WHATSAPP_JID = '0@s.whatsapp.net';

const isPerson = (jid: string) => (isPnUser(jid) === true || isLidUser(jid) === true) && jid !== WHATSAPP_JID;

/**
 * A number WhatsApp hides in part (a community's members): it sends "+49∙∙∙∙∙∙∙∙∙55" in a contact's name. It is no
 * name the person saved; said as "+49 … 55". Null for anything else.
 */
export function maskedNumber(name: string): string | null {
  const v = name.trim();
  if (!/^\+?[\d\s]*[∙•·*]{2,}[\d\s∙•·*]*$/.test(v)) return null;
  return v.replace(/\s+/g, '').replace(/[∙•·*]+/g, ' … ').trim();
}

/** A number as people say it: "+49 151 23456789". */
export function formatNumber(digits: string): string {
  return parsePhoneNumberFromString(`+${digits}`)?.formatInternational() ?? `+${digits}`;
}

export class Ids {
  private readonly s: IdsState;
  /** Something changed since the last snapshot. */
  dirty = false;
  /** Two addresses of one person that UCAP had already given ids of their own (counted, never merged). */
  conflicts = 0;
  me: { pn: string; lid: string | null } = { pn: '', lid: null };
  /** The name the person gave themselves on WhatsApp: their own chat is named by it. */
  meName: string | null = null;

  constructor(state?: IdsState | null) {
    this.s = state ?? { aliases: {}, names: {}, numbers: {}, subjects: {} };
  }

  snapshot(): IdsState {
    this.dirty = false;
    return this.s;
  }

  /** The account's own number and LID: one person, known by the number; their own name, when WhatsApp tells it. */
  setMe(pn: string, lid?: string | null, name?: string | null) {
    const p = jidNormalizedUser(pn);
    this.me = { pn: p, lid: lid ? jidNormalizedUser(lid) : null };
    if (name?.trim()) this.meName = name.trim();
    this.pair(p, this.me.lid);
  }

  /** The person UCAP serves (their own chat, "Message yourself"). */
  isSelf(jid: string): boolean {
    return this.me.pn !== '' && this.canonical(jid) === this.canonical(this.me.pn);
  }

  /**
   * Two addresses of the same person (a number and a LID, from WhatsApp's mappings, a contact, a chat or a message's
   * other address). The first id given stays; an address not seen yet points to it.
   */
  pair(a: string | null | undefined, b: string | null | undefined) {
    const x = a ? jidNormalizedUser(a) : '';
    const y = b ? jidNormalizedUser(b) : '';
    if (!x || !y || x === y || !isPerson(x) || !isPerson(y)) return;
    const pn = isPnUser(x) ? x : isPnUser(y) ? y : null;
    const ca = this.s.aliases[x];
    const cb = this.s.aliases[y];
    if (ca && cb) {
      if (ca !== cb) this.conflicts++;
    } else if (ca) this.set(y, ca);
    else if (cb) this.set(x, cb);
    else {
      const id = pn ?? x;
      this.set(x, id);
      this.set(y, id);
    }
    const id = this.s.aliases[x]!;
    if (pn && !this.s.numbers[id]) this.setNumber(id, pn);
  }

  private set(jid: string, id: string) {
    this.s.aliases[jid] = id;
    this.dirty = true;
  }

  private setNumber(id: string, pn: string) {
    const digits = jidDecode(pn)?.user;
    if (digits && /^\d{6,15}$/.test(digits)) {
      this.s.numbers[id] = digits;
      this.dirty = true;
    }
  }

  /** The address UCAP knows this person (or group) by; a person seen for the first time is known by this one. */
  canonical(jid: string): string {
    const n = jidNormalizedUser(jid);
    if (!isPerson(n)) return n;
    const known = this.s.aliases[n];
    if (known) return known;
    this.set(n, n);
    if (isPnUser(n)) this.setNumber(n, n);
    return n;
  }

  /** The person's id in UCAP's store: "user:<number>" or "lid:<LID>", as the stand-in names them too. */
  userId(jid: string): string {
    const c = this.canonical(jid);
    const user = jidDecode(c)?.user ?? c;
    if (isLidUser(c)) return `lid:${user}`;
    if (isPnUser(c)) return `user:${user}`;
    return `jid:${c}`;
  }

  number(jid: string): string | null {
    return this.s.numbers[this.canonical(jid)] ?? null;
  }

  /** The name the person saved for this contact; null removes it. True when it changed. */
  setName(jid: string, name: string | null | undefined): boolean {
    if (!isPerson(jidNormalizedUser(jid))) return false;
    const id = this.canonical(jid);
    const masked = name ? maskedNumber(name) : null;
    if (masked) {
      // WhatsApp's masked number in the name: kept to say, never taken for a name the person saved.
      const was = this.s.masked?.[id] ?? null;
      (this.s.masked ??= {})[id] = masked;
      const hadName = id in this.s.names;
      delete this.s.names[id];
      if (was !== masked || hadName) this.dirty = true;
      return was !== masked || hadName;
    }
    const v = name?.trim() || null;
    if ((this.s.names[id] ?? null) === v) return false;
    if (v) this.s.names[id] = v;
    else delete this.s.names[id];
    this.dirty = true;
    return true;
  }

  savedName(jid: string): string | null {
    return this.s.names[this.canonical(jid)] ?? null;
  }

  /** The name someone gave themselves on WhatsApp; never a contact's, never a masked number. True when it changed. */
  setOwnName(jid: string, name: string | null | undefined): boolean {
    if (!isPerson(jidNormalizedUser(jid))) return false;
    const v = name?.trim() || null;
    if (!v || v === '~' || maskedNumber(v)) return false;
    const id = this.canonical(jid);
    if (this.s.own?.[id] === v) return false;
    (this.s.own ??= {})[id] = v;
    this.dirty = true;
    return true;
  }

  /**
   * The name to say: the saved one, else the one they gave themselves, else the number, else the part of it WhatsApp
   * shows, else `unknown`; the person themselves by their own name.
   */
  name(jid: string, unknown: string): string {
    if (this.isSelf(jid) && this.meName) return this.meName;
    const saved = this.savedName(jid);
    if (saved) return saved;
    const own = this.s.own?.[this.canonical(jid)];
    if (own) return own;
    const digits = this.number(jid);
    if (digits) return formatNumber(digits);
    return this.s.masked?.[this.canonical(jid)] ?? unknown;
  }

  setSubject(group: string, subject: string | null | undefined): boolean {
    const g = jidNormalizedUser(group);
    const v = subject?.trim() || null;
    if (!isJidGroup(g) || !v || this.s.subjects[g] === v) return false;
    this.s.subjects[g] = v;
    this.dirty = true;
    return true;
  }

  subject(group: string): string | null {
    return this.s.subjects[jidNormalizedUser(group)] ?? null;
  }
}
