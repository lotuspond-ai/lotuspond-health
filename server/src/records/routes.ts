// The record agent in the app (docs/record-agent.md §4).
//   GET    /api/records                       the sources for this account's region, and whether the agent is on
//   GET    /api/records/connections           the sources this account connected, with each one's last run
//   POST   /api/records/connections           connect a source for a profile and start the first run
//   PATCH  /api/records/connections/:id       how often to check again ({ refreshDays })
//   POST   /api/records/connections/:id/run   check now
//   DELETE /api/records/connections/:id       disconnect (forgets the sign-in; saved reports stay)
//   GET    /api/records/runs/:id              a run: what it is doing, what it needs from the person, what it saved
//   POST   /api/records/runs/:id/answer       answer its question ({ answer }); passed to the portal, never stored
//   POST   /api/records/runs/:id/cancel
import { Hono } from 'hono';
import { z } from 'zod';
import { RECORD_AGENT_NOTICE_VERSION, type SourcesInfo } from '../../../shared/sources.ts';
import { HttpError, tooMany } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { readJson, requireAuth, UUID, type AppEnv, type Deps } from '../http.ts';
import type { RecordAgent } from './service.ts';

const Refresh = z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]);
const ConnectBody = z.object({
  sourceId: z.string().min(1).max(60),
  profileId: z.string().regex(UUID),
  portalUrl: z.string().max(500).optional(),
  refreshDays: Refresh.default(30),
  noticeVersion: z.string(),
});
const PatchBody = z.object({ refreshDays: Refresh });
const AnswerBody = z.object({ answer: z.string().trim().min(1, 'Type the answer.').max(200) });

export function recordRoutes(deps: Deps, agent: RecordAgent | undefined) {
  const app = new Hono<AppEnv>();
  const runs = new RateLimiter(20, 60 * 60_000);
  const answers = new RateLimiter(30, 10 * 60_000);
  app.use('*', requireAuth(deps));
  const on = () => {
    if (!agent) throw new HttpError(503, 'records_unavailable', 'The record agent is not switched on for this server.');
    return agent;
  };
  const limitRuns = (userId: string) => {
    const wait = runs.hit(userId);
    if (wait) throw tooMany(`The record agent has run many times in the last hour. Try again in ${Math.ceil(wait / 60)} minutes.`);
  };
  const id = (raw: string) => {
    if (!UUID.test(raw)) throw new HttpError(404, 'not_found', 'That item was not found.');
    return raw;
  };

  app.get('/', c => {
    const body: SourcesInfo = {
      enabled: !!agent, browser: agent?.browserLabel ?? null, noticeVersion: RECORD_AGENT_NOTICE_VERSION,
      sources: agent ? agent.sources(c.var.user.region) : [],
    };
    return c.json(body);
  });

  app.get('/connections', async c => c.json(agent ? await agent.connections(c.var.cell, c.var.user.id) : []));

  app.post('/connections', async c => {
    const a = on();
    const body = await readJson(c, ConnectBody);
    limitRuns(c.var.user.id);
    return c.json(await a.connect(c.var.cell, c.var.user, body), 201);
  });

  app.patch('/connections/:id', async c => {
    const body = await readJson(c, PatchBody);
    return c.json(await on().update(c.var.cell, c.var.user.id, id(c.req.param('id')), body));
  });

  app.post('/connections/:id/run', async c => {
    const a = on();
    limitRuns(c.var.user.id);
    return c.json(await a.startRun(c.var.cell, c.var.user, id(c.req.param('id'))), 201);
  });

  app.delete('/connections/:id', async c => {
    await on().disconnect(c.var.cell, c.var.user, id(c.req.param('id')));
    return c.body(null, 204);
  });

  app.get('/runs/:id', async c => c.json(await on().run(c.var.cell, c.var.user.id, id(c.req.param('id')))));

  app.post('/runs/:id/answer', async c => {
    const a = on();
    const wait = answers.hit(c.var.user.id);
    if (wait) throw tooMany(`Too many answers in a short time. Try again in ${Math.ceil(wait / 60)} minutes.`);
    const body = await readJson(c, AnswerBody);
    return c.json(await a.answer(c.var.cell, c.var.user.id, id(c.req.param('id')), body.answer));
  });

  app.post('/runs/:id/cancel', async c => c.json(await on().cancel(c.var.cell, c.var.user.id, id(c.req.param('id')))));

  return app;
}
