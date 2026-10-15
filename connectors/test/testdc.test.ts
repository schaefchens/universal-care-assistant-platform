/**
 * Opt-in: the real TDLib on Telegram's test servers (docs/plan.md, Appendix F "Tests"). Two test accounts (numbers
 * 99966XYYYY, whose login code is the DC digit X five times, on some days six) log in, one writes to the other, the
 * send is confirmed by Telegram and the message arrives. Needs the operator's own api_id and api_hash; sessions are kept between runs.
 *
 *   UCAP_TG_TEST=1 TG_API_ID=… TG_API_HASH=… npx vitest run --project connectors testdc
 *
 * The test servers are Telegram's, not UCAP's: an account made there is only for this test (Telegram allows
 * registration on the test servers; UCAP never creates accounts on the real ones). Every developer shares the test
 * numbers, and each number has a few logins a day: this computer draws its own two once and keeps them with the
 * sessions (or UCAP_TG_TEST_PHONES=+99966…,+99966…). UCAP_TG_TEST_TRACE=1 prints the login states.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FromConnectors } from '@ucap/shared';
import { getTdjson } from 'prebuilt-tdlib';
import * as tdl from 'tdl';
import { describe, expect, it } from 'vitest';
import { type TdClient, TelegramConnection } from '../src/telegram/connection.ts';

const on = process.env.UCAP_TG_TEST === '1' && !!process.env.TG_API_ID && !!process.env.TG_API_HASH;
const DIR = process.env.UCAP_TG_TEST_DIR ?? join(homedir(), '.cache', 'ucap-tg-test');
const DC = '2';

/** The two test numbers of this computer: drawn once, then the same, so their sessions stay valid. */
function phones(): string[] {
  if (process.env.UCAP_TG_TEST_PHONES) return process.env.UCAP_TG_TEST_PHONES.split(',').map((s) => s.trim());
  const file = join(DIR, 'phones.json');
  const kept = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as string[]) : [];
  if (kept.length === 2 && kept.every((n) => n.startsWith(`+99966${DC}`))) return kept;
  const first = randomInt(1000, 9998);
  const drawn = [`+99966${DC}${first}`, `+99966${DC}${first + 1}`];
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(drawn));
  return drawn;
}

async function until<T>(fn: () => T | undefined | null | false, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function account(name: string) {
  mkdirSync(join(DIR, name), { recursive: true });
  const client = tdl.createClient({
    apiId: Number(process.env.TG_API_ID),
    apiHash: String(process.env.TG_API_HASH),
    databaseDirectory: join(DIR, name, 'db'),
    filesDirectory: join(DIR, name, 'files'),
    databaseEncryptionKey: Buffer.alloc(32, name.charCodeAt(0)).toString('base64'),
    useTestDc: true,
  } as Parameters<typeof tdl.createClient>[0]);
  const events: FromConnectors[] = [];
  const conn = new TelegramConnection({ id: name, lang: 'de', filesRoot: join(DIR, name, 'out'), client: client as unknown as TdClient, emit: (e) => events.push(e), log: () => {} });
  return { client, conn, events };
}

describe.skipIf(!on)('Telegram test servers (opt-in)', () => {
  it('two test accounts log in; one writes, Telegram confirms the send, the other receives it', { timeout: 180_000 }, async () => {
    tdl.configure({ tdjson: getTdjson(), verbosityLevel: 0 });
    const PHONES = phones();
    const [a, b] = [account('a'), account('b')];
    /** Logs in from wherever the stored session's login stopped, one state (or refusal) Telegram reports at a time. */
    const ready = async (x: ReturnType<typeof account>, phone: string) => {
      const states = () => x.events.filter((e) => e.t === 'conn.state') as Extract<FromConnectors, { t: 'conn.state' }>[];
      const refusals = () => x.events.filter((e) => e.t === 'login.error') as Extract<FromConnectors, { t: 'login.error' }>[];
      const trace = (line: string) => process.env.UCAP_TG_TEST_TRACE && console.log(`${x.conn === a.conn ? 'a' : 'b'}: ${line}`);
      let seenStates = 0;
      let seenRefusals = 0;
      let codeLength = 0;
      for (let step = 0; step < 8; step++) {
        type Next = { refused: ReturnType<typeof refusals>[number] } | { state: ReturnType<typeof states>[number] };
        const next = await until<Next>(
          () => (refusals().length > seenRefusals ? { refused: refusals().at(-1)! } : states().length > seenStates ? { state: states().at(-1)! } : undefined),
          'the next login state',
        );
        if ('refused' in next) {
          seenRefusals = refusals().length;
          trace(`refused: ${next.refused.error}`);
          // Telegram has changed the length of these codes before (Telethon's docs): five, then six.
          if (next.refused.error === 'phone_code_invalid' && codeLength === 5) {
            codeLength = 6;
            await x.conn.login('code', DC.repeat(codeLength));
            continue;
          }
          throw new Error(`login refused: ${next.refused.error}`);
        }
        const s = next.state;
        seenStates = states().length;
        trace(`state ${s.state}${s.code ? `, code by ${s.code.via}, ${s.code.length} digits` : ''}${s.error ? ` (${s.error})` : ''}`);
        if (s.state === 'ready') return;
        if (s.state === 'wait_phone') await x.conn.login('phone', phone);
        // The code is the DC's digit, as many times as Telegram says the code is long.
        else if (s.state === 'wait_code') {
          codeLength = s.code?.length ?? 5;
          await x.conn.login('code', DC.repeat(codeLength));
        }
        // Only on the test servers: an account for the test.
        else if (s.state === 'error' && s.error === 'no_account') await x.client.invoke({ _: 'registerUser', first_name: 'UCAP', last_name: `Test ${phone.slice(-1)}` } as never);
        else throw new Error(`login stopped at ${s.state}${s.error ? ` (${s.error})` : ''}`);
      }
      throw new Error('the login did not finish');
    };
    await ready(a, PHONES[0]!);
    await ready(b, PHONES[1]!);
    const meB = (await b.client.invoke({ _: 'getMe' } as never)) as { id: number };
    const imported = (await a.client.invoke({ _: 'importContacts', contacts: [{ _: 'importedContact', phone_number: PHONES[1], first_name: 'UCAP', last_name: 'B' }] } as never)) as { user_ids: number[] };
    expect(imported.user_ids).toContain(meB.id);
    const chat = (await a.client.invoke({ _: 'createPrivateChat', user_id: meB.id, force: false } as never)) as { id: number };
    const text = `UCAP test ${new Date().toISOString()}`;
    await a.conn.send('req-1', String(chat.id), text);
    // Pending first; sent only once Telegram confirmed, with the server's id.
    expect(a.events).toContainEqual(expect.objectContaining({ t: 'send.result', requestId: 'req-1', state: 'pending_service' }));
    const sent = await until(() => a.events.find((e) => e.t === 'send.result' && e.state !== 'pending_service') as Extract<FromConnectors, { t: 'send.result' }> | undefined, 'send result');
    expect(sent.state).toBe('sent');
    const got = await until(() => b.events.find((e) => e.t === 'msg.upsert' && e.msg.text === text) as Extract<FromConnectors, { t: 'msg.upsert' }> | undefined, 'message at b');
    expect(got.msg).toMatchObject({ outgoing: false, kind: 'text', fromId: expect.stringMatching(/^user:\d+$/) });
    await a.conn.stop();
    await b.conn.stop();
  });
});
