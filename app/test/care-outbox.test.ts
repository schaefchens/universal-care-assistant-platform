/**
 * The person's outbox while the server cannot be reached (docs/plan.md, Appendix D "Client outbox"): A1 at once, A3
 * after 5 s, and with a phone fallback A3b after 15 s; the next deliberate press then calls, and the press itself
 * keeps being sent until the server answers (A22). Fake timers; the signed request is replaced by a stub.
 */
import { t } from '@ucap/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhoneFallback } from '../src/care/phone.ts';
import type { Session } from '../src/identity/account.ts';
import { ApiError } from '../src/net/api.ts';

const signedCall = vi.fn();
vi.mock('../src/net/signed.ts', () => ({ signedCall: (...a: unknown[]) => signedCall(...a) }));
const { CareClient } = await import('../src/care/client.ts');

const tr = (key: string, params?: Record<string, string | number | Date>) => t('de', key, params, 'du');
const offline = () => Promise.reject(new ApiError(0, 'unavailable'));

function client(fallback: PhoneFallback | null) {
  const said: string[] = [];
  const dialled: PhoneFallback[] = [];
  const revoked = { n: 0 };
  const care = new CareClient({
    ref: { serverUrl: 'http://localhost:8810', serverId: 's', userId: 'u', deviceId: 'd' },
    session: { call: offline } as unknown as Session,
    lang: 'de',
    tr,
    gesture: () => tr('care.gesture.explore'),
    say: (text) => said.push(text),
    onState: () => {},
    onRevoked: () => revoked.n++,
    fallback: () => fallback,
    dial: (f) => dialled.push(f),
  });
  return { care, said, dialled, revoked };
}

const request = { id: 'r', status: 'open', episode: 1, acceptedBy: null, receivedAt: '', delayMs: 0, resolvedAt: null, sosNumber: '112', events: [{ id: 1, episode: 1, type: 'created', at: '', actor: null, data: {} }] };

describe('a help request without a connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    signedCall.mockReset();
    signedCall.mockImplementation(offline);
  });
  afterEach(() => vi.useRealTimers());

  it('offers the phone fallback after 15 s; the next press calls, and the request is still sent', async () => {
    const { care, said, dialled } = client({ name: 'Maria', number: '+493012345678', direct: false });
    await care.press('touch');
    expect(said).toEqual(['Hilferuf wird gesendet.']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(said.at(-1)).toBe('Dein Hilferuf ist noch nicht gesendet. Ich versuche es weiter.');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(said.at(-1)).toBe('Keine Verbindung zum Server. Tippe zweimal auf das Hilfe-Feld, um Maria anzurufen.');
    // The deliberate second press calls; it is not a second request.
    await care.press('touch');
    expect(dialled).toEqual([{ name: 'Maria', number: '+493012345678', direct: false }]);
    expect(said.at(-1)).toBe('Die Telefon-App öffnet sich mit der Nummer von Maria.');
    expect(care.state.pending).toBe(true);
    // Still offline for a while, then the connection is back: the same press arrives, late (A22: more than 30 s), and
    // the call offer is withdrawn.
    await vi.advanceTimersByTimeAsync(20_000);
    signedCall.mockImplementation(async () => ({ request, coalesced: false, realerted: false }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(said).toContain('Dein Hilferuf ist jetzt angekommen, nach einer Minute ohne Verbindung. Ich benachrichtige jetzt deine Helfer.');
    expect(new Set(signedCall.mock.calls.map((c) => (c[2] as { clientRequestId: string }).clientRequestId)).size).toBe(1);
    const before = said.length;
    await care.press('touch');
    expect(dialled).toHaveLength(1);
    expect(said[before]).toBe('Hilferuf wird gesendet.');
    care.stop();
  });

  it('says nothing about calling when no fallback is set up', async () => {
    const { care, said, dialled } = client(null);
    await care.press('key');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(said).toEqual(['Hilferuf wird gesendet.', 'Dein Hilferuf ist noch nicht gesendet. Ich versuche es weiter.']);
    await care.press('key');
    expect(dialled).toEqual([]);
    expect(said.at(-1)).toBe('Hilferuf wird gesendet.');
    care.stop();
  });

  it('withdraws the offer when the request is cancelled before it was sent', async () => {
    const { care, said, dialled } = client({ name: 'Maria', number: '+493012345678', direct: true });
    await care.press('touch');
    await vi.advanceTimersByTimeAsync(15_000);
    await care.cancel();
    expect(said.at(-1)).toBe('Hilferuf abgebrochen. Er wurde nicht gesendet.');
    await care.press('touch');
    expect(dialled).toEqual([]);
    care.stop();
  });
});

describe('a help request the server refuses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    signedCall.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps being sent when a signature is refused; only a revoked device stops it', async () => {
    const { care, said, revoked } = client(null);
    signedCall.mockImplementation(() => Promise.reject(new ApiError(401, 'unauthorised', { reason: 'signature' })));
    await care.press('touch');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(revoked.n).toBe(0);
    expect(signedCall.mock.calls.length).toBeGreaterThan(1);
    expect(said.at(-1)).toBe('Dein Hilferuf ist noch nicht gesendet. Ich versuche es weiter.');
    signedCall.mockImplementation(() => Promise.reject(new ApiError(401, 'unauthorised', { reason: 'device_revoked' })));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(revoked.n).toBe(1);
    care.stop();
  });
});
