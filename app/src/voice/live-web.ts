/**
 * LIVE mode in a browser (docs/plan-m2.md: "the browser does what it can while its tab is visible, and says what it
 * cannot"): no keyword spotter, so the microphone is open only while the gate is: a touch on the talk area opens
 * both, and the conversation then goes on without touching until the quiet while has passed. While the tab is hidden
 * the microphone is closed, and opened again when it is back in front with the gate still open.
 */
import { scriptUrl } from '../trusted.ts';
import { encodeWav, resample, Segmenter } from './audio.ts';
import type { CaptureEvents, LiveCapture } from './live.ts';

export function webLiveCapture(): LiveCapture {
  let on: CaptureEvents | null = null;
  let gate = false;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let opening: Promise<void> | null = null;

  const close = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
    void ctx?.close().catch(() => {});
    ctx = null;
  };

  async function open() {
    if (stream || !on) return;
    if (!navigator.mediaDevices?.getUserMedia) return on.stopped('unavailable');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      const name = (e as Error).name;
      return on?.stopped(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
    }
    // Closed again (the gate, the tab, LIVE off) while the browser asked: the microphone closes at once.
    if (!gate || !on || document.hidden) return close();
    ctx = new AudioContext();
    await ctx.resume().catch(() => {});
    const rate = ctx.sampleRate;
    const seg = new Segmenter({
      utterance: (u) => {
        const wav = encodeWav(u);
        on?.utterance({ wav, ms: Math.round(u.length / 16) });
      },
      speech: () => on?.speech(),
    });
    const take = (block: Float32Array) => {
      if (gate) seg.push(resample(block, rate));
    };
    const source = ctx.createMediaStreamSource(stream);
    try {
      await ctx.audioWorklet.addModule(scriptUrl('capture-worklet.js'));
      const node = new AudioWorkletNode(ctx, 'ucap-capture');
      node.port.onmessage = (m: MessageEvent<Float32Array>) => take(m.data);
      source.connect(node);
    } catch {
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => take(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(ctx.destination);
    }
  }

  const visibility = () => {
    if (document.hidden) close();
    else if (gate && !opening) opening = open().finally(() => (opening = null));
  };

  return {
    spotsKeyword: false,
    async start(_o, events) {
      on = events;
      document.addEventListener('visibilitychange', visibility);
    },
    setGate(open_) {
      gate = open_;
      if (!open_) return close();
      if (!opening && !document.hidden) opening = open().finally(() => (opening = null));
    },
    stop() {
      gate = false;
      on = null;
      document.removeEventListener('visibilitychange', visibility);
      close();
    },
  };
}
