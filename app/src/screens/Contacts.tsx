/**
 * Contacts of one person (docs/plan-m3.md, K6): the person's own, or those of someone a helper supports with
 * contacts.manage ("Kontakte verwalten"). The list (each name with its numbers, labels and addresses), adding,
 * changing (a new name included) and deleting, with undo right after each (CONCEPT §8: "reversible"). A helper sees the
 * saved contacts only, never anything drawn from conversations. This is the page for screen readers and keyboards.
 */
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button, Form, Heading, Input, Label, TextField } from 'react-aria-components';
import { type Contact, type ContactFields, type ContactHandle, contacts } from '../contacts/api.ts';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

type Tr = ReturnType<typeof useUi>['tr'];

/** What went wrong, in the person's words: a number taken by another contact names that contact. */
function errorText(tr: Tr, e: unknown): string {
  if (!(e instanceof ApiError)) return tr('error.internal');
  const reason = e.params.reason;
  if (e.code === 'conflict' && reason === 'taken') return tr('contacts.error.taken', { value: String(e.params.value ?? ''), name: String(e.params.name ?? '') });
  if (e.code === 'conflict' && reason === 'stale') return tr('error.conflict');
  if (e.code === 'bad_request' && (reason === 'phone' || reason === 'email' || reason === 'name')) return tr(`contacts.error.${reason}`, { value: String(e.params.value ?? '') });
  return tr(`error.${e.code}`);
}

function Field(p: { label: string; value: string; onChange: (v: string) => void; type?: string; autoFocus?: boolean }) {
  return (
    <TextField value={p.value} onChange={p.onChange} className="field" autoComplete="off" autoFocus={p.autoFocus}>
      <Label>{p.label}</Label>
      <Input type={p.type ?? 'text'} />
    </TextField>
  );
}

function Editor(p: { initial: Contact | null; onSave: (f: ContactFields) => Promise<string | null>; onCancel: () => void }) {
  const { tr } = useUi();
  const [name, setName] = useState(p.initial?.name ?? '');
  const [phones, setPhones] = useState(() => {
    const own = (p.initial?.handles ?? []).filter((h) => h.kind === 'phone').map((h) => ({ value: h.display, label: h.label ?? '' }));
    return own.length ? own : [{ value: '', label: '' }];
  });
  const [emails, setEmails] = useState(() => {
    const own = (p.initial?.handles ?? []).filter((h) => h.kind === 'email').map((h) => h.value);
    return own.length ? own : [''];
  });
  /** Telegram's and WhatsApp's come from the services: kept as they are. */
  const kept = (p.initial?.handles ?? []).filter((h) => h.kind === 'telegram' || h.kind === 'whatsapp');
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const handles: ContactFields['handles'] = [
      ...phones.filter((x) => x.value.trim()).map((x) => ({ kind: 'phone' as const, value: x.value, label: x.label.trim() || null })),
      ...emails.filter((x) => x.trim()).map((x) => ({ kind: 'email' as const, value: x })),
      ...kept.map((h) => ({ kind: h.kind, value: h.value, label: h.label })),
    ];
    // Kept open with what went wrong, so nothing typed is lost.
    setError((await p.onSave({ name, handles })) ?? '');
  }

  return (
    <Form onSubmit={(e) => void submit(e)} className="stack">
      <Field label={tr('contacts.field.name')} value={name} onChange={setName} autoFocus />
      {phones.map((x, i) => (
        <div key={`phone-${i}`} className="stack">
          <Field
            label={phones.length > 1 ? tr('contacts.field.phone.n', { n: i + 1 }) : tr('contacts.field.phone')}
            type="tel"
            value={x.value}
            onChange={(v) => setPhones(phones.map((y, j) => (j === i ? { ...y, value: v } : y)))}
          />
          <Field label={tr('contacts.field.label')} value={x.label} onChange={(v) => setPhones(phones.map((y, j) => (j === i ? { ...y, label: v } : y)))} />
        </div>
      ))}
      <Button className="button" onPress={() => setPhones([...phones, { value: '', label: '' }])}>
        {tr('contacts.more.phone')}
      </Button>
      {emails.map((x, i) => (
        <Field
          key={`email-${i}`}
          label={emails.length > 1 ? tr('contacts.field.email.n', { n: i + 1 }) : tr('contacts.field.email')}
          type="email"
          value={x}
          onChange={(v) => setEmails(emails.map((y, j) => (j === i ? v : y)))}
        />
      ))}
      <Button className="button" onPress={() => setEmails([...emails, ''])}>
        {tr('contacts.more.email')}
      </Button>
      {error && (
        <p ref={errorRef} tabIndex={-1} role="alert" className="status warning">
          {error}
        </p>
      )}
      <div className="row">
        <Button type="submit" className="button primary" isDisabled={!name.trim()}>
          {tr('contacts.save')}
        </Button>
        <Button className="button" onPress={p.onCancel}>
          {tr('contacts.cancel')}
        </Button>
      </div>
    </Form>
  );
}

