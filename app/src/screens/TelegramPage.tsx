/**
 * Connecting the person's own Telegram (docs/plan.md, S10; Appendix F "Login"), on their own device: the phone number,
 * the code (where it went, and a new one), the password if the account has one, or a QR code scanned with Telegram
 * on another device. Each step is said as it comes. The values pass through to Telegram and are never kept. Helpers
 * get no access to messages through this (CONCEPT §3). Disconnecting asks first and deletes the copies kept on the
 * server; Telegram keeps its own.
 */
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button, Form, Input, Label, TextField } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';
import { QrCode } from './words/QrCode.tsx';

interface Connection {
  id: string;
  state: string;
  detail: { code?: { via: string; length: number | null; next: string | null }; qr?: string; passwordHint?: string; error?: string };
  me: { name: string } | null;
  running: boolean;
}

type Step = 'phone' | 'code' | 'password' | 'qr' | 'resend';

export function TelegramPage(p: { session: Session; refresh: number; onClose: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [c, setC] = useState<Connection | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('');
  const [asking, setAsking] = useState(false);
  const told = useRef('');
  const questionRef = useRef<HTMLParagraphElement>(null);

  /** What the person is told about the state: the step, or what went wrong. */
  function stateText(x: Connection): string {
    const e = x.detail.error;
    if (e) {
      const wait = /^flood_wait_(\d+)$/.exec(e);
      if (wait) return tr('telegram.error.flood_wait', { minutes: Math.max(1, Math.ceil(Number(wait[1]) / 60)) });
      const known = ['phone_number_invalid', 'phone_code_invalid', 'phone_code_expired', 'password_hash_invalid', 'login_timeout', 'no_account', 'email_needed', 'not_configured'];
      return known.includes(e) ? tr(`telegram.error.${e}`) : tr('telegram.error.other', { code: e });
    }
    if (x.state === 'wait_code') {
      const code = x.detail.code;
      const via = tr(`telegram.via.${code?.via ?? 'other'}`);
      return `${tr('telegram.state.wait_code', { via })}${code?.length ? ` ${tr('telegram.code.length', { length: code.length })}` : ''}`;
    }
    if (x.state === 'wait_password' && x.detail.passwordHint) return `${tr('telegram.state.wait_password')} ${tr('telegram.password.hint', { hint: x.detail.passwordHint })}`;
    if (x.state === 'ready') return tr('telegram.state.ready', { name: x.me?.name ?? '' });
    if (['starting', 'wait_phone', 'wait_password', 'wait_qr', 'closed', 'logged_out'].includes(x.state)) return tr(`telegram.state.${x.state}`);
    return tr('telegram.state.error');
  }

  const report = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  const load = async () => {
    try {
      const r = await p.session.call<{ connection: Connection | null; configured: boolean }>('/api/v1/messaging/connection');
      // Why nothing can be done here yet, said once.
      if (!r.configured && configured === null) say(tr('telegram.notConfigured'), 'system');
      setConfigured(r.configured);
      setC(r.connection);
      // Each new step, a new error, or a code sent another way is said once (a refreshed QR code is not news).
      const key = r.connection ? `${r.connection.state}|${r.connection.detail.error ?? ''}|${r.connection.detail.code?.via ?? ''}` : '';
      if (r.connection && key !== told.current) {
        told.current = key;
        say(stateText(r.connection), 'system');
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

  const failed = (e: unknown) => report(e instanceof ApiError && e.params.reason === 'connectors' ? tr('telegram.notRunning') : tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));

  async function connect() {
    setStatus('');
    try {
      await p.session.call('/api/v1/messaging/connection', { method: 'POST' });
      await load();
    } catch (e) {
      failed(e);
    }
  }
  // One login step at a time: Telegram refuses a second while the first is on its way.
  const sending = useRef(false);
  async function step(s: Step, e?: FormEvent) {
    e?.preventDefault();
    if (sending.current || ((s === 'phone' || s === 'code' || s === 'password') && !value.trim())) return;
    sending.current = true;
    try {
      await p.session.call('/api/v1/messaging/connection/login', { method: 'POST', body: s === 'qr' || s === 'resend' ? { step: s } : { step: s, value: value.trim() } });
      setValue('');
    } catch (err) {
      failed(err);
    } finally {
      sending.current = false;
    }
  }
  async function disconnect() {
    setAsking(false);
    try {
      const r = await p.session.call<{ loggedOut: boolean }>('/api/v1/messaging/connection', { method: 'DELETE' });
      told.current = '';
      report(tr(r.loggedOut ? 'telegram.disconnected' : 'telegram.disconnected.manual'));
      await load();
    } catch (e) {
      failed(e);
    }
  }

  const field = (label: string, type: string, autoComplete: string, inputMode: 'tel' | 'numeric' | 'text') => (
    <TextField value={value} onChange={setValue} className="field" autoComplete={autoComplete} autoFocus>
      <Label>{label}</Label>
      <Input type={type} inputMode={inputMode} spellCheck={false} autoCorrect="off" autoCapitalize="off" />
    </TextField>
  );

  return (
    <main className="page telegram">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('telegram.back')}
        </Button>
        <h1>{tr('telegram.title')}</h1>
      </header>
      <p className="muted">{tr('telegram.intro')}</p>
      {configured === false && <p className="status warning">{tr('telegram.notConfigured')}</p>}
      {c && !c.running && <p className="status warning">{tr('telegram.notRunning')}</p>}
      {c && (
        <p className="status" aria-live="polite">
          {stateText(c)}
        </p>
      )}
      <p role="status" className="status">
        {status}
      </p>

      {configured && !c && (
        <Button className="button primary" onPress={() => void connect()}>
          {tr('telegram.connect')}
        </Button>
      )}

      {c?.state === 'wait_phone' && (
        <Form className="stack" onSubmit={(e) => void step('phone', e)}>
          {field(tr('telegram.phone'), 'tel', 'tel', 'tel')}
          <Button type="submit" className="button primary">
            {tr('telegram.phone.send')}
          </Button>
          <Button className="button" onPress={() => void step('qr')}>
            {tr('telegram.qr')}
          </Button>
        </Form>
      )}

      {c?.state === 'wait_code' && (
        <Form className="stack" onSubmit={(e) => void step('code', e)}>
          {field(tr('telegram.code'), 'text', 'one-time-code', 'numeric')}
          <Button type="submit" className="button primary">
            {tr('telegram.code.send')}
          </Button>
          <Button className="button" onPress={() => void step('resend')}>
            {c.detail.code?.next ? tr('telegram.code.resendVia', { via: tr(`telegram.via.${c.detail.code.next}`) }) : tr('telegram.code.resend')}
          </Button>
          <Button className="button" onPress={() => void step('qr')}>
            {tr('telegram.qr')}
          </Button>
        </Form>
      )}

      {c?.state === 'wait_password' && (
        <Form className="stack" onSubmit={(e) => void step('password', e)}>
          {field(tr('telegram.password'), 'password', 'off', 'text')}
          <Button type="submit" className="button primary">
            {tr('telegram.password.send')}
          </Button>
        </Form>
      )}

      {c?.state === 'wait_qr' && c.detail.qr && (
        <div className="stack">
          <QrCode text={c.detail.qr} label={tr('telegram.qr.label')} size={240} />
        </div>
      )}

      {c && ['closed', 'error', 'logged_out'].includes(c.state) && (
        <Button className="button primary" onPress={() => void connect()}>
          {tr('telegram.restart')}
        </Button>
      )}

      {c && (
        <div className="stack">
          {asking ? (
            <>
              <p ref={questionRef} tabIndex={-1} className="question">
                {tr('telegram.disconnect.confirm')}
              </p>
              <div className="row">
                <Button className="button primary" onPress={() => void disconnect()}>
                  {tr('telegram.disconnect.yes')}
                </Button>
                <Button className="button" onPress={() => setAsking(false)}>
                  {tr('telegram.disconnect.no')}
                </Button>
              </div>
            </>
          ) : (
            <Button
              className="button"
              onPress={() => {
                setAsking(true);
                say(tr('telegram.disconnect.confirm'), 'system');
              }}
            >
              {tr('telegram.disconnect')}
            </Button>
          )}
        </div>
      )}
    </main>
  );
}
