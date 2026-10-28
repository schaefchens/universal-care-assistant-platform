/**
 * Device configurations over HTTP (docs/plan.md, Appendix B "configuration"): the device fetches its own and says
 * what it received and applied; the person and helpers with `device.configure` list the person's devices, read a
 * configuration with its history, check one, save a version from the current one (409 when stale, 422 when it breaks
 * the protected controls), and set an earlier one again.
 */
import { DeviceConfig } from '@ucap/shared';
import Type from 'typebox';
import type { Configs } from '../../domain/configs/service.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, OPEN, requireAuth } from '../auth.ts';

const Id = Type.Object({ id: Type.String({ format: 'uuid' }) });
const Reason = Type.Union([Type.Literal('touch'), Type.Literal('speech'), Type.Literal('awaiting'), Type.Literal('care')]);

export function registerConfigRoutes(app: AnyApp, o: { configs: Configs }) {
  const { configs } = o;
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  // —— The device's own ——
  // The device's own configuration is open to it while locked (docs/plan-m4.md, G4): its screens, help, the lock's way out.
  app.get('/api/v1/devices/current/config', { preHandler: requireAuth, config: OPEN }, async (req) => ({ config: await configs.forDevice(auth(req).userId, auth(req).deviceId) }));
  app.put(
    '/api/v1/devices/current/config',
    { preHandler: requireAuth, config: OPEN, bodyLimit: 256 * 1024, schema: { body: Type.Object({ body: DeviceConfig }, { additionalProperties: false }) } },
    async (req) => ({ config: await configs.createForDevice(auth(req).userId, auth(req).deviceId, (req.body as { body: DeviceConfig }).body) }),
  );
  // The device describes itself (G8): whether it is the home screen, what its kiosk does, and the apps it can open,
  // which it sends only when the answer asks for them (the owner, 2026-10-28). Open while locked, as the
  // configuration's state: it reads nothing.
  app.put(
    '/api/v1/devices/current/apps',
    {
      preHandler: requireAuth,
      config: OPEN,
      schema: {
        body: Type.Object(
          {
            apps: Type.Optional(Type.Array(Type.Object({ package: Type.String({ maxLength: 200 }), label: Type.String({ maxLength: 100 }) }, { additionalProperties: false }), { maxItems: 400 })),
            home: Type.Boolean(),
            // What the kiosk is doing (G9): off, pinned or locked, and whether UCAP is the device owner.
            kiosk: Type.Optional(Type.Object({ mode: Type.Union([Type.Literal('off'), Type.Literal('pinned'), Type.Literal('locked')]), owner: Type.Boolean() }, { additionalProperties: false })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => configs.describe(auth(req).userId, auth(req).deviceId, req.body as { apps?: { package: string; label: string }[]; home: boolean; kiosk?: { mode: string; owner: boolean } }),
  );
  app.post(
    '/api/v1/devices/current/config-state',
    {
      preHandler: requireAuth,
      config: OPEN,
      schema: {
        body: Type.Object(
          {
            delivered: Type.Optional(Type.Integer({ minimum: 1 })),
            applied: Type.Optional(Type.Integer({ minimum: 1 })),
            deferred: Type.Optional(Type.Union([Reason, Type.Null()])),
            repaired: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 40 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => ({ state: await configs.report(auth(req).userId, auth(req).deviceId, req.body as never) }),
  );

  // —— The person's and their helpers' ——
  app.get('/api/v1/people/:id/devices', { preHandler: requireAuth, schema: { params: Id } }, async (req) => ({ devices: await configs.devicesOf(auth(req).userId, id(req)) }));
  app.get('/api/v1/configs/:id', { preHandler: requireAuth, schema: { params: Id } }, async (req) => configs.get(auth(req).userId, id(req)));
  app.get(
    '/api/v1/configs/:id/versions/:version',
    { preHandler: requireAuth, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }), version: Type.Integer({ minimum: 1 }) }) } },
    async (req) => configs.version(auth(req).userId, id(req), (req.params as { version: number }).version),
  );
  app.post(
    '/api/v1/configs/validate',
    { preHandler: requireAuth, bodyLimit: 256 * 1024, schema: { body: Type.Object({ body: DeviceConfig }, { additionalProperties: false }) } },
    async (req) => configs.validate((req.body as { body: DeviceConfig }).body),
  );
  app.post(
    '/api/v1/configs/:id/versions',
    {
      preHandler: requireAuth,
      bodyLimit: 256 * 1024,
      schema: {
        params: Id,
        body: Type.Object(
          {
            base: Type.Integer({ minimum: 1 }),
            body: DeviceConfig,
            note: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 300 })])),
            acknowledge: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 50 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const a = auth(req);
      const b = req.body as { base: number; body: DeviceConfig; note?: string | null; acknowledge?: string[] };
      const r = await configs.addVersion(a.userId, id(req), { ...b, fromDevice: a.deviceId });
      return reply.code(r.unchanged ? 200 : 201).send(r);
    },
  );
  app.post(
    '/api/v1/configs/:id/revert',
    { preHandler: requireAuth, schema: { params: Id, body: Type.Object({ base: Type.Integer({ minimum: 1 }), to: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }) } },
    async (req, reply) => {
      const r = await configs.revert(auth(req).userId, id(req), req.body as { base: number; to: number });
      return reply.code(r.unchanged ? 200 : 201).send(r);
    },
  );
}
