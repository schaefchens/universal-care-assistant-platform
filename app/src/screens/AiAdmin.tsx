/**
 * The AI admin pages (docs/plan.md, S7), for administrators: speech providers (keys written, never shown again), what
 * the operator lets each receive (Appendix I), prices and monthly caps, this month's usage, and herde: invitations to
 * join (the command shown once) and the workers. Nothing here shows what anyone said or wrote.
 */
import { hasMessage } from '@ucap/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Checkbox, CheckboxGroup, Form, Heading, Input, Label, Radio, RadioGroup, Switch, TextField } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

interface Provider {
  id: string;
  function: 'tts' | 'stt' | 'llm';
  type: 'openai' | 'elevenlabs' | 'stt_mlx' | 'ollama' | 'anthropic';
  name: string;
  baseUrl: string | null;
  location: 'server' | 'operator_lan' | 'external';
  model: string | null;
  hasKey: boolean;
  allowedClasses: string[];
  priceMicrosPerUnit: number;
  monthlyCapMicros: number | null;
  voices: { id: string; label: string; langs: string[] }[];
  enabled: boolean;
  health: 'unknown' | 'ok' | 'failing';
  healthError: string | null;
  spentMicros: number;
}

interface Worker {
  id: number;
  name: string;
  trust: 'own' | 'lender';
  active: boolean;
  profile: string;
  lastSeen: string | null;
  voices: { id: string; label: string; langs: string[] }[];
}

const euros = (micros: number, lang: string) => new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR', maximumFractionDigits: 4 }).format(micros / 1_000_000);

/** "alloy:Alloy:de,en; nova:Nova" → voices; a language list left out means German and English. */
export function parseVoices(s: string): { id: string; label: string; langs: string[] }[] {
  return s
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [id, label, langs] = x.split(':').map((y) => y.trim());
      return { id: id!, label: label || id!, langs: langs ? langs.split(',').map((l) => l.trim()).filter(Boolean) : ['de', 'en'] };
    })
    .filter((v) => v.id);
}

function Field(p: { label: string; value: string; onChange: (v: string) => void; type?: string; description?: string }) {
  return (
    <TextField value={p.value} onChange={p.onChange} className="field" autoComplete="off">
      <Label>{p.label}</Label>
      <Input type={p.type ?? 'text'} />
      {p.description && <p className="muted">{p.description}</p>}
    </TextField>
  );
}

/**
 * Telegram's API credentials for this server (docs/plan.md, S10): the operator's own from my.telegram.org. The
 * api_hash is written only; the page shows whether it is set.
 */
function TelegramAdmin(p: { session: Session; tell: (text: string, show: (t: string) => void) => void }) {
  const { tr } = useUi();
  const [s, setS] = useState<{ configured: boolean; apiId: number | null; testDc: boolean } | null>(null);
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [testDc, setTestDc] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    void p.session.call<{ configured: boolean; apiId: number | null; testDc: boolean }>('/api/v1/ai-admin/telegram').then(
      (r) => {
        setS(r);
        setApiId(r.apiId ? String(r.apiId) : '');
        setTestDc(r.testDc);
      },
      () => {},
    );
  }, [p.session]);
  async function save(e: FormEvent) {
    e.preventDefault();
    const id = Number(apiId.trim());
    const hash = apiHash.trim().toLowerCase();
    if (!Number.isInteger(id) || id <= 0 || (hash && !/^[0-9a-f]{32}$/.test(hash)) || (!hash && !s?.configured)) return p.tell(tr('admin.telegram.invalid'), setStatus);
    try {
      const r = await p.session.call<{ configured: boolean; apiId: number | null; testDc: boolean }>('/api/v1/ai-admin/telegram', { method: 'PUT', body: { apiId: id, ...(hash ? { apiHash: hash } : {}), testDc } });
      setS(r);
      setApiHash('');
      p.tell(tr('admin.telegram.saved'), setStatus);
    } catch (err) {
      p.tell(tr(`error.${err instanceof ApiError ? err.code : 'internal'}`), setStatus);
    }
  }
  return (
    <section className="settings-section">
      <h2>{tr('admin.telegram.title')}</h2>
      <p className="muted">{tr('admin.telegram.intro')}</p>
      <p className="status">{s === null ? '' : s.configured ? tr(s.testDc ? 'admin.telegram.configuredTest' : 'admin.telegram.configured', { apiId: String(s.apiId) }) : tr('admin.telegram.missing')}</p>
      <Form className="stack" onSubmit={save}>
        <Field label={tr('admin.telegram.apiId')} value={apiId} onChange={setApiId} />
        <Field label={tr('admin.telegram.apiHash')} type="password" value={apiHash} onChange={setApiHash} description={s?.configured ? tr('admin.telegram.apiHash.keep') : undefined} />
        <Checkbox className="choice-option checkbox" isSelected={testDc} onChange={setTestDc}>
          {tr('admin.telegram.testDc')}
        </Checkbox>
        <Button type="submit" className="button primary">
          {tr('admin.telegram.save')}
        </Button>
        <p role="status" className="status">
          {status}
        </p>
      </Form>
    </section>
  );
}

