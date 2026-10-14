/**
 * Spike A (docs/plan.md, S0): does TDLib run in UCAP's image (Debian slim, glibc, arm64) through tdl + prebuilt-tdlib?
 *
 * Without credentials it checks what needs no network: the library loads, reports its version, takes the parameters
 * and reaches "waiting for a phone number" on Telegram's test DC. With TG_API_ID and TG_API_HASH (the operator's own,
 * from my.telegram.org) and TG_TEST_PHONE (a test-DC number 99966XYYYY), it also logs in. The login code on the test
 * DC is the DC digit X five times. It logs states and timings only, never message content.
 *
 *   docker compose exec connectors node connectors/spikes/tdlib-check.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTdjson } from 'prebuilt-tdlib';
import * as tdl from 'tdl';

const started = performance.now();
const ms = () => Math.round(performance.now() - started);

tdl.configure({ tdjson: getTdjson(), verbosityLevel: 1 });

// Without credentials, obviously fake values: TDLib checks them only when it talks to Telegram.
const apiId = Number(process.env.TG_API_ID ?? 0) || 1;
const apiHash = process.env.TG_API_HASH ?? '0'.repeat(32);
const phone = process.env.TG_TEST_PHONE;
const dir = mkdtempSync(join(tmpdir(), 'tdlib-spike-'));

const client = tdl.createClient({
  apiId,
  apiHash,
  databaseDirectory: join(dir, 'db'),
  filesDirectory: join(dir, 'files'),
  // TDLib reads `bytes` fields as base64. UCAP's real key: 32 random bytes from the server, stored encrypted.
  databaseEncryptionKey: Buffer.from('spike-only-not-a-secret').toString('base64'),
  useTestDc: true,
  tdlibParameters: { device_model: 'UCAP spike', system_language_code: 'de', application_version: '0.0.0' },
});

// TDLib's own error text names the failing request, never message content.
client.on('error', (e: unknown) => console.log(`${ms()} ms  error ${e instanceof Error ? `${e.name}: ${e.message}` : typeof e}`));

const done = new Promise<void>((resolve) => {
  client.on('update', (u: { _: string; authorization_state?: { _: string } }) => {
    if (u._ !== 'updateAuthorizationState' || !u.authorization_state) return;
    const state = u.authorization_state._;
    console.log(`${ms()} ms  ${state}`);
    if (state === 'authorizationStateWaitPhoneNumber' && !phone) resolve();
    if (state === 'authorizationStateReady' || state === 'authorizationStateClosed') resolve();
  });
});

const version = (await client.invoke({ _: 'getOption', name: 'version' })) as { value?: string };
console.log(`${ms()} ms  TDLib ${version.value ?? '?'} on ${process.platform}-${process.arch}, Node ${process.version}`);

if (phone) {
  const dc = phone.slice(5, 6);
  await client.login(() => ({
    getPhoneNumber: async () => phone,
    getAuthCode: async () => dc.repeat(5),
    getName: async () => ({ firstName: 'UCAP', lastName: 'Spike' }),
  }));
  const me = (await client.invoke({ _: 'getMe' })) as { id: number };
  console.log(`${ms()} ms  logged in on the test DC as user ${me.id}`);
}

await done;
await client.close();
console.log(`${ms()} ms  closed`);
// tdl's receive loop keeps the process alive after the last client closed.
process.exit(0);
