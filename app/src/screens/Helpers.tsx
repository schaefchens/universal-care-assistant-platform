/**
 * Helpers and the people one helps (docs/plan.md, S3), on one page that works with touch, keyboard and screen
 * readers:
 * - as a person: invite a helper (a code to read out, a link to pass on), approve who accepted, change what each
 *   helper may do, end a connection, hear who may do what;
 * - as a helper: accept an invitation, see the people one helps and what one may do for them, end a connection;
 * - the history of changes to this account (the audit log, without content).
 */
import { DEFAULT_HELPER_SCOPES, hasMessage, M1_SCOPES, type Scope } from '@ucap/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, CheckboxGroup, Form, Heading, Input, Label, TextField } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { PhoneFallbackSetting } from '../care/PhoneFallbackSetting.tsx';
import { UnconfirmedSetting } from '../care/UnconfirmedSetting.tsx';
import { ApiError } from '../net/api.ts';
import { type AuditEvent, type Invitation, type InvitePreview, people, previewInvite, type Relationship } from '../people/api.ts';
import { overviewSummary, scopeLabel } from '../people/summary.ts';
import type { ServerRef } from '../state/store.ts';
import { useUi } from '../ui.tsx';

/** Digits for a voice: "3 2 6, 5 1 3, 2 2 0 7". */
const spokenDigits = (code: string) => [code.slice(0, 3), code.slice(3, 6), code.slice(6)].map((g) => g.split('').join(' ')).join(', ');
const grouped = (code: string) => `${code.slice(0, 3)} ${code.slice(3, 6)} ${code.slice(6)}`;

function ScopeChoice(p: { label: string; value: Scope[]; onChange: (s: Scope[]) => void }) {
  const { tr } = useUi();
  return (
    <CheckboxGroup className="choice" value={p.value} onChange={(v) => p.onChange(v as Scope[])}>
      <Label className="choice-label">{p.label}</Label>
      {M1_SCOPES.map((s) => (
        <Checkbox key={s} value={s} className="choice-option checkbox">
          {scopeLabel(s, tr)}
        </Checkbox>
      ))}
    </CheckboxGroup>
  );
}

function Confirm(p: { question: string; yes: string; onYes: () => void; onNo: () => void }) {
  const { tr } = useUi();
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="stack">
      <p ref={ref} tabIndex={-1} role="alert">
        {p.question}
      </p>
      <div className="row">
        <Button className="button danger" onPress={p.onYes}>
          {p.yes}
        </Button>
        <Button className="button" onPress={p.onNo}>
          {tr('devices.cancel')}
        </Button>
      </div>
    </div>
  );
}

