/**
 * Connecting one of the person's email accounts (docs/plan-m3.md, K3), on their own device: the address, the password
 * (or an app password, where the provider asks for one), and the servers, filled in for known providers (GMX, WEB.DE,
 * T-Online, Posteo, mailbox.org, iCloud, Gmail, and Hetzner for domains of one's own) and typed for others. Outlook.com
 * and Microsoft 365 need a sign-in at Microsoft (OAuth2) that UCAP cannot do yet, and the page says so. The first
 * connection checks the account, sending included; what went wrong is said in plain words, with the provider's hint
 * (an app password, IMAP switched on). The password goes to the server once, sealed there, and is never shown again.
 * Several accounts can be connected, each on its own. Helpers get no access to mail through this (CONCEPT §3).
 * Disconnecting asks first and deletes UCAP's copies; the mailbox keeps its own.
 */
import { MAIL_PROVIDERS, type MailProvider, type MailServer, oauthOnly, providerFor } from '@ucap/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button, Form, Input, Label, Radio, RadioGroup, TextField } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

interface Connection {
  id: string;
  service: string;
  account: string;
  state: string;
  detail: { error?: string };
  running: boolean;
}

const KNOWN_ERRORS = ['auth_failed', 'smtp_auth_failed', 'unreachable', 'smtp_unreachable', 'mail_server'];
const OTHER = 'other';

interface Typed {
  imapHost: string;
  imapPort: string;
  imapTls: MailServer['tls'];
  smtpHost: string;
  smtpPort: string;
  smtpTls: MailServer['tls'];
}
const TYPED: Typed = { imapHost: '', imapPort: '993', imapTls: 'tls', smtpHost: '', smtpPort: '587', smtpTls: 'starttls' };

