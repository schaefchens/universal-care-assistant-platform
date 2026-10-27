/**
 * Setting up a person's device from a helper's own phone, tablet or browser (docs/plan.md, S11; CONCEPT §8 "Remote
 * setup"): how the screen looks, how touch works, and every screen of areas (docs/plan-m4.md, G1: their layout, areas
 * added and removed, each area's function, label, place, colour, sound, vibration and spoken description; new screens),
 * with a live preview in the person's colours and each area to listen to. What the device will say when the change
 * takes effect is shown before saving. Changes that would remove help or the way back cannot be saved;
 * warnings (a colour hard to read on) are saved only when acknowledged. The page tells a version saved on the server
 * from one the device received and applied, and sets an earlier version again.
 */
import { checkConfig, type ConfigIssue, describeChange, type DeviceConfig, THEME_IDS, type ThemeId, warningKey } from '@ucap/shared';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Form, Input, Label, Radio, RadioGroup, Slider, SliderOutput, SliderThumb, SliderTrack, TextField } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { areaText, screenTitle } from './AreaScreen.tsx';
import { useUi } from '../ui.tsx';
import { LiveSettings } from './LiveSettings.tsx';
import { MessagesSetting } from './MessagesSetting.tsx';
import { ScreensEditor } from './ScreensEditor.tsx';

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string | null;
  config: { id: string; version: number } | null;
}

interface Version {
  version: number;
  kind: 'device' | 'edit' | 'revert';
  author: { id: string; name: string } | null;
  note: string | null;
  createdAt: string;
}

interface Loaded {
  id: string;
  version: number;
  body: DeviceConfig;
  versions: Version[];
  state: { deliveredVersion: number | null; appliedVersion: number | null; deferredReason: string | null; repaired: string[] };
}

/** Two configurations alike, whatever order their keys came in (the server's store keeps its own). */
function same(a: unknown, b: unknown): boolean {
  const sorted = (v: unknown) =>
    JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([m], [n]) => (m < n ? -1 : m > n ? 1 : 0))) : x));
  return sorted(a) === sorted(b);
}

function Range(p: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <Slider className="range" value={p.value} minValue={p.min} maxValue={p.max} step={p.step} onChange={p.onChange}>
      <Label>{p.label}</Label>
      <SliderOutput>{({ state }) => p.format(state.getThumbValue(0))}</SliderOutput>
      <SliderTrack className="range-track">
        <SliderThumb className="range-thumb" />
      </SliderTrack>
    </Slider>
  );
}

