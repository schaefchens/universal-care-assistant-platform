/**
 * The person approves a helper on their own device (docs/plan.md, S3): who it is and what they may do, spoken the
 * same way every time, then Erlauben or Ablehnen by the person's usual gesture. Nothing is granted before this.
 */
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useState } from 'react';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { people, type Relationship } from '../people/api.ts';
import { approvalSummary } from '../people/summary.ts';
import { useUi } from '../ui.tsx';

export function Approve(p: { session: Session; relationshipId: string; config: DeviceConfig; onDone: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [rel, setRel] = useState<Relationship | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void people(p.session)
      .relationship(p.relationshipId)
      .then(setRel, (e) => setError(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`)));
  }, [p.relationshipId]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = rel ? approvalSummary({ name: rel.helper.displayName, scopes: rel.proposedScopes, lang: ui.lang, tr }) : '';
  useEffect(() => {
    if (!rel) return;
    if (rel.state !== 'pending') {
      p.onDone();
      return;
    }
    ui.earcons.play('screen');
    say(summary, 'system');
  }, [rel]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(allow: boolean) {
    if (!rel || busy) return;
    setBusy(true);
    try {
      if (allow) await people(p.session).approve(rel.id, rel.proposedScopes);
      else await people(p.session).end(rel.id);
      say(tr(allow ? 'people.approved' : 'people.declined', { name: rel.helper.displayName }), 'system');
      p.onDone();
    } catch (e) {
      const text = tr(`error.${e instanceof ApiError ? e.code : 'internal'}`);
      setError(text);
      say(text, 'system');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="area-screen" aria-label={tr('people.approve.title')}>
      <header className="onboard-header">
        <h1>{tr('people.approve.title')}</h1>
        {error ? (
          <p role="alert" className="status error">
            {error}
          </p>
        ) : (
          <p>{summary || tr('devices.loading')}</p>
        )}
      </header>
      {rel && (
        <ChoiceGrid
          id={`approve-${rel.id}`}
          config={p.config}
          choices={[
            { id: 'allow', label: tr('people.area.allow'), role: 'assistant' },
            { id: 'decline', label: tr('people.area.decline') },
            { id: 'repeat', label: tr('people.area.repeat') },
            { id: 'later', label: tr('people.area.later'), role: 'nav' },
          ]}
          onChoose={(id) => {
            if (id === 'allow') void act(true);
            else if (id === 'decline') void act(false);
            else if (id === 'repeat') say(summary, 'system');
            else p.onDone();
          }}
        />
      )}
    </main>
  );
}
