/**
 * The messages screen's list when the queue is fetched again (a new message came, one was marked heard, a transcript is
 * ready): the message in front stays first, as the server has it now, and "Nächste" leads on to the messages not shown
 * yet in the queue's order, the unread first, and only then to those already shown.
 * - Kept where it then was, a message just heard sat among the newest of each conversation, after the unread ones, and
 *   "Nächste" skipped them (seen with three services in the browser walk).
 * - Started over at the first unread one on every refresh, a person with many unread messages never got past them
 *   while voice messages were transcribed in the background (WhatsApp just linked, 26 unread: seen on 2026-10-22).
 */
export function keepInFront<T extends { id: string }>(fresh: T[], shown: T | undefined, seen: ReadonlySet<string> = new Set()): T[] {
  if (!shown) return fresh;
  const rest = fresh.filter((x) => x.id !== shown.id);
  return [fresh.find((x) => x.id === shown.id) ?? shown, ...rest.filter((x) => !seen.has(x.id)), ...rest.filter((x) => seen.has(x.id))];
}

/**
 * Where "Nächste" goes from `i`: the next message not shown yet on this visit, or null at the end. Through all of
 * them, it stays at the last one and never begins again from the first (the owner, 2026-10-26: "when user is through
 * all messages it shouldnt start from the beginning"); a refresh puts what was shown last, so the end is reached there.
 */
export function nextIndex(list: readonly { id: string }[], i: number, seen: ReadonlySet<string>): number | null {
  const n = i + 1;
  return n < list.length && !seen.has(list[n]!.id) ? n : null;
}
