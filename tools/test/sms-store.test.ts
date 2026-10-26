/**
 * Android's SMS and MMS store is the person's (docs/plan-m3.md, K9: "Android's SMS store is the person's and UCAP never
 * deletes from it"). As the SMS app, UCAP writes what it receives and sends there and marks it read and sent, so the
 * history stays when the role goes back; disconnecting SMS deletes UCAP's copies on the server and its own small
 * database on the phone (SmsSync.disconnect), never a message of the store. Only the SMS app may delete from the store
 * (docs/spikes/m3.md, C), so nothing in the app may ask a content provider to.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(REPO, 'app/android/app/src');

function javaFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return javaFiles(p);
    return p.endsWith('.java') || p.endsWith('.kt') ? [p] : [];
  });
}

/** A content provider asked to delete: the resolver's delete, a batch's delete operation, or a client's. */
const DELETES = /\b(?:getContentResolver\(\)|[A-Za-z_]*[Rr]esolver|[A-Za-z_]*[Cc]lient)\s*\.\s*delete\s*\(|ContentProviderOperation\s*\.\s*newDelete\s*\(/;

describe("Android's SMS store", () => {
  it('nothing in the app asks a content provider to delete; what it writes to the store is new messages and their read and sent states', () => {
    const files = [...javaFiles(join(SRC, 'main')), ...javaFiles(join(SRC, 'debug'))];
    expect(files.length).toBeGreaterThan(20);
    const deleting = files.filter((f) => DELETES.test(readFileSync(f, 'utf8'))).map((f) => relative(REPO, f));
    expect(deleting).toEqual([]);
    // Inserts and updates go to the SMS and MMS store only (SmsStore, MmsStore).
    const writing = files.filter((f) => /getContentResolver\(\)\s*\.\s*(?:insert|update|bulkInsert|applyBatch)\s*\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f).split('/').pop());
    expect(writing.sort()).toEqual(['MmsStore.java', 'SmsStore.java']);
  });
});
