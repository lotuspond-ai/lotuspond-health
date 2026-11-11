// FHIR R4 lab results: a Bundle (document, collection, searchset...), a DiagnosticReport or a single Observation.
// This is the format India's health records network (ABDM) carries, in the national profiles from NRCES
// (DiagnosticReportRecord: a document Bundle with a Composition, the Patient, DiagnosticReports and Observations),
// and what ABHA apps and many hospital portals export. docs/abdm.md explains where it fits.
//
// Observations become results: the LOINC code picks the catalogue marker when it has one, otherwise the name does;
// valueQuantity, valueString, valueCodeableConcept and valueInteger are read; reference ranges, interpretation
// flags (H, L...) and components (a blood pressure panel's systolic and diastolic) are kept. A report that carries
// only a PDF (presentedForm, or a DocumentReference) yields that PDF, which the caller reads like an upload.
import type { Measurement, ParseResult } from '../../types';
import { buildMeasurement, dedupeMeasurements, type RawRow } from './rows.ts';
import { parseDate } from './dates.ts';
import { findMarkerByLoinc } from '../catalog.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

const LOINC_SYSTEM = /loinc\.org/i;
/** Statuses that mean the value must not be used. */
const UNUSABLE = new Set(['entered-in-error', 'cancelled']);

/** True for FHIR content this reader handles. */
export function isFhir(data: unknown): boolean {
  if (!isObj(data)) return false;
  return data.resourceType === 'Bundle' || data.resourceType === 'DiagnosticReport' || data.resourceType === 'Observation';
}

/** Every resource in the content, including entries of nested bundles and contained resources. */
function resources(data: unknown, depth = 0): Obj[] {
  if (!isObj(data) || depth > 4) return [];
  const out: Obj[] = [data];
  for (const c of arr(data.contained)) out.push(...resources(c, depth + 1));
  if (data.resourceType === 'Bundle') for (const e of arr(data.entry)) if (isObj(e)) out.push(...resources(e.resource, depth + 1));
  return out;
}

/** UCUM as printed: "10*3/uL" → "10^3/µL", "mm[Hg]" → "mmHg", "[IU]/L" → "IU/L", "Cel" → "°C". */
export function ucumDisplay(unit: string): string {
  let u = unit.trim();
  if (u === 'Cel') return '°C';
  if (u === '[degF]') return '°F';
  u = u.replace(/\[([^\]]*)\]/g, '$1').replace(/10\*(\d+)/g, '10^$1').replace(/\{[^}]*\}/g, '');
  // "u" as the micro prefix (uL, ug/dL, uIU/mL, umol/L), not in words such as "unit".
  u = u.replace(/(^|\/)u(?=(?:L|g|mol|IU|U)\b|IU)/g, '$1µ');
  return u.trim();
}

function codingOf(cc: unknown): { loinc: string | null; name: string | null } {
  if (!isObj(cc)) return { loinc: null, name: null };
  const codings = arr(cc.coding).filter(isObj);
  const loinc = codings.find(c => LOINC_SYSTEM.test(String(c.system ?? '')) && str(c.code));
  const display = codings.map(c => str(c.display)).find(Boolean) ?? null;
  return { loinc: loinc ? str(loinc.code) : null, name: str(cc.text) ?? display ?? (loinc ? str(loinc.code) : null) };
}

function valueOf(o: Obj): { value: string | number | null; unit: string | null } {
  if (isObj(o.valueQuantity)) {
    const q = o.valueQuantity;
    const comparator = str(q.comparator) ?? '';
    const v = typeof q.value === 'number' ? q.value : str(q.value);
    const raw = str(q.unit) ?? str(q.code);
    // Some systems put the UCUM code in `unit` too ("10*3/uL"); show it as a person would write it.
    const unit = raw && /[*[\]{}]|^Cel$/.test(raw) ? ucumDisplay(raw) : raw;
    return { value: v == null ? null : comparator ? `${comparator}${v}` : v, unit };
  }
  if (typeof o.valueInteger === 'number') return { value: o.valueInteger, unit: null };
  if (str(o.valueString)) return { value: str(o.valueString), unit: null };
  if (isObj(o.valueCodeableConcept)) return { value: codingOf(o.valueCodeableConcept).name, unit: null };
  if (typeof o.valueBoolean === 'boolean') return { value: o.valueBoolean ? 'Positive' : 'Negative', unit: null };
  return { value: null, unit: null };
}

function rangeOf(o: Obj): Pick<RawRow, 'range' | 'low' | 'high'> {
  const r = arr(o.referenceRange).find(isObj);
  if (!r) return {};
  const low = isObj(r.low) && typeof r.low.value === 'number' ? r.low.value : null;
  const high = isObj(r.high) && typeof r.high.value === 'number' ? r.high.value : null;
  return { range: str(r.text), low, high };
}

