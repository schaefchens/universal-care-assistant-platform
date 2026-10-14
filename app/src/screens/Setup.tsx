/**
 * Setup: which UCAP server this device belongs to. Typed in (or, from S3, opened from an invitation link). The
 * address is checked against the server before it is kept.
 */
import { type FormEvent, useState } from 'react';
import { Button, FieldError, Form, Input, Label, TextField } from 'react-aria-components';
import { fetchServerInfo, normaliseServerUrl } from '../net/server.ts';
import type { ServerRef } from '../state/store.ts';
import { useUi } from '../ui.tsx';

export function Setup(p: { onConnected: (s: ServerRef) => void }) {
  const { tr, say } = useUi();
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<{ kind: 'idle' | 'checking' | 'error'; text?: string }>({ kind: 'idle' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const url = normaliseServerUrl(value);
    if (!url) {
      const text = tr('setup.error.invalid');
      setStatus({ kind: 'error', text });
      say(text, 'system');
      return;
    }
    setStatus({ kind: 'checking', text: tr('setup.checking') });
    const info = await fetchServerInfo(url);
    if (typeof info === 'string') {
      const text = tr(`setup.error.${info}`);
      setStatus({ kind: 'error', text });
      say(text, 'system');
      return;
    }
    say(tr('setup.connected', { name: info.name }), 'system');
    p.onConnected({ url, name: info.name, serverId: info.serverId });
  };

  return (
    <main className="page">
      <h1>{tr('setup.title')}</h1>
      <p>{tr('setup.intro')}</p>
      <Form onSubmit={submit} className="stack">
        <TextField value={value} onChange={setValue} isRequired autoFocus className="field" inputMode="url" autoComplete="url" spellCheck="false">
          <Label>{tr('setup.address')}</Label>
          <Input placeholder="ucap.example.org" />
          <FieldError />
        </TextField>
        <Button type="submit" className="button primary" isDisabled={status.kind === 'checking'}>
          {tr('setup.connect')}
        </Button>
        <p role="status" className={`status ${status.kind}`}>
          {status.text ?? ''}
        </p>
      </Form>
    </main>
  );
}
