/**
 * The end-to-end stack, made afresh for every run (compose profile e2e; docs/plan.md, Appendix G): its processes
 * removed, its database dropped and created again, its files emptied, then started (they migrate on start) and
 * waited for through the entry on 8815, the app included (Vite on the host, started by Playwright's webServer
 * before this runs). Stopped again afterwards, unless UCAP_E2E_KEEP=1 (for a look at what a failed run left).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeVoice } from './media.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SERVICES = ['core-e2e', 'assistant-e2e', 'connectors-e2e', 'caddy-e2e'];
const compose = (...args: string[]) => execFileSync('docker', ['compose', '--profile', 'e2e', ...args], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });

async function until(what: string, ok: () => Promise<boolean>, ms = 90_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok().catch(() => false))) {
    if (Date.now() > end) throw new Error(`the e2e stack: no ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  compose('up', '-d', '--wait', 'db', 'ntfy');
  compose('rm', '--stop', '--force', ...SERVICES);
  compose('exec', '-T', 'db', 'psql', '-q', '-U', 'ucap', '-d', 'ucap', '-c', 'drop database if exists ucap_e2e with (force)', '-c', 'create database ucap_e2e');
  compose('run', '--rm', '--no-deps', '--entrypoint', 'sh', 'core-e2e', '-c', 'find /data/files -mindepth 1 -delete');
  writeVoice();
  compose('up', '-d', '--wait', ...SERVICES);
  await until('server', async () => (await fetch('http://localhost:8815/healthz')).ok);
  await until('app', async () => (await fetch('http://localhost:8815/')).ok);
  return async () => {
    if (process.env.UCAP_E2E_KEEP !== '1') compose('stop', ...SERVICES);
  };
}
