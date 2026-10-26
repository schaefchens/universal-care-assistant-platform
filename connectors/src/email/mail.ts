/**
 * One email as the connector reads it (docs/plan-m3.md, K3; docs/spikes/m3.md, B): its ids and its thread (Message-ID,
 * In-Reply-To, References), who wrote it to whom, its subject, its words (text.ts) with the quoted part and the
 * signature apart, its attachments by name and kind, whether it comes from a list or newsletter (List-*, Precedence),
 * whether the sender's domain failed DMARC at the person's own provider (Authentication-Results), and, for a mail
 * server's report that a mail came back, which mail and why.
 */
import { simpleParser } from 'mailparser';
import { htmlToText, split, tidy } from './text.ts';

export interface Address {
  address: string;
  name: string;
}

export type AttachmentKind = 'pdf' | 'image' | 'audio' | 'video' | 'calendar' | 'document' | 'spreadsheet' | 'archive' | 'file';

export interface Mail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** The thread it belongs to: the first of its References, else what it answers, else itself. */
  threadRoot: string | null;
  subject: string;
  from: Address | null;
  /** Where replies go, when the sender asks for another address than its own. */
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  /** Seconds since the epoch: the Date header's, or the time it was read. */
  date: number;
  /** The mail has a Date header (the connector falls back to when it came). */
  dateGiven: boolean;
  list: boolean;
  dmarcFail: boolean;
  fresh: string;
  quoted: string;
  signature: string;
  attachments: { name: string; kind: AttachmentKind }[];
  /** A mail server's report that a mail came back (multipart/report, delivery-status). */
  bounce: { original: string | null; status: string | null; action: string | null } | null;
}

/** A Message-ID without its angle brackets; null for none. */
export const idOf = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim().replace(/^<|>$/g, '').trim() : '';
  return s || null;
};

const idsOf = (v: unknown): string[] => {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\s+/) : [];
  return list.map(idOf).filter((x): x is string => x !== null);
};

type AddressObject = { value?: { address?: string; name?: string }[] };
const addresses = (v: unknown): Address[] => {
  const objs = (Array.isArray(v) ? v : v ? [v] : []) as AddressObject[];
  return objs.flatMap((o) => o.value ?? []).flatMap((a) => (a.address ? [{ address: a.address.trim().toLowerCase(), name: (a.name ?? '').trim() }] : []));
};

