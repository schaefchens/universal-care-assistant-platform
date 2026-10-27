/**
 * "Neues Gerät verbinden" (docs/plan-m4.md, G3; CONCEPT §21: "he also might use multiple devices at once"): this
 * signed-in device gives a six-digit code for ten minutes, said digit by digit with the server's address; when a new
 * device has taken it, both show and say the same four pictures, and the person says yes here (signed by this device's
 * key) or no. Nothing is added before that yes.
 */
import { linkWordsOf } from '@ucap/shared';
import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { deviceKey } from '../identity/device-key.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

interface LinkView {
  id: string;
  state: 'open' | 'claimed' | 'approved' | 'declined' | 'cancelled' | 'expired';
  device: { name: string; platform: string; formFactor: string | null } | null;
  words: number[] | null;
  djkt: string | null;
  expiresAt: string;
}

/** "481027" → "4 8 1, 0 2 7" for a voice; "481 027" for the eye. */
const spoken = (code: string) => `${code.slice(0, 3).split('').join(' ')}, ${code.slice(3).split('').join(' ')}`;
const shown = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

export function LinkOffer(p: { session: Session; serverName: string; onLinked: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [offer, setOffer] = useState<{ id: string; code: string } | null>(null);
  const [view, setView] = useState<LinkView | null>(null);
  const [status, setStatus] = useState('');
  const heard = useRef<string | null>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);

  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  const failed = (e: unknown) => tell(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));

  // While a code is out, how it stands: every two seconds (the claim comes from another device, without a session).
  useEffect(() => {
    if (!offer) return;
    let stop = false;
    const tick = async () => {
      try {
        const v = await p.session.call<LinkView>(`/api/v1/devices/links/${offer.id}`);
        if (stop) return;
        setView(v);
        if (v.state === 'claimed' && heard.current !== `claimed:${v.id}`) {
          heard.current = `claimed:${v.id}`;
          ui.earcons.play('confirm');
          const words = linkWordsOf(v.words ?? [], ui.lang).map((w) => w.word);
          say(tr('link.offer.claimed', { name: v.device?.name ?? '', words: new Intl.ListFormat(ui.lang, { type: 'conjunction' }).format(words) }), 'system');
        } else if (v.state === 'expired' && heard.current !== `expired:${v.id}`) {
          heard.current = `expired:${v.id}`;
          tell(tr('link.offer.expired'));
        }
      } catch (e) {
        if (!stop) failed(e);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [offer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (view?.state === 'claimed') questionRef.current?.focus();
  }, [view?.state]);

  async function start() {
    try {
      const r = await p.session.call<{ id: string; code: string }>('/api/v1/devices/links', { method: 'POST' });
      setOffer(r);
      setView(null);
      heard.current = null;
      tell(tr('link.offer.code', { code: spoken(r.code), server: p.serverName }));
    } catch (e) {
      failed(e);
    }
  }

  async function answer(yes: boolean) {
    if (!offer || !view) return;
    try {
      if (yes) {
        const org = new URL(p.session.ref.serverUrl).origin;
        const proof = await deviceKey.sign('device.link', { srv: p.session.ref.serverId, org, lid: view.id, djkt: view.djkt ?? '' });
        await p.session.call(`/api/v1/devices/links/${view.id}/approve`, { body: { org, proof } });
        tell(tr('link.offer.approved', { name: view.device?.name ?? '' }));
        p.onLinked();
      } else {
        await p.session.call(`/api/v1/devices/links/${view.id}/decline`, { method: 'POST' });
        tell(tr('link.offer.declined'));
      }
      setOffer(null);
      setView(null);
    } catch (e) {
      failed(e);
    }
  }

  async function cancel() {
    if (offer) await p.session.call(`/api/v1/devices/links/${offer.id}`, { method: 'DELETE' }).catch(() => {});
    setOffer(null);
    setView(null);
    tell(tr('link.offer.cancelled'));
  }

  const words = view?.state === 'claimed' ? linkWordsOf(view.words ?? [], ui.lang) : [];
  return (
    <section className="settings-section link-offer">
      <h2>{tr('link.offer.title')}</h2>
      <p role="status" className="status">
        {status}
      </p>
      {!offer && (
        <>
          <p>{tr('link.offer.intro')}</p>
          <Button className="button primary" onPress={() => void start()}>
            {tr('link.offer.start')}
          </Button>
        </>
      )}
      {offer && view?.state !== 'claimed' && (
        <div className="stack">
          <p>{tr('link.offer.enter', { server: p.serverName })}</p>
          <p className="link-code" aria-label={tr('link.offer.codeLabel', { code: spoken(offer.code) })}>
            {shown(offer.code)}
          </p>
          <div className="row">
            <Button className="button" onPress={() => say(tr('link.offer.code', { code: spoken(offer.code), server: p.serverName }), 'system')}>
              {tr('link.offer.again')}
            </Button>
            <Button className="button" onPress={() => void cancel()}>
              {tr('devices.cancel')}
            </Button>
          </div>
        </div>
      )}
      {offer && view?.state === 'claimed' && (
        <div className="stack">
          <p ref={questionRef} tabIndex={-1} role="alert">
            {tr('link.offer.question', { name: view.device?.name ?? '' })}
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
          <div className="row">
            <Button className="button primary" onPress={() => void answer(true)}>
              {tr('link.offer.yes')}
            </Button>
            <Button className="button danger" onPress={() => void answer(false)}>
              {tr('link.offer.no')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
