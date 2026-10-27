/**
 * Creating an account, recovering a device, confirming the words, and keeping a session (docs/plan.md, Appendix C).
 * The entropy and the identity key exist only inside these calls and are wiped when they return; the access token
 * lives in memory only and is renewed by the device key two minutes before it expires.
 */
import { b64url, deriveIdentity, inviteDigest, signIdentity, wipe } from '@ucap/identity';
import { Alerts, has } from '../native/plugins.ts';
import { api, ApiError, deviceRevoked } from '../net/api.ts';
import { startEventsAt } from '../net/realtime.ts';
import { fetchServerInfo } from '../net/server.ts';
import type { ServerRef } from '../state/store.ts';
import { deviceKey, thumbprint } from './device-key.ts';

export interface DeviceRef {
  serverUrl: string;
  serverId: string;
  userId: string;
  deviceId: string;
}

const KEY = 'ucap.device.v1';

export function loadDeviceRef(): DeviceRef | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DeviceRef) : null;
  } catch {
    return null;
  }
}

function saveDeviceRef(r: DeviceRef | null) {
  try {
    if (r) localStorage.setItem(KEY, JSON.stringify(r));
    else localStorage.removeItem(KEY);
  } catch {
    // Without storage the device must sign in again next time.
  }
}

export interface DeviceInfo {
  name: string;
  platform: 'android' | 'ios' | 'web';
  formFactor: 'phone' | 'tablet' | 'desktop';
  appVersion: string;
}

const org = (s: ServerRef) => new URL(s.url).origin;

/**
 * A new device for the account, with a key of its own. A key left from an earlier setup is removed first: the Keystore
 * outlives the WebView's storage (AN-06), and a key the server already knows would be refused.
 */
async function deviceProof(server: ServerRef, nonce: string) {
  await deviceKey.remove().catch(() => {});
  const jwk = await deviceKey.ensure();
  const djkt = await thumbprint(jwk);
  const proof = await deviceKey.sign('device.proof', { srv: server.serverId, org: org(server), nonce, djkt });
  return { jwk, djkt, proof };
}

export async function createAccount(o: {
  server: ServerRef;
  invite: string;
  displayName: string;
  locale: string;
  addressForm: 'du' | 'Sie';
  timezone: string;
  entropy: Uint8Array;
  device: DeviceInfo;
}): Promise<{ ref: DeviceRef; session: Session; inviteKind: string }> {
  const id = deriveIdentity(o.entropy);
  try {
    const ch = await api<{ challengeId: string; nonce: string }>(o.server.url, '/api/v1/identity/challenge', { body: { purpose: 'device.proof' } });
    const dev = await deviceProof(o.server, ch.nonce);
    const ipk = b64url(id.publicKey);
    const identityProof = b64url(signIdentity(id.seed, 'account.create', { srv: o.server.serverId, org: org(o.server), inv: inviteDigest(o.invite), ipk, djkt: dev.djkt }));
    const r = await api<{ userId: string; deviceId: string; token: string; expiresIn: number; seq: number; invite: { kind: string } }>(o.server.url, '/api/v1/accounts', {
      body: {
        invite: o.invite,
        org: org(o.server),
        displayName: o.displayName,
        locale: o.locale,
        addressForm: o.addressForm,
        timezone: o.timezone,
        identityKey: ipk,
        identityProof,
        challengeId: ch.challengeId,
        nonce: ch.nonce,
        device: { jwk: dev.jwk, ...o.device, keyStore: deviceKey.keyStore, proof: dev.proof },
      },
    });
    const ref = { serverUrl: o.server.url, serverId: o.server.serverId, userId: r.userId, deviceId: r.deviceId };
    saveDeviceRef(ref);
    startEventsAt(r.deviceId, r.seq);
    return { ref, session: new Session(ref, r.token, r.expiresIn), inviteKind: r.invite.kind };
  } finally {
    wipe(id.seed);
  }
}

