/**
 * The server's secrets, made once by `npm run setup` outside the repository (tools/dev/setup-secrets.ts). In Docker
 * they are files under /run/secrets; on the host, UCAP_SECRETS_DIR. A missing secret stops the process: making a new
 * one would silently invalidate everything the old one protected.
 */
import { hkdfSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Secrets {
  /** Encrypts stored credentials (provider keys, TDLib keys) and derives signing keys. */
  masterKey: Uint8Array;
  /** HMACs of codes and tokens (herde worker keys, invites, sessions). */
  pepper: Uint8Array;
  /** Authenticates the connectors process to the assistant; absent in core. */
  connectorsToken: string | null;
  /** Lets core publish to ntfy, which refuses everyone else (docker/ntfy-start.sh). Without it, UnifiedPush is off. */
  ntfyToken?: string | null;
}

function readSecret(name: string): string | null {
  for (const dir of ['/run/secrets', process.env.UCAP_SECRETS_DIR]) {
    if (!dir) continue;
    const file = join(dir, name);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  }
  return null;
}

function required(name: string): string {
  const value = readSecret(name);
  if (!value) throw new Error(`missing secret "${name}": run \`npm run setup\` (see README.md)`);
  return value;
}

export function loadSecrets(opts: { connectors: boolean }): Secrets {
  const masterKey = Buffer.from(required('master_key'), 'base64');
  const pepper = Buffer.from(required('pepper'), 'base64');
  if (masterKey.length !== 32 || pepper.length !== 32) throw new Error('master_key and pepper must be 32 bytes (base64)');
  return {
    masterKey: new Uint8Array(masterKey),
    pepper: new Uint8Array(pepper),
    connectorsToken: opts.connectors ? required('connectors_token') : null,
    ntfyToken: readSecret('ntfy_token'),
  };
}

/** A key for one purpose, derived from the master key, so no two uses ever share a key. */
export function deriveKey(masterKey: Uint8Array, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, new Uint8Array(0), `ucap/${purpose}/v1`, 32));
}