export function Helpers(p: {
  session: Session;
  server: ServerRef;
  onApprove: (relationshipId: string) => void;
  onClose: () => void;
  refresh: number;
  /** The reminders of someone this helper supports, as far as their scopes reach. */
  onReminders?: (person: { id: string; displayName: string }, canManage: boolean, canRead: boolean) => void;
  /** Setting up the person's device (device.configure, S11). */
  onConfigure?: (person: { id: string; displayName: string }) => void;
}) {
  const ui = useUi();
  const { tr, say } = ui;
  const api = people(p.session);
  const [rels, setRels] = useState<{ asPerson: Relationship[]; asHelper: Relationship[] } | null>(null);
  const [history, setHistory] = useState<AuditEvent[]>([]);
  const [open, setOpen] = useState<{ id: string; proposedScopes: Scope[]; createdAt: string }[]>([]);
  const [reach, setReach] = useState<boolean | null>(null);
  const [status, setStatus] = useState('');
  const [inviteScopes, setInviteScopes] = useState<Scope[]>(DEFAULT_HELPER_SCOPES);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [editing, setEditing] = useState<{ id: string; scopes: Scope[] } | null>(null);
  const [ending, setEnding] = useState<Relationship | null>(null);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<InvitePreview | null>(null);

  const report = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  const fail = (e: unknown) => report(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));

  const load = async () => {
    try {
      setRels(await api.relationships());
      setHistory((await api.audit()).events);
      setOpen((await api.openInvites()).invites.filter((i) => i.kind === 'helper'));
      setReach((await p.session.call<{ reachable: boolean | null }>('/api/v1/care/readiness')).reachable);
    } catch (e) {
      fail(e);
    }
  };
  useEffect(() => {
    void load();
  }, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const mine = rels?.asPerson ?? [];
  const helping = rels?.asHelper ?? [];

  function readOverview() {
    const active = mine.filter((r) => r.state === 'active');
    say(overviewSummary({ helpers: active.map((r) => ({ name: r.helper.displayName, scopes: r.scopes })), pending: mine.filter((r) => r.state === 'pending').map((r) => r.helper.displayName), lang: ui.lang, tr }), 'system');
  }

  async function createInvitation() {
    try {
      const inv = await api.inviteHelper(inviteScopes);
      setInvitation(inv);
      void load();
      if (inv.spoken) say(tr('people.invite.spokenCode', { digits: spokenDigits(inv.spoken) }), 'system');
    } catch (e) {
      fail(e);
    }
  }

  async function check(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await previewInvite(p.server.url, code.trim());
      if (r.kind !== 'helper') return report(tr('people.accept.notHelper'));
      setPreview(r);
      say(`${tr('people.accept.from', { name: r.from?.displayName ?? '' })} ${tr('people.accept.proposed', { list: new Intl.ListFormat(ui.lang).format(r.proposedScopes.map((s) => scopeLabel(s, tr))) })}`, 'system');
    } catch (err) {
      fail(err);
    }
  }

  async function accept() {
    try {
      await api.accept(code.trim());
      report(tr('people.accept.waiting', { name: preview?.from?.displayName ?? '' }));
      setPreview(null);
      setCode('');
      await load();
    } catch (e) {
      fail(e);
    }
  }

  async function saveScopes() {
    if (!editing) return;
    try {
      await api.setScopes(editing.id, editing.scopes);
      setEditing(null);
      report(tr('people.scopes.saved'));
      await load();
    } catch (e) {
      fail(e);
    }
  }

  async function end(r: Relationship) {
    try {
      await api.end(r.id);
      setEnding(null);
      report(tr('people.ended'));
      await load();
    } catch (e) {
      fail(e);
    }
  }

  const link = invitation ? `${p.server.url}/#invite=${invitation.code}` : '';
  /** One sentence per entry; one's own actions have their own sentence ("Du hast …", not "Du hat …"). */
  const historyText = (e: AuditEvent) => {
    const key = `audit.${e.action}`;
    if (e.actor?.self && hasMessage(ui.lang, `${key}.self`)) return tr(`${key}.self`);
    return hasMessage(ui.lang, key) ? tr(key, { actor: e.actor?.displayName ?? '' }) : e.action;
  };

  return (
    <main className="page helpers">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('settings.people')}</h1>
      </header>
      <p role="status" className="status">
        {status}
      </p>

      <section className="settings-section">
        <h2>{tr('people.helpers.title')}</h2>
        {rels && mine.length === 0 && <p>{tr('people.helpers.none')}</p>}
        <ul className="device-list">
          {mine.map((r) => (
            <li key={r.id} className="device">
              <Heading level={3} className="device-name">
                {r.helper.displayName}
              </Heading>
              {r.state === 'pending' ? (
                <>
                  <p className="muted">{tr('people.state.pending')}</p>
                  <Button className="button primary" onPress={() => p.onApprove(r.id)}>
                    {tr('people.check')}
                  </Button>
                </>
              ) : editing?.id === r.id ? (
                <div className="stack">
                  <ScopeChoice label={r.helper.displayName} value={editing.scopes} onChange={(scopes) => setEditing({ id: r.id, scopes })} />
                  <div className="row">
                    <Button className="button primary" onPress={() => void saveScopes()}>
                      {tr('people.scopes.save')}
                    </Button>
                    <Button className="button" onPress={() => setEditing(null)}>
                      {tr('devices.cancel')}
                    </Button>
                  </div>
                </div>
              ) : ending?.id === r.id ? (
                <Confirm question={tr('people.end.confirm.person', { name: r.helper.displayName })} yes={tr('people.end.yes')} onYes={() => void end(r)} onNo={() => setEnding(null)} />
              ) : (
                <>
                  <p className="muted">{r.scopes.map((s) => scopeLabel(s, tr)).join(' · ')}</p>
                  <div className="row">
                    <Button className="button" onPress={() => setEditing({ id: r.id, scopes: r.scopes })}>
                      {tr('people.change')}
                    </Button>
                    <Button className="button" onPress={() => setEnding(r)}>
                      {tr('people.end')}
                    </Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
        {reach !== null && <p className={reach ? 'status' : 'status warning'}>{tr(reach ? 'care.readiness.person.ok' : 'care.readiness.person.none')}</p>}
        <Button className="button" onPress={readOverview}>
          {tr('people.overview.read')}
        </Button>
      </section>

      <PhoneFallbackSetting session={p.session} />
      <UnconfirmedSetting session={p.session} />

      <section className="settings-section">
        <h2>{tr('people.invite')}</h2>
        {invitation ? (
          <div className="stack">
            <p>{tr('people.invite.code')}</p>
            {invitation.spoken && <p className="invite-code">{grouped(invitation.spoken)}</p>}
            <p className="muted">{tr('people.invite.validity')}</p>
            <div className="row">
              {invitation.spoken && (
                <Button className="button" onPress={() => say(tr('people.invite.spokenCode', { digits: spokenDigits(invitation.spoken!) }), 'system')}>
                  {tr('people.invite.readCode')}
                </Button>
              )}
              {typeof navigator.share === 'function' && (
                <Button className="button" onPress={() => void navigator.share({ url: link }).catch(() => {})}>
                  {tr('people.invite.share')}
                </Button>
              )}
              <Button className="button" onPress={() => setInvitation(null)}>
                {tr('people.invite.done')}
              </Button>
            </div>
            <p className="muted invite-link">
              {tr('people.invite.link')}: {link}
            </p>
          </div>
        ) : (
          <div className="stack">
            <ScopeChoice label={tr('people.invite.scopes')} value={inviteScopes} onChange={setInviteScopes} />
            <Button className="button primary" isDisabled={inviteScopes.length === 0} onPress={() => void createInvitation()}>
              {tr('people.invite.create')}
            </Button>
          </div>
        )}
        {open.length > 0 && (
          <>
            <h3>{tr('people.invites.open')}</h3>
            <ul className="device-list">
              {open.map((i) => (
                <li key={i.id} className="device">
                  <p className="muted">
                    {new Intl.DateTimeFormat(ui.lang, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(i.createdAt))} · {i.proposedScopes.map((s) => scopeLabel(s, tr)).join(' · ')}
                  </p>
                  <Button
                    className="button"
                    onPress={() =>
                      void api.revokeInvite(i.id).then(
                        () => {
                          report(tr('people.invite.revoked'));
                          void load();
                        },
                        fail,
                      )
                    }
                  >
                    {tr('people.invite.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="settings-section">
        <h2>{tr('people.helping.title')}</h2>
        {rels && helping.length === 0 && <p>{tr('people.helping.none')}</p>}
        <ul className="device-list">
          {helping.map((r) => (
            <li key={r.id} className="device">
              <Heading level={3} className="device-name">
                {r.person.displayName}
              </Heading>
              <p className="muted">{r.state === 'pending' ? tr('people.state.pending') : r.scopes.map((s) => scopeLabel(s, tr)).join(' · ')}</p>
              {ending?.id === r.id ? (
                <Confirm question={tr('people.end.confirm.helper', { name: r.person.displayName })} yes={tr('people.end.yes')} onYes={() => void end(r)} onNo={() => setEnding(null)} />
              ) : (
                <div className="row">
                  {r.state === 'active' && r.scopes.includes('device.configure') && (
                    <Button className="button" onPress={() => p.onConfigure?.(r.person)}>
                      {tr('config.editor.open')}
                    </Button>
                  )}
                  {r.state === 'active' && (r.scopes.includes('reminders.manage') || r.scopes.includes('reminders.responses.read')) && (
                    <Button className="button" onPress={() => p.onReminders?.(r.person, r.scopes.includes('reminders.manage'), r.scopes.includes('reminders.responses.read'))}>
                      {tr('reminder.page.of', { name: r.person.displayName })}
                    </Button>
                  )}
                  <Button className="button" onPress={() => setEnding(r)}>
                    {tr('people.end')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <h3>{tr('people.accept')}</h3>
        {preview ? (
          <div className="stack">
            <p>{tr('people.accept.from', { name: preview.from?.displayName ?? '' })}</p>
            <p>{tr('people.accept.proposed', { list: new Intl.ListFormat(ui.lang).format(preview.proposedScopes.map((s) => scopeLabel(s, tr))) })}</p>
            <div className="row">
              <Button className="button primary" onPress={() => void accept()}>
                {tr('people.accept.yes')}
              </Button>
              <Button className="button" onPress={() => setPreview(null)}>
                {tr('devices.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <Form className="stack" onSubmit={check}>
            <TextField value={code} onChange={setCode} className="field" autoComplete="off">
              <Label>{tr('people.accept.code')}</Label>
              <Input inputMode="text" autoCorrect="off" spellCheck={false} />
            </TextField>
            <Button type="submit" className="button" isDisabled={code.trim().length < 10}>
              {tr('people.accept.check')}
            </Button>
          </Form>
        )}
      </section>

      <section className="settings-section">
        <h2>{tr('people.history')}</h2>
        <ul className="history">
          {history.map((e, i) => (
            <li key={i}>
              <span className="muted">{new Intl.DateTimeFormat(ui.lang, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(e.at))}</span>{' '}
              {historyText(e)}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
