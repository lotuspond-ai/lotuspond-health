// Show lab values in the person's unit system. Stored values are in each marker's canonical (conventional) unit,
// e.g. mg/dL; SI display converts with the catalog's own factors (value_in_canonical = value_in_alt × factor).
import type { Measurement, RefRange } from '../types';
import type { UnitSystem } from '../../shared/regions.ts';
import { findMarker } from './catalog.ts';

/** SI unit shown for each marker where SI and conventional units differ. Markers not listed are the same in both. */
const SI_UNIT: Record<string, string> = {
  total_cholesterol: 'mmol/L', hdl: 'mmol/L', ldl: 'mmol/L', vldl: 'mmol/L', non_hdl: 'mmol/L', triglycerides: 'mmol/L',
  apoa1: 'g/L', apob: 'g/L', lpa: 'nmol/L',
  glucose_fasting: 'mmol/L', glucose_pp: 'mmol/L', glucose_random: 'mmol/L', eag: 'mmol/L', insulin: 'pmol/L',
  bilirubin_total: 'µmol/L', bilirubin_direct: 'µmol/L', bilirubin_indirect: 'µmol/L',
  albumin: 'g/L', globulin: 'g/L', total_protein: 'g/L',
  creatinine: 'µmol/L', urea: 'mmol/L', bun: 'mmol/L', uric_acid: 'µmol/L',
  calcium: 'mmol/L', magnesium: 'mmol/L', phosphorus: 'mmol/L',
  hemoglobin: 'g/L', mchc: 'g/L', hematocrit: 'L/L',
  iron: 'µmol/L', tibc: 'µmol/L', uibc: 'µmol/L', vitamin_d: 'nmol/L',
  t3: 'nmol/L', t4: 'nmol/L', ft3: 'pmol/L', ft4: 'pmol/L', testosterone: 'nmol/L', cortisol: 'nmol/L',
};

/** Factor to divide a canonical value by for SI display, or null when the marker has no SI form. */
export function siConversion(markerId: string | null | undefined): { unit: string; factor: number } | null {
  if (!markerId) return null;
  const unit = SI_UNIT[markerId];
  const def = findMarker(markerId);
  const alt = unit && def?.altUnits?.find(a => a.unit === unit);
  return alt ? { unit, factor: alt.factor } : null;
}

/** Three significant figures, no more than two decimals; values of 100 and above as whole numbers. */
export function roundForDisplay(v: number): number {
  if (!Number.isFinite(v) || v === 0) return v;
  const abs = Math.abs(v);
  if (abs >= 100) return Math.round(v);
  const decimals = Math.min(2, Math.max(0, 2 - Math.floor(Math.log10(abs))));
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export interface DisplayValue {
  value: number | null;
  /** Value as text, e.g. "5.1" or "Negative". */
  text: string;
  unit: string;
  range: RefRange | null;
  /** True when the value was converted from the stored unit. */
  converted: boolean;
}

function convertRange(r: RefRange | null, factor: number): RefRange | null {
  if (!r) return r;
  const low = r.low != null ? roundForDisplay(r.low / factor) : undefined;
  const high = r.high != null ? roundForDisplay(r.high / factor) : undefined;
  const text = low != null && high != null ? `${low} – ${high}` : high != null ? `< ${high}` : low != null ? `> ${low}` : r.text;
  return { ...r, low, high, text };
}

/** A measurement as it should be shown in the given unit system. Status is unchanged by conversion. */
export function displayMeasurement(m: Measurement, system: UnitSystem): DisplayValue {
  const conv = system === 'si' && m.value != null && m.unit === findMarker(m.markerId)?.unit ? siConversion(m.markerId) : null;
  if (!conv || m.value == null) return { value: m.value, text: m.valueText, unit: m.unit, range: m.range, converted: false };
  const value = roundForDisplay(m.value / conv.factor);
  const prefix = /^\s*[<>≤≥]/.exec(m.valueText)?.[0].trim() ?? '';
  return { value, text: `${prefix}${value}`, unit: conv.unit, range: convertRange(m.range, conv.factor), converted: true };
}

export const UNIT_SYSTEM_LABEL: Record<UnitSystem, string> = {
  conventional: 'Conventional (mg/dL)',
  si: 'International (SI, mmol/L)',
};
