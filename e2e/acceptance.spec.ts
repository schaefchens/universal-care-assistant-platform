/**
 * Milestone 1's acceptance script (docs/plan.md, "Milestone 1: acceptance script"), walked in browsers against the
 * e2e stack: Maria (operator and first helper) and Clara (the person) in browsers of their own, Tom (the second
 * helper) on a simulated phone (phone.ts), the AI engines and Telegram replaced by stand-ins, the servers' clock moved
 * forward where the script waits. Each step builds on the ones before: they run in order, and the first that fails
 * ends the walk. What the app said is read from its debug record; recovery words stay in this process's memory.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { fromWords, toWords } from '@ucap/identity';
import { appointmentReadback, appointmentWhen } from '@ucap/shared';
import { axe, choose, clocks, heading, home, invitation, listen, mark, ORIGIN, said, setChoice, signUp, spoken, sql, talk, MESSAGING } from './app.ts';
import { type ChatRequest, type Engines, reply, startEngines } from './engines.ts';
import { type Phone, phone, type SmsPhone, smsPhone } from './phone.ts';

test.describe.configure({ mode: 'serial' });

const REPO = fileURLToPath(new URL('..', import.meta.url));

let engines: Engines;
const contexts: BrowserContext[] = [];
let maria: Page;
let clara: Page;
let tom: Phone;
/** Clara's phone, UCAP its SMS app (from 7b on). */
let ph: SmsPhone;
/** Each account's twelve words, in memory only: the recovery on a new device, and the phrase canary. */
const words = new Map<string, string[]>();

async function open(browser: Browser, name: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: ORIGIN, locale: 'de-DE', timezoneId: 'Europe/Berlin', permissions: ['microphone'], viewport: { width: 1000, height: 900 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`${name}: page error: ${e.name}`));
  await listen(page);
  return page;
}

async function helpersPage(page: Page): Promise<void> {
  await home(page);
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await page.getByRole('button', { name: 'Helfer', exact: true }).click();
  await expect(heading(page)).toHaveText('Helfer');
}

/** The person invites a helper with these scopes; returns the code of the link and the spoken code. */
async function invite(page: Page, scopes: string[]): Promise<{ link: string; spoken: string }> {
  await helpersPage(page);
  for (const box of await page.getByRole('group', { name: 'Was darf die Person, die du einlädst?' }).getByRole('checkbox').all()) {
    const label = (await box.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.innerText ?? '')).trim();
    await setChoice(box, scopes.includes(label));
  }
  await page.getByRole('button', { name: 'Einladung erstellen' }).click();
  const spokenCode = (await page.locator('.invite-code').innerText()).replace(/\s/g, '');
  const link = /#invite=(\S+)/.exec(await page.locator('.invite-link').innerText())![1]!;
  await page.getByRole('button', { name: 'Fertig', exact: true }).click();
  return { link, spoken: spokenCode };
}

/**
 * The approval comes up on the person's own device by itself (`from`: a mark from before the helper accepted), with
 * its summary read out; the person allows it. Returns the summary.
 */
async function approve(page: Page, helper: string, from: number): Promise<string> {
  await expect(heading(page)).toHaveText('Hilfe bestätigen');
  const summary = await said(page, new RegExp(`^${helper} möchte dir helfen\\. ${helper} darf `), from);
  await page.getByRole('button', { name: 'Erlauben', exact: true }).click();
  await said(page, new RegExp(`^${helper} darf dir jetzt helfen\\.$`), from);
  return summary;
}

/** The next time it is hh:mm in Berlin after `at` (Unix milliseconds), as Unix milliseconds. */
function nextBerlin(at: number, hh: number, mm: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]));
  const offset = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(at / 1000) * 1000;
  let t = Date.UTC(parts.year!, parts.month! - 1, parts.day!, hh, mm) - offset;
  if (t <= at) t += 86_400_000;
  return t;
}

/** Whether any three words in a row of a phrase occur in `text`, in order (ID-02's canary). */
function phraseIn(text: string, phrase: readonly string[]): boolean {
  const said = text.toLowerCase().split(/[^a-zäöüß]+/).filter(Boolean);
  for (let i = 0; i + 3 <= phrase.length; i++)
    for (let j = 0; j + 3 <= said.length; j++) if (said[j] === phrase[i] && said[j + 1] === phrase[i + 1] && said[j + 2] === phrase[i + 2]) return true;
  return false;
}

/** The model's answer to the person's words; a tool's data (DATEN …) gets the second answer. */
type Answer = (req: ChatRequest) => ReturnType<Engines['model']>;
const asked = (words: RegExp, first: Answer, then?: Answer): Answer => (req) => {
  const last = engines.last(req);
  if (last.startsWith('DATEN') && then) return then(req);
  return words.test(last) ? first(req) : reply('Das habe ich nicht verstanden.');
};

test.beforeAll(async ({ browser }) => {
  engines = await startEngines();
  maria = await open(browser, 'Maria');
  clara = await open(browser, 'Clara');
});

// On a failure, what was heard and said last (scripted texts and the app's own announcements; the app's record
// never holds recovery words).
test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  console.log(`heard: ${JSON.stringify(engines.seen.transcribed.slice(-6))}`);
  for (const [name, page] of [['Clara', clara], ['Maria', maria]] as const) if (page) console.log(`${name} said: ${JSON.stringify((await spoken(page)).slice(-12))}`);
});

test.afterAll(async () => {
  for (const c of contexts) await c.close();
  await tom?.close();
  await engines?.close();
  words.clear();
});

test('1 · the operator: an administrator from the CLI, a voice service and Telegram set up on the admin page, WhatsApp allowed after its risk', async () => {
  words.set('Maria', await signUp(maria, 'Maria', invitation(true)));
  await maria.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await maria.getByRole('button', { name: 'KI und Stimmen verwalten' }).click();
  await expect(heading(maria)).toHaveText('KI und Stimmen');
  // A voice service of one's own: the stand-in speaks OpenAI's speech API.
  const form = maria.locator('form').filter({ has: maria.getByRole('button', { name: 'Hinzufügen', exact: true }) });
  await choose(form, 'Sprachausgabe');
  await choose(form, 'OpenAI oder ein Server mit derselben Schnittstelle');
  await form.getByLabel('Name', { exact: true }).fill('Teststimmen');
  await form.getByLabel('Adresse', { exact: true }).fill('http://host.docker.internal:8824');
  await form.getByLabel('Modell', { exact: true }).fill('fake-tts');
  await choose(form, 'auf eigenen Rechnern');
  await form.getByLabel('Stimmen', { exact: true }).fill('alloy:Alloy:de,en');
  await form.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
  await expect(form.getByText('Teststimmen hinzugefügt.')).toBeVisible();
  // Telegram's credentials, invented: the messaging stand-in never reaches Telegram.
  const telegram = maria.locator('section').filter({ has: maria.getByRole('heading', { name: 'Telegram', exact: true }) });
  await telegram.getByLabel('api_id', { exact: true }).fill('1234567');
  await telegram.getByLabel('api_hash', { exact: true }).fill('0123456789abcdef0123456789abcdef');
  await telegram.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(telegram.getByText('Eingerichtet: api_id 1234567.')).toBeVisible();
  // WhatsApp: off until the operator, having read the risk, allows it (docs/plan-m3.md, acceptance step 1).
  const whatsapp = maria.locator('section').filter({ has: maria.getByRole('heading', { name: 'WhatsApp', exact: true }) });
  await expect(whatsapp.getByText(/Meta kann die Nummer eines Menschen dafür sperren/)).toBeVisible();
  const allow = whatsapp.getByRole('switch', { name: 'WhatsApp auf diesem Server erlauben' });
  await expect(allow).not.toBeChecked();
  await whatsapp.getByText('WhatsApp auf diesem Server erlauben').click();
  await expect(whatsapp.getByText('WhatsApp ist erlaubt.')).toBeVisible();
  await axe(maria, 'KI und Stimmen verwalten, with WhatsApp');
  await expect(allow).toBeChecked();
});

test('2 · the person creates an identity: twelve words, three checked, a reply voice chosen by listening; four areas', async () => {
  const sampled = engines.seen.speech.length;
  words.set(
    'Clara',
    await signUp(clara, 'Clara', invitation(), async (page) => {
      await page.getByRole('button', { name: 'Alloy (Teststimmen)', exact: true }).click();
      await expect(page.getByText('Alloy (Teststimmen): Diese Stimme nehmen?')).toBeVisible();
      await page.getByRole('button', { name: 'Diese Stimme nehmen', exact: true }).click();
    }, 'Mathilda'),
  );
  // The sample came from the voice service; the choice was said.
  expect(engines.seen.speech.length).toBeGreaterThan(sampled);
  await said(clara, /Alloy \(Teststimmen\) spricht jetzt/);
  // The assistant's name, chosen after the voices (docs/plan-m2.md).
  await said(clara, /^Ich heiße jetzt Mathilda\. /);
  const areas = await clara.locator('.area-grid button').allInnerTexts();
  expect(areas.length, areas.join(' | ')).toBe(4);
  expect(areas[0]).toContain('Hilfe');
});

test('3 · Maria is invited with the spoken code, sees what Maria may do, and is allowed on the person’s device; Tom too; the order is set', async () => {
  const code = await invite(clara, ['Hilferufe beantworten', 'Erinnerungen verwalten', 'Bedienung der Geräte einstellen']);
  expect(code.spoken).toMatch(/^\d{10}$/);
  await home(clara);
  await helpersPage(maria);
  await maria.getByLabel('Einladungscode').fill(code.spoken);
  await maria.getByRole('button', { name: 'Einladung prüfen' }).click();
  await expect(maria.getByText(/Hilferufe beantworten, Erinnerungen verwalten und Bedienung der Geräte einstellen/)).toBeVisible();
  let from = await mark(clara);
  await maria.getByRole('button', { name: 'Annehmen', exact: true }).click();
  // Said the same way every time: what Maria may do, and that Maria may not read messages or notes.
  expect(await approve(clara, 'Maria', from)).toBe(
    'Maria möchte dir helfen. Maria darf auf deine Hilferufe antworten, deine Erinnerungen anlegen und ändern und die Bedienung deiner Geräte einstellen. Maria darf nicht deine Nachrichten lesen oder deine Notizen lesen.',
  );
  // Tom answers help requests only, and accepts on the phone.
  const forTom = await invite(clara, ['Hilferufe beantworten']);
  await home(clara);
  tom = await phone('Tom', invitation());
  from = await mark(clara);
  await tom.acceptInvite(forTom.link);
  await approve(clara, 'Tom', from);
  // The order: Maria at once, Tom when nobody accepted within two minutes.
  await helpersPage(clara);
  await choose(clara.getByRole('radiogroup', { name: 'Tom benachrichtigen' }), 'nach 2 Minuten, wenn niemand angenommen hat');
  from = await mark(clara);
  await clara.getByRole('button', { name: 'Reihenfolge speichern' }).click();
  await said(clara, /^Gespeichert\. Bei einem Hilferuf benachrichtige ich sofort Maria\. Hat nach 2 Minuten niemand angenommen, auch Tom\.$/, from);
});

test('3b · a helper the person allows can set the order too, and the person’s history names the helper', async () => {
  // Clara lets Maria set who is notified (care.configure).
  await helpersPage(clara);
  const mariaItem = clara.locator('li.device').filter({ has: clara.getByRole('heading', { name: 'Maria', exact: true }) });
  await mariaItem.getByRole('button', { name: 'Ändern', exact: true }).click();
  await setChoice(mariaItem.getByRole('checkbox', { name: 'Benachrichtigung bei Hilferufen einstellen' }));
  await mariaItem.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(mariaItem.getByText(/Benachrichtigung bei Hilferufen einstellen/)).toBeVisible();
  // Maria opens Clara's order from the people Maria helps: five minutes for Tom, then two again.
  await helpersPage(maria);
  const claraItem = maria.locator('li.device').filter({ has: maria.getByRole('heading', { name: 'Clara', exact: true }) });
  await claraItem.getByRole('button', { name: 'Benachrichtigung bei Hilferufen einstellen' }).click();
  const order = claraItem.locator('section').filter({ has: maria.getByRole('heading', { name: 'Reihenfolge bei Hilferufen von Clara' }) });
  for (const minutes of [5, 2]) {
    await choose(order.getByRole('radiogroup', { name: 'Tom benachrichtigen' }), `nach ${minutes} Minuten, wenn niemand angenommen hat`);
    const from = await mark(maria);
    await order.getByRole('button', { name: 'Reihenfolge speichern' }).click();
    await said(maria, new RegExp(`^Gespeichert\\. Bei einem Hilferuf benachrichtige ich sofort Maria\\. Hat nach ${minutes} Minuten niemand angenommen, auch Tom\\.$`), from);
  }
  // In Clara's history: who changed it.
  await helpersPage(clara);
  await expect(clara.getByText('Maria hat die Einstellungen für Hilferufe geändert').first()).toBeVisible();
});

test('4 · help: said as sent only once the server has it; Maria’s device has it; Maria accepts, replies and resolves', async () => {
  await home(maria);
  await maria.getByRole('button', { name: 'Hilferufe', exact: true }).click();
  await home(clara);
  const from = await mark(clara);
  await clara.getByRole('button', { name: 'Hilfe', exact: true }).click();
  await said(clara, /^Hilferuf wird gesendet\.$/, from);
  await said(clara, /^Dein Hilferuf wurde gesendet\. Ich benachrichtige jetzt deine Helfer\.$/, from);
  await said(clara, /^Das Gerät von Maria hat deinen Hilferuf erhalten\.$/, from);
  // A new alert takes Maria's screen.
  await expect(heading(maria)).toHaveText('Hilferuf von Clara');
  await maria.getByRole('button', { name: 'Annehmen', exact: true }).click();
  await said(clara, /^Maria hat deinen Hilferuf angenommen\.$/, from);
  await maria.getByRole('button', { name: 'Ich bin unterwegs.', exact: true }).click();
  await said(clara, /^Maria sagt: „Ich bin unterwegs\.“$/, from);
  await maria.getByRole('button', { name: 'Erledigt', exact: true }).click();
  await said(clara, /^Maria hat deinen Hilferuf als erledigt markiert\./, from);
  // Tom is notified only after two minutes: nothing reached Tom’s phone.
  expect(tom.pushed.filter((p) => p.t === 'care.alert')).toEqual([]);
  // No system text said anyone was coming; only Maria's own words were quoted (CONCEPT §4).
  expect((await spoken(clara)).slice(from).filter((t) => /kommt|unterwegs|gleich da/.test(t) && !t.startsWith('Maria sagt:'))).toEqual([]);
});

