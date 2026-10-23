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
import { choose, clocks, heading, home, invitation, listen, mark, ORIGIN, said, setChoice, signUp, spoken, sql, talk, MESSAGING } from './app.ts';
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

  // Half a minute before three in the afternoon, then three: a three o'clock past step 5's reopen window (30 minutes
  // after its request was resolved), or "Ja" would reopen that request instead of sending a new one.
  await home(clara);
  const due = nextBerlin((await clocks.now()) + 31 * 60_000, 15, 0);
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
  await expect(clara.getByText(/^Telegram: verbunden\. hat Nachrichten ab dem \d+\. \S+ \d{4}; antwortet in den Unterhaltungen, die es gibt; „gesendet“, sobald Telegram es bestätigt\.$/)).toBeVisible();
  await said(clara, /^Nachrichtendienste\. Telegram: verbunden\.$/, from);
  await home(clara);

  // Anna writes; the person hears who, never what.
  from = await mark(clara);
  const sent = await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ chat: 'anna', text: 'Kannst du morgen zum Kaffee kommen?' }) });
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
  expect((await fetch(`${MESSAGING}/pair`, { method: 'POST' })).ok).toBe(true);
  await said(clara, /^Verbunden als Clara Test\. UCAP hat deine Nachrichten der letzten 30 Tage und alle neuen\.$/, from);

  // The services page names all three, each with its state.
  await clara.getByRole('button', { name: 'Zurück', exact: true }).click();
  await said(clara, /^Nachrichtendienste\. Telegram: verbunden\. SMS: verbunden\. WhatsApp: verbunden\.$/, from);
  await home(clara);

  // Anna writes on WhatsApp and by SMS, stamped with the servers' time; each is announced by its sender and, as there
  // is more than one service now, where it came.
  from = await mark(clara);
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ service: 'whatsapp', chat: 'anna', text: 'Am Samstag grillen wir, kommst du?' }) })).ok).toBe(true);
  await said(clara, /^Neue Nachricht von Anna Beispiel auf WhatsApp\.$/, from);
  from = await mark(clara);
  await ph.receive({ number: '+4915112345678', name: 'Anna Beispiel' }, 'Ich bin um drei bei dir.', await clocks.now());
  await said(clara, /^Neue Nachricht von Anna Beispiel per SMS\.$/, from);

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

  // Anna answers by email, above what she quotes: announced with the service, read with its subject, the quote named.
  from = await mark(clara);
  const mail = { service: 'email', chat: 'anna', text: 'Wir bringen Kuchen mit.', subject: 'Re: Besuch am Sonntag', quoted: 'Am Samstag schrieb Clara:\n> Wir freuen uns.' };
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify(mail) })).ok).toBe(true);
  await said(clara, /^Neue Nachricht von Anna Beispiel per E-Mail\.$/, from);
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

test('7e · one contact across services (docs/plan-m3.md, K6; acceptance 9): Clara saves Anna’s number; WhatsApp is hers by it, Telegram and email are asked and taken; her messages there are said as Anna’s; a new SMS and a new email to contacts with no conversation', async () => {
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
  await said(clara, /^Neue Nachricht von Anna auf WhatsApp\.$/, from);
  from = await mark(clara);
  expect((await fetch(`${MESSAGING}/incoming`, { method: 'POST', body: JSON.stringify({ chat: 'anna', text: 'Und Kuchen?' }) })).ok).toBe(true);
  await said(clara, /^Neue Nachricht von Anna auf Telegram\.$/, from);

  // A new SMS to the practice Maria saved (7d), with no conversation yet: the phone takes it with the number.
  engines.model = asked(/Physiotherapie/, () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Physiotherapie', text: 'Ich komme zehn Minuten später.' }], help: false }));
  from = await mark(clara);
  await talk(clara, engines, 'Schreib der Physiotherapie, dass ich zehn Minuten später komme');
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
  await home(clara);
  const mail = (subject: string | null) => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Bernd', text: 'Kommst du am Sonntag zum Kaffee?', subject }], help: false });
  engines.model = asked(/Bernd/, () => mail(null), () => mail('Kaffee am Sonntag'));
  from = await mark(clara);
  await talk(clara, engines, 'Schreib Bernd eine E-Mail, ob er am Sonntag zum Kaffee kommt');
  await said(clara, /^E-Mail an Bernd, Betreff „Kaffee am Sonntag“: „Kommst du am Sonntag zum Kaffee\?“\. Senden\?$/, from);
  await talk(clara, engines, 'Ja');
  await said(clara, /^Gesendet an Bernd\.$/, from);
  engines.model = () => reply('In Ordnung.');
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
