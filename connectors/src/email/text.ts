/**
 * An email's words, for speech (docs/plan-m3.md, K3 "Text"; measured in docs/spikes/m3.md, B). Plain text stays as it
 * is. HTML is turned into text UCAP's own way, never rendered, nothing fetched: mailparser's own text keeps a
 * newsletter's hidden preheader, names pictures by their URL, runs table cells together and writes every link's
 * address. Here:
 * - hidden parts are dropped (`display:none`, `hidden`, `aria-hidden`, heads, styles and scripts);
 * - pictures are said by their alt text or not at all;
 * - table cells are kept apart, list items and paragraphs on lines of their own;
 * - links are said by their words, and no address of anything is said.
 *
 * Then what is new is kept apart from the quoted part ("Am … schrieb …:", "> …", Outlook's "Von: … Gesendet: …") and
 * the signature ("-- ").
 */
import { Parser } from 'htmlparser2';

/** Never content: their text is not said. */
const SKIP = new Set(['head', 'style', 'script', 'title', 'template', 'noscript', 'svg', 'object', 'iframe', 'button', 'select', 'option', 'textarea', 'input']);
/** Their own lines. */
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'blockquote', 'pre', 'center', 'address', 'dl', 'dd', 'dt', 'form', 'fieldset', 'figure', 'figcaption', 'hr']);
const HIDDEN_STYLE = /(display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)|font-size\s*:\s*0(?:px|pt|em)?\s*(?:;|!|$)|max-height\s*:\s*0(?:px)?\s*(?:;|!|$))/i;
const URL_TEXT = /^(https?:\/\/|www\.)\S+$/i;
const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;

interface Open {
  tag: string;
  hidden: boolean;
  quote: boolean;
  /** Text said inside this link: a link written as its own address is not said. */
  linkText?: string[];
}

/** HTML as lines of speakable text; quoted parts (`<blockquote>`, Gmail's quote) are marked with "> ". */
export function htmlToText(html: string): string {
  const lines: string[] = [];
  let line = '';
  let cellsInRow = 0;
  const stack: Open[] = [];
  const hidden = () => stack.some((o) => o.hidden);
  const quoted = () => stack.some((o) => o.quote);
  const flush = () => {
    const t = line.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (t) lines.push(quoted() ? `> ${t}` : t);
    else if (lines.length && lines.at(-1) !== '') lines.push('');
    line = '';
  };
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const tag = name.toLowerCase();
        const style = attrs.style ?? '';
        const cls = attrs.class ?? '';
        const isHidden = SKIP.has(tag) || 'hidden' in attrs || attrs['aria-hidden'] === 'true' || HIDDEN_STYLE.test(style);
        const isQuote = tag === 'blockquote' || /\bgmail_quote\b|\byahoo_quoted\b|\bmoz-cite-prefix\b/.test(cls) || attrs.id === 'divRplyFwdMsg';
        stack.push({ tag, hidden: isHidden, quote: isQuote, ...(tag === 'a' ? { linkText: [] } : {}) });
        if (hidden()) return;
        if (BLOCK.has(tag)) flush();
        if (tag === 'tr') cellsInRow = 0;
        if (tag === 'td' || tag === 'th') {
          if (cellsInRow++ > 0) line += ' · ';
        }
        if (tag === 'li') {
          flush();
          line += '– ';
        }
        if (tag === 'br') flush();
        if (tag === 'img') {
          const alt = (attrs.alt ?? '').trim();
          // A picture by its alt text, when it says something; never its address.
          if (alt && !URL_TEXT.test(alt) && !/^(logo|image|bild|spacer|pixel)$/i.test(alt)) line += ` ${alt} `;
        }
      },
      ontext(text) {
        if (hidden()) return;
        const link = [...stack].reverse().find((o) => o.linkText);
        if (link) link.linkText!.push(text);
        else line += text;
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        // Close up to the matching tag (HTML mail is often sloppy).
        let i = stack.length - 1;
        while (i >= 0 && stack[i]!.tag !== tag) i--;
        if (i < 0) return;
        const wasHidden = hidden();
        const closing = stack.slice(i).reverse();
        stack.length = i;
        if (wasHidden && hidden()) return;
        for (const o of closing) {
          if (o.linkText) {
            const words = o.linkText.join('').replace(/\s+/g, ' ').trim();
            if (words && !URL_TEXT.test(words)) line += words;
          }
        }
        if (BLOCK.has(tag) || tag === 'li') flush();
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  flush();
  return tidy(lines.join('\n'));
}

/** Spaces and blank lines tidied; no address of anything left in the words. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(URL_IN_TEXT, '')
    // An address in angle brackets, as headers write it ("Anna <anna@example.org>"): the name is said, not the address.
    .replace(/\s*<[^<>\s]+@[^<>\s]+>/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Where a quoted part begins: a reply's header, as clients write it. */
const QUOTE_HEADERS = [
  /^(?:>\s*)?Am .{3,90} schrieb .{1,160}:\s*$/m,
  /^(?:>\s*)?On .{3,90} wrote:\s*$/m,
  /^-{2,}\s*(?:Ursprüngliche Nachricht|Original Message)\s*-{2,}\s*$/im,
  /^(?:Von|From):[ \t].+\n(?:Gesendet|Sent|Datum|Date):[ \t].+/m,
  /^_{10,}\s*$/m,
];
/** A forward's header: what follows it is the message that was sent on, said with the rest. */
const FORWARD = /^-{2,}\s*(?:Weitergeleitete Nachricht|Forwarded message|Original-Nachricht)\s*-{2,}\s*$/im;

/**
 * The new text, the quoted part (from the first reply header or "> " line) and the signature (after "-- "), apart.
 * A line of dashes left at the end of the new part (Outlook's rule above its quote) goes.
 */
export function split(text: string): { fresh: string; quoted: string; signature: string } {
  let body = text.replace(/\r\n?/g, '\n');
  let cut = -1;
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(body);
    if (m && (cut < 0 || m.index < cut)) cut = m.index;
  }
  const firstQuoteLine = /^>.*$/m.exec(body);
  if (firstQuoteLine && (cut < 0 || firstQuoteLine.index < cut)) cut = firstQuoteLine.index;
  // A forward before any quote: the forwarded message is what was sent, not a quote of the past.
  const forward = FORWARD.exec(body);
  if (forward && (cut < 0 || forward.index < cut)) {
    body = `${body.slice(0, forward.index)}${body.slice(forward.index + forward[0].length)}`;
    const rest = split(body);
    return rest;
  }
  let quoted = '';
  if (cut >= 0) {
    quoted = body.slice(cut).trim();
    body = body.slice(0, cut);
  }
  let signature = '';
  const sig = /\n-- ?\n/.exec(`\n${body}`);
  if (sig) {
    signature = `\n${body}`.slice(sig.index + sig[0].length).trim();
    body = `\n${body}`.slice(0, sig.index);
  }
  const fresh = body.replace(/\n[-_=*]{3,}\s*$/, '').replace(/\n{3,}/g, '\n\n').trim();
  return { fresh, quoted, signature };
}

/** A quoted part's first line, said in place of it: shared with the server, which says it. */
export { quoteHeader } from '@ucap/shared';
