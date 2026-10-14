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

export async function evaluate(expression: string): Promise<unknown> {
  const pid = execFileSync(ADB, ['shell', 'pidof', APP]).toString().trim();
  if (!pid) throw new Error('the app is not running');
  execFileSync(ADB, ['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
  const pages = (await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())) as { url: string; webSocketDebuggerUrl: string }[];
  const page = pages.find((p) => p.url.startsWith('https://localhost'));
  if (!page) throw new Error('no page at https://localhost');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const msg = await new Promise<string>((r) => ws.addEventListener('message', (e) => r(String(e.data)), { once: true }));
  ws.close();
  const res = JSON.parse(msg) as { result?: { result?: { value?: unknown }; exceptionDetails?: { text: string } } };
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
  return res.result?.result?.value;
}

if (import.meta.main) {
  const v = await evaluate(process.argv[2] ?? 'document.title');
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
}
