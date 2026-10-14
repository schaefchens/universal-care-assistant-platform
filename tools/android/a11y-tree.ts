/**
 * The accessibility tree of the screen the app shows, as Chrome gives it to Android's accessibility services (docs/plan.md,
 * Appendix J UI-02: "buttons in every mode, the same DOM with TalkBack on and off"): one line per node that is not
 * ignored, with its role and name, indented by depth. Live regions are left out: what they say changes with every
 * announcement. Save it with TalkBack off and on, then compare:
 *
 *   node tools/android/a11y-tree.ts > off.txt
 *   node tools/android/a11y-tree.ts --dom    # also a signature of the DOM: every element with its role and labels
 */
import { call, evaluate } from './cdp.ts';

interface AXNode {
  nodeId: string;
  parentId?: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  childIds?: string[];
  properties?: { name: string; value: { value: unknown } }[];
}

const { nodes } = (await call('Accessibility.getFullAXTree', {}, ['Accessibility.enable'])) as { nodes: AXNode[] };
const byId = new Map(nodes.map((n) => [n.nodeId, n]));
const live = (n: AXNode) => n.properties?.some((p) => p.name === 'live' && p.value.value !== 'off');
const lines: string[] = [];
const walk = (n: AXNode, depth: number) => {
  if (live(n)) return;
  const shown = !n.ignored && n.role?.value !== 'generic' && n.role?.value !== 'none';
  if (shown) lines.push(`${'  '.repeat(depth)}${n.role?.value ?? '?'}${n.name?.value ? ` "${n.name.value}"` : ''}`);
  for (const c of n.childIds ?? []) {
    const child = byId.get(c);
    if (child) walk(child, shown ? depth + 1 : depth);
  }
};
const root = nodes.find((n) => !n.parentId);
if (root) walk(root, 0);
console.log(lines.join('\n'));

if (process.argv.includes('--dom')) {
  const dom = await evaluate(`[...document.body.querySelectorAll('*')].filter((e) => !e.closest('[aria-live]')).map((e) => [e.tagName.toLowerCase(), e.getAttribute('role'), e.getAttribute('aria-label'), e.getAttribute('aria-hidden'), e.getAttribute('tabindex')].filter((x) => x !== null).join(' ')).join('\\n')`);
  console.log('--- DOM');
  console.log(dom);
}