export async function recoverAccount(o: { server: ServerRef; entropy: Uint8Array; device: DeviceInfo }): Promise<{ ref: DeviceRef; session: Session }> {
  const id = deriveIdentity(o.entropy);
  try {
    const ipk = b64url(id.publicKey);
    const ch = await api<{ challengeId: string; nonce: string }>(o.server.url, '/api/v1/identity/challenge', { body: { purpose: 'device.recover', identityKey: ipk } });
    const dev = await deviceProof(o.server, ch.nonce);
    const identityProof = b64url(signIdentity(id.seed, 'device.recover', { srv: o.server.serverId, org: org(o.server), nonce: ch.nonce, ipk, djkt: dev.djkt }));
    const r = await api<{ userId: string; deviceId: string; token: string; expiresIn: number; seq: number }>(o.server.url, '/api/v1/devices/recover', {
      body: { org: org(o.server), identityKey: ipk, identityProof, challengeId: ch.challengeId, nonce: ch.nonce, device: { jwk: dev.jwk, ...o.device, keyStore: deviceKey.keyStore, proof: dev.proof } },
    });
    const ref = { serverUrl: o.server.url, serverId: o.server.serverId, userId: r.userId, deviceId: r.deviceId };
    saveDeviceRef(ref);
    startEventsAt(r.deviceId, r.seq);
    return { ref, session: new Session(ref, r.token, r.expiresIn) };
  } finally {
    wipe(id.seed);
  }
}

/**
 * Device linking (docs/plan-m4.md, G3): this new device takes a code another device of the person shows, with a key of
 * its own, and gets the four fingerprint words to compare. Nothing is its own until the person says yes over there.
 */
export async function claimLink(o: { server: ServerRef; code: string; device: DeviceInfo }): Promise<{ id: string; words: number[]; jkt: string; expiresAt: string }> {
  const ch = await api<{ challengeId: string; nonce: string }>(o.server.url, '/api/v1/identity/challenge', { body: { purpose: 'device.proof' } });
  const dev = await deviceProof(o.server, ch.nonce);
  const r = await api<{ id: string; words: number[]; expiresAt: string }>(o.server.url, '/api/v1/devices/links/claim', {
    body: { code: o.code.replace(/\s/g, ''), org: org(o.server), challengeId: ch.challengeId, nonce: ch.nonce, device: { jwk: dev.jwk, ...o.device, keyStore: deviceKey.keyStore, proof: dev.proof } },
  });
  return { ...r, jkt: dev.djkt };
}

/** How the claim stands. Once the person said yes, this device is theirs and signs in with its own key. */
export async function pollLink(o: { server: ServerRef; id: string; jkt: string }): Promise<{ state: 'claimed' | 'declined' | 'cancelled' | 'expired' } | { state: 'approved'; session: Session }> {
  const r = await api<{ state: 'claimed' | 'declined' | 'cancelled' | 'expired' } | { state: 'approved'; userId: string; deviceId: string; seq: number }>(o.server.url, `/api/v1/devices/links/${o.id}/poll`, { body: { jkt: o.jkt } });
  if (r.state !== 'approved') return r;
  const ref = { serverUrl: o.server.url, serverId: o.server.serverId, userId: r.userId, deviceId: r.deviceId };
  saveDeviceRef(ref);
  startEventsAt(r.deviceId, r.seq);
  return { state: 'approved', session: new Session(ref) };
}

/**
 * The WebView's storage was lost, but Android kept this device's key and who it is (AN-06: the Keystore survives
 * WebView storage loss): the device signs in again with its key, without the words. Null when there is nothing to
 * restore; 'later' when the server cannot be reached now (native code keeps ringing alarms meanwhile). A server that
 * revoked the device has it forgotten, as on sign-out.
 */
