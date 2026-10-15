/**
 * The messages screen's list, fetched again: the message in front stays first, so "Nächste" leads on to the unread
 * ones and never skips them.
 */
import { describe, expect, it } from 'vitest';
import { keepInFront } from '../src/screens/messages-list.ts';

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

  it('takes the queue as it is when nothing is in front', () => {
    expect(keepInFront(fresh, undefined)).toBe(fresh);
  });
});
