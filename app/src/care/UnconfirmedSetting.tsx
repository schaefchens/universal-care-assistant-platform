/**
 * What happens to a help question nobody answered (docs/plan.md, Decisions "Other help": "unanswered twice in
 * push-to-talk, it is sent marked 'unconfirmed'"; Appendix D: "a per-person setting, on by default"). Part of the
 * escalation plan, so every device of the person, and helpers with care.configure, see the same; kept on the device.
 */
import { useEffect, useState } from 'react';
import { Label, Radio, RadioGroup } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';
import { refreshFallbacks } from './phone.ts';

interface PlanView {
  version: number;
  tiers: { waitS: number; helpers: string[] }[];
  realertS: number;
  sosNumber: string;
  phoneFallback: unknown;
  unconfirmedPolicy: 'send' | 'drop';
}

export function UnconfirmedSetting(p: { session: Session; personId?: string }) {
  const { tr, say } = useUi();
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [status, setStatus] = useState('');
  // The person's own, or someone's a helper with care.configure sets up (docs/plan-m4.md, G2).
  const url = `/api/v1/people/${p.personId ?? p.session.ref.userId}/escalation-plan`;
  const load = async () => setPlan(await p.session.call<PlanView>(url));
  useEffect(() => {
    void load().catch(() => {});
  }, [p.session]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(policy: 'send' | 'drop') {
    if (!plan) return;
    try {
      // The plan is saved whole: everything else as it is.
      await p.session.call(url, { method: 'PUT', body: { version: plan.version, tiers: plan.tiers, realertS: plan.realertS, sosNumber: plan.sosNumber, phoneFallback: plan.phoneFallback, unconfirmedPolicy: policy } });
      await refreshFallbacks(p.session);
      await load();
      const text = tr(`unconfirmed.saved.${policy}`);
      setStatus(text);
      say(text, 'system');
    } catch (e) {
      const text = tr(e instanceof ApiError && e.code === 'conflict' ? 'fallback.stale' : `error.${e instanceof ApiError ? e.code : 'internal'}`);
      setStatus(text);
      say(text, 'system');
      await load().catch(() => {});
    }
  }

  if (!plan) return null;
  return (
    <section className="settings-section">
      <h2>{tr('unconfirmed.title')}</h2>
      <RadioGroup className="choice" value={plan.unconfirmedPolicy} onChange={(v) => void save(v as 'send' | 'drop')}>
        <Label className="choice-label">{tr('unconfirmed.intro')}</Label>
        <Radio value="send" className="choice-option">
          {tr('unconfirmed.send')}
        </Radio>
        <Radio value="drop" className="choice-option">
          {tr('unconfirmed.drop')}
        </Radio>
      </RadioGroup>
      <p role="status" className="status">
        {status}
      </p>
    </section>
  );
}
