/**
 * The real clients for a person's mail servers (docs/plan-m3.md, K3; docs/spikes/m3.md, B), used by the email process
 * and its opt-in live suite.
 *
 * - Both libraries log commands at their debug levels, and LOGIN carries the password: their loggers are off.
 * - A server's name is resolved by the system and must lead to public addresses only (net.ts); the connection goes to
 *   that address, with the name kept for TLS. nodemailer would otherwise resolve it with its own DNS queries first,
 *   which can hang where direct DNS is blocked (spike B).
 * - STARTTLS is required where it is chosen: a password never crosses the network in the clear.
 */
import type { MailServer } from '@ucap/shared';
import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import type { ImapLike, SmtpLike } from './connection.ts';
import { resolvePublic } from './net.ts';

export interface Account {
  address: string;
  password: string;
  imap: MailServer;
  smtp: MailServer;
}

export function imapClient(a: Account): () => Promise<ImapLike> {
  return async () => {
    const address = await resolvePublic(a.imap.host);
    return new ImapFlow({
      host: address,
      servername: a.imap.host,
      port: a.imap.port,
      secure: a.imap.tls === 'tls',
      ...(a.imap.tls === 'starttls' ? { doSTARTTLS: true } : {}),
      tls: { servername: a.imap.host },
      auth: { user: a.address, pass: a.password },
      logger: false,
      // UIDs in unsolicited FETCH (read in another program): spike B.
      qresync: true,
      // In IDLE a second after the last command, not imapflow's 15 s: mail that comes meanwhile waits for it (measured
      // in the live suite: 15.2 s with the default).
      autoIdleDelay: 1_000,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      clientInfo: { name: 'UCAP' },
    }) as unknown as ImapLike;
  };
}

export function smtpClient(a: Account): () => Promise<SmtpLike> {
  return async () => {
    const address = await resolvePublic(a.smtp.host);
    return createTransport({
      host: address,
      servername: a.smtp.host,
      tls: { servername: a.smtp.host },
      port: a.smtp.port,
      secure: a.smtp.tls === 'tls',
      requireTLS: a.smtp.tls === 'starttls',
      auth: { user: a.address, pass: a.password },
      logger: false,
      debug: false,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    }) as unknown as SmtpLike;
  };
}

/** A mail's bytes, as they are sent and kept in the Sent folder. */
const composer = createTransport({ streamTransport: true, buffer: true });
export async function compose(mail: Record<string, unknown>): Promise<Buffer> {
  const info = await composer.sendMail(mail);
  return info.message as Buffer;
}