export async function restoreDevice(): Promise<{ server: ServerRef; session: Session; lang?: string; form?: string } | 'later' | null> {
  if (!has('Alerts')) return null;
  const n = await Alerts.getRef().catch(() => ({}) as { serverUrl?: string; serverId?: string; deviceId?: string; lang?: string; form?: string });
  if (!n.serverUrl || !n.serverId || !n.deviceId || !(await deviceKey.exists().catch(() => false))) return null;
  const info = await fetchServerInfo(n.serverUrl);
  if (info === 'unreachable') return 'later';
  if (typeof info === 'string' || info.serverId !== n.serverId) return null;
  const probe = new Session({ serverUrl: n.serverUrl, serverId: n.serverId, deviceId: n.deviceId, userId: '' });
  let me: Me;
  try {
    me = await probe.call<Me>('/api/v1/me');
  } catch (e) {
    if (!(e instanceof ApiError)) return 'later';
    if (deviceRevoked(e)) await probe.forget();
    else if (e.status === 401) return 'later';
    return null;
  }
  const ref = { serverUrl: n.serverUrl, serverId: n.serverId, userId: me.id, deviceId: n.deviceId };
  saveDeviceRef(ref);
  // Beyond any head: the server answers with a resync, and the device fetches what is now instead of a month's events.
  startEventsAt(ref.deviceId, Number.MAX_SAFE_INTEGER);
  return { server: { url: n.serverUrl, serverId: info.serverId, name: info.name, development: info.development }, session: new Session(ref), lang: n.lang, form: n.form };
}

/** After the verification quiz: the identity key signs that the person has their words. */
export async function confirmWords(session: Session, server: ServerRef, entropy: Uint8Array): Promise<void> {
  const id = deriveIdentity(entropy);
  try {
    const proof = b64url(signIdentity(id.seed, 'recovery.confirm', { srv: server.serverId, org: org(server), uid: session.ref.userId, ipk: b64url(id.publicKey) }));
    await session.call('/api/v1/identity/recovery-confirmed', { body: { org: org(server), proof } });
  } finally {
    wipe(id.seed);
  }
}

export interface Me {
  id: string;
  displayName: string;
  locale: string;
  addressForm: 'du' | 'Sie';
  timezone: string;
  recoveryState: 'none' | 'unconfirmed' | 'confirmed';
  isAdmin: boolean;
  identityKey: string | null;
  /** Unconfirmed words, and this device created the account: it may replace them without the old words. */
  canReissue: boolean;
  /** LIVE mode (docs/plan-m2.md): what the person calls the assistant, and a keyword of their own instead of it. */
  assistantName?: string | null;
  keyword?: string | null;
  /** How long the assistant answers ("Kürzer", "Ausführlicher"). */
  answers?: 'short' | 'normal' | 'detailed';
}

/** Whether typed words belong to this account (checked against its public key before anything changes). */
export function wordsMatch(me: Me, entropy: Uint8Array): boolean {
  const id = deriveIdentity(entropy);
  try {
    return me.identityKey === b64url(id.publicKey);
  } finally {
    wipe(id.seed);
  }
}

/** New words replace the current ones; both identity keys sign (docs/plan.md, Appendix C: rotation). */
export async function rotateWords(session: Session, server: ServerRef, oldEntropy: Uint8Array, newEntropy: Uint8Array): Promise<void> {
  const old = deriveIdentity(oldEntropy);
  const next = deriveIdentity(newEntropy);
  try {
    const ch = await session.call<{ challengeId: string; nonce: string }>('/api/v1/identity/challenge', { body: { purpose: 'identity.rotate' } });
    const oldKey = b64url(old.publicKey);
    const newKey = b64url(next.publicKey);
    const payload = { srv: server.serverId, org: org(server), uid: session.ref.userId, old_ipk: oldKey, new_ipk: newKey, nonce: ch.nonce };
    await session.call('/api/v1/identity/rotate', {
      body: { org: org(server), challengeId: ch.challengeId, nonce: ch.nonce, oldKey, oldProof: b64url(signIdentity(old.seed, 'identity.rotate', payload)), newKey, newProof: b64url(signIdentity(next.seed, 'identity.rotate', payload)) },
    });
  } finally {
    wipe(old.seed, next.seed);
  }
}

