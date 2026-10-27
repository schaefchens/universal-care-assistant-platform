/**
 * "Mit einem anderen Gerät verbinden" (docs/plan-m4.md, G3): this new device takes the code another device of the
 * person shows, with a key of its own; then both show and say the same four pictures, and the person says yes on the
 * other device. Only then is this device theirs and signs in with its key. No words are needed, and none are shown.
 */
import { linkWordsOf } from '@ucap/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button, Form, Input, Label, TextField } from 'react-aria-components';
import { claimLink, pollLink, type Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import type { ServerRef } from '../state/store.ts';
import { useUi } from '../ui.tsx';
import { deviceInfo } from './words/common.ts';

export function LinkDevice(p: { server: ServerRef; onSignedIn: (s: Session) => void; onCancel: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [code, setCode] = useState('');
  const [claim, setClaim] = useState<{ id: string; jkt: string; words: number[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wordsRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    say(`${tr('link.claim.title')}. ${tr('link.claim.intro')}`, 'system');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (text: string) => {
    setError(text);
    ui.earcons.play('error');
    say(text, 'system');
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await claimLink({ server: p.server, code, device: await deviceInfo() });
      setClaim(r);
      const words = linkWordsOf(r.words, ui.lang).map((w) => w.word);
      ui.earcons.play('confirm');
      say(tr('link.claim.words', { words: new Intl.ListFormat(ui.lang, { type: 'conjunction' }).format(words) }), 'system');
    } catch (err) {
      const reason = err instanceof ApiError ? err.params.reason : undefined;
      fail(reason === 'link_code' ? tr('link.claim.wrong') : tr(`error.${err instanceof ApiError ? err.code : 'internal'}`));
    } finally {
      setBusy(false);
    }
  }

  // The person's answer comes on the other device: asked every two seconds.
  useEffect(() => {
    if (!claim) return;
    wordsRef.current?.focus();
    let stop = false;
    const t = setInterval(() => {
      void pollLink({ server: p.server, id: claim.id, jkt: claim.jkt }).then(
        (r) => {
          if (stop) return;
          if (r.state === 'approved') {
            stop = true;
            say(tr('link.claim.done'), 'system');
            p.onSignedIn(r.session);
          } else if (r.state !== 'claimed') {
            stop = true;
            setClaim(null);
            fail(tr(r.state === 'declined' ? 'link.claim.declined' : 'link.claim.expired'));
          }
        },
        () => {},
      );
    }, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [claim?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (claim) {
    const words = linkWordsOf(claim.words, ui.lang);
    return (
      <main className="page">
        <h1>{tr('link.claim.title')}</h1>
        <p ref={wordsRef} tabIndex={-1}>
          {tr('link.claim.compare')}
        </p>
        <ul className="link-words" aria-label={tr('link.words.label')}>
          {words.map((w, i) => (
            <li key={i}>
              <span className="link-emoji" aria-hidden>
                {w.emoji}
              </span>
              <span>{w.word}</span>
            </li>
          ))}
        </ul>
        <p className="muted">{tr('link.claim.waiting')}</p>
        <Button className="button" onPress={() => say(tr('link.claim.words', { words: new Intl.ListFormat(ui.lang, { type: 'conjunction' }).format(words.map((w) => w.word)) }), 'system')}>
          {tr('link.offer.again')}
        </Button>
        <p role="status" className="status error">
          {error ?? ''}
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>{tr('link.claim.title')}</h1>
      <p>{tr('link.claim.intro')}</p>
      <Form onSubmit={submit} className="stack">
        <TextField value={code} onChange={(v) => setCode(v.replace(/[^\d ]/g, '').slice(0, 7))} isRequired className="field" autoComplete="off">
          <Label>{tr('link.claim.code')}</Label>
          <Input inputMode="numeric" autoCorrect="off" spellCheck={false} />
        </TextField>
        <Button type="submit" className="button primary" isDisabled={busy || code.replace(/\s/g, '').length !== 6}>
          {tr('onboard.invite.next')}
        </Button>
        <Button className="button" onPress={p.onCancel}>
          {tr('area.back.label')}
        </Button>
        <p role="status" className="status error">
          {error ?? ''}
        </p>
      </Form>
    </main>
  );
}
