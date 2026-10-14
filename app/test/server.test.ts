import { describe, expect, it } from 'vitest';
import { normaliseServerUrl } from '../src/net/server.ts';

describe('the server address a person types', () => {
  it('gets https for a bare host, http only for this computer in development', () => {
    expect(normaliseServerUrl('ucap.example.org')).toBe('https://ucap.example.org');
    expect(normaliseServerUrl('  UCAP.Example.org/  ')).toBe('https://ucap.example.org');
    expect(normaliseServerUrl('localhost:8810')).toBe('http://localhost:8810');
    expect(normaliseServerUrl('10.0.2.2:8810')).toBe('http://10.0.2.2:8810');
    expect(normaliseServerUrl('http://ucap.example.org')).toBe('http://ucap.example.org');
  });

  it('keeps a path and its case, drops a trailing slash', () => {
    expect(normaliseServerUrl('https://example.org/Care/UCAP/')).toBe('https://example.org/Care/UCAP');
  });

  it('refuses what is not a plain server address', () => {
    expect(normaliseServerUrl('')).toBeNull();
    expect(normaliseServerUrl('https://user:pw@example.org')).toBeNull();
    expect(normaliseServerUrl('https://example.org/?x=1')).toBeNull();
    expect(normaliseServerUrl('not a url')).toBeNull();
    expect(normaliseServerUrl('intranet')).toBeNull();
  });
});
