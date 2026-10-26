/**
 * Appointments and tasks of one person (docs/plan-m3.md, K7): the person's own, or those of someone a helper supports
 * with agenda.manage ("Termine und Aufgaben verwalten"), who never sees what the person marked private. Listing,
 * entering, changing and deleting, with undo right after each (CONCEPT §8: "reversible"); an appointment is read back
 * as it was stored ("Termin gespeichert: …"). These are the pages for screen readers and keyboards.
 */
import { appointmentReadback, appointmentWhen, dayText, type Lang, reminderWhen, remindersText, weekdayName } from '@ucap/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, CheckboxGroup, Form, Heading, Input, Label, TextArea, TextField } from 'react-aria-components';
import { agenda, type Appointment, type AppointmentFields, type Task, type TaskFields } from '../agenda/api.ts';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

type Tr = ReturnType<typeof useUi>['tr'];

/** Reminder choices: at the time, a quarter of an hour, an hour, a day before; for a whole day, its morning or the day before. */
const TIMED = [0, 15, 60, 1440];
const ALL_DAY = [0, 1440];

function errorText(tr: Tr, e: unknown): string {
  if (!(e instanceof ApiError)) return tr('error.internal');
  const reason = e.params.reason;
  if (e.code === 'conflict' && reason === 'stale') return tr('error.conflict');
  if (e.code === 'bad_request' && typeof reason === 'string' && ['title', 'day', 'time', 'weekdays', 'reminders', 'duration'].includes(reason)) return tr(`agenda.error.${reason}`);
  return tr(`error.${e.code}`);
}

function Field(p: { label: string; value: string; onChange: (v: string) => void; type?: string; autoFocus?: boolean; multiline?: boolean }) {
  return (
    <TextField value={p.value} onChange={p.onChange} className="field" autoComplete="off" autoFocus={p.autoFocus}>
      <Label>{p.label}</Label>
      {p.multiline ? <TextArea rows={3} /> : <Input type={p.type ?? 'text'} />}
    </TextField>
  );
}

function Problem(p: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (p.text) ref.current?.focus();
  }, [p.text]);
  return p.text ? (
    <p ref={ref} tabIndex={-1} role="alert" className="status warning">
      {p.text}
    </p>
  ) : null;
}

function AppointmentEditor(p: { initial: Appointment | null; own: boolean; onSave: (f: AppointmentFields) => Promise<string | null>; onCancel: () => void }) {
  const { tr, lang } = useUi();
  const i = p.initial;
  const [title, setTitle] = useState(i?.title ?? '');
  const [day, setDay] = useState(i?.day ?? new Date().toISOString().slice(0, 10));
  const [allDay, setAllDay] = useState(i ? i.time === null : false);
  const [time, setTime] = useState(i?.time ?? '10:00');
  const [duration, setDuration] = useState(i?.durationMin ? String(i.durationMin) : '');
  const [place, setPlace] = useState(i?.place ?? '');
  const [note, setNote] = useState(i?.note ?? '');
  const [weekdays, setWeekdays] = useState<string[]>((i?.weekdays ?? []).map(String));
  const [remind, setRemind] = useState<string[]>((i?.remindBefore ?? [60]).map(String));
  const [priv, setPriv] = useState(i?.private ?? false);
  const [error, setError] = useState('');
  const choices = allDay ? ALL_DAY : TIMED;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const f: AppointmentFields = {
      title,
      day,
      time: allDay ? null : time,
      durationMin: duration.trim() ? Number(duration) : null,
      weekdays: weekdays.length ? weekdays.map(Number) : null,
      place: place.trim() || null,
      note: note.trim() || null,
      // Only the choices this kind of appointment offers.
      remindBefore: remind.map(Number).filter((m) => choices.includes(m)),
      ...(p.own ? { private: priv } : {}),
    };
    setError((await p.onSave(f)) ?? '');
  }

  return (
    <Form onSubmit={(e) => void submit(e)} className="stack">
      <Field label={tr('agenda.field.title')} value={title} onChange={setTitle} autoFocus />
      <Field label={tr('agenda.field.day')} type="date" value={day} onChange={setDay} />
      <Checkbox className="choice-option checkbox" isSelected={allDay} onChange={setAllDay}>
        {tr('agenda.field.allDay')}
      </Checkbox>
      {!allDay && <Field label={tr('agenda.field.time')} type="time" value={time} onChange={setTime} />}
      {!allDay && <Field label={tr('agenda.field.duration')} type="number" value={duration} onChange={setDuration} />}
      <Field label={tr('agenda.field.place')} value={place} onChange={setPlace} />
      <Field label={tr('agenda.field.note')} value={note} onChange={setNote} multiline />
      <CheckboxGroup className="choice" value={weekdays} onChange={setWeekdays}>
        <Label className="choice-label">{tr('agenda.field.weekly')}</Label>
        {[1, 2, 3, 4, 5, 6, 7].map((w) => (
          <Checkbox key={w} value={String(w)} className="choice-option checkbox">
            {weekdayName(lang as Lang, w)}
          </Checkbox>
        ))}
      </CheckboxGroup>
      <CheckboxGroup className="choice" value={remind} onChange={setRemind}>
        <Label className="choice-label">{tr('agenda.field.remind')}</Label>
        {choices.map((m) => (
          <Checkbox key={m} value={String(m)} className="choice-option checkbox">
            {reminderWhen(lang as Lang, m, allDay)}
          </Checkbox>
        ))}
      </CheckboxGroup>
      {p.own && (
        <Checkbox className="choice-option checkbox" isSelected={priv} onChange={setPriv}>
          {tr('agenda.field.private')}
        </Checkbox>
      )}
      <Problem text={error} />
      <div className="row">
        <Button type="submit" className="button primary" isDisabled={!title.trim() || !day}>
          {tr('agenda.save')}
        </Button>
        <Button className="button" onPress={p.onCancel}>
          {tr('agenda.cancel')}
        </Button>
      </div>
    </Form>
  );
}

