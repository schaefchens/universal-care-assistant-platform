/**
 * The messages screen's list, fetched again: the message in front stays first, so "Nächste" leads on to the unread
 * ones and never skips them.
 */
import { describe, expect, it } from 'vitest';
import { keepInFront, nextIndex } from '../src/screens/messages-list.ts';

describe('the messages screen, fetched again', () => {
  // The queue as the server orders it: the unread first (oldest first), then the newest of each other conversation.
  const fresh = [
    { id: 'whatsapp', unread: true },
    { id: 'telegram', unread: true },
    { id: 'familie', unread: false },
    { id: 'sms', unread: false },
  ];

  it('keeps the message just heard first, as the server has it now, and the unread ones next', () => {
    const list = keepInFront(fresh, { id: 'sms', unread: true });
    expect(list.map((x) => x.id)).toEqual(['sms', 'whatsapp', 'telegram', 'familie']);
    expect(list[0]).toEqual({ id: 'sms', unread: false });
  });

  it('keeps one that is no longer in the queue', () => {
    expect(keepInFront(fresh, { id: 'gone', unread: false }).map((x) => x.id)).toEqual(['gone', 'whatsapp', 'telegram', 'familie', 'sms']);
  });

  it('leads on to what was not shown yet: a refresh never brings back what the person already passed', () => {
    const queue = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `u${n}`, unread: true }));
    // u1 and u2 were shown and passed, u3 is in front; a transcript is ready and the queue comes again, as it was.
    const once = keepInFront(queue, queue[2], new Set(['u1', 'u2', 'u3']));
    expect(once.map((x) => x.id)).toEqual(['u3', 'u4', 'u5', 'u6', 'u1', 'u2']);
    // On to u4, and the queue comes again: still on, never back to u1.
    expect(keepInFront(queue, queue[3], new Set(['u1', 'u2', 'u3', 'u4'])).map((x) => x.id)).toEqual(['u4', 'u5', 'u6', 'u1', 'u2', 'u3']);
  });

  it('takes the queue as it is when nothing is in front', () => {
    expect(keepInFront(fresh, undefined)).toBe(fresh);
  });

  it('"Nächste" through all of them ends at the last one, never at the first again; a new one is still next', () => {
    const queue = [1, 2, 3].map((n) => ({ id: `u${n}` }));
    expect(nextIndex(queue, 0, new Set(['u1']))).toBe(1);
    expect(nextIndex(queue, 1, new Set(['u1', 'u2']))).toBe(2);
    expect(nextIndex(queue, 2, new Set(['u1', 'u2', 'u3']))).toBeNull();
    // A new message comes while the last is in front: the refresh puts it next, and after it is the end again.
    const seen = new Set(['u1', 'u2', 'u3']);
    const again = keepInFront([...queue, { id: 'new' }], queue[2], seen);
    expect(again.map((x) => x.id)).toEqual(['u3', 'new', 'u1', 'u2']);
    expect(nextIndex(again, 0, seen)).toBe(1);
    seen.add('new');
    expect(nextIndex(again, 1, seen)).toBeNull();
  });
});
