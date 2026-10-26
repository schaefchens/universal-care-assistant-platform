/**
 * The person's messages (docs/plan.md, S10), in large areas: the next one, the current one again, a reply, the rest
 * marked read (in UCAP only, asked first), back home, and help, which every screen has (Appendix H). Unread messages come first, oldest first, then the newest of each
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
import { keepInFront, nextIndex } from './messages-list.ts';

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
  /** `quote`: an email's quoted part, named by its first line ("Darunter zitiert: …"). */
  say: { frame: string; text: string; quote?: string };
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
  /** How many are new (the area "Rest gelesen" is there while some are). */
  const [unread, setUnread] = useState(0);
  /** "Rest gelesen" asked: how many the server counted, by its time then, which the mark takes. */
  const [askingRest, setAskingRest] = useState<{ unread: number; asOf: string } | null>(null);
  const reading = useRef(0);
  /** What was shown on this visit: a refresh of the queue leads on past it (messages-list.ts). */
  const shownHere = useRef(new Set<string>());
  const current = items?.[i];
  /**
   * The message in front as it is now, for a fetch that comes back later: state seen by the fetch's own render could
   * be from before the screen had a list, and the queue as the server has it then (a message just heard among the
   * newest, an unread one first) would take its place without a word (seen on the emulator on 2026-10-22).
   */
  const front = useRef<MessageItem | undefined>(undefined);
  front.current = current;
  /** The refreshes counted before the screen opened are no reason to fetch again: it fetches as it opens. */
  const refreshAtOpen = useRef(p.refresh);

  async function readItem(m: MessageItem) {
    const mine = ++reading.current;
    shownHere.current.add(m.id);
    p.stop();
    resume = { id: m.id, at: Date.now() };
    const text = [m.say.frame, m.say.text, m.say.quote].filter(Boolean).join(' ');
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
      const r = await p.session.call<{ connections: { id: string; service: string; name: string; state: string }[]; items: MessageItem[]; unread?: number }>(`/api/v1/messaging/queue?lang=${ui.lang}`);
      setUnread(r.unread ?? r.items.filter((x) => x.unread).length);
      // Ready while one of the person's services is (each message keeps its own service).
      const st = !r.connections.length ? 'none' : r.connections.some((x) => x.state === 'ready') ? 'ready' : 'not_ready';
      setState(st);
      setConns(r.connections);
      // Which services are down, named: "WhatsApp ist gerade nicht verbunden."
      const down = [...new Set(r.connections.filter((x) => x.state !== 'ready').map((x) => x.name))];
      const names = down.length > 1 ? tr('messages.and', { first: down.slice(0, -1).join(', '), last: down.at(-1)! }) : (down[0] ?? '');
      // The message in front stays first (fetched again after a new message, or back from a reply's question), so
      // "Nächste" leads on to the rest, the unread first.
      const keep = first ? (resume && Date.now() - resume.at < 5 * 60_000 ? resume.id : null) : (front.current?.id ?? null);
      if (first) shownHere.current.clear();
      const list = keepInFront(r.items, first ? r.items.find((x) => x.id === keep) : front.current, shownHere.current);
      setItems(list);
      setI(0);
      if (!first || Date.now() - introducedAt < 1500) return;
      introducedAt = Date.now();
      ui.earcons.play('screen');
      if (st === 'none') return say(`${tr('messages.title')}. ${tr('messages.notConnected')}`, 'system');
      // All of them: the list holds the oldest 30.
      const unread = r.unread ?? r.items.filter((x) => x.unread).length;
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
    if (p.refresh !== refreshAtOpen.current) void load(false);
  }, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  function next() {
    if (!items?.length) return say(tr('messages.empty'), 'system');
    // Through all of them: the last one stays in front ("Wiederholen" says it again), nothing starts over.
    const n = nextIndex(items, i, shownHere.current);
    if (n === null) return say(tr('messages.noMore'), 'system');
    setI(n);
    void readItem(items[n]!);
  }

  /**
   * "Rest gelesen": asked first, with how many are new now (counted afresh: one heard meanwhile is no longer new);
   * then those marked read in UCAP only (the owner, 2026-10-26).
   */
  async function askRest() {
    reading.current++;
    p.stop();
    try {
      const r = await p.session.call<{ unread: number; asOf: string }>('/api/v1/messaging/unread');
      setUnread(r.unread);
      if (!r.unread) return say(tr('messages.rest.none'), 'system');
      setAskingRest(r);
      say(tr('messages.rest.confirm', { count: r.unread }), 'system');
    } catch {
      say(tr('messages.unavailable'), 'system');
    }
  }
  async function markRest() {
    const asked = askingRest;
    setAskingRest(null);
    if (!asked) return;
    try {
      const r = await p.session.call<{ count: number }>('/api/v1/messaging/messages/read-rest', { method: 'POST', body: { before: asked.asOf } });
      say(tr('messages.rest.done', { count: r.count }), 'system');
      await load(false);
    } catch {
      say(tr('messages.unavailable'), 'system');
    }
  }
  const keepRest = () => {
    setAskingRest(null);
    say(tr('messages.rest.kept'), 'system');
  };

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
      ...(askingRest ? { context: 'confirm' as const } : {}),
      onIntent: (intent) => {
        if (askingRest && intent === 'yes') void markRest();
        else if (askingRest && (intent === 'no' || intent === 'stop')) keepRest();
        else if (askingRest && intent === 'repeat') say(tr('messages.rest.confirm', { count: askingRest.unread }), 'system');
        else if (intent === 'repeat' && current) void readItem(current);
        else return false;
        return true;
      },
    },
    [current, askingRest],
  );

  const choices =
    state === 'none'
      ? [
          { id: 'connect', label: tr('messaging.connect'), role: 'messages' as const },
          { id: 'back', label: tr('messages.area.back'), role: 'nav' as const },
          { id: 'help', label: tr('area.help.label'), role: 'help' as const },
        ]
      : askingRest
        ? [
            { id: 'rest.yes', label: tr('messages.rest.yes'), role: 'messages' as const },
            { id: 'rest.no', label: tr('messages.rest.no'), role: 'nav' as const },
            { id: 'help', label: tr('area.help.label'), role: 'help' as const },
          ]
        : [
            { id: 'next', label: tr('messages.area.next'), role: 'messages' as const },
            { id: 'repeat', label: tr('messages.area.repeat'), role: 'neutral' as const },
            { id: 'reply', label: tr('messages.area.reply'), role: 'assistant' as const },
            // While some are new: the rest marked read at once, without hearing them.
            ...(unread > 0 ? [{ id: 'rest', label: tr('messages.area.rest'), role: 'neutral' as const }] : []),
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
            {current.say.quote && <p className="muted">{current.say.quote}</p>}
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
          id={`messages-${state}${askingRest ? '-rest' : ''}`}
          config={p.config}
          choices={choices}
          onChoose={(id) => {
            if (id === 'next') next();
            else if (id === 'repeat') {
              if (current) void readItem(current);
              else say(tr('messages.empty'), 'system');
            } else if (id === 'reply') void reply();
            else if (id === 'rest') void askRest();
            else if (id === 'rest.yes') void markRest();
            else if (id === 'rest.no') keepRest();
            else if (id === 'back') p.onHome();
            else if (id === 'help') p.onHelp();
            else if (id === 'connect') p.onConnect();
          }}
        />
      )}
    </main>
  );
}
