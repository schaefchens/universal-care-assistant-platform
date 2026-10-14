/**
 * The people of the end-to-end tests: "E2E Person" and "E2E Helfer", each in a browser profile of their own
 * (e2e/.profiles, git-ignored) that keeps the device key between runs, so their accounts are made once, through the
 * app's own onboarding (an invitation from the CLI, the twelve words and their check), and the person invites the
 * helper to answer help requests, also through the app. Recovery words are read from the screen into memory to pass
 * the check and never printed.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, expect, type Page, test as base } from '@playwright/test';

export const PERSON = 'E2E Person';
export const HELPER = 'E2E Helfer';

const PROFILES = fileURLToPath(new URL('./.profiles/', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

/** An account invitation from the server's CLI, as an operator makes it. */
function accountInvite(): string {
  const out = execFileSync('docker', ['compose', 'exec', '-T', 'core', 'node', 'server/src/cli.ts', 'account-invite', '--label', 'e2e'], { cwd: REPO }).toString();
  const code = /Code:\s+(\S+)/.exec(out)?.[1];
  if (!code) throw new Error('no invitation from the CLI');
  return code;
}

/** What the app said, from its debug record (development builds keep it in memory). */
export async function spoken(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as unknown as { __ucap?: { spoken: { text: string }[] } }).__ucap?.spoken ?? []).map((s) => s.text));
}

/** Waits until the app has said something that matches, after the first `from` things it said. */
export async function said(page: Page, pattern: RegExp, from = 0): Promise<string> {
  let found = '';
  await expect
    .poll(async () => {
      found = (await spoken(page)).slice(from).find((t) => pattern.test(t)) ?? '';
      return found;
    }, { message: `the app says ${pattern}` })
    .not.toBe('');
  return found;
}

const heading = (page: Page) => page.locator('h1').first();

async function home(page: Page): Promise<void> {
  await page.goto('/');
  await expect(heading(page)).toHaveText(/Startseite|Willkommen bei UCAP|Einladung/);
}

/** Onboarding with an invitation: the name, the twelve words one by one, the card, the check of three of them. */
async function signUp(page: Page, name: string): Promise<void> {
  // A link opened from elsewhere starts the app afresh; only then is the invitation in it read.
  await page.goto('about:blank');
  await page.goto(`/#invite=${accountInvite()}`);
  await expect(heading(page)).toHaveText('Einladung');
  await page.getByLabel('Dein Name').fill(name);
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();
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
  words.fill('');
  // The voices are offered once by listening; the device voice will do here.
  await page.getByRole('button', { name: 'Später', exact: true }).click();
  await expect(heading(page)).toHaveText('Startseite');
}

async function openProfile(name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await chromium.launchPersistentContext(PROFILES + name, {
    headless: true,
    locale: 'de-DE',
    viewport: { width: 1000, height: 800 },
    baseURL: 'http://localhost:8812',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => console.log(`${name}: page error: ${e.name}`));
  return { ctx, page };
}

/** Signed in as `name`: from the profile when it has the account, otherwise a new one. */
async function signedIn(page: Page, name: string): Promise<void> {
  await home(page);
  if ((await heading(page).innerText()) !== 'Startseite') await signUp(page, name);
}

async function helpersPage(page: Page): Promise<void> {
  await home(page);
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await page.getByRole('button', { name: 'Helfer', exact: true }).click();
  await expect(heading(page)).toHaveText('Helfer');
}

/** The helper may answer the person's help requests: invited, accepted and approved through the app, once. */
async function related(person: Page, helper: Page): Promise<void> {
  await helpersPage(helper);
  // Once loaded, the page names whom the helper helps, or says there is nobody.
  await expect(helper.getByText(PERSON).or(helper.getByText('Du hilfst noch niemandem.')).first()).toBeVisible();
  if (await helper.getByText(PERSON).count()) return;
  await helpersPage(person);
  await person.getByRole('checkbox', { name: 'Hilferufe beantworten' }).check();
  await person.getByRole('button', { name: 'Einladung erstellen' }).click();
  const link = await person.getByText(/#invite=/).first().innerText();
  const code = /#invite=(\S+)/.exec(link)![1]!;
  await person.getByRole('button', { name: 'Fertig', exact: true }).click();
  await home(person);
  await helper.getByLabel('Einladungscode').fill(code);
  await helper.getByRole('button', { name: 'Einladung prüfen' }).click();
  await helper.getByRole('button', { name: 'Annehmen', exact: true }).click();
  await expect(helper.getByText(/muss das noch auf dem eigenen Gerät bestätigen/)).toBeVisible();
  // The person approves on their own device: the question comes up there by itself.
  await expect(heading(person)).toHaveText('Hilfe bestätigen');
  await person.getByRole('button', { name: 'Erlauben', exact: true }).click();
  await said(person, new RegExp(`${HELPER} darf dir jetzt helfen`));
  await helpersPage(helper);
  await expect(helper.getByText(PERSON)).toBeVisible();
}

export const test = base.extend<object, { person: Page; helper: Page }>({
  person: [
    async ({}, use) => {
      const { ctx, page } = await openProfile('person');
      await signedIn(page, PERSON);
      await use(page);
      await ctx.close();
    },
    { scope: 'worker' },
  ],
  helper: [
    async ({ person }, use) => {
      const { ctx, page } = await openProfile('helper');
      await signedIn(page, HELPER);
      await related(person, page);
      await use(page);
      await ctx.close();
    },
    { scope: 'worker' },
  ],
});

export { expect };