/**
 * WhatsApp on this server (docs/plan-m3.md, K1/K2): allowed by the operator after reading the risk, off until then.
 * Each person still hears the risk and agrees before linking their own account.
 */
function WhatsappAdmin(p: { session: Session; tell: (text: string, show: (t: string) => void) => void }) {
  const { tr } = useUi();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    void p.session.call<{ allowed: boolean }>('/api/v1/ai-admin/whatsapp').then(
      (r) => setAllowed(r.allowed),
      () => {},
    );
  }, [p.session]);
  async function change(on: boolean) {
    try {
      const r = await p.session.call<{ allowed: boolean }>('/api/v1/ai-admin/whatsapp', { method: 'PUT', body: { allowed: on } });
      setAllowed(r.allowed);
      p.tell(tr(r.allowed ? 'admin.whatsapp.allowed' : 'admin.whatsapp.forbidden'), setStatus);
    } catch (err) {
      p.tell(tr(`error.${err instanceof ApiError ? err.code : 'internal'}`), setStatus);
    }
  }
  return (
    <section className="settings-section">
      <h2>{tr('admin.whatsapp.title')}</h2>
      <p className="muted">{tr('admin.whatsapp.intro')}</p>
      {allowed !== null && (
        <Switch className="switch" isSelected={allowed} onChange={(on) => void change(on)}>
          <span className="switch-indicator" aria-hidden />
          {tr('admin.whatsapp.allow')}
        </Switch>
      )}
      <p role="status" className="status">
        {status}
      </p>
    </section>
  );
}

