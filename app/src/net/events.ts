/**
 * Realtime events that a part of the app waits for (a test alarm's receipt), handed on by the shell, which owns the
 * connection. Ids and flags only, like every event.
 */
const target = new EventTarget();

export function emitAppEvent(type: string, data: Record<string, unknown>) {
  target.dispatchEvent(new CustomEvent(type, { detail: data }));
}

export function onAppEvent(type: string, fn: (data: Record<string, unknown>) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<Record<string, unknown>>).detail);
  target.addEventListener(type, h);
  return () => target.removeEventListener(type, h);
}
