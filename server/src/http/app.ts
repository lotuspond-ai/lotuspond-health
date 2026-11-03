// The HTTP app. Only the webhook receiver and a health check so far; the client API joins it next.
import { Hono } from 'hono';
import { webhookRoutes, type ReceiverDeps } from '../webhooks/receiver.ts';

export function createApp(deps: { receiver: ReceiverDeps }): Hono {
  const app = new Hono();
  app.get('/healthz', c => c.json({ ok: true }));
  app.route('/hooks', webhookRoutes(deps.receiver));
  app.notFound(c => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    // routePath is the pattern (/hooks/:partner/:hookSecret), so the secret never reaches the log.
    deps.receiver.log.error('request failed', { route: c.req.routePath, error: err.name, alert: true });
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
