/**
 * What the assistant can do with the person's messages (docs/plan.md, S10; Appendix E; docs/plan-m3.md; CONCEPT §3),
 * across all the services they connected:
 *
 * | Tool | Kind | Confirmation |
 * |---|---|---|
 * | messages.overview, messages.read, messages.search | read: the messages come back as untrusted data with their sender, service and time, and the turn is tainted | – |
 * | messages.connections | read: each connection and what it can do (Appendix K), for "Was kann WhatsApp hier?" | – |
 * | messages.send | act: UCAP reads the whole message back with its recipient and service (C1; an email with its subject), warns when the recipient is no contact | always |
 *
 * A reply goes back on the service its conversation is on. A name found on several services goes where that person
 * last wrote lately; otherwise UCAP says which services, and the model asks the person (CONCEPT §2: "a focused
 * clarification rather than a guess"). Someone in the person's contacts with no conversation gets a new message (K6),
 * to their number, address or Telegram id: a new email with a subject the model proposes, read back in C1. A message is
 * marked read on its service only when the person heard its original, never because the model read it. The model
 * never confirms: the person's yes comes from their device.
 */
import { quoteHeader, t } from '@ucap/shared';
import type { JsonSchema } from '../ai/llm/reply.ts';
import { type ActTool, type ReadTool, type ToolContext, ToolError } from '../assistant/tools.ts';
import { type Found, type Item, type Messaging, serviceName, whenSaid } from './service.ts';
import { isServerService, type Service } from './services.ts';

/** The longest message UCAP sends (Telegram's own limit is 4096). */
export const MAX_TEXT = 4000;
/** An email's subject, as long as UCAP writes one. */
const MAX_SUBJECT = 200;

const str = (description: string): JsonSchema => ({ type: 'string', description });
const nullableStr = (description: string): JsonSchema => ({ anyOf: [{ type: 'string', description }, { type: 'null' }] });
const tr = (ctx: ToolContext, key: string, params: Record<string, string> = {}) => t(ctx.lang, key, params, ctx.form);

function messaging(ctx: ToolContext): Messaging {
  if (!ctx.messaging) throw new ToolError('messaging_not_connected');
  return ctx.messaging;
}

/** Text as it may be sent: no direction overrides or invisible characters (Appendix E), trimmed. */
export function cleanText(s: string): string {
  return s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').trim();
}