/** New words when the first were never confirmed: only the device that created the account may do this. */
export async function reissueWords(session: Session, server: ServerRef, newEntropy: Uint8Array): Promise<void> {
  const next = deriveIdentity(newEntropy);
  try {
    const ch = await session.call<{ challengeId: string; nonce: string }>('/api/v1/identity/challenge', { body: { purpose: 'identity.reissue' } });
    const newKey = b64url(next.publicKey);
    const payload = { srv: server.serverId, org: org(server), uid: session.ref.userId, did: session.ref.deviceId, new_ipk: newKey, nonce: ch.nonce };
    await session.call('/api/v1/identity/reissue', { body: { org: org(server), challengeId: ch.challengeId, nonce: ch.nonce, newKey, newProof: b64url(signIdentity(next.seed, 'identity.reissue', payload)) } });
  } finally {
    wipe(next.seed);
  }
}

// —— New words without the old ones, and the day they wait (docs/plan-m4.md, G5) ——

export interface WaitingChange {
  id: string;
  kind: 'device' | 'trusted' | 'reset';
  effectiveAt: string;
  createdAt: string;
  /** The person's device that asked (kind `device`), by its name. */
  byDevice: string | null;
  /** The administrator of a reset. */
  byName: string | null;
  reason: string | null;
  /** Asked for on this very device. */
  own: boolean;
}

/** New words from this device, without the old ones: the new key signs on a challenge for this device; they wait a day. */
export async function requestNewWords(session: Session, server: ServerRef, newEntropy: Uint8Array): Promise<{ id: string; effectiveAt: string }> {
  const next = deriveIdentity(newEntropy);
  try {
    const ch = await session.call<{ challengeId: string; nonce: string }>('/api/v1/identity/challenge', { body: { purpose: 'identity.change' } });
    const newKey = b64url(next.publicKey);
    const payload = { srv: server.serverId, org: org(server), uid: session.ref.userId, did: session.ref.deviceId, new_ipk: newKey, nonce: ch.nonce };
    return await session.call('/api/v1/identity/changes', { body: { org: org(server), challengeId: ch.challengeId, nonce: ch.nonce, newKey, newProof: b64url(signIdentity(next.seed, 'identity.change', payload)) } });
  } finally {
    wipe(next.seed);
  }
}

/** What waits for this person, if anything (said at every start until it took effect or was stopped). */
export const currentChange = (session: Session) => session.call<{ change: WaitingChange | null }>('/api/v1/identity/changes/current').then((r) => r.change);

/** Stopped from this device (it must be unlocked when the app lock is on). */
export const stopChange = (session: Session, id: string) => session.call(`/api/v1/identity/changes/${id}/stop`, { method: 'POST' });

/** "Später einrichten": an account set up for someone starts without words. */
export const recoveryLater = (session: Session) => session.call('/api/v1/identity/later', { method: 'POST' });

// —— The operator's reset, on a new device (G5) ——

/** A claimed reset this device waits for, kept across restarts of the app. */
export interface PendingReset {
  serverUrl: string;
  id: string;
  jkt: string;
  name: string;
  effectiveAt: string;
}

const PENDING_RESET = 'ucap.pendingReset';

export function loadPendingReset(serverUrl: string): PendingReset | null {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_RESET) ?? 'null') as PendingReset | null;
    return p && p.serverUrl === serverUrl ? p : null;
  } catch {
    return null;
  }
}

export function clearPendingReset() {
  try {
    localStorage.removeItem(PENDING_RESET);
  } catch {
    // Nothing kept.
  }
}

/** Whose account a reset code is for, before any words are made. */
export const checkReset = (server: ServerRef, code: string) => api<{ name: string }>(server.url, '/api/v1/identity/reset/check', { body: { code: code.trim() } });

