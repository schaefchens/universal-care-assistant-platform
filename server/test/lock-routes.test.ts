/**
 * The app lock's route matrix (docs/plan-m4.md, G4: "every route of core and the assistant named open or locked"):
 * every route that takes a session, in both processes, is closed to a locked device unless it is on this list. A new
 * route is closed until someone adds it here on purpose; one dropped from the list fails here too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAssistant } from '../src/assistant/app.ts';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

/** What a locked device may use: help, reminders' questions, its own configuration, push, voice commands, the lock. */
const OPEN_WHILE_LOCKED = [
  // Who the device is, and signing out.
  'GET /api/v1/me',
  // New words waiting to take effect (G5): said on every device at start, a locked one too; stopping needs the unlock.
  'GET /api/v1/identity/changes/current',
  'DELETE /api/v1/sessions/current',
  // The lock itself.
  'GET /api/v1/lock',
  'POST /api/v1/lock/unlock',
  'POST /api/v1/lock/unlock-key',
  'POST /api/v1/lock/lock',
  // Android's key forgotten (the phone's lock was removed): dropping a way in opens nothing.
  'DELETE /api/v1/lock/android-key',
  // Its own screens and settings.
  'GET /api/v1/devices/current/config',
  'PUT /api/v1/devices/current/config',
  'POST /api/v1/devices/current/config-state',
  // Help requests, the person's and a helper's.
  'GET /api/v1/care/requests',
  'GET /api/v1/care/requests/:id',
  'POST /api/v1/care/requests/:id/seen',
  'POST /api/v1/care/requests/:id/accept',
  'POST /api/v1/care/requests/:id/decline',
  'POST /api/v1/care/requests/:id/release',
  'POST /api/v1/care/requests/:id/resolve',
  'POST /api/v1/care/requests/:id/messages',
  'GET /api/v1/people/:id/escalation-plan',
  'GET /api/v1/care/readiness',
  // Push: alarms reach the device whether it is locked or not.
  'PUT /api/v1/devices/current/push-endpoints/webpush',
  'DELETE /api/v1/devices/current/push-endpoints/webpush',
  'POST /api/v1/devices/current/push-test',
  // Reminders: their alarms on the device, their questions said.
  'GET /api/v1/people/:id/reminders/upcoming',
  'GET /api/v1/reminders/occurrences/:id',
  'POST /api/v1/speech/render',
  // Voice: commands and help (the turn keeps the rest back), and LIVE's keyword spotter.
  'POST /api/v1/assistant/turns',
  'POST /api/v1/assistant/warmup',
  'GET /api/v1/assistant/keyword-models',
  'GET /api/v1/assistant/keyword-models/:id',
].sort();

describe('the app lock’s route matrix', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let assistant: Awaited<ReturnType<typeof buildAssistant>>;

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    const config = testConfig();
    core = await buildCore({ config, db, clock: fakeClock(), secrets: SECRETS, logger: false });
    assistant = await buildAssistant({ config, db, clock: fakeClock(), secrets: SECRETS, logger: false });
    await core.app.ready();
    await assistant.app.ready();
  });
  afterAll(async () => {
    await assistant.app.close();
    await core.app.close();
    await drop();
  });

  it('opens to a locked device exactly the routes on the list; every other route that takes a session is closed', () => {
    const routes = [...core.app.ucapRoutes, ...assistant.app.ucapRoutes];
    const open = routes.filter((r) => r.open).map((r) => `${r.method} ${r.url}`);
    // Marked open without a session is a mistake too: the mark means nothing there.
    expect(routes.filter((r) => r.open && !r.session).map((r) => `${r.method} ${r.url}`)).toEqual([]);
    expect([...new Set(open)].sort()).toEqual(OPEN_WHILE_LOCKED);
    // Everything personal is closed: messages, notes, contacts, appointments, the assistant's tools, people, devices.
    const closed = routes.filter((r) => r.session && !r.open).map((r) => `${r.method} ${r.url}`);
    for (const route of ['GET /api/v1/notes', 'GET /api/v1/messaging/conversations', 'GET /api/v1/people/:id/contacts', 'GET /api/v1/people/:id/appointments', 'GET /api/v1/relationships', 'GET /api/v1/devices', 'POST /api/v1/devices/links', 'PUT /api/v1/lock', 'PUT /api/v1/lock/code', 'POST /api/v1/assistant/live/news'])
      expect(closed, route).toContain(route);
  });
});
