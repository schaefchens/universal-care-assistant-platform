/**
 * herde-project's setVoiceActivity is a single global flag: while it is on, own workers poll every second and get
 * no background speech, because one GPU serves the dialogue model and herde (measured: background speech makes
 * whisper 1.6–1.8× slower and the MoE model drop to 26–32 tokens/s). Several people may be talking at once, so
 * UCAP counts active voice turns and keeps the flag on while any is active; herde adds its 5-minute linger.
 */
export interface VoiceActivity {
  /** Marks a turn as started; call the returned function exactly once when it ends. */
  begin(): () => void;
  readonly active: number;
}

export function createVoiceActivity(set: (active: boolean) => void): VoiceActivity {
  let active = 0;
  return {
    begin() {
      if (active++ === 0) set(true);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        if (--active === 0) set(false);
      };
    },
    get active() {
      return active;
    },
  };
}
