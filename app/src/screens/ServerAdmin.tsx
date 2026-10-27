/**
 * The server and its accounts, for administrators (docs/plan.md, S12): whether what help depends on runs (the
 * database, notifications to devices, the helpers' devices that can be reached), what the assistant depends on (the
 * language model, speech recognition, the connectors process), the jobs and the storage; the accounts by name and
 * devices; and invitations for new accounts, shown once. Nothing here shows what anyone said or wrote (CONCEPT §7).
 */
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Checkbox, Form, Heading, Input, Label, Radio, RadioGroup, TextField } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

interface CoreStatus {
  db: boolean;
  dispatcher: boolean;
  realtimeConnections: number;
  accounts: number;
  devices: number;
  helperDevicesReady: { ready: number; total: number };
  jobs: { due: number; dead: number };
  files: { count: number; bytes: number };
  disk: { freeBytes: number; totalBytes: number } | null;
  migrations: number;
}
interface AssistantStatus {
  /** Each service's connectors process (docs/plan-m3.md), and the connections by service and state (no names). */
  messaging: { running: Record<'telegram' | 'whatsapp' | 'email', boolean>; configured: boolean; whatsappAllowed: boolean; connections: Partial<Record<string, Record<string, number>>> };
  engines: { ollama: boolean | null; stt: boolean | null };
  herdeWorkers: number;
}
interface Account {
  id: string;
  name: string;
  admin: boolean;
  createdAt: string;
  recoveryState: string;
  devices: number;
  lastSeenAt: string | null;
  /** New words waiting to take effect (G5): their kind and until when, nothing more. */
  waiting: { kind: string; until: string } | null;
  /** Who represents the account (G6), by name. */
  representative: string | null;
}

const size = (bytes: number, lang: string) => new Intl.NumberFormat(lang, { style: 'unit', unit: bytes > 1e9 ? 'gigabyte' : 'megabyte', maximumFractionDigits: 1 }).format(bytes > 1e9 ? bytes / 1e9 : bytes / 1e6);

