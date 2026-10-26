/**
 * Appointments and tasks in large areas (docs/plan-m3.md, K7: "„Termine" and „Aufgaben" in areas (Nächster,
 * Wiederholen, Erledigt, Zurück, Hilfe)"): what comes next is said as UCAP says it everywhere, from what is stored;
 * a task ticked off can be opened again right there (CONCEPT §8: reversible). Reading needs only the server's core, so
 * it works with the assistant stopped. What is said is on screen as text too, for partial sight and screen readers.
 */
import { appointmentAloud, type DeviceConfig, dayText, type Lang } from '@ucap/shared';
import { useEffect, useState } from 'react';
import { agenda, type Appointment, type Task } from '../agenda/api.ts';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { Session } from '../identity/account.ts';
import { useUi } from '../ui.tsx';
import { useScreenVoice } from '../voice/screen.ts';
import { TalkButton } from '../voice/TalkButton.tsx';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The calendar day of an instant where the appointment is. */
const dayIn = (iso: string, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso));

type Screen = { session: Session; config: DeviceConfig; onHome: () => void; onHelp: () => void };

export function AppointmentsScreen(p: Screen) {
  const ui = useUi();
  const { tr, say } = ui;
  const lang = ui.lang as Lang;
  const [list, setList] = useState<Appointment[] | null>(null);
  const [i, setI] = useState(0);

  const aloud = (a: Appointment) => appointmentAloud(lang, { ...a, nextDay: a.nextAt ? dayIn(a.nextAt, a.timezone) : null }, { today: today(), year: new Date().getFullYear() });
  const item = (all: Appointment[], k: number) => tr('agenda.area.item', { n: k + 1, count: all.length, text: aloud(all[k]!) });

  useEffect(() => {
    void agenda(p.session, p.session.ref.userId)
      .appointments.list()
      .then(
        (r) => {
          // What is still to come, the next first.
          const coming = r.appointments.filter((a) => a.nextAt !== null);
          setList(coming);
          ui.earcons.play('screen');
          say(`${tr('agenda.page.appointments')}. ${tr('agenda.area.count', { count: coming.length })} ${coming.length ? item(coming, 0) : tr('agenda.area.empty')}`, 'system');
        },
        () => {
          setList([]);
          say(tr('agenda.area.unavailable'), 'system');
        },
      );
  }, [p.session]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = list?.[i];
  useScreenVoice(
    {
      onIntent: (intent) => {
        if (intent !== 'repeat' || !list) return false;
        say(current ? item(list, i) : tr('agenda.area.empty'), 'system');
        return true;
      },
    },
    [list, i],
  );

  const choices = [
    ...(current
      ? [
          { id: 'next', label: tr('agenda.area.next'), role: 'agenda' as const },
          { id: 'repeat', label: tr('agenda.area.repeat'), role: 'neutral' as const },
        ]
      : []),
    { id: 'back', label: tr('agenda.area.back'), role: 'nav' as const },
    // Every screen has a way to help that needs no speech (Appendix H).
    { id: 'help', label: tr('area.help.label'), role: 'help' as const },
  ];

  return (
    <main className="area-screen" aria-label={tr('agenda.page.appointments')}>
      <header className="topbar">
        <h1 className="topbar-title">{tr('agenda.page.appointments')}</h1>
        <TalkButton />
      </header>
      <div className="onboard-header">{current ? <p>{aloud(current)}</p> : list && <p>{tr('agenda.area.empty')}</p>}</div>
      {list && (
        <ChoiceGrid
          id="appointments"
          config={p.config}
          choices={choices}
          onChoose={(id) => {
            if (id === 'next' && list.length) {
              const k = (i + 1) % list.length;
              setI(k);
              say(item(list, k), 'system');
            } else if (id === 'repeat' && current) say(item(list, i), 'system');
            else if (id === 'back') p.onHome();
            else if (id === 'help') p.onHelp();
          }}
        />
      )}
    </main>
  );
}

export function TasksScreen(p: Screen) {
  const ui = useUi();
  const { tr, say } = ui;
  const lang = ui.lang as Lang;
  const api = agenda(p.session, p.session.ref.userId).tasks;
  const [list, setList] = useState<Task[] | null>(null);
  const [i, setI] = useState(0);

  const item = (all: Task[], k: number) => {
    const x = all[k]!;
    const done = x.done ? ` ${tr('agenda.state.done')}.` : '';
    return (x.dueDay ? tr('tasks.area.itemDue', { n: k + 1, count: all.length, title: x.title, date: dayText(lang, x.dueDay, new Date().getFullYear()) }) : tr('tasks.area.item', { n: k + 1, count: all.length, title: x.title })) + done;
  };

  useEffect(() => {
    void api.list().then(
      (r) => {
        const open = r.tasks.filter((x) => !x.done);
        setList(open);
        ui.earcons.play('screen');
        say(`${tr('agenda.page.tasks')}. ${tr('tasks.area.count', { count: open.length })} ${open.length ? item(open, 0) : tr('tasks.area.empty')}`, 'system');
      },
      () => {
        setList([]);
        say(tr('tasks.area.unavailable'), 'system');
      },
    );
  }, [p.session]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = list?.[i];

  /** Ticked off, or opened again: the task stays in the list until the next, so a mistake is undone right here. */
  async function setDone(x: Task, done: boolean) {
    try {
      const t = await api.done(x.id, done);
      setList((l) => l?.map((y) => (y.id === t.id ? t : y)) ?? l);
      say(tr(done ? 'agenda.doneSaid' : 'agenda.reopenedSaid', { title: t.title }), 'system');
    } catch {
      say(tr('tasks.area.unavailable'), 'system');
    }
  }

  useScreenVoice(
    {
      onIntent: (intent) => {
        if (intent !== 'repeat' || !list) return false;
        say(current ? item(list, i) : tr('tasks.area.empty'), 'system');
        return true;
      },
    },
    [list, i],
  );

  const choices = [
    ...(current
      ? [
          current.done ? { id: 'reopen', label: tr('tasks.area.reopen'), role: 'neutral' as const } : { id: 'done', label: tr('tasks.area.done'), role: 'reminders' as const },
          { id: 'next', label: tr('tasks.area.next'), role: 'neutral' as const },
          { id: 'repeat', label: tr('agenda.area.repeat'), role: 'neutral' as const },
        ]
      : []),
    { id: 'back', label: tr('agenda.area.back'), role: 'nav' as const },
    { id: 'help', label: tr('area.help.label'), role: 'help' as const },
  ];

  return (
    <main className="area-screen" aria-label={tr('agenda.page.tasks')}>
      <header className="topbar">
        <h1 className="topbar-title">{tr('agenda.page.tasks')}</h1>
        <TalkButton />
      </header>
      <div className="onboard-header">
        {current ? (
          <>
            <h2>{current.title}</h2>
            <p>{current.done ? tr('agenda.state.done') : current.dueDay ? tr('agenda.state.due', { date: dayText(lang, current.dueDay, new Date().getFullYear()) }) : tr('agenda.state.open')}</p>
          </>
        ) : (
          list && <p>{tr('tasks.area.empty')}</p>
        )}
      </div>
      {list && (
        <ChoiceGrid
          id={`tasks-${current?.done ? 'done' : 'open'}`}
          config={p.config}
          choices={choices}
          onChoose={(id) => {
            if (id === 'done' && current) void setDone(current, true);
            else if (id === 'reopen' && current) void setDone(current, false);
            else if (id === 'next' && list.length) {
              // What was ticked off leaves the list as the next one is said.
              const left = list.filter((y) => !y.done);
              if (!left.length) {
                setList([]);
                setI(0);
                say(tr('tasks.area.count', { count: 0 }), 'system');
                return;
              }
              const k = left.indexOf(list.slice(i + 1).find((y) => !y.done) ?? left[0]!);
              setList(left);
              setI(k);
              say(item(left, k), 'system');
            } else if (id === 'repeat' && current) say(item(list, i), 'system');
            else if (id === 'back') p.onHome();
            else if (id === 'help') p.onHelp();
          }}
        />
      )}
    </main>
  );
}
