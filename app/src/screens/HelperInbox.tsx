/**
 * The helper's side (docs/plan.md, S4 "the helper inbox"): an incoming request as a screen of large areas
 * (Annehmen, Kann nicht, Zur Liste), and the list of open requests of the people one responds for, with what one can
 * do: accept, decline, give it back, a quick reply in one's own words, mark it done. Seeing a request tells the
 * person (A5).
 */
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useState } from 'react';
import { Button, Heading } from 'react-aria-components';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import { helperCare, type HelperRequest, whenPressed } from '../care/helper.ts';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

const QUICK_MINUTES = [5, 10, 15, 30] as const;

export function HelperAlert(p: { session: Session; requestId: string; config: DeviceConfig; onDone: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const api = helperCare(p.session);
  const [r, setR] = useState<HelperRequest | null>(null);

  useEffect(() => {
    void api.get(p.requestId).then(
      (x) => {
        setR(x);
        if (x.status !== 'open') return;
        ui.earcons.play('care-press');
        say(`${tr('care.helper.alert', { person: x.person.displayName })}${x.unconfirmed ? ` ${tr('care.helper.unconfirmed')}` : ''}`, 'care');
        void api.act(x.id, 'seen', x.episode).catch(() => {});
      },
      () => p.onDone(),
    );
  }, [p.requestId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(action: 'accept' | 'decline') {
    if (!r) return;
    try {
      await api.act(r.id, action, r.episode);
      if (action === 'accept') say(tr('care.helper.youAccepted', { person: r.person.displayName }), 'system');
    } catch (e) {
      const by = e instanceof ApiError ? (e.params.acceptedBy as string | undefined) : undefined;
      say(by ? tr('care.helper.alreadyAccepted', { name: by }) : tr(`error.${e instanceof ApiError ? e.code : 'internal'}`), 'system');
    }
    p.onDone();
  }

  return (
    <main className="area-screen" aria-label={r ? tr('care.helper.alert', { person: r.person.displayName }) : tr('care.helper.inbox')}>
      <header className="onboard-header">
        <h1>{r ? tr('care.helper.alert', { person: r.person.displayName }) : tr('care.helper.inbox')}</h1>
        {r && (
          <p>
            {[r.originDevice, whenPressed(r, ui.lang, tr)].filter(Boolean).join(' · ')} {r.unconfirmed && tr('care.helper.unconfirmed')}
          </p>
        )}
      </header>
      {r && r.status === 'open' && (
        <ChoiceGrid
          id={`alert-${r.id}-${r.episode}`}
          config={p.config}
          choices={[
            { id: 'accept', label: tr('care.helper.accept'), role: 'assistant' },
            { id: 'decline', label: tr('care.helper.decline') },
            { id: 'list', label: tr('care.helper.inbox'), role: 'nav' },
          ]}
          onChoose={(id) => (id === 'list' ? p.onDone() : void act(id as 'accept' | 'decline'))}
        />
      )}
    </main>
  );
}

export function HelperInbox(p: { session: Session; userId: string; refresh: number; onClose: () => void; children?: React.ReactNode }) {
  const ui = useUi();
  const { tr, say } = ui;
  const api = helperCare(p.session);
  const [list, setList] = useState<HelperRequest[] | null>(null);
  const [status, setStatus] = useState('');

  const load = async () => {
    try {
      const requests = (await api.list()).requests;
      setList(requests);
      // A request on screen has been seen (A5 for the person), once per episode.
      for (const r of requests) {
        if (r.status !== 'open' && r.status !== 'accepted') continue;
        if (!r.events.some((e) => e.type === 'seen' && e.episode === r.episode && e.actor?.id === p.userId)) void api.act(r.id, 'seen', r.episode).catch(() => {});
      }
    } catch (e) {
      setStatus(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  };
  useEffect(() => {
    void load();
  }, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(f: () => Promise<void>, done?: string) {
    try {
      await f();
      if (done) {
        setStatus(done);
        say(done, 'system');
      }
    } catch (e) {
      const by = e instanceof ApiError ? (e.params.acceptedBy as string | undefined) : undefined;
      const text = by ? tr('care.helper.alreadyAccepted', { name: by }) : tr(`error.${e instanceof ApiError ? e.code : 'internal'}`);
      setStatus(text);
      say(text, 'system');
    }
    await load();
  }

  const open = (list ?? []).filter((r) => r.status === 'open' || r.status === 'accepted');
  const recent = (list ?? []).filter((r) => r.status === 'resolved' || r.status === 'cancelled');

  return (
    <main className="page inbox">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('care.helper.inbox')}</h1>
      </header>
      <p role="status" className="status">
        {status}
      </p>
      {list && open.length === 0 && <p>{tr('care.helper.none')}</p>}
      <ul className="device-list">
        {open.map((r) => {
          const mine = r.acceptedBy?.id === p.userId;
          return (
            <li key={`${r.id}-${r.episode}`} className={`device request ${r.status}`}>
              <Heading level={2} className="device-name">
                {tr('care.helper.alert', { person: r.person.displayName })} {r.unconfirmed && <span className="muted">{tr('care.helper.unconfirmed')}</span>}
              </Heading>
              <p className="muted">
                {[r.originDevice, whenPressed(r, ui.lang, tr)].filter(Boolean).join(' · ')} ·{' '}
                {r.status === 'accepted' ? tr('care.helper.state.accepted', { name: r.acceptedBy?.displayName ?? '' }) : tr('care.helper.state.open')}
              </p>
              <div className="row">
                {r.status === 'open' && (
                  <>
                    <Button className="button primary" onPress={() => void run(() => api.act(r.id, 'accept', r.episode), tr('care.helper.youAccepted', { person: r.person.displayName }))}>
                      {tr('care.helper.accept')}
                    </Button>
                    <Button className="button" onPress={() => void run(() => api.act(r.id, 'decline', r.episode))}>
                      {tr('care.helper.decline')}
                    </Button>
                  </>
                )}
                {mine && (
                  <Button className="button" onPress={() => void run(() => api.act(r.id, 'release', r.episode))}>
                    {tr('care.helper.release')}
                  </Button>
                )}
                <Button className="button" onPress={() => void run(() => api.act(r.id, 'resolve', r.episode), tr('care.helper.resolved', { person: r.person.displayName }))}>
                  {tr('care.helper.resolve')}
                </Button>
              </div>
              <div className="row" role="group" aria-label={tr('care.helper.reply')}>
                <Button className="button" onPress={() => void run(() => api.reply(r.id, r.episode, 'on_the_way'), tr('quick.on_the_way'))}>
                  {tr('quick.on_the_way')}
                </Button>
                <Button className="button" onPress={() => void run(() => api.reply(r.id, r.episode, 'will_call'), tr('quick.will_call'))}>
                  {tr('quick.will_call')}
                </Button>
                {QUICK_MINUTES.map((n) => (
                  <Button key={n} className="button" onPress={() => void run(() => api.reply(r.id, r.episode, 'minutes', n), tr('quick.minutes', { n }))}>
                    {tr('quick.minutes', { n })}
                  </Button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      {recent.length > 0 && (
        <section>
          <h2>{tr('people.history')}</h2>
          <ul className="history">
            {recent.map((r) => (
              <li key={`${r.id}-${r.episode}`}>
                {whenPressed(r, ui.lang, tr)} · {r.person.displayName} · {tr(`care.helper.state.${r.status}`)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {p.children}
    </main>
  );
}
