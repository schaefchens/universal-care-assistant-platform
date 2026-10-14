/**
 * The Fastify app both processes start from.
 * - Logs carry the route pattern, status and duration, never a body, a header value or a query string
 *   (CLAUDE.md: no content in logs). Request ids are UUIDv7.
 * - Every error is `{error: {code, params}}`. Validation errors never echo the input, and unexpected ones are logged
 *   by class name only.
 * - CORS and the WebSocket upgrade accept only the configured origins: the Capacitor app (https://localhost), the
 *   dev server, our own origin. Bearer tokens only, no cookies, so there is no CSRF surface.
 */
import cors from '@fastify/cors';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { uuidv7 } from '@ucap/shared';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';

export function createHttp(config: Pick<Config, 'allowedOrigins' | 'logLevel'>, opts: { logger?: boolean; logStream?: { write(line: string): void } } = {}) {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            // Tests read what would be logged (ID-02: no recovery words in logs); production logs to stdout.
            ...(opts.logStream ? { stream: opts.logStream } : {}),
            // Nothing of the request but its method and route pattern; the onResponse hook logs the rest.
            serializers: { req: (req) => ({ method: req.method, route: req.routeOptions?.url }), res: () => ({}) },
            redact: { paths: ['headers', 'body', 'query', 'params'], remove: true },
          },
    // Fastify's own request logs would carry the URL with its query; the onResponse hook logs the route pattern.
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => uuidv7(),
    bodyLimit: 1024 * 1024,
    trustProxy: true, // behind Caddy
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ method: req.method, route: req.routeOptions.url ?? 'unmatched', status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, ...(err.params ? { params: err.params } : {}) } });
    }
    const e = err as { validation?: unknown; statusCode?: number; code?: string };
    if (e.validation) return reply.code(400).send({ error: { code: 'bad_request' } });
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e.statusCode === 413) return reply.code(413).send({ error: { code: 'too_large' } });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: 'bad_request' } });
    req.log.error({ err: { type: (err as Error).name } }, 'unexpected error');
    return reply.code(500).send({ error: { code: 'internal' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found' } }));

  void app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin)),
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'ucap-sig', 'range'],
    exposedHeaders: ['content-range', 'accept-ranges', 'x-request-id'],
    maxAge: 600,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
  });

  return app;
}

export type App = ReturnType<typeof createHttp>;
export type AnyApp = FastifyInstance;
