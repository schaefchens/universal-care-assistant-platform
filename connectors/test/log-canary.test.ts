/**
 * The log canary (docs/plan-m3.md, K9: "the canary with Baileys, imapflow and nodemailer at their loudest levels (no
 * content, no password in any log)"). Each library runs in a process of its own, as in production: imapflow and
 * nodemailer with UCAP's options (canary/email-child.ts), Baileys and libsignal under UCAP's quiet logger and console
 * (canary/whatsapp-child.ts), each with every other switch at its loudest. The canary words pass through them: a
 * password, a subject, texts, addresses and numbers, the private keys of a Signal session. A process's whole output,
 * whatever writes there (the console, a library's own logger), must hold none of them, in no form (as written, hex,
 * base64). That they really passed is checked too: the servers got the password and the mail, imapflow's own log
 * events carried the texts, libsignal dumped the session with its keys, Baileys passed the numbers to its logger.
 *
 * The mail servers here are TLS servers that answer just what the exchange asks, with a certificate for
 * mail.canary.test made for each run (openssl; no key is kept in the repository). M1's canary for the servers' own
 * logs is AS-11 (server/test/speech.test.ts).
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { createTransport } from 'nodemailer';
import { afterAll, describe, expect, it } from 'vitest';

const CERTS = mkdtempSync(join(tmpdir(), 'ucap-canary-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(CERTS, 'key.pem'), '-out', join(CERTS, 'cert.pem'), '-days', '2', '-subj', '/CN=mail.canary.test', '-addext', 'subjectAltName=DNS:mail.canary.test'], { stdio: 'ignore' });
const key = readFileSync(join(CERTS, 'key.pem'));
const cert = readFileSync(join(CERTS, 'cert.pem'));

const ADDRESS = 'clara.kanarie@example.org';
const PASSWORD = 'Kanarienpasswort-Geheim-7341';
const ANNA = 'anna.kanarienzucht@example.org';
const REFUSED = 'niemand.kanarienhof@example.org';
const SUBJECT = 'Kanarienbetreff zum Samstag';
const TEXT = 'Der Kanarienvogel singt um Mitternacht im Treppenhaus.';
const REPLY = 'Antwort mit der Kanarienfeder: Samstag passt.';
const REFUSAL = 'Kanarienpostfach unbekannt';

/** What a child process wrote to stdout and stderr, and what it reported over IPC. */
async function run(child: string, config: unknown): Promise<{ output: string; found: Record<string, unknown> }> {
  const p = spawn(process.execPath, [fileURLToPath(new URL(`canary/${child}`, import.meta.url)), JSON.stringify(config)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    // Libraries that read the environment for their level: as loud as it goes.
    env: { ...process.env, DEBUG: '*', LOG_LEVEL: 'trace' },
  });
  let output = '';
  p.stdout!.on('data', (d: Buffer) => (output += d.toString()));
  p.stderr!.on('data', (d: Buffer) => (output += d.toString()));
  let found: Record<string, unknown> = {};
  p.on('message', (m) => (found = m as Record<string, unknown>));
  const code = await new Promise<number | null>((r) => p.on('close', r));
  // Only whether it ended well: the output is never printed, it may hold what the canary looks for.
  expect(code, `${child} ended with ${code}`).toBe(0);
  return { output, found };
}

/** Every form a word could take in a log: as written, its bytes as hex, base64. */
function forms(word: string): string[] {
  const b = Buffer.from(word);
  return [word, word.toLowerCase(), b.toString('hex'), b.toString('base64')];
}

function leaked(output: string, words: string[]): string[] {
  return words.filter((w) => forms(w).some((f) => output.includes(f)));
}

const servers: Server[] = [];
async function listen(s: Server): Promise<number> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}
afterAll(() => {
  for (const s of servers) s.close();
  rmSync(CERTS, { recursive: true, force: true });
});

