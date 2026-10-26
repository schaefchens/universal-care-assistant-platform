/**
 * Reminders of one person (docs/plan.md, S6): the person's own, or those of someone a helper supports. A list (what,
 * when, next time, who made it), changing, pausing and deleting, a new one, and the answers ("Anna hat angegeben:
 * getrunken"), always as what the person reported (CONCEPT §9). The person keeps control of every reminder of
 * theirs; a helper needs reminders.manage to change them and reminders.responses.read to see answers.
 */
import type { Schedule } from '@ucap/shared';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Button, Checkbox, CheckboxGroup, Form, Heading, Input, Label, Radio, RadioGroup, Switch, TextField } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { CATEGORIES, type Category, type Reminder, type ReminderFields, type ResponseRow, reminders } from '../reminders/api.ts';
import { responseText, scheduleText, titleOf } from '../reminders/words.ts';
import { useUi } from '../ui.tsx';

type Kind = Schedule['kind'];
const DAYS = [1, 2, 3, 4, 5, 6, 7];

interface Draft {
  title: string;
  prompt: string;
  category: Category;
  kind: Kind;
  date: string;
  time: string;
  times: string;
  days: string[];
  everyMinutes: string;
  from: string;
  until: string;
  repeatCount: string;
  repeatEveryMin: string;
  snoozeMin: string;
  followUp: boolean;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function draftFrom(r: Reminder | null): Draft {
  const s = r?.schedule;
  return {
    title: r?.title ?? '',
    prompt: r?.prompt ?? '',
    category: r?.category ?? 'drink',
    kind: s?.kind ?? 'daily',
    date: s?.kind === 'once' ? s.date : today(),
    time: s?.kind === 'once' ? s.time : '15:00',
    times: s?.kind === 'daily' ? s.times.join(', ') : '08:00, 15:00',
    days: (s && s.kind !== 'once' ? s.days : DAYS).map(String),
    everyMinutes: s?.kind === 'interval' ? String(s.everyMinutes) : '120',
    from: s?.kind === 'interval' ? s.from : '08:00',
    until: s?.kind === 'interval' ? s.until : '20:00',
    repeatCount: String(r?.repeatCount ?? 2),
    repeatEveryMin: String(r?.repeatEveryMin ?? 10),
    snoozeMin: String(r?.snoozeMin ?? 15),
    followUp: (r?.followUp ?? 'helpers') === 'helpers',
  };
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** The form's fields as the server takes them, or the key of what is wrong. */
export function fieldsFrom(d: Draft): ReminderFields | { error: string } {
  // Left empty: the person's device names the category and asks its question, in the person's own language and form
  // of address (du or Sie), whoever writes the reminder.
  const title = d.title.trim();
  const prompt = d.prompt.trim();
  const days = d.days.map(Number).sort();
  let schedule: Schedule;
  if (d.kind === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !HHMM.test(d.time)) return { error: 'reminder.error.time' };
    schedule = { kind: 'once', date: d.date, time: d.time };
  } else if (d.kind === 'daily') {
    const times = [...new Set(d.times.split(/[,;\s]+/).filter(Boolean).map((t) => (t.length === 4 ? `0${t}` : t)))].sort();
    if (!times.length || !times.every((t) => HHMM.test(t))) return { error: 'reminder.error.time' };
    if (!days.length) return { error: 'reminder.error.days' };
    schedule = { kind: 'daily', times, days };
  } else {
    if (!HHMM.test(d.from) || !HHMM.test(d.until) || d.from > d.until) return { error: 'reminder.error.time' };
    if (!days.length) return { error: 'reminder.error.days' };
    schedule = { kind: 'interval', everyMinutes: Number(d.everyMinutes), from: d.from, until: d.until, days };
  }
  return {
    title,
    prompt,
    category: d.category,
    schedule,
    repeatCount: Number(d.repeatCount),
    repeatEveryMin: Number(d.repeatEveryMin),
    snoozeMin: Number(d.snoozeMin),
    followUp: d.followUp ? 'helpers' : 'none',
  };
}

function Choice(p: { label: string; value: string; options: { id: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <RadioGroup className="choice" value={p.value} onChange={p.onChange}>
      <Label className="choice-label">{p.label}</Label>
      {p.options.map((o) => (
        <Radio key={o.id} value={o.id} className="choice-option">
          {o.label}
        </Radio>
      ))}
    </RadioGroup>
  );
}

function Field(p: { label: string; value: string; onChange: (v: string) => void; type?: string; description?: string }) {
  return (
    <TextField value={p.value} onChange={p.onChange} className="field" autoComplete="off">
      <Label>{p.label}</Label>
      <Input type={p.type ?? 'text'} />
      {p.description && <p className="muted">{p.description}</p>}
    </TextField>
  );
}

function Editor(p: { initial: Reminder | null; onSave: (f: ReminderFields) => Promise<void>; onCancel: () => void }) {
  const { tr } = useUi();
  const [d, setD] = useState<Draft>(() => draftFrom(p.initial));
  const [error, setError] = useState('');
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const opts = (values: number[], key: string) => values.map((n) => ({ id: String(n), label: tr(key, { n }) }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const f = fieldsFrom(d);
    if ('error' in f) return setError(tr(f.error));
    setError('');
    await p.onSave(f);
  }

  return (
    <Form onSubmit={submit} className="stack reminder-editor">
      <Choice label={tr('reminder.field.category')} value={d.category} options={CATEGORIES.map((c) => ({ id: c, label: tr(`reminder.category.${c}`) }))} onChange={(v) => set({ category: v as Category })} />
      <Field label={tr('reminder.field.title')} value={d.title} onChange={(title) => set({ title })} description={tr('reminder.field.title.hint', { example: tr(`reminder.category.${d.category}`) })} />
      <Field label={tr('reminder.field.prompt')} value={d.prompt} onChange={(prompt) => set({ prompt })} description={tr('reminder.field.prompt.hint', { example: tr(`reminder.defaultPrompt.${d.category}`) })} />
      <Choice
        label={tr('reminder.field.when')}
        value={d.kind}
        options={(['once', 'daily', 'interval'] as const).map((k) => ({ id: k, label: tr(`reminder.kind.${k}`) }))}
        onChange={(v) => set({ kind: v as Kind })}
      />
      {d.kind === 'once' && (
        <>
          <Field label={tr('reminder.field.date')} type="date" value={d.date} onChange={(date) => set({ date })} />
          <Field label={tr('reminder.field.time')} type="time" value={d.time} onChange={(time) => set({ time })} />
        </>
      )}
      {d.kind === 'daily' && <Field label={tr('reminder.field.times')} value={d.times} onChange={(times) => set({ times })} description={tr('reminder.field.times.hint')} />}
      {d.kind === 'interval' && (
        <>
          <Choice label={tr('reminder.field.every')} value={d.everyMinutes} options={opts([30, 60, 90, 120, 180, 240], 'reminder.every')} onChange={(everyMinutes) => set({ everyMinutes })} />
          <Field label={tr('reminder.field.from')} type="time" value={d.from} onChange={(from) => set({ from })} />
          <Field label={tr('reminder.field.until')} type="time" value={d.until} onChange={(until) => set({ until })} />
        </>
      )}
      {d.kind !== 'once' && (
        <CheckboxGroup className="choice" value={d.days} onChange={(days) => set({ days })}>
          <Label className="choice-label">{tr('reminder.field.days')}</Label>
          {DAYS.map((x) => (
            <Checkbox key={x} value={String(x)} className="choice-option checkbox">
              {tr(`reminder.weekdayLong.${x}`)}
            </Checkbox>
          ))}
        </CheckboxGroup>
      )}
      <Choice label={tr('reminder.field.repeatCount')} value={d.repeatCount} options={opts([0, 1, 2, 3], 'reminder.repeatCount')} onChange={(repeatCount) => set({ repeatCount })} />
      <Choice label={tr('reminder.field.repeatEvery')} value={d.repeatEveryMin} options={opts([5, 10, 15, 30], 'reminder.minutes')} onChange={(repeatEveryMin) => set({ repeatEveryMin })} />
      <Choice label={tr('reminder.field.snooze')} value={d.snoozeMin} options={opts([5, 10, 15, 30, 60], 'reminder.minutes')} onChange={(snoozeMin) => set({ snoozeMin })} />
      <Switch className="switch" isSelected={d.followUp} onChange={(followUp) => set({ followUp })}>
        <span className="switch-indicator" aria-hidden />
        {tr('reminder.field.followUp')}
      </Switch>
      <div className="row">
        <Button type="submit" className="button primary">
          {tr('reminder.save')}
        </Button>
        <Button className="button" onPress={p.onCancel}>
          {tr('devices.cancel')}
        </Button>
      </div>
      <p role="status" className="status error">
        {error}
      </p>
    </Form>
  );
}

export function RemindersPage(p: { session: Session; personId: string; personName: string | null; canManage: boolean; canRead: boolean; refresh: number; onClose: () => void; children?: ReactNode }) {
  const ui = useUi();
  const { tr, say } = ui;
  const api = reminders(p.session, p.personId);
  const [list, setList] = useState<Reminder[] | null>(null);
  const [answers, setAnswers] = useState<ResponseRow[]>([]);
  const [editing, setEditing] = useState<Reminder | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Reminder | null>(null);
  const [status, setStatus] = useState('');
  const own = p.personId === p.session.ref.userId;
  const who = p.personName ?? '';

  const load = async () => {
    try {
      setList((await api.list()).reminders);
      if (p.canRead) setAnswers((await api.responses()).responses);
    } catch (e) {
      setStatus(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  };
  useEffect(() => {
    void load();
  }, [p.personId, p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  async function run(f: () => Promise<unknown>, done: string) {
    try {
      await f();
      tell(done);
    } catch (e) {
      tell(tr(e instanceof ApiError && e.code === 'conflict' ? 'reminder.error.stale' : `error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
    await load();
  }
  const when = (iso: string) => new Date(iso).toLocaleString(ui.lang, { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <main className="page reminders">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{own ? tr('reminder.page.own') : tr('reminder.page.of', { name: who })}</h1>
      </header>
      <p role="status" className="status">
        {status}
      </p>
      {editing ? (
        <section className="settings-section">
          <h2>{editing === 'new' ? tr('reminder.new') : tr('reminder.edit', { title: titleOf(tr, editing) })}</h2>
          <Editor
            initial={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSave={async (f) => {
              const e = editing;
              setEditing(null);
              await run(() => (e === 'new' ? api.create(f) : api.update(e.id, e.version, f)), tr('reminder.saved', { title: titleOf(tr, f), when: scheduleText(tr, ui.lang, f.schedule) }));
            }}
          />
        </section>
      ) : (
        <section className="settings-section">
          {list && list.length === 0 && <p>{tr('reminder.none')}</p>}
          <ul className="device-list">
            {(list ?? []).map((r) => (
              <li key={r.id} className={`device${r.active ? '' : ' paused'}`}>
                <Heading level={2} className="device-name">
                  {titleOf(tr, r)}
                </Heading>
                <p>{scheduleText(tr, ui.lang, r.schedule)}</p>
                <p className="muted">
                  {[
                    r.active ? (r.nextAt ? tr('reminder.next', { when: when(r.nextAt) }) : null) : tr('reminder.paused'),
                    r.createdBy.id !== p.personId && r.createdBy.displayName ? tr('reminder.by', { name: r.createdBy.displayName }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {r.appointmentId && <p className="muted">{tr('reminder.ofAppointment')}</p>}
                {p.canManage &&
                  !r.appointmentId &&
                  (deleting?.id === r.id ? (
                    <div className="stack">
                      <p role="alert">{tr('reminder.delete.confirm', { title: titleOf(tr, r) })}</p>
                      <div className="row">
                        <Button
                          className="button danger"
                          onPress={() => {
                            setDeleting(null);
                            void run(() => api.remove(r.id), tr('reminder.deleted', { title: titleOf(tr, r) }));
                          }}
                        >
                          {tr('reminder.delete.yes')}
                        </Button>
                        <Button className="button" onPress={() => setDeleting(null)}>
                          {tr('devices.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="row">
                      <Button className="button" onPress={() => setEditing(r)}>
                        {tr('reminder.change')}
                      </Button>
                      <Button className="button" onPress={() => void run(() => api.setActive(r.id, !r.active), tr(r.active ? 'reminder.pausedNow' : 'reminder.resumedNow', { title: titleOf(tr, r) }))}>
                        {tr(r.active ? 'reminder.pause' : 'reminder.resume')}
                      </Button>
                      <Button className="button" onPress={() => setDeleting(r)}>
                        {tr('reminder.delete')}
                      </Button>
                    </div>
                  ))}
              </li>
            ))}
          </ul>
          {p.canManage && (
            <Button className="button primary" onPress={() => setEditing('new')}>
              {tr('reminder.new')}
            </Button>
          )}
        </section>
      )}
      {p.canRead && !editing && (
        <section className="settings-section">
          <h2>{tr('reminder.responses')}</h2>
          <p className="muted">{tr('reminder.responses.note')}</p>
          {answers.length === 0 && <p>{tr('reminder.responses.none')}</p>}
          <ul className="history">
            {answers.map((a) => (
              <li key={a.occurrenceId}>
                {when(a.dueAt)} · {titleOf(tr, a)} · {responseText(tr, own ? null : who, a)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {p.children}
    </main>
  );
}
