/**
 * The accessibility audit of the screen the app shows (docs/plan.md, Appendix J UI-01: "axe finds 0 serious issues on
 * every M1 screen"): axe-core injected into the app's WebView over its DevTools socket (debug builds), run on the page,
 * the violations printed by impact. Exits 1 when a serious or critical one is found.
 *
 *   node tools/android/axe.ts            # the screen in front
 *   node tools/android/axe.ts --all      # every impact, also moderate and minor
 */
import { readFileSync } from 'node:fs';
import { evaluate } from './cdp.ts';

const all = process.argv.includes('--all');
const source = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
await evaluate(`(() => { if (!window.axe) { (0, eval)(${JSON.stringify(source)}); } return typeof window.axe; })()`);
const r = (await evaluate(`(async () => {
  const res = await window.axe.run(document, { resultTypes: ['violations'] });
  return { title: document.querySelector('h1')?.textContent ?? document.title, violations: res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })) };
})()`)) as { title: string; violations: { id: string; impact: string; help: string; nodes: number; targets: string[] }[] };
const shown = r.violations.filter((v) => all || v.impact === 'serious' || v.impact === 'critical');
console.log(`${r.title}: ${shown.length ? '' : 'no '}${all ? '' : 'serious '}violations${shown.length ? ':' : ''}`);
for (const v of shown) console.log(`  ${v.impact} ${v.id} (${v.nodes}): ${v.help} — ${v.targets.join(', ')}`);
process.exit(r.violations.some((v) => v.impact === 'serious' || v.impact === 'critical') ? 1 : 0);