test('5 · escalation: nobody accepts within two minutes, Tom is alerted and Tom’s phone has it; Tom accepts on the alarm; Maria is told', async () => {
  // Past the half hour in which a press would reopen the last request.
  await clocks.advance(31 * 60_000);
  await home(maria);
  await home(clara);
  const from = await mark(clara);
  await clara.getByRole('button', { name: 'Hilfe', exact: true }).click();
  await said(clara, /^Dein Hilferuf wurde gesendet\. Ich benachrichtige jetzt deine Helfer\.$/, from);
  await expect(heading(maria)).toHaveText('Hilferuf von Clara');
  // Two minutes, and nobody accepted.
  await clocks.advance(121_000);
  await said(clara, /^Noch hat niemand angenommen\. Ich benachrichtige jetzt auch Tom\.$/, from);
  await expect.poll(() => tom.pushed.some((p) => p.t === 'care.alert'), { message: 'the alert reached Tom’s phone' }).toBe(true);
  const alert = tom.pushed.find((p) => p.t === 'care.alert')!;
  expect(alert.who).toBe('Clara');
  // The phone's receipt, signed by it: the person hears that Tom's device has it.
  await said(clara, /^Das Gerät von Tom hat deinen Hilferuf erhalten\.$/, from);
  const fromMaria = await mark(maria);
  await tom.accept(alert.rid!, alert.ep!);
  await said(clara, /^Tom hat deinen Hilferuf angenommen\.$/, from);
  // Maria's alert gives way to the list, and Maria is told who took over.
  await said(maria, /^Tom kümmert sich um den Hilferuf von Clara\.$/, fromMaria);
  await expect(heading(maria)).toHaveText('Hilferufe');
  await tom.resolve(alert.rid!, alert.ep!);
  await said(clara, /^Tom hat deinen Hilferuf als erledigt markiert\./, from);
});

test('6 · a reminder: Maria sets "Trinken" for 15:00; at 15:00 it asks; "Noch nicht. Kann mir jemand Wasser bringen?" leads to the question, "Ja" to a help request linked to it', async () => {
  // A three o'clock in the afternoon past step 5's reopen window (30 minutes after its request was resolved), or "Ja"
  // would reopen that request instead of sending a new one. The clock goes to five minutes before it while the reminder
  // does not exist yet: a jump past another three o'clock after it was set would leave that one asking, a day late (a
  // walk started at 14:20 showed it again at step 9).
  const due = nextBerlin((await clocks.now()) + 31 * 60_000, 15, 0);
  await clocks.moveTo(due - 5 * 60_000);
  // Maria, who may manage the person's reminders.
  await home(maria);
  await maria.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await maria.getByRole('button', { name: 'Helfer', exact: true }).click();
  await maria.getByRole('button', { name: 'Erinnerungen von Clara' }).click();
  await expect(heading(maria)).toHaveText('Erinnerungen von Clara');
  await maria.getByRole('button', { name: 'Neue Erinnerung' }).click();
  const editor = maria.locator('form.reminder-editor');
  await choose(editor, 'Trinken');
  await choose(editor, 'Täglich zu festen Zeiten');
  await editor.getByLabel('Uhrzeiten', { exact: true }).fill('15:00');
  await editor.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(maria.getByText(/^Erinnerung „Trinken“ gespeichert/).first()).toBeVisible();

  // Half a minute before three, then three.
  await home(clara);
  await clocks.moveTo(due - 30_000);
  const from = await mark(clara);
  await clocks.moveTo(due + 1_000);
  await expect(heading(clara)).toHaveText('Trinken');
  await said(clara, /Trinken/, from);

  // The person's answer goes to the language model, which proposes help: the person is asked (A17).
  engines.model = asked(/Wasser/, () => ({ say: [], calls: [], help: true }));
  await talk(clara, engines, 'Noch nicht. Kann mir jemand Wasser bringen?');
  await said(clara, /^Soll ich einen Hilferuf senden\?$/, from);
  await expect(heading(clara)).toHaveText('Soll ich einen Hilferuf senden?');
  await talk(clara, engines, 'Ja');
  await said(clara, /^Dein Hilferuf wurde gesendet\. Ich benachrichtige jetzt deine Helfer\.$/, from);
  // Proposed by the assistant, confirmed by the person, and linked to the reminder, whose answer is "help".
  await expect.poll(() => sql(`select r.source || ' ' || rem.category from care_requests r join reminders rem on rem.id = r.reminder_id order by r.received_at desc limit 1`)).toBe('assistant drink');
  expect(sql(`select rr.kind from reminder_responses rr join care_requests r on r.id = rr.care_request order by rr.at desc limit 1`)).toBe('help');
  // Maria takes it and closes it.
  await expect(heading(maria)).toHaveText('Hilferuf von Clara');
  await maria.getByRole('button', { name: 'Annehmen', exact: true }).click();
  await maria.getByRole('button', { name: 'Erledigt', exact: true }).click();
  await said(clara, /^Maria hat deinen Hilferuf als erledigt markiert\./, from);
});

test('7 · Telegram: connected on the person’s device; a new message announced by its sender and what it says; a summary said as one; the original framed; a reply sent only after "Ja", and "Gesendet" only once Telegram confirmed', async () => {
  await clocks.advance(31 * 60_000); // past the reopen window of the last request
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Nachrichtendienste', exact: true }).click();
  await expect(heading(clara)).toHaveText('Nachrichtendienste');
  await expect(clara.getByText('Noch ist kein Nachrichtendienst verbunden.')).toBeVisible();
  await clara.getByRole('button', { name: 'Telegram verbinden' }).click();
  await expect(heading(clara)).toHaveText('Telegram');
  await clara.getByRole('button', { name: 'Telegram verbinden' }).click();
  await clara.getByLabel('Telefonnummer').fill('+49 170 1234567');
  await clara.getByRole('button', { name: 'Weiter', exact: true }).click();
  await clara.getByLabel('Code', { exact: true }).fill('22222');
  await clara.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(clara.getByText('Verbunden als Clara Test.')).toBeVisible();
  // Back on the list: the connection says what it can do, its history from a day on, never "all of it" (Appendix K; CONCEPT §3).
  let from = await mark(clara);
  await clara.getByRole('button', { name: 'Zurück', exact: true }).click();
  await expect(clara.getByText(/^Telegram: verbunden\. hat Nachrichten ab dem \d+\. \S+ \d{4}; antwortet in den Unterhaltungen, die es gibt, und schreibt an deine Kontakte; „gesendet“, sobald Telegram es bestätigt\.$/)).toBeVisible();
  await said(clara, /^Nachrichtendienste\. Telegram: verbunden\.$/, from);
  await home(clara);

  // Anna writes; the person hears who and what (the owner, 2026-10-27: "should say what, in general for all messages").
  from = await mark(clara);
  const sent = await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ chat: 'anna', text: 'Kannst du morgen zum Kaffee kommen?' }) });
  expect(sent.ok).toBe(true);
  await said(clara, /^Neue Nachricht von Anna Beispiel: „Kannst du morgen zum Kaffee kommen\?“$/, from);

  // "Lies meine neuen Nachrichten": the model reads them (data, not instructions) and sums them up, said as a summary.
  engines.model = asked(/Lies meine neuen Nachrichten/, () => ({ say: [], calls: [{ tool: 'messages.read', chat: null, unread_only: true }], help: false }), () => ({ say: [{ kind: 'summary', text: 'Anna fragt, ob du morgen zum Kaffee kommst.', ref: null }], calls: [], help: false }));
  await talk(clara, engines, 'Lies meine neuen Nachrichten');
  await said(clara, /^Zusammenfassung: Anna fragt, ob du morgen zum Kaffee kommst\.$/, from);

  // "Lies sie genau vor": the original, word for word from the source, framed with sender and time.
  // The data lists messages oldest first: the newest is Anna's.
  const refOf = (req: ChatRequest) => [...engines.last(req).matchAll(/"ref":\s*"(msg:[^"]+)"/g)].at(-1)?.[1] ?? null;
  engines.model = asked(/genau vor/, () => ({ say: [], calls: [{ tool: 'messages.read', chat: 'Anna Beispiel', unread_only: false }], help: false }), (req) => ({ say: [{ kind: 'original', text: 'Kannst du morgen?', ref: refOf(req) }], calls: [], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Lies sie genau vor');
  const original = await said(clara, /Kannst du morgen zum Kaffee kommen\?/, from);
  expect(original).toMatch(/^Anna Beispiel schrieb .*auf Telegram:/);

  // The reply: the confirmation question (C1), "Ja", then "Wird gesendet." (C2); "Gesendet" (C3) only once Telegram confirms.
  expect((await fetch(`${MESSAGING}/hold`, { method: 'POST', body: JSON.stringify({ on: true }) })).ok).toBe(true);
  engines.model = asked(/Antworte/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Anna Beispiel', text: 'Morgen passt.' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Antworte, dass morgen passt');
  await said(clara, /^Nachricht an Anna Beispiel über Telegram: „Morgen passt\.“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Wird gesendet\.$/, from);
  await new Promise((r) => setTimeout(r, 2_000));
  expect((await spoken(clara)).slice(from).some((t) => /^Gesendet an/.test(t))).toBe(false);
  expect((await fetch(`${MESSAGING}/hold`, { method: 'POST', body: JSON.stringify({ on: false }) })).ok).toBe(true);
  await said(clara, /^Gesendet an Anna Beispiel\.$/, from);
});

test('7b · across services (docs/plan-m3.md, K1): WhatsApp linked and UCAP the SMS app on Clara’s phone; the assistant, the services page and the messages screen name each message’s service; a reply by SMS waits for the phone, "Gesendet" at its report', async () => {
  await home(clara);
  // Clara's phone joins her account with her words; UCAP is its SMS app.
  let from = await mark(clara);
  ph = await smsPhone('Clara', words.get('Clara')!);
  await said(clara, /^Mit deinen Wiederherstellungswörtern wurde ein neues Gerät hinzugefügt: Telefon von Clara\.$/, from);
  // WhatsApp, on its own page (K2): the risk said first and agreed to, the number, then the pairing code, shown and said
  // character by character, "typed on the phone" (the stand-in's /pair).
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Nachrichtendienste', exact: true }).click();
  from = await mark(clara);
  await clara.getByRole('button', { name: 'WhatsApp verbinden', exact: true }).click();
  await said(clara, /^Bevor du verbindest: WhatsApp erlaubt keine fremden Programme\. .* Meta kann deine Nummer dafür sperren/, from);
  await clara.getByRole('button', { name: 'Ich habe die Gefahr verstanden: WhatsApp verbinden', exact: true }).click();
  await said(clara, /^Gib die Nummer deines WhatsApp ein, mit Ländervorwahl/, from);
  await clara.getByLabel('Telefonnummer').fill('+49 170 1234567');
  await clara.getByRole('button', { name: 'Weiter', exact: true }).click();
  await said(clara, /^Der Code für WhatsApp: U, C, A, P, 2, 0, 2, 6\. Öffne WhatsApp auf deinem Telefon: Einstellungen, Verknüpfte Geräte, Gerät hinzufügen\./, from);
  await expect(clara.getByText('UCAP-2026', { exact: true })).toBeVisible();
  await axe(clara, 'the WhatsApp page with its pairing code');
  expect((await fetch(`${MESSAGING}/pair`, { method: 'POST' })).ok).toBe(true);
  await said(clara, /^Verbunden als Clara Test\. UCAP hat deine Nachrichten der letzten 30 Tage und alle neuen\.$/, from);

  // The services page names all three, each with its state.
  await clara.getByRole('button', { name: 'Zurück', exact: true }).click();
  await said(clara, /^Nachrichtendienste\. Telegram: verbunden\. SMS: verbunden\. WhatsApp: verbunden\.$/, from);
  await axe(clara, 'Nachrichtendienste');
  await home(clara);

  // Anna writes on WhatsApp and by SMS, stamped with the servers' time; each is announced by its sender and, as there
  // is more than one service now, where it came.
  from = await mark(clara);
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ service: 'whatsapp', chat: 'anna', text: 'Am Samstag grillen wir, kommst du?' }) })).ok).toBe(true);
  await said(clara, /^Neue Nachricht von Anna Beispiel auf WhatsApp: „Am Samstag grillen wir, kommst du\?“$/, from);
  from = await mark(clara);
  await ph.receive({ number: '+4915112345678', name: 'Anna Beispiel' }, 'Ich bin um drei bei dir.', await clocks.now());
  await said(clara, /^Neue Nachricht von Anna Beispiel per SMS: „Ich bin um drei bei dir\.“$/, from);

  // "Lies meine neuen Nachrichten": the model gets each message with its service.
  let data = '';
  engines.model = asked(
    /Lies meine neuen Nachrichten/,
    () => ({ say: [], calls: [{ tool: 'messages.read', chat: null, unread_only: true }], help: false }),
    (req) => {
      data = engines.last(req);
      return { say: [{ kind: 'summary', text: 'Anna lädt dich zum Grillen ein und kommt um drei.', ref: null }], calls: [], help: false };
    },
  );
  from = await mark(clara);
  await talk(clara, engines, 'Lies meine neuen Nachrichten');
  await said(clara, /^Zusammenfassung: Anna lädt dich zum Grillen ein und kommt um drei\.$/, from);
  for (const service of ['WhatsApp', 'SMS']) expect(data).toContain(`"service":"${service}"`);

  // The messages screen reads the unread, oldest first, each with where it came from: WhatsApp's, the SMS, Anna's answer
  // on Telegram to step 7's reply (4 s after it, so it may come after the others), and step 7's own message when its
  // original was not heard to its end there. "Nächste" leads on. The first waits for the news still being said, and a
  // browser's speech that stalls is cut only after about twice its time (src/audio/speech.ts): it may take a while.
  await expect.poll(() => sql(`select count(*) from messaging_messages where text = 'Schön, bis dann!'`)).toBe('1');
  const frames = [/^Anna Beispiel schrieb .* auf Telegram: Schön, bis dann!$/, /^Anna Beispiel schrieb .* auf WhatsApp: Am Samstag grillen wir, kommst du\?$/, /^Anna Beispiel schrieb .* per SMS: Ich bin um drei bei dir\.$/];
  const framed = async () => (await spoken(clara)).slice(from).filter((t) => /^Anna Beispiel schrieb .* (auf \S+|per SMS): /.test(t));
  const allRead = async () => {
    const read = await framed();
    return frames.every((f) => read.some((t) => f.test(t)));
  };
  from = await mark(clara);
  await clara.getByRole('button', { name: 'Nachrichten', exact: true }).click();
  for (let n = 1; n <= 5 && !(await allRead()); n++) {
    await expect.poll(async () => (await framed()).length, { message: `message ${n} read with its service`, timeout: n === 1 ? 90_000 : undefined }).toBeGreaterThanOrEqual(n);
    if (!(await allRead())) await clara.getByRole('button', { name: 'Nächste', exact: true }).click();
  }
  const read = await framed();
  for (const f of frames) expect(read.some((t) => f.test(t)), String(f)).toBe(true);
  await axe(clara, 'the messages screen across services');
  await home(clara);

  // A reply by SMS: C1 names SMS; confirmed, it waits for the phone, which sends it and reports; then "Gesendet".
  engines.model = asked(/per SMS/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Anna Beispiel', text: 'Ich freue mich.', service: 'SMS' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Antworte Anna per SMS, dass ich mich freue');
  await said(clara, /^SMS an Anna Beispiel: „Ich freue mich\.“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Bestätigt\. Die Nachricht wird gesendet, sobald das Telefon erreichbar ist\.$/, from);
  expect((await spoken(clara)).slice(from).some((t) => /^Gesendet an/.test(t))).toBe(false);
  expect((await ph.sendWaiting()).map((s) => s.text)).toEqual(['Ich freue mich.']);
  await said(clara, /^Gesendet an Anna Beispiel\.$/, from);
});

