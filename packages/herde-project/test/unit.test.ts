import { describe, expect, it } from 'vitest';
import { canonical, canonicalHash, DEFAULT_PROFILE, inspectMp3, plausible, Profile } from '../src/index.ts';
import { fixture, MP3_1S } from './helpers.ts';

describe('canonical JSON', () => {
  it('hashes the profile fixture exactly as herde (Python) does', () => {
    // The fixture's hash is Python's json.dumps(sort_keys, (",", ":"), ensure_ascii=False) of {"tts": …}.
    // JSON.parse turns its top_p 1.0 into 1: without the float keys the hash would differ.
    const body = fixture('profile').response.body as { profile: string; tts: unknown };
    expect(canonicalHash({ tts: body.tts })).toBe(body.profile);
    expect(canonical({ top_p: 1, chunk_chars: 300 })).toBe('{"chunk_chars":300,"top_p":1.0}');
  });

  it('writes non-ASCII as it is and escapes only what JSON must', () => {
    expect(canonical({ b: 'größer – "ja"\n', a: [1, null, true] })).toBe('{"a":[1,null,true],"b":"größer – \\"ja\\"\\n"}');
  });

  it("serves the profile's own bytes, and its hash covers everything but itself", () => {
    const p = new Profile(DEFAULT_PROFILE);
    const doc = JSON.parse(p.bytes);
    expect(doc.profile).toBe(p.hash);
    expect(canonicalHash({ tts: doc.tts })).toBe(p.hash);
    expect(p.bytes).toContain('"top_p":1.0');
  });
});

describe('MP3', () => {
  it('measures a real clip', () => {
    const c = inspectMp3(MP3_1S);
    expect(c.ok).toBe(true);
    // LAME pads the start and the end: within a frame or two of a second.
    expect(c.ms).toBeGreaterThan(950);
    expect(c.ms).toBeLessThan(1150);
  });

  it('refuses what is no MP3', () => {
    expect(inspectMp3(new TextEncoder().encode('ID3' + '\0'.repeat(200))).ok).toBe(false);
    expect(inspectMp3(new Uint8Array(4000)).ok).toBe(false);
    expect(inspectMp3(MP3_1S.slice(0, 300)).ok).toBe(false);
  });
});

describe('plausible speech length (ARCHE Tasks::plausible)', () => {
  it('takes a short text even when its clip is short', () => {
    expect(plausible('Hilfe ist unterwegs.', 1000)).toBe(true);
  });
  it('refuses a clip far too short or far too long for its words', () => {
    const text = 'x'.repeat(300);
    expect(plausible(text, 1000)).toBe(false); // 300 characters in 1 s: something was skipped
    expect(plausible(text, 60_000)).toBe(false); // over 300/6 + 3 s: something repeated
    expect(plausible(text, 20_000)).toBe(true);
  });
});
