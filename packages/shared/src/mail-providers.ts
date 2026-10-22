/**
 * Mail providers whose servers UCAP fills in (docs/plan-m3.md, K3 "Connecting"): found by the address's domain, or
 * chosen (Hetzner hosts domains of their own). Each says whether it needs an app password (a password made for one
 * program, where the account has two-step sign-in) or the mail access switched on in its settings first. Outlook.com
 * and Microsoft 365 need OAuth2, which UCAP cannot do yet (plan-m3.md, decisions: "not in M3").
 */
import type { MailServer } from './connectors.ts';

export interface MailProvider {
  id: string;
  name: string;
  domains: string[];
  imap: MailServer;
  smtp: MailServer;
  /** An app password, not the account's own (Gmail and iCloud with two-step sign-in). */
  appPassword: boolean;
  /** IMAP must be switched on in the provider's settings first (GMX, WEB.DE). */
  enableImap: boolean;
}

export const MAIL_PROVIDERS: readonly MailProvider[] = [
  { id: 'gmx', name: 'GMX', domains: ['gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch'], imap: { host: 'imap.gmx.net', port: 993, tls: 'tls' }, smtp: { host: 'mail.gmx.net', port: 587, tls: 'starttls' }, appPassword: false, enableImap: true },
  { id: 'webde', name: 'WEB.DE', domains: ['web.de'], imap: { host: 'imap.web.de', port: 993, tls: 'tls' }, smtp: { host: 'smtp.web.de', port: 587, tls: 'starttls' }, appPassword: false, enableImap: true },
  { id: 'tonline', name: 'Telekom (T-Online)', domains: ['t-online.de', 'magenta.de'], imap: { host: 'secureimap.t-online.de', port: 993, tls: 'tls' }, smtp: { host: 'securesmtp.t-online.de', port: 465, tls: 'tls' }, appPassword: true, enableImap: false },
  { id: 'posteo', name: 'Posteo', domains: ['posteo.de', 'posteo.net'], imap: { host: 'posteo.de', port: 993, tls: 'tls' }, smtp: { host: 'posteo.de', port: 587, tls: 'starttls' }, appPassword: false, enableImap: false },
  { id: 'mailboxorg', name: 'mailbox.org', domains: ['mailbox.org'], imap: { host: 'imap.mailbox.org', port: 993, tls: 'tls' }, smtp: { host: 'smtp.mailbox.org', port: 465, tls: 'tls' }, appPassword: false, enableImap: false },
  { id: 'icloud', name: 'iCloud', domains: ['icloud.com', 'me.com', 'mac.com'], imap: { host: 'imap.mail.me.com', port: 993, tls: 'tls' }, smtp: { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' }, appPassword: true, enableImap: false },
  { id: 'gmail', name: 'Gmail', domains: ['gmail.com', 'googlemail.com'], imap: { host: 'imap.gmail.com', port: 993, tls: 'tls' }, smtp: { host: 'smtp.gmail.com', port: 465, tls: 'tls' }, appPassword: true, enableImap: false },
  { id: 'hetzner', name: 'Hetzner', domains: [], imap: { host: 'mail.your-server.de', port: 993, tls: 'tls' }, smtp: { host: 'mail.your-server.de', port: 587, tls: 'starttls' }, appPassword: false, enableImap: false },
];

/** Microsoft's own domains: OAuth2 only, so not yet. */
export const OAUTH_ONLY_DOMAINS: readonly string[] = ['outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'live.com', 'live.de', 'msn.com'];

const domainOf = (address: string) => address.trim().toLowerCase().split('@')[1] ?? '';

/** The provider an address belongs to, by its domain; null when UCAP does not know it. */
export function providerFor(address: string): MailProvider | null {
  const d = domainOf(address);
  return MAIL_PROVIDERS.find((p) => p.domains.includes(d)) ?? null;
}

/** An address UCAP cannot connect yet (Microsoft's OAuth2). */
export function oauthOnly(address: string): boolean {
  return OAUTH_ONLY_DOMAINS.includes(domainOf(address));
}
