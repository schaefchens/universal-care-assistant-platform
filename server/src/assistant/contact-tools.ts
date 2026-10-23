/**
 * The person's contacts for the assistant (docs/plan-m3.md, K6: "„Speichere diese Nummer als Anna", with numbers read
 * back digit by digit; „Wie ist Annas Nummer?"", and "Calls: „Ruf Anna an": which number, when she has several; asked
 * first"):
 *
 * | Tool | Kind | Confirmation |
 * |---|---|---|
 * | contacts.find | read: the contacts a name fits, each with what it has (numbers and addresses by their labels), never the numbers themselves | – |
 * | contacts.save | act: a number as said, or of someone who wrote, kept with a contact; read back digit by digit, with undo | always |
 * | contacts.call | act: a call by phone, asked first ("Anna anrufen, Handy?"); the device that asked dials | always |
 *
 * Numbers never pass through the language model's words: it names a contact's ref as an original, and UCAP says the
 * numbers digit by digit from what is stored (a model copying digits can misdial). The person's own contacts only.
 */
import { type Lang, t } from '@ucap/shared';
import type { JsonSchema } from '../ai/llm/reply.ts';
import { type Handle, MAX_NAME, normalHandle, regionOf, spokenNumber } from '../domain/contacts/service.ts';
import { chooseHandle, fold, serviceMatches } from '../messaging/service.ts';
import { type ActTool, type ReadTool, type ToolContext, ToolError } from './tools.ts';

interface Contact {
  id: string;
  name: string;
  handles: Handle[];
}

const str = (description: string): JsonSchema => ({ type: 'string', description });
const nullableStr = (description: string): JsonSchema => ({ anyOf: [{ type: 'string', description }, { type: 'null' }] });
const tr = (ctx: ToolContext, key: string, params: Record<string, string> = {}) => t(ctx.lang, key, params, ctx.form);
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

async function all(ctx: ToolContext): Promise<Contact[]> {
  if (!ctx.contacts) throw new ToolError('contacts_unavailable');
  return (await ctx.contacts.list(ctx.userId, ctx.userId)).contacts.map((c) => ({ id: c.id, name: c.name, handles: c.handles.map((h) => ({ kind: h.kind, value: h.value, label: h.label })) }));
}

/** The contacts a name fits, as conversations are found: by ref, the whole name, the name within more words, a first name. */
export function fitting<T extends { id: string; name: string }>(list: T[], said: string): T[] {
  const ref = UUID.exec(said);
  if (ref) return list.filter((c) => c.id === ref[1]);
  const n = fold(said);
  if (!n) return [];
  const exact = list.filter((c) => fold(c.name) === n);
  if (exact.length) return exact;
  const within = list.filter((c) => fold(c.name).length > 2 && ` ${n} `.includes(` ${fold(c.name)} `));
  if (within.length) return within;
  return list.filter((c) => fold(c.name).split(' ').includes(n) || fold(c.name).startsWith(`${n} `));
}

/** One contact, never a guess: several that fit are named back. */
function one(list: Contact[], said: unknown): Contact {
  if (typeof said !== 'string' || !said.trim()) throw new ToolError('name_missing');
  const found = fitting(list, said);
  if (!found.length) throw new ToolError('contact_unknown');
  if (found.length > 1) throw new ToolError(`contact_ambiguous: ${found.slice(0, 5).map((c) => c.name).join(', ')}`);
  return found[0]!;
}

/** A contact's numbers: its phone numbers and its number on WhatsApp, each once. */
export const numbersOf = (c: { handles: Handle[] }): Handle[] =>
  c.handles.filter((h, i, a) => (h.kind === 'phone' || h.kind === 'whatsapp') && a.findIndex((x) => (x.kind === 'phone' || x.kind === 'whatsapp') && x.value === h.value) === i);

/** What UCAP says of a contact (an original): its name, each number digit by digit and each address, by their labels. */
export function contactAloud(lang: Lang, form: 'du' | 'Sie', timezone: string, c: Contact): string {
  const region = regionOf(timezone);
  const parts = [
    ...numbersOf(c).map((h) => `${h.label ?? t(lang, 'contacts.kind.phone', {}, form)}: ${spokenNumber(h.value, region)}`),
    ...c.handles.filter((h) => h.kind === 'email').map((h) => `${h.label ?? t(lang, 'contacts.kind.email', {}, form)}: ${h.value}`),
  ];
  return parts.length ? `${c.name}. ${parts.join('. ')}.` : t(lang, 'contacts.spoken.none', { name: c.name }, form);
}

