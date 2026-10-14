/**
 * What the assistant can do with the person's messages (docs/plan.md, S10; Appendix E; CONCEPT §3):
 *
 * | Tool | Kind | Confirmation |
 * |---|---|---|
 * | messages.overview, messages.read, messages.search | read: the messages come back as untrusted data with their sender, service and time, and the turn is tainted | – |
 * | messages.send | act: UCAP reads the whole message back with its recipient and service (C1), warns when the recipient is no contact | always |
 *
 * A message is marked read on the service only when the person heard its original, never because the model read it.
 * The model never confirms: the person's yes comes from their device.
 */
import { t } from '@ucap/shared';
import type { JsonSchema } from '../ai/llm/reply.ts';
import { type ActTool, type ReadTool, type ToolContext, ToolError } from '../assistant/tools.ts';
import { type Item, type Messaging, SERVICE_NAMES, whenSaid } from './service.ts';

/** The longest message UCAP sends (Telegram's own limit is 4096). */
export const MAX_TEXT = 4000;

const str = (description: string): JsonSchema => ({ type: 'string', description });
const nullableStr = (description: string): JsonSchema => ({ anyOf: [{ type: 'string', description }, { type: 'null' }] });
const tr = (ctx: ToolContext, key: string, params: Record<string, string> = {}) => t(ctx.lang, key, params, ctx.form);

function messaging(ctx: ToolContext): Messaging {
  if (!ctx.messaging) throw new ToolError('messaging_not_connected');
  return ctx.messaging;
}

/** Text as it may be sent: no direction overrides or invisible characters (Appendix E), trimmed. */
export function cleanText(s: string): string {
  return s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim();
}

/** A message as data for the model: who, when, what; a voice message's automatic transcript marked as such. */
function asData(ctx: ToolContext, i: Item) {
  return {
    ref: `msg:${i.id}`,
    chat: i.conversation,
    from: i.outgoing ? (ctx.lang === 'de' ? 'du selbst' : 'you') : i.from,
    when: whenSaid(ctx.lang, ctx.timezone, new Date(i.at), ctx.now),
    kind: i.kind,
    text: i.text,
    ...(i.fileName ? { file: i.fileName } : {}),
    ...(i.durationS ? { seconds: i.durationS } : {}),
    ...(i.kind === 'voice' ? { transcript: i.transcriptState === 'done' ? { text: i.transcript, automatic: true } : null } : {}),
    unread: i.unread,
  };
}

async function chatOf(ctx: ToolContext, to: unknown) {
  if (typeof to !== 'string' || !to.trim()) throw new ToolError('chat_missing');
  const r = await messaging(ctx).find(ctx.userId, to, { forSending: false });
  if (!r) throw new ToolError('chat_unknown');
  if ('ambiguous' in r) throw new ToolError(`chat_ambiguous: ${r.ambiguous.join(', ')}`);
  return r;
}

