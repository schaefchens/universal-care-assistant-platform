/**
 * The app's security policy and inert rendering (docs/plan.md, "App shell rules"; Appendix J UI-08): scripts only
 * from the app itself, never inline or from strings; script URLs only through the app's one Trusted Types policy; and
 * no source file turns a string into markup or code, so text from messages, notes and the language model reaches the
 * screen as text.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, REACT_ARIA_STYLE, REACT_ARIA_STYLE_HASH } from '../src/csp.ts';
import { scriptUrl } from '../src/trusted.ts';

const directives = new Map(
  CONTENT_SECURITY_POLICY.split('; ').map((d) => {
    const [name, ...sources] = d.split(' ');
    return [name!, sources] as const;
  }),
);

describe('the security policy', () => {
  it('runs only the app’s own scripts and styles', () => {
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('style-src')).toEqual(["'self'", `'${REACT_ARIA_STYLE_HASH}'`]);
    expect(directives.get('worker-src')).toEqual(["'self'"]);
    for (const d of ['object-src', 'base-uri', 'frame-src', 'form-action']) expect(directives.get(d), d).toEqual(["'none'"]);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-|strict-dynamic|'wasm/);
  });

  it('allows React Aria’s one inline style, exactly as the installed version writes it', () => {
    expect(`sha256-${createHash('sha256').update(REACT_ARIA_STYLE).digest('base64')}`).toBe(REACT_ARIA_STYLE_HASH);
    const entry = createRequire(import.meta.url).resolve('react-aria');
    const source = readFileSync(join(dirname(entry), '../private/interactions/usePress.mjs'), 'utf8');
    const attribute = /PRESSABLE_ATTRIBUTE = '([^']+)'/.exec(source)?.[1];
    const template = /style\.textContent = `([^`]*)`\.trim\(\)/.exec(source)?.[1];
    expect(template?.replace(/\$\{[^}]*PRESSABLE_ATTRIBUTE\}/, attribute ?? '').trim()).toBe(REACT_ARIA_STYLE);
  });

  it('requires Trusted Types, from the app’s policy only', () => {
    expect(directives.get('require-trusted-types-for')).toEqual(["'script'"]);
    expect(directives.get('trusted-types')).toEqual(['ucap']);
  });

  it('lets requests and media go to any HTTPS server, and over plain HTTP to this computer only', () => {
    for (const d of ['connect-src', 'media-src']) {
      const sources = directives.get(d)!;
      expect(sources).toContain('https:');
      expect(sources, d).not.toContain('*');
      expect(sources, d).not.toContain('http:');
      for (const s of sources.filter((x) => x.startsWith('http://') || x.startsWith('ws://'))) expect(s).toMatch(/^(http|ws):\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2):\*$/);
    }
  });

  it('makes script URLs for the app’s own scripts only', () => {
    expect(scriptUrl('capture-worklet.js')).toBe('capture-worklet.js');
    expect(scriptUrl('./sw.js')).toBe('./sw.js');
    expect(() => scriptUrl('https://example.org/x.js')).toThrow(TypeError);
    expect(() => scriptUrl('data:text/javascript,alert(1)')).toThrow(TypeError);
  });
});

describe('inert rendering', () => {
  const SRC = join(import.meta.dirname, '../src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : /\.(ts|tsx)$/.test(n) ? [join(dir, n)] : []));
  // Every way a string becomes markup or code in a page.
  const SINKS = /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|createContextualFragment|parseFromString|srcdoc|\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]/;

  it('no source file turns a string into markup or code', () => {
    const found = files(SRC).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (SINKS.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//') ? [`${relative(SRC, f)}:${i + 1}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