export function ServerAdmin(p: { session: Session; serverUrl: string; onClose: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [core, setCore] = useState<CoreStatus | null>(null);
  const [assistant, setAssistant] = useState<AssistantStatus | null | 'down'>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [label, setLabel] = useState('');
  const [asAdmin, setAsAdmin] = useState(false);
  const [forSomeone, setForSomeone] = useState(false);
  const [invite, setInvite] = useState<{ code: string; spoken: string | null; expiresAt: string } | null>(null);
  // The operator's reset (G5): for whom, why, and the code made.
  const [resetFor, setResetFor] = useState<Account | null>(null);
  const [reason, setReason] = useState('');
  const [reset, setReset] = useState<{ name: string; link: string; spoken: string } | null>(null);
  // A representative named by this administrator (G6): for whom, who, and why.
  const [repFor, setRepFor] = useState<Account | null>(null);
  const [repWho, setRepWho] = useState<string | null>(null);
  const [repReason, setRepReason] = useState('');
  const [status, setStatus] = useState('');

  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  async function load() {
    try {
      setCore(await p.session.call<CoreStatus>('/api/v1/admin/status'));
      setAccounts((await p.session.call<{ accounts: Account[] }>('/api/v1/admin/accounts')).accounts);
    } catch (e) {
      tell(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
    // The assistant is optional: the page says so when it does not answer.
    setAssistant(await p.session.call<AssistantStatus>('/api/v1/ai-admin/status').catch(() => 'down' as const));
  }
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function makeInvite(e: FormEvent) {
    e.preventDefault();
    try {
      // For someone this administrator sets the account up for and helps: they become the helper once the person agrees.
      const r = forSomeone
        ? await p.session.call<{ code: string; spoken: string | null; expiresAt: string }>('/api/v1/invites', { method: 'POST', body: { kind: 'supported_person', proposedScopes: ['care.respond', 'device.configure'], label: label.trim() || undefined } })
        : await p.session.call<{ code: string; spoken: string | null; expiresAt: string }>('/api/v1/admin/account-invites', { method: 'POST', body: { label: label.trim() || undefined, admin: asAdmin, spoken: true } });
      setInvite(r);
      setLabel('');
      setAsAdmin(false);
      setForSomeone(false);
      tell(tr('admin.accounts.invited'));
    } catch (err) {
      tell(tr(`error.${err instanceof ApiError ? err.code : 'internal'}`));
    }
  }

  async function makeReset(e: FormEvent) {
    e.preventDefault();
    if (!resetFor) return;
    try {
      const r = await p.session.call<{ code: string; spoken: string }>(`/api/v1/admin/accounts/${resetFor.id}/reset`, { method: 'POST', body: { reason: reason.trim() } });
      const made = { name: resetFor.name, link: `${p.serverUrl}/#reset=${r.code}`, spoken: r.spoken.replace(/(\d{3})(?=\d)/g, '$1 ') };
      setReset(made);
      setResetFor(null);
      setReason('');
      tell(tr('admin.reset.made', made));
      await load();
    } catch (err) {
      tell(tr(`error.${err instanceof ApiError ? err.code : 'internal'}`));
    }
  }

  async function makeRepresentative(e: FormEvent) {
    e.preventDefault();
    const who = accounts.find((x) => x.id === repWho);
    if (!repFor || !who) return;
    try {
      await p.session.call(`/api/v1/admin/accounts/${repFor.id}/representative`, { method: 'POST', body: { representativeId: who.id, reason: repReason.trim() } });
      tell(tr('admin.rep.made', { rep: who.name, name: repFor.name }));
      setRepFor(null);
      setRepWho(null);
      setRepReason('');
      await load();
    } catch (err) {
      tell(tr(`error.${err instanceof ApiError ? err.code : 'internal'}`));
    }
  }

  const yes = (b: boolean | null) => tr(b === null ? 'admin.server.notSet' : b ? 'admin.server.ok' : 'admin.server.down');
  const lines = core
    ? [
        tr('admin.server.line.db', { state: yes(core.db) }),
        tr('admin.server.line.dispatcher', { state: yes(core.dispatcher), count: core.realtimeConnections }),
        tr('admin.server.line.helpers', { ready: core.helperDevicesReady.ready, total: core.helperDevicesReady.total }),
        tr('admin.server.line.accounts', { accounts: core.accounts, devices: core.devices }),
        tr('admin.server.line.jobs', { due: core.jobs.due, dead: core.jobs.dead }),
        tr('admin.server.line.files', { count: core.files.count, size: size(core.files.bytes, ui.lang) }),
        ...(core.disk ? [tr('admin.server.line.disk', { free: size(core.disk.freeBytes, ui.lang), total: size(core.disk.totalBytes, ui.lang) })] : []),
        ...(assistant === 'down'
          ? [tr('admin.server.line.assistantDown')]
          : assistant
            ? [
                tr('admin.server.line.engines', { llm: yes(assistant.engines.ollama), stt: yes(assistant.engines.stt) }),
                tr('admin.server.line.connectors', {
                  // Telegram always; another service once its process runs or someone connected it.
                  services: (['telegram', 'whatsapp', 'email'] as const)
                    .filter((s) => s === 'telegram' || assistant.messaging.running[s] || assistant.messaging.connections[s])
                    .map((s) => `${s === 'email' ? tr('messaging.service.email') : s === 'whatsapp' ? 'WhatsApp' : 'Telegram'}: ${yes(assistant.messaging.running[s])}`)
                    .join('; '),
                  configured: tr(assistant.messaging.configured ? 'admin.server.ok' : 'admin.server.notSet'),
                }),
                tr('admin.server.line.herde', { count: assistant.herdeWorkers }),
              ]
            : []),
      ]
    : [];
  const link = invite ? `${p.serverUrl}/#invite=${invite.code}` : '';

  return (
    <main className="page settings server-admin">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('admin.server.title')}</h1>
      </header>
      <p role="status" className="status">
        {status}
      </p>

      <section className="settings-section">
        <h2>{tr('admin.server.status')}</h2>
        <ul>
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <Button className="button" onPress={() => void load().then(() => say(lines.join(' '), 'system'))}>
          {tr('admin.server.refresh')}
        </Button>
      </section>

      <section className="settings-section">
        <h2>{tr('admin.accounts.title')}</h2>
        <ul className="device-list">
          {accounts.map((a) => (
            <li key={a.id} className="device">
              <Heading level={3} className="device-name">
                {a.name}
              </Heading>
              <p className="muted">
                {tr('admin.accounts.row', { devices: a.devices, created: new Date(a.createdAt) })}
                {a.admin ? ` · ${tr('admin.accounts.admin')}` : ''}
                {a.lastSeenAt ? ` · ${tr('admin.accounts.lastSeen', { time: new Date(a.lastSeenAt) })}` : ''}
              </p>
              {a.waiting && <p className="status warning">{tr('admin.accounts.waiting', { time: new Date(a.waiting.until) })}</p>}
              {/* Never one's own account: an administrator who lost their words asks another. */}
              {a.id !== p.session.ref.userId && (
                <Button className="button" onPress={() => setResetFor(a)}>
                  {tr('admin.reset.open')}
                </Button>
              )}
              {a.representative && <p className="muted">{tr('admin.rep.current', { rep: a.representative })}</p>}
              <Button className="button" onPress={() => setRepFor(a)}>
                {tr('admin.rep.open')}
              </Button>
              {repFor?.id === a.id && (
                <Form className="stack" onSubmit={makeRepresentative}>
                  {/* Never the administrator themselves, never the person. */}
                  <RadioGroup className="choice" value={repWho} onChange={setRepWho} isRequired>
                    <Label className="choice-label">{tr('admin.rep.who', { name: a.name })}</Label>
                    {accounts
                      .filter((x) => x.id !== a.id && x.id !== p.session.ref.userId)
                      .map((x) => (
                        <Radio key={x.id} value={x.id} className="choice-option">
                          {x.name}
                        </Radio>
                      ))}
                  </RadioGroup>
                  <TextField className="field" value={repReason} onChange={setRepReason} isRequired minLength={3}>
                    <Label>{tr('admin.rep.reason')}</Label>
                    <Input maxLength={300} />
                  </TextField>
                  <Button type="submit" className="button primary">
                    {tr('admin.rep.make')}
                  </Button>
                </Form>
              )}
              {resetFor?.id === a.id && (
                <Form className="stack" onSubmit={makeReset}>
                  <TextField className="field" value={reason} onChange={setReason} isRequired minLength={3}>
                    <Label>{tr('admin.reset.reason')}</Label>
                    <Input maxLength={300} />
                  </TextField>
                  <Button type="submit" className="button primary">
                    {tr('admin.reset.make')}
                  </Button>
                </Form>
              )}
            </li>
          ))}
        </ul>
        <Form className="stack" onSubmit={makeInvite}>
          <TextField className="field" value={label} onChange={setLabel}>
            <Label>{tr('admin.accounts.label')}</Label>
            <Input maxLength={60} />
          </TextField>
          <Checkbox className="choice-option checkbox" isSelected={forSomeone} onChange={setForSomeone}>
            {tr('admin.accounts.forSomeone')}
          </Checkbox>
          {!forSomeone && (
            <Checkbox className="choice-option checkbox" isSelected={asAdmin} onChange={setAsAdmin}>
              {tr('admin.accounts.asAdmin')}
            </Checkbox>
          )}
          <Button type="submit" className="button primary">
            {tr('admin.accounts.invite')}
          </Button>
        </Form>
        {reset && (
          <div className="stack" role="status">
            <p>{tr('admin.reset.made', reset)}</p>
            <pre className="command">{reset.link}</pre>
          </div>
        )}
        {invite && (
          <div className="stack">
            <p>{tr('admin.accounts.inviteLink')}</p>
            <pre className="command">{link}</pre>
            {invite.spoken && <p>{tr('admin.accounts.inviteSpoken', { code: invite.spoken.replace(/(\d{3})(?=\d)/g, '$1 ') })}</p>}
          </div>
        )}
      </section>
    </main>
  );
}
