/**
 * The tasks screen's "Nächste" (docs/plan-m3.md, K7; docs/decisions.md, M3, item 22): on to the next open task, what
 * was ticked off leaving the list; after the last open one it stays there, never back at the first.
 */
import { describe, expect, it } from 'vitest';
import { nextTask } from '../src/screens/AgendaScreen.tsx';

const task = (id: string, done = false) => ({ id, done });

describe('the tasks screen, on to the next', () => {
  it('goes to the next open one, leaving what was ticked off behind', () => {
    const list = [task('a'), task('b', true), task('c')];
    expect(nextTask(list, 0)).toEqual({ list: [task('a'), task('c')], i: 1 });
    // The one in front just ticked off: on to the next, and it leaves the list.
    expect(nextTask([task('a', true), task('b')], 0)).toEqual({ list: [task('b')], i: 0 });
  });

  it('stays at the last open one, never back at the first', () => {
    expect(nextTask([task('a'), task('b')], 1)).toBe('last');
    expect(nextTask([task('a'), task('b', true)], 0)).toBe('last');
    // Ticked off as the last one: it stays, to be opened again right here.
    expect(nextTask([task('a'), task('b', true)], 1)).toBe('last');
    expect(nextTask([task('a', true)], 0)).toBe('none');
  });
});
