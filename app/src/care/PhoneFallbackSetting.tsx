/**
 * The phone fallback (docs/plan.md, S5, Appendix D A3b), opt-in for each person: whom this device offers to call when
 * a help request cannot reach the server. Part of the escalation plan, so every device of the person and their
 * helpers with care.configure see the same; kept on the device for offline use. The call is placed only by a
 * deliberate activation, never by itself.
 */
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Form, Input, Label, Switch, TextField } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { Alerts, has } from '../native/plugins.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';
import { type PhoneFallback, refreshFallbacks } from './phone.ts';

interface PlanView {
  version: number;
  tiers: { waitS: number; helpers: string[] }[];
  realertS: number;
  sosNumber: string;
  phoneFallback: PhoneFallback | null;
  unconfirmedPolicy: 'send' | 'drop';
}

/** "+49 30 / 123-45 67" → "+4930123 4567" without the spaces: what a dialler takes. */
export const normaliseNumber = (s: string) => s.replace(/[\s/().-]/g, '');

export function PhoneFallbackSetting(p: { session: Session }) {
  const { tr, say } = useUi();
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [direct, setDirect] = useState(false);
  const [status, setStatus] = useState('');
  const url = `/api/v1/people/${p.session.ref.userId}/escalation-plan`;

  const load = async () => {
    const v = await p.session.call<PlanView>(url);
    setPlan(v);
    setName(v.phoneFallback?.name ?? '');
    setNumber(v.phoneFallback?.number ?? '');
    setDirect(v.phoneFallback?.direct ?? false);
  };
  useEffect(() => {
    void load().catch(() => {});
  }, [p.session]); // eslint-disable-line react-hooks/exhaustive-deps

  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  async function save(fallback: PhoneFallback | null) {
    if (!plan) return;
    try {
      await p.session.call(url, { method: 'PUT', body: { version: plan.version, tiers: plan.tiers, realertS: plan.realertS, sosNumber: plan.sosNumber, phoneFallback: fallback, unconfirmedPolicy: plan.unconfirmedPolicy } });
      await refreshFallbacks(p.session);
      await load();
      tell(fallback ? tr(fallback.direct ? 'fallback.saved.direct' : 'fallback.saved', { name: fallback.name }) : tr('fallback.removed'));
    } catch (e) {
      tell(tr(e instanceof ApiError && e.code === 'conflict' ? 'fallback.stale' : `error.${e instanceof ApiError ? e.code : 'internal'}`));
      if (e instanceof ApiError && e.code === 'conflict') await load().catch(() => {});
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = normaliseNumber(number);
    if (!/^\+?[0-9]{3,15}$/.test(n)) return tell(tr('fallback.badNumber'));
    let d = direct;
    // Direct calls need Android's phone permission: asked now, so the call itself is never held up by a question.
    if (d && has('Alerts')) d = (await Alerts.requestCallPermission().catch(() => ({ granted: false }))).granted;
    if (direct && !d) tell(tr('fallback.noPermission'));
    await save({ name: name.trim(), number: n, direct: d });
  }

  if (!plan) return null;
  return (
    <section className="settings-section">
      <h2>{tr('fallback.title')}</h2>
      <p>{tr('fallback.intro')}</p>
      <Form onSubmit={submit} className="stack">
        <TextField value={name} onChange={setName} isRequired maxLength={40} className="field">
          <Label>{tr('fallback.name')}</Label>
          <Input />
        </TextField>
        <TextField value={number} onChange={setNumber} isRequired maxLength={24} className="field" inputMode="tel" autoComplete="tel">
          <Label>{tr('fallback.number')}</Label>
          <Input />
        </TextField>
        <Switch className="switch" isSelected={direct} onChange={setDirect}>
          <span className="switch-indicator" aria-hidden />
          {tr('fallback.direct')}
        </Switch>
        <div className="row">
          <Button type="submit" className="button primary" isDisabled={!name.trim() || !number.trim()}>
            {tr('fallback.save')}
          </Button>
          {plan.phoneFallback && (
            <Button className="button" onPress={() => void save(null)}>
              {tr('fallback.remove')}
            </Button>
          )}
        </div>
      </Form>
      <p role="status" className="status">
        {status}
      </p>
    </section>
  );
}
