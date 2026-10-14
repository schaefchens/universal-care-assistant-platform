import { createHash } from 'node:crypto';

/**
 * JSON exactly as herde hashes it: `json.dumps(value, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)` (herde/protocol.py `canonical_hash`). A profile's hash is the SHA-256 of
 * these bytes, and the worker compares it byte for byte (PROTOCOL.md, Profiles).
 *
 * JavaScript cannot tell 1.0 from 1, while Python writes a float as `1.0`. The profile's
 * `speech.top_p` is 1.0, so a plain JSON.stringify gives another hash and every worker would stay
 * out of step. ARCHE solved the same with PHP's JSON_PRESERVE_ZERO_FRACTION; here the keys whose
 * values are floats are named, and their whole numbers get their `.0`.
 */
export const FLOAT_KEYS: ReadonlySet<string> = new Set(['top_p', 'repetition_penalty', 'temperature']);

export function canonical(value: unknown, floatKeys: ReadonlySet<string> = FLOAT_KEYS): string {
  return write(value, null, floatKeys);
}

export function canonicalHash(value: unknown, floatKeys: ReadonlySet<string> = FLOAT_KEYS): string {
  return createHash('sha256').update(canonical(value, floatKeys), 'utf8').digest('hex');
}

function write(value: unknown, key: string | null, floatKeys: ReadonlySet<string>): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return number(value, key !== null && floatKeys.has(key));
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => write(v, key, floatKeys)).join(',') + ']';
  if (typeof value === 'object') {
    // Python sorts by code point; for the ASCII keys of the protocol that is plain string order.
    const keys = Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + write((value as Record<string, unknown>)[k], k, floatKeys)).join(',') + '}';
  }
  throw new TypeError(`canonical JSON cannot hold a ${typeof value}`);
}

function number(n: number, isFloat: boolean): string {
  if (!Number.isFinite(n)) throw new TypeError('canonical JSON cannot hold NaN or Infinity');
  // Both languages write the shortest form that reads back; only a float's whole number differs.
  if (isFloat && Number.isInteger(n)) return n.toFixed(1);
  return String(n);
}
