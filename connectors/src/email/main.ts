/**
 * The email process (docs/plan-m3.md, K3): imapflow, mailparser and nodemailer, pinned, in a process of their own, with
 * a small state volume (/data/email: UIDs and Message-IDs per connection, no content). The frame (dialing the
 * assistant, hello, events kept while it is away) is process.ts; the clients are clients.ts; the measurements behind
 * this are docs/spikes/m3.md, B.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToConnectors } from '@ucap/shared';
import { runProcess } from '../process.ts';
import { compose, imapClient, smtpClient } from './clients.ts';
import { EmailConnection } from './connection.ts';

const STATE_DIR = process.env.UCAP_EMAIL_DIR ?? '/data/email';
const SAFE_ID = /^[a-z0-9-]{1,64}$/;

type Start = Extract<ToConnectors, { t: 'start'; service: 'email' }>;

const conns = new Map<string, { conn: EmailConnection; account: string }>();

/** What a start's account is: a new password or other servers make a new connection. */
const accountOf = (c: Start) => createHash('sha256').update(JSON.stringify([c.address, c.password, c.imap, c.smtp])).digest('hex');

async function start(c: Start) {
  const running = conns.get(c.id);
  const account = accountOf(c);
  if (running && !running.conn.ended() && running.account === account) {
    // The same account again: the person's senders may have changed.
    running.conn.setIdentities(c.identities);
    running.conn.replay();
    return;
  }
  // Ended (a refused login, a server that could not be reached), or connected again with a new password or other
  // servers: started anew.
  if (running) {
    conns.delete(c.id);
    await running.conn.stop();
  }
  if (!SAFE_ID.test(c.id)) {
    emit({ t: 'conn.state', id: c.id, state: 'error', error: 'bad_dir' });
    return;
  }
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const conn = new EmailConnection({
    id: c.id,
    lang: c.lang === 'en' ? 'en' : 'de',
    address: c.address,
    identities: c.identities,
    smtp: c.smtp,
    statePath: join(STATE_DIR, `${c.id}.json`),
    makeImap: imapClient(c),
    makeSmtp: smtpClient(c),
    compose,
    emit,
    log,
  });
  conns.set(c.id, { conn, account });
  await conn.start();
  log(`connection ${c.id} started`);
}

/** A connection the person removed: logged out, its state deleted. */
async function remove(id: string) {
  const running = conns.get(id);
  conns.delete(id);
  if (running) await Promise.race([running.conn.logout(), new Promise((r) => setTimeout(r, 10_000))]);
  if (SAFE_ID.test(id)) await rm(join(STATE_DIR, `${id}.json`), { force: true });
  log(`connection ${id} removed`);
}

function handle(cmd: ToConnectors) {
  if (cmd.t === 'start') {
    if (cmd.service === 'email') {
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
  const conn = conns.get(cmd.id)?.conn;
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
      // Nothing to type after the password: it came with the start.
      emit({ t: 'login.error', id: cmd.id, error: 'login_state' });
      return;
    case 'send':
      void conn.send(cmd.requestId, cmd.chatId, cmd.text, cmd.subject, cmd.to, { all: cmd.all, from: cmd.from });
      return;
    case 'download':
      // Email has no voice messages to fetch; attachments are named, never opened.
      emit({ t: 'file.ready', id: cmd.id, requestId: cmd.requestId, ok: false });
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
  name: 'email',
  version: 'ucap-email/1 (imapflow 2.3.0, nodemailer 10.0.16, mailparser 3.9.37)',
  services: ['email'],
  running: () => [...conns.keys()],
  handle,
  stopAll: () => Promise.allSettled([...conns.values()].map((c) => c.conn.stop())),
  forget: (id) => conns.delete(id),
});
