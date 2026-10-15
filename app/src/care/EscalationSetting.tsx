/**
 * The order of helpers for help requests (docs/plan.md, S4 "Escalation plans"; Appendix D): for each helper who may
 * answer them, at once or after some minutes in which nobody accepted. Set by the person, or by a helper they allowed
 * to (care.configure: "einstellen, wer bei deinen Hilferufen benachrichtigt wird"). Part of the escalation plan,
 * saved whole with its other settings, and read back as a sentence. A helper none of whose devices can be reached is
 * named (Appendix D: "The plan editor warns about helpers without a reachable device").
 */
import { useEffect, useState } from 'react';
import { Button, Label, Radio, RadioGroup } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';
import { DELAYS_S, delaysFromTiers, orderSummary, type Tier, tiersFromDelays } from './escalation.ts';
import { refreshFallbacks } from './phone.ts';

interface PlanView {
  version: number;
  tiers: Tier[];
  realertS: number;
  sosNumber: string;
  phoneFallback: unknown;
  unconfirmedPolicy: 'send' | 'drop';
  helpers: { id: string; displayName: string; reachable: boolean }[];
}

/**
 * `personName`: set when a helper opens it for the person they help. `refresh`: changes whenever the page's
 * relationships do (a helper added, ended, given other scopes), so the order lists who answers help requests now.
 */
export function EscalationSetting(p: { session: Session; personId: string; personName?: string; refresh?: string }) {
  const { tr, say, lang } = useUi();
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [delays, setDelays] = useState<Map<string, number>>(new Map());
  const [status, setStatus] = useState('');
  const url = `/api/v1/people/${p.personId}/escalation-plan`;
  const own = p.personId === p.session.ref.userId;

  const load = async () => {
    const v = await p.session.call<PlanView>(url);
    setPlan(v);
    setDelays(delaysFromTiers(v.tiers));
  };
  useEffect(() => {
    void load().catch(() => {});
  }, [p.session, p.personId, p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  async function save() {
    if (!plan) return;
    const tiers = tiersFromDelays(delays, plan.tiers.at(-1)?.waitS);
    if (tiers === 'no_first') return tell(tr('escalation.needFirst'));
    // The names of the plan that was saved, kept across the reload.
    const name = (id: string) => plan.helpers.find((h) => h.id === id)?.displayName ?? '';
    try {
      // The plan is saved whole: everything else as it is.
      await p.session.call(url, { method: 'PUT', body: { version: plan.version, tiers, realertS: plan.realertS, sosNumber: plan.sosNumber, phoneFallback: plan.phoneFallback, unconfirmedPolicy: plan.unconfirmedPolicy } });
      if (own) await refreshFallbacks(p.session);
      await load();
      tell(`${tr('escalation.saved')} ${orderSummary(tiers, name, tr, lang)}`);
    } catch (e) {
      tell(tr(e instanceof ApiError && e.code === 'conflict' ? 'fallback.stale' : `error.${e instanceof ApiError ? e.code : 'internal'}`));
      await load().catch(() => {});
    }
  }

  if (!plan) return null;
  const title = p.personName ? tr('escalation.title.of', { name: p.personName }) : tr('escalation.title');
  const name = (id: string) => plan.helpers.find((h) => h.id === id)?.displayName ?? '';
  // With one helper there is no order to choose: on one's own page nothing, for a helper what is in force.
  if (plan.helpers.length < 2)
    return own ? null : (
      <section className="settings-section">
        <h2>{title}</h2>
        <p>{orderSummary(plan.tiers, name, tr, lang)}</p>
      </section>
    );
  const choice = (s: number) => (s === 0 ? tr('escalation.at.once') : tr('escalation.at.after', { n: s / 60 }));
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      <p>{tr('escalation.intro')}</p>
      {plan.helpers.map((h) => {
        const value = delays.get(h.id) ?? 0;
        // A delay set elsewhere that is not among the choices is shown as it is.
        const options = DELAYS_S.includes(value) ? DELAYS_S : [...DELAYS_S, value].sort((a, b) => a - b);
        return (
          <RadioGroup key={h.id} className="choice" value={String(value)} onChange={(v) => setDelays(new Map(delays).set(h.id, Number(v)))}>
            <Label className="choice-label">{tr('escalation.notify', { name: h.displayName })}</Label>
            {options.map((s) => (
              <Radio key={s} value={String(s)} className="choice-option">
                {choice(s)}
              </Radio>
            ))}
          </RadioGroup>
        );
      })}
      {plan.helpers
        .filter((h) => !h.reachable)
        .map((h) => (
          <p key={h.id} className="status warning">
            {tr('escalation.unreachable', { name: h.displayName })}
          </p>
        ))}
      <Button className="button primary" onPress={() => void save()}>
        {tr('escalation.save')}
      </Button>
      <p role="status" className="status">
        {status}
      </p>
    </section>
  );
}
