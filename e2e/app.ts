/**
 * What the end-to-end tests do in the app, as a person does it, and what they need from the stack: invitations from
 * the server's CLI, what the app said (its debug record, kept in memory by development builds), the onboarding with
 * the twelve words, the talk button with words the speech-recognition stand-in says it heard, and the servers'
 * clocks. Recovery words are read from the screen into memory and never printed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import type { Engines } from './engines.ts';

export const ORIGIN = 'http://localhost:8815';
/** The messaging stand-in's control (tools/dev/fake-services.ts, published by compose's connectors-e2e). */
export const MESSAGING = 'http://localhost:8825';
const REPO = fileURLToPath(new URL('..', import.meta.url));

/** The e2e server's CLI, as an operator runs it. */
export function cli(...args: string[]): string {
  return execFileSync('docker', ['compose', '--profile', 'e2e', 'exec', '-T', 'core-e2e', 'node', 'server/src/cli.ts', ...args], { cwd: REPO }).toString();
}

/** An account invitation (an administrator's with `admin`), its code read from the link line. */
export function invitation(admin = false): string {
  const code = /#invite=(\S+)/.exec(cli(admin ? 'admin-invite' : 'account-invite', '--label', 'e2e'))?.[1];
  if (!code) throw new Error('no invitation from the CLI');
  return code;
}

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

/**
 * The accessibility audit of what the page shows (docs/plan.md, UI-01; docs/plan-m3.md, K9: "accessibility audits of
 * the new screens"): axe-core evaluated in the page over DevTools, as tools/android/axe.ts does on the emulator, so the
 * app's security policy stays as it is. A serious or critical violation fails, named by its rule and where.
 */
