/**
 * The email connector against the two Hetzner test mailboxes (docs/plan-m3.md, K3: "an opt-in suite with the two
 * Hetzner mailboxes"), only with UCAP_EMAIL_TEST=1: the first sends, the second hears it over IDLE and replies through
 * UCAP, the reply comes back to the first the same way, and the thread is kept on both sides; the reply's copy is in
 * the Sent folder, a mail heard in UCAP is read on the server, and nothing of the mail, the addresses or the passwords
 * is in the log. The servers and mailboxes come from .secrets and are never printed; what the run sent is deleted at
 * its end.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FromConnectors, MailServer } from '@ucap/shared';
import type { ImapFlow } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { type Account, compose, imapClient, smtpClient } from '../src/email/clients.ts';
import { EmailConnection } from '../src/email/connection.ts';

const RUN_IT = process.env.UCAP_EMAIL_TEST === '1';

/** KEY=VALUE lines of .secrets; the values stay in this process. */
function secrets(): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of readFileSync(new URL('../../.secrets', import.meta.url), 'utf8').split('\n')) {
    const x = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (x) m.set(x[1]!, /^(["']).*\1$/.test(x[2]!) ? x[2]!.slice(1, -1) : x[2]!);
  }
  return m;
}

function server(s: Map<string, string>, kind: 'IMAP' | 'SMTP'): MailServer {
  const port = Number(s.get(`EMAIL_${kind}_SERVER_PORT`));
  const e = (s.get(`EMAIL_${kind}_SERVER_ENCRYPTION`) ?? '').toLowerCase();
  return { host: s.get(`EMAIL_${kind}_SERVER`)!, port, tls: e.includes('starttls') ? 'starttls' : e.includes('ssl') || e.includes('tls') ? 'tls' : port === 993 || port === 465 ? 'tls' : 'starttls' };
}

async function until<T>(f: () => T | undefined | null | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A plain client, to look into a mailbox as another mail program would. */
async function plain(a: Account): Promise<ImapFlow> {
  const c = (await imapClient(a)()) as unknown as ImapFlow;
  await c.connect();
  return c;
}

async function sentPath(c: ImapFlow): Promise<string> {
  return (await c.list()).find((f) => f.specialUse === '\\Sent')!.path;
}

/** What this run sent, gone from both folders. */
async function clean(a: Account, tag: string) {
  const c = await plain(a).catch(() => null);
  if (!c) return;
  try {
    for (const box of ['INBOX', await sentPath(c)]) {
      const lock = await c.getMailboxLock(box);
      try {
        await c.messageDelete({ subject: tag }, { uid: true });
      } finally {
        lock.release();
      }
    }
  } finally {
    await c.logout().catch(() => c.close());
  }
}

describe.skipIf(!RUN_IT)('email, against the two test mailboxes', () => {
  it('the first sends, the second hears it over IDLE and replies in the thread, and the reply comes back the same way', async () => {
    const s = secrets();
    const imap = server(s, 'IMAP');
    const smtp = server(s, 'SMTP');
    const a1: Account = { address: s.get('TESTER1_EMAIL')!, password: s.get('TESTER1_EMAIL_PASSWORD')!, imap, smtp };
    const a2: Account = { address: s.get('TESTER2_EMAIL')!, password: s.get('TESTER2_EMAIL_PASSWORD')!, imap, smtp };
    const tag = `ucap-k3-${Date.now().toString(36)}`;
    const domain = a1.address.split('@')[1]!;
    const logs: string[] = [];
    const make = (id: string, a: Account, events: FromConnectors[]) =>
      new EmailConnection({
        id,
        lang: 'de',
        address: a.address,
        smtp: a.smtp,
        statePath: join(mkdtempSync(join(tmpdir(), 'ucap-email-live-')), 'state.json'),
        makeImap: imapClient(a),
        makeSmtp: smtpClient(a),
        compose,
        emit: (e) => events.push(e),
        log: (m) => logs.push(m),
      });
    const ev1: FromConnectors[] = [];
    const ev2: FromConnectors[] = [];
    const c1 = make('live-1', a1, ev1);
    const c2 = make('live-2', a2, ev2);
    const state = (ev: FromConnectors[]) => ev.filter((e) => e.t === 'conn.state').at(-1);
    const mail = (ev: FromConnectors[], id: string) => ev.find((e): e is Extract<FromConnectors, { t: 'msg.upsert' }> => e.t === 'msg.upsert' && e.msg.externalId === id);
    const sent = (ev: FromConnectors[], requestId: string) => ev.find((e): e is Extract<FromConnectors, { t: 'send.result' }> => e.t === 'send.result' && e.requestId === requestId && e.state !== 'pending_service');
    try {
      await c1.start();
      await c2.start();
      await until(() => [state(ev1), state(ev2)].every((x) => x?.t === 'conn.state' && (x.state === 'ready' || x.state === 'error')), 120_000, 'both ready');
      expect([state(ev1), state(ev2)].map((x) => x?.t === 'conn.state' && x.state)).toEqual(['ready', 'ready']);

      // The first mail, as another mail program sends it.
      const first = `${tag}-1@${domain}`;
      const raw = await compose({ from: a1.address, to: a2.address, subject: `Besuch ${tag}`, messageId: `<${first}>`, text: 'Passt dir Samstag?' });
      const t0 = performance.now();
      const smtp1 = await smtpClient(a1)();
      await smtp1.sendMail({ envelope: { from: a1.address, to: [a2.address] }, raw });
      smtp1.close();
      const got = await until(() => mail(ev2, first), 60_000, 'the first mail over IDLE');
      const idleMs = Math.round(performance.now() - t0);
      expect(got).toMatchObject({ live: true, msg: { chatId: `thread:${first}`, fromId: `mail:${a1.address.toLowerCase()}`, outgoing: false, subject: `Besuch ${tag}`, text: 'Passt dir Samstag?' } });

      // The reply, through UCAP: "sent" at the server's 250.
      await c2.send('r1', `thread:${first}`, 'Ja, Samstag passt.');
      const r1 = sent(ev2, 'r1');
      expect(r1?.state).toBe('sent');
      const back = await until(() => mail(ev1, r1!.externalId!), 60_000, 'the reply over IDLE');
      // The thread kept: the reply is in the first mail's thread, with its topic.
      expect(back).toMatchObject({ live: true, msg: { chatId: `thread:${first}`, subject: `Re: Besuch ${tag}`, text: 'Ja, Samstag passt.' } });

      // An answer to the answer, through UCAP on the first side, lands in the same thread on the second.
      await c1.send('r2', `thread:${first}`, 'Schön, bis dann.');
      const r2 = sent(ev1, 'r2');
      expect(r2?.state).toBe('sent');
      expect((await until(() => mail(ev2, r2!.externalId!), 60_000, 'the answer to the answer')).msg.chatId).toBe(`thread:${first}`);

      // The reply's copy is in the second's Sent folder; the first mail, heard in UCAP, is read on the server.
      await c2.markRead(`thread:${first}`, [first]);
      const p2 = await plain(a2);
      try {
        const box = await sentPath(p2);
        let lock = await p2.getMailboxLock(box);
        try {
          expect(await p2.search({ header: { 'message-id': r1!.externalId! } }, { uid: true })).toHaveLength(1);
        } finally {
          lock.release();
        }
        lock = await p2.getMailboxLock('INBOX');
        try {
          const uids = (await p2.search({ header: { 'message-id': first } }, { uid: true })) || [];
          const one = await p2.fetchOne(String(uids[0]), { flags: true }, { uid: true });
          expect(one && one.flags?.has('\\Seen')).toBe(true);
        } finally {
          lock.release();
        }
      } finally {
        await p2.logout().catch(() => p2.close());
      }

      // Nothing of the mail, the addresses or the passwords in the log.
      const all = logs.join('\n');
      for (const x of [a1.password, a2.password, a1.address, a2.address, tag, 'Samstag', imap.host, smtp.host]) expect(all.includes(x)).toBe(false);
      console.log(`email live: IDLE told the first mail ${idleMs} ms after the server took it`);
    } finally {
      await c1.stop();
      await c2.stop();
      await clean(a1, tag);
      await clean(a2, tag);
    }
  }, 360_000);
});
