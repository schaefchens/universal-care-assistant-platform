/**
 * Connecting the person's own WhatsApp (docs/plan-m3.md, K2), on their own device. First the risk in plain words, which
 * the person hears and agrees to (WhatsApp forbids other programs; Meta may block the number). Then their number, and
 * WhatsApp's pairing code: shown large and said character by character, with where to type it in WhatsApp on their
 * phone (Linked devices → "Link with phone number instead"). WhatsApp waits about three and a half minutes for it
 * (docs/spikes/m3.md, A); then a new one is fetched. Each step is said as it comes. The number passes through and is
 * never kept. Helpers get no access to messages through this (CONCEPT §3). Disconnecting asks first, unlinks UCAP
 * from the person's WhatsApp and deletes the copies kept on the server; WhatsApp keeps its own.
 */
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button, Form, Input, Label, TextField } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

interface Connection {
  id: string;
  service: string;
  state: string;
  detail: { pairing?: string; error?: string };
  me: { name: string } | null;
  running: boolean;
}

const KNOWN_ERRORS = ['phone_number_invalid', 'pairing_expired', 'pairing_failed', 'login_timeout', 'forbidden', 'replaced'];

/** "ABCD-1234": the code as WhatsApp's field shows it, in two halves. */
const shown = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function WhatsappPage(p: { session: Session; refresh: number; onClose: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [c, setC] = useState<Connection | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('');
  const [asking, setAsking] = useState(false);
  const told = useRef('');
  const riskTold = useRef(false);
  const questionRef = useRef<HTMLParagraphElement>(null);

  /** The code said one character at a time, so it can be typed while listening. */
  const spelled = (code: string) => tr('whatsapp.code.say', { chars: [...code].join(', ') });

  function stateText(x: Connection): string {
    const e = x.detail.error;
    if (e) return KNOWN_ERRORS.includes(e) ? tr(`whatsapp.error.${e}`) : tr('whatsapp.error.other', { code: e });
    if (x.state === 'wait_pairing' && x.detail.pairing) return `${spelled(x.detail.pairing)} ${tr('whatsapp.state.wait_pairing')}`;
    if (x.state === 'ready') return tr('whatsapp.state.ready', { name: x.me?.name ?? '' });
    if (['starting', 'wait_phone', 'wait_pairing', 'closed', 'logged_out'].includes(x.state)) return tr(`whatsapp.state.${x.state}`);
    return tr('whatsapp.state.error');
  }

  const report = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  const load = async () => {
    try {
      const r = await p.session.call<{ connections: Connection[]; offered: { whatsapp: boolean } }>('/api/v1/messaging/connections');
      const conn = r.connections.find((x) => x.service === 'whatsapp') ?? null;
      if (!r.offered.whatsapp && allowed === null && !conn) say(tr('whatsapp.notAllowed'), 'system');
      // The risk is said before anything else, once, as the page opens without a connection.
      if (r.offered.whatsapp && !conn && !riskTold.current) {
        riskTold.current = true;
        say(tr('whatsapp.risk'), 'system');
      }
      setAllowed(r.offered.whatsapp);
      setC(conn);
      // Each new step, a new code or a new error is said once.
      const key = conn ? `${conn.state}|${conn.detail.error ?? ''}|${conn.detail.pairing ?? ''}` : '';
      if (conn && key !== told.current) {
        told.current = key;
        say(stateText(conn), 'system');
        setValue('');
      }
    } catch (e) {
      setStatus(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  };
  useEffect(() => {
    void load();
  }, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (asking) questionRef.current?.focus();
  }, [asking]);

  const failed = (e: unknown) => report(e instanceof ApiError && e.params.reason === 'connectors' ? tr('whatsapp.notRunning') : tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));

  /** The person heard the risk and agreed: the connection starts (audited on the server). */
  async function connect() {
    setStatus('');
    try {
      await p.session.call('/api/v1/messaging/connections', { method: 'POST', body: { service: 'whatsapp', acceptedRisk: true } });
      await load();
    } catch (e) {
      failed(e);
    }
  }
  const sending = useRef(false);
  async function step(s: 'phone' | 'resend', e?: FormEvent) {
    e?.preventDefault();
    if (!c || sending.current || (s === 'phone' && !value.trim())) return;
    sending.current = true;
    try {
      await p.session.call(`/api/v1/messaging/connections/${c.id}/login`, { method: 'POST', body: s === 'resend' ? { step: s } : { step: s, value: value.trim() } });
      setValue('');
    } catch (err) {
      failed(err);
    } finally {
      sending.current = false;
    }
  }
  async function disconnect() {
    setAsking(false);
    if (!c) return;
    try {
      const r = await p.session.call<{ loggedOut: boolean }>(`/api/v1/messaging/connections/${c.id}`, { method: 'DELETE' });
      told.current = '';
      riskTold.current = false;
      report(tr(r.loggedOut ? 'whatsapp.disconnected' : 'whatsapp.disconnected.manual'));
      await load();
    } catch (e) {
      failed(e);
    }
  }

  const code = c?.state === 'wait_pairing' ? c.detail.pairing : undefined;

  return (
    <main className="page whatsapp">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('whatsapp.back')}
        </Button>
        <h1>{tr('whatsapp.title')}</h1>
      </header>
      <p className="muted">{tr('whatsapp.intro')}</p>
      {allowed === false && !c && <p className="status warning">{tr('whatsapp.notAllowed')}</p>}
      {c && !c.running && <p className="status warning">{tr('whatsapp.notRunning')}</p>}
      {c && (
        <p className="status" aria-live="polite">
          {c.state === 'wait_pairing' && code ? tr('whatsapp.state.wait_pairing') : stateText(c)}
        </p>
      )}
      <p role="status" className="status">
        {status}
      </p>

      {allowed && !c && (
        <div className="stack">
          <p className="status warning">{tr('whatsapp.risk')}</p>
          <Button className="button primary" onPress={() => void connect()}>
            {tr('whatsapp.agree')}
          </Button>
        </div>
      )}

      {c?.state === 'wait_phone' && (
        <Form className="stack" onSubmit={(e) => void step('phone', e)}>
          <TextField value={value} onChange={setValue} className="field" autoComplete="tel" autoFocus>
            <Label>{tr('whatsapp.phone')}</Label>
            <Input type="tel" inputMode="tel" spellCheck={false} autoCorrect="off" autoCapitalize="off" />
          </TextField>
          <Button type="submit" className="button primary">
            {tr('whatsapp.phone.send')}
          </Button>
        </Form>
      )}

      {c?.state === 'wait_pairing' && (
        <div className="stack">
          {code && (
            <>
              <p className="pairing-code" aria-label={tr('whatsapp.code.label', { chars: [...code].join(' ') })}>
                {shown(code)}
              </p>
              <p>{tr('whatsapp.code.where')}</p>
              <Button className="button" onPress={() => say(spelled(code), 'system')}>
                {tr('whatsapp.code.again')}
              </Button>
            </>
          )}
          <Button className="button" onPress={() => void step('resend')}>
            {tr('whatsapp.code.new')}
          </Button>
        </div>
      )}

      {c && ['closed', 'error', 'logged_out'].includes(c.state) && (
        <Button className="button primary" onPress={() => void connect()}>
          {tr('whatsapp.restart')}
        </Button>
      )}

      {c && (
        <div className="stack">
          {asking ? (
            <>
              <p ref={questionRef} tabIndex={-1} className="question">
                {tr('whatsapp.disconnect.confirm')}
              </p>
              <div className="row">
                <Button className="button primary" onPress={() => void disconnect()}>
                  {tr('whatsapp.disconnect.yes')}
                </Button>
                <Button className="button" onPress={() => setAsking(false)}>
                  {tr('whatsapp.disconnect.no')}
                </Button>
              </div>
            </>
          ) : (
            <Button
              className="button"
              onPress={() => {
                setAsking(true);
                say(tr('whatsapp.disconnect.confirm'), 'system');
              }}
            >
              {tr('whatsapp.disconnect')}
            </Button>
          )}
        </div>
      )}
    </main>
  );
}
