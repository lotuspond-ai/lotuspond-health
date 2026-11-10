// Turns an adapter's report into the bundle the browser receives (design doc §4.2, §9).
// The server never matches results to the biomarker catalog; the browser does that.
import type { LabResultBundle, PartnerId } from '../../../../shared/lab-bundle.ts';
import type { PartnerReport } from '../partners/types.ts';

const IST_OFFSET_MS = 330 * 60_000;

/** Collection date as the patient knows it: the calendar day in India. */
function collectionDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export interface BundleContext {
  partner: PartnerId;
  orderId: string;
  partnerRef: string;
  sequence: number;
}

/** Null while the report is still pending. A PDF-only report gives a bundle with no rows; the PDF travels separately. */
export function buildBundle(report: PartnerReport, ctx: BundleContext): LabResultBundle | null {
  if (report.pending) return null;
  return {
    version: 1,
    kind: 'lab-result-bundle',
    source: {
      partner: ctx.partner, orderId: ctx.orderId, partnerRef: ctx.partnerRef,
      ...(report.labName ? { labName: report.labName } : {}),
    },
    date: collectionDate(report.collectedAt),
    reportedAt: report.reportedAt ?? null,
    partial: report.partial,
    sequence: ctx.sequence,
    // Never send `markerId`: an id the catalog doesn't know turns off name matching (design doc §4.2).
    results: (report.rows ?? []).map(r => ({ ...r })),
  };
}
