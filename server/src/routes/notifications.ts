// The bell in the app (shared/notifications.ts):
//   GET  /api/notifications           the latest notifications and the unread count
//   POST /api/notifications/read      mark { ids } (or all) as read
//   POST /api/notifications/:id/undo  undo what an agent added, from its notification
import { Hono } from 'hono';
import { z } from 'zod';
import { eventContext, recordEvent } from '../compliance/audit.ts';
import { notFound } from '../lib/errors.ts';
import { readJson, requireAuth, UUID, type AppEnv, type Deps } from '../http.ts';
import { listNotifications, markRead, undoAgentWrite } from '../notifications.ts';
import { toProfile } from '../serialize.ts';
import type { UndoResult } from '../../../shared/notifications.ts';

const ReadBody = z.object({ ids: z.array(z.string().regex(UUID)).max(100).optional() });

export function notificationRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps));

  app.get('/', async c => c.json(await listNotifications(c.var.cell.db, c.var.user.id)));

  app.post('/read', async c => {
    const body = await readJson(c, ReadBody);
    await markRead(c.var.cell.db, c.var.user.id, body.ids);
    return c.json(await listNotifications(c.var.cell.db, c.var.user.id));
  });

  app.post('/:id/undo', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notFound('That notification');
    const out = await undoAgentWrite(c.var.cell.db, c.var.cell.files, c.var.user.id, id);
    if (!out) throw notFound('That notification');
    if (out.removed) {
      await recordEvent(c.var.cell.db, eventContext(c, deps), c.var.user.id, 'agent_write_undone', {
        profileId: out.notification.profileId, ...(out.notification.connectionId ? { connectionId: out.notification.connectionId } : {}),
      });
    }
    // The profile as it now is, so the app can show the lists without reloading.
    const body: UndoResult = { notification: out.notification, removed: out.removed, ...(out.profile ? { profile: toProfile(out.profile) } : {}) };
    return c.json(body);
  });

  return app;
}