function TaskEditor(p: { initial: Task | null; own: boolean; onSave: (f: TaskFields) => Promise<string | null>; onCancel: () => void }) {
  const { tr } = useUi();
  const i = p.initial;
  const [title, setTitle] = useState(i?.title ?? '');
  const [due, setDue] = useState(i?.dueDay ?? '');
  const [note, setNote] = useState(i?.note ?? '');
  const [priv, setPriv] = useState(i?.private ?? false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError((await p.onSave({ title, dueDay: due || null, note: note.trim() || null, ...(p.own ? { private: priv } : {}) })) ?? '');
  }

  return (
    <Form onSubmit={(e) => void submit(e)} className="stack">
      <Field label={tr('agenda.field.task')} value={title} onChange={setTitle} autoFocus />
      <Field label={tr('agenda.field.due')} type="date" value={due} onChange={setDue} />
      <Field label={tr('agenda.field.note')} value={note} onChange={setNote} multiline />
      {p.own && (
        <Checkbox className="choice-option checkbox" isSelected={priv} onChange={setPriv}>
          {tr('agenda.field.privateTask')}
        </Checkbox>
      )}
      <Problem text={error} />
      <div className="row">
        <Button type="submit" className="button primary" isDisabled={!title.trim()}>
          {tr('agenda.save')}
        </Button>
        <Button className="button" onPress={p.onCancel}>
          {tr('agenda.cancel')}
        </Button>
      </div>
    </Form>
  );
}

/** What a page says and shows of a change, and "Rückgängig" right after it. */
function usePageState() {
  const ui = useUi();
  const [status, setStatus] = useState('');
  const tell = (text: string) => {
    setStatus(text);
    ui.say(text, 'system');
  };
  return { ui, status, tell };
}

