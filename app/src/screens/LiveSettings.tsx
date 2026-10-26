/**
 * LIVE mode's settings (docs/plan-m2.md, L1): on or off, how long the conversation may be quiet before the keyword is
 * needed again, quiet times, what UCAP says by itself, per service (docs/plan-m3.md, K8); part of the device
 * configuration, so helpers with device.configure change them too (the owner's decision). On the person's own page also
 * the assistant's name, which is the keyword, or a keyword of their own (CONCEPT §19: "might have a key word to
 * unlock").
 */
import { type DeviceConfig, LIVE_SERVICES, type LiveConfig, liveOf } from '@ucap/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Checkbox, Form, Input, Label, Slider, SliderOutput, SliderThumb, SliderTrack, Switch, Text, TextField } from 'react-aria-components';
import { useUi } from '../ui.tsx';

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const ASSISTANT_NAME = /^[A-Za-zÄÖÜäöüßÉéÈèÀàÇç]{2,20}( [A-Za-zÄÖÜäöüßÉéÈèÀàÇç]{2,20})?$/;

export function LiveSettings(p: {
  config: DeviceConfig;
  onConfig: (c: DeviceConfig) => void;
  /** The person's own page: the assistant's name and keyword (a setting of the person, on all their devices). */
  assistant?: {
    name: string | null;
    keyword: string | null;
    save: (o: { assistantName?: string; keyword?: string | null }) => Promise<boolean>;
    /** The app waits for the name; a browser opens the gate by touch alone. */
    spotsKeyword: boolean;
  };
}) {
  const { tr, say } = useUi();
  const live = liveOf(p.config);
  const set = (patch: Partial<LiveConfig>) => p.onConfig({ ...p.config, live: { ...live, ...patch } });
  const [name, setName] = useState(p.assistant?.name ?? '');
  const [keyword, setKeyword] = useState(p.assistant?.keyword ?? '');
  const [status, setStatus] = useState('');
  useEffect(() => {
    setName(p.assistant?.name ?? '');
    setKeyword(p.assistant?.keyword ?? '');
  }, [p.assistant?.name, p.assistant?.keyword]);
  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  async function saveAssistant(e: FormEvent) {
    e.preventDefault();
    if (!p.assistant) return;
    const n = name.trim();
    const k = keyword.trim();
    if (!ASSISTANT_NAME.test(n) || (k && !ASSISTANT_NAME.test(k))) return tell(tr('live.name.invalid'));
    const ok = await p.assistant.save({ assistantName: n, keyword: k || null });
    tell(ok ? tr('live.name.saved', { keyword: k || n }) : tr('error.internal'));
  }

  // On the person's own page the switch says what it did, as "LIVE an" by voice does; without a name it cannot be
  // called, so it stays off and says so. A helper's switch is part of a configuration the device announces.
  function setEnabled(enabled: boolean) {
    if (!p.assistant) return set({ enabled });
    const keyword = p.assistant.keyword || p.assistant.name;
    if (enabled && !keyword) return tell(tr('live.needName'));
    set({ enabled });
    tell(enabled ? tr(p.assistant.spotsKeyword ? 'live.on' : 'live.on.touch', { keyword: keyword ?? '' }) : tr('live.off'));
  }

  const quietMin = Math.max(1, Math.round(live.quietS / 60));
  return (
    <section className="settings-section">
      <h2>{tr('live.title')}</h2>
      <p className="muted">{tr('live.intro')}</p>
      <Switch className="switch" isSelected={live.enabled} onChange={setEnabled}>
        <span className="switch-indicator" aria-hidden />
        {tr('live.enabled')}
      </Switch>
      {p.assistant && (
        <Form className="stack" onSubmit={saveAssistant}>
          <TextField value={name} onChange={setName} className="field" autoComplete="off" maxLength={41}>
            <Label>{tr('live.name')}</Label>
            <Input />
            <Text slot="description">{tr('live.name.hint')}</Text>
          </TextField>
          <TextField value={keyword} onChange={setKeyword} className="field" autoComplete="off" maxLength={41}>
            <Label>{tr('live.keyword')}</Label>
            <Input />
            <Text slot="description">{tr('live.keyword.hint')}</Text>
          </TextField>
          <Button type="submit" className="button" isDisabled={!name.trim()}>
            {tr('live.name.save')}
          </Button>
        </Form>
      )}
      <Slider className="range" value={quietMin} minValue={1} maxValue={30} step={1} onChange={(m) => set({ quietS: m * 60 })}>
        <Label>{tr('live.quiet')}</Label>
        <SliderOutput>{({ state }) => tr('live.quiet.value', { n: state.getThumbValue(0) })}</SliderOutput>
        <SliderTrack className="range-track">
          <SliderThumb className="range-thumb" />
        </SliderTrack>
      </Slider>
      <div className="stack" role="group" aria-label={tr('live.say')}>
        <p className="choice-label">{tr('live.say')}</p>
        <Checkbox className="choice-option checkbox" isSelected={live.say.messages} onChange={(messages) => set({ say: { ...live.say, messages } })}>
          {tr('live.say.messages')}
        </Checkbox>
        {/* Per service (docs/plan-m3.md, K8): every service is offered, so a helper's page shows nothing of which
            the person uses. */}
        <div className="stack choice-group" role="group" aria-label={tr('live.say.services')}>
          {LIVE_SERVICES.map((s) => (
            <Checkbox
              key={s}
              className="choice-option checkbox"
              isDisabled={!live.say.messages}
              isSelected={live.say.services?.[s] !== false}
              onChange={(on) => set({ say: { ...live.say, services: { ...live.say.services, [s]: on } } })}
            >
              {tr(`live.say.service.${s}`)}
            </Checkbox>
          ))}
        </div>
        <p className="muted">{tr('live.say.always')}</p>
        <p className="muted">{tr('live.say.asked')}</p>
      </div>
      <QuietTimes value={live.quietTimes} onChange={(quietTimes) => set({ quietTimes })} />
      <p role="status" className="status">
        {status}
      </p>
    </section>
  );
}

