// Lab results into the profile (docs/lab-booking-backend.md §4.1, §5.3).
//
// fetchDue(): for orders whose partner status changed since the last report check (reaching partial_report or
//   report_ready, or REPORT_AMENDED while ready or delivered), fetch the report. A new version is stored as a pending
//   result: the bundle (rows as the lab printed them) and the PDF in the cell's file store, under the profile. A
//   failed fetch is retried with backoff (1 minute doubling to 1 hour), with an alert after 8 failures in a row.
//
// The app lists pending results and shows them on its review screen, matching rows to the biomarker catalogue
// itself (§4.2). save() then turns a result into ordinary records in one transaction: the PDF becomes a document,
// the reviewed values become measurements, and whatever an earlier delivery of the same order saved is replaced.
// A final result moves the order to delivered. dismiss() drops a result without saving anything.
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, max, or } from 'drizzle-orm';
import type { z } from 'zod';
import type { LabResultBundle, LabResultView } from '../../../../shared/lab-bundle.ts';
import type { Db } from '../../db/client.ts';
import { documents, labResults, measurements, type LabResultRow } from '../../db/schema.ts';
import { conflict, notFound } from '../../lib/errors.ts';
import type { FileStore } from '../../lib/files.ts';
import type { MeasurementInput } from '../../schemas.ts';
import type { Logger } from '../log.ts';
import { checkMove, REPORT_STATUSES } from '../orders/state.ts';
import { PartnerError, type PartnerReport, type PartnerRegistry } from '../partners/types.ts';
import { DrizzleOrderStore } from '../store/drizzle.ts';
import type { OrderRecord, OrderStore } from '../store/types.ts';
import { buildBundle } from './bundle.ts';

export type ReviewedMeasurement = z.output<typeof MeasurementInput>;

export interface ResultsDeps {
  /** The cell's database and file store. */
  db: Db;
  files: FileStore;
  orders: OrderStore;
  partners: PartnerRegistry;
  now: () => number;
  log: Logger;
  /** A new result is waiting for review (notifications hang off this). */
  onResultsReady?: (order: OrderRecord, resultId: string) => void | Promise<void>;
}

const MIN = 60_000;
const ALERT_AFTER = 8;

/** How saved records are labelled (their sourceFile), and what replacing an order's earlier delivery matches on. */
export function sourceLabel(bundle: LabResultBundle): string {
  return `${bundle.source.labName ?? bundle.source.partner} order ${bundle.source.partnerRef}`;
}

/** A version for reports that don't carry one: a hash of what they contain. */
function contentVersion(r: PartnerReport): string {
  const h = createHash('sha256').update(JSON.stringify({ partial: r.partial, rows: r.rows ?? [] }));
  if (r.pdf) h.update(r.pdf);
  return `sha256:${h.digest('hex')}`;
}

export function resultView(r: LabResultRow): LabResultView {
  return {
    id: r.id, orderId: r.orderId, profileId: r.profileId, sequence: r.sequence, partial: r.partial, status: r.status,
    source: sourceLabel(r.bundle), createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null,
    documentId: r.documentId, hasPdf: !!r.pdfKey, ...(r.status === 'pending' ? { bundle: r.bundle } : {}),
  };
}

export class ResultsService {
  private readonly deps: ResultsDeps;
  private running: Promise<{ checked: number; stored: number; failed: number }> | null = null;

  constructor(deps: ResultsDeps) {
    this.deps = deps;
  }

  /* ---------------- fetching ---------------- */

  /** Check every order whose report may be new. Overlapping calls share one run. */
  fetchDue(limit = 20): Promise<{ checked: number; stored: number; failed: number }> {
    this.running ??= this.run(limit).finally(() => { this.running = null; });
    return this.running;
  }

  private async run(limit: number) {
    const out = { checked: 0, stored: 0, failed: 0 };
    for (const o of await this.deps.orders.dueForReport([...REPORT_STATUSES], this.deps.now(), limit)) {
      out.checked++;
      try {
        if (await this.fetchOne(o)) out.stored++;
      } catch (e) {
        out.failed++;
        await this.fetchFailed(o, e);
      }
    }
    return out;
  }

