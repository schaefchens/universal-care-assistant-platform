/**
 * UCAP as this phone's SMS app (docs/plan-m3.md, K4), on the phone itself. Before Android's dialog: what changes (UCAP
 * receives and sends the SMS, Android's store keeps them, where Google Messages finds them again), and RCS: chats sent
 * through Google Messages' chat features may stop arriving, so the person switches those off first. Android's own
 * dialog takes two choices (the current app is preselected); an app installed from a file needs "Eingeschränkte
 * Einstellungen zulassen" first. Then the server's connection is made and the phone reports to it: 30 days of SMS, then
 * all that comes. The way back is always here: Android's Default apps page, one tap there; Android then ends UCAP's
 * processes, and the server is told. Helpers get no access to SMS through this (CONCEPT §3).
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { has, Sms } from '../native/plugins.ts';
import { useUi } from '../ui.tsx';

interface Connection {
  id: string;
  service: string;
  deviceId: string | null;
  state: string;
}

export function SmsPage(p: { session: Session; refresh: number; onClose: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const native = has('Sms');
  const [role, setRole] = useState<{ available: boolean; held: boolean; other: string | null } | null>(null);
  const [c, setC] = useState<Connection | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const told = useRef('');

  /** Where it stands, said once per change. */
  const load = async () => {
    const r = native ? await Sms.status().catch(() => null) : null;
    setRole(r);
    const list = await p.session.call<{ connections: Connection[] }>('/api/v1/messaging/connections').catch(() => null);
    const conn = list?.connections.find((x) => x.service === 'sms' && x.deviceId === p.session.ref.deviceId) ?? null;
    setC(conn);
    const key = !native || !r?.available ? 'unavailable' : r.held ? (conn?.state === 'ready' ? 'ready' : 'held') : 'other';
    if (key !== told.current) {
      told.current = key;
      say(text(key, r?.other ?? null), 'system');
    }
  };
  useEffect(() => {
    void load();
  }, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  function text(key: string, other: string | null): string {
    if (key === 'unavailable') return tr('sms.unavailable');
    if (key === 'ready') return tr('sms.state.ready');
    if (key === 'held') return tr('sms.state.held');
    return other ? tr('sms.state.other', { app: other }) : tr('sms.state.none');
  }

  const report = (t: string) => {
    setStatus(t);
    say(t, 'system');
  };

  /** Android's dialog, then the server's connection, then the phone reports to it. */
  async function take() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await Sms.requestRole();
      if (!r.held) return report(tr(r.reason === 'unavailable' ? 'sms.unavailable' : 'sms.refused'));
      await connect();
    } catch (e) {
      report(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    } finally {
      setBusy(false);
      void load();
    }
  }

  async function connect() {
    const r = await p.session.call<{ connection: { id: string } }>('/api/v1/messaging/connections', { method: 'POST', body: { service: 'sms' } });
    await Sms.connect({ connectionId: r.connection.id });
    report(tr('sms.connected'));
  }

  async function giveBack() {
    say(tr('sms.giveBack.how'), 'system');
    await Sms.openDefaultApps().catch(() => {});
  }

  const held = role?.held === true;
  return (
    <main className="page sms">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('sms.back')}
        </Button>
        <h1>{tr('sms.title')}</h1>
      </header>
      <p className="muted">{tr('sms.intro')}</p>
      <p className="status" aria-live="polite">
        {role === null && !native ? tr('sms.unavailable') : role ? text(!role.available ? 'unavailable' : held ? (c?.state === 'ready' ? 'ready' : 'held') : 'other', role.other) : ''}
      </p>
      <p role="status" className="status">
        {status}
      </p>

      {role?.available && !held && (
        <div className="stack">
          <p className="status warning">{tr('sms.rcs')}</p>
          <p>{tr('sms.dialog')}</p>
          <Button className="button primary" onPress={() => void take()} isDisabled={busy}>
            {tr('sms.take')}
          </Button>
          <p className="muted">{tr('sms.restricted')}</p>
        </div>
      )}

      {held && c?.state !== 'ready' && (
        <Button className="button primary" onPress={() => void connect().catch((e) => report(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`))).finally(() => void load())}>
          {tr('sms.connect')}
        </Button>
      )}

      {held && (
        <div className="stack">
          <p>{tr('sms.giveBack.what')}</p>
          <Button className="button" onPress={() => void giveBack()}>
            {tr('sms.giveBack')}
          </Button>
        </div>
      )}
    </main>
  );
}
