/**
 * The assistant's name, once per person after the voices (docs/plan-m2.md, the owner's decision: "The person names the
 * assistant, with a suggestion, in onboarding and in the settings; the name is the keyword"). A few names to choose
 * from by touch, the ones the keyword spotter hears best (docs/spikes/m2.md), none a helper of the person is called;
 * "Später" leaves it for the settings, where a name or a keyword of one's own can be typed. Skipped when the person
 * has a name already (from another device).
 */
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useState } from 'react';
import { sentences } from '../areas/AreaGrid.tsx';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { Me, Session } from '../identity/account.ts';
import { people } from '../people/api.ts';
import { useUi } from '../ui.tsx';

/**
 * Heard best by the spotter and seldom where nobody called it (docs/spikes/m2.md: Mathilda 45 of 45 and no false
 * wake in an hour of speech, Theodor 45 of 45, Hanna 42 of 45, Leopold 44 of 45), in this order.
 */
export const SUGGESTED_NAMES = ['Mathilda', 'Theodor', 'Hanna', 'Leopold'];

export function NameIntro(p: { session: Session; config: DeviceConfig; onDone: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [names, setNames] = useState<string[] | null>(null);

  useEffect(() => {
    let gone = false;
    void (async () => {
      // Named on another device already, or the server unreachable: nothing to ask now.
      const me = await p.session.call<Me>('/api/v1/me').catch(() => null);
      if (gone) return;
      if (!me || me.assistantName) return p.onDone();
      // A helper's name would wake the assistant whenever the person speaks to that helper.
      const taken = await people(p.session)
        .relationships()
        .then(
          (r) => r.asPerson.filter((x) => x.state !== 'ended').map((x) => x.helper.displayName.split(' ')[0]!.toLowerCase()),
          () => [] as string[],
        );
      if (!gone) setNames(SUGGESTED_NAMES.filter((n) => !taken.includes(n.toLowerCase())).slice(0, 3));
    })();
    return () => {
      gone = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!names) return;
    ui.earcons.play('screen');
    // The title is a question: no full stop after it ("Wie soll ich heißen?. …" was said on the emulator).
    say(sentences(tr('live.nameIntro.title'), tr('live.nameIntro.text', { name: names[0] ?? '' })), 'system');
  }, [names]); // eslint-disable-line react-hooks/exhaustive-deps

  async function take(name: string) {
    try {
      await p.session.call('/api/v1/me', { method: 'PATCH', body: { assistantName: name } });
      say(tr('live.nameIntro.taken', { name }), 'system');
    } catch {
      say(tr('error.internal'), 'system');
    }
    p.onDone();
  }

  if (!names) return null;
  return (
    <main className="area-screen" aria-label={tr('live.nameIntro.title')}>
      <header className="onboard-header">
        <h1>{tr('live.nameIntro.title')}</h1>
        <p>{tr('live.nameIntro.text', { name: names[0] ?? '' })}</p>
      </header>
      <ChoiceGrid
        id="name-intro"
        config={p.config}
        choices={[...names.map((n, i) => ({ id: `n${i}`, label: n, role: 'assistant' as const })), { id: 'later', label: tr('live.nameIntro.later'), role: 'nav' as const }]}
        onChoose={(id) => {
          if (id === 'later') {
            say(tr('live.nameIntro.laterSaid'), 'system');
            return p.onDone();
          }
          const n = names[Number(id.slice(1))];
          if (n) void take(n);
        }}
      />
    </main>
  );
}
