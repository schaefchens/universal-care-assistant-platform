/**
 * Stand-ins for the AI engines (docs/plan.md, Appendix G "Fakes"), in the test process on 127.0.0.1:8824, reached by
 * the e2e stack's assistant at host.docker.internal:8824 as it reaches the real ones, so its own adapters run:
 * - Ollama's chat API: a scripted model answering in UCAP's reply schema (`say`, `calls`, `help`), streamed;
 * - the transcription API UCAP's whisper server speaks: what the test says was heard, one utterance at a time;
 * - OpenAI's speech API: a quarter second of silence (MP3) for any text.
 * Each can be taken down, and everything they were sent is kept (the phrase canary, ID-02).
 */
import { createServer, type IncomingMessage } from 'node:http';

export interface ChatRequest {
  system: string;
  messages: { role: string; content: string }[];
}

export interface Reply {
  say: { kind: string; text: string; ref: string | null }[];
  calls: Record<string, unknown>[];
  help: boolean;
  /** LIVE mode: whether what was heard without the name was said to the assistant (docs/plan-m2.md). */
  addressed?: boolean;
}

export const reply = (text: string): Reply => ({ say: [{ kind: 'reply', text, ref: null }], calls: [], help: false });

/** Silent MPEG-1 Layer III frames (128 kbit/s, 44.1 kHz, mono): ten of them, a quarter of a second. */
const SILENCE_MP3 = Buffer.concat(Array.from({ length: 10 }, () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0xc4]), Buffer.alloc(413)])));

const body = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (b: Buffer) => parts.push(b));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });

export async function startEngines(port = 8824) {
  const e = {
    /** The model: what it answers to a request (the person's words are the last message). */
    model: (_req: ChatRequest): Reply | 'down' => reply('In Ordnung.'),
    /** What the person says next, one entry per utterance; a voice message gets `voiceMessage`. */
    heard: [] as string[],
    voiceMessage: 'Ich komme morgen um drei vorbei.',
    sttDown: false,
    seen: { chat: [] as ChatRequest[], speech: [] as string[], transcribed: [] as { lang: string | null; text: string }[] },
    /** The text of the last message to the model: the person's words, or the data its tools returned. */
    last: (req: ChatRequest) => req.messages.at(-1)?.content ?? '',
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, v: unknown, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(type === 'application/json' ? JSON.stringify(v) : (v as Buffer));
    };
    try {
      const raw = await body(req);
      // Ollama
      if (url.pathname === '/api/tags') return send(200, { models: [{ name: 'fake' }] });
      if (url.pathname === '/api/generate') return send(200, { done: true });
      if (url.pathname === '/api/chat') {
        const b = JSON.parse(raw.toString()) as { messages: { role: string; content: string }[] };
        const r: ChatRequest = { system: b.messages[0]?.content ?? '', messages: b.messages.slice(1) };
        e.seen.chat.push(r);
        const out = e.model(r);
        if (out === 'down') return req.socket.destroy();
        // Streamed in small pieces, as Ollama does.
        const text = JSON.stringify(out);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (let i = 0; i < text.length; i += 12) res.write(`${JSON.stringify({ message: { content: text.slice(i, i + 12) }, done: false })}\n`);
        return res.end(`${JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 500, eval_count: 40 })}\n`);
      }
      // Speech recognition (the whisper server's API)
      if (url.pathname === '/health') return e.sttDown ? send(503, { ok: false }) : send(200, { ok: true });
      if (url.pathname === '/v1/audio/transcriptions') {
        if (e.sttDown) return req.socket.destroy();
        const form = await new Response(new Uint8Array(raw), { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
        const lang = form.get('language');
        // A turn always names its language; someone else's voice message never does.
        const text = typeof lang === 'string' ? (e.heard.shift() ?? '') : e.voiceMessage;
        e.seen.transcribed.push({ lang: typeof lang === 'string' ? lang : null, text });
        return send(200, { text, segments: text ? [{ no_speech_prob: 0.01, avg_logprob: -0.15, compression_ratio: 1.2 }] : [], engine_ms: 40 });
      }
      // Speech output (OpenAI's API)
      if (url.pathname === '/v1/models') return send(200, { data: [{ id: 'fake-tts' }] });
      if (url.pathname === '/v1/audio/speech') {
        e.seen.speech.push(String((JSON.parse(raw.toString()) as { input?: string }).input ?? ''));
        return send(200, SILENCE_MP3, 'audio/mpeg');
      }
      send(404, {});
    } catch {
      send(500, {});
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
  return Object.assign(e, { close: () => new Promise<void>((ok) => server.close(() => ok())) });
}

export type Engines = Awaited<ReturnType<typeof startEngines>>;
