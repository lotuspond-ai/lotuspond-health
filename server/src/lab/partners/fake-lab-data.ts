// Fixture data for the simulated lab: packages and the result rows each panel prints.
// Names, units and printed ranges follow common Indian lab report styles. Values are invented.
// Units stick to characters a base-14 PDF font can draw (WinAnsi), e.g. "X 10³ / µL".

export interface FixtureRow {
  name: string;
  unit: string;
  /** Number for measured values; text for qualitative ones ("Negative"). */
  base: number | string;
  /** Female value when it differs. */
  baseF?: number;
  /** Decimal places to print. */
  dp?: number;
  /** How far values may vary between orders, as a fraction either way. Default 0.04. */
  jitter?: number;
  /** Printed reference range: "13.0 - 17.0", "< 200", "> 40", "Negative". */
  range: string;
  /** Female range when it differs. */
  rangeF?: string;
}

export interface Panel {
  code: string;
  title: string;
  /** Results that usually come back a day later; held back from a partial report. */
  slow?: boolean;
  rows: FixtureRow[];
}

export const PANELS: Panel[] = [
  {
    code: 'CBC', title: 'Complete blood count', rows: [
      { name: 'Haemoglobin', unit: 'g/dL', base: 14.2, baseF: 12.6, dp: 1, range: '13.0 - 17.0', rangeF: '12.0 - 15.0' },
      { name: 'Total Leucocyte Count (WBC)', unit: 'X 10³ / µL', base: 7.2, dp: 2, range: '4.0 - 10.0' },
      { name: 'RBC Count', unit: 'mill/cumm', base: 4.9, baseF: 4.4, dp: 2, range: '4.5 - 5.5', rangeF: '3.8 - 4.8' },
      { name: 'Haematocrit (PCV)', unit: '%', base: 43.5, baseF: 38.9, dp: 1, range: '40 - 50', rangeF: '36 - 46' },
      { name: 'MCV', unit: 'fL', base: 88.4, dp: 1, range: '83 - 101' },
      { name: 'MCH', unit: 'pg', base: 29.1, dp: 1, range: '27 - 32' },
      { name: 'MCHC', unit: 'g/dL', base: 33.0, dp: 1, range: '31.5 - 34.5' },
      { name: 'RDW-CV', unit: '%', base: 13.2, dp: 1, range: '11.6 - 14.0' },
      { name: 'Neutrophils', unit: '%', base: 58, dp: 0, range: '40 - 80' },
      { name: 'Lymphocytes', unit: '%', base: 32, dp: 0, range: '20 - 40' },
      { name: 'Monocytes', unit: '%', base: 6, dp: 0, range: '2 - 10' },
      { name: 'Eosinophils', unit: '%', base: 3, dp: 0, range: '1 - 6' },
      { name: 'Platelet Count', unit: 'X 10³ / µL', base: 245, dp: 0, range: '150 - 410' },
    ],
  },
  {
    code: 'LIPID', title: 'Lipid profile', rows: [
      { name: 'Total Cholesterol', unit: 'mg/dL', base: 212, dp: 0, range: '< 200' },
      { name: 'Triglycerides', unit: 'mg/dL', base: 168, dp: 0, range: '< 150' },
      { name: 'HDL Cholesterol - Direct', unit: 'mg/dL', base: 44, dp: 0, range: '> 40' },
      { name: 'LDL Cholesterol - Direct', unit: 'mg/dL', base: 138, dp: 0, range: '< 100' },
      { name: 'VLDL Cholesterol', unit: 'mg/dL', base: 33.6, dp: 1, range: '< 30' },
      { name: 'Non-HDL Cholesterol', unit: 'mg/dL', base: 168, dp: 0, range: '< 130' },
      { name: 'TC/HDL Cholesterol Ratio', unit: 'Ratio', base: 4.5, dp: 1, range: '3.0 - 5.0' },
    ],
  },
  {
    code: 'FBS', title: 'Blood sugar', rows: [
      { name: 'Fasting Blood Sugar (Glucose)', unit: 'mg/dL', base: 108, dp: 0, range: '70 - 100' },
    ],
  },
  {
    code: 'HBA1C', title: 'Glycosylated haemoglobin', slow: true, rows: [
      { name: 'HbA1c', unit: '%', base: 5.9, dp: 1, range: '4.0 - 5.6' },
      { name: 'Estimated Average Glucose (eAG)', unit: 'mg/dL', base: 123, dp: 0, range: '< 117' },
    ],
  },
  {
    code: 'LFT', title: 'Liver function test', rows: [
      { name: 'Bilirubin - Total', unit: 'mg/dL', base: 0.8, dp: 2, range: '0.3 - 1.2' },
      { name: 'Bilirubin - Direct', unit: 'mg/dL', base: 0.2, dp: 2, range: '0.0 - 0.3' },
      { name: 'Bilirubin - Indirect', unit: 'mg/dL', base: 0.6, dp: 2, range: '0.0 - 0.9' },
      { name: 'SGOT (AST)', unit: 'U/L', base: 28, dp: 0, range: '< 35' },
      { name: 'SGPT (ALT)', unit: 'U/L', base: 52, dp: 0, range: '< 45' },
      { name: 'Alkaline Phosphatase', unit: 'U/L', base: 82, dp: 0, range: '45 - 129' },
      { name: 'Gamma GT (GGT)', unit: 'U/L', base: 32, dp: 0, range: '< 55' },
      { name: 'Total Protein', unit: 'g/dL', base: 7.2, dp: 1, range: '6.4 - 8.3' },
      { name: 'Albumin', unit: 'g/dL', base: 4.4, dp: 1, range: '3.5 - 5.2' },
      { name: 'Globulin', unit: 'g/dL', base: 2.8, dp: 1, range: '2.0 - 3.5' },
      { name: 'A/G Ratio', unit: 'Ratio', base: 1.57, dp: 2, range: '0.9 - 2.0' },
    ],
  },
  {
    code: 'KFT', title: 'Kidney function test', rows: [
      { name: 'Urea', unit: 'mg/dL', base: 26, dp: 0, range: '17 - 43' },
      { name: 'Blood Urea Nitrogen (BUN)', unit: 'mg/dL', base: 12.1, dp: 1, range: '7 - 20' },
      { name: 'Creatinine', unit: 'mg/dL', base: 0.92, baseF: 0.74, dp: 2, range: '0.70 - 1.30', rangeF: '0.55 - 1.02' },
      { name: 'Uric Acid', unit: 'mg/dL', base: 6.1, baseF: 4.9, dp: 1, range: '3.5 - 7.2', rangeF: '2.6 - 6.0' },
      { name: 'Sodium', unit: 'mmol/L', base: 140, dp: 0, jitter: 0.012, range: '136 - 145' },
      { name: 'Potassium', unit: 'mmol/L', base: 4.4, dp: 1, range: '3.5 - 5.1' },
      { name: 'Chloride', unit: 'mmol/L', base: 102, dp: 0, jitter: 0.015, range: '98 - 107' },
      { name: 'Calcium', unit: 'mg/dL', base: 9.4, dp: 1, jitter: 0.03, range: '8.6 - 10.3' },
    ],
  },
  {
    code: 'TFT', title: 'Thyroid profile, total', rows: [
      { name: 'Total T3', unit: 'ng/dL', base: 112, dp: 0, range: '80 - 200' },
      { name: 'Total T4', unit: 'µg/dL', base: 8.1, dp: 1, range: '5.1 - 14.1' },
      { name: 'TSH - Ultrasensitive', unit: 'µIU/mL', base: 2.6, dp: 2, range: '0.54 - 5.30' },
    ],
  },
  {
    code: 'VITD', title: 'Vitamin D', slow: true, rows: [
      { name: '25-OH Vitamin D (Total)', unit: 'ng/mL', base: 18.4, dp: 1, range: '30 - 100' },
    ],
  },
  {
    code: 'B12', title: 'Vitamin B12', slow: true, rows: [
      { name: 'Vitamin B-12', unit: 'pg/mL', base: 186, dp: 0, range: '211 - 911' },
    ],
  },
  {
    code: 'IRON', title: 'Iron studies', rows: [
      { name: 'Iron', unit: 'µg/dL', base: 72, dp: 0, range: '65 - 175', rangeF: '50 - 170' },
      { name: 'Total Iron Binding Capacity (TIBC)', unit: 'µg/dL', base: 340, dp: 0, range: '250 - 450' },
      { name: 'Transferrin Saturation', unit: '%', base: 21, dp: 0, range: '20 - 50' },
      { name: 'Ferritin', unit: 'ng/mL', base: 48, dp: 0, range: '30 - 400', rangeF: '13 - 150' },
    ],
  },
  {
    code: 'URINE', title: 'Urine routine examination', rows: [
      { name: 'Urine pH', unit: '', base: 6.0, dp: 1, range: '4.6 - 8.0' },
      { name: 'Urine Specific Gravity', unit: '', base: 1.02, dp: 3, jitter: 0.004, range: '1.005 - 1.030' },
      { name: 'Urine Glucose', unit: '', base: 'Negative', range: 'Negative' },
      { name: 'Urine Protein', unit: '', base: 'Negative', range: 'Negative' },
      { name: 'Urine Ketones', unit: '', base: 'Negative', range: 'Negative' },
      { name: 'Pus Cells', unit: '/hpf', base: '2-3', range: '0 - 5' },
    ],
  },
];