export function AppointmentsPage(p: { session: Session; personId: string; personName: string | null; refresh: number; onClose: () => void }) {
  const { ui, status, tell } = usePageState();
  const { tr, form } = ui;
  const lang = ui.lang as Lang;
  const api = agenda(p.session, p.personId).appointments;
  const own = p.personId === p.session.ref.userId;
  // A helper hears whom it reminds: "Ich erinnere Clara eine Stunde vorher."
  const of = own ? undefined : (p.personName ?? undefined);
  const [list, setList] = useState<Appointment[] | null>(null);
  const [editing, setEditing] = useState<Appointment | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Appointment | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const year = new Date().getFullYear();

  const load = async () => {
    try {
      setList((await api.list()).appointments);
    } catch (e) {
      tell(errorText(tr, e));
    }
  };
  useEffect(() => {
    void load();
  }, [p.personId, p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(f: AppointmentFields): Promise<string | null> {
    try {
      const a = editing === 'new' || !editing ? await api.create(f) : await api.update(editing.id, editing.version, f);
      setEditing(null);
      setLast(a.id);
      // Read back from what was stored.
      tell(appointmentReadback(lang, form, a, year, of));
      await load();
      return null;
    } catch (err) {
      const text = errorText(tr, err);
      ui.say(text, 'system');
      return text;
    }
  }

  async function remove(a: Appointment) {
    setDeleting(null);
    try {
      await api.remove(a.id);
      setLast(a.id);
      tell(tr('agenda.deleted.appointment', { title: a.title }));
    } catch (e) {
      tell(errorText(tr, e));
    }
    await load();
  }

  async function undo() {
    if (!last) return;
    try {
      await api.undo(last);
      setLast(null);
      tell(tr('agenda.undone'));
    } catch (e) {
      tell(errorText(tr, e));
    }
    await load();
  }

  return (
    <main className="page agenda">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{own ? tr('agenda.page.appointments') : tr('agenda.page.appointmentsOf', { name: p.personName ?? '' })}</h1>
      </header>
      <p role="status" className="status">
        {status}
      </p>
      {last && !editing && (
        <Button className="button" onPress={() => void undo()}>
          {tr('agenda.undo')}
        </Button>
      )}
      {editing ? (
        <section className="settings-section">
          <h2>{editing === 'new' ? tr('agenda.new.appointment') : tr('agenda.edit.appointment', { title: editing.title })}</h2>
          <AppointmentEditor initial={editing === 'new' ? null : editing} own={own} onSave={save} onCancel={() => setEditing(null)} />
        </section>
      ) : (
        <section className="settings-section">
          {list && list.length === 0 && <p>{tr('agenda.none.appointments')}</p>}
          <ul className="device-list">
            {(list ?? []).map((a) => (
              <li key={a.id} className="device">
                <Heading level={2} className="device-name">
                  {a.title}
                </Heading>
                <p>
                  {appointmentWhen(lang, a, year)}
                  {a.nextAt === null ? ` · ${tr('agenda.over')}` : ''}
                </p>
                {a.place && <p>{a.place}</p>}
                {a.remindBefore.length > 0 && <p>{remindersText(lang, form, a, of)}</p>}
                {a.note && <p className="muted">{a.note}</p>}
                {(a.private || a.fromMessage) && <p className="muted">{[a.private ? tr('agenda.private') : '', a.fromMessage ? tr('agenda.fromMessage') : ''].filter(Boolean).join(' · ')}</p>}
                <p className="muted">{tr('agenda.changedBy', { name: a.updatedBy.displayName })}</p>
                {deleting?.id === a.id ? (
                  <div className="stack">
                    <p role="alert">{tr('agenda.delete.confirm.appointment', { title: a.title })}</p>
                    <div className="row">
                      <Button className="button danger" onPress={() => void remove(a)}>
                        {tr('agenda.delete.yes')}
                      </Button>
                      <Button className="button" onPress={() => setDeleting(null)}>
                        {tr('agenda.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="row">
                    <Button className="button" onPress={() => setEditing(a)}>
                      {tr('agenda.change')}
                    </Button>
                    <Button className="button" onPress={() => setDeleting(a)}>
                      {tr('agenda.delete')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Button className="button primary" onPress={() => setEditing('new')}>
            {tr('agenda.add.appointment')}
          </Button>
        </section>
      )}
    </main>
  );
}

export function TasksPage(p: { session: Session; personId: string; personName: string | null; refresh: number; onClose: () => void }) {
  const { ui, status, tell } = usePageState();
  const { tr } = ui;
  const lang = ui.lang as Lang;
  const api = agenda(p.session, p.personId).tasks;
  const own = p.personId === p.session.ref.userId;
  const [list, setList] = useState<Task[] | null>(null);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const year = new Date().getFullYear();

  const load = async () => {
    try {
      setList((await api.list()).tasks);
    } catch (e) {
      tell(errorText(tr, e));
    }
  };
  useEffect(() => {
    void load();
  }, [p.personId, p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(f: TaskFields): Promise<string | null> {
    try {
      const t = editing === 'new' || !editing ? await api.create(f) : await api.update(editing.id, editing.version, f);
      setEditing(null);
      setLast(t.id);
      tell(t.dueDay ? tr('agenda.saved.taskDue', { title: t.title, date: dayText(lang, t.dueDay, year) }) : tr('agenda.saved.task', { title: t.title }));
      await load();
      return null;
    } catch (err) {
      const text = errorText(tr, err);
      ui.say(text, 'system');
      return text;
    }
  }

  async function setDone(t: Task, done: boolean) {
    try {
      await api.done(t.id, done);
      setLast(t.id);
      tell(tr(done ? 'agenda.doneSaid' : 'agenda.reopenedSaid', { title: t.title }));
    } catch (e) {
      tell(errorText(tr, e));
    }
    await load();
  }

  async function remove(t: Task) {
    setDeleting(null);
    try {
      await api.remove(t.id);
      setLast(t.id);
      tell(tr('agenda.deleted.task', { title: t.title }));
    } catch (e) {
      tell(errorText(tr, e));
    }
    await load();
  }

  async function undo() {
    if (!last) return;
    try {
      await api.undo(last);
      setLast(null);
      tell(tr('agenda.undone'));
    } catch (e) {
      tell(errorText(tr, e));
    }
    await load();
  }

  return (
    <main className="page agenda">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{own ? tr('agenda.page.tasks') : tr('agenda.page.tasksOf', { name: p.personName ?? '' })}</h1>
      </header>
      <p role="status" className="status">
        {status}
      </p>
      {last && !editing && (
        <Button className="button" onPress={() => void undo()}>
          {tr('agenda.undo')}
        </Button>
      )}
      {editing ? (
        <section className="settings-section">
          <h2>{editing === 'new' ? tr('agenda.new.task') : tr('agenda.edit.task', { title: editing.title })}</h2>
          <TaskEditor initial={editing === 'new' ? null : editing} own={own} onSave={save} onCancel={() => setEditing(null)} />
        </section>
      ) : (
        <section className="settings-section">
          {list && list.length === 0 && <p>{tr('agenda.none.tasks')}</p>}
          <ul className="device-list">
            {(list ?? []).map((t) => (
              <li key={t.id} className="device">
                <Heading level={2} className="device-name">
                  {t.title}
                </Heading>
                <p>
                  {t.done ? tr('agenda.state.done') : t.dueDay ? tr('agenda.state.due', { date: dayText(lang, t.dueDay, year) }) : tr('agenda.state.open')}
                </p>
                {t.note && <p className="muted">{t.note}</p>}
                {(t.private || t.fromMessage) && <p className="muted">{[t.private ? tr('agenda.private') : '', t.fromMessage ? tr('agenda.fromMessage') : ''].filter(Boolean).join(' · ')}</p>}
                <p className="muted">{tr('agenda.changedBy', { name: t.updatedBy.displayName })}</p>
                {deleting?.id === t.id ? (
                  <div className="stack">
                    <p role="alert">{tr('agenda.delete.confirm.task', { title: t.title })}</p>
                    <div className="row">
                      <Button className="button danger" onPress={() => void remove(t)}>
                        {tr('agenda.delete.yes')}
                      </Button>
                      <Button className="button" onPress={() => setDeleting(null)}>
                        {tr('agenda.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="row">
                    <Button className="button" onPress={() => void setDone(t, !t.done)}>
                      {t.done ? tr('agenda.reopen') : tr('agenda.done')}
                    </Button>
                    <Button className="button" onPress={() => setEditing(t)}>
                      {tr('agenda.change')}
                    </Button>
                    <Button className="button" onPress={() => setDeleting(t)}>
                      {tr('agenda.delete')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Button className="button primary" onPress={() => setEditing('new')}>
            {tr('agenda.add.task')}
          </Button>
        </section>
      )}
    </main>
  );
}
