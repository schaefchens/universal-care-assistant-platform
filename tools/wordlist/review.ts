/**
 * The owner's listening pass (docs/plan.md, "The German wordlist", step 5): writes tools/wordlist/out/review.html, a
 * page that lists the 2048 words, the ones speech recognition did not hear as themselves first (with what it heard),
 * plays each as the recovery screen speaks it ("Wort: Apfel.") with the browser's own local German voice, and
 * collects the words marked for replacement, to copy out. Self-contained: no network, nothing leaves the page.
 *
 *   node tools/wordlist/review.ts && open tools/wordlist/out/review.html
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { score } from './stt-check.ts';

const OUT = new URL('out/', import.meta.url);
const list = JSON.parse(readFileSync(new URL('../../packages/identity/wordlists/de-dev.json', import.meta.url), 'utf8')) as { id: string; words: string[] };
const stt = new Map<string, { status: string; heard: string }>();
if (existsSync(new URL('stt.jsonl', OUT)))
  for (const line of readFileSync(new URL('stt.jsonl', OUT), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { word: string; status: string; heard: string };
    stt.set(r.word, r);
  }
const tiers = new Map<string, number>(existsSync(new URL('tiers.json', OUT)) ? (JSON.parse(readFileSync(new URL('tiers.json', OUT), 'utf8')) as [string, number][]) : []);

// Scored again from what was heard, so the page follows the current scoring rules without new recordings.
const listSet = new Set(list.words);
const rows = list.words.map((w) => {
  const r = stt.get(w);
  return { w, tier: tiers.get(w) ?? 0, status: r ? score(w, r.heard, listSet) : 'unchecked', heard: r?.heard ?? '' };
});
const order: Record<string, number> = { conflict: 0, flagged: 1, unchecked: 2, ok: 3 };
rows.sort((a, b) => order[a.status]! - order[b.status]! || a.w.localeCompare(b.w));
const counts = Object.fromEntries(Object.keys(order).map((k) => [k, rows.filter((r) => r.status === k).length]));

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);

const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wortliste prüfen</title>
<style>
:root { --bg: #f7f7f5; --fg: #16181b; --muted: #5a6068; --line: #d9dbde; --accent: #1a56db; --warn: #9a5b00; }
@media (prefers-color-scheme: dark) { :root { --bg: #15171a; --fg: #eceef0; --muted: #a2a8b0; --line: #30343a; --accent: #8ab4ff; --warn: #f0b45a; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 system-ui, sans-serif; }
main { max-width: 56rem; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.5rem; margin: 0.5rem 0; }
p { color: var(--muted); }
.bar { position: sticky; top: 0; background: var(--bg); padding: 0.5rem 0; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; border-bottom: 1px solid var(--line); }
button, select { font: inherit; padding: 0.4rem 0.8rem; border: 1px solid var(--line); border-radius: 0.4rem; background: transparent; color: var(--fg); cursor: pointer; }
table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
td { padding: 0.35rem 0.4rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
td.word { font-weight: 700; font-size: 1.1rem; }
td.heard { color: var(--muted); }
.flagged td.word, .conflict td.word { color: var(--warn); }
textarea { width: 100%; min-height: 4rem; font: inherit; background: transparent; color: var(--fg); border: 1px solid var(--line); border-radius: 0.4rem; }
</style>
</head>
<body>
<main>
<h1>Wortliste prüfen (${esc(list.id)}, ${list.words.length} Wörter)</h1>
<p>Zuerst die Wörter, die die Spracherkennung nicht als sich selbst gehört hat (${counts.flagged} markiert, ${counts.conflict} verwechselt, ${counts.unchecked} noch nicht geprüft). ▶ spricht das Wort so, wie der Wiederherstellungsbildschirm es spricht, mit der eingebauten deutschen Stimme dieses Browsers. Hake an, was ersetzt werden soll; unten steht die Liste zum Kopieren.</p>
<div class="bar">
  <label>Zeigen <select id="filter"><option value="all">alle</option><option value="flagged">nur markierte und verwechselte</option><option value="t3">nur Stufe 3 (nur Wiktionary)</option></select></label>
  <button id="stop" type="button">Stopp</button>
  <span id="voice"></span>
</div>
<table><tbody>
${rows
  .map(
    (r) =>
      `<tr class="${r.status}" data-status="${r.status}" data-tier="${r.tier}"><td><button type="button" class="play" data-w="${esc(cap(r.w))}" aria-label="${esc(cap(r.w))} anhören">▶</button></td><td class="word">${esc(cap(r.w))}</td><td>Stufe ${r.tier || '?'}</td><td class="heard">${r.status === 'ok' ? '' : esc(r.heard)}</td><td><label><input type="checkbox" value="${esc(r.w)}"> ersetzen</label></td></tr>`,
  )
  .join('\n')}
</tbody></table>
<h2>Zu ersetzen</h2>
<textarea id="out" readonly></textarea>
</main>
<script>
const voice = () => speechSynthesis.getVoices().find((v) => v.localService && v.lang.startsWith('de'));
const show = () => { const v = voice(); document.getElementById('voice').textContent = v ? 'Stimme: ' + v.name : 'Keine eingebaute deutsche Stimme gefunden'; };
speechSynthesis.onvoiceschanged = show; show();
document.addEventListener('click', (e) => {
  const b = e.target.closest('.play'); if (!b) return;
  const v = voice(); if (!v) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance('Wort: ' + b.dataset.w + '.'); u.voice = v; u.lang = v.lang; speechSynthesis.speak(u);
});
document.getElementById('stop').onclick = () => speechSynthesis.cancel();
document.addEventListener('change', (e) => {
  if (e.target.id === 'filter') {
    for (const tr of document.querySelectorAll('tbody tr')) tr.hidden = e.target.value === 'flagged' ? !['flagged', 'conflict'].includes(tr.dataset.status) : e.target.value === 't3' ? tr.dataset.tier !== '3' : false;
    return;
  }
  document.getElementById('out').value = [...document.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value).join(' ');
});
</script>
</body>
</html>
`;
writeFileSync(new URL('review.html', OUT), html);
console.log(`wrote tools/wordlist/out/review.html: ${JSON.stringify(counts)}`);
