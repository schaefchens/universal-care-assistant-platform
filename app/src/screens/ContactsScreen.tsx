/**
 * The person's contacts in large areas (docs/plan-m3.md, K6: "By voice and on screens: … areas, and a page for screen
 * readers"): the contact shown is read out with its numbers digit by digit, the next one, a call (which number when
 * there are several, then asked first: "Anna anrufen, Handy?"; dialled directly where the person allowed calls, else
 * in the dialler), back, and help (every screen has it: Appendix H). Reading needs only the server's core, so it works
 * with the assistant stopped. The contact shown is on screen as text too, for partial sight and screen readers.
 */
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useRef, useState } from 'react';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import { type Contact, type ContactHandle, contacts } from '../contacts/api.ts';
import { canCall, placeCall } from '../contacts/call.ts';
import type { Session } from '../identity/account.ts';
import { useUi } from '../ui.tsx';
import { useScreenVoice } from '../voice/screen.ts';
import { TalkButton } from '../voice/TalkButton.tsx';

/** A contact's numbers: its phone numbers and its number on WhatsApp, each once. */
const numbersOf = (c: Contact): ContactHandle[] =>
  c.handles.filter((h, i, a) => (h.kind === 'phone' || h.kind === 'whatsapp') && a.findIndex((x) => (x.kind === 'phone' || x.kind === 'whatsapp') && x.value === h.value) === i);

type Mode = { kind: 'list' } | { kind: 'pick' } | { kind: 'confirm'; number: ContactHandle; question: string };

export function ContactsScreen(p: { session: Session; config: DeviceConfig; onHome: () => void; onHelp: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [list, setList] = useState<Contact[] | null>(null);
  const [i, setI] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const asking = useRef(false);

  const item = (all: Contact[], k: number) => tr('contacts.area.item', { n: k + 1, count: all.length, name: all[k]!.name });
  /** Its name, each number digit by digit and each address, by their labels: what the assistant says of it too. */
  const aloud = (c: Contact) => {
    const parts = [
      ...numbersOf(c).map((h) => `${h.label ?? tr('contacts.kind.phone')}: ${h.spoken ?? h.display}`),
      ...c.handles.filter((h) => h.kind === 'email').map((h) => `${h.label ?? tr('contacts.kind.email')}: ${h.value}`),
    ];
    return parts.length ? `${c.name}. ${parts.join('. ')}.` : tr('contacts.spoken.none', { name: c.name });
  };

  useEffect(() => {
    void contacts(p.session, p.session.ref.userId)
      .list()
      .then(
        (r) => {
          setList(r.contacts);
          ui.earcons.play('screen');
          say(`${tr('contacts.page.own')}. ${tr('contacts.area.count', { count: r.contacts.length })} ${r.contacts.length ? item(r.contacts, 0) : tr('contacts.area.empty')}`, 'system');
        },
        () => {
          setList([]);
          say(tr('contacts.area.unavailable'), 'system');
        },
      );
  }, [p.session]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = list?.[i];
  const numbers = current ? numbersOf(current) : [];

  const ask = (c: Contact, h: ContactHandle) => {
    // Said with which number, where it has a label or the contact has more than one (as the assistant asks).
    const which = h.label ?? (numbersOf(c).length > 1 ? (h.spoken ?? h.display) : null);
    const question = which ? tr('contacts.call.askWhich', { name: c.name, which }) : tr('contacts.call.ask', { name: c.name });
    setMode({ kind: 'confirm', number: h, question });
    ui.earcons.play('confirm');
    say(question, 'system');
  };
  const yes = async () => {
    if (mode.kind !== 'confirm' || !current || asking.current) return;
    asking.current = true;
    setMode({ kind: 'list' });
    await placeCall(ui, { number: mode.number.value, name: current.name });
    asking.current = false;
  };
  const no = () => {
    setMode({ kind: 'list' });
    say(tr('contacts.call.notCalled'), 'system');
  };

  useScreenVoice(
    {
      ...(mode.kind === 'confirm' ? { context: 'confirm' as const } : {}),
      onIntent: (intent) => {
        if (mode.kind === 'confirm' && intent === 'yes') void yes();
        else if (mode.kind === 'confirm' && (intent === 'no' || intent === 'stop')) no();
        else if (intent === 'repeat' && mode.kind === 'confirm') say(mode.question, 'system');
        else if (intent === 'repeat' && current) say(aloud(current), 'system');
        else return false;
        return true;
      },
    },
    [mode, current],
  );

  const choices =
    mode.kind === 'confirm'
      ? [
          { id: 'yes', label: tr('assistant.action.yes'), role: 'contacts' as const },
          { id: 'no', label: tr('assistant.action.no'), role: 'nav' as const },
        ]
      : mode.kind === 'pick'
        ? [
            ...numbers.map((h, k) => ({ id: `number-${k}`, label: h.label ?? h.display, role: 'contacts' as const })),
            { id: 'back', label: tr('contacts.area.back'), role: 'nav' as const },
            { id: 'help', label: tr('area.help.label'), role: 'help' as const },
          ]
        : [
            ...(current
              ? [
                  { id: 'read', label: tr('contacts.area.read'), role: 'contacts' as const },
                  { id: 'next', label: tr('contacts.area.next'), role: 'neutral' as const },
                  // Only where this device can call, and the contact has a number to call.
                  ...(canCall() && numbers.length ? [{ id: 'call', label: tr('contacts.area.call'), role: 'assistant' as const }] : []),
                ]
              : []),
            { id: 'back', label: tr('contacts.area.back'), role: 'nav' as const },
            // Every screen has a way to help that needs no speech (Appendix H).
            { id: 'help', label: tr('area.help.label'), role: 'help' as const },
          ];

  return (
    <main className="area-screen" aria-label={tr('contacts.page.own')}>
      <header className="topbar">
        <h1 className="topbar-title">{mode.kind === 'confirm' ? mode.question : mode.kind === 'pick' && current ? tr('contacts.area.pick', { name: current.name }) : tr('contacts.page.own')}</h1>
        <TalkButton />
      </header>
      <div className="onboard-header">
        {current ? (
          <>
            <h2>{current.name}</h2>
            <ul className="contact-handles">
              {current.handles
                .filter((h) => h.kind !== 'telegram')
                .map((h) => (
                  <li key={`${h.kind}:${h.value}`}>
                    {tr(`contacts.kind.${h.kind}`)}
                    {h.label ? ` (${h.label})` : ''}: {h.display}
                  </li>
                ))}
            </ul>
          </>
        ) : (
          list && <p>{tr('contacts.area.empty')}</p>
        )}
      </div>
      {list && (
        <ChoiceGrid
          id={`contacts-${mode.kind}`}
          config={p.config}
          choices={choices}
          onChoose={(id) => {
            if (id === 'yes') void yes();
            else if (id === 'no') no();
            else if (id === 'read' && current) say(aloud(current), 'system');
            else if (id === 'next' && list.length) {
              const k = (i + 1) % list.length;
              setI(k);
              say(item(list, k), 'system');
            } else if (id === 'call' && current) {
              if (numbers.length === 1) ask(current, numbers[0]!);
              else {
                setMode({ kind: 'pick' });
                say(tr('contacts.area.pick', { name: current.name }), 'system');
              }
            } else if (id.startsWith('number-') && current) ask(current, numbers[Number(id.slice(7))]!);
            else if (id === 'back') {
              if (mode.kind === 'pick') setMode({ kind: 'list' });
              else p.onHome();
            } else if (id === 'help') p.onHelp();
          }}
        />
      )}
    </main>
  );
}
