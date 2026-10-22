/**
 * A person's mail servers must be somewhere on the internet: never this server, its Docker network or the operator's
 * LAN, so no account can make the email process reach into them. The API refuses literal private addresses and names
 * without a dot (server/src/messaging/routes.ts); here what a name resolves to is checked, and the connection goes to
 * that address with the name kept for TLS. Resolved by the system (`dns.lookup`): nodemailer's own DNS queries can
 * hang where direct DNS is blocked (docs/spikes/m3.md, B).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function publicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 6) {
    const h = ip.toLowerCase();
    if (h.startsWith('::ffff:')) return publicAddress(h.slice(7));
    return !/^(::1?$|f[cd]|fe[89ab]|ff|2001:db8|64:ff9b)/.test(h);
  }
  if (v !== 4) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
}

/**
 * The server's address, when every address its name has is public. Throws `EPRIVATE` for a name that leads anywhere
 * else (the account cannot be used), and `ENOTFOUND` when the name does not resolve now (it may later).
 */
export async function resolvePublic(host: string, resolve: typeof lookup = lookup): Promise<string> {
  const all = await resolve(host, { all: true }).catch(() => []);
  if (!all.length) throw Object.assign(new Error('not resolved'), { code: 'ENOTFOUND' });
  if (!all.every((x) => publicAddress(x.address))) throw Object.assign(new Error('not a public address'), { code: 'EPRIVATE' });
  return all[0]!.address;
}
