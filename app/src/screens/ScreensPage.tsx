/**
 * The person's own screens, shaped on this device (docs/plan-m4.md, G1; CONCEPT §6: "Users and authorized helpers
 * should be able to configure …"): the helper's editor's part for screens and areas, applied here at once when the
 * person chooses "Übernehmen", as any setting they change themselves (it becomes the device's next version, S11). The
 * protected controls hold as everywhere: what would remove help or the way back cannot be applied.
 */
import { checkConfig, type ConfigIssue, type DeviceConfig } from '@ucap/shared';
import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox } from 'react-aria-components';
import { has, Launcher } from '../native/plugins.ts';
import { useUi } from '../ui.tsx';
import { areaText, screenTitle } from './AreaScreen.tsx';
import { ScreensEditor } from './ScreensEditor.tsx';

export function ScreensPage(p: { config: DeviceConfig; onConfig: (c: DeviceConfig) => void; onClose: () => void }) {
  const { tr, say } = useUi();
  const [draft, setDraft] = useState<DeviceConfig>(() => structuredClone(p.config));
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState('');
  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  // This device's apps (G8), for areas that open them; a browser has none.
  const [apps, setApps] = useState<{ package: string; label: string }[]>([]);
  useEffect(() => {
    if (has('Launcher')) void Launcher.apps().then((r) => setApps(r.apps), () => {});
  }, []);
  const check = useMemo(() => checkConfig(draft, has('Launcher') ? { apps: apps.map((a) => a.package) } : {}), [draft, apps]);
  const issueText = (i: ConfigIssue) => {
    const s = draft.screens[i.screen ?? ''];
    const a = i.area && s?.areas.find((x) => x.id === i.area);
    const text = tr(`config.issue.${i.code}`, { label: a ? areaText(a, tr).label : '', ratio: String(i.ratio ?? '') });
    return s && i.screen !== draft.home ? `${screenTitle(s, tr)}: ${text}` : text;
  };
  const changed = JSON.stringify(draft) !== JSON.stringify(p.config);

  function apply() {
    if (check.errors.length) return tell(`${tr('config.editor.errors')} ${check.errors.map(issueText).join(' ')}`);
    if (check.warnings.length && !acknowledged) return tell(`${tr('config.editor.warnings')} ${check.warnings.map(issueText).join(' ')}`);
    p.onConfig(draft);
    setAcknowledged(false);
    tell(tr('screens.page.saved'));
  }

  return (
    <main className="page settings">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('screens.page.title')}</h1>
      </header>
      <p role="status" className="status">
        {status}
      </p>
      <ScreensEditor draft={draft} onDraft={setDraft} tell={tell} apps={apps} />
      {check.errors.length > 0 && (
        <div className="status warning" role="alert">
          {tr('config.editor.errors')} {check.errors.map(issueText).join(' ')}
        </div>
      )}
      {check.warnings.length > 0 && (
        <div className="status warning">
          <p>
            {tr('config.editor.warnings')} {check.warnings.map(issueText).join(' ')}
          </p>
          <Checkbox className="choice-option checkbox" isSelected={acknowledged} onChange={setAcknowledged}>
            {tr('config.editor.acknowledge')}
          </Checkbox>
        </div>
      )}
      <Button className="button primary" onPress={apply} isDisabled={!changed || check.errors.length > 0}>
        {tr('screens.page.save')}
      </Button>
    </main>
  );
}
