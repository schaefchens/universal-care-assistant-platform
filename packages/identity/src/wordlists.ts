/**
 * UCAP's German recovery-word list. Until the owner has reviewed and frozen it, it is `de-dev`: usable in
 * development, refused against production servers. Once a real person holds a German phrase the list must never
 * change again; it is then frozen as `ucap-de-1` and its SHA-256 is pinned in a test.
 */
import de from '../wordlists/de-dev.json' with { type: 'json' };

export interface GermanList {
  id: 'de-dev' | 'ucap-de-1';
  frozen: boolean;
  words: readonly string[];
}

export const GERMAN: GermanList = { id: de.id as GermanList['id'], frozen: de.frozen, words: de.words };