export function AiAdmin(p: { session: Session; onClose: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [providers, setProviders] = useState<Provider[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [invite, setInvite] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  // The add form's outcome is shown at the form: the page's status line is far above it.
  const [formStatus, setFormStatus] = useState('');
  const [form, setForm] = useState({ fn: 'tts' as 'tts' | 'stt' | 'llm', type: 'openai', name: '', baseUrl: '', model: '', apiKey: '', location: 'external', classes: [] as string[], price: '', cap: '', voices: '' });
  const [workerName, setWorkerName] = useState('');
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const load = async () => {
    try {
      setProviders((await p.session.call<{ providers: Provider[] }>('/api/v1/ai-admin/providers')).providers);
      setWorkers((await p.session.call<{ workers: Worker[] }>('/api/v1/ai-admin/herde/workers')).workers);
    } catch (e) {
      setStatus(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tell = (text: string, show: (t: string) => void = setStatus) => {
    show(text);
    say(text, 'system');
  };
  /** Why a provider does not work, in words where the reason is known ("quota", "http_401"…). */
  const reason = (kind: string) => (hasMessage(ui.lang, `admin.reason.${kind}`) ? tr(`admin.reason.${kind}`) : kind);
  async function check(x: Provider) {
    try {
      const r = await p.session.call<Provider>(`/api/v1/ai-admin/providers/${x.id}/check`, { method: 'POST' });
      if (r.health === 'failing') tell(tr('admin.checked.failing', { name: x.name, reason: reason(r.healthError ?? 'error') }));
      else tell(r.health === 'ok' ? tr('admin.checked.ok', { name: x.name }) : `${x.name}: ${tr('admin.health.unknown')}`);
    } catch (e) {
      tell(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
    await load();
  }
  /** Runs an admin action and says how it went; false when it failed. */
  async function run(f: () => Promise<unknown>, done: string, show: (t: string) => void = setStatus): Promise<boolean> {
    let ok = true;
    try {
      await f();
      tell(done, show);
    } catch (e) {
      ok = false;
      const known = e instanceof ApiError && typeof e.params.reason === 'string' && hasMessage(ui.lang, `admin.error.${e.params.reason}`);
      tell(tr(known ? `admin.error.${(e as ApiError).params.reason}` : `error.${e instanceof ApiError ? e.code : 'internal'}`), show);
    }
    await load();
    return ok;
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const euros = Number(form.price.replace(',', '.') || '0');
    const body = {
      function: form.fn,
      type: form.type,
      name: form.name.trim() || ({ openai: 'OpenAI', stt_mlx: 'Whisper', elevenlabs: 'ElevenLabs', ollama: 'Ollama', anthropic: 'Claude' } as Record<string, string>)[form.type]!,
      baseUrl: form.baseUrl.trim() || null,
      location: form.location,
      model: form.model.trim() || null,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      allowedClasses: form.classes,
      // Prices are entered in euros: speech per 1000 characters, recognition per minute (kept per 1000 seconds),
      // a language model per 1000 tokens.
      priceMicrosPerUnit: Math.round(form.fn === 'stt' ? (euros * 1_000_000 * 1000) / 60 : euros * 1_000_000),
      monthlyCapMicros: form.cap.trim() ? Math.round(Number(form.cap.replace(',', '.')) * 1_000_000) : null,
      voices: form.fn === 'tts' ? parseVoices(form.voices) : [],
    };
    // The form keeps what was typed when it was refused, to be corrected.
    if (await run(() => p.session.call('/api/v1/ai-admin/providers', { method: 'POST', body }), tr('admin.provider.added', { name: body.name }), setFormStatus)) set({ name: '', apiKey: '', voices: '' });
  }

  return (
    <main className="page ai-admin">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('admin.title')}</h1>
      </header>
      <p className="muted">{tr('admin.intro')}</p>
      <p role="status" className="status">
        {status}
      </p>

      <section className="settings-section">
        <h2>{tr('admin.providers')}</h2>
        {providers.length === 0 && <p>{tr('admin.providers.none')}</p>}
        <ul className="device-list">
          {providers.map((x) => (
            <li key={x.id} className="device">
              <Heading level={3} className="device-name">
                {x.name}
              </Heading>
              <p className="muted">
                {[
                  tr(`admin.function.${x.function}`),
                  tr(`admin.location.${x.location}`),
                  x.voices.map((v) => v.label).join(', '),
                  tr(`admin.health.${x.health}`) + (x.health === 'failing' && x.healthError ? ` (${reason(x.healthError)})` : ''),
                  x.monthlyCapMicros === null ? tr('admin.spent.noCap', { spent: euros(x.spentMicros, ui.lang) }) : tr('admin.spent', { spent: euros(x.spentMicros, ui.lang), cap: euros(x.monthlyCapMicros, ui.lang) }),
                  x.hasKey ? tr('admin.key.set') : tr('admin.key.none'),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <p className="muted">{x.allowedClasses.length ? tr('admin.classes', { list: x.allowedClasses.map((c) => tr(`admin.class.${c}`)).join(', ') }) : tr('admin.classes.none')}</p>
              <div className="row">
                <Button className="button" onPress={() => void check(x)}>
                  {tr('admin.check')}
                </Button>
                <Button className="button" onPress={() => void run(() => p.session.call(`/api/v1/ai-admin/providers/${x.id}`, { method: 'DELETE' }), tr('admin.provider.removed', { name: x.name }))}>
                  {tr('admin.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <h3>{tr('admin.provider.add')}</h3>
        <Form className="stack" onSubmit={add}>
          <RadioGroup className="choice" value={form.fn} onChange={(fn) => set({ fn: fn as 'tts' | 'stt' | 'llm', type: fn === 'llm' ? 'ollama' : 'openai', classes: [] })}>
            <Label className="choice-label">{tr('admin.field.function')}</Label>
            {(['tts', 'stt', 'llm'] as const).map((f) => (
              <Radio key={f} value={f} className="choice-option">
                {tr(`admin.function.${f}`)}
              </Radio>
            ))}
          </RadioGroup>
          <RadioGroup className="choice" value={form.type} onChange={(type) => set({ type })}>
            <Label className="choice-label">{tr('admin.field.type')}</Label>
            {form.fn === 'llm' && (
              <Radio value="ollama" className="choice-option">
                {tr('admin.type.ollama')}
              </Radio>
            )}
            <Radio value="openai" className="choice-option">
              {tr('admin.type.openai')}
            </Radio>
            {form.fn === 'tts' && (
              <Radio value="elevenlabs" className="choice-option">
                ElevenLabs
              </Radio>
            )}
            {form.fn === 'stt' && (
              <Radio value="stt_mlx" className="choice-option">
                {tr('admin.type.stt_mlx')}
              </Radio>
            )}
            {form.fn === 'llm' && (
              <Radio value="anthropic" className="choice-option">
                {tr('admin.type.anthropic')}
              </Radio>
            )}
          </RadioGroup>
          <Field label={tr('admin.field.name')} value={form.name} onChange={(name) => set({ name })} />
          <Field label={tr('admin.field.baseUrl')} value={form.baseUrl} onChange={(baseUrl) => set({ baseUrl })} description={tr('admin.field.baseUrl.hint')} />
          <Field label={tr('admin.field.model')} value={form.model} onChange={(model) => set({ model })} description={tr('admin.field.model.hint')} />
          <Field label={tr('admin.field.key')} type="password" value={form.apiKey} onChange={(apiKey) => set({ apiKey })} description={tr('admin.field.key.hint')} />
          <RadioGroup className="choice" value={form.location} onChange={(location) => set({ location })}>
            <Label className="choice-label">{tr('admin.field.location')}</Label>
            {(['external', 'operator_lan', 'server'] as const).map((l) => (
              <Radio key={l} value={l} className="choice-option">
                {tr(`admin.location.${l}`)}
              </Radio>
            ))}
          </RadioGroup>
          <CheckboxGroup className="choice" value={form.classes} onChange={(classes) => set({ classes })}>
            <Label className="choice-label">{tr('admin.field.classes')}</Label>
            {(form.fn === 'stt' ? ['voice_audio', 'live_audio'] : ['personal', 'communication', 'health']).map((c) => (
              <Checkbox key={c} value={c} className="choice-option checkbox">
                {tr(`admin.class.${c}`)}
              </Checkbox>
            ))}
          </CheckboxGroup>
          <Field label={tr(form.fn === 'stt' ? 'admin.field.price.stt' : form.fn === 'llm' ? 'admin.field.price.llm' : 'admin.field.price')} value={form.price} onChange={(price) => set({ price })} />
          <Field label={tr('admin.field.cap')} value={form.cap} onChange={(cap) => set({ cap })} />
          {form.fn === 'tts' && <Field label={tr('admin.field.voices')} value={form.voices} onChange={(voices) => set({ voices })} description={tr('admin.field.voices.hint')} />}
          <Button type="submit" className="button primary">
            {tr('admin.provider.save')}
          </Button>
          <p role="status" className="status">
            {formStatus}
          </p>
        </Form>
      </section>

      <TelegramAdmin session={p.session} tell={tell} />
      <WhatsappAdmin session={p.session} tell={tell} />

      <section className="settings-section">
        <h2>{tr('admin.herde')}</h2>
        <p className="muted">{tr('admin.herde.intro')}</p>
        {workers.length === 0 && <p>{tr('admin.herde.none')}</p>}
        <ul className="device-list">
          {workers.map((w) => (
            <li key={w.id} className="device">
              <Heading level={3} className="device-name">
                {w.name}
              </Heading>
              <p className="muted">
                {[
                  tr(`admin.trust.${w.trust}`),
                  w.profile === 'ok' ? tr('admin.profile.ok') : tr('admin.profile.not', { state: w.profile }),
                  w.voices.map((v) => v.label).join(', '),
                  w.lastSeen ? tr('admin.lastSeen', { time: new Date(w.lastSeen) }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <Button
                className="button"
                onPress={() => void run(() => p.session.call(`/api/v1/ai-admin/herde/workers/${w.id}`, { method: 'PATCH', body: { active: !w.active } }), tr(w.active ? 'admin.worker.off' : 'admin.worker.on', { name: w.name }))}
              >
                {tr(w.active ? 'admin.worker.switchOff' : 'admin.worker.switchOn')}
              </Button>
            </li>
          ))}
        </ul>
        <Form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void p.session
              .call<{ command: string }>('/api/v1/ai-admin/herde/invites', { method: 'POST', body: { name: workerName.trim() || 'herde', trust: 'own' } })
              .then(
                (r) => {
                  setInvite(r.command);
                  tell(tr('admin.herde.invited'));
                },
                () => tell(tr('error.internal')),
              );
          }}
        >
          <Field label={tr('admin.herde.name')} value={workerName} onChange={setWorkerName} />
          <Button type="submit" className="button">
            {tr('admin.herde.invite')}
          </Button>
        </Form>
        {invite && (
          <div className="stack">
            <p>{tr('admin.herde.command')}</p>
            <pre className="command">{invite}</pre>
          </div>
        )}
      </section>
    </main>
  );
}