  /** Returns true if a new result was stored. */
  private async fetchOne(o: OrderRecord): Promise<boolean> {
    const { db, files, orders, partners, log } = this.deps;
    const cfg = partners.get(o.partner);
    if (!cfg || !o.partnerRef || o.partnerStatusAt == null) return false;
    // What this check covers: the partner status as it was when we started. A later status means check again.
    const seenAt = o.partnerStatusAt;
    const report = await cfg.adapter.report(o.partnerRef, o.partnerToken);
    const now = this.deps.now();
    const markChecked = (extra: Partial<OrderRecord> = {}) => orders.apply(o.id, cur => ({
      next: { ...cur, ...extra, reportCheckedStatusAt: Math.max(cur.reportCheckedStatusAt ?? 0, seenAt), reportAttempts: 0, nextReportAt: null, updatedAt: now },
      events: [],
    }));
    if (report.pending) {
      await markChecked();
      return false;
    }
    const version = report.version ?? contentVersion(report);
    if (version === o.reportVersion) {
      await markChecked();
      return false;
    }

    const [{ last }] = await db.select({ last: max(labResults.sequence) }).from(labResults).where(eq(labResults.orderId, o.id));
    const sequence = (last ?? 0) + 1;
    const bundle = buildBundle(report, { partner: o.partner, orderId: o.id, partnerRef: o.partnerRef, sequence })!;
    const id = randomUUID();
    const pdf = report.pdf?.byteLength ? report.pdf : null;
    // Same key shape as uploaded documents (<profile>/<uuid>), so it is deleted with the profile like them.
    const pdfKey = pdf ? `${o.profileId}/${id}` : null;
    if (pdf && pdfKey) await files.put(pdfKey, pdf);

    let superseded: string[] = [];
    try {
      await db.transaction(async tx => {
        // An unreviewed earlier delivery won't be saved now: this one replaces it, and its PDF goes.
        const dropped = await tx.select({ id: labResults.id, pdfKey: labResults.pdfKey }).from(labResults)
          .where(and(eq(labResults.orderId, o.id), eq(labResults.status, 'pending')));
        if (dropped.length) {
          await tx.update(labResults).set({ status: 'superseded', decidedAt: new Date(now), pdfKey: null }).where(inArray(labResults.id, dropped.map(d => d.id)));
        }
        superseded = dropped.map(d => d.pdfKey).filter((k): k is string => !!k);
        await tx.insert(labResults).values({
          id, orderId: o.id, profileId: o.profileId, sequence, partial: report.partial, partnerVersion: version, bundle,
          pdfKey, pdfBytes: pdf?.byteLength ?? null, pdfSha256: pdf ? createHash('sha256').update(pdf).digest('hex') : null,
          status: 'pending', createdAt: new Date(now),
        });
        await new DrizzleOrderStore(tx as unknown as Db).apply(o.id, cur => ({
          next: { ...cur, reportVersion: version, reportCheckedStatusAt: Math.max(cur.reportCheckedStatusAt ?? 0, seenAt), reportAttempts: 0, nextReportAt: null, updatedAt: now },
          events: [{
            orderId: o.id, status: cur.status, partnerStatus: null, source: 'system', occurredAt: now, receivedAt: now,
            note: `${report.partial ? 'partial ' : ''}results received (delivery ${sequence})`,
          }],
        }));
      });
    } catch (e) {
      if (pdfKey) await files.delete(pdfKey).catch(() => {});
      throw e;
    }
    for (const k of superseded) await files.delete(k).catch(() => {});
    log.info('lab results stored', { orderId: o.id, partner: o.partner, resultId: id, sequence, partial: report.partial, hasPdf: !!pdf });
    try {
      await this.deps.onResultsReady?.(o, id);
    } catch {
      log.error('results hook failed', { orderId: o.id, alert: true });
    }
    return true;
  }

  private async fetchFailed(o: OrderRecord, e: unknown): Promise<void> {
    const now = this.deps.now();
    const attempts = o.reportAttempts + 1;
    const delay = Math.min(MIN * 2 ** (attempts - 1), 60 * MIN);
    await this.deps.orders.apply(o.id, cur => ({ next: { ...cur, reportAttempts: attempts, nextReportAt: now + delay, updatedAt: now }, events: [] }));
    const fields = { orderId: o.id, partner: o.partner, attempts, error: e instanceof PartnerError ? e.code : e instanceof Error ? e.name : 'error' };
    if (attempts === ALERT_AFTER || (e instanceof PartnerError && !e.retryable && attempts === 1)) {
      this.deps.log.error('lab report could not be fetched', { ...fields, alert: true });
    } else {
      this.deps.log.warn('lab report fetch failed; will retry', { ...fields, retryInMs: delay });
    }
  }

  /* ---------------- reading, saving, dismissing ---------------- */

  async list(profileId: string, all = false): Promise<LabResultView[]> {
    const rows = await this.deps.db.select().from(labResults)
      .where(all ? eq(labResults.profileId, profileId) : and(eq(labResults.profileId, profileId), eq(labResults.status, 'pending')))
      .orderBy(desc(labResults.createdAt), desc(labResults.sequence));
    return rows.map(resultView);
  }