/** This device takes the code with a key of its own and the new words (both sign); it waits a day to be the person's. */
export async function claimReset(o: { server: ServerRef; code: string; entropy: Uint8Array; device: DeviceInfo }): Promise<PendingReset> {
  const id = deriveIdentity(o.entropy);
  try {
    const code = o.code.trim();
    const ch = await api<{ challengeId: string; nonce: string }>(o.server.url, '/api/v1/identity/challenge', { body: { purpose: 'device.proof' } });
    const dev = await deviceProof(o.server, ch.nonce);
    const ipk = b64url(id.publicKey);
    const identityProof = b64url(signIdentity(id.seed, 'identity.reset', { srv: o.server.serverId, org: org(o.server), inv: inviteDigest(code), ipk, djkt: dev.djkt }));
    const r = await api<{ id: string; effectiveAt: string; name: string }>(o.server.url, '/api/v1/identity/reset/claim', {
      body: { code, org: org(o.server), challengeId: ch.challengeId, nonce: ch.nonce, identityKey: ipk, identityProof, device: { jwk: dev.jwk, ...o.device, keyStore: deviceKey.keyStore, proof: dev.proof } },
    });
    const pending = { serverUrl: o.server.url, id: r.id, jkt: dev.djkt, name: r.name, effectiveAt: r.effectiveAt };
    try {
      localStorage.setItem(PENDING_RESET, JSON.stringify(pending));
    } catch {
      // Kept in memory only: a restart would ask for the code again.
    }
    return pending;
  } finally {
    wipe(id.seed);
  }
}

/** How the reset stands. Once the day is over, this device is the person's and signs in with its own key. */
export async function pollReset(o: { server: ServerRef; pending: PendingReset }): Promise<{ state: 'waiting' | 'stopped' } | { state: 'done'; session: Session }> {
  const r = await api<{ state: 'waiting' | 'stopped' } | { state: 'done'; userId: string; deviceId: string; seq: number }>(o.server.url, `/api/v1/identity/reset/${o.pending.id}/poll`, { body: { jkt: o.pending.jkt } });
  if (r.state !== 'done') return { state: r.state };
  clearPendingReset();
  const ref = { serverUrl: o.server.url, serverId: o.server.serverId, userId: r.userId, deviceId: r.deviceId };
  saveDeviceRef(ref);
  startEventsAt(r.deviceId, r.seq);
  return { state: 'done', session: new Session(ref) };
}

// —— Trusted persons (docs/plan-m4.md, G7) ——

/** A recovery through trusted persons this new device started: its code and four words, until they said yes. */
export interface TrustedStart {
  id: string;
  code: string;
  words: number[];
  jkt: string;
  expiresAt: string;
}

/** This new device asks the person's trusted persons: its own key and the new words (both sign); nobody's yet. */
export async function startTrusted(o: { server: ServerRef; entropy: Uint8Array; device: DeviceInfo }): Promise<TrustedStart> {
  const id = deriveIdentity(o.entropy);
  try {
    const ch = await api<{ challengeId: string; nonce: string }>(o.server.url, '/api/v1/identity/challenge', { body: { purpose: 'device.proof' } });
    const dev = await deviceProof(o.server, ch.nonce);
    const ipk = b64url(id.publicKey);
    const identityProof = b64url(signIdentity(id.seed, 'identity.trusted', { srv: o.server.serverId, org: org(o.server), nonce: ch.nonce, ipk, djkt: dev.djkt }));
    const r = await api<{ id: string; code: string; words: number[]; expiresAt: string }>(o.server.url, '/api/v1/trusted-recoveries', {
      body: { org: org(o.server), challengeId: ch.challengeId, nonce: ch.nonce, identityKey: ipk, identityProof, device: { jwk: dev.jwk, ...o.device, keyStore: deviceKey.keyStore, proof: dev.proof } },
    });
    return { ...r, jkt: dev.djkt };
  } finally {
    wipe(id.seed);
  }
}

/** How the trusted persons' answers stand; once enough said yes, the day's wait is a pending change like a reset's. */
export async function pollTrusted(o: { server: ServerRef; start: TrustedStart }): Promise<{ state: 'open'; approvals: number } | { state: 'declined' | 'expired' } | { state: 'waiting'; pending: PendingReset }> {
  const r = await api<{ state: 'open'; approvals: number } | { state: 'declined' | 'expired' } | { state: 'waiting'; changeId: string; name: string; effectiveAt: string }>(
    o.server.url,
    `/api/v1/trusted-recoveries/${o.start.id}/poll`,
    { body: { jkt: o.start.jkt } },
  );
  if (r.state !== 'waiting') return r;
  const pending = { serverUrl: o.server.url, id: r.changeId, jkt: o.start.jkt, name: r.name, effectiveAt: r.effectiveAt };
  try {
    localStorage.setItem('ucap.pendingReset', JSON.stringify(pending));
  } catch {
    // Kept in memory only.
  }
  return { state: 'waiting', pending };
}