export interface PackageDef {
  code: string;
  name: string;
  panels: string[];
  mrpInr: number;
  offerInr: number;
  fasting: boolean;
  tatHours: number;
}

/** Invented package names; not modelled on any real lab's packages. */
export const PACKAGES: PackageDef[] = [
  { code: 'FL_ESSENTIAL', name: 'Essential health check', panels: ['CBC', 'LIPID', 'FBS', 'HBA1C', 'LFT', 'KFT', 'TFT'], mrpInr: 2400, offerInr: 999, fasting: true, tatHours: 24 },
  { code: 'FL_COMPLETE', name: 'Complete health check', panels: ['CBC', 'LIPID', 'FBS', 'HBA1C', 'LFT', 'KFT', 'TFT', 'VITD', 'B12', 'IRON', 'URINE'], mrpInr: 4800, offerInr: 1899, fasting: true, tatHours: 36 },
  { code: 'FL_THYROID', name: 'Thyroid profile', panels: ['TFT'], mrpInr: 800, offerInr: 399, fasting: false, tatHours: 12 },
  { code: 'FL_LIPID', name: 'Lipid profile', panels: ['LIPID'], mrpInr: 700, offerInr: 349, fasting: true, tatHours: 12 },
  { code: 'FL_DIABETES', name: 'Diabetes check', panels: ['FBS', 'HBA1C'], mrpInr: 900, offerInr: 449, fasting: true, tatHours: 24 },
  { code: 'FL_VITAMINS', name: 'Vitamin D and B12', panels: ['VITD', 'B12'], mrpInr: 2600, offerInr: 1199, fasting: false, tatHours: 24 },
];

/** First three digits of the pincodes the simulated lab serves (Delhi NCR, Mumbai, Pune, Hyderabad, Bengaluru, Chennai, Kolkata). */
export const SERVED_PIN_PREFIXES = ['110', '122', '201', '400', '411', '500', '560', '600', '700'];

/** Collection slot start hours (IST); each slot is one hour. */
export const SLOT_HOURS = [6, 7, 8, 9, 10, 11, 16, 17];
