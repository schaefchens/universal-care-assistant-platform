/**
 * The messages screen's list when the queue is fetched again (a new message came, one was marked heard): the message
 * in front stays first, as the server has it now, and "Nächste" leads on to the rest in the queue's order, the unread
 * first. Kept where it then was, a message just heard sat among the newest of each conversation, after the unread
 * ones, and "Nächste" skipped them (seen with three services in the browser walk).
 */
export function keepInFront<T extends { id: string }>(fresh: T[], shown: T | undefined): T[] {
  if (!shown) return fresh;
  return [fresh.find((x) => x.id === shown.id) ?? shown, ...fresh.filter((x) => x.id !== shown.id)];
}
