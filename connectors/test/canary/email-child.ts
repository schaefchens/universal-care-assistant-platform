/**
 * The email side of the log canary (log-canary.test.ts), in a process of its own as the email process is: imapflow and
 * nodemailer with UCAP's options (clients.ts) and every other switch at its loudest. imapflow logs raw socket data and
 * emits each entry as an event, nodemailer logs each command and response, and the canary words pass through both: the
 * password at login, a mail fetched, parsed with UCAP's parser, marked read, its reply sent and copied to the Sent
 * folder, and a recipient refused with words of its own. Whatever reaches this process's stdout and stderr is the
 * test's to check; what this process found goes back over the IPC channel only.
 *
 *   node email-child.ts <config as JSON>
 */
import { readFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { compose, imapOptions, smtpOptions } from '../../src/email/clients.ts';
import { parseMail } from '../../src/email/mail.ts';

interface Config {
  address: string;
  password: string;
  imapPort: number;
  smtpPort: number;
  ca: string;
  /** Words to look for in imapflow's own log events (at its loudest), and the text the fetched mail carries. */
  words: string[];
  text: string;
  reply: { to: string; refused: string; subject: string; text: string };
}

const c = JSON.parse(process.argv[2]!) as Config;
const ca = readFileSync(c.ca, 'utf8');
const account = { address: c.address, password: c.password, imap: { host: 'mail.canary.test', port: c.imapPort, tls: 'tls' as const }, smtp: { host: 'mail.canary.test', port: c.smtpPort, tls: 'tls' as const } };
const found: Record<string, unknown> = {};

// —— imapflow ——
const o = imapOptions(account, '127.0.0.1');
const imap = new ImapFlow({ ...o, tls: { ...o.tls, ca }, logRaw: true, emitLogs: true });
let events = 0;
const inEvents = new Set<string>();
imap.on('log', (e: { data?: unknown }) => {
  events++;
  // Raw socket data comes as base64.
  const s = JSON.stringify(e) + (typeof e.data === 'string' ? Buffer.from(e.data, 'base64').toString() : '');
  for (const w of c.words) if (s.includes(w)) inEvents.add(w);
});
await imap.connect();
await imap.mailboxOpen('INBOX');
let source: Buffer | undefined;
for await (const m of imap.fetch('1:*', { uid: true, source: true }, { uid: true })) source = m.source;
const mail = await parseMail(source!);
found.parsed = mail.fresh.includes(c.text);
await imap.messageFlagsAdd([1], ['\\Seen'], { uid: true });
const raw = await compose({ from: c.address, to: c.reply.to, subject: c.reply.subject, text: c.reply.text });
await imap.append('Sent', raw, ['\\Seen']);
await imap.logout();
found.imapEvents = events;
found.wordsInEvents = [...inEvents];

// —— nodemailer ——
const s = smtpOptions(account, '127.0.0.1');
const smtp = createTransport({ ...s, tls: { ...s.tls, ca }, debug: true, transactionLog: true });
await smtp.verify();
const sent = await smtp.sendMail({ envelope: { from: c.address, to: [c.reply.to] }, raw });
found.sent = /^250/.test(sent.response);
found.refused = await smtp
  .sendMail({ envelope: { from: c.address, to: [c.reply.refused] }, raw })
  .then(() => false)
  .catch((e: { responseCode?: number }) => e.responseCode === 550);
smtp.close();

process.send!(found, () => process.exit(0));
