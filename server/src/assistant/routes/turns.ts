/**
 * Voice turns over HTTP (docs/plan.md, Appendix B "turns"): one POST per turn, the audio as its body (16 kHz mono WAV)
 * or `{text}` as JSON, answered as NDJSON, one event per line as it happens. The app aborting the request (talk
 * pressed again) stops the turn and its recognition call. The query holds names only (the turn's id, its context and
 * language), never words.
 */
import { Readable } from 'node:stream';
import Type from 'typebox';
import type { Llm } from '../../ai/llm/service.ts';
import type { Stt } from '../../ai/stt/service.ts';
import { auth, requireAuth } from '../../core/auth.ts';
import { AppError } from '../../lib/errors.ts';
import type { AnyApp } from '../../lib/http.ts';
import { MAX_TURN_MS, type TurnEvent, type Turns } from '../turns.ts';

const Query = Type.Object({
  id: Type.String({ format: 'uuid' }),
  context: Type.Union([Type.Literal('global'), Type.Literal('confirm'), Type.Literal('reminder'), Type.Literal('dictation'), Type.Literal('reply')]),
  lang: Type.Union([Type.Literal('de'), Type.Literal('en')]),
  /** A reply's conversation (context `reply`). */
  conversation: Type.Optional(Type.String({ format: 'uuid' })),
});

/** 16 kHz × 2 bytes × the longest turn, and a little. */
const AUDIO_LIMIT = Math.ceil((MAX_TURN_MS / 1000 + 2) * 32_000) + 1024;

export function registerTurnRoutes(app: AnyApp, o: { turns: Turns; stt: Stt; llm?: Llm }) {
  void app.register(async (scope) => {
    scope.addContentTypeParser('audio/wav', { parseAs: 'buffer', bodyLimit: AUDIO_LIMIT }, (_req, body, done) => done(null, body));

    scope.post('/api/v1/assistant/turns', { preHandler: requireAuth, bodyLimit: AUDIO_LIMIT, schema: { querystring: Query } }, async (req, reply) => {
      const a = auth(req);
      const q = req.query as { id: string; context: 'global' | 'confirm' | 'reminder' | 'dictation' | 'reply'; lang: 'de' | 'en'; conversation?: string };
      const body = req.body as Buffer | { text?: unknown } | undefined;
      let audio: Uint8Array<ArrayBuffer> | undefined;
      let text: string | undefined;
      if (Buffer.isBuffer(body)) audio = new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
      else if (body && typeof body.text === 'string' && body.text.length <= 1000) text = body.text;
      else throw new AppError('bad_request', { params: { reason: 'turn' } });

      const abort = new AbortController();
      // The app went away before the answer was complete: the turn stops.
      reply.raw.on('close', () => !reply.raw.writableFinished && abort.abort());
      const lines: string[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      const emit = (e: TurnEvent) => {
        lines.push(`${JSON.stringify(e)}\n`);
        wake?.();
      };
      void o.turns.run({ userId: a.userId, deviceId: a.deviceId, id: q.id, context: q.context, lang: q.lang, conversation: q.conversation, audio, text, signal: abort.signal }, emit).finally(() => {
        finished = true;
        wake?.();
      });
      const stream = Readable.from(
        (async function* () {
          for (;;) {
            while (lines.length) yield lines.shift()!;
            if (finished) return;
            await new Promise<void>((r) => (wake = r));
            wake = null;
          }
        })(),
      );
      return reply.header('content-type', 'application/x-ndjson').header('cache-control', 'no-store').header('x-accel-buffering', 'no').send(stream);
    });
  });

  // The app's warm-up when the talk area is first touched: whether voice input can work now (nothing is sent), and
  // the dialogue model loading meanwhile.
  app.post('/api/v1/assistant/warmup', { preHandler: requireAuth }, async (req) => {
    void o.llm?.warm();
    return { voice: await o.stt.ready(auth(req).userId) };
  });
}