export async function axe(page: Page, what: string): Promise<void> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(AXE);
  const found = await page.evaluate(async () => {
    type Result = { violations: { id: string; impact?: string; nodes: { target: string[] }[] }[] };
    const r = await (window as unknown as { axe: { run(c: Document, o: unknown): Promise<Result> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  expect(found, `axe on ${what}`).toEqual([]);
}

/** SQL in the e2e database, for what no screen shows (a link between records). */
export function sql(query: string): string {
  return execFileSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'ucap', '-d', 'ucap_e2e', '-tAc', query], { cwd: REPO }).toString().trim();
}

const logs = new WeakMap<Page, string[]>();

/**
 * Keeps everything the page's app says, in this process, across reloads: the app's debug record (src/debug.ts) is
 * created anew with each page and holds the last hundred only. Before the first navigation.
 */
export async function listen(page: Page): Promise<void> {
  const log: string[] = [];
  logs.set(page, log);
  await page.exposeFunction('__e2eSaid', (text: string) => void log.push(text));
  await page.addInitScript(() => {
    type Rec = { spoken: { text: string }[] };
    const w = window as unknown as { __ucap?: Rec; __e2eSaid(text: string): void };
    let rec: Rec | undefined;
    Object.defineProperty(w, '__ucap', {
      configurable: true,
      get: () => rec,
      set(v: Rec) {
        rec = v;
        const push = v.spoken.push.bind(v.spoken);
        v.spoken.push = (...items) => {
          for (const it of items) w.__e2eSaid(it.text);
          return push(...items);
        };
      },
    });
  });
}

/** What the app said so far (since `listen`). */
export async function spoken(page: Page): Promise<string[]> {
  const log = logs.get(page);
  if (!log) throw new Error('listen(page) first');
  return [...log];
}

/** Waits until the app said something that matches, after the first `from` things it said; returns it. */
export async function said(page: Page, pattern: RegExp, from = 0, timeout?: number): Promise<string> {
  let found = '';
  await expect
    .poll(async () => {
      found = (await spoken(page)).slice(from).find((t) => pattern.test(t)) ?? '';
      return found;
    }, { message: `the app says ${pattern}`, timeout })
    .not.toBe('');
  return found;
}

/** How many things the app has said: a mark to look after. */
export const mark = async (page: Page) => (await spoken(page)).length;

export const heading = (page: Page) => page.locator('h1').first();

/** A React Aria radio or checkbox, set as a person does it: its label is what takes the press. */
export async function setChoice(control: Locator, on = true): Promise<void> {
  if ((await control.isChecked()) !== on) await control.locator('xpath=ancestor::label[1]').click();
  await expect(control).toBeChecked({ checked: on });
}

/** The radio of that name in `scope`, chosen. */
export const choose = (scope: Locator | Page, name: string) => setChoice(scope.getByRole('radio', { name, exact: true }));

export async function home(page: Page): Promise<void> {
  await page.goto('/');
  await expect(heading(page)).toHaveText('Startseite');
}

/**
 * Onboarding with an invitation: the name, the twelve words one by one, the card, three of them checked. Returns the
 * words (German), for the recovery on a new device and for the phrase canary; the caller keeps them in memory only.
 */
export async function signUp(page: Page, name: string, code: string, voice: (page: Page) => Promise<void> = laterVoice, assistantName?: string): Promise<string[]> {
  // A link opened from elsewhere starts the app afresh; only then is the invitation in it read.
  await page.goto('about:blank');
  await page.goto(`/#invite=${code}`);
  await expect(heading(page)).toHaveText('Einladung');
  await page.getByLabel('Dein Name').fill(name);
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();
  const words = await ceremony(page);
  await voice(page);
  await nameStep(page, assistantName);
  await expect(heading(page)).toHaveText('Startseite');
  return words;
}

/** New words shown one by one and three of them checked, from the screen before the first word; returns them. */
export async function ceremony(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: 'Wörter anzeigen' }).click();
  const main = page.locator('main');
  const words: string[] = [];
  for (let n = 1; n <= 12; n++) {
    await expect(main).toContainText(`Wort ${n} von 12`);
    words[n - 1] = /Wort \d+ von 12\s+(\S+)/.exec(await main.innerText())![1]!;
    await page.getByRole('button', { name: n === 12 ? 'Alle Wörter notiert' : 'Nächstes Wort', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Weiter zur Prüfung' }).click();
  let asked = 0;
  for (let round = 0; round < 3; round++) {
    // The next question, not the one just answered.
    let n = 0;
    await expect
      .poll(async () => {
        const m = /Welches ist Wort (\d+)\?/.exec(await main.innerText());
        n = m && Number(m[1]) !== asked ? Number(m[1]) : 0;
        return n;
      })
      .toBeGreaterThan(0);
    asked = n;
    await page.getByRole('button', { name: words[n - 1], exact: true }).click();
  }
  return words;
}

/** The assistant's name, offered once after the voices (docs/plan-m2.md): one of the names, or later. */
export async function nameStep(page: Page, name?: string): Promise<void> {
  const screen = heading(page).filter({ hasText: 'Wie soll ich heißen?' });
  await expect(screen.or(heading(page).filter({ hasText: 'Startseite' }))).toBeVisible();
  if (!(await screen.isVisible())) return;
  await page.getByRole('button', { name: name ?? 'Später', exact: true }).click();
}

/** The voices are offered once, by listening, when there is more than the device voice; the device voice will do. */
export async function laterVoice(page: Page): Promise<void> {
  const later = page.getByRole('button', { name: 'Später', exact: true });
  await expect(later.or(heading(page).filter({ hasText: 'Startseite' }))).toBeVisible();
  if (await later.isVisible()) await later.click();
}

/**
 * The person presses the talk button and says `words`: the fake microphone's voice, then a pause, ends the utterance,
 * and speech recognition (the stand-in) hears the words. What follows may be another screen.
 */
export async function talk(page: Page, engines: Engines, words: string): Promise<void> {
  engines.heard.push(words);
  await page.getByRole('button', { name: 'Sprechen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fertig', exact: true })).toBeVisible();
  await expect.poll(() => engines.heard.length, { message: `the turn "${words}" reached speech recognition`, timeout: 15_000 }).toBe(0);
  await expect(page.getByRole('button', { name: 'Fertig', exact: true })).toBeHidden();
}

/** Both processes' clocks (test mode), moved to the same time. */
export const clocks = {
  async now(): Promise<number> {
    return ((await (await fetch(`${ORIGIN}/__test/clock`)).json()) as { now: number }).now;
  },
  /** `messaging` false: the messaging stand-in is stopped (acceptance 14) and keeps its time. */
  async moveTo(at: number, o: { messaging?: boolean } = {}): Promise<void> {
    for (const path of ['/__test/clock', '/__test/assistant/clock']) {
      const r = await fetch(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ at }) });
      expect(r.ok, path).toBe(true);
    }
    // The messaging stand-in keeps the same time, or new messages would look hours old.
    if (o.messaging !== false) expect((await fetch(`${MESSAGING}/clock`, { method: 'POST', body: JSON.stringify({ at: await clocks.now() }) })).ok).toBe(true);
  },
  async advance(ms: number): Promise<void> {
    await clocks.moveTo((await clocks.now()) + ms);
  },
};
