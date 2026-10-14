/**
 * A relay for Google's Maven repository. From this network dl.google.com answers HTTP/2 but never HTTP/1.1
 * (curl --http1.1 times out, --http2 answers in 0.15 s), and Gradle fetches dependencies over HTTP/1.1. So
 * Gradle asks 127.0.0.1:8098 in HTTP/1.1, and this relay asks Google over HTTP/2. Same files, same source.
 *
 *   node code/google-maven-relay.ts
 */
import { createServer } from 'node:http';
import http2 from 'node:http2';

const UPSTREAM = 'https://dl.google.com';
const PREFIX = '/dl/android/maven2';
let session: http2.ClientHttp2Session | null = null;

function upstream(): http2.ClientHttp2Session {
  if (!session || session.closed || session.destroyed) {
    const s = http2.connect(UPSTREAM);
    // After GOAWAY or a close, new streams fail: the next request opens a fresh session.
    const drop = () => {
      if (session === s) session = null;
    };
    s.on('goaway', drop);
    s.on('close', drop);
    s.on('error', drop);
    session = s;
  }
  return session;
}

/** One upstream request, retried on a fresh session: Gradle asks many in parallel, and a session can be cut. */
function relay(method: string, path: string, res: import('node:http').ServerResponse, attempt = 0) {
  let r: http2.ClientHttp2Stream;
  try {
    r = upstream().request({ ':method': method, ':path': PREFIX + path });
  } catch {
    session = null;
    if (attempt < 2) return relay(method, path, res, attempt + 1);
    res.writeHead(502);
    return res.end();
  }
  r.on('response', (h) => {
    const headers: Record<string, string> = {};
    for (const k of ['content-type', 'content-length', 'etag', 'last-modified']) if (typeof h[k] === 'string') headers[k] = h[k];
    res.writeHead(Number(h[':status']), headers);
    r.pipe(res);
  });
  r.on('error', (e) => {
    if (!res.headersSent && attempt < 2) {
      session = null;
      return relay(method, path, res, attempt + 1);
    }
    console.error(`relay: ${path}: ${e.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  r.end();
}

createServer((req, res) => relay(req.method ?? 'GET', req.url ?? '/', res)).listen(8098, '127.0.0.1', () =>
  console.log('relay: http://127.0.0.1:8098/ → https://dl.google.com/dl/android/maven2/ over HTTP/2'),
);
