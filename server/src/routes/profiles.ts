// Profiles and everything stored under them: measurements, scans and original documents.
// Every route below /:pid first checks that the profile belongs to the signed-in account.
// All of it is personal data, so every query goes to the account's cell (c.var.cell), never to deps.db.
import { createHash } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { LIMITS } from '../../../shared/constants.ts';
import type { Db } from '../db/client.ts';
import { documents, measurements, profiles, scans, type ProfileRow } from '../db/schema.ts';
import { eventContext, recentActivity, recordEvent } from '../compliance/audit.ts';
import { listConsents } from '../compliance/consents.ts';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.ts';
import { readJson, requireAuth, UUID, type AppEnv, type Deps } from '../http.ts';
import {
  DocumentKind, MeasurementPatchBody, MeasurementsCreateBody, ProfileCreateBody, ProfilePatchBody, ScanPatchBody, ScansCreateBody,
} from '../schemas.ts';
import { toAccount, toDocument, toMeasurement, toProfile, toScan } from '../serialize.ts';

const RELATIONSHIP_RANK: Record<string, number> = { self: 0, partner: 1, child: 2, parent: 3, sibling: 4, other: 5 };

/** Account holder first, then family in a stable order. */
export function relationshipOrder(a: ProfileRow, b: ProfileRow): number {
  return (RELATIONSHIP_RANK[a.relationship] ?? 9) - (RELATIONSHIP_RANK[b.relationship] ?? 9) || a.createdAt.getTime() - b.createdAt.getTime();
}

/** Types a browser may display inline. Anything else is sent as a download. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'application/pdf']);
const MIME = /^[a-z0-9][\w.+-]*\/[\w.+-]+$/i;

function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 200);
  return cleaned || 'file';
}

function contentDisposition(kind: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** After requireAuth: load the :pid profile if it belongs to the signed-in account (else 404) into c.var.profile. */
export function requireProfile(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const pid = c.req.param('pid');
    if (!pid || !UUID.test(pid)) throw notFound('That profile');
    const { db } = c.var.cell;
    const [row] = await db.select().from(profiles).where(and(eq(profiles.id, pid), eq(profiles.userId, c.var.user.id))).limit(1);
    if (!row) throw notFound('That profile');
    c.set('profile', row);
    await next();
  };
}