/** Lines from a socket, with an IMAP literal ({n} at a line's end) read as bytes after a continuation. */
function lines(sock: TLSSocket, onLine: (line: string, literal?: Buffer) => void, imap: boolean) {
  let buf = Buffer.alloc(0);
  let literal: { line: string; need: number; bytes?: Buffer } | null = null;
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (literal && !literal.bytes) {
        if (buf.length < literal.need) return;
        literal.bytes = buf.subarray(0, literal.need);
        buf = buf.subarray(literal.need);
      }
      const eol = buf.indexOf('\r\n');
      if (eol < 0) return;
      const line = buf.subarray(0, eol).toString();
      buf = buf.subarray(eol + 2);
      if (literal) {
        const done = literal;
        literal = null;
        onLine(done.line + line, done.bytes);
        continue;
      }
      const lit = imap ? /\{(\d+)\}$/.exec(line) : null;
      if (lit) {
        literal = { line, need: Number(lit[1]) };
        sock.write('+ Ready for literal data\r\n');
        continue;
      }
      onLine(line);
    }
  });
}

/** An IMAP server with one mail in INBOX, answering what imapflow asks for it (no extensions offered). */
function imapServer(mail: Buffer, got: { login: string[]; appended: string[] }): Server {
  return createServer({ key, cert }, (sock) => {
    sock.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
    lines(
      sock,
      (line, literal) => {
        const [tag, ...rest] = line.split(' ');
        const cmd = (rest[0] === 'UID' ? `UID ${rest[1]}` : rest[0] ?? '').toUpperCase();
        const ok = (text = 'done') => sock.write(`${tag} OK ${text}\r\n`);
        if (cmd === 'CAPABILITY') {
          sock.write('* CAPABILITY IMAP4rev1\r\n');
          ok();
        } else if (cmd === 'LOGIN') {
          got.login.push(line);
          if (line.includes(PASSWORD)) ok('[CAPABILITY IMAP4rev1] Logged in');
          else sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        } else if (cmd === 'LIST') {
          sock.write('* LIST (\\HasNoChildren) "/" INBOX\r\n* LIST (\\HasNoChildren \\Sent) "/" Sent\r\n');
          ok();
        } else if (cmd === 'SELECT' || cmd === 'EXAMINE') {
          sock.write('* FLAGS (\\Seen \\Answered)\r\n* OK [PERMANENTFLAGS (\\Seen \\Answered)] ok\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 2] ok\r\n');
          ok('[READ-WRITE] selected');
        } else if (cmd === 'UID FETCH') {
          sock.write(`* 1 FETCH (UID 1 BODY[] {${mail.length}}\r\n`);
          sock.write(mail);
          sock.write(')\r\n');
          ok();
        } else if (cmd === 'UID STORE') {
          sock.write('* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n');
          ok();
        } else if (cmd === 'APPEND') {
          got.appended.push(literal?.toString() ?? '');
          ok('[APPENDUID 7 2] appended');
        } else if (cmd === 'LOGOUT') {
          sock.write('* BYE logging out\r\n');
          ok();
          sock.end();
        } else if (cmd === 'NOOP') ok();
        else sock.write(`${tag} BAD not here\r\n`);
      },
      true,
    );
  });
}

/** An SMTP server that takes mail, except for one recipient, whom it refuses with words of its own. */
function smtpServer(got: { auth: string[]; data: string[] }): Server {
  return createServer({ key, cert }, (sock) => {
    let data: string[] | null = null;
    let login: 'user' | 'pass' | null = null;
    sock.write('220 mail.canary.test ESMTP\r\n');
    lines(
      sock,
      (line) => {
        if (data) {
          if (line === '.') {
            got.data.push(data.join('\r\n'));
            data = null;
            // As a server may quote what it took.
            sock.write(`250 2.0.0 Ok: queued, ${SUBJECT}\r\n`);
          } else data.push(line);
          return;
        }
        if (login) {
          got.auth.push(Buffer.from(line, 'base64').toString());
          if (login === 'user') {
            login = 'pass';
            sock.write('334 UGFzc3dvcmQ6\r\n');
          } else {
            login = null;
            sock.write('235 2.7.0 Authentication successful\r\n');
          }
          return;
        }
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') sock.write('250-mail.canary.test\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
        else if (verb === 'AUTH' && /^AUTH PLAIN \S+/i.test(line)) {
          got.auth.push(Buffer.from(line.split(' ')[2]!, 'base64').toString());
          sock.write('235 2.7.0 Authentication successful\r\n');
        } else if (verb === 'AUTH') {
          login = 'user';
          sock.write('334 VXNlcm5hbWU6\r\n');
        } else if (verb === 'MAIL' || verb === 'RSET' || verb === 'NOOP') sock.write('250 2.1.0 Ok\r\n');
        else if (verb === 'RCPT') sock.write(line.includes(REFUSED) ? `550 5.1.1 <${REFUSED}>: ${REFUSAL}\r\n` : '250 2.1.5 Ok\r\n');
        else if (verb === 'DATA') {
          data = [];
          sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') {
          sock.write('221 2.0.0 Bye\r\n');
          sock.end();
        } else sock.write('502 5.5.2 not here\r\n');
      },
      false,
    );
  });
}

