/**
 * The person's messages (docs/plan.md, S10), in large areas: the next one, the current one again, a reply, back home,
 * and help, which every screen has (Appendix H). Unread messages come first, oldest first, then the newest of each
 * other conversation. Each is introduced by UCAP (who, when, where, on which service: CONCEPT §3), then its original
 * follows in the voice for reading; a voice message's original is its recording. Only an original heard to its end
 * is marked read on Telegram. A reply is dictated and asked about as said (C1), never sent without the person's yes.
 * The message shown is also on screen as text, for partial sight and screen readers.
 */
import type { DeviceConfig } from '@ucap/shared';
import { useContext, useEffect, useRef, useState } from 'react';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { Session } from '../identity/account.ts';
import { useUi } from '../ui.tsx';
import { useScreenVoice } from '../voice/screen.ts';
import { TalkButton, VoiceContext } from '../voice/TalkButton.tsx';
import { keepInFront } from './messages-list.ts';

export interface MessageItem {
  id: string;
  conversationId: string;
  /** The connection it came through: a reply needs that one ready. */
  connectionId: string;
  service: string;
  conversation: string;
  group: boolean;
  from: string;
  outgoing: boolean;
  at: string;
  kind: string;
  text: string;
  fileName: string | null;
  durationS: number | null;
  audio: boolean;
  transcript: string | null;
  transcriptState: string;
  unread: boolean;
  say: { frame: string; text: string };
}

/** Where the person was, so coming back from a reply's question continues there. */
let resume: { id: string; at: number } | null = null;
/** When the screen last introduced itself: React runs the effect twice in development, the person hears it once. */
let introducedAt = 0;