export function DeviceEditor(p: { session: Session; person: { id: string; displayName: string }; myName: string; refresh: number; onClose: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [cfg, setCfg] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<DeviceConfig | null>(null);
  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState('');

  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  const failed = (e: unknown) => tell(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));

  async function loadDevices() {
    try {
      const r = await p.session.call<{ devices: DeviceRow[] }>(`/api/v1/people/${p.person.id}/devices`);
      setDevices(r.devices);
      setDeviceId((cur) => cur ?? r.devices.find((d) => d.config)?.id ?? r.devices[0]?.id ?? null);
    } catch (e) {
      failed(e);
    }
  }
  /**
   * The configuration as the server has it. A newer version (someone else's, the person's undo) replaces the draft,
   * so a save never puts back what was changed meanwhile; edits not saved yet are told to be lost.
   */
  async function loadConfig() {
    const d = devices?.find((x) => x.id === deviceId);
    if (!d?.config) {
      setCfg(null);
      setDraft(null);
      return;
    }
    try {
      const r = await p.session.call<Loaded>(`/api/v1/configs/${d.config.id}`);
      const newer = !cfg || cfg.id !== r.id || cfg.version !== r.version;
      const unsaved = cfg !== null && draft !== null && !same(draft, cfg.body) && !same(draft, r.body);
      setCfg(r);
      if (newer) {
        setDraft(structuredClone(r.body));
        setAcknowledged(false);
        if (unsaved && cfg?.id === r.id) tell(tr('config.editor.stale'));
      }
    } catch (e) {
      failed(e);
    }
  }
  useEffect(() => {
    void loadDevices();
  }, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void loadConfig();
  }, [deviceId, devices]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = useMemo(() => (draft ? checkConfig(draft) : { errors: [] as ConfigIssue[], warnings: [] as ConfigIssue[] }), [draft]);
  const willSay = useMemo(() => (cfg && draft ? describeChange({ lang: ui.lang, form: ui.form, author: p.myName, before: cfg.body, after: draft, max: 6 }) : []), [cfg, draft, ui.lang, ui.form, p.myName]);
  const issueText = (i: ConfigIssue) => {
    const s = draft?.screens[i.screen ?? ''];
    const a = i.area && s?.areas.find((x) => x.id === i.area);
    const text = tr(`config.issue.${i.code}`, { label: a ? areaText(a, tr).label : '', ratio: String(i.ratio ?? '').replace('.', ui.lang === 'de' ? ',' : '.') });
    // Which screen, when there is more than home (docs/plan-m4.md, G1).
    return s && draft && Object.keys(draft.screens).length > 1 && i.screen !== draft.home ? `${screenTitle(s, tr)}: ${text}` : text;
  };

  const setVisual = (patch: Partial<DeviceConfig['visual']>) => setDraft((d) => d && { ...d, visual: { ...d.visual, ...patch } });
  const setTouch = (patch: Partial<DeviceConfig['touch']>) => setDraft((d) => d && { ...d, touch: { ...d.touch, ...patch } });
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!cfg || !draft) return;
    if (check.errors.length) return tell(`${tr('config.editor.errors')} ${check.errors.map(issueText).join(' ')}`);
    if (check.warnings.length && !acknowledged) return tell(`${tr('config.editor.warnings')} ${check.warnings.map(issueText).join(' ')}`);
    try {
      const r = await p.session.call<{ version: number; unchanged: boolean }>(`/api/v1/configs/${cfg.id}/versions`, {
        method: 'POST',
        body: { base: cfg.version, body: draft, note: note.trim() || null, acknowledge: check.warnings.map(warningKey) },
      });
      if (r.unchanged) return tell(tr('config.editor.unchanged'));
      setNote('');
      tell(tr('config.editor.saved', { version: r.version, name: p.person.displayName }));
      await loadDevices();
    } catch (err) {
      if (err instanceof ApiError && err.params.reason === 'stale') await loadDevices();
      else failed(err);
    }
  }
  async function revert(v: number) {
    if (!cfg) return;
    try {
      await p.session.call(`/api/v1/configs/${cfg.id}/revert`, { method: 'POST', body: { base: cfg.version, to: v } });
      tell(tr('config.editor.reverted', { version: v }));
      await loadDevices();
    } catch (err) {
      if (err instanceof ApiError && err.params.reason === 'stale') await loadDevices();
      else failed(err);
    }
  }

  const stateText = () => {
    if (!cfg) return '';
    const s = cfg.state;
    if (s.appliedVersion === cfg.version) return tr(s.repaired.length ? 'config.editor.state.repaired' : 'config.editor.state.applied', { version: cfg.version });
    if (s.deliveredVersion === cfg.version)
      return s.deferredReason ? tr('config.editor.state.deferred', { version: cfg.version, reason: tr(`config.editor.reason.${s.deferredReason}`) }) : tr('config.editor.state.delivered', { version: cfg.version });
    return tr('config.editor.state.saved', { version: cfg.version });
  };
  const device = devices?.find((x) => x.id === deviceId);

  return (
    <main className="page settings device-editor">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('config.editor.back')}
        </Button>
        <h1>{tr('config.editor.title', { name: p.person.displayName })}</h1>
      </header>
      <p role="status" className="status">
        {status}
      </p>

      {devices && devices.length === 0 && <p>{tr('config.editor.noDevices', { name: p.person.displayName })}</p>}
      {devices && devices.length > 1 && (
        <RadioGroup className="choice" value={deviceId ?? ''} onChange={setDeviceId}>
          <Label className="choice-label">{tr('config.editor.devices')}</Label>
          {devices.map((d) => (
            <Radio key={d.id} value={d.id} className="choice-option">
              {d.name}
            </Radio>
          ))}
        </RadioGroup>
      )}
      {device && !device.config && <p>{tr('config.editor.noConfig')}</p>}
      {device && cfg && (
        <p className="status" aria-live="polite">
          {device.name}: {stateText()} {device.lastSeenAt ? tr('config.editor.lastSeen', { time: new Date(device.lastSeenAt) }) : ''}
        </p>
      )}

      {draft && cfg && (
        <Form className="stack" onSubmit={save}>
          <section className="settings-section">
            <h2>{tr('config.editor.look')}</h2>
            <RadioGroup className="choice" value={draft.visual.theme} onChange={(v) => setVisual({ theme: v as ThemeId })}>
              <Label className="choice-label">{tr('settings.theme')}</Label>
              {THEME_IDS.map((id) => (
                <Radio key={id} value={id} className="choice-option">
                  {tr(`settings.theme.${id}`)}
                </Radio>
              ))}
            </RadioGroup>
            <Range label={tr('settings.textScale')} value={draft.visual.textScale} min={1} max={3} step={0.25} format={(v) => `${Math.round(v * 100)} %`} onChange={(textScale) => setVisual({ textScale })} />
            <Range label={tr('settings.borders')} value={draft.visual.borderPx} min={0} max={12} step={1} format={(v) => `${v} px`} onChange={(borderPx) => setVisual({ borderPx })} />
          </section>

          {/* LIVE mode: helpers with device.configure switch it on and off directly (the owner's decision, docs/plan-m2.md). */}
          <MessagesSetting config={draft} onConfig={(c) => setDraft(c)} />
          <LiveSettings config={draft} onConfig={(c) => setDraft(c)} />
          <section className="settings-section">
            <h2>{tr('config.editor.touch')}</h2>
            <RadioGroup className="choice" value={draft.touch.mode} onChange={(v) => setTouch({ mode: v as DeviceConfig['touch']['mode'] })}>
              <Label className="choice-label">{tr('settings.touchMode')}</Label>
              {(['explore', 'direct', 'hold'] as const).map((m) => (
                <Radio key={m} value={m} className="choice-option">
                  {tr(`settings.touchMode.${m}`)}
                </Radio>
              ))}
            </RadioGroup>
            <Range label={tr('settings.dwell')} value={draft.touch.dwellMs} min={0} max={2000} step={100} format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(dwellMs) => setTouch({ dwellMs })} />
          </section>

          <ScreensEditor draft={draft} onDraft={setDraft} tell={tell} />

          {willSay.length > 0 && (
            <section className="settings-section">
              <h2>{tr('config.editor.willSay')}</h2>
              {willSay.map((l) => (
                <p key={l}>{l}</p>
              ))}
            </section>
          )}
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
          <TextField className="field" value={note} onChange={setNote}>
            <Label>{tr('config.editor.note')}</Label>
            <Input maxLength={300} />
          </TextField>
          <Button type="submit" className="button primary" isDisabled={check.errors.length > 0}>
            {tr('config.editor.save')}
          </Button>
        </Form>
      )}

      {cfg && cfg.versions.length > 1 && (
        <section className="settings-section">
          <h2>{tr('config.editor.versions')}</h2>
          <ul className="device-list">
            {cfg.versions.map((v) => (
              <li key={v.version} className="device">
                <p>
                  {tr('config.editor.version', { version: v.version, time: new Date(v.createdAt), name: v.author?.name ?? '?' })}
                  {v.note ? ` · ${v.note}` : ''}
                </p>
                {v.version !== cfg.version && (
                  <Button className="button" onPress={() => void revert(v.version)}>
                    {tr('config.editor.revert')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
