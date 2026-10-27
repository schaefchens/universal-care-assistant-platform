/**
 * The person's devices (docs/plan.md, S2: device list, rename and revoke). Signing a device out ends its sessions at
 * once and closes its connection; it can come back through the recovery words or a new link. Signing out this device
 * also removes its key. A new device is added here by a code (docs/plan-m4.md, G3: `LinkOffer`).
 */
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button, Form, Heading, Input, Label, TextField } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';
import { LinkOffer } from './LinkOffer.tsx';

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  formFactor: string | null;
  enrolledVia: 'create' | 'recover' | 'link';
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

type Action = { kind: 'none' } | { kind: 'rename'; id: string; value: string } | { kind: 'revoke'; id: string };

export function Devices(p: { session: Session; serverName: string; onSignedOut: () => void; onClose: () => void }) {
  const { tr, say } = useUi();
  const [rows, setRows] = useState<DeviceRow[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [action, setAction] = useState<Action>({ kind: 'none' });
  const [status, setStatus] = useState('');
  const questionRef = useRef<HTMLParagraphElement>(null);

  const load = async () => {
    try {
      const r = await p.session.call<{ devices: DeviceRow[]; current: string }>('/api/v1/devices');
      setRows(r.devices);
      setCurrent(r.current);
    } catch (e) {
      setStatus(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A confirmation question takes the focus and is spoken, so it is never missed.
  useEffect(() => {
    if (action.kind === 'revoke') questionRef.current?.focus();
  }, [action]);

  const report = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  async function rename(e: FormEvent, id: string, value: string) {
    e.preventDefault();
    const name = value.trim();
    if (!name) return;
    try {
      await p.session.call(`/api/v1/devices/${id}`, { method: 'PATCH', body: { name } });
      setAction({ kind: 'none' });
      report(tr('devices.renamed', { name }));
      await load();
    } catch (err) {
      report(tr(`error.${err instanceof ApiError ? err.code : 'internal'}`));
    }
  }

  async function revoke(row: DeviceRow) {
    try {
      await p.session.call(`/api/v1/devices/${row.id}`, { method: 'DELETE' });
      setAction({ kind: 'none' });
      if (row.id === current) {
        await p.session.forget();
        p.onSignedOut();
        return;
      }
      report(tr('devices.revoked', { name: row.name }));
      await load();
    } catch (err) {
      report(tr(`error.${err instanceof ApiError ? err.code : 'internal'}`));
    }
  }

  const active = rows?.filter((r) => !r.revokedAt) ?? [];
  const revoked = rows?.filter((r) => r.revokedAt) ?? [];

  return (
    <main className="page devices">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('devices.title')}</h1>
      </header>
      <p role="status" className="status">
        {status}
      </p>
      {!rows && <p>{tr('devices.loading')}</p>}
      <LinkOffer session={p.session} serverName={p.serverName} onLinked={() => void load()} />
      <ul className="device-list">
        {active.map((row) => {
          const isThis = row.id === current;
          return (
            <li key={row.id} className="device">
              <Heading level={2} className="device-name">
                {row.name}
                {isThis && <span className="device-this"> ({tr('devices.this')})</span>}
              </Heading>
              <p className="muted">
                {tr(`devices.via.${row.enrolledVia}`)}
                {row.lastSeenAt && <> · {tr('devices.lastSeen', { time: new Date(row.lastSeenAt) })}</>}
              </p>
              {action.kind === 'rename' && action.id === row.id ? (
                <Form className="stack" onSubmit={(e) => rename(e, row.id, action.value)}>
                  <TextField value={action.value} onChange={(value) => setAction({ ...action, value })} className="field" maxLength={60} autoFocus>
                    <Label>{tr('devices.name')}</Label>
                    <Input />
                  </TextField>
                  <div className="row">
                    <Button type="submit" className="button primary">
                      {tr('devices.rename.save')}
                    </Button>
                    <Button className="button" onPress={() => setAction({ kind: 'none' })}>
                      {tr('devices.cancel')}
                    </Button>
                  </div>
                </Form>
              ) : action.kind === 'revoke' && action.id === row.id ? (
                <div className="stack">
                  <p ref={questionRef} tabIndex={-1} role="alert">
                    {isThis ? tr('devices.signOut.confirm') : tr('devices.revoke.confirm', { name: row.name })}
                  </p>
                  <div className="row">
                    <Button className="button danger" onPress={() => void revoke(row)}>
                      {tr('devices.revoke.yes')}
                    </Button>
                    <Button className="button" onPress={() => setAction({ kind: 'none' })}>
                      {tr('devices.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="row">
                  <Button className="button" onPress={() => setAction({ kind: 'rename', id: row.id, value: row.name })}>
                    {tr('devices.rename')}
                  </Button>
                  <Button className="button" onPress={() => setAction({ kind: 'revoke', id: row.id })}>
                    {isThis ? tr('devices.signOut') : tr('devices.revoke')}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {revoked.length > 0 && (
        <section>
          <h2>{tr('devices.revokedList')}</h2>
          <ul className="device-list muted">
            {revoked.map((row) => (
              <li key={row.id}>
                {row.name} · {tr('devices.revokedAt', { time: new Date(row.revokedAt!) })}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
