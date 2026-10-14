/**
 * Whether a recovery-word screen is open (docs/plan.md, Appendix C: the ceremony is isolated by code). While it is,
 * screenshots are blocked, and every path that could carry the words away checks `ceremony.active`: the debug
 * recorder keeps no list words, and from S7/S8 the microphone and server voices refuse to start.
 */
import { WORDLISTS } from '@ucap/identity';
import { has, Info } from '../native/plugins.ts';

export const ceremony = { active: false };

/** Marks the ceremony open and blocks screenshots; returns the function that undoes both. */
export function enterCeremony(): () => void {
  ceremony.active = true;
  if (has('Info')) void Info.setSecure({ on: true }).catch(() => {});
  return () => {
    ceremony.active = false;
    if (has('Info')) void Info.setSecure({ on: false }).catch(() => {});
  };
}

const LIST_WORDS = new Set([...WORDLISTS.de, ...WORDLISTS.en]);

/** The text with every recovery-list word and every single letter (spelling) replaced, for anything that keeps a
 *  record. */
export const redactWords = (text: string) => text.replace(/\p{L}+/gu, (w) => (w.length === 1 ? '•' : LIST_WORDS.has(w.toLowerCase()) ? '•••' : w));
