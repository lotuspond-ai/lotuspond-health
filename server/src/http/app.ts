// The HTTP app: the client API under /v1, partner webhooks under /hooks, and a health check.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Logger } from '../log.ts';
import { webhookRoutes, type ReceiverDeps } from '../webhooks/receiver.ts';
import { apiRoutes, type ApiDeps } from './api.ts';

export interface AppDeps {
  receiver: ReceiverDeps;
  /** Omit to serve webhooks only. */
  api?: ApiDeps;
  /** Browser origins allowed to call /v1 (design doc §7). Empty: same-origin only. */
  allowedOrigins?: string[];
  log: Logger;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.get('/healthz', c => c.json({ ok: true }));
  if (deps.api) {
    const origins = deps.allowedOrigins ?? [];
    app.use('/v1/*', cors({
      origin: origin => (origins.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      exposeHeaders: ['Idempotent-Replayed', 'Retry-After'],
      maxAge: 600,
    }));
    app.route('/v1', apiRoutes(deps.api));
  }
  app.route('/hooks', webhookRoutes(deps.receiver));
  app.notFound(c => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    // routePath is the pattern (/hooks/:partner/:hookSecret), so the secret never reaches the log.
    deps.log.error('request failed', { route: c.req.routePath, error: err.name, alert: true });
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