/** One handle as it is said and shown: "Telefon (Praxis): +49 30 1234567". */
function handleText(tr: Tr, h: ContactHandle): string {
  const kind = tr(`contacts.kind.${h.kind}`);
  return `${h.label ? `${kind} (${h.label})` : kind}: ${h.display}`;
}

export function ContactsPage(p: { session: Session; personId: string; personName: string | null; refresh: number; onClose: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const api = contacts(p.session, p.personId);
  const [list, setList] = useState<Contact[] | null>(null);
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Contact | null>(null);
  const [status, setStatus] = useState('');
  /** The contact the last change on this page was made to: "Rückgängig" puts it back. */
  const [last, setLast] = useState<string | null>(null);
  const own = p.personId === p.session.ref.userId;

  const load = async () => {
    try {
      setList((await api.list()).contacts);
    } catch (e) {
      setStatus(errorText(tr, e));
    }
  };
  useEffect(() => {
    void load();
  }, [p.personId, p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  async function save(f: ContactFields): Promise<string | null> {
    const e = editing;
    try {
      const c = e === 'new' || !e ? await api.create(f) : await api.update(e.id, e.version, f);
      setEditing(null);
      setLast(c.id);
      tell(tr('contacts.saved', { name: c.name }));
      await load();
      return null;
    } catch (err) {
      const text = errorText(tr, err);
      say(text, 'system');
      return text;
    }
  }

  async function remove(c: Contact) {
    setDeleting(null);
    try {
      await api.remove(c.id);
      setLast(c.id);
      tell(tr('contacts.deleted', { name: c.name }));
    } catch (e) {
      tell(errorText(tr, e));
    }
    await load();
  }

  async function undo() {
    if (!last) return;
    try {
      await api.undo(last);
      setLast(null);
      tell(tr('contacts.undone'));
    } catch (e) {
      tell(errorText(tr, e));
    }
    await load();
  }

  return (
    <main className="page contacts">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{own ? tr('contacts.page.own') : tr('contacts.page.of', { name: p.personName ?? '' })}</h1>
      </header>
      <p role="status" className="status">
        {status}
      </p>
      {last && !editing && (
        <Button className="button" onPress={() => void undo()}>
          {tr('contacts.undo')}
        </Button>
      )}
      {editing ? (
        <section className="settings-section">
          <h2>{editing === 'new' ? tr('contacts.new') : tr('contacts.edit', { name: editing.name })}</h2>
          <Editor initial={editing === 'new' ? null : editing} onSave={save} onCancel={() => setEditing(null)} />
        </section>
      ) : (
        <section className="settings-section">
          {list && list.length === 0 && <p>{tr('contacts.none')}</p>}
          <ul className="device-list">
            {(list ?? []).map((c) => (
              <li key={c.id} className="device">
                <Heading level={2} className="device-name">
                  {c.name}
                </Heading>
                {c.handles.length > 0 && (
                  <ul>
                    {c.handles.map((h) => (
                      <li key={`${h.kind}:${h.value}`}>{handleText(tr, h)}</li>
                    ))}
                  </ul>
                )}
                <p className="muted">{tr('contacts.changedBy', { name: c.updatedBy.displayName })}</p>
                {deleting?.id === c.id ? (
                  <div className="stack">
                    <p role="alert">{tr('contacts.delete.confirm', { name: c.name })}</p>
                    <div className="row">
                      <Button className="button danger" onPress={() => void remove(c)}>
                        {tr('contacts.delete.yes')}
                      </Button>
                      <Button className="button" onPress={() => setDeleting(null)}>
                        {tr('contacts.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="row">
                    <Button className="button" onPress={() => setEditing(c)}>
                      {tr('contacts.change')}
                    </Button>
                    <Button className="button" onPress={() => setDeleting(c)}>
                      {tr('contacts.delete')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Button className="button primary" onPress={() => setEditing('new')}>
            {tr('contacts.add')}
          </Button>
        </section>
      )}
    </main>
  );
}
