/**
 * The connectors process for Telegram (TDLib); WhatsApp and email run in processes of their own (docs/plan-m3.md). It
 * holds no database credentials and talks only to the assistant process over an internal WebSocket (docs/plan.md,
 * Appendix B "Internal connector protocol"), so a crash in native messaging code can never reach the help path. TDLib keeps a lock on its database,
 * so this process is restarted by hand, never by --watch.
 *
 * - It dials the assistant and proves itself with the connectors token in its first frame (`hello`): process.ts.
 * - The assistant starts each person's connection with its secrets (`start`); they live in this process's memory only.
 * - On SIGTERM every TDLib client is closed before the process exits (compose gives it 20 s).
 *
 * Logs carry states, codes and counts only, never content.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FromConnectors, ToConnectors } from '@ucap/shared';
import { getTdjson } from 'prebuilt-tdlib';
import * as tdl from 'tdl';
import { runProcess } from './process.ts';
import { type TdClient, TelegramConnection } from './telegram/connection.ts';

const TDLIB_DIR = process.env.UCAP_TDLIB_DIR ?? '/data/tdlib';
const FILES_DIR = process.env.UCAP_FILES_DIR ?? '/data/files';

// Fatal errors only: from level 1 (errors) TDLib quotes what it was handling, a link in a message's preview for one.
tdl.configure({ tdjson: getTdjson(), verbosityLevel: 0 });

const conns = new Map<string, TelegramConnection>();

const SAFE_DIR = /^[a-z0-9-]{1,64}$/;
const SAFE_DEST = /^incoming\/[a-z0-9-]{1,64}\/[a-z0-9-]{1,64}$/;

function start(c: Extract<ToConnectors, { t: 'start'; service: 'telegram' }>) {
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
  if (cmd.t === 'start') {
    // This process runs Telegram; WhatsApp and email run in processes of their own (docs/plan-m3.md).
    if (cmd.service === 'telegram') return start(cmd);
    emit({ t: 'conn.state', id: cmd.id, state: 'error', error: 'service' });
    return;
  }
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
      void conn.send(cmd.requestId, cmd.chatId, cmd.text, cmd.to);
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

const { emit, log }: { emit: (e: FromConnectors) => void; log: (m: string) => void } = runProcess({
  name: 'connectors',
  version: 'ucap-connectors/1',
  services: ['telegram'],
  running: () => [...conns.keys()],
  handle,
  stopAll: () => Promise.allSettled([...conns.values()].map((c) => c.stop())),
  forget: (id) => conns.delete(id),
});
