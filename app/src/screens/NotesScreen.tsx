/**
 * The person's notes (docs/plan.md, S9: "notes with screen and tools"), in large areas: read the current one out in
 * the voice for reading, go to the next, dictate a new one, back home, and help (every screen has it: Appendix H). Reading needs only the server's core, so it
 * works with the assistant stopped; a new note is dictated through the assistant ("Notiere: …"). The note shown is
 * also on screen as text, for partial sight and screen readers.
 */
import type { DeviceConfig } from '@ucap/shared';
import { useContext, useEffect, useRef, useState } from 'react';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { Session } from '../identity/account.ts';
import { useUi } from '../ui.tsx';
import { TalkButton, VoiceContext } from '../voice/TalkButton.tsx';

interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

export function NotesScreen(p: { session: Session; config: DeviceConfig; read: (text: string) => void; onHome: () => void; onHelp: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const { voice } = useContext(VoiceContext);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [i, setI] = useState(0);
  const { state } = useContext(VoiceContext);
  const dictated = useRef(false);
  const date = (iso: string) => new Intl.DateTimeFormat(ui.lang === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'long' }).format(new Date(iso));
  const item = (list: Note[], k: number) => tr('notes.item', { n: k + 1, count: list.length, title: list[k]!.title, date: date(list[k]!.updatedAt) });

  const reload = () => p.session.call<{ notes: Note[] }>('/api/v1/notes').then((r) => setNotes(r.notes), () => {});
  // A note dictated here: the list shows it once the turn is done, newest first.
  useEffect(() => {
    if (state !== 'idle' || !dictated.current) return;
    dictated.current = false;
    setI(0);
    void reload();
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void p.session.call<{ notes: Note[] }>('/api/v1/notes').then(
      (r) => {
        setNotes(r.notes);
        ui.earcons.play('screen');
        say(`${tr('notes.title')}. ${tr('notes.count', { count: r.notes.length })} ${r.notes.length ? item(r.notes, 0) : tr('notes.empty')}`, 'system');
      },
      () => {
        setNotes([]);
        say(tr('notes.unavailable'), 'system');
      },
    );
  }, [p.session]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = notes?.[i];
  return (
    <main className="area-screen" aria-label={tr('notes.title')}>
      <header className="topbar">
        <h1 className="topbar-title">{tr('notes.title')}</h1>
        <TalkButton />
      </header>
      <div className="onboard-header">
        {current ? (
          <>
            <h2>
              {current.title} · {date(current.updatedAt)}
            </h2>
            <p className="note-body">{current.body}</p>
          </>
        ) : (
          notes && <p>{tr('notes.empty')}</p>
        )}
      </div>
      {notes && (
        <ChoiceGrid
          id="notes"
          config={p.config}
          choices={[
            ...(current
              ? [
                  { id: 'read', label: tr('notes.area.read'), role: 'notes' as const },
                  { id: 'next', label: tr('notes.area.next'), role: 'neutral' as const },
                ]
              : []),
            { id: 'new', label: tr('notes.area.new'), role: 'assistant' as const },
            { id: 'back', label: tr('notes.area.back'), role: 'nav' as const },
            // Every screen has a way to help that needs no speech (Appendix H).
            { id: 'help', label: tr('area.help.label'), role: 'help' as const },
          ]}
          onChoose={(id) => {
            // The title is often the note's first words: then the note alone.
            if (id === 'read' && current) p.read(current.body.startsWith(current.title) ? current.body : `${current.title}. ${current.body}`);
            else if (id === 'next' && notes.length) {
              const k = (i + 1) % notes.length;
              setI(k);
              say(item(notes, k), 'system');
            } else if (id === 'new') {
              // The hint first, then listening; what is said is the note.
              void ui.sayAndWait(tr('notes.dictate'), 'system').then(() => {
                dictated.current = true;
                voice?.talk({ context: 'dictation' });
              });
            } else if (id === 'back') p.onHome();
            else if (id === 'help') p.onHelp();
          }}
        />
      )}
    </main>
  );
}
