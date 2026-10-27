/**
 * The person's representative (docs/plan-m4.md, G6; the owner: "Person, or admin with a reason"): an arrangement of its
 * own, named on the person's own device from their helpers after hearing what it means, ended there too. Who the
 * person represents is shown as well. An administrator's arrangement names who made it and why.
 */
import { useEffect, useState } from 'react';
import { Button, Label, Radio, RadioGroup } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

export interface Representation {
  id: string;
  person: { id: string; displayName: string };
  representative: { id: string; displayName: string };
  madeHow: 'person' | 'admin';
  madeBy: string;
  reason: string | null;
  startedAt: string;
}

export function RepresentationSetting(p: { session: Session; helpers: { id: string; displayName: string }[]; refresh: number; onManage: (person: { id: string; displayName: string }) => void }) {
  const { tr, say } = useUi();
  const [reps, setReps] = useState<{ mine: Representation | null; represented: Representation[] } | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  const load = () =>
    p.session.call<{ mine: Representation | null; represented: Representation[] }>('/api/v1/representations').then(setReps, () => {});
  useEffect(() => {
    void load();
  }, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) => tell(tr(e instanceof ApiError && e.code === 'locked' ? 'error.locked' : `error.${e instanceof ApiError ? e.code : 'internal'}`));
  const chosen = p.helpers.find((h) => h.id === choosing);

  async function appoint() {
    if (!chosen) return;
    try {
      await p.session.call('/api/v1/representations', { body: { representativeId: chosen.id } });
      setChoosing(null);
      tell(tr('rep.made', { name: chosen.displayName }));
      await load();
    } catch (e) {
      fail(e);
    }
  }

  async function end(r: Representation) {
    try {
      await p.session.call(`/api/v1/representations/${r.id}`, { method: 'DELETE' });
      tell(tr('rep.ended', { name: r.representative.displayName }));
      await load();
    } catch (e) {
      fail(e);
    }
  }

  if (!reps) return null;
  const mine = reps.mine;
  return (
    <section className="settings-section">
      <h2>{tr('rep.title')}</h2>
      <p role="status" className="status">
        {status}
      </p>
      {mine ? (
        <>
          <p>{mine.madeHow === 'admin' ? tr('rep.mine.admin', { name: mine.representative.displayName, by: mine.madeBy, reason: mine.reason ?? '' }) : tr('rep.mine', { name: mine.representative.displayName })}</p>
          <Button className="button" onPress={() => void end(mine)}>
            {tr('rep.end', { name: mine.representative.displayName })}
          </Button>
        </>
      ) : (
        <>
          <p>{tr('rep.none')}</p>
          {p.helpers.length === 0 ? (
            <p className="muted">{tr('rep.noHelpers')}</p>
          ) : (
            <RadioGroup
              className="choice"
              value={choosing}
              onChange={(id) => {
                setChoosing(id);
                const h = p.helpers.find((x) => x.id === id);
                // What it means, said before anything is decided (the plan's sentence).
                if (h) say(tr('rep.explain', { name: h.displayName }), 'system');
              }}
            >
              <Label className="choice-label">{tr('rep.choose')}</Label>
              {p.helpers.map((h) => (
                <Radio key={h.id} value={h.id} className="choice-option">
                  {h.displayName}
                </Radio>
              ))}
            </RadioGroup>
          )}
          {chosen && (
            <div className="stack">
              <p>{tr('rep.explain', { name: chosen.displayName })}</p>
              <Button className="button primary" onPress={() => void appoint()}>
                {tr('rep.confirm', { name: chosen.displayName })}
              </Button>
            </div>
          )}
        </>
      )}
      {reps.represented.map((r) => (
        <div key={r.id} className="stack">
          <p>{tr('rep.represented', { name: r.person.displayName })}</p>
          <Button className="button" onPress={() => p.onManage(r.person)}>
            {tr('rep.access.title', { name: r.person.displayName })}
          </Button>
        </div>
      ))}
    </section>
  );
}
