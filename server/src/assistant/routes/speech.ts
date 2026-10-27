/**
 * Speech for the person (docs/plan.md, Appendix B "speech"): the voices they may choose, their choice per purpose
 * (with consent for an external voice, asked when chosen), samples to choose by listening, and rendering in the
 * chosen voice. The answer is either audio to play, or "use the device voice" with the reason.
 */
import Type from 'typebox';
import type { Providers } from '../../ai/providers.ts';
import type { Stt } from '../../ai/stt/service.ts';
import type { Speech } from '../../ai/tts/service.ts';
import { auth, OPEN, requireAuth } from '../../core/auth.ts';
import type { AnyApp } from '../../lib/http.ts';

const Ref = Type.String({ minLength: 1, maxLength: 120 });

export function registerSpeechRoutes(app: AnyApp, o: { speech: Speech; providers: Providers; stt: Stt }) {
  const { speech } = o;
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
