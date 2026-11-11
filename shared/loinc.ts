// LOINC codes (https://loinc.org) for the catalogue's markers: the standard identifier other systems, FHIR and
// agents use for a lab test. One code per marker, the one Indian lab reports most often correspond to (for example
// calculated LDL, CKD-EPI eGFR, 25-hydroxyvitamin D2+D3). Markers with no confident match are left out.
// Every code passes LOINC's mod-10 check digit (tools/test-parsers.mjs checks it).
// LOINC is copyright Regenstrief Institute, Inc., and is available at no cost under the license at https://loinc.org/license.
export const LOINC: Readonly<Record<string, string>> = {
  total_cholesterol: '2093-3',
  hdl: '2085-9',
  ldl: '13457-7',
  vldl: '13458-5',
  non_hdl: '43396-1',
  triglycerides: '2571-8',
  tc_hdl_ratio: '9830-1',
  ldl_hdl_ratio: '11054-4',
  apoa1: '1869-7',
  apob: '1884-6',
  lpa: '10835-7',
  glucose_fasting: '1558-6',
  glucose_pp: '1521-4',
  glucose_random: '2345-7',
  hba1c: '4548-4',
  eag: '27353-2',
  insulin: '20448-7',
  hs_crp: '30522-7',
  troponin_i: '10839-9',
  troponin_t: '6598-7',
  nt_probnp: '33762-6',
  homocysteine: '13965-9',
  crp: '1988-5',
  esr: '30341-2',
  alt: '1742-6',
  ast: '1920-8',
  ast_alt_ratio: '16325-3',
  alp: '6768-6',
  ggt: '2324-2',
  bilirubin_total: '1975-2',
  bilirubin_direct: '1968-7',
  bilirubin_indirect: '1971-1',
  albumin: '1751-7',
  globulin: '10834-0',
  total_protein: '2885-2',
  ag_ratio: '1759-0',
  creatinine: '2160-0',
  urea: '3091-6',
  bun: '3094-0',
  bun_creatinine_ratio: '3097-3',
  egfr: '62238-1',
  uric_acid: '3084-1',
  sodium: '2951-2',
  potassium: '2823-3',
  chloride: '2075-0',
  bicarbonate: '1963-8',
  calcium: '17861-6',
  magnesium: '19123-9',
  phosphorus: '2777-1',
  hemoglobin: '718-7',
  rbc: '789-8',
  hematocrit: '4544-3',
  mcv: '787-2',
  mch: '785-6',
  mchc: '786-4',
  rdw: '788-0',
  rdw_sd: '21000-5',
  wbc: '6690-2',
  neutrophils_pct: '770-8',
  lymphocytes_pct: '736-9',
  monocytes_pct: '5905-5',
  eosinophils_pct: '713-8',
  basophils_pct: '706-2',
  neutrophils_abs: '751-8',
  lymphocytes_abs: '731-0',
  monocytes_abs: '742-7',
  eosinophils_abs: '711-2',
  basophils_abs: '704-7',
  platelets: '777-3',
  mpv: '32623-1',
  iron: '2498-4',
  tibc: '2500-7',
  uibc: '2501-5',
  transferrin_sat: '2502-3',
  ferritin: '2276-4',
  vitamin_d: '62292-8',
  vitamin_b12: '2132-9',
  folate: '2284-8',
  tsh: '3016-3',
  t3: '3053-6',
  t4: '3026-2',
  ft3: '3051-0',
  ft4: '3024-7',
  testosterone: '2986-8',
  cortisol: '2143-6',
  urine_ph: '5803-2',
  urine_sg: '5811-5',
  urine_protein: '5804-0',
  urine_glucose: '5792-7',
  urine_ketones: '5797-6',
  urine_rbc: '13945-1',
  urine_pus_cells: '5821-4',
  urine_nitrite: '5802-4',
};

/** LOINC's mod-10 check digit for the part before the dash. */
export function loincCheckDigit(base: string): number {
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    let d = Number(base[base.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/** "2093-3" with a correct check digit. */
export function isLoincCode(code: string): boolean {
  const m = /^(\d{1,7})-(\d)$/.exec(code);
  return !!m && loincCheckDigit(m[1]) === Number(m[2]);
}
