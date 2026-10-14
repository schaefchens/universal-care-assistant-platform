/**
 * The app's one Trusted Types policy (csp.ts: "trusted-types ucap"). It makes script URLs for the app's own two
 * scripts only, the browser's service worker and the microphone's audio worklet, and refuses every other. Nothing in
 * the app turns a string into markup: text from messages, notes and the language model is always rendered as text.
 */
const OWN_SCRIPTS = new Set(['./sw.js', '/src/sw.ts', 'capture-worklet.js']);

interface Policy {
  createScriptURL(url: string): unknown;
}
interface PolicyFactory {
  createPolicy(name: string, rules: { createScriptURL(url: string): string }): Policy;
}

let policy: Policy | null | undefined;

function check(url: string): string {
  if (!OWN_SCRIPTS.has(url)) throw new TypeError(`not one of the app's scripts: ${url}`);
  return url;
}

/** A script URL the WebView accepts under the policy; where there are no Trusted Types, the checked string. */
export function scriptUrl(url: string): string {
  if (policy === undefined) {
    const factory = (globalThis as { trustedTypes?: PolicyFactory }).trustedTypes;
    policy = factory ? factory.createPolicy('ucap', { createScriptURL: check }) : null;
  }
  // A TrustedScriptURL stands in for the string: the sinks take either, and it turns into the same text.
  return policy ? (policy.createScriptURL(url) as string) : check(url);
}