/** A trusted person's yes for the person whose new device shows these words: signed by this device. */
export async function approveTrusted(session: Session, server: ServerRef, o: { id: string; personId: string; djkt: string }): Promise<{ approvals: number; needed: number; effectiveAt: string | null }> {
  const payload = { srv: server.serverId, org: org(server), rid: o.id, uid: o.personId, djkt: o.djkt };
  const proof = await deviceKey.sign('trusted.approve', payload);
  return session.call(`/api/v1/trusted-recoveries/${o.id}/approve`, { body: { personId: o.personId, org: org(server), proof } });
}

/** A signed-in device. The token stays in memory; a new one is signed for whenever it is about to expire. */
export class Session {
  readonly ref: DeviceRef;
  private token: string | null;
  private expiresAt: number;
  private renewing: Promise<string> | null = null;
  /**
   * The app lock (docs/plan-m4.md, G4): this session was unlocked by the person's code, so a renewal names it and stays
   * unlocked. A device without the lock is never "unlocked" here: its sessions have everything anyway.
   */
  private unlocked = false;
  /** Told when the server answers that this device is locked (403 `locked`). */
  onLocked: (() => void) | null = null;

  constructor(ref: DeviceRef, token: string | null = null, expiresIn = 0) {
    this.ref = ref;
    this.token = token;
    this.expiresAt = Date.now() + expiresIn * 1000;
  }

  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 120_000) return this.token;
    this.renewing ??= this.renew().finally(() => (this.renewing = null));
    return this.renewing;
  }

  setUnlocked(on: boolean): void {
    this.unlocked = on;
  }

  private async renew(): Promise<string> {
    const base = this.ref.serverUrl;
    const ch = await api<{ challengeId: string; nonce: string }>(base, '/api/v1/identity/challenge', { body: { purpose: 'session', deviceId: this.ref.deviceId } });
    const proof = await deviceKey.sign('session', { srv: this.ref.serverId, org: new URL(base).origin, nonce: ch.nonce, did: this.ref.deviceId });
    const previous = this.unlocked && this.token ? { previous: this.token } : {};
    const r = await api<{ token: string; expiresIn: number }>(base, '/api/v1/sessions', {
      body: { org: new URL(base).origin, deviceId: this.ref.deviceId, challengeId: ch.challengeId, nonce: ch.nonce, proof, ...previous },
    });
    this.token = r.token;
    this.expiresAt = Date.now() + r.expiresIn * 1000;
    return r.token;
  }

  /** Forget the current token (the server refused it); the next call signs for a new one. */
  dropToken(): void {
    this.token = null;
  }

  /** `signal`: a limit of the caller's own instead of the usual 15 s (what may take longer: LIVE's news). */
  async call<T>(path: string, o: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
    try {
      return await api<T>(this.ref.serverUrl, path, { ...o, token: await this.accessToken() });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'locked') {
        this.unlocked = false;
        this.onLocked?.();
        throw e;
      }
      // A token the server no longer knows (restart, clock): one fresh proof, then give up.
      if (e instanceof ApiError && e.status === 401 && !deviceRevoked(e)) {
        this.token = null;
        return api<T>(this.ref.serverUrl, path, { ...o, token: await this.accessToken() });
      }
      throw e;
    }
  }

  /** This device was revoked or the person signed out: forget it, and its key; nothing may ring for it any more. */
  async forget(): Promise<void> {
    saveDeviceRef(null);
    await deviceKey.remove().catch(() => {});
    if (has('Alerts')) await Alerts.setRef({}).catch(() => {});
  }
}
