/**
 * Which assistive technology is running, and so how UCAP takes input and gives output (docs/plan.md, Appendix H).
 *
 * | Mode | Input | Speech |
 * |---|---|---|
 * | screen-reader | TalkBack explores and sends clicks; UCAP's gestures are off | live regions (TalkBack speaks) |
 * | gesture-at | Switch Access point scanning or Voice Access' grid dispatch real touches: direct mode | UCAP's own voice |
 * | none | UCAP's touch engine (explore / direct / hold) | UCAP's own voice |
 *
 * The DOM is the same in every mode: areas are always real, named buttons, so keyboards, switches and screen readers
 * all reach them. In the browser nothing reports a screen reader, so the person can set it.
 */
import { A11y, type A11yState, has } from '../native/plugins.ts';

export type AssistiveMode = 'screen-reader' | 'gesture-at' | 'none';

export function modeFrom(s: A11yState | null, override: AssistiveMode | 'auto'): AssistiveMode {
  if (override !== 'auto') return override;
  if (!s) return 'none';
  if (s.touchExploration || s.spokenFeedback) return 'screen-reader';
  if (s.gestureDispatch) return 'gesture-at';
  return 'none';
}

export async function watchAssistive(onChange: (s: A11yState | null) => void): Promise<() => void> {
  if (!has('A11y')) {
    onChange(null);
    return () => {};
  }
  onChange(await A11y.state());
  const handle = await A11y.addListener('change', (s) => onChange(s));
  return () => void handle.remove();
}
