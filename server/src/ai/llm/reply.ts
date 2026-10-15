/**
 * What a language model answers, whichever one it is (docs/plan.md: "Every provider answers JSON in one schema"):
 *
 * - `say`: what UCAP says, each part with its kind: the assistant's own words (`reply`), a summary of the person's
 *   content (`summary`, announced as one), an original read word for word (`original`, with `ref`; its text is
 *   inserted by the server from the source, never retyped by the model: CONCEPT §3, §11; a voice message's original
 *   is its recording), or a voice message's automatic transcript (`transcript`, with `ref`, announced as one);
 * - `calls`: tools to use, each with its own arguments (a read tool's results come back for another round; an
 *   action is prepared, and confirmed where its policy says);
 * - `help`: a person is needed; UCAP then asks whether to send a help request (A17), and never sends on its own.
 *
 * The schema keeps to what Ollama, OpenAI's strict mode and Anthropic's structured outputs all take: every object
 * closed and fully required, no length or number limits (the server checks those).
 */

export interface SayItem {
  /** `transcript`: a voice message's automatic transcript, inserted by the server and announced as one (S10). */
  kind: 'reply' | 'summary' | 'original' | 'transcript';
  text: string;
  ref: string | null;
}

const KINDS = ['reply', 'summary', 'original', 'transcript'];

export interface Call {
  tool: string;
  [arg: string]: unknown;
}

export interface Reply {
  say: SayItem[];
  calls: Call[];
  help: boolean;
}

export type JsonSchema = Record<string, unknown>;

/** The reply schema for these tools (each with its own closed argument object). */
export function replySchema(tools: { name: string; args: Record<string, JsonSchema> }[]): JsonSchema {
  const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: 'null' }] });
  // Calls and help first: the words are written last, knowing what happens, and can be spoken as they come only when
  // nothing does.
  return {
    type: 'object',
    additionalProperties: false,
    required: ['calls', 'help', 'say'],
    properties: {
      calls: {
        type: 'array',
        items: {
          anyOf: tools.map((t) => ({
            type: 'object',
            additionalProperties: false,
            required: ['tool', ...Object.keys(t.args)],
            properties: { tool: { type: 'string', enum: [t.name] }, ...t.args },
          })),
        },
      },
      help: { type: 'boolean' },
      say: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'text', 'ref'],
          properties: { kind: { type: 'string', enum: KINDS }, text: { type: 'string' }, ref: nullable({ type: 'string' }) },
        },
      },
    },
  };
}

/** Whether a reply still being written has already said it uses no tool and asks for no help: then its words can go. */
export function nothingHappens(partial: string): boolean {
  const say = partial.search(/"say"\s*:/);
  if (say < 0) return false;
  const before = partial.slice(0, say);
  return /"calls"\s*:\s*\[\s*\]/.test(before) && /"help"\s*:\s*false/.test(before);
}

/** A reply, if `text` is one: the shape checked; arguments are checked by each tool. */
export function parseReply(text: string): Reply | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const say = Array.isArray(o.say) ? o.say : [];
  const calls = Array.isArray(o.calls) ? o.calls : [];
  const items: SayItem[] = [];
  for (const s of say) {
    if (!s || typeof s !== 'object') return null;
    const x = s as Record<string, unknown>;
    if (!KINDS.includes(String(x.kind)) || typeof x.text !== 'string') return null;
    items.push({ kind: x.kind as SayItem['kind'], text: x.text, ref: typeof x.ref === 'string' ? x.ref : null });
  }
  const cs: Call[] = [];
  for (const c of calls) {
    if (!c || typeof c !== 'object' || typeof (c as Call).tool !== 'string') return null;
    cs.push(c as Call);
  }
  return { say: items, calls: cs, help: o.help === true };
}

/**
 * The `say` items whose text is complete in a reply still being written, so the first sentence can be spoken
 * before the rest is there. Reads only what is certain: items of the `say` array that closed.
 */
export function finishedSay(partial: string): SayItem[] {
  const start = partial.search(/"say"\s*:\s*\[/);
  if (start < 0) return [];
  const out: SayItem[] = [];
  let i = partial.indexOf('[', start) + 1;
  for (;;) {
    while (i < partial.length && /[\s,]/.test(partial[i]!)) i++;
    if (partial[i] !== '{') return out;
    // Find the object's end, minding strings.
    let depth = 0;
    let inString = false;
    let j = i;
    for (; j < partial.length; j++) {
      const ch = partial[j]!;
      if (inString) {
        if (ch === '\\') j++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) break;
    }
    if (j >= partial.length) return out;
    try {
      const x = JSON.parse(partial.slice(i, j + 1)) as Record<string, unknown>;
      if (KINDS.includes(String(x.kind)) && typeof x.text === 'string') out.push({ kind: x.kind as SayItem['kind'], text: x.text, ref: typeof x.ref === 'string' ? x.ref : null });
    } catch {
      return out;
    }
    i = j + 1;
  }
}
