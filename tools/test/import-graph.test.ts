/**
 * The help path must not depend on anything optional (CONCEPT §4: "The dedicated help control and request handling
 * must work independently of the conversational AI."). The core process carries it, so everything core loads is
 * walked from its entry point, and nothing on the way may reach AI, speech, messaging or herde code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const FORBIDDEN_DIRS = ['server/src/ai/', 'server/src/messaging/', 'server/src/assistant/', 'connectors/', 'packages/herde-project/'];
const FORBIDDEN_PACKAGES = ['herde-project', 'tdl', 'prebuilt-tdlib', 'openai', '@anthropic-ai/sdk', 'ollama', '@elevenlabs/elevenlabs-js'];

const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(])import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;

/** Specifiers a file imports (static, re-exports, side-effect and literal dynamic imports). */
export function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Workspace packages resolve to their source, so the walk follows them (packages/shared and the like). */
function resolveWorkspace(spec: string): string | null {
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
  for (const dir of ['packages', 'server', 'connectors']) {
    const root = join(REPO, dir);
    if (!existsSync(root)) continue;
    const candidates = dir === 'packages' ? readDirs(root) : [root];
    for (const pkgDir of candidates) {
      const pkgFile = join(pkgDir, 'package.json');
      if (!existsSync(pkgFile)) continue;
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name: string; exports?: Record<string, string> | string };
      if (pkg.name !== name) continue;
      const entry = typeof pkg.exports === 'string' ? pkg.exports : (pkg.exports?.['.'] ?? './src/index.ts');
      return resolve(pkgDir, entry);
    }
  }
  return null;
}

function readDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name));
}

export function walk(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const next = resolveLocal(file, spec);
        if (next) queue.push(next);
        continue;
      }
      if (spec.startsWith('node:')) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
      packages.add(name);
      const local = resolveWorkspace(spec);
      if (local && existsSync(local)) queue.push(local);
    }
  }
  return { files, packages };
}

describe('the core process loads no AI, speech, messaging or herde code', () => {
  const entry = join(REPO, 'server/src/core/main.ts');
  const { files, packages } = walk(entry);

  it('walks from the core entry point', () => {
    expect(files.has(entry)).toBe(true);
  });

  it('reaches no forbidden directory', () => {
    const bad = [...files].map((f) => relative(REPO, f)).filter((f) => FORBIDDEN_DIRS.some((d) => f.startsWith(d)));
    expect(bad).toEqual([]);
  });

  it('imports no forbidden package', () => {
    expect([...packages].filter((p) => FORBIDDEN_PACKAGES.includes(p))).toEqual([]);
  });
});

describe('the import scanner', () => {
  it('finds static, re-exported, side-effect and dynamic imports', () => {
    const source = [
      "import Fastify from 'fastify';",
      "import { a, type B } from './a.ts';",
      "export { c } from '../c.ts';",
      "import './side-effect.ts';",
      "const m = await import('herde-project');",
    ].join('\n');
    expect(specifiers(source).sort()).toEqual(['../c.ts', './a.ts', './side-effect.ts', 'fastify', 'herde-project'].sort());
  });
});