  async get(profileId: string, id: string): Promise<LabResultRow> {
    const [r] = /^[0-9a-f-]{36}$/i.test(id)
      ? await this.deps.db.select().from(labResults).where(and(eq(labResults.id, id), eq(labResults.profileId, profileId))).limit(1)
      : [];
    if (!r) throw notFound('That lab result');
    return r;
  }

  /** The report PDF, while the result has one. */
  async pdf(profileId: string, id: string): Promise<{ stream: ReadableStream<Uint8Array>; fileName: string } | null> {
    const r = await this.get(profileId, id);
    if (!r.pdfKey) return null;
    const stream = await this.deps.files.get(r.pdfKey);
    return stream ? { stream, fileName: `${sourceLabel(r.bundle)}.pdf` } : null;
  }

  /**
   * Save a pending result as the profile's records: the PDF as a document (kind "report") and the reviewed values
   * as measurements labelled with the order. Measurements and documents saved from an earlier delivery of the same
   * order are replaced. A final (non-partial) result moves the order to delivered.
   */
  async save(profileId: string, id: string, reviewed: ReviewedMeasurement[]): Promise<{ result: LabResultView; documentId: string | null; saved: number; replaced: number }> {
    const { db, files, log } = this.deps;
    const r = await this.get(profileId, id);
    if (r.status !== 'pending') throw conflict(`This result is already ${r.status}.`, 'not_pending');
    const label = sourceLabel(r.bundle);
    const now = this.deps.now();
    const documentId = r.pdfKey ? randomUUID() : null;
    const removedFiles: string[] = [];

    const out = await db.transaction(async tx => {
      const earlier = await tx.select().from(labResults).where(and(eq(labResults.orderId, r.orderId), eq(labResults.status, 'saved')));
      const earlierDocs = earlier.map(e => e.documentId).filter((d): d is string => !!d);
      const replaced = await tx.delete(measurements).where(and(
        eq(measurements.profileId, profileId),
        or(eq(measurements.sourceFile, label), earlierDocs.length ? inArray(measurements.documentId, earlierDocs) : undefined),
      )).returning({ id: measurements.id });
      if (earlierDocs.length) {
        const gone = await tx.delete(documents).where(and(eq(documents.profileId, profileId), inArray(documents.id, earlierDocs)))
          .returning({ storageKey: documents.storageKey });
        removedFiles.push(...gone.map(d => d.storageKey));
      }
      if (earlier.length) {
        await tx.update(labResults).set({ status: 'superseded', documentId: null, pdfKey: null }).where(inArray(labResults.id, earlier.map(e => e.id)));
      }
      if (documentId) {
        // The PDF is already in the profile's file store; the document points at it rather than copying it.
        await tx.insert(documents).values({
          id: documentId, profileId, fileName: `${label}.pdf`, contentType: 'application/pdf', kind: 'report',
          sizeBytes: r.pdfBytes ?? 0, sha256: r.pdfSha256 ?? '', storageKey: r.pdfKey!,
        });
      }
      const rows = reviewed.length
        ? await tx.insert(measurements).values(reviewed.map(m => ({ ...m, profileId, documentId, sourceFile: label }))).returning({ id: measurements.id })
        : [];
      const [after] = await tx.update(labResults).set({ status: 'saved', documentId, decidedAt: new Date(now) }).where(eq(labResults.id, r.id)).returning();
      if (!r.partial) {
        await new DrizzleOrderStore(tx as unknown as Db).apply(r.orderId, cur => checkMove(cur.status, 'delivered', 'local').ok ? {
          next: { ...cur, status: 'delivered', updatedAt: now },
          events: [{ orderId: cur.id, status: 'delivered', partnerStatus: null, source: 'user', occurredAt: now, receivedAt: now, note: 'results saved to the profile' }],
        } : null);
      }
      return { after, saved: rows.length, replaced: replaced.length };
    });
    for (const k of removedFiles) await files.delete(k).catch(() => {});
    log.info('lab results saved', { resultId: r.id, orderId: r.orderId, saved: out.saved, replaced: out.replaced });
    return { result: resultView(out.after), documentId, saved: out.saved, replaced: out.replaced };
  }

  /** Drop a pending result without saving anything: its PDF is deleted and only the decision is kept. */
  async dismiss(profileId: string, id: string): Promise<LabResultView> {
    const r = await this.get(profileId, id);
    if (r.status !== 'pending') throw conflict(`This result is already ${r.status}.`, 'not_pending');
    const [after] = await this.deps.db.update(labResults)
      .set({ status: 'dismissed', decidedAt: new Date(this.deps.now()), pdfKey: null, bundle: { ...r.bundle, results: [] } })
      .where(eq(labResults.id, r.id)).returning();
    if (r.pdfKey) await this.deps.files.delete(r.pdfKey).catch(() => {});
    return resultView(after);
  }
}