const PREFIX = /^((re|aw|antw|antwort|wg|fwd?|tr|sv|vs)(\[\d+\])?:\s*)+/i;
/** A subject as a thread's topic: what replies and forwards put before it, case and spaces aside. */
const topic = (s: string) => s.replace(PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * A reply's subject: the thread's with "Re: " before it (once), or the person's own, as the model wrote it. The model
 * often repeats the thread's subject without "Re: " (seen on the emulator, 2026-10-22): that is the thread's, and a
 * reply keeps "Re: ".
 */
export function replySubject(threadSubject: string | null, written: string | null): string {
  const thread = cleanText(threadSubject ?? '');
  const own = cleanText(written ?? '');
  if (own && topic(own) !== topic(thread)) return own.slice(0, MAX_SUBJECT);
  return (PREFIX.test(thread) ? thread : `Re: ${thread}`).slice(0, MAX_SUBJECT);
}

/** A message as data for the model: who, when, what, on which service; a voice message's automatic transcript marked as such. */
function asData(ctx: ToolContext, i: Item) {
  return {
    ref: `msg:${i.id}`,
    service: serviceName(i.service, i.label),
    chat: i.conversation,
    from: i.outgoing ? (ctx.lang === 'de' ? 'du selbst' : 'you') : i.from,
    when: whenSaid(ctx.lang, ctx.timezone, new Date(i.at), ctx.now),
    kind: i.kind,
    ...(i.subject ? { subject: i.subject } : {}),
    text: i.text,
    // An email's quoted part, by its first line: the new text is what it says.
    ...(i.quoted && quoteHeader(i.quoted) ? { quotes: quoteHeader(i.quoted) } : {}),
    ...(i.fileName ? { file: i.fileName } : {}),
    ...(i.durationS ? { seconds: i.durationS } : {}),
    ...(i.kind === 'voice' ? { transcript: i.transcriptState === 'done' ? { text: i.transcript, automatic: true } : null } : {}),
    // A preview is all UCAP knows of that conversation (CONCEPT §3).
    ...(i.service === 'notifications' ? { preview: true } : {}),
    unread: i.unread,
    // The person's own message reached the other side's phone (an SMS delivery report).
    ...(i.delivered ? { delivered: true } : {}),
  };
}

/**
 * One conversation, never a guess: several people who fit are named back, one person on several services is asked
 * about. For sending, also a contact with no conversation yet (K6), whose numbers or addresses are asked about when
 * there are several.
 */
async function conversationOf(ctx: ToolContext, to: unknown, o: { forSending: boolean; service?: unknown; address?: unknown }): Promise<Found> {
  if (typeof to !== 'string' || !to.trim()) throw new ToolError('chat_missing');
  const r = await messaging(ctx).find(ctx.userId, to, { forSending: o.forSending, service: typeof o.service === 'string' ? o.service : null, address: typeof o.address === 'string' ? o.address : null });
  if (!r) throw new ToolError(typeof o.service === 'string' && o.service.trim() ? 'chat_unknown_on_service' : 'chat_unknown');
  if ('ambiguous' in r) throw new ToolError(`chat_ambiguous: ${r.ambiguous.join(', ')}`);
  if ('services' in r) throw new ToolError(`service_ambiguous: ${r.services.join(', ')}`);
  if ('addresses' in r) throw new ToolError(`address_ambiguous: ${r.addresses.join(', ')}`);
  return r;
}

const C1: Partial<Record<Service, string>> = { email: 'messages.C1.email', sms: 'messages.C1.sms', notifications: 'messages.C1.preview' };

export const MESSAGE_TOOLS: (ReadTool | ActTool)[] = [
  {
    kind: 'read',
    name: 'messages.overview',
    description:
      "The person's conversations on all their connected services, each with its service, those with unread messages first: who, how many unread, when the last message came, whether it waits for a reply, a saved draft. For \"Habe ich neue Nachrichten?\", \"Wer hat geschrieben?\", \"Welche Unterhaltungen warten auf eine Antwort?\".",
    args: {},
    async run(ctx) {
      const list = await messaging(ctx).overview(ctx.userId, 10);
      return {
        data: {
          conversations: list.map((c) => ({
            ref: `chat:${c.id}`,
            name: c.name,
            service: c.serviceName,
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
      'Messages, oldest first: of one conversation, or (chat null) of all of them. Each with its ref, service, conversation, sender, time, kind and text (a voice message with its automatic transcript, if there is one; an email with its subject, and the first line of what it quotes). "Lies meine neuen Nachrichten": chat null, unread_only true. To read one out word for word, say it as kind "original" with its ref; the original of a voice message is its recording.',
    args: {
      chat: nullableStr('The conversation, as "chat:<id>", or the name of the person or group; null for all.'),
      unread_only: { type: 'boolean', description: 'Only messages not read yet.' },
      service: nullableStr('Only on this service, when the person named one ("Telegram", "WhatsApp", "E-Mail", "SMS", an app); else null.'),
    },
    async run(ctx, args) {
      const unreadOnly = args.unread_only === true;
      if (args.chat === null || args.chat === undefined || args.chat === '') {
        const list = await messaging(ctx).everywhere(ctx.userId, { unreadOnly, limit: unreadOnly ? 20 : 10 });
        return { data: { messages: list.map((i) => asData(ctx, i)) } };
      }
      const c = await conversationOf(ctx, args.chat, { forSending: false, service: args.service });
      if (!c.conversationId) throw new ToolError('chat_unknown');
      const list = await messaging(ctx).conversation(ctx.userId, c.conversationId, { limit: unreadOnly ? 20 : 10, unreadOnly });
      return {
        data: { chat: { ref: `chat:${c.conversationId}`, name: c.name, service: serviceName(c.service, c.label) }, messages: list.map((i) => asData(ctx, i)) },
        focus: { chat: { id: c.conversationId, title: c.name } },
      };
    },
  },
  {
    kind: 'read',
    name: 'messages.search',
    description:
      'Searches all messages on every service for words, optionally only those with one person or group: for "Finde die Nachricht über den Besuch morgen", "Was hat Michael über das Wochenende geschrieben?". Newest first.',
    args: {
      query: str('The words to search for; empty for the newest messages.'),
      person: nullableStr('Whose messages: the other person or group (never the one you talk with), or null for all.'),
    },
    async run(ctx, args) {
      const found = await messaging(ctx).search(ctx.userId, typeof args.query === 'string' ? args.query : '', typeof args.person === 'string' ? args.person : null);
      return { data: { messages: found.map((i) => asData(ctx, i)) } };
    },
  },
  {
    kind: 'read',
    name: 'messages.connections',
    description:
      'The person\'s messaging connections and what each can do: its service; whether it is connected now; how much history UCAP has (since: messages from historySince on, fetched when it was linked, and all that came after, nothing older; previews: only what the app\'s notifications showed, no history); whom it sends to (any: any address or number; contacts: the conversations there are, and anew to anyone in the person\'s contacts with a number or address; conversations: the conversations there are; replies: only as a reply to a notification that came; none); what "sent" means (service: the service confirmed it; server: the mail server accepted it; network: the phone network accepted it; app: the other app shows it as sent). For "Was kann WhatsApp hier?", "Kannst du auch SMS schicken?".',
    args: {},
    async run(ctx) {
      const list = await messaging(ctx).connections(ctx.userId, ctx.lang);
      return {
        data: {
          connections: list.map((c) => ({
            service: c.name,
            ...(c.service === 'email' ? { account: c.account } : {}),
            connected: c.state === 'ready',
            history: c.capabilities.history,
            ...(c.historySince ? { historySince: c.historySince.slice(0, 10) } : {}),
            sends: c.capabilities.send,
            sent: c.capabilities.sent,
            voiceMessages: c.capabilities.voice,
          })),
        },
      };
    },
  },
  {
    kind: 'act',
    name: 'messages.send',
    description:
      'Sends a message in a conversation, on the service the conversation is on, or a new one to someone in the person\'s contacts (to their number, address or Telegram id): the words the person dictated or agreed to, exactly as they should arrive. UCAP reads the whole message back with its recipient and service and asks the person before sending; it says itself when the service confirmed it.',
    args: {
      chat: str('The conversation, as "chat:<id>", or the name of the person or group.'),
      text: str('The message, as it should be sent.'),
      service: nullableStr('The service, when the person named one ("auf WhatsApp", "per SMS", "per E-Mail"); else null.'),
      subject: nullableStr("An email's subject: for a new email (UCAP answers subject_missing), a short one you propose from the message; in a thread only when the person wants their own, else null for the thread's (\"Re: …\")."),
      address: nullableStr('Which of the contact\'s numbers or addresses, when UCAP asked (address_ambiguous): as UCAP named it ("Handy"); else null.'),
    },
    async prepare(ctx, args) {
      const r = await conversationOf(ctx, args.chat, { forSending: true, service: args.service, address: args.address });
      const text = cleanText(typeof args.text === 'string' ? args.text : '');
      if (!text) throw new ToolError('text_missing');
      if (text.length > MAX_TEXT) throw new ToolError('text_too_long');
      const written = typeof args.subject === 'string' ? args.subject : null;
      // A new email (K6; plan-m3.md, K3: "a new mail gets a subject (proposed by the model, read back in C1)").
      const subject = r.service !== 'email' ? null : r.conversationId ? replySubject(r.subject, written) : cleanText(written ?? '').slice(0, MAX_SUBJECT);
      if (subject === '') throw new ToolError('subject_missing');
      const ask = tr(ctx, C1[r.service] ?? 'messages.C1', { recipient: r.name, service: serviceName(r.service, r.label), text, subject: subject ?? '' });
      // Someone renamed "Maria (Tochter)" is still not Maria: a stranger's chat is named as such (Appendix E).
      const confirm = r.contact === false ? `${tr(ctx, 'messages.C1.notContact', { name: r.name })} ${ask}` : ask;
      const to = r.to ? { connectionId: r.to.connectionId, to: r.to.address } : {};
      return { args: { conversationId: r.conversationId, ...to, recipient: r.name, text, service: r.service, ...(subject ? { subject } : {}) }, confirm };
    },
    async run(ctx, args) {
      const service = String(args.service ?? 'telegram') as Service;
      const conversationId = typeof args.conversationId === 'string' ? args.conversationId : null;
      const out = await messaging(ctx).send({
        userId: ctx.userId,
        deviceId: ctx.deviceId,
        actionId: ctx.actionId ?? null,
        conversationId,
        to: typeof args.to === 'string' ? { connectionId: String(args.connectionId), address: args.to, recipient: String(args.recipient) } : null,
        text: String(args.text),
        subject: typeof args.subject === 'string' ? args.subject : null,
      });
      // Waiting: for its connection to come back, or for the phone that sends it.
      const waiting = isServerService(service) ? 'messages.C9' : 'messages.C9.device';
      return { say: tr(ctx, out === 'attempting' ? 'messages.C2' : waiting), ...(conversationId ? { focus: { chat: { id: conversationId, title: String(args.recipient) } } } : {}) };
    },
    async cancelled(ctx, args, why) {
      // A new message (K6) has no conversation to keep its draft in.
      if (typeof args.conversationId !== 'string') return tr(ctx, why === 'silence' ? 'messages.C8.noDraft' : 'messages.C7.noDraft');
      await ctx.messaging?.keepDraft(ctx.userId, args.conversationId, String(args.text));
      return tr(ctx, why === 'silence' ? 'messages.C8' : 'messages.C7');
    },
  },
];