export function EmailPage(p: { session: Session; refresh: number; connectionId: string | null; onConnected: (id: string) => void; onClose: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [c, setC] = useState<Connection | null>(null);
  const [editing, setEditing] = useState(p.connectionId === null);
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  /** '' while the address names its provider; a provider's id, or OTHER for servers typed by hand. */
  const [chosen, setChosen] = useState('');
  const [typed, setTyped] = useState<Typed>(TYPED);
  const [status, setStatus] = useState('');
  const [asking, setAsking] = useState(false);
  const told = useRef('');
  const introduced = useRef(false);
  const sending = useRef(false);
  const questionRef = useRef<HTMLParagraphElement>(null);

  const found = providerFor(address);
  const provider: MailProvider | null = chosen === OTHER ? null : (MAIL_PROVIDERS.find((x) => x.id === chosen) ?? found);
  const microsoft = oauthOnly(address);
  const domainKnown = address.includes('@') && address.split('@')[1]!.includes('.');

  /** What the provider asks for first: an app password, or mail access switched on. */
  const hint = (x: MailProvider | null) => (x?.appPassword ? tr(`email.hint.appPassword.${x.id}`) : x?.enableImap ? tr('email.hint.enableImap', { name: x.name }) : '');

  function stateText(x: Connection): string {
    const e = x.detail.error;
    if (x.state === 'error') {
      const known = e && KNOWN_ERRORS.includes(e) ? tr(`email.error.${e}`) : tr('email.error.other', { code: e ?? '' });
      const h = e === 'auth_failed' || e === 'smtp_auth_failed' ? hint(providerFor(x.account)) : '';
      return h ? `${known} ${h}` : known;
    }
    if (x.state === 'ready') return tr('email.state.ready', { address: x.account });
    if (x.state === 'starting') return tr('email.state.starting');
    return tr('email.state.closed');
  }

  const report = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  const load = async () => {
    try {
      const r = await p.session.call<{ connections: Connection[] }>('/api/v1/messaging/connections');
      const conn = r.connections.find((x) => x.id === p.connectionId && x.service === 'email') ?? null;
      setC(conn);
      // Each new state or error is said once.
      const key = conn ? `${conn.state}|${conn.detail.error ?? ''}` : '';
      if (conn && key !== told.current) {
        told.current = key;
        say(stateText(conn), 'system');
      }
    } catch (e) {
      setStatus(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  };
  useEffect(() => {
    if (p.connectionId) void load();
    // Said once as the page opens: any messaging news (a WhatsApp message) refreshes the page.
    else if (!introduced.current) {
      introduced.current = true;
      say(tr('email.intro.say'), 'system');
    }
  }, [p.refresh, p.connectionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (asking) questionRef.current?.focus();
  }, [asking]);

  const failed = (e: unknown) => {
    const reason = e instanceof ApiError ? String(e.params.reason ?? '') : '';
    if (reason === 'connectors') return report(tr('email.notRunning'));
    if (reason === 'mail_server' || reason === 'mail_account') return report(tr(`email.error.${reason}`));
    report(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
  };

  /** The account, checked by the server's email process: its state follows on this page. */
  async function connect(e: FormEvent) {
    e.preventDefault();
    if (sending.current || microsoft) return;
    const servers = provider ? { imap: provider.imap, smtp: provider.smtp } : typedServers();
    if (!address.trim() || !password || !servers) return report(tr('email.error.mail_account'));
    sending.current = true;
    setStatus('');
    try {
      const r = await p.session.call<{ connection: Connection }>('/api/v1/messaging/connections', { method: 'POST', body: { service: 'email', address: address.trim(), password, ...servers } });
      setPassword('');
      setEditing(false);
      told.current = '';
      p.onConnected(r.connection.id);
    } catch (err) {
      failed(err);
    } finally {
      sending.current = false;
    }
  }

  function typedServers(): { imap: MailServer; smtp: MailServer } | null {
    const imapPort = Number(typed.imapPort);
    const smtpPort = Number(typed.smtpPort);
    if (!typed.imapHost.trim() || !typed.smtpHost.trim() || !Number.isInteger(imapPort) || !Number.isInteger(smtpPort)) return null;
    return { imap: { host: typed.imapHost.trim(), port: imapPort, tls: typed.imapTls }, smtp: { host: typed.smtpHost.trim(), port: smtpPort, tls: typed.smtpTls } };
  }

  /** Connecting again: the same address, a new password (it is never shown or kept on the device). */
  function again() {
    if (c) setAddress(c.account);
    setPassword('');
    setEditing(true);
    say(tr('email.again.say'), 'system');
  }

  async function disconnect() {
    setAsking(false);
    if (!c) return;
    try {
      await p.session.call(`/api/v1/messaging/connections/${c.id}`, { method: 'DELETE' });
      report(tr('email.disconnected', { address: c.account }));
      setC(null);
      p.onClose();
    } catch (e) {
      failed(e);
    }
  }

  const set = (x: Partial<Typed>) => setTyped((t) => ({ ...t, ...x }));

  return (
    <main className="page email">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('email.back')}
        </Button>
        <h1>{tr('email.title')}</h1>
      </header>
      <p className="muted">{tr('email.intro')}</p>
      {c && !c.running && <p className="status warning">{tr('email.notRunning')}</p>}
      {c && (
        <p className="status" aria-live="polite">
          {stateText(c)}
        </p>
      )}
      <p role="status" className="status">
        {status}
      </p>

      {editing && (
        <Form className="stack" onSubmit={(e) => void connect(e)}>
          <TextField value={address} onChange={setAddress} className="field" autoComplete="email" isReadOnly={c !== null}>
            <Label>{tr('email.address')}</Label>
            <Input type="email" inputMode="email" spellCheck={false} autoCorrect="off" autoCapitalize="off" />
          </TextField>
          {microsoft && <p className="status warning">{tr('email.microsoft')}</p>}
          {!microsoft && domainKnown && provider && (
            <div className="stack">
              <p>{tr(chosen ? 'email.provider.chosen' : 'email.provider.found', { name: provider.name })}</p>
              <Button className="button" onPress={() => setChosen(OTHER)}>
                {tr('email.provider.type')}
              </Button>
            </div>
          )}
          {!microsoft && domainKnown && !found && !provider && chosen !== OTHER && (
            <RadioGroup className="choice" value={chosen} onChange={setChosen}>
              <Label className="choice-label">{tr('email.provider.choose')}</Label>
              {MAIL_PROVIDERS.map((x) => (
                <Radio key={x.id} value={x.id} className="choice-option">
                  {x.name}
                </Radio>
              ))}
              <Radio value={OTHER} className="choice-option">
                {tr('email.provider.other')}
              </Radio>
            </RadioGroup>
          )}
          {!microsoft && chosen === OTHER && (
            <fieldset className="stack">
              <legend>{tr('email.servers')}</legend>
              <TextField value={typed.imapHost} onChange={(v) => set({ imapHost: v })} className="field">
                <Label>{tr('email.imap.host')}</Label>
                <Input spellCheck={false} autoCorrect="off" autoCapitalize="off" />
              </TextField>
              <TextField value={typed.imapPort} onChange={(v) => set({ imapPort: v })} className="field">
                <Label>{tr('email.imap.port')}</Label>
                <Input inputMode="numeric" />
              </TextField>
              <RadioGroup className="choice" value={typed.imapTls} onChange={(v) => set({ imapTls: v as MailServer['tls'], imapPort: v === 'tls' ? '993' : '143' })}>
                <Label className="choice-label">{tr('email.imap.tls')}</Label>
                <Radio value="tls" className="choice-option">
                  {tr('email.tls.tls')}
                </Radio>
                <Radio value="starttls" className="choice-option">
                  {tr('email.tls.starttls')}
                </Radio>
              </RadioGroup>
              <TextField value={typed.smtpHost} onChange={(v) => set({ smtpHost: v })} className="field">
                <Label>{tr('email.smtp.host')}</Label>
                <Input spellCheck={false} autoCorrect="off" autoCapitalize="off" />
              </TextField>
              <TextField value={typed.smtpPort} onChange={(v) => set({ smtpPort: v })} className="field">
                <Label>{tr('email.smtp.port')}</Label>
                <Input inputMode="numeric" />
              </TextField>
              <RadioGroup className="choice" value={typed.smtpTls} onChange={(v) => set({ smtpTls: v as MailServer['tls'], smtpPort: v === 'tls' ? '465' : '587' })}>
                <Label className="choice-label">{tr('email.smtp.tls')}</Label>
                <Radio value="tls" className="choice-option">
                  {tr('email.tls.tls')}
                </Radio>
                <Radio value="starttls" className="choice-option">
                  {tr('email.tls.starttls')}
                </Radio>
              </RadioGroup>
            </fieldset>
          )}
          {!microsoft && (
            <>
              <TextField value={password} onChange={setPassword} className="field" autoComplete="current-password">
                <Label>{tr(provider?.appPassword ? 'email.password.app' : 'email.password')}</Label>
                <Input type="password" spellCheck={false} autoCorrect="off" autoCapitalize="off" />
              </TextField>
              {hint(provider) && <p className="muted">{hint(provider)}</p>}
              <Button type="submit" className="button primary">
                {tr('email.connect')}
              </Button>
            </>
          )}
        </Form>
      )}

      {c && !editing && ['closed', 'error', 'logged_out'].includes(c.state) && (
        <Button className="button primary" onPress={again}>
          {tr('email.again')}
        </Button>
      )}

      {c && (
        <div className="stack">
          {asking ? (
            <>
              <p ref={questionRef} tabIndex={-1} className="question">
                {tr('email.disconnect.confirm', { address: c.account })}
              </p>
              <div className="row">
                <Button className="button primary" onPress={() => void disconnect()}>
                  {tr('email.disconnect.yes')}
                </Button>
                <Button className="button" onPress={() => setAsking(false)}>
                  {tr('email.disconnect.no')}
                </Button>
              </div>
            </>
          ) : (
            <Button
              className="button"
              onPress={() => {
                setAsking(true);
                say(tr('email.disconnect.confirm', { address: c.account }), 'system');
              }}
            >
              {tr('email.disconnect')}
            </Button>
          )}
        </div>
      )}
    </main>
  );
}