export function MessagesScreen(p: {
  session: Session;
  config: DeviceConfig;
  refresh: number;
  /** Says text in the voice for reading; true when it was said to its end (`isCurrent`: false once another began). */
  read: (text: string, isCurrent: () => boolean) => Promise<boolean>;
  /** Plays a recording (a signed URL of the server); true when it played to its end. */
  play: (url: string) => Promise<boolean>;
  stop: () => void;
  onHome: () => void;
  onHelp: () => void;
  onConnect: () => void;
}) {
  const ui = useUi();
  const { tr, say } = ui;
  const { voice } = useContext(VoiceContext);
  const [items, setItems] = useState<MessageItem[] | null>(null);
  const [state, setState] = useState<'none' | 'ready' | 'not_ready' | 'unavailable'>('ready');
  const [conns, setConns] = useState<{ id: string; name: string; state: string }[]>([]);
  const [i, setI] = useState(0);
  const reading = useRef(0);
  /** What was shown on this visit: a refresh of the queue leads on past it (messages-list.ts). */
  const shownHere = useRef(new Set<string>());
  const current = items?.[i];

  async function readItem(m: MessageItem) {
    const mine = ++reading.current;
    shownHere.current.add(m.id);
    p.stop();
    resume = { id: m.id, at: Date.now() };
    const text = m.say.text ? `${m.say.frame} ${m.say.text}` : m.say.frame;
    const said = p.read(text, () => mine === reading.current);
    let done: boolean;
    if (m.kind === 'voice') {
      // The recording follows the frame: when it was said, or after as long as it takes to say (a speech engine that
      // never tells its end, as in a hidden browser tab, must not hold back the voice message itself).
      await Promise.race([said, new Promise((r) => setTimeout(r, 2000 + text.length * 140))]);
      if (mine !== reading.current) return;
      const a = await p.session.call<{ url?: string; pending?: boolean }>(`/api/v1/messaging/messages/${m.id}/audio`).catch(() => null);
      if (mine !== reading.current) return;
      if (a?.url) done = await p.play(`${p.session.ref.serverUrl}${a.url}`);
      else {
        say(tr(a?.pending ? 'messages.audio.pending' : 'messages.audio.unavailable'), 'system');
        done = false;
      }
    } else done = await said;
    if (mine !== reading.current) return;
    // Heard to its end: now it counts as read, also on Telegram.
    if (done && mine === reading.current && !m.outgoing) await p.session.call('/api/v1/messaging/messages/heard', { method: 'POST', body: { ids: [m.id] } }).catch(() => {});
  }

  const load = async (first: boolean) => {
    try {
      const r = await p.session.call<{ connections: { id: string; service: string; name: string; state: string }[]; items: MessageItem[] }>(`/api/v1/messaging/queue?lang=${ui.lang}`);
      // Ready while one of the person's services is (each message keeps its own service).
      const st = !r.connections.length ? 'none' : r.connections.some((x) => x.state === 'ready') ? 'ready' : 'not_ready';
      setState(st);
      setConns(r.connections);
      // Which services are down, named: "WhatsApp ist gerade nicht verbunden."
      const down = [...new Set(r.connections.filter((x) => x.state !== 'ready').map((x) => x.name))];
      const names = down.length > 1 ? tr('messages.and', { first: down.slice(0, -1).join(', '), last: down.at(-1)! }) : (down[0] ?? '');
      // The message in front stays first (fetched again after a new message, or back from a reply's question), so
      // "Nächste" leads on to the rest, the unread first.
      const keep = first ? (resume && Date.now() - resume.at < 5 * 60_000 ? resume.id : null) : (items?.[i]?.id ?? null);
      if (first) shownHere.current.clear();
      const list = keepInFront(r.items, first ? r.items.find((x) => x.id === keep) : items?.[i], shownHere.current);
      setItems(list);
      setI(0);
      if (!first || Date.now() - introducedAt < 1500) return;
      introducedAt = Date.now();
      ui.earcons.play('screen');
      if (st === 'none') return say(`${tr('messages.title')}. ${tr('messages.notConnected')}`, 'system');
      const unread = r.items.filter((x) => x.unread).length;
      const intro = `${tr('messages.title')}. ${tr('messages.count', { count: unread })}${down.length ? ` ${tr('messages.notReady', { names, count: down.length })}` : ''}`;
      if (!list.length) return say(`${intro} ${tr('messages.empty')}`, 'system');
      // Back from a reply's question: where it was, without reading it again.
      if (keep && list[0]?.id === keep) return say(intro, 'system');
      await ui.sayAndWait(intro, 'system');
      void readItem(list[0]!);
    } catch {
      setItems([]);
      setState('unavailable');
      if (first) say(tr('messages.unavailable'), 'system');
    }
  };
  useEffect(() => {
    void load(true);
    return () => {
      reading.current++;
      p.stop();
    };
  }, [p.session]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (p.refresh) void load(false);
  }, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  function next() {
    if (!items?.length) return say(tr('messages.empty'), 'system');
    if (i + 1 >= items.length) {
      setI(0);
      // Through all of them: the next round goes in the queue's own order again.
      shownHere.current.clear();
      say(tr('messages.noMore'), 'system');
      return;
    }
    setI(i + 1);
    void readItem(items[i + 1]!);
  }

  async function reply() {
    if (!current || current.kind === 'service') return say(tr('messages.reply.none'), 'system');
    const conn = conns.find((x) => x.id === current.connectionId);
    if (conn?.state !== 'ready') return say(tr('messages.reply.notReady', { service: conn?.name ?? tr(`messaging.service.${current.service}`) }), 'system');
    reading.current++;
    p.stop();
    const ok = await ui.sayAndWait(tr('messages.reply.hint', { name: current.conversation }), 'system');
    if (ok) voice?.talk({ context: 'reply', conversation: current.conversationId });
  }

  useScreenVoice(
    {
      onIntent: (intent) => {
        if (intent === 'repeat' && current) void readItem(current);
        else return false;
        return true;
      },
    },
    [current],
  );

  const choices =
    state === 'none'
      ? [
          { id: 'connect', label: tr('messaging.connect'), role: 'messages' as const },
          { id: 'back', label: tr('messages.area.back'), role: 'nav' as const },
          { id: 'help', label: tr('area.help.label'), role: 'help' as const },
        ]
      : [
          { id: 'next', label: tr('messages.area.next'), role: 'messages' as const },
          { id: 'repeat', label: tr('messages.area.repeat'), role: 'neutral' as const },
          { id: 'reply', label: tr('messages.area.reply'), role: 'assistant' as const },
          { id: 'back', label: tr('messages.area.back'), role: 'nav' as const },
          { id: 'help', label: tr('area.help.label'), role: 'help' as const },
        ];

  return (
    <main className="area-screen" aria-label={tr('messages.title')}>
      {/* Talk works here too: "Was hat sie gesagt?", "Lies sie genau vor". */}
      <header className="topbar">
        <h1 className="topbar-title">{tr('messages.title')}</h1>
        <TalkButton />
      </header>
      <div className="onboard-header">
        {current ? (
          <>
            <h2>
              {current.conversation}
              {current.unread ? ` · ${tr('messages.unread')}` : ''}
            </h2>
            <p>{current.say.frame}</p>
            {current.say.text && <p className="note-body">{current.say.text}</p>}
            {current.kind === 'voice' && current.transcriptState === 'done' && current.transcript && (
              <p className="note-body">
                {tr('messages.transcript.label')}: {current.transcript}
              </p>
            )}
          </>
        ) : (
          items && <p>{state === 'none' ? tr('messages.notConnected') : state === 'unavailable' ? tr('messages.unavailable') : tr('messages.empty')}</p>
        )}
      </div>
      {items && (
        <ChoiceGrid
          id={`messages-${state}`}
          config={p.config}
          choices={choices}
          onChoose={(id) => {
            if (id === 'next') next();
            else if (id === 'repeat') {
              if (current) void readItem(current);
              else say(tr('messages.empty'), 'system');
            } else if (id === 'reply') void reply();
            else if (id === 'back') p.onHome();
            else if (id === 'help') p.onHelp();
            else if (id === 'connect') p.onConnect();
          }}
        />
      )}
    </main>
  );
}