/** One of the person's contacts by its id (an original's ref). */
export async function contactById(ctx: ToolContext, id: string): Promise<Contact | null> {
  return (await all(ctx).catch(() => [])).find((c) => c.id === id) ?? null;
}

const DIGIT_WORDS: Record<string, string> = {
  null: '0', eins: '1', ein: '1', zwei: '2', zwo: '2', drei: '3', vier: '4', fünf: '5', sechs: '6', sieben: '7', acht: '8', neun: '9',
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', plus: '+',
};

/** A number as it was said: figures stay, digit words become figures ("null eins sieben null …" → "0170…"). */
export function figures(said: string): string {
  return said
    .toLowerCase()
    .split(/[^\p{L}\p{N}+]+/u)
    .map((w) => DIGIT_WORDS[w] ?? w)
    .join('')
    .replace(/[^0-9+]/g, '');
}

export const CONTACT_TOOLS: (ReadTool | ActTool)[] = [
  {
    kind: 'read',
    name: 'contacts.find',
    description:
      'The person\'s saved contacts that fit a name (null: all of them), each with its ref and what it has: its numbers and email addresses by their labels, and whether it is on WhatsApp or Telegram; never the numbers themselves. For "Wie ist Annas Nummer?", "Habe ich die Nummer vom Zahnarzt?". To say a contact\'s numbers, say kind "original" with its ref: UCAP reads them digit by digit.',
    args: { name: nullableStr('The name as the person said it ("Anna", "der Zahnarzt"), or null for all contacts.') },
    async run(ctx, args) {
      const list = await all(ctx);
      const found = typeof args.name === 'string' && args.name.trim() ? fitting(list, args.name) : list;
      const contacts = found.slice(0, 20).map((c) => ({
        ref: `contact:${c.id}`,
        name: c.name,
        numbers: numbersOf(c).map((h) => h.label ?? tr(ctx, 'contacts.kind.phone')),
        addresses: c.handles.filter((h) => h.kind === 'email').map((h) => h.label ?? tr(ctx, 'contacts.kind.email')),
        ...(c.handles.some((h) => h.kind === 'whatsapp') ? { whatsapp: true } : {}),
        ...(c.handles.some((h) => h.kind === 'telegram') ? { telegram: true } : {}),
      }));
      const only = found.length === 1 ? found[0]! : null;
      return { data: { contacts, ...(found.length > 20 ? { more: found.length - 20 } : {}) }, ...(only ? { focus: { contact: { id: only.id, title: only.name } } } : {}) };
    },
  },
  {
    kind: 'act',
    name: 'contacts.save',
    description:
      'Saves a phone number with a contact: a new contact of that name, or the one of that name there is. The number as the person said it, or the number (or email address) of whoever wrote a message. UCAP reads it back digit by digit and asks the person first.',
    args: {
      name: str('The contact\'s name, as the person said it ("Anna").'),
      number: nullableStr('The number exactly as the person said it, in figures or words; null with message.'),
      message: nullableStr('"msg:<id>": the number of whoever wrote that message ("Speichere diese Nummer als Anna" after it was read); else null.'),
      label: nullableStr('What kind of number, when the person said it ("Handy", "Festnetz"); else null.'),
    },
    async prepare(ctx, args) {
      const name = typeof args.name === 'string' ? args.name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME) : '';
      if (!name) throw new ToolError('name_missing');
      const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim().slice(0, 30) : null;
      const region = regionOf(ctx.timezone);
      let h: Handle;
      const ref = typeof args.message === 'string' ? UUID.exec(args.message)?.[1] : undefined;
      if (ref) {
        // Whoever wrote: their number as the service told it, never as the model would copy it.
        const a = ctx.messaging ? await ctx.messaging.senderAddress(ctx.userId, ref) : null;
        if (!a) throw new ToolError('number_unknown');
        h = { kind: a.includes('@') ? 'email' : 'phone', value: a, label };
      } else {
        const said = figures(typeof args.number === 'string' ? args.number : '');
        if (!said) throw new ToolError('number_missing');
        try {
          h = normalHandle({ kind: 'phone', value: said, label }, region);
        } catch {
          throw new ToolError('number_invalid');
        }
      }
      const list = await all(ctx);
      // One number or address is one contact: one saved already is named back with whose it is.
      const owner = list.find((c) => c.handles.some((x) => x.value === h.value && (x.kind === h.kind || (h.kind === 'phone' && x.kind === 'whatsapp'))));
      if (owner) throw new ToolError(`${fold(owner.name) === fold(name) ? 'number_saved' : 'number_taken'}: ${owner.name}`);
      const same = list.filter((c) => fold(c.name) === fold(name));
      if (same.length > 1) throw new ToolError(`contact_ambiguous: ${same.map((c) => c.name).join(', ')}`);
      const target = same[0] ?? null;
      const value = h.kind === 'email' ? h.value : spokenNumber(h.value, region);
      const confirm = tr(ctx, `contacts.save.${h.kind === 'email' ? 'address' : 'number'}.${target ? 'add' : 'new'}`, { value, name: target?.name ?? name });
      return { args: { contactId: target?.id ?? null, name: target?.name ?? name, handle: { kind: h.kind, value: h.value, label: h.label } }, confirm };
    },
    async run(ctx, args) {
      if (!ctx.contacts) throw new ToolError('contacts_unavailable');
      const h = args.handle as Handle;
      const added = typeof args.contactId === 'string';
      const c = added
        ? await ctx.contacts.addHandle(ctx.userId, ctx.userId, args.contactId as string, h)
        : await ctx.contacts.create(ctx.userId, ctx.userId, { name: String(args.name), handles: [h] });
      return { say: tr(ctx, 'contacts.saved', { name: c.name }), undo: { contact: c.id, name: c.name, created: !added }, focus: { contact: { id: c.id, title: c.name } } };
    },
    async undo(ctx, u) {
      if (!ctx.contacts) throw new ToolError('contacts_unavailable');
      await ctx.contacts.undo(ctx.userId, ctx.userId, String(u.contact));
      return tr(ctx, u.created ? 'assistant.undone.contactCreated' : 'assistant.undone.contact', { name: String(u.name) });
    },
  },
  {
    kind: 'act',
    name: 'contacts.call',
    description:
      'Calls someone in the person\'s contacts by phone: UCAP asks first ("Anna anrufen, Handy?"), then the device dials. Phone calls only: calls on WhatsApp or Telegram are not possible.',
    args: {
      name: str('The contact, as the person said it ("Anna", "die Physiotherapie"), or "contact:<id>".'),
      number: nullableStr('Which of the contact\'s numbers, when UCAP asked (number_ambiguous): as UCAP named it ("Handy"); else null.'),
      service: nullableStr('A service the person named for the call ("auf WhatsApp"); else null.'),
    },
    async prepare(ctx, args) {
      // WhatsApp and Telegram calls are named as not possible (K6).
      const service = typeof args.service === 'string' ? args.service : '';
      for (const s of ['whatsapp', 'telegram'] as const) if (service && serviceMatches(service, s, null)) throw new ToolError(`call_not_possible: ${t(ctx.lang, `messaging.service.${s}`)}`);
      if (!ctx.canCall) throw new ToolError('device_cannot_call');
      const c = one(await all(ctx), args.name);
      const numbers = numbersOf(c);
      if (!numbers.length) throw new ToolError(`contact_no_number: ${c.name}`);
      const h = chooseHandle(numbers, typeof args.number === 'string' ? args.number : null);
      if (Array.isArray(h)) throw new ToolError(`number_ambiguous: ${h.join(', ')}`);
      // Said with which number, where it has a label or the contact has more than one.
      const which = h.label ?? (numbers.length > 1 ? spokenNumber(h.value, regionOf(ctx.timezone)) : null);
      const confirm = which ? tr(ctx, 'contacts.call.askWhich', { name: c.name, which }) : tr(ctx, 'contacts.call.ask', { name: c.name });
      return { args: { contactId: c.id, name: c.name, number: h.value }, confirm };
    },
    async run(_ctx, args) {
      // The device that asked dials, now that the person said yes, and says what it does.
      return { say: '', device: { call: { number: String(args.number), name: String(args.name) } }, focus: { contact: { id: String(args.contactId), title: String(args.name) } } };
    },
  },
];
