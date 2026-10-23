/**
 * Calls by phone (docs/plan-m3.md, K6: "dialled directly where the person allowed calls (the phone fallback's
 * setting), or in the dialler otherwise. A device that cannot make calls says so"): whether this device can, told to
 * the assistant with each turn, and the call itself, said before it is placed.
 */
import { dial, loadFallbacks } from '../care/phone.ts';
import { has, Info } from '../native/plugins.ts';
import { record } from '../debug.ts';

/** In a browser a tel: link is the best there is; the app asks Android once. */
let voice = !has('Info');
if (has('Info')) void Info.get().then((i) => (voice = i.voiceCapable === true), () => {});

/** Whether this device can place a phone call (the turn says so: `calls=1`). */
export const canCall = () => voice;

/**
 * The call the person said yes to: said first ("Ich rufe Anna an."), then placed directly where they allowed calls,
 * else the dialler opened with the number; a device that cannot call says so.
 */
export async function placeCall(ui: { tr: (key: string, params?: Record<string, string>) => string; sayAndWait: (text: string, channel: 'system') => Promise<boolean>; say: (text: string, channel: 'system') => void }, c: { number: string; name: string }) {
  if (!voice) {
    ui.say(ui.tr('contacts.call.cannot'), 'system');
    return;
  }
  const direct = loadFallbacks().phoneFallback?.direct === true;
  await ui.sayAndWait(ui.tr(direct ? 'contacts.call.dialling' : 'contacts.call.dialler', { name: c.name }), 'system');
  const how = await dial(c.number, direct);
  record('activations', { area: 'call', how: how ?? 'none' });
  // Asked for direct calls, but the permission was refused: the dialler has the number.
  if (how === 'dialler' && direct) ui.say(ui.tr('contacts.call.dialler', { name: c.name }), 'system');
  else if (!how) ui.say(ui.tr('contacts.call.cannot'), 'system');
}
