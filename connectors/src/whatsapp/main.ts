/**
 * The WhatsApp process (docs/plan-m3.md, K2): Baileys, pinned exactly, in a process of its own, its key stores sealed
 * per connection on a volume of its own (/data/whatsapp). The frame (dialing the assistant, hello, events kept while
 * it is away) is process.ts; the measurements behind this are docs/spikes/m3.md, A.
 *
 * Nothing goes to the console from here but this process's own lines: quiet.ts, imported before Baileys, turns Baileys'
 * logger off and replaces the console (libsignal prints session records with their private keys there).
 */
import { lastHour, logger } from './quiet.ts';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToConnectors } from '@ucap/shared';
import makeWASocket, { Browsers, DEFAULT_CONNECTION_CONFIG, downloadContentFromMessage, fetchLatestWaWebVersion, makeCacheableSignalKeyStore, type WAVersion } from 'baileys';
import { runProcess } from '../process.ts';
import { type SocketLike, WhatsappConnection } from './connection.ts';
import { openStore } from './store.ts';

const STORE_DIR = process.env.UCAP_WHATSAPP_DIR ?? '/data/whatsapp';
const FILES_DIR = process.env.UCAP_FILES_DIR ?? '/data/files';
const SAFE_DIR = /^[a-z0-9-]{1,64}$/;
const SAFE_DEST = /^incoming\/[a-z0-9-]{1,64}\/[a-z0-9-]{1,64}$/;

/**
 * The web version WhatsApp expects: fetched from web.whatsapp.com once a day, else Baileys' own. An old one is refused
 * (405) until Baileys is updated (plan-m3.md, Risks).
 */
let version: WAVersion = DEFAULT_CONNECTION_CONFIG.version;
async function refreshVersion() {
  const v = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (v?.isLatest) version = v.version;
}

const conns = new Map<string, WhatsappConnection>();

async function start(c: Extract<ToConnectors, { t: 'start'; service: 'whatsapp' }>) {
  const running = conns.get(c.id);
  if (running && !running.ended()) {
    running.replay();
    return;
  }
  // Ended (unlinked, refused, a link left waiting): started anew, as "Neu verbinden" asks.
  if (running) {
    conns.delete(c.id);
    await running.stop();
  }
  if (!SAFE_DIR.test(c.dir)) {
    emit({ t: 'conn.state', id: c.id, state: 'error', error: 'bad_dir' });
    return;
  }
  const store = await openStore(join(STORE_DIR, c.dir), c.storeKey);
  const conn = new WhatsappConnection({
    id: c.id,
    lang: c.lang === 'en' ? 'en' : 'de',
    store,
    filesRoot: FILES_DIR,
    makeSocket: (o) =>
      makeWASocket({
        auth: { creds: o.auth.creds, keys: makeCacheableSignalKeyStore(o.auth.keys, logger) },
        version,
        // Baileys' own: with a name of UCAP's own, WhatsApp refused the pairing code (spike A). The phone lists it as
        // "Chrome (Mac OS)".
        browser: Browsers.macOS('Chrome'),
        logger,
        // Never shown online: the phone keeps showing WhatsApp's notifications (plan-m3.md, research).
        markOnlineOnConnect: false,
        // What a linked browser gets (spike A: years of it); a full sync would ask the phone for everything.
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: o.getMessage,
      }) as unknown as SocketLike,
    fetchAudio: (a) => downloadContentFromMessage({ mediaKey: Buffer.from(a.mediaKey, 'base64'), directPath: a.directPath, url: a.url }, 'audio'),
    emit,
    log,
  });
  conns.set(c.id, conn);
  await conn.start();
  log(`connection ${c.id} started`);
}

/** A connection the person removed: this device unlinked from their WhatsApp (10 s at most), then its keys deleted. */
async function remove(id: string) {
  const conn = conns.get(id);
  conns.delete(id);
  if (conn) {
    await Promise.race([conn.logout(), new Promise((r) => setTimeout(r, 10_000))]);
    await conn.stop();
  }
  if (SAFE_DIR.test(id)) {
    await rm(join(STORE_DIR, id), { recursive: true, force: true });
    await rm(join(FILES_DIR, 'incoming', id), { recursive: true, force: true });
  }
  log(`connection ${id} removed`);
}

function handle(cmd: ToConnectors) {
  if (cmd.t === 'start') {
    if (cmd.service === 'whatsapp') {
      void start(cmd).catch((e) => {
        log(`connection ${cmd.id} not started: ${(e as Error).name}`);
        emit({ t: 'conn.state', id: cmd.id, state: 'error', error: 'store' });
      });
      return;
    }
    emit({ t: 'conn.state', id: cmd.id, state: 'error', error: 'service' });
    return;
  }
  if (cmd.t === 'remove') {
    void remove(cmd.id);
    return;
  }
  const conn = conns.get(cmd.id);
  if (!conn) {
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
      void conn.history(cmd.chatId, cmd.limit);
      return;
    case 'mark_read':
      void conn.markRead(cmd.chatId, cmd.externalIds);
      return;
  }
}

const { emit, log } = runProcess({
  name: 'whatsapp',
  version: 'ucap-whatsapp/1 (baileys 7.0.0-rc14)',
  services: ['whatsapp'],
  running: () => [...conns.keys()],
  handle,
  stopAll: () => Promise.allSettled([...conns.values()].map((c) => c.stop())),
  forget: (id) => conns.delete(id),
});

await refreshVersion();
setInterval(() => void refreshVersion(), 86_400_000).unref();
// Once an hour, how many lines Baileys and libsignal wanted to write: their wording only.
setInterval(() => {
  const line = lastHour();
  if (line) log(line);
}, 3_600_000).unref();
