/**
 * What others wrote is shown as text, never as a page (docs/plan-m3.md, K9: "email text rendered inert"). An email's
 * HTML becomes plain text in the email process, nothing fetched (connectors/src/email/text.ts, its tests); messages of
 * every service reach the app as text, and the app puts text into the page only as text: React escapes it, and no
 * code hands a string to the page as HTML. The app's security policy enforces it besides: with Trusted Types required
 * for scripts, an HTML sink given a string throws.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

const SINKS = /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\bsrcdoc\b|createContextualFragment|DOMParser/;

describe('text from others', () => {
  it('the app hands no string to the page as HTML, and its policy requires Trusted Types', () => {
    const files = sources(join(REPO, 'app/src'));
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => SINKS.test(readFileSync(f, 'utf8'))).map((f) => relative(REPO, f))).toEqual([]);
    const csp = readFileSync(join(REPO, 'app/src/csp.ts'), 'utf8');
    expect(csp).toContain("require-trusted-types-for 'script'");
  });
});