export function profileRoutes(deps: Deps) {
  const { config } = deps;
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps));

  /* ---------- profile list ---------- */

  app.get('/', async c => {
    const { db } = c.var.cell;
    const rows = await db.select().from(profiles).where(eq(profiles.userId, c.var.user.id));
    return c.json(rows.sort(relationshipOrder).map(toProfile));
  });

  app.post('/', async c => {
    const { db } = c.var.cell;
    const body = await readJson(c, ProfileCreateBody);
    const [{ n }] = await db.select({ n: count() }).from(profiles).where(eq(profiles.userId, c.var.user.id));
    if (n >= LIMITS.profilesPerAccount) throw conflict(`An account can hold up to ${LIMITS.profilesPerAccount} profiles.`);
    if (body.relationship === 'self') throw badRequest('Your account already has your own profile. Choose who this person is to you.');
    const [row] = await db.insert(profiles).values({ ...body, relationship: body.relationship ?? 'other', userId: c.var.user.id }).returning();
    return c.json(toProfile(row), 201);
  });

  /* ---------- one profile (ownership check) ---------- */

  // Matches '/:pid' as well as everything below it.
  app.use('/:pid/*', requireProfile());
  app.get('/:pid', c => c.json(toProfile(c.var.profile)));

  app.patch('/:pid', async c => {
    const { db } = c.var.cell;
    const body = await readJson(c, ProfilePatchBody);
    const current = c.var.profile;
    if (body.relationship && (body.relationship === 'self') !== (current.relationship === 'self')) {
      throw badRequest(current.relationship === 'self' ? 'Your own profile stays marked as you.' : 'Only your own profile can be marked as you.');
    }
    const [row] = await db.update(profiles).set({ ...body, updatedAt: new Date() }).where(eq(profiles.id, current.id)).returning();
    return c.json(toProfile(row));
  });

  app.delete('/:pid', async c => {
    const { db, files } = c.var.cell;
    const p = c.var.profile;
    if (p.relationship === 'self') throw conflict('Your own profile cannot be removed. To remove everything, delete your account.');
    await db.delete(profiles).where(eq(profiles.id, p.id));
    await files.deletePrefix(p.id);
    await recordEvent(db, eventContext(c, deps), c.var.user.id, 'profile_deleted', { profileId: p.id });
    return c.body(null, 204);
  });

  /* ---------- all records ---------- */

  async function loadRecords(db: Db, profileId: string) {
    const [ms, ss, ds] = await Promise.all([
      db.select().from(measurements).where(eq(measurements.profileId, profileId)).orderBy(asc(measurements.date), asc(measurements.createdAt)),
      db.select().from(scans).where(eq(scans.profileId, profileId)).orderBy(asc(scans.createdAt)),
      db.select().from(documents).where(eq(documents.profileId, profileId)).orderBy(desc(documents.createdAt)),
    ]);
    return { measurements: ms.map(toMeasurement), scans: ss.map(toScan), documents: ds.map(toDocument) };
  }

  app.get('/:pid/records', async c => c.json(await loadRecords(c.var.cell.db, c.var.profile.id)));

  app.delete('/:pid/records', async c => {
    const { db, files } = c.var.cell;
    const pid = c.var.profile.id;
    await db.transaction(async tx => {
      await tx.delete(measurements).where(eq(measurements.profileId, pid));
      await tx.delete(documents).where(eq(documents.profileId, pid)); // cascades to scans
    });
    await files.deletePrefix(pid);
    await recordEvent(db, eventContext(c, deps), c.var.user.id, 'records_deleted', { profileId: pid });
    return c.body(null, 204);
  });

  /**
   * Everything for this profile as JSON. Re-importable through the upload dialog. The account holder's own
   * profile also carries the account: country, storage region, preferences, consents and recent activity.
   * Family profiles leave that out, since they are often passed on to a doctor.
   */
  app.get('/:pid/export', async c => {
    const { db } = c.var.cell;
    const p = c.var.profile;
    const records = await loadRecords(db, p.id);
    await recordEvent(db, eventContext(c, deps), c.var.user.id, 'export', { profileId: p.id });
    const account = p.relationship === 'self'
      ? { ...toAccount(c.var.user), consents: await listConsents(db, c.var.user.id), activity: await recentActivity(db, c.var.user.id, 500) }
      : undefined;
    const payload = { version: 1, app: 'LotusPond Health', exportedAt: new Date().toISOString(), profile: toProfile(p), ...records, account };
    const name = `lotuspond-${p.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile'}-${new Date().toISOString().slice(0, 10)}.json`;
    c.header('Content-Disposition', contentDisposition('attachment', name));
    c.header('Cache-Control', 'no-store');
    return c.json(payload);
  });

  /* ---------- measurements ---------- */

  async function assertDocuments(db: Db, profileId: string, ids: (string | null | undefined)[]) {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (!wanted.length) return;
    const found = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.profileId, profileId), inArray(documents.id, wanted)));
    if (found.length !== wanted.length) throw badRequest('A linked document does not belong to this profile.');
  }

  app.post('/:pid/measurements', async c => {
    const { db } = c.var.cell;
    const pid = c.var.profile.id;
    const body = await readJson(c, MeasurementsCreateBody);
    await assertDocuments(db, pid, body.measurements.map(m => m.documentId));
    const rows = await db.insert(measurements).values(body.measurements.map(m => ({ ...m, documentId: m.documentId ?? null, profileId: pid }))).returning();
    return c.json(rows.map(toMeasurement), 201);
  });

  app.patch('/:pid/measurements/:id', async c => {
    const pid = c.var.profile.id, id = c.req.param('id');
    if (!UUID.test(id)) throw notFound('That result');
    const body = await readJson(c, MeasurementPatchBody);
    const { db } = c.var.cell;
    await assertDocuments(db, pid, [body.documentId]);
    const [row] = await db.update(measurements).set({ ...body, updatedAt: new Date() })
      .where(and(eq(measurements.id, id), eq(measurements.profileId, pid))).returning();
    if (!row) throw notFound('That result');
    return c.json(toMeasurement(row));
  });

  app.delete('/:pid/measurements/:id', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notFound('That result');
    const { db } = c.var.cell;
    const gone = await db.delete(measurements).where(and(eq(measurements.id, id), eq(measurements.profileId, c.var.profile.id))).returning({ id: measurements.id });
    if (!gone.length) throw notFound('That result');
    return c.body(null, 204);
  });

  /* ---------- documents (original files) ---------- */

  app.post('/:pid/documents',
    bodyLimit({ maxSize: config.maxUploadBytes + 64 * 1024, onError: () => { throw new HttpError(413, 'too_large', `Files can be up to ${Math.round(config.maxUploadBytes / 1048576)} MB.`); } }),
    async c => {
      const { db, files } = c.var.cell;
      const pid = c.var.profile.id;
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody();
      } catch {
        throw badRequest('Send the file as multipart form data.');
      }
      const file = form.file;
      if (!(file instanceof File)) throw badRequest('Attach a file in the "file" field.');
      if (file.size === 0) throw badRequest('This file is empty.');
      if (file.size > config.maxUploadBytes) throw new HttpError(413, 'too_large', `Files can be up to ${Math.round(config.maxUploadBytes / 1048576)} MB.`);
      const kind = DocumentKind.catch('other').parse(typeof form.kind === 'string' ? form.kind : 'other');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = crypto.randomUUID();
      const storageKey = `${pid}/${id}`;
      await files.put(storageKey, bytes);
      try {
        const [row] = await db.insert(documents).values({
          id, profileId: pid, storageKey, kind,
          fileName: cleanFileName(file.name),
          contentType: MIME.test(file.type) ? file.type.toLowerCase() : 'application/octet-stream',
          sizeBytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }).returning();
        return c.json(toDocument(row), 201);
      } catch (e) {
        await files.delete(storageKey);
        throw e;
      }
    });

  app.get('/:pid/documents/:id/file', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notFound('That file');
    const { db, files } = c.var.cell;
    const [doc] = await db.select().from(documents).where(and(eq(documents.id, id), eq(documents.profileId, c.var.profile.id))).limit(1);
    if (!doc) throw notFound('That file');
    const stream = await files.get(doc.storageKey);
    if (!stream) throw notFound('That file');
    const inline = c.req.query('download') == null && INLINE_TYPES.has(doc.contentType);
    return new Response(stream, {
      headers: {
        'Content-Type': inline ? doc.contentType : 'application/octet-stream',
        'Content-Length': String(doc.sizeBytes),
        'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', doc.fileName),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });

  app.delete('/:pid/documents/:id', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notFound('That file');
    const { db, files } = c.var.cell;
    const [doc] = await db.delete(documents).where(and(eq(documents.id, id), eq(documents.profileId, c.var.profile.id))).returning();
    if (!doc) throw notFound('That file');
    await files.delete(doc.storageKey);
    return c.body(null, 204);
  });

  /* ---------- scans ---------- */

  app.post('/:pid/scans', async c => {
    const { db } = c.var.cell;
    const pid = c.var.profile.id;
    const body = await readJson(c, ScansCreateBody);
    await assertDocuments(db, pid, body.scans.map(s => s.blobKey));
    const rows = await db.insert(scans).values(body.scans.map(({ blobKey, ...s }) => ({ ...s, documentId: blobKey, profileId: pid }))).returning();
    return c.json(rows.map(toScan), 201);
  });

  app.patch('/:pid/scans/:id', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notFound('That scan');
    const body = await readJson(c, ScanPatchBody);
    const { db } = c.var.cell;
    const [row] = await db.update(scans).set({ ...body, updatedAt: new Date() })
      .where(and(eq(scans.id, id), eq(scans.profileId, c.var.profile.id))).returning();
    if (!row) throw notFound('That scan');
    return c.json(toScan(row));
  });

  /** Removing a scan also removes its original file. */
  app.delete('/:pid/scans/:id', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notFound('That scan');
    const { db, files } = c.var.cell;
    const [scan] = await db.select().from(scans).where(and(eq(scans.id, id), eq(scans.profileId, c.var.profile.id))).limit(1);
    if (!scan) throw notFound('That scan');
    const [doc] = await db.delete(documents).where(eq(documents.id, scan.documentId)).returning();
    if (doc) await files.delete(doc.storageKey);
    return c.body(null, 204);
  });

  return app;
}
