/**
 * An email account's senders (the owner, 2026-10-27: "the user might have different aliases and therefore its importan
 * to reply with the correct email and name. we need to configure identities like email apps have"): a name and an
 * address each, the first the default. A reply goes out as the one the mail came to, a new mail as the default. The
 * person's own, on their own device; another address must be set up at the provider (UCAP cannot check it before a
 * mail is sent: the mail server refuses one it does not allow, and the person is told).
 */
import { type FormEvent, useState } from 'react';
import { Button, Form, Input, Label, Text, TextField } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

export interface Sender {
  name: string;
  address: string;
}

const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
const MAX = 10;

export function EmailSenders(p: { session: Session; connectionId: string; senders: Sender[]; onChanged: (senders: Sender[]) => void }) {
  const { tr, say } = useUi();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  /** The sender being changed, by its place; null while adding one. */
  const [editing, setEditing] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const list = p.senders;
  const shown = (x: Sender) => (x.name ? `${x.name} <${x.address}>` : `${x.address} (${tr('email.senders.noName')})`);

  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  async function put(next: Sender[], done: string) {
    try {
      const r = await p.session.call<{ connection: { identities?: Sender[] } }>(`/api/v1/messaging/connections/${p.connectionId}/identities`, { method: 'PUT', body: { identities: next } });
      p.onChanged(r.connection.identities ?? next);
      setEditing(null);
      setName('');
      setAddress('');
      tell(done);
    } catch (e) {
      const reason = e instanceof ApiError ? String(e.params.reason ?? '') : '';
      tell(reason === 'address' ? tr('email.senders.invalid') : tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const a = address.trim().toLowerCase();
    if (!ADDRESS.test(a)) return tell(tr('email.senders.invalid'));
    const x = { name: name.trim(), address: a };
    if (editing !== null) return void put(list.map((y, i) => (i === editing ? x : y)), tr('email.senders.saved', { sender: shown(x) }));
    if (list.some((y) => y.address === a)) return tell(tr('email.senders.exists', { address: a }));
    if (list.length >= MAX) return tell(tr('email.senders.max'));
    void put([...list, x], tr('email.senders.added', { sender: shown(x) }));
  }

  function edit(i: number) {
    setEditing(i);
    setName(list[i]!.name);
    setAddress(list[i]!.address);
    say(tr('email.senders.editing', { sender: shown(list[i]!) }), 'system');
  }

  return (
    <section className="settings-section">
      <h2>{tr('email.senders.title')}</h2>
      <p className="muted">{tr('email.senders.intro')}</p>
      <ul className="stack">
        {list.map((x, i) => (
          <li key={x.address} className="stack">
            <span>
              {shown(x)}
              {i === 0 ? ` · ${tr('email.senders.default')}` : ''}
            </span>
            <div className="row">
              <Button className="button" aria-label={tr('email.senders.edit.label', { address: x.address })} onPress={() => edit(i)}>
                {tr('email.senders.edit')}
              </Button>
              {i > 0 && (
                <Button
                  className="button"
                  aria-label={tr('email.senders.makeDefault.label', { address: x.address })}
                  onPress={() => void put([x, ...list.filter((_, j) => j !== i)], tr('email.senders.defaulted', { address: x.address }))}
                >
                  {tr('email.senders.makeDefault')}
                </Button>
              )}
              {list.length > 1 && (
                <Button
                  className="button"
                  aria-label={tr('email.senders.remove.label', { address: x.address })}
                  onPress={() => void put(list.filter((_, j) => j !== i), tr('email.senders.removed', { address: x.address }))}
                >
                  {tr('email.senders.remove')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Form className="stack" onSubmit={save} aria-label={tr(editing !== null ? 'email.senders.change' : 'email.senders.add')}>
        <TextField value={name} onChange={setName} className="field" autoComplete="name" maxLength={100}>
          <Label>{tr('email.senders.name')}</Label>
          <Input />
          <Text slot="description">{tr('email.senders.name.hint')}</Text>
        </TextField>
        <TextField value={address} onChange={setAddress} className="field" autoComplete="email" maxLength={254}>
          <Label>{tr('email.senders.address')}</Label>
          <Input type="email" inputMode="email" spellCheck={false} autoCorrect="off" autoCapitalize="off" />
        </TextField>
        <div className="row">
          <Button type="submit" className="button primary">
            {tr(editing !== null ? 'email.senders.save' : 'email.senders.add')}
          </Button>
          {editing !== null && (
            <Button
              className="button"
              onPress={() => {
                setEditing(null);
                setName('');
                setAddress('');
                setStatus('');
              }}
            >
              {tr('email.senders.cancel')}
            </Button>
          )}
        </div>
      </Form>
      <p role="status" className="status">
        {status}
      </p>
    </section>
  );
}
