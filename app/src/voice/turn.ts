/**
 * One voice turn to the assistant (docs/plan.md, Appendix B "turns"): the recording as the request body, the answer
 * as NDJSON events read as they arrive. Aborting the request (talk pressed again) ends the turn on the server too.
 */
import type { CommandContext, Intent } from '@ucap/speech-text';
import { uuidv7 } from '@ucap/shared';
import type { Session } from '../identity/account.ts';

export type TurnEvent =
  | { t: 'turn'; id: string }
  | { t: 'transcript'; text: string }
  /** Nothing was said, or (LIVE mode) only the assistant's name. */
  | { t: 'heard'; what: 'nothing' | 'name' }
  | { t: 'leak' }
  | { t: 'command'; intent: Intent }
  | { t: 'ask'; kind: 'help_confirm'; reason: 'help_word' | 'help_near' }
  | { t: 'unmatched' }
  | { t: 'error'; code: 'stt_unavailable' | 'audio' | 'assistant_unavailable' | 'assistant_failed' }
  /**
   * A part of the assistant's answer: its own words, a summary, an original (read word for word), a voice message's
   * automatic transcript, or UCAP's own. `audio`: a recording played after the words (a voice message's original);
   * `source`: the message whose original it is, reported once heard to its end.
   */
  | { t: 'segment'; kind: 'reply' | 'summary' | 'original' | 'transcript' | 'system'; text: string; audio?: string; source?: { message: string } }
  /** An action waiting for the person's yes on this device. */
  | { t: 'action'; id: string; contentHash: string; prompt: string; expiresAt: string }
  | { t: 'ask'; kind: 'help_confirm'; reason: 'assistant' }
  /** `addressed`: meant for the assistant (false: LIVE mode heard something else, and the server dropped it). */
  | { t: 'done'; ms: { stt: number | null; total: number }; audioMs: number | null; addressed?: boolean };

/** Rejects with `unreachable` when the assistant cannot be reached (it is optional: help never needs it). */
export async function postTurn(
  session: Session,
  o: {
    wav?: Uint8Array<ArrayBuffer>;
    text?: string;
    context: CommandContext;
    lang: 'de' | 'en';
    conversation?: string;
    /** LIVE mode (docs/plan-m2.md): heard after the name or a touch, or in the open conversation. */
    live?: 'keyword' | 'named' | 'touch' | 'open';
    /** A change made by voice on this device a moment ago: "Rückgängig" is the device's to undo (L5). */
    undoHere?: boolean;
    signal: AbortSignal;
  },
  onEvent: (e: TurnEvent) => void,
): Promise<void> {
  const id = uuidv7(Date.now());
  const url = `${session.ref.serverUrl}/api/v1/assistant/turns?id=${id}&context=${o.context}&lang=${o.lang}${o.conversation ? `&conversation=${o.conversation}` : ''}${o.live ? `&mode=live&via=${o.live}` : ''}${o.undoHere ? '&undo=device' : ''}`;
  const send = async () =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${await session.accessToken()}`, 'content-type': o.wav ? 'audio/wav' : 'application/json' },
      body: o.wav ?? JSON.stringify({ text: o.text ?? '' }),
      signal: o.signal,
    });
  let res: Response;
  try {
    res = await send();
    // A token the server no longer knows: one fresh proof.
    if (res.status === 401) {
      session.dropToken();
      res = await send();
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error('unreachable');
  }
  if (!res.ok || !res.body) throw new Error(res.status === 401 ? 'unauthorised' : 'unreachable');
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += value;
    let nl = rest.indexOf('\n');
    while (nl >= 0) {
      const line = rest.slice(0, nl).trim();
      rest = rest.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as TurnEvent);
      nl = rest.indexOf('\n');
    }
  }
}
