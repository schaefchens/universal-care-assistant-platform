/**
 * Milestone 1's acceptance script (docs/plan.md, "Milestone 1: acceptance script"), walked in browsers against the
 * e2e stack: Maria (operator and first helper) and Clara (the person) in browsers of their own, Tom (the second
 * helper) on a simulated phone (phone.ts), the AI engines and Telegram replaced by stand-ins, the servers' clock moved
 * forward where the script waits. Each step builds on the ones before: they run in order, and the first that fails
 * ends the walk. What the app said is read from its debug record; recovery words stay in this process's memory.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { fromWords, toWords } from '@ucap/identity';
import { choose, clocks, heading, home, invitation, listen, mark, ORIGIN, said, setChoice, signUp, spoken, sql, talk, TELEGRAM } from './app.ts';
import { type ChatRequest, type Engines, reply, startEngines } from './engines.ts';
import { type Phone, phone } from './phone.ts';

test.describe.configure({ mode: 'serial' });

const REPO = fileURLToPath(new URL('..', import.meta.url));

let engines: Engines;
const contexts: BrowserContext[] = [];
let maria: Page;
let clara: Page;
let tom: Phone;
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

test('1 · the operator: an administrator from the CLI, a voice service and Telegram set up on the admin page', async () => {
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
  // Telegram's credentials, invented: the stand-in for the connectors never reaches Telegram.
  const telegram = maria.locator('section').filter({ has: maria.getByRole('heading', { name: 'Telegram', exact: true }) });
  await telegram.getByLabel('api_id', { exact: true }).fill('1234567');
  await telegram.getByLabel('api_hash', { exact: true }).fill('0123456789abcdef0123456789abcdef');
  await telegram.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(telegram.getByText('Eingerichtet: api_id 1234567.')).toBeVisible();
});

test('2 · the person creates an identity: twelve words, three checked, a reply voice chosen by listening; four areas', async () => {
  const sampled = engines.seen.speech.length;
  words.set(
    'Clara',
    await signUp(clara, 'Clara', invitation(), async (page) => {
      await page.getByRole('button', { name: 'Alloy (Teststimmen)', exact: true }).click();
      await expect(page.getByText('Alloy (Teststimmen): Diese Stimme nehmen?')).toBeVisible();
      await page.getByRole('button', { name: 'Diese Stimme nehmen', exact: true }).click();
    }),
  );
  // The sample came from the voice service; the choice was said.
  expect(engines.seen.speech.length).toBeGreaterThan(sampled);
  await said(clara, /Alloy \(Teststimmen\) spricht jetzt/);
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

  // Half a minute before three in the afternoon, then three.
  await home(clara);
  const due = nextBerlin(await clocks.now(), 15, 0);
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

test('7 · Telegram: connected on the person’s device; a new message announced by its sender; a summary said as one; the original framed; a reply sent only after "Ja", and "Gesendet" only once Telegram confirmed', async () => {
  await clocks.advance(31 * 60_000); // past the reopen window of the last request
  await home(clara);
  await clara.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await clara.getByRole('button', { name: 'Telegram', exact: true }).click();
  await clara.getByRole('button', { name: 'Telegram verbinden' }).click();
  await clara.getByLabel('Telefonnummer').fill('+49 170 1234567');
  await clara.getByRole('button', { name: 'Weiter', exact: true }).click();
  await clara.getByLabel('Code', { exact: true }).fill('22222');
  await clara.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(clara.getByText('Verbunden als Clara Test.')).toBeVisible();
  await home(clara);

  // Anna writes; the person hears who, never what.
  let from = await mark(clara);
  const sent = await fetch(`${TELEGRAM}/incoming`, { method: 'POST', body: JSON.stringify({ chat: 'anna', text: 'Kannst du morgen zum Kaffee kommen?' }) });
  expect(sent.ok).toBe(true);
  await said(clara, /^Neue Nachricht von Anna Beispiel\.$/, from);

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
  expect((await fetch(`${TELEGRAM}/hold`, { method: 'POST', body: JSON.stringify({ on: true }) })).ok).toBe(true);
  engines.model = asked(/Antworte/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Anna Beispiel', text: 'Morgen passt.' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Antworte, dass morgen passt');
  await said(clara, /^Nachricht an Anna Beispiel über Telegram: „Morgen passt\.“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Wird gesendet\.$/, from);
  await new Promise((r) => setTimeout(r, 2_000));
  expect((await spoken(clara)).slice(from).some((t) => /^Gesendet an/.test(t))).toBe(false);
  expect((await fetch(`${TELEGRAM}/hold`, { method: 'POST', body: JSON.stringify({ on: false }) })).ok).toBe(true);
  await said(clara, /^Gesendet an Anna Beispiel\.$/, from);
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
