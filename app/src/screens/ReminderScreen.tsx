/**
 * A reminder that is due (docs/plan.md, S6; CONCEPT §9): its question, spoken, and four large areas. Erledigt,
 * Später, Nein, Hilfe holen. "Hilfe holen" is a help request linked to the reminder, so it goes through the help path
 * and its outbox. What the person hears afterwards says what was recorded, and whether it has left the device yet.
 */
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useRef, useState } from 'react';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { CareClient } from '../care/client.ts';
import type { Session } from '../identity/account.ts';
import { type Answer, answer, type Occurrence, reminders } from '../reminders/api.ts';
import { afterAnswer, promptOf, question, titleOf } from '../reminders/words.ts';
import { useUi } from '../ui.tsx';
import { useScreenVoice } from '../voice/screen.ts';
import { TalkButton } from '../voice/TalkButton.tsx';

export function ReminderScreen(p: {
  session: Session;
  occurrenceId: string;
  config: DeviceConfig;
  care: CareClient | null;
  /** The question in the person's voice for answers; the device voice when that one cannot speak. */
  ask: (text: string) => void;
  /** LIVE mode listens: the time is said first, and the answer needs no touch. */
  live?: boolean;
  onDone: () => void;
  onHelp: () => void;
}) {
  const ui = useUi();
  const { tr, say } = ui;
  const [o, setO] = useState<Occurrence | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef('');

  useEffect(() => {
    void reminders(p.session, p.session.ref.userId)
      .occurrence(p.occurrenceId)
      .then(
        (x) => {
          // Answered elsewhere, missed or gone meanwhile: nothing to ask.
          if (x.state !== 'due' && x.state !== 'scheduled') return p.onDone();
          setO(x);
          // Once per prompt, also where an effect runs twice (React's development checks).
          if (asked.current === `${x.id}:${x.prompts}`) return;
          asked.current = `${x.id}:${x.prompts}`;
          ui.earcons.play('screen');
          p.ask(question(tr, x, p.live ? new Date() : undefined));
        },
        () => p.onDone(),
      );
  }, [p.occurrenceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // By voice too (docs/plan.md, S8: the reminder context): "Erledigt" or "Ja", "Später", "Nein", "Hilfe holen".
  useScreenVoice(
    {
      context: 'reminder',
      onIntent: (i) => {
        if (!o) return false;
        if (i === 'done' || i === 'later' || i === 'no' || i === 'help') void choose(i);
        else if (i === 'repeat') p.ask(question(tr, o, p.live ? new Date() : undefined));
        else return false;
        return true;
      },
    },
    [o?.id, o?.prompts, busy],
  );

  async function choose(id: string) {
    if (!o || busy) return;
    if (id === 'help') {
      void p.care?.press('reminder', { reminderOccurrenceId: o.id });
      p.onHelp();
      return;
    }
    setBusy(true);
    const kind = id as Answer;
    const r = await answer(p.session, o.id, kind);
    say(afterAnswer(tr, kind, r, o), 'system');
    setBusy(false);
    p.onDone();
  }

  return (
    <main className="area-screen" aria-label={o ? tr('reminder.announce', { title: titleOf(tr, o) }) : tr('reminder.title')}>
      <header className="onboard-header">
        <h1>{o ? titleOf(tr, o) : tr('reminder.title')}</h1>
        {o && <p>{promptOf(tr, o)}</p>}
        <TalkButton className="button talk" />
      </header>
      {o && (
        <ChoiceGrid
          id={`reminder-${o.id}-${o.prompts}`}
          config={p.config}
          choices={[
            { id: 'done', label: tr('reminder.area.done'), role: 'reminders' },
            { id: 'later', label: tr('reminder.area.later', { n: o.snoozeMin }), role: 'neutral' },
            { id: 'no', label: tr('reminder.area.no'), role: 'neutral' },
            { id: 'help', label: tr('reminder.area.help'), role: 'help' },
          ]}
          onChoose={(id) => void choose(id)}
        />
      )}
    </main>
  );
}