test('7c · email (docs/plan-m3.md, K3): connected on its own page with the servers of a known provider; a refused password said with what the provider asks for; a mail read with its subject and what it quotes named; a reply read back with the thread’s subject, "Gesendet" at the server’s acceptance', async () => {
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Nachrichtendienste', exact: true }).click();
  let from = await mark(clara);
  await clara.getByRole('button', { name: 'E-Mail verbinden', exact: true }).click();
  await said(clara, /^E-Mail verbinden\. Gib deine E-Mail-Adresse und dein Passwort ein\.$/, from);
  await clara.getByLabel('E-Mail-Adresse').fill('clara.test@gmx.de');
  await expect(clara.getByText('Erkannt: GMX. Die Server sind eingetragen.', { exact: true })).toBeVisible();
  await axe(clara, 'the email page');
  // A password the server refuses (the stand-in's "falsch"): said, with what GMX asks for first.
  await clara.getByLabel('Passwort', { exact: true }).fill('falsch');
  await clara.getByRole('button', { name: 'E-Mail verbinden', exact: true }).click();
  await said(clara, /^Der Mailserver hat die Anmeldung abgelehnt\. Stimmt das Passwort\? Bei GMX muss der Zugriff für andere Programme erst eingeschaltet sein/, from);
  await clara.getByRole('button', { name: 'Neu verbinden', exact: true }).click();
  await said(clara, /^Gib das Passwort noch einmal ein\.$/, from);
  await clara.getByLabel('Passwort', { exact: true }).fill('richtig');
  await clara.getByRole('button', { name: 'E-Mail verbinden', exact: true }).click();
  await said(clara, /^Verbunden: clara\.test@gmx\.de\. UCAP hat deine E-Mails der letzten 30 Tage und alle neuen\.$/, from);
  await clara.getByRole('button', { name: 'Zurück', exact: true }).click();
  await said(clara, /^Nachrichtendienste\. Telegram: verbunden\. SMS: verbunden\. WhatsApp: verbunden\. E-Mail \(clara\.test@gmx\.de\): verbunden\.$/, from);
  await home(clara);

  // Anna answers by email, above what she quotes: announced by its subject, read with it, the quote named.
  from = await mark(clara);
  const mail = { service: 'email', chat: 'anna', text: 'Wir bringen Kuchen mit.', subject: 'Re: Besuch am Sonntag', quoted: 'Am Samstag schrieb Clara:\n> Wir freuen uns.' };
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify(mail) })).ok).toBe(true);
  await said(clara, /^Neue E-Mail von Anna Beispiel, Betreff „Re: Besuch am Sonntag“\.$/, from);
  const read = /^Anna Beispiel schrieb .* per E-Mail mit dem Betreff „Re: Besuch am Sonntag“: Wir bringen Kuchen mit\. Darunter zitiert: Am Samstag schrieb Clara\.$/;
  from = await mark(clara);
  await clara.getByRole('button', { name: 'Nachrichten', exact: true }).click();
  for (let n = 1; n <= 5 && !(await spoken(clara)).slice(from).some((t) => read.test(t)); n++) {
    await expect.poll(async () => (await spoken(clara)).slice(from).filter((t) => / schrieb /.test(t)).length, { message: `message ${n} read`, timeout: n === 1 ? 90_000 : undefined }).toBeGreaterThanOrEqual(n);
    if (!(await spoken(clara)).slice(from).some((t) => read.test(t))) await clara.getByRole('button', { name: 'Nächste', exact: true }).click();
  }
  expect((await spoken(clara)).slice(from).some((t) => read.test(t))).toBe(true);
  await home(clara);

  // A reply by email: the model repeats the thread's subject, as models do; C1 reads it back as a reply's, and
  // "Gesendet" comes once the mail server took it.
  engines.model = asked(/per E-Mail/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Anna Beispiel', text: 'Wunderbar, danke!', service: 'E-Mail', subject: 'Besuch am Sonntag' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Antworte Anna per E-Mail: Wunderbar, danke!');
  await said(clara, /^E-Mail an Anna Beispiel, Betreff „Re: Besuch am Sonntag“: „Wunderbar, danke!“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Gesendet an Anna Beispiel\.$/, from);
  expect(await sql(`select subject from messaging_outbound where text = 'Wunderbar, danke!'`)).toBe('Re: Besuch am Sonntag');
});

test('7d · contacts (docs/plan-m3.md, K6): Clara lets Maria manage her contacts; Maria adds "Physiotherapie" from her device, and Clara’s tablet says so and her history names it; undone, said too', async () => {
  // Clara allows "Kontakte verwalten", as any permission.
  await helpersPage(clara);
  const mariaItem = clara.locator('li.device').filter({ has: clara.getByRole('heading', { name: 'Maria', exact: true }) });
  await mariaItem.getByRole('button', { name: 'Ändern', exact: true }).click();
  await setChoice(mariaItem.getByRole('checkbox', { name: 'Kontakte verwalten' }));
  await mariaItem.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(mariaItem.getByText(/Kontakte verwalten/)).toBeVisible();
  await home(clara);
  // Maria adds the practice, its number as it is written in Germany.
  await helpersPage(maria);
  const claraItem = maria.locator('li.device').filter({ has: maria.getByRole('heading', { name: 'Clara', exact: true }) });
  await claraItem.getByRole('button', { name: 'Kontakte von Clara' }).click();
  const add = async () => {
    await maria.getByRole('button', { name: 'Kontakt hinzufügen' }).click();
    await maria.getByLabel('Name', { exact: true }).fill('Physiotherapie');
    await maria.getByLabel('Telefonnummer', { exact: true }).fill('030 1234567');
    await maria.getByLabel('Bezeichnung, etwa Handy').fill('Praxis');
    const saved = await mark(maria);
    await maria.getByRole('button', { name: 'Speichern', exact: true }).click();
    await said(maria, /^Kontakt „Physiotherapie“ gespeichert\.$/, saved);
  };
  let from = await mark(clara);
  await add();
  await expect(maria.getByText('Telefon (Praxis): +49 30 1234567')).toBeVisible();
  await axe(maria, 'Kontakte von Clara (the helper)');
  // Said on Clara's tablet, and kept in her history.
  await said(clara, /^Maria hat den Kontakt „Physiotherapie“ hinzugefügt\.$/, from);
  await helpersPage(clara);
  await expect(clara.getByText('Maria hat den Kontakt „Physiotherapie“ hinzugefügt').first()).toBeVisible();
  await home(clara);
  // Undone: the contact goes, and Clara hears that too; added again for the call (K6, part 3).
  from = await mark(clara);
  const undone = await mark(maria);
  await maria.getByRole('button', { name: 'Rückgängig', exact: true }).click();
  await said(maria, /^Rückgängig gemacht\.$/, undone);
  await expect(maria.getByText('Noch keine Kontakte.')).toBeVisible();
  await said(clara, /^Maria hat den Kontakt „Physiotherapie“ gelöscht\.$/, from);
  await add();
  await home(maria);
});

