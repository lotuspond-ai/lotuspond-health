// Fictional demo data for "Asha". Not a real person; values are illustrative only.
import type { Measurement, ParseResult } from '../types';
import { findMarker } from './catalog.ts';
import { buildMeasurement } from './parse/rows.ts';

type Row = [markerId: string, value: string, unit: string, range: string | null];

const VISITS: Record<string, Row[]> = {
  '2026-03-14': [
    ['total_cholesterol', '212', 'mg/dL', '< 200'],
    ['ldl', '138', 'mg/dL', '< 100'],
    ['hdl', '38', 'mg/dL', '> 40'],
    ['triglycerides', '168', 'mg/dL', '< 150'],
    ['glucose_fasting', '98', 'mg/dL', '70 - 100'],
    ['hba1c', '5.6', '%', '< 5.7'],
    ['alt', '47', 'U/L', 'Upto 40'],
    ['ast', '34', 'U/L', 'Upto 40'],
    ['bilirubin_total', '0.8', 'mg/dL', '0.3 - 1.2'],
    ['creatinine', '0.82', 'mg/dL', '0.6 - 1.1'],
    ['egfr', '96', 'mL/min/1.73m²', '> 60'],
    ['hemoglobin', '12.4', 'g/dL', '12.0 - 15.5'],
    ['wbc', '6.8', '10^3/µL', '4.0 - 11.0'],
    ['platelets', '245', '10^3/µL', '150 - 410'],
    ['tsh', '4.6', 'µIU/mL', '0.4 - 4.5'],
    ['vitamin_d', '14.2', 'ng/mL', '30 - 100'],
    ['vitamin_b12', '310', 'pg/mL', '211 - 911'],
    ['crp', '2.1', 'mg/L', '< 5'],
    ['urine_ph', '6.0', '', '4.6 - 8.0'],
  ],
  '2026-07-02': [
    ['total_cholesterol', '198', 'mg/dL', '< 200'],
    ['ldl', '121', 'mg/dL', '< 100'],
    ['hdl', '42', 'mg/dL', '> 40'],
    ['triglycerides', '141', 'mg/dL', '< 150'],
    ['glucose_fasting', '94', 'mg/dL', '70 - 100'],
    ['alt', '42', 'U/L', 'Upto 40'],
    ['ast', '30', 'U/L', 'Upto 40'],
    ['tsh', '4.3', 'µIU/mL', '0.4 - 4.5'],
    ['vitamin_d', '22.5', 'ng/mL', '30 - 100'],
    ['ferritin', '28', 'ng/mL', '15 - 150'],
    ['hemoglobin', '12.6', 'g/dL', '12.0 - 15.5'],
    ['esr', '18', 'mm/hr', '0 - 20'],
    ['potassium', '4.2', 'mmol/L', '3.5 - 5.1'],
  ],
  '2026-10-20': [
    ['total_cholesterol', '189', 'mg/dL', '< 200'],
    ['ldl', '112', 'mg/dL', '< 100'],
    ['hdl', '47', 'mg/dL', '> 40'],
    ['triglycerides', '128', 'mg/dL', '< 150'],
    ['hba1c', '5.5', '%', '< 5.7'],
    ['glucose_fasting', '91', 'mg/dL', '70 - 100'],
    ['alt', '33', 'U/L', 'Upto 40'],
    ['ast', '27', 'U/L', 'Upto 40'],
    ['tsh', '3.9', 'µIU/mL', '0.4 - 4.5'],
    ['ft4', '1.2', 'ng/dL', '0.8 - 1.8'],
    ['vitamin_d', '31.4', 'ng/mL', '30 - 100'],
    ['hemoglobin', '12.9', 'g/dL', '12.0 - 15.5'],
    ['sodium', '139', 'mmol/L', '135 - 145'],
    ['cortisol', '14.2', 'µg/dL', '5 - 23'],
    ['urine_pus_cells', '2-3', '/hpf', '0 - 5'],
    ['urine_protein', 'Negative', '', 'Negative'],
    ['bp_systolic', '126', 'mmHg', '90 - 120'],
    ['bp_diastolic', '81', 'mmHg', '60 - 80'],
  ],
};

function build(): Measurement[] {
  const out: Measurement[] = [];
  for (const [date, rows] of Object.entries(VISITS)) {
    for (const [markerId, value, unit, range] of rows) {
      const def = findMarker(markerId);
      const m = buildMeasurement({ name: def?.name ?? markerId, value, unit, range, markerId }, { sourceFile: 'Sample report', date });
      if (m) out.push({ ...m, id: `sample-${markerId}-${date}`, confidence: 'high' });
    }
  }
  return out;
}

export const SAMPLE: ParseResult = {
  measurements: build(),
  scans: [],
  blobs: {},
  warnings: [],
  detectedDate: '2026-10-20',
};