/** The quiet times, each from–to (across midnight too): one row each, an empty row to add one. */
function QuietTimes(p: { value: LiveConfig['quietTimes']; onChange: (v: LiveConfig['quietTimes']) => void }) {
  const { tr } = useUi();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const add = () => {
    if (!TIME.test(from.trim()) || !TIME.test(to.trim()) || p.value.length >= 4) return;
    p.onChange([...p.value, { from: from.trim(), to: to.trim() }]);
    setFrom('');
    setTo('');
  };
  return (
    <div className="stack" role="group" aria-label={tr('live.quietTimes')}>
      <p className="choice-label">{tr('live.quietTimes')}</p>
      <p className="muted">{tr('live.quietTimes.hint')}</p>
      {p.value.map((q, i) => (
        <div key={`${q.from}-${q.to}-${i}`} className="row">
          <span>{tr('live.quietTimes.range', { from: q.from, to: q.to })}</span>
          <Button className="button" onPress={() => p.onChange(p.value.filter((_, j) => j !== i))}>
            {tr('live.quietTimes.remove', { from: q.from, to: q.to })}
          </Button>
        </div>
      ))}
      {p.value.length < 4 && (
        <div className="row">
          <TextField value={from} onChange={setFrom} className="field" autoComplete="off" maxLength={5}>
            <Label>{tr('live.quietTimes.from')}</Label>
            <Input inputMode="numeric" placeholder="22:00" />
          </TextField>
          <TextField value={to} onChange={setTo} className="field" autoComplete="off" maxLength={5}>
            <Label>{tr('live.quietTimes.to')}</Label>
            <Input inputMode="numeric" placeholder="07:00" />
          </TextField>
          <Button className="button" isDisabled={!TIME.test(from.trim()) || !TIME.test(to.trim())} onPress={add}>
            {tr('live.quietTimes.add')}
          </Button>
        </div>
      )}
    </div>
  );
}
