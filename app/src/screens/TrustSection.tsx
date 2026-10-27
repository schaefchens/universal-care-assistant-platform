/**
 * Trusted persons (docs/plan-m4.md, G7), both sides on the helpers page. The person asks people who help them and
 * says how many must agree; a trusted person agrees on their own device ("Du siehst dadurch nichts von Claras Daten."),
 * and when someone they trust lost every device, enters the new device's code, compares its four pictures and says
 * yes. Enough yeses start the day's wait (G5), which every device of the person can stop.
 */
import { linkWordsOf } from '@ucap/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Form, Heading, Input, Label, Radio, RadioGroup, TextField } from 'react-aria-components';
import { approveTrusted, type Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import type { ServerRef } from '../state/store.ts';
import { useUi } from '../ui.tsx';

interface Trust {
  trustees: { id: string; trustee: { id: string; displayName: string }; state: 'asked' | 'accepted' }[];
  threshold: number | null;
  trustedBy: { id: string; person: { id: string; displayName: string }; state: 'asked' | 'accepted' }[];
}

export function TrustSection(p: { session: Session; server: ServerRef; helpers: { id: string; displayName: string }[]; refresh: number }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [trust, setTrust] = useState<Trust | null>(null);
  const [status, setStatus] = useState('');
  const [code, setCode] = useState('');
  const [found, setFound] = useState<{ id: string; words: number[]; djkt: string; people: { id: string; displayName: string }[] } | null>(null);
  const [forWhom, setForWhom] = useState<string | null>(null);
  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  const fail = (e: unknown) => tell(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
  const load = () => p.session.call<Trust>('/api/v1/trustees').then(setTrust, () => {});
  useEffect(() => {
    void load();
  }, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what: () => Promise<unknown>, said: string) => {
    try {
      await what();
      tell(said);
      await load();
    } catch (e) {
      fail(e);
    }
  };

  async function lookup(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await p.session.call<{ id: string; words: number[]; djkt: string; people: { id: string; displayName: string }[] }>('/api/v1/trusted-recoveries/lookup', { body: { code: code.replace(/\s/g, '') } });
      setFound(r);
      setForWhom(r.people.length === 1 ? r.people[0]!.id : null);
      const words = new Intl.ListFormat(ui.lang, { type: 'conjunction' }).format(linkWordsOf(r.words, ui.lang).map((w) => w.word));
      tell(tr('trusted.confirm.compare', { words }));
    } catch (err) {
      tell(err instanceof ApiError && err.code === 'not_found' ? tr('trusted.confirm.unknown') : tr(`error.${err instanceof ApiError ? err.code : 'internal'}`));
    }
  }

  async function approve() {
    const person = found?.people.find((x) => x.id === forWhom);
    if (!found || !person) return;
    try {
      const r = await approveTrusted(p.session, p.server, { id: found.id, personId: person.id, djkt: found.djkt });
      setFound(null);
      setCode('');
      tell(r.effectiveAt ? tr('trusted.confirm.enough', { name: person.displayName, time: new Date(r.effectiveAt) }) : tr('trusted.confirm.thanks', { n: r.approvals, needed: r.needed }));
    } catch (e) {
      fail(e);
    }
  }

  if (!trust) return null;
  const asked = new Set(trust.trustees.map((t) => t.trustee.id));
  const count = trust.trustees.length;
  return (
    <section className="settings-section">
      <h2>{tr('trusted.title.mine')}</h2>
      <p>{tr('trusted.intro')}</p>
      <p role="status" className="status">
        {status}
      </p>
      <ul className="device-list">
        {trust.trustees.map((t) => (
          <li key={t.id} className="device">
            <Heading level={3} className="device-name">
              {t.trustee.displayName}
            </Heading>
            <p className="muted">{tr(t.state === 'accepted' ? 'trusted.state.accepted' : 'trusted.state.asked')}</p>
            <Button className="button" onPress={() => void act(() => p.session.call(`/api/v1/trustees/${t.id}`, { method: 'DELETE' }), tr('trusted.ended', { name: t.trustee.displayName }))}>
              {tr('people.end')}
            </Button>
          </li>
        ))}
      </ul>
      {p.helpers
        .filter((h) => !asked.has(h.id))
        .map((h) => (
          <Button key={h.id} className="button" onPress={() => void act(() => p.session.call('/api/v1/trustees', { body: { trusteeId: h.id } }), tr('trusted.asked', { name: h.displayName }))}>
            {tr('trusted.ask', { name: h.displayName })}
          </Button>
        ))}
      {count > 0 && (
        <RadioGroup
          className="choice"
          value={String(Math.min(trust.threshold ?? Math.min(2, count), count))}
          onChange={(v) => void act(() => p.session.call('/api/v1/trustees/threshold', { method: 'PUT', body: { k: Number(v) } }), tr('trusted.threshold.saved', { k: Number(v), n: count }))}
        >
          <Label className="choice-label">{tr('trusted.threshold')}</Label>
          {Array.from({ length: count }, (_, i) => i + 1).map((k) => (
            <Radio key={k} value={String(k)} className="choice-option">
              {tr('trusted.threshold.option', { k, n: count })}
            </Radio>
          ))}
        </RadioGroup>
      )}

      {trust.trustedBy.length > 0 && (
        <>
          <h3>{tr('trusted.title.theirs')}</h3>
          <ul className="device-list">
            {trust.trustedBy.map((t) => (
              <li key={t.id} className="device">
                <Heading level={3} className="device-name">
                  {t.person.displayName}
                </Heading>
                {t.state === 'asked' ? (
                  <>
                    <p>{tr('trusted.request', { name: t.person.displayName })}</p>
                    <div className="row">
                      <Button className="button primary" onPress={() => void act(() => p.session.call(`/api/v1/trustees/${t.id}/answer`, { body: { yes: true } }), tr('trusted.agreed', { name: t.person.displayName }))}>
                        {tr('trusted.agree')}
                      </Button>
                      <Button className="button" onPress={() => void act(() => p.session.call(`/api/v1/trustees/${t.id}/answer`, { body: { yes: false } }), tr('trusted.refused', { name: t.person.displayName }))}>
                        {tr('rep.access.decline')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="muted">{tr('trusted.youAre', { name: t.person.displayName })}</p>
                    <Button className="button" onPress={() => void act(() => p.session.call(`/api/v1/trustees/${t.id}`, { method: 'DELETE' }), tr('trusted.left', { name: t.person.displayName }))}>
                      {tr('people.end')}
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {trust.trustedBy.some((t) => t.state === 'accepted') && (
            <Form className="stack" onSubmit={lookup}>
              <TextField className="field" value={code} onChange={setCode} isRequired>
                <Label>{tr('trusted.confirm.code')}</Label>
                <Input inputMode="numeric" autoComplete="off" />
              </TextField>
              <Button type="submit" className="button">
                {tr('reset.next')}
              </Button>
            </Form>
          )}
          {found && (
            <div className="stack">
              <ul className="link-words" aria-label={tr('link.words.label')}>
                {linkWordsOf(found.words, ui.lang).map((w, i) => (
                  <li key={i}>
                    <span className="link-emoji" aria-hidden>
                      {w.emoji}
                    </span>
                    <span>{w.word}</span>
                  </li>
                ))}
              </ul>
              <RadioGroup className="choice" value={forWhom} onChange={setForWhom}>
                <Label className="choice-label">{tr('trusted.confirm.whose')}</Label>
                {found.people.map((x) => (
                  <Radio key={x.id} value={x.id} className="choice-option">
                    {x.displayName}
                  </Radio>
                ))}
              </RadioGroup>
              {forWhom && (
                <Button className="button primary" onPress={() => void approve()}>
                  {tr('trusted.confirm.yes', { name: found.people.find((x) => x.id === forWhom)?.displayName ?? '' })}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
