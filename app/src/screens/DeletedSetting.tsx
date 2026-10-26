/**
 * What the person deleted is kept, for undo and their history, until they remove it for good here (docs/decisions.md,
 * M3, To confirm 20: "we keep messages forever until user decides to purge deleted"). It names what is kept, and asks
 * before anything goes (CONCEPT §5: deleting content is confirmed); afterwards nothing brings it back. The person's
 * own settings only: no helper can.
 */
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

interface Counts {
  notes: number;
  contacts: number;
  appointments: number;
  tasks: number;
}

export function DeletedSetting(p: { session: Session }) {
  const { tr, say } = useUi();
  const [kept, setKept] = useState<Counts | null>(null);
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState('');

  const load = () => p.session.call<{ kept: Counts }>('/api/v1/deleted').then((r) => setKept(r.kept), () => setKept(null));
  useEffect(() => {
    void load();
  }, [p.session]); // eslint-disable-line react-hooks/exhaustive-deps

  /** "zwei Kontakte, ein Termin und drei Notizen": what there is, the rest left out. */
  const listOf = (c: Counts) => {
    const parts = (['contacts', 'appointments', 'tasks', 'notes'] as const).filter((k) => c[k] > 0).map((k) => tr(`deleted.${k}`, { count: c[k] }));
    return parts.length > 1 ? tr('messages.and', { first: parts.slice(0, -1).join(', '), last: parts.at(-1)! }) : (parts[0] ?? '');
  };
  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  async function purge() {
    setAsking(false);
    try {
      const r = await p.session.call<{ purged: Counts }>('/api/v1/deleted/purge', { method: 'POST', body: {} });
      tell(tr('deleted.done', { list: listOf(r.purged) }));
      await load();
    } catch (e) {
      tell(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  }

  if (!kept) return null;
  const list = listOf(kept);
  return (
    <section className="settings-section">
      <h2>{tr('deleted.title')}</h2>
      <p>{list ? tr('deleted.kept', { list }) : tr('deleted.none')}</p>
      {list && !asking && (
        <Button
          className="button"
          onPress={() => {
            setAsking(true);
            tell(tr('deleted.confirm', { list }));
          }}
        >
          {tr('deleted.purge')}
        </Button>
      )}
      {asking && (
        <div className="row" role="group" aria-label={tr('deleted.confirm', { list })}>
          <Button className="button primary" onPress={() => void purge()} autoFocus>
            {tr('deleted.yes')}
          </Button>
          <Button
            className="button"
            onPress={() => {
              // Declined: the question goes from the status line too.
              setAsking(false);
              setStatus('');
            }}
          >
            {tr('deleted.no')}
          </Button>
        </div>
      )}
      <p role="status" className="status">
        {status}
      </p>
    </section>
  );
}
