/**
 * What a representative manages for the person (docs/plan-m4.md, G6): who may help them and what. Helpers waiting for a
 * yes, every helper's permissions (never more for oneself), ending a connection, inviting a new helper, and signing out
 * one of the person's devices. Nothing of the person's data is here. Every act is said on the person's devices as the
 * representative's and kept in their history.
 */
import { DEFAULT_HELPER_SCOPES, type Scope } from '@ucap/shared';
import { useEffect, useState } from 'react';
import { Button, Heading } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import type { Relationship } from '../people/api.ts';
import { scopeLabel } from '../people/summary.ts';
import { useUi } from '../ui.tsx';
import { ScopeChoice } from './Helpers.tsx';

interface DeviceRow {
  id: string;
  name: string;
  lastSeenAt: string | null;
}

export function RepresentedAccess(p: { session: Session; person: { id: string; displayName: string }; serverUrl: string; refresh: number; onClose: () => void }) {
  const { tr, say } = useUi();
  const name = p.person.displayName;
  const me = p.session.ref.userId;
  const [rels, setRels] = useState<Relationship[] | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [editing, setEditing] = useState<{ id: string; scopes: Scope[] } | null>(null);
  const [inviteScopes, setInviteScopes] = useState<Scope[]>(DEFAULT_HELPER_SCOPES);
  const [invitation, setInvitation] = useState<{ code: string; spoken: string | null } | null>(null);
  const [status, setStatus] = useState('');
  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  const fail = (e: unknown) => tell(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));

  const load = async () => {
    try {
      setRels((await p.session.call<{ relationships: Relationship[] }>(`/api/v1/people/${p.person.id}/relationships`)).relationships);
      setDevices((await p.session.call<{ devices: DeviceRow[] }>(`/api/v1/people/${p.person.id}/devices/signed-in`)).devices);
    } catch (e) {
      fail(e);
    }
  };
  useEffect(() => {
    void load();
  }, [p.person.id, p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what: () => Promise<unknown>, said: string) => {
    try {
      await what();
      setEditing(null);
      tell(said);
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const chosen = (r: Relationship) => (editing?.id === r.id ? editing.scopes : r.proposedScopes);

  return (
    <main className="page settings">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('rep.access.title', { name })}</h1>
      </header>
      <p>{tr('rep.access.intro', { name })}</p>
      <p role="status" className="status">
        {status}
      </p>

      {rels && (
        <section className="settings-section">
          <h2>{tr('people.helpers.title')}</h2>
          <ul className="device-list">
            {rels.map((r) => (
              <li key={r.id} className="device">
                <Heading level={3} className="device-name">
                  {r.helper.displayName}
                </Heading>
                {r.state === 'pending' ? (
                  <div className="stack">
                    <p className="muted">{tr('people.state.pending')}</p>
                    <ScopeChoice label={r.helper.displayName} value={chosen(r)} onChange={(scopes) => setEditing({ id: r.id, scopes })} />
                    <div className="row">
                      <Button
                        className="button primary"
                        onPress={() => void act(() => p.session.call(`/api/v1/relationships/${r.id}/approve`, { body: { scopes: chosen(r) } }), tr('rep.access.approved', { helper: r.helper.displayName, name }))}
                      >
                        {tr('rep.access.approve')}
                      </Button>
                      <Button className="button" onPress={() => void act(() => p.session.call(`/api/v1/relationships/${r.id}`, { method: 'DELETE' }), tr('rep.access.declined', { helper: r.helper.displayName }))}>
                        {tr('rep.access.decline')}
                      </Button>
                    </div>
                  </div>
                ) : editing?.id === r.id ? (
                  <div className="stack">
                    <ScopeChoice label={r.helper.displayName} value={editing.scopes} onChange={(scopes) => setEditing({ id: r.id, scopes })} />
                    <div className="row">
                      <Button
                        className="button primary"
                        onPress={() => void act(() => p.session.call(`/api/v1/relationships/${r.id}/grants`, { method: 'PUT', body: { scopes: editing.scopes } }), tr('rep.access.saved', { helper: r.helper.displayName }))}
                      >
                        {tr('people.scopes.save')}
                      </Button>
                      <Button className="button" onPress={() => setEditing(null)}>
                        {tr('devices.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="muted">{r.scopes.map((s) => scopeLabel(s, tr)).join(' · ')}</p>
                    {r.helper.id === me ? (
                      <p className="muted">{tr('rep.access.own', { name })}</p>
                    ) : (
                      <div className="row">
                        <Button className="button" onPress={() => setEditing({ id: r.id, scopes: r.scopes })}>
                          {tr('people.change')}
                        </Button>
                        <Button className="button" onPress={() => void act(() => p.session.call(`/api/v1/relationships/${r.id}`, { method: 'DELETE' }), tr('rep.access.ended', { helper: r.helper.displayName }))}>
                          {tr('people.end')}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="settings-section">
        <h2>{tr('rep.access.invite', { name })}</h2>
        <ScopeChoice label={tr('rep.access.inviteScopes')} value={inviteScopes} onChange={setInviteScopes} />
        <Button
          className="button"
          onPress={() =>
            void p.session.call<{ code: string; spoken: string | null }>(`/api/v1/people/${p.person.id}/invites`, { body: { proposedScopes: inviteScopes } }).then((inv) => {
              setInvitation(inv);
              tell(tr('rep.access.invited', { name }));
            }, fail)
          }
        >
          {tr('people.invite.create')}
        </Button>
        {invitation && (
          <div className="stack">
            <p>{tr('people.invite.link')}</p>
            <pre className="command">{`${p.serverUrl}/#invite=${invitation.code}`}</pre>
            {invitation.spoken && <p>{tr('people.invite.spokenCode', { digits: invitation.spoken.replace(/(\d{3})(?=\d)/g, '$1 ') })}</p>}
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>{tr('rep.access.devices', { name })}</h2>
        <ul className="device-list">
          {devices.map((dv) => (
            <li key={dv.id} className="device">
              <Heading level={3} className="device-name">
                {dv.name}
              </Heading>
              {dv.lastSeenAt && <p className="muted">{tr('person.device.seen', { time: new Date(dv.lastSeenAt) })}</p>}
              <Button className="button" onPress={() => void act(() => p.session.call(`/api/v1/people/${p.person.id}/devices/${dv.id}/revoke`, { method: 'POST' }), tr('rep.access.signedOut', { device: dv.name, name }))}>
                {tr('rep.access.signOut')}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