describe('the log canary', () => {
  it('imapflow and nodemailer, with UCAP’s options and everything else at its loudest, write nothing of the password or the mail anywhere', async () => {
    const mail = (await createTransport({ streamTransport: true, buffer: true }).sendMail({ from: `Anna <${ANNA}>`, to: ADDRESS, subject: SUBJECT, text: TEXT, messageId: '<kanarie-1@example.org>' })).message as Buffer;
    const imap = { login: [] as string[], appended: [] as string[] };
    const smtp = { auth: [] as string[], data: [] as string[] };
    const imapPort = await listen(imapServer(mail, imap));
    const smtpPort = await listen(smtpServer(smtp));
    const { output, found } = await run('email-child.ts', {
      address: ADDRESS,
      password: PASSWORD,
      imapPort,
      smtpPort,
      ca: join(CERTS, 'cert.pem'),
      words: [PASSWORD, TEXT, REPLY],
      text: TEXT,
      reply: { to: ANNA, refused: REFUSED, subject: `Re: ${SUBJECT}`, text: REPLY },
    });

    // The canary passed through both libraries: the servers got the password and the mails, the mail was read, a
    // reply sent and one refused; imapflow's own log entries, at its loudest, carried the texts. (imapflow 2.3.0 masks
    // the password in its entries, raw ones too: measured here, not relied on.)
    expect(imap.login.some((l) => l.includes(PASSWORD))).toBe(true);
    expect(smtp.auth.some((a) => a.includes(PASSWORD))).toBe(true);
    expect(imap.appended.some((a) => a.includes(REPLY))).toBe(true);
    expect(smtp.data.some((d) => d.includes(REPLY))).toBe(true);
    expect(found).toMatchObject({ parsed: true, sent: true, refused: true });
    expect(found.imapEvents).toBeGreaterThan(10);
    expect(found.wordsInEvents).toEqual(expect.arrayContaining([TEXT, REPLY]));

    // None of it in the process's output, in any form; the login as AUTH PLAIN sends it too.
    expect(leaked(output, [PASSWORD, `\0${ADDRESS}\0${PASSWORD}`, TEXT, REPLY, SUBJECT, ADDRESS, ANNA, REFUSED, REFUSAL])).toEqual([]);
  }, 30_000);

  it('Baileys at trace and libsignal’s session dumps, under UCAP’s quiet logger and console, write nothing of the keys, the text or the numbers; the hourly line keeps the wording only', async () => {
    const clara = '4917011122233';
    const anna = '4917044455566';
    const { output, found } = await run('whatsapp-child.ts', { clara: `${clara}@s.whatsapp.net`, anna: `${anna}@s.whatsapp.net`, text: TEXT });

    // libsignal closed the first session and dumped it, private keys and all; Baileys passed both numbers to its
    // logger; the message went from one to the other; Baileys warned with Anna's number.
    expect(found).toMatchObject({ closed: true, dumpCarriesKeys: true, loggerCarriesNumbers: true, decrypted: true, warned: true });
    const keys = found.forms as string[];
    expect(keys.length).toBeGreaterThan(0);

    expect(keys.filter((k) => output.includes(k))).toEqual([]);
    expect(leaked(output, [TEXT, clara, anna])).toEqual([]);
    // What was counted, by its wording: libsignal's dump and Baileys' warning, without the number.
    expect(output).toMatch(/^whatsapp: last hour: .*"console: Closing session:"/m);
    expect(output).toContain('"Invalid LID-PN mapping: <jid> <jid>"');
  }, 30_000);
});