test('7e · one contact across services (docs/plan-m3.md, K6; acceptance 9): Clara saves Anna’s number; WhatsApp is hers by it, Telegram and email are asked and taken; her messages there are said as Anna’s; a new SMS, email and WhatsApp message to contacts with no conversation; "Ruf die Physiotherapie an": asked, then dialled', async () => {
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Kontakte', exact: true }).click();
  await expect(heading(clara)).toHaveText('Kontakte');
  await clara.getByRole('button', { name: 'Kontakt hinzufügen' }).click();
  await clara.getByLabel('Name', { exact: true }).fill('Anna');
  await clara.getByLabel('Telefonnummer', { exact: true }).fill('0151 12345678');
  await clara.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Her number is hers on WhatsApp and by SMS; on Telegram and by email only her name fits: asked, never merged by it.
  const ask = (where: string) => clara.getByText(`„Anna Beispiel“ ${where}: dieselbe Person wie dein Kontakt „Anna“?`);
  for (const where of ['auf Telegram', 'per E-Mail']) {
    await expect(ask(where)).toBeVisible();
    const item = clara.locator('li.device').filter({ has: ask(where) });
    const from = await mark(clara);
    await item.getByRole('button', { name: 'Ja, dieselbe Person' }).click();
    await said(clara, new RegExp(`^„Anna Beispiel“ ${where} gehört jetzt zum Kontakt „Anna“\\.$`), from);
  }
  await expect(clara.getByText(/^E-Mail: anna@example\.org$/)).toBeVisible();
  await home(clara);
  // From now on she is Anna on each of them.
  let from = await mark(clara);
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ service: 'whatsapp', chat: 'anna', text: 'Bis Samstag!' }) })).ok).toBe(true);
  await said(clara, /^Neue Nachricht von Anna auf WhatsApp: „Bis Samstag!“$/, from);
  from = await mark(clara);
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ chat: 'anna', text: 'Und Kuchen?' }) })).ok).toBe(true);
  await said(clara, /^Neue Nachricht von Anna auf Telegram: „Und Kuchen\?“$/, from);

  // A new message to the practice Maria saved (7d), with no conversation yet: SMS, WhatsApp and Telegram could all
  // write to its number, so the service is asked; by SMS the phone takes it with the number.
  let told = '';
  engines.model = asked(
    /Physiotherapie/,
    () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Physiotherapie', text: 'Ich komme zehn Minuten später.' }], help: false }),
    (req) => {
      told = engines.last(req);
      return reply('Per SMS, auf WhatsApp oder auf Telegram?');
    },
  );
  from = await mark(clara);
  await talk(clara, engines, 'Schreib der Physiotherapie, dass ich zehn Minuten später komme');
  await said(clara, /^Per SMS, auf WhatsApp oder auf Telegram\?$/, from);
  expect(told).toContain('service_ambiguous: SMS, Telegram, WhatsApp');
  engines.model = asked(/SMS/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Physiotherapie', service: 'SMS', text: 'Ich komme zehn Minuten später.' }], help: false }));
  await talk(clara, engines, 'Per SMS');
  await said(clara, /^SMS an Physiotherapie: „Ich komme zehn Minuten später\.“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Bestätigt\. Die Nachricht wird gesendet, sobald das Telefon erreichbar ist\.$/, from);
  expect((await ph.sendWaiting()).map((x) => [x.chatId, x.to, x.text])).toEqual([['', '+49301234567', 'Ich komme zehn Minuten später.']]);
  await said(clara, /^Gesendet an Physiotherapie\.$/, from);
  // A new email to Bernd, saved with his address alone: the model proposes the subject UCAP asks for.
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Kontakte', exact: true }).click();
  await clara.getByRole('button', { name: 'Kontakt hinzufügen' }).click();
  await clara.getByLabel('Name', { exact: true }).fill('Bernd');
  await clara.getByLabel('E-Mail-Adresse', { exact: true }).fill('bernd@example.org');
  await clara.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(clara.getByText(/^E-Mail: bernd@example\.org$/)).toBeVisible();
  await axe(clara, 'Kontakte (the person)');
  await home(clara);
  const mail = (subject: string | null) => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Bernd', text: 'Kommst du am Sonntag zum Kaffee?', subject }], help: false });
  engines.model = asked(/Bernd/, () => mail(null), () => mail('Kaffee am Sonntag'));
  from = await mark(clara);
  await talk(clara, engines, 'Schreib Bernd eine E-Mail, ob er am Sonntag zum Kaffee kommt');
  await said(clara, /^E-Mail an Bernd, Betreff „Kaffee am Sonntag“: „Kommst du am Sonntag zum Kaffee\?“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Gesendet an Bernd\.$/, from);
  // On WhatsApp too (the owner, 2026-10-23): the practice has no chat there, and WhatsApp has its number.
  engines.model = asked(/WhatsApp/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Physiotherapie', service: 'WhatsApp', text: 'Bis gleich.' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Schreib der Physiotherapie auf WhatsApp: Bis gleich.');
  await said(clara, /^Nachricht an Physiotherapie über WhatsApp: „Bis gleich\.“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Gesendet an Physiotherapie\.$/, from);
  // "Ruf die Physiotherapie an" (acceptance 9): asked first, with which number; then dialled (a browser opens tel:).
  engines.model = asked(/Ruf/, () => ({ say: [], calls: [{ tool: 'contacts.call', name: 'die Physiotherapie', number: null, service: null }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Ruf die Physiotherapie an');
  await said(clara, /^Physiotherapie anrufen, Praxis\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^(Ich rufe Physiotherapie an\.|Ich öffne das Telefon mit der Nummer von Physiotherapie\. Tippe dort auf Anrufen\.)$/, from);
  const calls = () => clara.evaluate(() => ((window as unknown as { __ucap?: { activations: { area: string; how: string }[] } }).__ucap?.activations ?? []).filter((a) => a.area === 'call').map((a) => a.how));
  await expect.poll(calls).toEqual(['dialler']);
  engines.model = () => reply('In Ordnung.');
});

test('7f · appointments (docs/plan-m3.md, K7; acceptance 10): Clara lets Maria manage her appointments and tasks; Maria enters a doctor’s appointment from her browser, read back as stored; Clara’s tablet says so and her history names it; its reminder is Clara’s, changed with it only', async () => {
  // Clara allows "Termine und Aufgaben verwalten", as any permission.
  await helpersPage(clara);
  const mariaItem = clara.locator('li.device').filter({ has: clara.getByRole('heading', { name: 'Maria', exact: true }) });
  await mariaItem.getByRole('button', { name: 'Ändern', exact: true }).click();
  await setChoice(mariaItem.getByRole('checkbox', { name: 'Termine und Aufgaben verwalten' }));
  await mariaItem.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(mariaItem.getByText(/Termine und Aufgaben verwalten/)).toBeVisible();
  await home(clara);
  // A week from the servers' today, at 10:00, with the editor's reminder an hour before.
  const day = new Date((await clocks.now()) + 7 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  await helpersPage(maria);
  const claraItem = maria.locator('li.device').filter({ has: maria.getByRole('heading', { name: 'Clara', exact: true }) });
  await claraItem.getByRole('button', { name: 'Termine von Clara' }).click();
  await maria.getByRole('button', { name: 'Termin eintragen' }).click();
  await maria.getByLabel('Was', { exact: true }).fill('Zahnarzt');
  await maria.getByLabel('Tag', { exact: true }).fill(day);
  await maria.getByLabel('Uhrzeit', { exact: true }).fill('10:00');
  await maria.getByLabel('Ort', { exact: true }).fill('Praxis Weber');
  await axe(maria, 'a new appointment, filled in (the helper)');
  const from = await mark(clara);
  const saved = await mark(maria);
  await maria.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Read back from what the server stored, naming whom it reminds.
  const readback = appointmentReadback('de', 'du', { title: 'Zahnarzt', day, time: '10:00', weekdays: null, place: 'Praxis Weber', remindBefore: [60] }, { year: new Date().getFullYear(), of: 'Clara' });
  expect(readback).toMatch(/^Termin gespeichert: \S+, \d+\. \S+, 10 Uhr: Zahnarzt, Praxis Weber\. Ich erinnere Clara eine Stunde vorher\.$/);
  expect(await said(maria, /^Termin gespeichert: /, saved)).toBe(readback);
  await axe(maria, 'Termine von Clara (the helper)');
  // Said on Clara's tablet, and kept in her history.
  await said(clara, /^Maria hat den Termin „Zahnarzt“ eingetragen\.$/, from);
  await helpersPage(clara);
  await expect(clara.getByText('Maria hat den Termin „Zahnarzt“ eingetragen').first()).toBeVisible();
  // Its reminder is among Clara's, as part of the appointment: not changed on its own.
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Erinnerungen', exact: true }).click();
  const reminder = clara.locator('li.device').filter({ has: clara.getByRole('heading', { name: 'Zahnarzt', exact: true }) });
  await expect(reminder.getByText('Gehört zu einem Termin: unter „Termine“ ändern.')).toBeVisible();
  await expect(reminder.getByRole('button')).toHaveCount(0);
  await home(clara);
  // By voice: "Wann ist der Zahnarzt?" is said by UCAP from what is stored (the model names it, never its time);
  // "Verschieb den Zahnarzt auf 11 Uhr" moves it, read back as stored.
  const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const year = new Date().getFullYear();
  const appointmentRef = (req: ChatRequest) => /"ref":"(appointment:[0-9a-f-]{36})"/.exec(engines.last(req))![1]!;
  engines.model = asked(
    /Wann/,
    () => ({ say: [], calls: [{ tool: 'agenda.list', date: null, days: null, title: 'Zahnarzt' }], help: false }),
    (req) => ({ say: [{ kind: 'original', text: '', ref: appointmentRef(req) }], calls: [], help: false }),
  );
  let heard = await mark(clara);
  await talk(clara, engines, 'Wann ist der Zahnarzt?');
  await said(clara, exactly(`Zahnarzt: ${appointmentWhen('de', { day, time: '10:00', weekdays: null }, year)}, Praxis Weber.`), heard);
  engines.model = asked(/Verschieb/, () => ({ say: [], calls: [{ tool: 'agenda.move', appointment: 'den Zahnarzt', date: null, time: '11:00' }], help: false }));
  heard = await mark(clara);
  await talk(clara, engines, 'Verschieb den Zahnarzt auf 11 Uhr');
  await said(clara, exactly(appointmentReadback('de', 'du', { title: 'Zahnarzt', day, time: '11:00', weekdays: null, place: 'Praxis Weber', remindBefore: [60] }, { year, changed: true })), heard);
  engines.model = () => reply('In Ordnung.');
  await home(maria);
});

test('7g · a note from a message (docs/plan-m3.md, K7; acceptance 11): "Speichere das als Notiz" after Anna’s message is asked first, then the note names where it came from; "Lies die Nachricht dazu" reads the original', async () => {
  await home(clara);
  let from = await mark(clara);
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ chat: 'anna', text: 'Die Gartenschere liegt im Schuppen links.' }) })).ok).toBe(true);
  await said(clara, /^Neue Nachricht von Anna/, from);
  // The newest message's ref: the data lists them oldest first.
  const newest = (req: ChatRequest) => [...engines.last(req).matchAll(/"ref":\s*"(msg:[^"]+)"/g)].at(-1)?.[1] ?? null;
  engines.model = asked(
    /Notiz/,
    () => ({ say: [], calls: [{ tool: 'messages.read', chat: 'Anna', unread_only: false }], help: false }),
    (req) => ({ say: [], calls: [{ tool: 'notes.create', body: '', from_message: newest(req) }], help: false }),
  );
  from = await mark(clara);
  await talk(clara, engines, 'Speichere Annas Nachricht als Notiz');
  // Known by its first words, as any note; the turn read the message, so asked first.
  await said(clara, /^Notiz „Die Gartenschere liegt im Schuppen links“ speichern, aus der Nachricht von Anna( Beispiel)? auf Telegram\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Notiz gespeichert: „Die Gartenschere liegt im Schuppen links“, aus der Nachricht von Anna( Beispiel)? auf Telegram\. Sag „Rückgängig“, um sie zu löschen\.$/, from);
  // "Lies die Nachricht dazu": the note is what the conversation is about; UCAP reads the message it came from.
  engines.model = asked(/dazu/, (req) => ({ say: [{ kind: 'original', text: '', ref: `source:note:${/\(note:([0-9a-f-]{36})\)/.exec(req.system)?.[1]}` }], calls: [], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Lies die Nachricht dazu');
  expect(await said(clara, /Die Gartenschere liegt im Schuppen links\.$/, from)).toMatch(/^Anna( Beispiel)? schrieb .*auf Telegram: Die Gartenschere liegt im Schuppen links\.$/);
  engines.model = () => reply('In Ordnung.');
});

test('7h · §2’s sentence (CONCEPT §2; docs/plan-m3.md, acceptance 6): Anna’s voice message on WhatsApp; "Lies meine neuen Nachrichten", "Was hat Anna in ihrer Sprachnachricht gesagt?", "Antworte ihr, dass Samstag passt" (C1 names WhatsApp, "Gesendet" at its acknowledgement), "Erinnere mich an den Termin, den sie erwähnt hat" (asked as understood, read back with the voice message as its source, which Maria’s page names only as "aus einer Nachricht")', async () => {
  await home(clara);
  await home(maria);
  // Anna's recording (any sound: the speech stand-in hears these words in someone else's voice message).
  engines.voiceMessage = 'Ich komme am Samstag um drei zum Kaffee, wenn es dir passt.';
  const ogg = fileURLToPath(new URL('./.media/anna.ogg', import.meta.url));
  mkdirSync(dirname(ogg), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:a', 'libopus', '-b:a', '24k', ogg]);
  let from = await mark(clara);
  expect((await fetch(`${MESSAGING}/voice`, { method: 'POST', body: JSON.stringify({ service: 'whatsapp', chat: 'anna', ogg: readFileSync(ogg).toString('base64'), seconds: 2 }) })).ok).toBe(true);
  await said(clara, /^Neue (Sprach)?[Nn]achricht von Anna/, from);
  await expect.poll(() => sql(`select transcript_state from messaging_attachments order by updated_at desc limit 1`), { message: 'transcribed', timeout: 30_000 }).toBe('done');
  // "Lies meine neuen Nachrichten": summed up, said as a summary.
  engines.model = asked(
    /neuen Nachrichten/,
    () => ({ say: [], calls: [{ tool: 'messages.read', chat: null, unread_only: true }], help: false }),
    () => ({ say: [{ kind: 'summary', text: 'Anna hat dir eine Sprachnachricht geschickt.', ref: null }], calls: [], help: false }),
  );
  from = await mark(clara);
  await talk(clara, engines, 'Lies meine neuen Nachrichten');
  await said(clara, /^Zusammenfassung: Anna hat dir eine Sprachnachricht geschickt\.$/, from);
  // "Was hat Anna in ihrer Sprachnachricht gesagt?": its automatic transcript, said to be one.
  let voice: string | null = null;
  const newest = (req: ChatRequest) => [...engines.last(req).matchAll(/"ref":\s*"(msg:[^"]+)"/g)].at(-1)?.[1] ?? null;
  engines.model = asked(
    /Sprachnachricht/,
    () => ({ say: [], calls: [{ tool: 'messages.read', chat: 'Anna', unread_only: false }], help: false }),
    (req) => {
      voice = newest(req);
      return { say: [{ kind: 'transcript', text: '', ref: voice }], calls: [], help: false };
    },
  );
  from = await mark(clara);
  await talk(clara, engines, 'Was hat Anna in ihrer Sprachnachricht gesagt?');
  await said(clara, /^Automatisch abgeschrieben: Ich komme am Samstag um drei zum Kaffee, wenn es dir passt\.$/, from);
  // The answer goes where she wrote: C1 names WhatsApp; "Gesendet" once WhatsApp acknowledged it.
  engines.model = asked(/Antworte/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Anna', text: 'Samstag passt.' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Antworte ihr, dass Samstag passt');
  await said(clara, /^Nachricht an Anna über WhatsApp: „Samstag passt\.“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Gesendet an Anna\.$/, from);
  // "Erinnere mich an den Termin, den sie erwähnt hat": the day and time as understood, asked first (the turn read
  // her message); read back with the voice message as its source.
  const base = await clocks.now();
  const saturday = Array.from({ length: 7 }, (_, i) => new Date(base + (i + 1) * 86_400_000))
    .find((d) => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Europe/Berlin' }).format(d) === 'Saturday')!
    .toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  engines.model = asked(
    /Erinnere/,
    () => ({ say: [], calls: [{ tool: 'messages.read', chat: 'Anna', unread_only: false }], help: false }),
    () => ({ say: [], calls: [{ tool: 'agenda.add', title: 'Kaffee mit Anna', date: saturday, time: '15:00', place: null, weekdays: null, remind_before: null, from_message: voice }], help: false }),
  );
  from = await mark(clara);
  await talk(clara, engines, 'Erinnere mich an den Termin, den sie erwähnt hat');
  await said(clara, /^Termin eintragen: Samstag, \d+\. \S+( \d{4})?, 15 Uhr: Kaffee mit Anna\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Termin gespeichert: Samstag, \d+\. \S+( \d{4})?, 15 Uhr: Kaffee mit Anna\. Ich erinnere dich eine Stunde vorher\. Aus der Sprachnachricht von Anna auf WhatsApp\.$/, from);
  engines.model = () => reply('In Ordnung.');
  // Clara's page names the message; Maria's says only that there was one.
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Termine', exact: true }).click();
  const own = clara.locator('li.device').filter({ has: clara.getByRole('heading', { name: 'Kaffee mit Anna', exact: true }) });
  await expect(own.getByText(/^aus der Sprachnachricht von Anna auf WhatsApp$/)).toBeVisible();
  await axe(clara, 'Termine (the person)');
  await home(clara);
  await helpersPage(maria);
  await maria.locator('li.device').filter({ has: maria.getByRole('heading', { name: 'Clara', exact: true }) }).getByRole('button', { name: 'Termine von Clara' }).click();
  const theirs = maria.locator('li.device').filter({ has: maria.getByRole('heading', { name: 'Kaffee mit Anna', exact: true }) });
  await expect(theirs.getByText('aus einer Nachricht', { exact: true })).toBeVisible();
  await expect(theirs.getByText(/WhatsApp|Sprachnachricht/)).toHaveCount(0);
  await home(maria);
});

test('8 · a remote change: Maria moves Messages and switches the device to high contrast; it waits while the person uses it, then is applied, announced with undo; Maria’s page says "angewendet"', async () => {
  await home(clara);
  await home(maria);
  await maria.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await maria.getByRole('button', { name: 'Helfer', exact: true }).click();
  await maria.getByRole('button', { name: 'Gerät einrichten' }).click();
  await expect(heading(maria)).toHaveText('Gerät von Clara');
  await choose(maria.getByRole('radiogroup', { name: 'Farbschema' }), 'Hoher Kontrast, hell');
  const messages = maria.locator('fieldset').filter({ has: maria.getByRole('heading', { name: 'Feld „Nachrichten“' }) });
  await choose(messages.getByRole('radiogroup', { name: 'Platz' }), 'Unten links');
  const from = await mark(clara);
  await maria.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(maria.getByText(/ist beim Gerät angekommen und (wird angewendet, sobald es niemand benutzt|wartet)/)).toBeVisible();
  // The person keeps using the device: the change waits.
  for (let i = 0; i < 4; i++) {
    await clara.getByRole('button', { name: 'Notizen', exact: true }).click();
    await home(clara);
    await new Promise((r) => setTimeout(r, 2_500));
  }
  await expect(heading(clara)).toHaveText('Startseite');
  // Then nobody uses it for half a minute: applied and announced, with the way back.
  await expect(heading(clara)).toHaveText('Neue Einstellungen', { timeout: 60_000 });
  const told = await said(clara, /^Neue Einstellungen\. /, from);
  expect(told).toMatch(/^Neue Einstellungen\. Maria hat den Bildschirm auf hohen Kontrast, hell umgestellt\. Maria hat das Feld „Nachrichten“ verschoben\. Es ist jetzt unten links\. .*Wenn du das nicht möchtest, wähle „Rückgängig“\.$/);
  // Said once.
  expect((await spoken(clara)).slice(from).filter((t) => t.startsWith('Neue Einstellungen.'))).toHaveLength(1);
  await clara.getByRole('button', { name: 'Behalten', exact: true }).click();
  await said(clara, /^Die neuen Einstellungen bleiben\.$/, from);
  await expect(maria.getByText(/ist auf dem Gerät angewendet/)).toBeVisible();
  // The screen is the new one: high contrast, Messages bottom left.
  await expect(clara.locator('html')).toHaveAttribute('data-theme', 'hc-light');
});

test('8b · the appointments in areas (docs/plan-m3.md, K7): Maria turns Clara’s "Notizen" into "Termine" in the device editor; said as such; the area says what comes next, as stored, and the next one', async () => {
  await home(clara);
  await home(maria);
  await maria.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await maria.getByRole('button', { name: 'Helfer', exact: true }).click();
  await maria.getByRole('button', { name: 'Gerät einrichten' }).click();
  await expect(heading(maria)).toHaveText('Gerät von Clara');
  const field = (name: string) => maria.locator('fieldset').filter({ has: maria.getByRole('heading', { name: `Feld „${name}“` }) });
  // The field takes the new task's words: then it is the field "Termine".
  await field('Notizen').getByRole('radiogroup', { name: 'Was das Feld öffnet' }).getByText('Termine', { exact: true }).click();
  await expect(field('Termine').getByRole('radio', { name: 'Termine', exact: true })).toBeChecked();
  await expect(maria.getByRole('img', { name: /Oben links: Termine/ })).toBeVisible();
  await axe(maria, 'Gerät von Clara, an area opening Termine');
  const from = await mark(clara);
  await maria.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Applied once nobody uses the tablet, said with the way back.
  await expect(heading(clara)).toHaveText('Neue Einstellungen', { timeout: 60_000 });
  expect(await said(clara, /^Neue Einstellungen\. /, from)).toMatch(/^Neue Einstellungen\. Maria hat aus dem Feld „Notizen“ das Feld „Termine“ gemacht\. .*Wenn du das nicht möchtest, wähle „Rückgängig“\.$/);
  await clara.getByRole('button', { name: 'Behalten', exact: true }).click();
  await expect(maria.getByText(/ist auf dem Gerät angewendet/)).toBeVisible();
  // The area: what is still to come, the next first, as UCAP says it everywhere (7f moved the dentist to 11).
  const opened = await mark(clara);
  await clara.getByRole('button', { name: 'Termine', exact: true }).click();
  const first = await said(clara, /^Termine\. 2 Termine\. 1 von 2: /, opened);
  await axe(clara, 'Termine in areas');
  await clara.getByRole('button', { name: 'Nächster', exact: true }).click();
  const both = `${first} ${await said(clara, /^2 von 2: /, opened)}`;
  expect(both).toMatch(/Zahnarzt: \S+, \d+\. \S+( \d{4})?, 11 Uhr, Praxis Weber\./);
  expect(both).toMatch(/Kaffee mit Anna: Samstag, \d+\. \S+( \d{4})?, 15 Uhr\./);
  // After the last, it stays there and says so, as the messages screen does (the owner, 2026-10-26).
  await clara.getByRole('button', { name: 'Nächster', exact: true }).click();
  await said(clara, /^Das war der letzte Termin\.$/, opened);
  expect((await spoken(clara)).slice(opened).filter((t) => /^\d+ von 2: /.test(t))).toHaveLength(1);
  await clara.getByRole('button', { name: 'Zurück', exact: true }).click();
  await expect(heading(clara)).toHaveText('Startseite');
  await home(maria);
});

test('G1 · screens and areas (docs/plan-m4.md, G1; acceptance 1): Maria gives Clara a screen "Freizeit", lays the home screen out for six with an area that opens it, gives "Nachrichten" another sound; the tablet says it and opens the new screen; Clara shapes her own screens too', async () => {
  await home(clara);
  await home(maria);
  await maria.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await maria.getByRole('button', { name: 'Helfer', exact: true }).click();
  await maria.getByRole('button', { name: 'Gerät einrichten' }).click();
  await expect(heading(maria)).toHaveText('Gerät von Clara');
  const field = (name: string) => maria.locator('fieldset').filter({ has: maria.getByRole('heading', { name: `Feld „${name}“` }) });
  const layout = () => maria.getByRole('radiogroup', { name: 'Anordnung der Felder' });
  // A new screen, laid out for six: its two new areas start as "Uhrzeit", the first becomes "Notizen".
  await maria.getByRole('textbox', { name: 'Name für einen neuen Bildschirm' }).fill('Freizeit');
  await maria.getByRole('button', { name: 'Neuen Bildschirm anlegen' }).click();
  await choose(layout(), '6 Felder, 3 Reihen');
  await maria.getByRole('button', { name: /^Feld hinzufügen: / }).first().click();
  await field('Uhrzeit').getByRole('radiogroup', { name: 'Was das Feld öffnet' }).getByText('Notizen', { exact: true }).click();
  await maria.getByRole('button', { name: /^Feld hinzufügen: / }).first().click();
  await expect(maria.getByRole('img', { name: /^Vorschau von „Freizeit“: Oben links: Zurück, Oben rechts: Wo bin ich\?, Reihe 2, Spalte 1: Notizen, Reihe 2, Spalte 2: Uhrzeit, Unten links: Startseite, Unten rechts: Hilfe$/ })).toBeVisible();
  // Home for six: the help area stays bottom right; a new area opens "Freizeit".
  await choose(maria.getByRole('radiogroup', { name: 'Welcher Bildschirm' }), 'Startseite');
  await choose(layout(), '6 Felder, 3 Reihen');
  await maria.getByRole('button', { name: /^Feld hinzufügen: / }).first().click();
  await field('Uhrzeit').getByRole('radiogroup', { name: 'Was das Feld öffnet' }).getByText('Bildschirm „Freizeit“', { exact: true }).click();
  await maria.getByRole('button', { name: /^Feld hinzufügen: / }).first().click();
  await choose(field('Nachrichten').getByRole('radiogroup', { name: 'Ton beim Berühren' }), 'Ton 9');
  await expect(maria.getByRole('img', { name: /Unten rechts: Hilfe/ })).toBeVisible();
  await axe(maria, 'Gerät von Clara, screens and areas');
  const from = await mark(clara);
  await maria.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(heading(clara)).toHaveText('Neue Einstellungen', { timeout: 60_000 });
  const told = await said(clara, /^Neue Einstellungen\. /, from);
  expect(told).toMatch(/Maria hat die Startseite auf 6 Felder umgestellt\./);
  expect(told).toMatch(/Maria hat dem Feld „Nachrichten“ einen anderen Ton gegeben\./);
  expect(told).toMatch(/Maria hat das Feld „Freizeit“ hinzugefügt\./);
  // The help area kept its corner: not said as moved.
  expect(told).not.toMatch(/Hilfe-Feld verschoben/);
  await clara.getByRole('button', { name: 'Behalten', exact: true }).click();
  await expect(maria.getByText(/ist auf dem Gerät angewendet/)).toBeVisible();
  // The new screen opens from its area, said with its areas, and leads back.
  const opened = await mark(clara);
  await clara.getByRole('button', { name: 'Freizeit', exact: true }).click();
  await expect(heading(clara)).toHaveText('Freizeit');
  await said(clara, /^Freizeit\. 6 Felder\.$/, opened);
  await clara.getByRole('button', { name: 'Zurück', exact: true }).click();
  await expect(heading(clara)).toHaveText('Startseite');
  // Clara's own page shapes her screens on the tablet, at once.
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Bildschirme einrichten', exact: true }).click();
  await expect(heading(clara)).toHaveText('Bildschirme einrichten');
  await axe(clara, 'Bildschirme einrichten');
  const own = clara.locator('fieldset').filter({ has: clara.getByRole('heading', { name: 'Feld „Uhrzeit“' }) });
  await own.getByRole('textbox', { name: 'Beschriftung' }).fill('Wie spät?');
  await clara.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  await said(clara, /^Übernommen\.$/, opened);
  await home(clara);
  await expect(clara.getByRole('button', { name: 'Wie spät?', exact: true })).toBeVisible();
  await home(maria);
});

test('G3 · a second device (docs/plan-m4.md, G3; acceptance 3): Clara’s tablet gives a code; a new browser takes it; both show the same four pictures; Clara says yes on the tablet, and the browser is hers without any words; signed out from the tablet, it is off at once', async ({ browser }) => {
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Meine Geräte', exact: true }).click();
  const from = await mark(clara);
  await clara.getByRole('button', { name: 'Code für ein neues Gerät', exact: true }).click();
  const code = (await clara.locator('.link-code').innerText()).replace(/\s/g, '');
  expect(code).toMatch(/^\d{6}$/);
  // Said digit by digit, with the server.
  await said(clara, /^Der Code für das neue Gerät: \d \d \d, \d \d \d\. Server: .*Er gilt zehn Minuten\.$/, from);
  await axe(clara, 'Meine Geräte, a code for a new device');
  const fresh = await open(browser, 'Claras zweites Gerät');
  await fresh.goto('/');
  await fresh.getByRole('button', { name: 'Mit einem anderen Gerät verbinden' }).click();
  await expect(heading(fresh)).toHaveText('Mit einem anderen Gerät verbinden');
  await axe(fresh, 'Mit einem anderen Gerät verbinden');
  await fresh.getByRole('textbox', { name: 'Code mit sechs Ziffern' }).fill(code);
  await fresh.getByRole('button', { name: 'Weiter', exact: true }).click();
  const pictures = (page: Page) => page.getByRole('list', { name: 'Die vier Bilder' }).getByRole('listitem');
  await expect(pictures(fresh)).toHaveCount(4);
  // The tablet asks, with the same four pictures, said too.
  await expect(clara.getByRole('alert')).toHaveText(/^Ein Gerät möchte sich verbinden: /);
  expect(await pictures(clara).allInnerTexts()).toEqual(await pictures(fresh).allInnerTexts());
  await said(clara, /^Ein Gerät möchte sich verbinden: .*Sind es dieselben\?$/, from);
  await axe(clara, 'Meine Geräte, the four pictures');
  await clara.getByRole('button', { name: 'Ja, das ist mein neues Gerät', exact: true }).click();
  await said(clara, /^Verbunden\. .* gehört jetzt zu dir\.$/, from);
  // The new device is Clara's, with no words typed: it signs in with its own key.
  await expect(heading(fresh)).toHaveText('Startseite', { timeout: 30_000 });
  await said(fresh, /^Verbunden\. Dieses Gerät gehört jetzt zu dir\.$/);
  // The tablet said yes itself: it is not told again.
  expect((await spoken(clara)).slice(from).filter((t) => t.startsWith('Ein neues Gerät wurde hinzugefügt'))).toEqual([]);
  // Listed as connected; signed out from the tablet, it is off at once.
  const linked = clara.locator('li.device').filter({ hasText: 'verbunden' });
  await expect(linked).toHaveCount(1);
  await linked.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await clara.getByRole('button', { name: 'Ja, abmelden', exact: true }).click();
  await expect(heading(fresh)).toHaveText('Willkommen bei UCAP', { timeout: 5_000 });
  await home(clara);
});

test('G4 · the app lock (docs/plan-m4.md, G4; acceptance 4): Clara chooses her code on the large areas and locks her tablet; locked, help still works by touch and her notes wait behind the code; a wrong code is said, the right one unlocks; unlocked again for the steps after', async () => {
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const from = await mark(clara);
  // The code: six presses on the large areas, asked twice; never said.
  await clara.getByRole('button', { name: 'Code festlegen', exact: true }).click();
  await expect(heading(clara)).toHaveText('Neuer Code');
  await axe(clara, 'Neuer Code');
  const enter = async (code: string) => {
    for (const d of code) await clara.getByRole('button', { name: d, exact: true }).click();
  };
  await enter('123412');
  await expect(heading(clara)).toHaveText('Noch einmal, zur Kontrolle');
  await enter('123412');
  await said(clara, /^Dein Code ist festgelegt\.$/, from);
  expect((await spoken(clara)).slice(from).filter((t) => /1.?2.?3.?4.?1.?2/.test(t))).toEqual([]);
  // On for this tablet.
  await setChoice(clara.getByRole('switch', { name: 'App-Sperre auf diesem Gerät' }));
  await said(clara, /^Die App-Sperre ist auf diesem Gerät eingeschaltet\.$/, from);
  await clara.getByRole('button', { name: 'Jetzt sperren', exact: true }).click();
  await expect(heading(clara)).toHaveText('Startseite');
  await said(clara, /^UCAP ist gesperrt\. Hilfe geht weiter, auch ohne Code\.$/, from);
  // Locked: the notes wait behind the code.
  await clara.getByRole('button', { name: 'Termine', exact: true }).click();
  await expect(heading(clara)).toHaveText('Gesperrt');
  await axe(clara, 'Gesperrt');
  await enter('444444');
  await said(clara, /^Der Code stimmt nicht\. Bitte noch einmal\.$/, from);
  // Help by touch needs no code.
  await clara.getByRole('button', { name: 'Hilfe', exact: true }).click();
  await said(clara, /^Dein Hilferuf wurde gesendet\./, from);
  await clara.getByRole('button', { name: 'Hilferuf abbrechen', exact: true }).click();
  await clara.getByRole('button', { name: 'Ja, abbrechen', exact: true }).click();
  await said(clara, /^Hilferuf abgebrochen\./, from);
  // The right code unlocks.
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await expect(heading(clara)).toHaveText('Gesperrt');
  await enter('123412');
  await said(clara, /^Entsperrt\.$/, from);
  await expect(heading(clara)).toHaveText('Einstellungen');
  // Off again: the steps after use the tablet unlocked.
  await setChoice(clara.getByRole('switch', { name: 'App-Sperre auf diesem Gerät' }), false);
  await said(clara, /^Die App-Sperre ist auf diesem Gerät ausgeschaltet\.$/, from);
  await home(clara);
});

test('G2 · the helper’s page (docs/plan-m4.md, G2; acceptance 1, 2): Maria finds everything for Clara in one place; Clara’s voice for reading aloud is said on the tablet and "Rückgängig" puts it back; shorter answers; the phone fallback to Tom, said; a slower voice and short guidance from the device editor, applied when idle and said', async () => {
  await home(clara);
  await home(maria);
  await maria.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await maria.getByRole('button', { name: 'Helfer', exact: true }).click();
  await maria.getByRole('button', { name: 'Alles für Clara', exact: true }).click();
  await expect(heading(maria)).toHaveText('Clara');
  // Clara's devices, with how their setup stands.
  await expect(maria.getByRole('heading', { name: 'Geräte von Clara' })).toBeVisible();
  await expect(maria.getByText(/ist auf dem Gerät angewendet/).first()).toBeVisible();
  await axe(maria, 'Alles für Clara');
  // The voice for reading aloud (Clara chose Alloy in step 2): said on the tablet with how to undo it, undone by voice.
  let from = await mark(clara);
  await choose(maria.getByRole('radiogroup', { name: 'Stimme zum Vorlesen' }), 'Gerätestimme');
  await expect(maria.getByText(/^Gespeichert\. Clara hört davon/).first()).toBeVisible();
  await said(clara, /^Maria hat deine Stimme zum Vorlesen auf Gerätestimme gestellt\. Wenn du das nicht möchtest, sag „Rückgängig“\.$/, from);
  from = await mark(clara);
  await talk(clara, engines, 'Rückgängig');
  await said(clara, /^Rückgängig gemacht: wieder wie vorher\.$/, from);
  await expect.poll(() => sql(`select settings -> 'voices' ->> 'reading' from users where display_name = 'Clara'`)).toMatch(/^p:.+:alloy$/);
  // How long answers are.
  from = await mark(clara);
  await choose(maria.getByRole('radiogroup', { name: 'Länge der Antworten' }), 'Kurz');
  await said(clara, /^Maria hat eingestellt, dass ich kürzer antworte\. /, from);
  // The phone fallback: Clara's tablet fetches it again and says whom it would call.
  from = await mark(clara);
  const fallback = maria.locator('form').filter({ has: maria.getByRole('textbox', { name: 'Telefonnummer' }) });
  await fallback.getByRole('textbox', { name: 'Name', exact: true }).fill('Tom');
  await fallback.getByRole('textbox', { name: 'Telefonnummer' }).fill('+49 151 2345678');
  await fallback.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(maria.getByText(/^Gespeichert\. Ohne Verbindung bieten die Geräte von Clara an, Tom anzurufen/)).toBeVisible();
  await said(clara, /^Maria hat die Einstellungen für deine Hilferufe geändert\. Ohne Verbindung zum Server biete ich jetzt an, Tom anzurufen\.$/, from);
  // A slower voice and short guidance in the device's configuration: applied when nobody uses the tablet, and said.
  const editor = async (steps: string, guidance: string) => {
    await maria.getByRole('button', { name: 'Gerät einrichten' }).click();
    await expect(heading(maria)).toHaveText('Gerät von Clara');
    await maria.getByRole('slider', { name: 'Sprechtempo' }).focus();
    for (const key of steps.split(' ')) await maria.keyboard.press(key);
    await choose(maria.getByRole('radiogroup', { name: 'Hinweise bei den Feldern' }), guidance);
    const at = await mark(clara);
    await maria.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(heading(clara)).toHaveText('Neue Einstellungen', { timeout: 60_000 });
    const told = await said(clara, /^Neue Einstellungen\. /, at);
    await clara.getByRole('button', { name: 'Behalten', exact: true }).click();
    await expect(maria.getByText(/ist auf dem Gerät angewendet/).first()).toBeVisible();
    await maria.getByRole('button', { name: 'Zurück', exact: true }).click();
    return told;
  };
  const told = await editor('ArrowLeft ArrowLeft', 'Nur der Name');
  expect(told).toMatch(/Maria hat eingestellt, dass ich langsamer spreche\./);
  expect(told).toMatch(/Maria hat eingestellt, dass ich bei den Feldern nur noch ihren Namen sage\./);
  // Back as it was for the steps after.
  await home(maria);
  await maria.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await maria.getByRole('button', { name: 'Helfer', exact: true }).click();
  expect(await editor('ArrowRight ArrowRight', 'Name, Beschreibung und wie man wählt')).toMatch(/schneller spreche\./);
});

test('9 · without the language model and speech recognition: voice says A19; help by touch still works', async () => {
  await clocks.advance(31 * 60_000);
  engines.sttDown = true;
  engines.model = () => 'down';
  await home(clara);
  let from = await mark(clara);
  engines.heard.push('Wie spät ist es?');
  await clara.getByRole('button', { name: 'Sprechen', exact: true }).click();
  await said(clara, /^Die Spracheingabe ist gerade nicht verfügbar\. Für Hilfe /, from);
  engines.heard.length = 0;
  from = await mark(clara);
  await clara.getByRole('button', { name: 'Hilfe', exact: true }).click();
  await said(clara, /^Dein Hilferuf wurde gesendet\. Ich benachrichtige jetzt deine Helfer\.$/, from);
  // Cancelled by the person, asked once (A13), and the helpers told (A14).
  await clara.getByRole('button', { name: 'Hilferuf abbrechen' }).click();
  await clara.getByRole('button', { name: 'Ja, abbrechen' }).click();
  await said(clara, /^Hilferuf abgebrochen\. Ich sage deinen Helfern Bescheid\.$/, from);
  engines.sttDown = false;
  engines.model = () => reply('In Ordnung.');
});

test('L · LIVE mode in a browser (docs/plan-m2.md): Maria switches it on for Clara; a touch opens it, the name is taken off, the next question needs no touch, what was not said to it says nothing, "Pause" closes it', async () => {
  await home(clara);
  await home(maria);
  await maria.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await maria.getByRole('button', { name: 'Helfer', exact: true }).click();
  await maria.getByRole('button', { name: 'Gerät einrichten' }).click();
  await expect(heading(maria)).toHaveText('Gerät von Clara');
  const live = maria.locator('section').filter({ has: maria.getByRole('heading', { name: 'LIVE-Modus', exact: true }) });
  await setChoice(live.getByRole('switch', { name: 'LIVE-Modus an' }), true);
  let from = await mark(clara);
  await maria.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Applied once nobody uses the device, and said first; a browser cannot wait for the name, and says so.
  await expect(heading(clara)).toHaveText('Neue Einstellungen', { timeout: 60_000 });
  expect(await said(clara, /^Neue Einstellungen\. /, from)).toMatch(/^Neue Einstellungen\. Maria hat den LIVE-Modus eingeschaltet\. Berühre „Sprechen“, dann höre ich zu, bis eine Weile niemand mit mir spricht\./);
  await clara.getByRole('button', { name: 'Behalten', exact: true }).click();
  await expect(clara.locator('.voice-status').first()).toHaveText('LIVE: Berühre „Sprechen“');
  // A touch opens it: the name is taken off what was said, and the command answered.
  engines.heard.push('Mathilda, wie spät ist es?');
  from = await mark(clara);
  await clara.getByRole('button', { name: 'Sprechen', exact: true }).click();
  await said(clara, /^Es ist \d{1,2}(:\d\d)? Uhr/, from);
  await expect(clara.locator('.voice-status').first()).toHaveText(/^(LIVE: Ich höre zu|Gehört: .*)$/);
  // The next question without a touch or the name: the model judges it was said to it, and answers.
  // The model judges first, in a call of its own, whether it was said to the assistant; then it answers.
  engines.model = (req) => {
    const judging = req.system.startsWith('Du entscheidest für UCAP');
    const meant = /welcher Tag/.test(engines.last(req));
    if (judging) return { say: [], calls: [], help: false, addressed: meant };
    return meant ? reply('Heute ist Donnerstag.') : reply('Das sollte niemand hören.');
  };
  engines.heard.push('Und welcher Tag ist heute?');
  await said(clara, /^Heute ist Donnerstag\.$/, from);
  // Something else in the room, not said to it: nothing is said, nothing shown.
  const quiet = await mark(clara);
  engines.heard.push('Und jetzt das Wetter für morgen: Sonne im Süden.');
  await expect.poll(() => engines.heard.length, { timeout: 15_000 }).toBe(0);
  await new Promise((r) => setTimeout(r, 4_000));
  expect((await spoken(clara)).slice(quiet)).toEqual([]);
  await expect(clara.getByText(/Wetter für morgen/)).toHaveCount(0);
  // "Pause": the gate closes, and nothing is sent until a touch.
  engines.heard.push('Pause');
  await said(clara, /^Pause\. Ich sage nichts von selbst, bis du „Weiter“ sagst\.$/, quiet);
  await expect(clara.locator('.voice-status').first()).toHaveText('LIVE: Pause');
  const transcribed = engines.seen.transcribed.length;
  await new Promise((r) => setTimeout(r, 5_000));
  expect(engines.seen.transcribed.length, 'nothing was sent while paused').toBe(transcribed);
  // A touch, and "LIVE aus" by voice: off, and said.
  engines.heard.push('LIVE aus');
  from = await mark(clara);
  await clara.getByRole('button', { name: 'Sprechen', exact: true }).click();
  await said(clara, /^LIVE-Modus ist aus\. Ich höre nur noch zu, wenn du „Sprechen“ wählst\.$/, from);
  engines.model = () => reply('In Ordnung.');
});

test('L2 · LIVE across services (docs/plan-m3.md, K8): what came in is said by itself with its service; a code named, never read; an email from someone Clara does not know named, what it says only when asked; a newsletter and a service she leaves to herself only when asked; "Was gibt’s Neues?" covers everything, today’s tasks too', async () => {
  // LIVE speaks only when nothing else is being said, and the browser's speech here ends only when it is cut, after
  // about twice its time (src/audio/speech.ts): each announcement may wait for the one before.
  test.setTimeout(480_000);
  const LIVE_WAIT = 90_000;
  await home(clara);
  // What earlier steps left unread is no news here: heard, so this step's are the only ones.
  sql(`update messaging_messages set heard_at = now() where heard_at is null`);
  // A task due today, on Clara's own page.
  const today = new Date(await clocks.now()).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Aufgaben', exact: true }).click();
  await clara.getByRole('button', { name: 'Aufgabe eintragen' }).click();
  await clara.getByLabel('Was zu tun ist', { exact: true }).fill('Rezept abholen');
  await clara.getByLabel('Fällig am', { exact: true }).fill(today);
  await clara.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(clara.getByRole('heading', { name: 'Rezept abholen', exact: true })).toBeVisible();
  await axe(clara, 'Aufgaben (the person)');
  await home(clara);
  // LIVE on again, by Clara's voice (L ended with it off); a browser waits for a touch, not the name.
  let from = await mark(clara);
  await talk(clara, engines, 'LIVE an');
  await said(clara, /^LIVE-Modus ist an\. Hier kann ich nicht auf meinen Namen warten/, from);
  // The line beside the talk button may still show what was heard: push-to-talk's turn reports it again as it ends,
  // sometimes after LIVE cleared it (M2).
  await expect(clara.locator('.voice-status').first()).toHaveText(/^(LIVE: Berühre „Sprechen“|Gehört: „LIVE an“)$/);
  // The model sums up what is to be summed up, beginning with who wrote (the summary's rule).
  engines.model = (req) => {
    const who = /zusammen, was (.+?) geschrieben hat/.exec(req.system)?.[1];
    return who ? ({ text: `${who} schreibt etwas Neues.` } as unknown as ReturnType<Engines['model']>) : reply('In Ordnung.');
  };

  // Anna on WhatsApp: said by itself, word for word, with its service (Clara has more than one).
  from = await mark(clara);
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ service: 'whatsapp', chat: 'anna', text: 'Kommst du morgen zum Kaffee?' }) })).ok).toBe(true);
  await said(clara, /^Anna schrieb auf WhatsApp: „Kommst du morgen zum Kaffee\?“$/, from, LIVE_WAIT);
  // A code by SMS: who sent it, never the code.
  from = await mark(clara);
  await ph.receive({ number: '+4922000', name: 'Bank' }, 'Ihre mTAN lautet 482913. Geben Sie sie nicht weiter.', await clocks.now());
  await said(clara, /^Bank hat per SMS einen Code geschickt\. Codes lese ich nur vor, wenn du darum bittest\.$/, from, LIVE_WAIT);

  // Clara leaves WhatsApp to herself on this device, on her own settings page.
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const live = clara.locator('section').filter({ has: clara.getByRole('heading', { name: 'LIVE-Modus', exact: true }) });
  await setChoice(live.getByRole('checkbox', { name: 'WhatsApp', exact: true }), false);
  await axe(clara, 'Einstellungen with LIVE per service');
  await home(clara);
  // Maria's mail, from an address Clara has not saved: that it came, from whom and about what, never what it says
  // (the owner, 2026-10-26: "the user may then ask about those"). Not by themselves: a newsletter, WhatsApp now.
  from = await mark(clara);
  for (const m of [
    { service: 'email', chat: 'newsletter', text: 'Tipps für den Herbst: Laub als Mulch.' },
    { service: 'email', chat: 'maria', text: 'Hallo, das ist meine neue Adresse.', subject: 'Neue Adresse' },
    { service: 'whatsapp', chat: 'anna', text: 'Ich bringe Kuchen mit.' },
  ])
    expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify(m) })).ok).toBe(true);
  await expect.poll(() => sql(`select count(*) from messaging_messages where text in ('Tipps für den Herbst: Laub als Mulch.', 'Hallo, das ist meine neue Adresse.', 'Ich bringe Kuchen mit.')`)).toBe('3');
  await said(clara, /^E-Mail von Maria, Betreff „Neue Adresse“\.$/, from, LIVE_WAIT);
  // Longer than LIVE gathers news and waits for what is still being said: none of the others, nor M1's "Neue Nachricht".
  await new Promise((r) => setTimeout(r, 30_000));
  expect((await spoken(clara)).slice(from).filter((t) => /Herbst|Kuchen|Gartenfreunde|Neue Nachricht|Maria schreibt/.test(t))).toEqual([]);

  // "Was gibt's Neues?": a touch opens LIVE, and the answer covers everything, WhatsApp too, the newsletter counted, the
  // task. This browser's speech ends only when it is cut, and LIVE says no more of news cut short (M2): its first part
  // is heard here, the whole answer read from the server's response.
  const answer = clara.waitForResponse((r) => r.url().endsWith('/api/v1/assistant/live/news') && (r.request().postDataJSON() as { asked?: boolean }).asked === true, { timeout: LIVE_WAIT });
  engines.heard.push('Was gibt’s Neues?');
  await clara.getByRole('button', { name: 'Sprechen', exact: true }).click();
  const texts = ((await (await answer).json()) as { segments: { text: string }[] }).segments.map((x) => x.text);
  for (const part of [
    /^Bank hat per SMS einen Code geschickt\./,
    /^E-Mail von Maria, Betreff „Neue Adresse“\.$/,
    /^Maria schreibt etwas Neues\.$/,
    // Anna's two on WhatsApp summed up, or her second alone when the first was heard to its end by itself.
    /^(Anna schrieb auf WhatsApp: „Ich bringe Kuchen mit\.“|Auf WhatsApp: Anna schreibt etwas Neues\.)$/,
    /^Von Newslettern und Verteilern: eine neue E-Mail\.$/,
  ])
    expect(texts.some((t) => part.test(t)), String(part)).toBe(true);
  expect(texts.at(-1)).toBe('Heute zu erledigen: Rezept abholen.');
  expect(texts.join('\n')).not.toMatch(/482913|Laub/);
  await said(clara, new RegExp(`^${texts[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), from, LIVE_WAIT);
  expect((await spoken(clara)).slice(from).join('\n')).not.toMatch(/482913|Laub/);

  // As it was: WhatsApp said by itself again, LIVE off.
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await setChoice(clara.locator('section').filter({ has: clara.getByRole('heading', { name: 'LIVE-Modus', exact: true }) }).getByRole('checkbox', { name: 'WhatsApp', exact: true }), true);
  await home(clara);
  engines.heard.push('LIVE aus');
  from = await mark(clara);
  await clara.getByRole('button', { name: 'Sprechen', exact: true }).click();
  await said(clara, /^LIVE-Modus ist aus\. /, from, LIVE_WAIT);
  engines.model = () => reply('In Ordnung.');
});

test('7i · across services (docs/plan-m3.md, acceptance 5): "Was hat Bernd heute geschickt?" finds what he wrote wherever he wrote it, in the family’s WhatsApp group and email thread, each with its service', async () => {
  await home(clara);
  const texts = { whatsapp: 'Ich bringe morgen die Grillkohle mit.', email: 'Das Familientreffen ist am dritten Mai bei uns.' };
  for (const [service, text] of Object.entries(texts)) expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ service, chat: 'familie', text }) })).ok, service).toBe(true);
  await expect.poll(() => sql(`select count(*) from messaging_messages where text in ('${texts.whatsapp}', '${texts.email}')`)).toBe('2');
  let data = '';
  engines.model = asked(
    /Was hat Bernd heute geschickt/,
    () => ({ say: [], calls: [{ tool: 'messages.search', query: '', person: 'Bernd' }], help: false }),
    (req) => {
      data = engines.last(req);
      return { say: [{ kind: 'summary', text: 'Bernd bringt morgen die Grillkohle mit, und das Familientreffen ist am dritten Mai.', ref: null }], calls: [], help: false };
    },
  );
  const from = await mark(clara);
  await talk(clara, engines, 'Was hat Bernd heute geschickt?');
  await said(clara, /^Zusammenfassung: Bernd bringt morgen die Grillkohle mit, und das Familientreffen ist am dritten Mai\.$/, from);
  // Both reached the model, each with where it came from.
  const items = data.split('{"ref":').slice(1);
  expect(items.some((i) => i.includes('"service":"WhatsApp"') && i.includes(texts.whatsapp)), 'his WhatsApp message').toBe(true);
  expect(items.some((i) => i.includes('"service":"E-Mail"') && i.includes(texts.email)), 'his email').toBe(true);
  engines.model = () => reply('In Ordnung.');
});

test('8c · previews (docs/plan-m3.md, K5; acceptance 8): Clara’s phone reads Signal’s notifications; Lena’s message is said as a preview; on to the end of the messages, never from the first again, and the rest marked read in UCAP; a reply goes through Signal’s notification, "Gesendet" only once Signal shows it as Clara’s', async () => {
  await home(clara);
  let from = await mark(clara);
  await ph.preview({ package: 'org.thoughtcrime.securesms', name: 'Signal' }, 'Lena', 'Bist du heute Nachmittag zu Hause?', await clocks.now());
  await said(clara, /^Vorschau von Signal: neue Nachricht von Lena: „Bist du heute Nachmittag zu Hause\?“$/, from);
  // On the messages screen, framed as a preview: the newest of what is unread, after L2's and 7i's.
  const read = /^Vorschau von Signal: Lena schrieb .* auf Signal: Bist du heute Nachmittag zu Hause\?$/;
  from = await mark(clara);
  await clara.getByRole('button', { name: 'Nachrichten', exact: true }).click();
  for (let n = 1; n <= 12 && !(await spoken(clara)).slice(from).some((t) => read.test(t)); n++) {
    await expect.poll(async () => (await spoken(clara)).slice(from).filter((t) => / schrieb /.test(t)).length, { message: `message ${n} read`, timeout: n === 1 ? 90_000 : undefined }).toBeGreaterThanOrEqual(n);
    if (!(await spoken(clara)).slice(from).some((t) => read.test(t))) await clara.getByRole('button', { name: 'Nächste', exact: true }).click();
  }
  expect((await spoken(clara)).slice(from).some((t) => read.test(t))).toBe(true);
  // On to the end: "Nächste" then says it was the last, and never begins again from the first (the owner, 2026-10-26).
  const end = /^Das war die letzte Nachricht\.$/;
  for (let n = 0; n < 30 && !(await spoken(clara)).slice(from).some((t) => end.test(t)); n++) {
    const before = (await spoken(clara)).length;
    await clara.getByRole('button', { name: 'Nächste', exact: true }).click();
    await expect.poll(async () => (await spoken(clara)).length, { message: `"Nächste" ${n + 1} said something` }).toBeGreaterThan(before);
  }
  const reads = (await spoken(clara)).slice(from).filter((t) => / schrieb /.test(t)).length;
  await clara.getByRole('button', { name: 'Nächste', exact: true }).click();
  await expect.poll(async () => (await spoken(clara)).slice(from).filter((t) => end.test(t)).length).toBe(2);
  expect((await spoken(clara)).slice(from).filter((t) => / schrieb /.test(t)).length).toBe(reads);
  // "Rest gelesen", in UCAP only (the owner, 2026-10-26): asked with how many; "Nein" keeps them, "Ja" marks them.
  const rest = /^(Die neue Nachricht|Die (\d+) neuen Nachrichten) als gelesen markieren\? Das gilt nur hier in UCAP: Die Absender erfahren davon nichts\.$/;
  await clara.getByRole('button', { name: 'Rest gelesen', exact: true }).click();
  await said(clara, rest, from);
  await clara.getByRole('button', { name: 'Nein', exact: true }).click();
  await said(clara, /^Nichts markiert\.$/, from);
  const marking = await mark(clara);
  await clara.getByRole('button', { name: 'Rest gelesen', exact: true }).click();
  const many = rest.exec(await said(clara, rest, marking))![2];
  await clara.getByRole('button', { name: 'Ja, als gelesen markieren', exact: true }).click();
  await said(clara, many ? new RegExp(`^${many} Nachrichten als gelesen markiert\\.$`) : /^Eine Nachricht als gelesen markiert\.$/, marking);
  await expect(clara.getByRole('button', { name: 'Rest gelesen', exact: true })).toHaveCount(0);
  expect(sql(`select count(*) from messaging_messages m join messaging_conversations v on v.id = m.conversation_id where m.direction = 'in' and m.read_at is null and m.heard_at is null and v.kind <> 'channel'`)).toBe('0');
  await home(clara);

  // The reply: Lena is known only by what Signal's notifications show, so she is no contact (decisions.md, M3, 19).
  engines.model = asked(/Antworte Lena/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Lena', text: 'Ja, ab drei.' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Antworte Lena, dass ich ab drei zu Hause bin');
  await said(clara, /^Achtung: Lena ist nicht in deinen Kontakten\. Antwort an Lena über Signal: „Ja, ab drei\.“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Bestätigt\. Die Nachricht wird gesendet, sobald das Telefon erreichbar ist\.$/, from);
  expect((await spoken(clara)).slice(from).some((t) => /^Gesendet an/.test(t))).toBe(false);
  // The phone hands it to Signal's notification; "Gesendet" once Signal shows it as Clara's own.
  expect((await ph.replyThroughApps()).map((s) => s.text)).toEqual(['Ja, ab drei.']);
  await said(clara, /^Gesendet an Lena\.$/, from);
  engines.model = () => reply('In Ordnung.');
});

test('8d · the owner’s answers of 2026-10-27 (docs/decisions.md, M3, To confirm 6, 8, 11, 19): a second sender on the email account; Bernd’s mail to the family is announced by its subject, a reply goes to him alone, "Allen antworten" to everyone, from the address it came to or the one Clara names; Lena from Signal is suggested for Clara’s contact "Lena", no stranger after "Ja"; new messages by who wrote alone where Clara sets it', async () => {
  await home(clara);
  // 8: a second sender, as in a mail program.
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Nachrichtendienste', exact: true }).click();
  await clara.getByRole('button', { name: 'E-Mail (clara.test@gmx.de) öffnen', exact: true }).click();
  await expect(heading(clara)).toHaveText('E-Mail');
  const senders = clara.locator('section').filter({ has: clara.getByRole('heading', { name: 'Absender', exact: true }) });
  await senders.getByLabel('Name', { exact: true }).fill('Clara (Verein)');
  await senders.getByLabel('Adresse', { exact: true }).fill('verein@clara.example');
  let from = await mark(clara);
  await senders.getByRole('button', { name: 'Absender hinzufügen', exact: true }).click();
  await said(clara, /^Absender hinzugefügt: Clara \(Verein\) <verein@clara\.example>\.$/, from);
  await expect(senders.getByText(/^clara\.test@gmx\.de \(ohne Namen\) · Standard$/)).toBeVisible();
  await axe(clara, 'E-Mail with its senders');
  await home(clara);

  // 6: Bernd writes to the family's thread, to Clara, Anna and Hans; announced by its subject (11).
  from = await mark(clara);
  const family = { service: 'email', chat: 'familie', text: 'Wer bringt am Sonntag Salat mit?', subject: 'Re: Familientreffen im Mai' };
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify(family) })).ok).toBe(true);
  await said(clara, /^Neue E-Mail von Bernd, Betreff „Re: Familientreffen im Mai“\.$/, from);
  // On the messages screen, a reply to all of them too, named as Clara knows them. (Its words are dictated after the
  // hint, which this browser cuts as stalled, so the dictation is in messaging-services.test.ts; here by voice.)
  from = await mark(clara);
  await clara.getByRole('button', { name: 'Nachrichten', exact: true }).click();
  // The first message is read after the screen's own words, each waiting for its stall cut (as in step 8c).
  await said(clara, /^Bernd schrieb .* per E-Mail mit dem Betreff „Re: Familientreffen im Mai“: Wer bringt am Sonntag Salat mit\?$/, from, 90_000);
  await expect(clara.getByRole('button', { name: 'Antworten', exact: true })).toBeVisible();
  await clara.getByRole('button', { name: 'Allen antworten', exact: true }).click();
  await said(clara, /^Sag jetzt deine Antwort an alle: Bernd, Anna und Hans\.$/, from, 60_000);
  await home(clara);
  // "Antworte allen": everyone, from the address the mail came to, named since Clara has two; sent on "Ja".
  engines.model = asked(/allen/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Familientreffen', text: 'Ich bringe den Salat mit.', all: true }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Antworte allen: Ich bringe den Salat mit');
  await said(clara, /^E-Mail von clara\.test@gmx\.de an Bernd, Anna und Hans, Betreff „Re: Familientreffen im Mai“: „Ich bringe den Salat mit\.“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Gesendet an Bernd, Anna und Hans\.$/, from);
  const sends = async () => ((await (await fetch(`${MESSAGING}/sent`, { method: 'POST', body: JSON.stringify({ service: 'email' }) })).json()) as { sends: { service: string; chatId: string; all: boolean; from: { name: string; address: string } | null }[] }).sends;
  expect((await sends()).at(-1)).toEqual({ service: 'email', chatId: 'thread:familie', all: true, from: { name: '', address: 'clara.test@gmx.de' } });
  // By voice, to Bernd alone, from the address Clara names.
  engines.model = asked(/Vereinsadresse/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Familientreffen', text: 'Bis Sonntag.', from: 'Verein' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Antworte Bernd von meiner Vereinsadresse: Bis Sonntag');
  await said(clara, /^E-Mail von verein@clara\.example an Bernd, Betreff „Re: Familientreffen im Mai“: „Bis Sonntag\.“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Gesendet an Bernd\.$/, from);
  expect((await sends()).at(-1)).toEqual({ service: 'email', chatId: 'thread:familie', all: false, from: { name: 'Clara (Verein)', address: 'verein@clara.example' } });

  // 19: Lena, known only from Signal's notifications, and Clara's new contact "Lena": the same person? Yes.
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Kontakte', exact: true }).click();
  await clara.getByRole('button', { name: 'Kontakt hinzufügen' }).click();
  await clara.getByLabel('Name', { exact: true }).fill('Lena');
  await clara.getByRole('button', { name: 'Speichern', exact: true }).click();
  const lena = clara.getByText('„Lena“ auf Signal: dieselbe Person wie dein Kontakt „Lena“?');
  await expect(lena).toBeVisible();
  from = await mark(clara);
  await clara.locator('li.device').filter({ has: lena }).getByRole('button', { name: 'Ja, dieselbe Person' }).click();
  await said(clara, /^„Lena“ auf Signal gehört jetzt zum Kontakt „Lena“\.$/, from);
  await expect(clara.getByText(/^Vorschau \(Signal\)$/)).toBeVisible();
  await home(clara);
  // Kept with her: no warning before a reply through Signal any more.
  engines.model = asked(/Antworte Lena/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Lena', text: 'Bis später.' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Antworte Lena: Bis später');
  await said(clara, /^Antwort an Lena über Signal: „Bis später\.“\. Senden\?$/, from);
  await talk(clara, engines, 'Nein');
  await said(clara, /^Nicht gesendet\. Der Entwurf ist gespeichert\.$/, from);

  // 11: who wrote alone, where Clara sets it on her device; then with what it says again.
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await setChoice(clara.getByRole('switch', { name: 'Sagen, was darin steht', exact: true }), false);
  await axe(clara, 'Einstellungen with Neue Nachrichten');
  await home(clara);
  from = await mark(clara);
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ chat: 'anna', text: 'Ich rufe dich heute Abend an.' }) })).ok).toBe(true);
  await said(clara, /^Neue Nachricht von Anna auf Telegram\.$/, from);
  expect((await spoken(clara)).slice(from).join('\n')).not.toMatch(/heute Abend/);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await setChoice(clara.getByRole('switch', { name: 'Sagen, was darin steht', exact: true }), true);
  await home(clara);
  engines.model = () => reply('In Ordnung.');
});

test('12 · strangers (docs/plan-m3.md, acceptance 12): before C1 UCAP says that neither is in Clara’s contacts, "Maria (Tochter)" on WhatsApp nor "Maria" by email from another address; declined, nothing is sent', async () => {
  await home(clara);
  let from = await mark(clara);
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ service: 'whatsapp', chat: 'maria', text: 'Hallo Mama, ich habe eine neue Nummer.' }) })).ok).toBe(true);
  await said(clara, /^Neue Nachricht von Maria \(Tochter\) auf WhatsApp: „Hallo Mama, ich habe eine neue Nummer\.“$/, from);
  engines.model = asked(/Antworte Maria auf WhatsApp/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Maria (Tochter)', text: 'Ruf mich bitte an.', service: 'WhatsApp' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Antworte Maria auf WhatsApp: Ruf mich bitte an');
  await said(clara, /^Achtung: Maria \(Tochter\) ist nicht in deinen Kontakten\. Nachricht an Maria \(Tochter\) über WhatsApp: „Ruf mich bitte an\.“\. Senden\?$/, from);
  await talk(clara, engines, 'Nein');
  await said(clara, /^Nicht gesendet\. Der Entwurf ist gespeichert\.$/, from);

  // Maria's mail from an address Clara has not saved (step L2).
  engines.model = asked(/Antworte Maria per E-Mail/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Maria', text: 'Wer bist du?', service: 'E-Mail' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Antworte Maria per E-Mail: Wer bist du?');
  await said(clara, /^Achtung: Maria ist nicht in deinen Kontakten\. .*„Wer bist du\?“\. Senden\?$/, from);
  await talk(clara, engines, 'Nein');
  await said(clara, /^Nicht gesendet\. Der Entwurf ist gespeichert\.$/, from);
  // Declined: nothing went out to either.
  expect(sql(`select count(*) from messaging_outbound where text in ('Ruf mich bitte an.', 'Wer bist du?')`)).toBe('0');
  engines.model = () => reply('In Ordnung.');
});

test('13 · disconnecting (docs/plan-m3.md, acceptance 13): WhatsApp and email go, with what UCAP kept of them, and the stand-in’s link with them; the SMS role goes back, and the services page says so', async () => {
  const kept = (service: string) =>
    sql(`select count(*) from messaging_messages m join messaging_conversations v on v.id = m.conversation_id join messaging_connections k on k.id = v.connection_id where k.service = '${service}'`);
  const ids = Object.fromEntries(['whatsapp', 'email'].map((s) => [s, sql(`select id from messaging_connections where service = '${s}'`)]));
  for (const s of ['whatsapp', 'email']) expect(Number(kept(s)), s).toBeGreaterThan(0);
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Nachrichtendienste', exact: true }).click();
  for (const name of ['WhatsApp', 'E-Mail (clara.test@gmx.de)']) {
    const from = await mark(clara);
    await clara.getByRole('button', { name: `${name} trennen`, exact: true }).click();
    const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await said(clara, new RegExp(`^${quoted} trennen\\? UCAP löscht dann, was es davon gespeichert hat; beim Dienst selbst bleibt alles\\.$`), from);
    await clara.getByRole('button', { name: 'Ja, trennen', exact: true }).click();
    await said(clara, new RegExp(`^${quoted} ist getrennt\\.$`), from);
  }
  // Nothing of them is kept; the stand-in logged out of both (its link and state gone, as Baileys' and the email
  // process's are).
  for (const s of ['whatsapp', 'email']) expect(kept(s), s).toBe('0');
  expect(sql(`select count(*) from messaging_connections where service in ('whatsapp', 'email')`)).toBe('0');
  const left = execFileSync('docker', ['compose', '--profile', 'e2e', 'exec', '-T', 'connectors-e2e', 'ls', '/data/tdlib'], { cwd: REPO }).toString();
  for (const id of Object.values(ids)) expect(left).not.toContain(`fake-${id}.json`);

  // The SMS role goes back to Google Messages on the phone (its history stays there: on the emulator, K4).
  await ph.roleGone();
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const from = await mark(clara);
  await clara.getByRole('button', { name: 'Nachrichtendienste', exact: true }).click();
  // Signal's previews (step 8c) stay: they are the phone's own, not the SMS app's.
  await said(clara, /^Nachrichtendienste\. Telegram: verbunden\. SMS: auf dem Telefon ausgeschaltet\. Signal: verbunden\.$/, from);
  await home(clara);
});

test('14 · help needs none of it (docs/plan-m3.md, acceptance 14): with the messaging stand-in stopped, as every connector process, help by touch reaches Maria, and an appointment’s reminder comes at its time', async () => {
  // Past the half hour in which a press would reopen the last request (step 9's).
  await clocks.advance(31 * 60_000);
  // An appointment of Clara's own, in two hours: reminded an hour before.
  const later = (await clocks.now()) + 2 * 3_600_000;
  const at = later - (later % 60_000);
  const berlin = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Termine', exact: true }).click();
  await clara.getByRole('button', { name: 'Termin eintragen' }).click();
  await clara.getByLabel('Was', { exact: true }).fill('Fußpflege');
  await clara.getByLabel('Tag', { exact: true }).fill(`${berlin.year}-${berlin.month}-${berlin.day}`);
  await clara.getByLabel('Uhrzeit', { exact: true }).fill(`${berlin.hour}:${berlin.minute}`);
  await clara.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(clara.getByRole('heading', { name: 'Fußpflege', exact: true })).toBeVisible();
  await home(clara);

  execFileSync('docker', ['compose', '--profile', 'e2e', 'stop', 'connectors-e2e'], { cwd: REPO, stdio: 'ignore' });
  try {
    // Help by touch, as in step 4.
    await home(maria);
    await maria.getByRole('button', { name: 'Hilferufe', exact: true }).click();
    let from = await mark(clara);
    await clara.getByRole('button', { name: 'Hilfe', exact: true }).click();
    await said(clara, /^Dein Hilferuf wurde gesendet\. Ich benachrichtige jetzt deine Helfer\.$/, from);
    await expect(heading(maria)).toHaveText('Hilferuf von Clara');
    await maria.getByRole('button', { name: 'Annehmen', exact: true }).click();
    await said(clara, /^Maria hat deinen Hilferuf angenommen\.$/, from);
    await maria.getByRole('button', { name: 'Erledigt', exact: true }).click();
    await said(clara, /^Maria hat deinen Hilferuf als erledigt markiert\./, from);
    await home(maria);

    // The appointment's reminder, an hour before it, on the home screen (the resolved request's screen stays until left).
    await home(clara);
    const due = at - 3_600_000;
    await clocks.moveTo(due - 30_000, { messaging: false });
    from = await mark(clara);
    await clocks.moveTo(due + 1_000, { messaging: false });
    await expect(heading(clara)).toHaveText(/Fußpflege/);
    await said(clara, /Fußpflege/, from);
  } finally {
    execFileSync('docker', ['compose', '--profile', 'e2e', 'start', 'connectors-e2e'], { cwd: REPO, stdio: 'ignore' });
  }
  // Back, with the servers' time.
  await expect.poll(async () => (await fetch(`${MESSAGING}/clock`, { method: 'POST', body: JSON.stringify({ at: await clocks.now() }) }).catch(() => null))?.ok ?? false, { timeout: 30_000 }).toBe(true);
  await home(clara);
});

test('15 · removed for good (docs/decisions.md, M3, 20: "we keep messages forever until user decides to purge deleted"): what Clara deleted is kept and named in her settings; asked first, she removes it for good; her history still says what Maria did, without its name', async () => {
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const section = clara.locator('section').filter({ has: clara.getByRole('heading', { name: 'Gelöschtes', exact: true }) });
  // The first "Physiotherapie", undone in step 7d, is kept.
  await expect(section.getByText(/^Gelöscht und noch aufbewahrt, damit du es zurückholen kannst: .*ein Kontakt/)).toBeVisible();
  await axe(clara, 'Einstellungen with what was deleted');
  const from = await mark(clara);
  await section.getByRole('button', { name: 'Gelöschtes endgültig entfernen', exact: true }).click();
  await said(clara, /^Endgültig entfernen: .*ein Kontakt.*\? Danach lässt es sich nicht mehr zurückholen\.$/, from);
  await section.getByRole('button', { name: 'Ja, endgültig entfernen', exact: true }).click();
  await said(clara, /^Endgültig entfernt: .*ein Kontakt.*\.$/, from);
  await expect(section.getByText('Nichts Gelöschtes ist aufbewahrt.', { exact: true })).toBeVisible();
  expect(sql(`select count(*) from contacts where deleted_at is not null`)).toBe('0');
  // The history: what Maria did with the contact now gone, without its name; the one she added again by its name.
  await helpersPage(clara);
  await expect(clara.getByText('Maria hat einen Kontakt hinzugefügt (inzwischen endgültig entfernt)').first()).toBeVisible();
  await expect(clara.getByText('Maria hat den Kontakt „Physiotherapie“ hinzugefügt').first()).toBeVisible();
  await expect(clara.getByText('Du hast Gelöschtes endgültig entfernt').first()).toBeVisible();
  await home(clara);
});

test('10 · recovery: on a new device the English words recover the same account; the other device is told; signed out, it loses its connection at once', async ({ browser }) => {
  const german = words.get('Clara')!;
  const phrase = fromWords(german);
  if ('error' in phrase) throw new Error('the words read from the screen do not form a phrase');
  const english = toWords(phrase.entropy, 'en');
  phrase.entropy.fill(0);
  const fresh = await open(browser, 'Claras neues Gerät');
  await fresh.goto('/');
  await fresh.getByRole('button', { name: 'Ich habe Wiederherstellungswörter' }).click();
  await fresh.getByRole('button', { name: 'English', exact: true }).click();
  const from = await mark(clara);
  // Typed on a keyboard: letters, then Enter takes the word; after the twelfth the words are checked at once.
  for (const w of english) {
    await fresh.keyboard.type(w);
    await fresh.keyboard.press('Enter');
  }
  const submit = fresh.getByRole('button', { name: 'Wiederherstellen', exact: true });
  if (await submit.isVisible()) await submit.click();
  await said(fresh, /^Willkommen zurück\./);
  english.fill('');
  await expect(heading(fresh)).toHaveText('Startseite', { timeout: 30_000 });
  // The tablet is told.
  await said(clara, /^Mit deinen Wiederherstellungswörtern wurde ein neues Gerät hinzugefügt: /, from);
  // From the new device, the old one is signed out; it loses its connection at once.
  await fresh.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await fresh.getByRole('button', { name: 'Meine Geräte', exact: true }).click();
  await home(clara);
  const others = fresh.locator('li.device').filter({ hasNot: fresh.getByText('dieses Gerät') }).filter({ has: fresh.getByRole('button', { name: 'Abmelden', exact: true }) });
  await others.first().getByRole('button', { name: 'Abmelden', exact: true }).click();
  await fresh.getByRole('button', { name: 'Ja, abmelden', exact: true }).click();
  const at = Date.now();
  // The tablet is closed off at once: the not-set-up screen, from which no help request can leave.
  await expect(heading(clara)).toHaveText('Willkommen bei UCAP', { timeout: 5_000 });
  expect(Date.now() - at, 'from the sign-out to the old device’s own screen').toBeLessThan(3_000);
});

test('ID-02 · the phrase canary: no three recovery words in a row in anything the stand-ins received or the servers logged', async () => {
  const phrases: string[][] = [];
  for (const w of words.values()) {
    phrases.push(w);
    const p = fromWords(w);
    if (!('error' in p)) phrases.push(toWords(p.entropy, 'en'));
  }
  const received = [...engines.seen.chat.map((c) => `${c.system}\n${c.messages.map((m) => m.content).join('\n')}`), ...engines.seen.speech, ...engines.seen.transcribed.map((t) => t.text)];
  const logs = execFileSync('docker', ['compose', '--profile', 'e2e', 'logs', '--no-color', 'core-e2e', 'assistant-e2e', 'connectors-e2e'], { cwd: REPO }).toString();
  // Only whether: a match is never printed.
  const leaked = phrases.some((p) => received.some((r) => phraseIn(r, p)) || phraseIn(logs, p));
  expect(leaked, 'recovery words found in what the stand-ins received or the servers logged').toBe(false);
  phrases.length = 0;
});

test('L-02 · LIVE’s privacy canary: what it overheard and dropped is kept nowhere, not in a log, not in any table', async () => {
  const overheard = 'Wetter für morgen';
  const logs = execFileSync('docker', ['compose', '--profile', 'e2e', 'logs', '--no-color', 'core-e2e', 'assistant-e2e', 'connectors-e2e'], { cwd: REPO }).toString();
  expect(logs.includes(overheard), 'the servers logged what LIVE overheard').toBe(false);
  const dump = execFileSync('docker', ['compose', 'exec', '-T', 'db', 'pg_dump', '-U', 'ucap', '--data-only', 'ucap_e2e'], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 }).toString();
  expect(dump.includes(overheard), 'a table holds what LIVE overheard').toBe(false);
  // The turn itself is recorded by its outcome only.
  expect(sql(`select count(*) from assistant_turns where mode = 'live' and outcome = 'ignored'`)).not.toBe('0');
});
