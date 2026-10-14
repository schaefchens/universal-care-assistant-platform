/**
 * Credentials kept in the database are sealed (docs/plan.md, Appendix I: provider keys, push auth secrets, the VAPID
 * private key): AES-256-GCM with a key derived from the master key, and bound to where they belong (the additional
 * data), so a sealed value copied into another row does not open. Format: 0x01 | iv (12) | tag (16) | ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Clock } from './clock.ts';
import type { Exec } from './db.ts';
import { deriveKey } from './secrets.ts';

export interface Sealer {
  seal(plain: string, context: string): Buffer;
  open(sealed: Uint8Array, context: string): string;
}

export function createSealer(masterKey: Uint8Array): Sealer {
  const key = deriveKey(masterKey, 'sealed');
  return {
    seal(plain, context) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(context));
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
    },
    open(sealed, context) {
      const b = Buffer.from(sealed);
      if (b[0] !== 1 || b.length < 29) throw new Error('unknown sealed format');
      const d = createDecipheriv('aes-256-gcm', key, b.subarray(1, 13));
      d.setAAD(Buffer.from(context));
      d.setAuthTag(b.subarray(13, 29));
      return Buffer.concat([d.update(b.subarray(29)), d.final()]).toString('utf8');
    },
  };
}

/** A server secret made once, at first need (concurrent first starts agree on one), and sealed at rest. */
export async function storedSecret(exec: Exec, sealer: Sealer, clock: Clock, name: string, make: () => string): Promise<string> {
  const context = `stored_secret:${name}`;
  await sql`insert into stored_secrets (name, sealed, created_at) values (${name}, ${sealer.seal(make(), context)}, ${new Date(clock())})
    on conflict (name) do nothing`.execute(exec);
  const r = await sql<{ sealed: Buffer }>`select sealed from stored_secrets where name = ${name}`.execute(exec);
  return sealer.open(r.rows[0]!.sealed, context);
}
