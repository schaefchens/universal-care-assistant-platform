/**
 * The connectors process: TDLib for Telegram (M1), later WhatsApp and email. It holds no database credentials and
 * talks only to the assistant process over an internal WebSocket (docs/plan.md, Appendix B "Internal connector
 * protocol"), so a crash in native messaging code can never reach the help path. TDLib keeps a lock on its database,
 * so this process is restarted by hand, never by --watch.
 *
 * - It dials the assistant and proves itself with the connectors token in its first frame (`hello`).
 * - The assistant starts each person's connection with its secrets (`start`); they live in this process's memory only.
 * - While the assistant is away (a restart), events wait here in order, up to a limit, and go out after the next hello.
 * - On SIGTERM every TDLib client is closed before the process exits (compose gives it 20 s).
 *
 * Logs carry states, codes and counts only, never content.
 */
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { FromConnectors, ToConnectors } from '@ucap/shared';
import { getTdjson } from 'prebuilt-tdlib';
import * as tdl from 'tdl';
import { type TdClient, TelegramConnection } from './telegram/connection.ts';

const VERSION = 'ucap-connectors/1';
const PORT = Number(process.env.PORT ?? 8822);
const ASSISTANT = process.env.UCAP_ASSISTANT_WS ?? 'ws://assistant:8821/internal/connectors';
const TDLIB_DIR = process.env.UCAP_TDLIB_DIR ?? '/data/tdlib';
const FILES_DIR = process.env.UCAP_FILES_DIR ?? '/data/files';
/** Events kept while the assistant is away; beyond this the oldest go (TDLib's own history fills the gap at start). */
const MAX_PENDING = 10_000;

const log = (m: string) => console.log(`connectors: ${m}`);

function secret(name: string): string {
  for (const dir of ['/run/secrets', process.env.UCAP_SECRETS_DIR]) {
    if (!dir) continue;
    const file = join(dir, name);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  }
  console.error(`connectors: missing secret "${name}": run \`npm run setup\` (see README.md)`);
  process.exit(1);
}
const token = secret('connectors_token');

tdl.configure({ tdjson: getTdjson(), verbosityLevel: 1 });

const conns = new Map<string, TelegramConnection>();
const pending: string[] = [];
let dropped = 0;
let ws: WebSocket | null = null;
let ready = false;
let stopping = false;

function emit(e: FromConnectors) {
  // A connection that closed (logged out, or its client ended) is gone from here.
  if (e.t === 'conn.state' && (e.state === 'closed' || e.state === 'logged_out')) conns.delete(e.id);
  const frame = JSON.stringify(e);
  if (ws && ready && ws.readyState === WebSocket.OPEN) {
    ws.send(frame);
    return;
  }
  pending.push(frame);
  if (pending.length > MAX_PENDING) {
    pending.shift();
    dropped++;
  }
}

const SAFE_DIR = /^[a-z0-9-]{1,64}$/;
const SAFE_DEST = /^incoming\/[a-z0-9-]{1,64}\/[a-z0-9-]{1,64}$/;

function start(c: Extract<ToConnectors, { t: 'start' }>) {
  const running = conns.get(c.id);
  if (running) {
    running.replay();
    return;
  }
  if (!SAFE_DIR.test(c.dir)) {
    emit({ t: 'conn.state', id: c.id, state: 'error', error: 'bad_dir' });
    return;
  }
  const dir = join(TDLIB_DIR, c.dir);
  const client = tdl.createClient({
    apiId: c.apiId,
    apiHash: c.apiHash,
    databaseDirectory: join(dir, 'db'),
    filesDirectory: join(dir, 'files'),
    // 32 random bytes from the server, base64 (TDLib reads `bytes` fields as base64).
    databaseEncryptionKey: c.dbKey,
    useTestDc: c.testDc,
    tdlibParameters: {
      use_message_database: true,
      use_secret_chats: false,
      system_language_code: c.lang,
      application_version: '1.0',
      device_model: 'UCAP',
      system_version: 'server',
    },
  } as Parameters<typeof tdl.createClient>[0]);
  const conn = new TelegramConnection({ id: c.id, lang: c.lang === 'en' ? 'en' : 'de', filesRoot: FILES_DIR, client: client as unknown as TdClient, emit, log });
  conns.set(c.id, conn);
  emit({ t: 'conn.state', id: c.id, state: 'starting' });
  log(`connection ${c.id} started${c.testDc ? ' (test DC)' : ''}`);
}

