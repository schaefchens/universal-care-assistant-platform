import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatSigHeader, parseSigHeader, signedRequestPayload } from '../src/signed-request.ts';
import { statement } from '../src/statements.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/signed-requests.json', import.meta.url), 'utf8')) as { cases: { input: Parameters<typeof signedRequestPayload>[0]; statementHex: string }[] };

describe('signed requests', () => {
  it('build the same statement bytes as the fixture (which the Android code must match too)', () => {
    for (const c of fixture.cases) expect(Buffer.from(statement('req', signedRequestPayload(c.input))).toString('hex')).toBe(c.statementHex);
  });

  it('read back the header they write, and refuse malformed ones', () => {
    const h = formatSigHeader({ did: '01a13a89-5c32-7fe2-910b-9ad519edd569', org: 'https://ucap.example', sig: 'A'.repeat(86) });
    expect(parseSigHeader(h)).toEqual({ did: '01a13a89-5c32-7fe2-910b-9ad519edd569', org: 'https://ucap.example', sig: 'A'.repeat(86) });
    for (const bad of [undefined, '', 'did=x; org=y; sig=z', `did=01a13a89-5c32-7fe2-910b-9ad519edd569; sig=${'A'.repeat(86)}`]) expect(parseSigHeader(bad)).toBeNull();
  });
});