function flagOf(o: Obj): string | null {
  for (const cc of arr(o.interpretation)) {
    if (!isObj(cc)) continue;
    for (const c of arr(cc.coding)) {
      const code = isObj(c) ? str(c.code)?.toUpperCase() : null;
      if (code === 'H' || code === 'HH' || code === 'HU' || code === '>') return 'H';
      if (code === 'L' || code === 'LL' || code === 'LU' || code === '<') return 'L';
    }
    const t = str(cc.text)?.toLowerCase();
    if (t === 'high' || t === 'low') return t;
  }
  return null;
}

const dateOf = (o: Obj): string | null =>
  parseDate(str(o.effectiveDateTime) ?? (isObj(o.effectivePeriod) ? str(o.effectivePeriod.start) : null) ?? str(o.issued) ?? str(o.date));

/** One Observation → rows: itself when it has a value, plus each component that has one. */
function rowsOf(o: Obj, fallbackDate: string | null): (RawRow & { loinc: string | null })[] {
  const date = dateOf(o) ?? fallbackDate;
  const out: (RawRow & { loinc: string | null })[] = [];
  const add = (src: Obj, code: unknown) => {
    const { loinc, name } = codingOf(code);
    const v = valueOf(src);
    if (!name || v.value == null) return;
    const marker = loinc ? findMarkerByLoinc(loinc) : undefined;
    out.push({ name, value: v.value, unit: v.unit, ...rangeOf(src), date, flag: flagOf(src), markerId: marker?.id ?? null, loinc });
  };
  add(o, o.code);
  for (const c of arr(o.component)) if (isObj(c)) add(c, c.code);
  return out;
}

export interface FhirAttachment { title: string; contentType: string; data: string }

/** PDFs (and other attachments) carried in DiagnosticReport.presentedForm or DocumentReference.content. */
export function fhirAttachments(data: unknown): FhirAttachment[] {
  const out: FhirAttachment[] = [];
  for (const r of resources(data)) {
    const forms = r.resourceType === 'DiagnosticReport' ? arr(r.presentedForm)
      : r.resourceType === 'DocumentReference' ? arr(r.content).map(c => (isObj(c) ? c.attachment : null))
      : r.resourceType === 'Binary' ? [{ contentType: r.contentType, data: r.data, title: r.id }]
      : [];
    for (const a of forms) {
      if (!isObj(a) || !str(a.data) || !str(a.contentType)) continue;
      out.push({ title: str(a.title) ?? str(r.id) ?? 'report', contentType: str(a.contentType)!, data: str(a.data)! });
    }
  }
  return out;
}

/** The patient's name as written in the record, so the review can say whose results these are. */
export function fhirPatientName(data: unknown): string | null {
  const p = resources(data).find(r => r.resourceType === 'Patient');
  const n = p ? arr(p.name).find(isObj) : null;
  if (!n) return null;
  return str(n.text) ?? ([...arr(n.given).map(str), str(n.family)].filter(Boolean).join(' ') || null);
}

/** FHIR content → results for the upload review. Attachments are returned for the caller to read. */
export function parseFhir(data: unknown, sourceFile: string): ParseResult & { attachments: FhirAttachment[] } {
  const all = resources(data);
  const reportDate = all.filter(r => r.resourceType === 'DiagnosticReport').map(dateOf).find(Boolean)
    ?? all.filter(r => r.resourceType === 'Composition').map(dateOf).find(Boolean) ?? null;
  const out: Measurement[] = [];
  let skipped = 0, preliminary = 0, unmatched = 0;
  for (const o of all) {
    if (o.resourceType !== 'Observation') continue;
    const status = str(o.status);
    if (status && UNUSABLE.has(status)) { skipped++; continue; }
    for (const row of rowsOf(o, reportDate)) {
      const m = buildMeasurement(row, { sourceFile, date: row.date ?? reportDate, keepUnmatched: true });
      if (!m) continue;
      // A LOINC-coded result whose unit matched is as clear as a typed one; a preliminary one still needs checking.
      if (status === 'preliminary' || status === 'registered') { m.confidence = 'low'; preliminary++; }
      if (!m.markerId) unmatched++;
      out.push(m);
    }
  }
  const measurements = dedupeMeasurements(out);
  const attachments = fhirAttachments(data);
  const warnings: string[] = [];
  const who = fhirPatientName(data);
  if (who && measurements.length) warnings.push(`These results are for ${who}. Add them only to that person’s profile.`);
  if (skipped) warnings.push(`${skipped} result${skipped === 1 ? ' was' : 's were'} marked as entered in error or cancelled, and ${skipped === 1 ? 'was' : 'were'} left out.`);
  if (preliminary) warnings.push(`${preliminary} result${preliminary === 1 ? ' is' : 's are'} marked preliminary by the lab: check ${preliminary === 1 ? 'it' : 'them'} against the final report.`);
  if (unmatched) warnings.push(`${unmatched} row${unmatched === 1 ? '' : 's'} did not match a known biomarker; pick the right one or remove them.`);
  if (!measurements.length && !attachments.length) warnings.push('No lab results were found in this FHIR file.');
  const ds = measurements.map(m => m.date).filter((d): d is string => !!d).sort();
  return { measurements, scans: [], blobs: {}, warnings, detectedDate: ds[ds.length - 1] ?? reportDate, attachments };
}
