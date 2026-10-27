/**
 * Speech for the person (docs/plan.md, Appendix B "speech"): the voices they may choose, their choice per purpose
 * (with consent for an external voice, asked when chosen), samples to choose by listening, and rendering in the
 * chosen voice. The answer is either audio to play, or "use the device voice" with the reason.
 */
import Type from 'typebox';
import type { Providers } from '../../ai/providers.ts';
import type { Stt } from '../../ai/stt/service.ts';
import type { Speech } from '../../ai/tts/service.ts';
import type { PeopleService } from '../../domain/people/service.ts';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { emit } from '../../lib/outbox.ts';
import { auth, OPEN, requireAuth } from '../../core/auth.ts';
import type { AnyApp } from '../../lib/http.ts';

const Ref = Type.String({ minLength: 1, maxLength: 120 });

export function registerSpeechRoutes(app: AnyApp, o: { speech: Speech; providers: Providers; stt: Stt; people: PeopleService; db: Db; clock: Clock }) {
  const { speech } = o;
  /** The person, or a helper who may set up their devices (docs/plan-m4.md, G2: "voice preferences"). */
  const mayVoice = async (actor: string, personId: string) => {
    if (actor !== personId && !(await o.people.can(actor, 'device.configure', personId))) throw new AppError('forbidden');
  };
  app.get('/api/v1/speech/voices', { preHandler: requireAuth, schema: { querystring: Type.Object({ lang: Type.Optional(Type.Union([Type.Literal('de'), Type.Literal('en')])) }) } }, async (req) => {
    const lang = (req.query as { lang?: 'de' | 'en' }).lang ?? 'de';
    const userId = auth(req).userId;
    return { voices: await speech.voices(userId, lang), settings: await speech.settings(userId), chosen: await speech.chosen(userId) };
  });

  app.put(
    '/api/v1/speech/settings',
    { preHandler: requireAuth, schema: { body: Type.Object({ reply: Type.Optional(Ref), reading: Type.Optional(Ref), consent: Type.Optional(Type.Boolean()) }, { additionalProperties: false }) } },
    async (req) => {
      const b = req.body as { reply?: string; reading?: string; consent?: boolean };
      const patch = { ...(b.reply ? { reply: b.reply } : {}), ...(b.reading ? { reading: b.reading } : {}) };
      return speech.setSettings(auth(req).userId, patch, b.consent === true);
    },
  );

  app.post('/api/v1/speech/samples', { preHandler: requireAuth, schema: { body: Type.Object({ ref: Ref }) } }, async (req) => speech.sample(auth(req).userId, (req.body as { ref: string }).ref));

  // —— A helper with device.configure sets the person's voices (G2). A voice that needs the person's consent for what it
  // would read is refused (409 consent_required): only the person agrees, on their own device. Each change is told to
  // the person's devices with the voice it replaced, so "Rückgängig" there puts it back, and kept in the history.
  const PersonQuery = Type.Object({ lang: Type.Optional(Type.Union([Type.Literal('de'), Type.Literal('en')])) });
  app.get('/api/v1/speech/people/:id/voices', { preHandler: requireAuth, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }), querystring: PersonQuery } }, async (req) => {
    const personId = (req.params as { id: string }).id;
    await mayVoice(auth(req).userId, personId);
    const lang = (req.query as { lang?: 'de' | 'en' }).lang ?? 'de';
    return { voices: await speech.voices(personId, lang), settings: await speech.settings(personId) };
  });
  app.put(
    '/api/v1/speech/people/:id/settings',
    { preHandler: requireAuth, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: Type.Object({ reply: Type.Optional(Ref), reading: Type.Optional(Ref) }, { additionalProperties: false }) } },
    async (req) => {
      const a = auth(req);
      const personId = (req.params as { id: string }).id;
      await mayVoice(a.userId, personId);
      const b = req.body as { reply?: string; reading?: string };
      const before = await speech.settings(personId);
      const patch = { ...(b.reply ? { reply: b.reply } : {}), ...(b.reading ? { reading: b.reading } : {}) };
      const next = await speech.setSettings(personId, patch, false);
      const changed = (Object.keys(patch) as ('reply' | 'reading')[]).filter((k) => before[k] !== next[k]);
      if (changed.length) {
        await audit(o.db, o.clock, { actorUser: a.userId, actorDevice: a.deviceId, subjectUser: personId, action: 'speech.changed', targetType: 'user', targetId: personId, detail: { changed } });
        await emit(o.db, { kind: 'speech.changed', recipients: [personId], payload: { by: a.userId, changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, next[k]])) } });
      }
      return next;
    },
  );

  // Open to a locked device (docs/plan-m4.md, G4): a reminder's question is said in the person's voice there too.
  app.post(
    '/api/v1/speech/render',
    {
      preHandler: requireAuth,
      config: OPEN,
      schema: {
        body: Type.Object({
          text: Type.String({ minLength: 1, maxLength: 4000 }),
          purpose: Type.Union([Type.Literal('reply'), Type.Literal('reading'), Type.Literal('reminder')]),
          background: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => speech.render(auth(req).userId, req.body as { text: string; purpose: 'reply' | 'reading' | 'reminder'; background?: boolean }),
  );

  // Who hears the person's voice: the operator's own recognition, or an external one they chose (with consent).
  app.get('/api/v1/speech/recognition', { preHandler: requireAuth }, async (req) => {
    const userId = auth(req).userId;
    return { options: await o.stt.options(userId), chosen: await o.stt.chosen(userId) };
  });
  app.put(
    '/api/v1/speech/recognition',
    { preHandler: requireAuth, schema: { body: Type.Object({ ref: Type.Union([Type.Null(), Type.String({ format: 'uuid' })]), consent: Type.Optional(Type.Boolean()) }, { additionalProperties: false }) } },
    async (req) => {
      const b = req.body as { ref: string | null; consent?: boolean };
      return { chosen: await o.stt.choose(auth(req).userId, b.ref, b.consent === true) };
    },
  );

  // What the person consented to, and taking it back: voices that needed it go back to the device voice.
  app.get('/api/v1/speech/consents', { preHandler: requireAuth }, async (req) => ({ consents: await o.providers.consents(auth(req).userId) }));
  app.delete('/api/v1/speech/consents/:id', { preHandler: requireAuth, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } }, async (req, reply) => {
    const userId = auth(req).userId;
    const providerId = (req.params as { id: string }).id;
    await o.providers.revokeConsent(userId, providerId);
    const s = await speech.settings(userId);
    const reset = Object.fromEntries(Object.entries(s).filter(([, ref]) => ref.startsWith(`p:${providerId}:`)).map(([k]) => [k, 'device']));
    if (Object.keys(reset).length) await speech.setSettings(userId, reset, false);
    if ((await o.stt.chosen(userId)) === providerId) await o.stt.choose(userId, null, false);
    return reply.code(204).send();
  });
}
