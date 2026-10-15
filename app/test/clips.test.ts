/**
 * The clip player (a voice of the person's choosing, a voice message's recording): stopped while it plays (a touch,
 * LIVE's barge-in), the wait for it ends at once as cut off, so what comes after it is never held forever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClipPlayer } from '../src/audio/voices.ts';

class FakeAudio {
  static last: FakeAudio | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = true;
  ended = false;
  readonly src: string;
  constructor(src: string) {
    this.src = src;
    FakeAudio.last = this;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

describe('the clip player', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stopped while playing, the wait ends as cut off; played to its end, as heard', async () => {
    vi.stubGlobal('Audio', FakeAudio);
    const p = new ClipPlayer();
    const first = p.play(['a.mp3']);
    await Promise.resolve();
    expect(p.playing).toBe(true);
    p.stop();
    await expect(first).resolves.toBe(false);
    const second = p.play(['b.mp3']);
    await Promise.resolve();
    FakeAudio.last!.onended!();
    await expect(second).resolves.toBe(true);
  });

  it('a touch on an area stops an answer in a server voice, as in the device voice; anything else plays on', async () => {
    vi.stubGlobal('Audio', FakeAudio);
    const p = new ClipPlayer();
    const reminder = p.play(['question.mp3']);
    await Promise.resolve();
    expect(p.stopAnswer()).toBe(false);
    expect(p.playing).toBe(true);
    FakeAudio.last!.onended!();
    await expect(reminder).resolves.toBe(true);
    const answer = p.play(['reply.mp3'], { answer: true });
    await Promise.resolve();
    expect(p.stopAnswer()).toBe(true);
    await expect(answer).resolves.toBe(false);
    expect(p.cutOff).toBe(true);
    // Nothing playing: nothing to stop.
    expect(p.stopAnswer()).toBe(false);
  });
});
