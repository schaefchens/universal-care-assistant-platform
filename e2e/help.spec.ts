/**
 * A help request from the person's browser to the helper's (docs/plan.md, acceptance script step 4, in browsers): the
 * press is said as sent only after the server has it, the helper's inbox shows it, and the person hears who accepted
 * and that it was resolved, in the plan's words (A1, A2, A6, A12). Within half an hour of the last run's "Erledigt"
 * a press reopens that request (A12: "Wenn du noch Hilfe brauchst …"), and the person hears that instead of A2.
 */
import type { Page } from '@playwright/test';
import { expect, HELPER, PERSON, said, spoken, test } from './people.ts';

/** Whatever an earlier run left open, the person cancels, as a person would. */
async function nothingOpen(person: Page): Promise<void> {
  await person.goto('/');
  await expect(person.locator('h1').first()).toHaveText('Startseite');
  const open = person.getByRole('button', { name: 'Hilferuf', exact: true });
  if (!(await open.waitFor({ timeout: 3_000 }).then(() => true, () => false))) return;
  const from = (await spoken(person)).length;
  await open.click();
  await person.getByRole('button', { name: 'Hilferuf abbrechen' }).click();
  await person.getByRole('button', { name: 'Ja, abbrechen' }).click();
  await said(person, /^Hilferuf abgebrochen\./, from);
}

test('a help request reaches the helper, and the person hears the accept and the resolve', async ({ person, helper }) => {
  await nothingOpen(person);
  await helper.goto('/');
  await helper.getByRole('button', { name: 'Hilferufe', exact: true }).click();
  await expect(helper.locator('h1').first()).toHaveText('Hilferufe');

  await person.goto('/');
  await expect(person.locator('h1').first()).toHaveText('Startseite');
  const from = (await spoken(person)).length;
  await person.getByRole('button', { name: 'Hilfe', exact: true }).click();
  await said(person, /^Hilferuf wird gesendet\.$/, from);
  await said(person, /^(Dein Hilferuf wurde gesendet\. Ich benachrichtige jetzt deine Helfer\.|Ich frage deine Helfer noch einmal\.)$/, from);

  // A new alert takes the helper's screen, wherever the helper is; it is the person's only open request.
  await expect(helper.getByRole('heading', { name: `Hilferuf von ${PERSON}` }).first()).toBeVisible();
  await helper.getByRole('button', { name: 'Annehmen', exact: true }).click();
  await said(person, new RegExp(`^${HELPER} hat deinen Hilferuf angenommen\\.$`), from);

  await helper.getByRole('button', { name: 'Erledigt', exact: true }).click();
  await said(person, new RegExp(`^${HELPER} hat deinen Hilferuf als erledigt markiert\\.`), from);
  // Nothing the person heard said anyone was coming (CONCEPT §4).
  expect((await spoken(person)).slice(from).filter((t) => /kommt|unterwegs|gleich da/.test(t))).toEqual([]);
});