/** A connection the person removed: logged out if it runs (10 s at most), then its files deleted. */
async function remove(id: string) {
  const conn = conns.get(id);
  conns.delete(id);
  if (conn) {
    await Promise.race([conn.logout(), new Promise((r) => setTimeout(r, 10_000))]);
    await conn.stop();
  }
  if (SAFE_DIR.test(id)) {
    await rm(join(TDLIB_DIR, id), { recursive: true, force: true });
    await rm(join(FILES_DIR, 'incoming', id), { recursive: true, force: true });
  }
  log(`connection ${id} removed`);
}

function handle(cmd: ToConnectors) {
  if (cmd.t === 'start') return start(cmd);
  if (cmd.t === 'remove') {
    void remove(cmd.id);
    return;
  }
  const conn = conns.get(cmd.id);
  if (!conn) {
    // Not running here (any more): the assistant starts it again when it should run.
    emit({ t: 'conn.state', id: cmd.id, state: 'closed' });
    return;
  }
  switch (cmd.t) {
    case 'stop':
      conns.delete(cmd.id);
      void conn.stop().then(() => emit({ t: 'conn.state', id: cmd.id, state: 'closed' }));
      return;
    case 'login':
      void conn.login(cmd.step, cmd.value);
      return;
    case 'send':
      void conn.send(cmd.requestId, cmd.chatId, cmd.text);
      return;
    case 'download':
      if (!SAFE_DEST.test(cmd.dest)) {
        emit({ t: 'file.ready', id: cmd.id, requestId: cmd.requestId, ok: false });
        return;
      }
      void conn.download(cmd.requestId, cmd.fileId, cmd.dest);
      return;
    case 'history':
      void conn.history(cmd.chatId, Math.min(100, Math.max(1, cmd.limit)));
      return;
    case 'mark_read':
      void conn.markRead(cmd.chatId, cmd.externalIds);
      return;
  }
}

let backoff = 500;
function dial() {
  if (stopping) return;
  ready = false;
  const socket = new WebSocket(ASSISTANT);
  ws = socket;
  socket.addEventListener('open', () => {
    backoff = 500;
    socket.send(JSON.stringify({ t: 'hello', token, version: VERSION, running: [...conns.keys()] } satisfies FromConnectors));
    ready = true;
    if (dropped) log(`${dropped} events were dropped while the assistant was away`);
    dropped = 0;
    for (const frame of pending.splice(0)) socket.send(frame);
    log('connected to the assistant');
  });
  socket.addEventListener('message', (m) => {
    let cmd: ToConnectors;
    try {
      cmd = JSON.parse(String(m.data)) as ToConnectors;
    } catch {
      return;
    }
    try {
      handle(cmd);
    } catch (e) {
      log(`command ${cmd.t} failed: ${(e as Error).name}`);
    }
  });
  socket.addEventListener('close', (e) => {
    ready = false;
    if (ws === socket) ws = null;
    if (stopping) return;
    if (e.code === 4403) log('the assistant refused the connectors token');
    // Jittered backoff, 0.5 s up to 15 s.
    const wait = backoff * (0.75 + Math.random() / 2);
    backoff = Math.min(15_000, backoff * 2);
    setTimeout(dial, wait);
  });
  socket.addEventListener('error', () => {
    // A close follows.
  });
}

const server = createServer((req, res) => {
  const ok = req.url === '/healthz';
  res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ok ? { ok: true, service: 'connectors', assistant: ready, connections: conns.size } : { error: 'not_found' }));
});
server.listen(PORT, '0.0.0.0', () => log(`listening on :${PORT}`));
dial();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    stopping = true;
    log(`closing ${conns.size} connections`);
    const all = [...conns.values()].map((c) => c.stop());
    const limit = new Promise((resolve) => setTimeout(resolve, 15_000));
    void Promise.race([Promise.allSettled(all), limit]).finally(() => {
      // A client may close with 1000 or 3000–4999 only (1001 throws).
      ws?.close(1000, 'stopping');
      server.close();
      // tdl's receive loop keeps the process alive after the last client closed (docs/spikes/README.md).
      process.exit(0);
    });
  });
}
