/**
 * The microphone for push-to-talk (docs/plan.md, S8: `AudioInput`): getUserMedia in the WebView, with the platform's
 * echo canceller, noise suppression and gain control, one utterance at a time. M2's native capture (a foreground
 * service, for LIVE mode) replaces it behind the same interface. The microphone is open only while recording.
 */
import { Endpointer, type EndpointOptions, type EndReason, encodeWav, resample } from './audio.ts';

export interface Recording {
  wav: Uint8Array<ArrayBuffer>;
  ms: number;
  reason: EndReason;
  /** Whether anything louder than the room was heard. */
  speech: boolean;
}

export interface Recorder {
  /** The utterance, or null when cancelled. Rejects with `mic_denied` or `mic_unavailable`. */
  done: Promise<Recording | null>;
  /** Ends the utterance now (talk pressed again, the hold released). */
  finish(): void;
  /** The talk button is held: only its release ends the utterance. */
  hold(): void;
  /** Drops it. */
  cancel(): void;
}

export interface AudioInput {
  record(o?: Partial<EndpointOptions>): Recorder;
}

export class MicError extends Error {
  readonly code: 'mic_denied' | 'mic_unavailable';
  constructor(code: 'mic_denied' | 'mic_unavailable') {
    super(code);
    this.code = code;
  }
}

export function micInput(): AudioInput {
  return {
    record(o = {}) {
      let finish = () => {};
      let cancel = () => {};
      const ep = new Endpointer(o);
      const done = new Promise<Recording | null>((resolve, reject) => {
        let closed = false;
        let stream: MediaStream | null = null;
        let ctx: AudioContext | null = null;
        const close = () => {
          if (closed) return;
          closed = true;
          for (const t of stream?.getTracks() ?? []) t.stop();
          void ctx?.close().catch(() => {});
        };
        const end = () => {
          close();
          const u = ep.utterance();
          resolve({ wav: encodeWav(u), ms: Math.round(u.length / 16), reason: ep.ended ?? 'stopped', speech: ep.speech });
        };
        finish = () => {
          ep.stop();
          end();
        };
        cancel = () => {
          close();
          resolve(null);
        };
        void (async () => {
          if (!navigator.mediaDevices?.getUserMedia) return reject(new MicError('mic_unavailable'));
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          } catch (e) {
            return reject(new MicError((e as Error).name === 'NotAllowedError' || (e as Error).name === 'SecurityError' ? 'mic_denied' : 'mic_unavailable'));
          }
          // Cancelled while the permission question was open: the microphone closes at once.
          if (closed) {
            for (const t of stream.getTracks()) t.stop();
            return;
          }
          ctx = new AudioContext();
          // Started after the permission question, the press that asked for it may no longer count as a gesture.
          await ctx.resume().catch(() => {});
          const source = ctx.createMediaStreamSource(stream);
          const rate = ctx.sampleRate;
          const take = (block: Float32Array) => {
            if (closed) return;
            if (ep.push(resample(block, rate))) end();
          };
          try {
            await ctx.audioWorklet.addModule('capture-worklet.js');
            const node = new AudioWorkletNode(ctx, 'ucap-capture');
            node.port.onmessage = (m: MessageEvent<Float32Array>) => take(m.data);
            source.connect(node);
          } catch {
            // No audio worklet (an old WebView): the deprecated processor node does the same.
            const node = ctx.createScriptProcessor(2048, 1, 1);
            node.onaudioprocess = (e) => take(new Float32Array(e.inputBuffer.getChannelData(0)));
            source.connect(node);
            node.connect(ctx.destination);
          }
        })();
      });
      return { done, finish: () => finish(), cancel: () => cancel(), hold: () => ep.hold() };
    },
  };
}