/** "Re: AW: Fwd: Termin" → "Termin": a thread's topic, without the prefixes replies and forwards add. */
export function topicOf(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 10; i++) {
    const next = s.replace(/^(re|aw|antw|antwort|fwd?|wg|wtr|tr|sv|vs)\s*(\[\d+\])?\s*:\s*/i, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

export const kindOf = (mime: string, name: string): AttachmentKind => {
  const m = mime.toLowerCase();
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'text/calendar' || ext === 'ics') return 'calendar';
  if (/spreadsheet|excel|csv/.test(m) || ['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return 'spreadsheet';
  if (/word|opendocument\.text|rtf/.test(m) || ['doc', 'docx', 'odt', 'rtf', 'txt'].includes(ext)) return 'document';
  if (/zip|compressed|x-tar|gzip|x-7z/.test(m) || ['zip', '7z', 'tar', 'gz', 'rar'].includes(ext)) return 'archive';
  return 'file';
};

/** A part of a mail as the IMAP server describes it (BODYSTRUCTURE), without fetching it. */
export interface Structure {
  type?: string;
  id?: string;
  disposition?: string;
  parameters?: Record<string, string>;
  dispositionParameters?: Record<string, string>;
  childNodes?: Structure[];
}

/**
 * A mail's attachments from its structure, for a mail too large to fetch whole: what was sent along, by name and kind.
 * Pictures of the HTML's layout (in multipart/related, or inline with a Content-ID) are none, as in `parseMail`.
 */
export function attachmentsOf(node: Structure, related = false): Mail['attachments'] {
  if (node.childNodes?.length) return node.childNodes.flatMap((c) => attachmentsOf(c, (node.type ?? '').toLowerCase() === 'multipart/related'));
  const type = (node.type ?? '').toLowerCase();
  const name = (node.dispositionParameters?.filename ?? node.parameters?.name ?? '').trim();
  if ((node.disposition ?? '').toLowerCase() !== 'attachment') {
    if (!name || related || (node.id && type.startsWith('image/')) || type === 'text/plain' || type === 'text/html') return [];
  }
  return [{ name, kind: kindOf(type, name) }];
}

const headerText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(headerText).join('\n');
  if (v && typeof v === 'object' && 'value' in v) return headerText((v as { value: unknown }).value);
  return '';
};

export async function parseMail(source: Buffer | string): Promise<Mail> {
  const raw = typeof source === 'string' ? Buffer.from(source) : source;
  const p = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const h = p.headers;
  // Plain text when the mail has its own; HTML only through UCAP's own step (mailparser's keeps hidden parts and URLs).
  const hasPlain = /^content-type:\s*text\/plain/im.test(raw.toString('latin1'));
  const words = hasPlain && p.text ? tidy(p.text) : p.html ? htmlToText(p.html) : tidy(p.text ?? '');
  const parts = split(words);
  const contentType = h.get('content-type') as { value?: string; params?: Record<string, string> } | undefined;
  const isReport = contentType?.value === 'multipart/report' && /delivery-status/i.test(contentType.params?.['report-type'] ?? '');
  let bounce: Mail['bounce'] = null;
  if (isReport) {
    // mailparser keeps the delivery-status part as text at times: its fields are read from there too.
    const status = p.attachments.find((a) => a.contentType === 'message/delivery-status');
    const fields = status ? status.content.toString('utf8') : (p.text ?? '');
    const original = p.attachments.find((a) => a.contentType === 'message/rfc822' || a.contentType === 'text/rfc822-headers');
    const originalText = original ? original.content.toString('utf8') : (p.text ?? '');
    bounce = {
      original: idOf(/^Message-ID:\s*(<[^>\r\n]+>)/im.exec(originalText)?.[1]),
      status: /^Status:\s*(\d\.\d{1,3}\.\d{1,3})/im.exec(fields)?.[1] ?? null,
      // RFC 3464's actions only: whoever wrote the report chose its words, and the action goes to the log.
      action: /^Action:\s*(failed|delayed|delivered|relayed|expanded)\b/im.exec(fields)?.[1]?.toLowerCase() ?? null,
    };
  }
  const attachments = isReport
    ? []
    : p.attachments
        // Pictures inside the HTML (cid) belong to its layout, not to what was sent along.
        .filter((a) => !(a.related || (a.contentDisposition === 'inline' && a.cid && a.contentType.startsWith('image/'))))
        .map((a) => ({ name: (a.filename ?? '').trim(), kind: kindOf(a.contentType, a.filename ?? '') }));
  const precedence = headerText(h.get('precedence')).toLowerCase();
  const list = h.has('list') || h.has('list-id') || h.has('list-unsubscribe') || ['bulk', 'list', 'junk'].includes(precedence.trim());
  const auth = headerText(h.get('authentication-results'));
  const messageId = idOf(p.messageId);
  const dateGiven = p.date !== undefined && Number.isFinite(p.date.getTime());
  const references = idsOf(p.references);
  const inReplyTo = idsOf(p.inReplyTo)[0] ?? null;
  return {
    messageId,
    inReplyTo,
    references,
    threadRoot: references[0] ?? inReplyTo ?? messageId,
    subject: (p.subject ?? '').trim(),
    from: addresses(p.from)[0] ?? null,
    replyTo: addresses(p.replyTo),
    to: addresses(p.to),
    cc: addresses(p.cc),
    date: Math.floor((dateGiven ? p.date!.getTime() : Date.now()) / 1000),
    dateGiven,
    list,
    dmarcFail: /\bdmarc\s*=\s*fail\b/i.test(auth),
    fresh: parts.fresh,
    quoted: parts.quoted,
    signature: parts.signature,
    attachments,
    bounce,
  };
}