export const MESSAGE_TOOLS: (ReadTool | ActTool)[] = [
  {
    kind: 'read',
    name: 'messages.overview',
    description:
      "The person's conversations on Telegram, those with unread messages first: who, how many unread, when the last message came, whether it waits for a reply, a saved draft. For \"Habe ich neue Nachrichten?\", \"Wer hat geschrieben?\", \"Welche Unterhaltungen warten auf eine Antwort?\".",
    args: {},
    async run(ctx) {
      const list = await messaging(ctx).overview(ctx.userId, 10);
      return {
        data: {
          service: 'Telegram',
          conversations: list.map((c) => ({
            ref: `chat:${c.id}`,
            name: c.name,
            ...(c.group ? { group: true } : {}),
            unread: c.unread,
            last: c.lastAt ? whenSaid(ctx.lang, ctx.timezone, new Date(c.lastAt), ctx.now) : null,
            waitingForReply: c.waitingForReply,
            ...(c.draft ? { draft: c.draft } : {}),
            ...(c.muted ? { muted: true } : {}),
          })),
        },
      };
    },
  },
  {
    kind: 'read',
    name: 'messages.read',
    description:
      'Messages, oldest first: of one conversation, or (chat null) of all of them. Each with its ref, conversation, sender, time, kind and text (a voice message with its automatic transcript, if there is one). "Lies meine neuen Nachrichten": chat null, unread_only true. To read one out word for word, say it as kind "original" with its ref; the original of a voice message is its recording.',
    args: { chat: nullableStr('The conversation, as "chat:<id>", or the name of the person or group; null for all.'), unread_only: { type: 'boolean', description: 'Only messages not read yet.' } },
    async run(ctx, args) {
      const unreadOnly = args.unread_only === true;
      if (args.chat === null || args.chat === undefined || args.chat === '') {
        const list = await messaging(ctx).everywhere(ctx.userId, { unreadOnly, limit: unreadOnly ? 20 : 10 });
        return { data: { service: 'Telegram', messages: list.map((i) => asData(ctx, i)) } };
      }
      const c = await chatOf(ctx, args.chat);
      const list = await messaging(ctx).conversation(ctx.userId, c.conversationId, { limit: unreadOnly ? 20 : 10, unreadOnly });
      return {
        data: { chat: { ref: `chat:${c.conversationId}`, name: c.name, service: SERVICE_NAMES[c.service] }, messages: list.map((i) => asData(ctx, i)) },
        focus: { chat: { id: c.conversationId, title: c.name } },
      };
    },
  },
  {
    kind: 'read',
    name: 'messages.search',
    description:
      'Searches all messages for words, optionally only those with one person or group: for "Finde die Nachricht über den Besuch morgen", "Was hat Michael über das Wochenende geschrieben?". Newest first.',
    args: {
      query: str('The words to search for; empty for the newest messages.'),
      person: nullableStr('Whose messages: the other person or group (never the one you talk with), or null for all.'),
    },
    async run(ctx, args) {
      const found = await messaging(ctx).search(ctx.userId, typeof args.query === 'string' ? args.query : '', typeof args.person === 'string' ? args.person : null);
      return { data: { service: 'Telegram', messages: found.map((i) => asData(ctx, i)) } };
    },
  },
  {
    kind: 'act',
    name: 'messages.send',
    description:
      'Sends a message on Telegram in a conversation: the words the person dictated or agreed to, exactly as they should arrive. UCAP reads the whole message back with its recipient and asks the person before sending; it says itself when Telegram confirmed it.',
    args: { chat: str('The conversation, as "chat:<id>", or the name of the person or group.'), text: str('The message, as it should be sent.') },
    async prepare(ctx, args) {
      if (typeof args.chat !== 'string' || !args.chat.trim()) throw new ToolError('chat_missing');
      const r = await messaging(ctx).find(ctx.userId, args.chat, { forSending: true });
      if (!r) throw new ToolError('chat_unknown');
      if ('ambiguous' in r) throw new ToolError(`chat_ambiguous: ${r.ambiguous.join(', ')}`);
      const text = cleanText(typeof args.text === 'string' ? args.text : '');
      if (!text) throw new ToolError('text_missing');
      if (text.length > MAX_TEXT) throw new ToolError('text_too_long');
      const ask = tr(ctx, 'messages.C1', { recipient: r.name, service: SERVICE_NAMES[r.service], text });
      // Someone renamed "Maria (Tochter)" is still not Maria: a stranger's chat is named as such (Appendix E).
      const confirm = r.contact === false ? `${tr(ctx, 'messages.C1.notContact', { name: r.name })} ${ask}` : ask;
      return { args: { conversationId: r.conversationId, recipient: r.name, text }, confirm };
    },
    async run(ctx, args) {
      const out = await messaging(ctx).send({ userId: ctx.userId, deviceId: ctx.deviceId, actionId: ctx.actionId ?? null, conversationId: String(args.conversationId), text: String(args.text) });
      return { say: tr(ctx, out === 'attempting' ? 'messages.C2' : 'messages.C9'), focus: { chat: { id: String(args.conversationId), title: String(args.recipient) } } };
    },
    async cancelled(ctx, args, why) {
      await ctx.messaging?.keepDraft(ctx.userId, String(args.conversationId), String(args.text));
      return tr(ctx, why === 'silence' ? 'messages.C8' : 'messages.C7');
    },
  },
];
