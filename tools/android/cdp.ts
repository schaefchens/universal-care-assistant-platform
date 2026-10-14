/**
 * Evaluates an expression in the app's WebView over its DevTools socket (debug builds enable web contents
 * debugging), and prints the result as JSON. From lookup's android-shell scripts/cdp.ts.
 *
 *   node tools/android/cdp.ts "document.title"
 */
import { execFileSync } from 'node:child_process';

const ADB = process.env.ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const APP = 'de.schaefchens.ucap';
const PORT = 9334;

/** One DevTools method on the app's page (a fresh socket each time), e.g. `Accessibility.getFullAXTree`. */
export async function call(method: string, params: Record<string, unknown> = {}, enable: string[] = []): Promise<Record<string, unknown>> {
  const pid = execFileSync(ADB, ['shell', 'pidof', APP]).toString().trim();
  if (!pid) throw new Error('the app is not running');
  execFileSync(ADB, ['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
  const pages = (await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())) as { url: string; webSocketDebuggerUrl: string }[];
  const page = pages.find((p) => p.url.startsWith('https://localhost'));
  if (!page) throw new Error('no page at https://localhost');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const calls = [...enable.map((m) => ({ method: m, params: {} })), { method, params }];
  const answers = new Map<number, Record<string, unknown>>();
  const done = new Promise<void>((resolve) =>
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number };
      if (m.id) answers.set(m.id, m as Record<string, unknown>);
      if (answers.has(calls.length)) resolve();
    }),
  );
  calls.forEach((c, i) => ws.send(JSON.stringify({ id: i + 1, ...c })));
  await done;
  ws.close();
  const res = answers.get(calls.length)! as { result?: Record<string, unknown>; error?: { message: string } };
  if (res.error) throw new Error(res.error.message);
  return res.result ?? {};
}

export async function evaluate(expression: string): Promise<unknown> {
  const res = (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result?.value;
}

if (import.meta.main) {
  const v = await evaluate(process.argv[2] ?? 'document.title');
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
}
