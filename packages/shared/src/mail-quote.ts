/**
 * An email's quoted part, said in place of it (docs/plan-m3.md, K3: "Darunter zitiert: …"): its first line, the
 * header clients write above a quote ("Am Montag, 12. Oktober schrieb Anna:"), without "> " marks, rules or the colon.
 */
export function quoteHeader(quoted: string): string {
  const first = quoted.split('\n').find((l) => l.replace(/^[>\s\-_]+/, '').trim()) ?? '';
  return first
    .replace(/^[>\s\-_]+|[\-_\s]+$/g, '')
    .replace(/:$/, '')
    .trim()
    .slice(0, 160);
}
