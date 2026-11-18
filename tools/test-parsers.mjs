// Parser tests for the LotusPond Health data layer. Run: node tools/test-parsers.mjs
// Uses Node's built-in TypeScript type stripping (Node >= 22.18) to import src/lib/*.ts directly.
// Regenerate fixtures first with: python3 tools/make-fixtures.py
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const lib = p => new URL(`../src/lib/${p}`, import.meta.url).href;

const { matchMarkerName, BIOMARKERS, findMarker, SYSTEM_LABELS } = await import(lib('catalog.ts'));
const { parseRangeText, computeStatus, resolveRange, normalizeUnit, formatValue, refreshMeasurement, convertRange } = await import(lib('status.ts'));
const { detectReportDate, parseDate } = await import(lib('parse/dates.ts'));
const { parseCsvText } = await import(lib('parse/csv.ts'));
const { parseJsonText } = await import(lib('parse/json.ts'));
const { parseReportPages, buildLines, findRows } = await import(lib('parse/pdf-text.ts'));
const { decodeDicom, applyWindow, headerMeta, hasDicmMagic } = await import(lib('parse/dicom-core.ts'));
const { dicomOrgan, displayModality } = await import(lib('parse/dicom.ts')).catch(() => ({}));
const { guessOrgan, guessModality } = await import(lib('parse/organs.ts'));
const { parseValue } = await import(lib('parse/rows.ts'));
const { SAMPLE } = await import(lib('sample.ts'));
const store = await import(lib('store.ts'));
const { buildExport } = await import(lib('export.ts'));
const units = await import(lib('units.ts'));
const regions = await import(new URL('../shared/regions.ts', import.meta.url).href);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const section = t => console.log(`\n== ${t}`);

/* ---------------- catalog ---------------- */
section('catalog');
const ids = new Set();
for (const b of BIOMARKERS) {
  check(`unique id ${b.id}`, !ids.has(b.id)); ids.add(b.id);
  // Whole-body vitals (temperature, weight, body fat) belong to no single organ; everything else shows on the body map.
  check(`${b.id} has organs`, b.organs.length > 0 || b.system === 'vitals');
  check(`${b.id} has about`, b.about.length > 10);
  check(`${b.id} system label`, !!SYSTEM_LABELS[b.system]);
  check(`${b.id} aliases lower-case`, b.aliases.every(a => a === a.toLowerCase()));
}
console.log(`  ${BIOMARKERS.length} biomarkers`);
check('catalog size ~75+', BIOMARKERS.length >= 75, String(BIOMARKERS.length));

const NAME_CASES = [
  ['SGPT', 'alt'], ['ALT (SGPT)', 'alt'], ['S.G.P.T', 'alt'], ['Alanine Aminotransferase', 'alt'], ['SGOT (AST)', 'ast'],
  ['HDL Cholesterol', 'hdl'], ['HDL Cholesterol - Direct', 'hdl'], ['Non-HDL Cholesterol', 'non_hdl'], ['NON HDL CHOLESTEROL', 'non_hdl'],
  ['LDL Cholesterol (Calculated)', 'ldl'], ['Cholesterol, Total', 'total_cholesterol'], ['Total Cholesterol', 'total_cholesterol'],
  ['Chol/HDL Ratio', 'tc_hdl_ratio'], ['TC/HDL Cholesterol Ratio', 'tc_hdl_ratio'], ['LDL/HDL Ratio', 'ldl_hdl_ratio'], ['VLDL', 'vldl'],
  ['Triglycerides', 'triglycerides'], ['Haemoglobin (Hb)', 'hemoglobin'], ['Hemoglobin', 'hemoglobin'], ['Hb', 'hemoglobin'],
  ['Total Leucocyte Count (TLC)', 'wbc'], ['WBC Count', 'wbc'], ['RBC Count', 'rbc'], ['PCV', 'hematocrit'], ['Packed Cell Volume', 'hematocrit'],
  ['MCV', 'mcv'], ['MCH', 'mch'], ['MCHC', 'mchc'], ['RDW-CV', 'rdw'], ['RDW-SD', 'rdw_sd'], ['Neutrophils', 'neutrophils_pct'],
  ['Absolute Neutrophil Count', 'neutrophils_abs'], ['Lymphocytes Absolute', 'lymphocytes_abs'], ['Eosinophils', 'eosinophils_pct'],
  ['Absolute Eosinophil Count (AEC)', 'eosinophils_abs'], ['Platelet Count', 'platelets'], ['MPV', 'mpv'], ['ESR (Westergren)', 'esr'],
  ['Glucose Fasting (FBS)', 'glucose_fasting'], ['Fasting Blood Sugar', 'glucose_fasting'], ['Glucose - Post Prandial', 'glucose_pp'],
  ['Blood Sugar PP', 'glucose_pp'], ['HbA1c', 'hba1c'], ['Glycosylated Haemoglobin (HbA1c)', 'hba1c'], ['Estimated Average Glucose (eAG)', 'eag'],
  ['Bilirubin Total', 'bilirubin_total'], ['Bilirubin Direct', 'bilirubin_direct'], ['Bilirubin - Indirect', 'bilirubin_indirect'],
  ['Alkaline Phosphatase', 'alp'], ['GGT', 'ggt'], ['Gamma GT (GGTP)', 'ggt'], ['Total Protein', 'total_protein'], ['Albumin', 'albumin'],
  ['Globulin', 'globulin'], ['A/G Ratio', 'ag_ratio'], ['Serum Creatinine', 'creatinine'], ['Blood Urea', 'urea'], ['BUN', 'bun'],
  ['BUN/Creatinine Ratio', 'bun_creatinine_ratio'], ['eGFR', 'egfr'], ['Uric Acid', 'uric_acid'], ['Sodium (Na+)', 'sodium'],
  ['Potassium', 'potassium'], ['Chloride', 'chloride'], ['Calcium, Total', 'calcium'], ['Magnesium', 'magnesium'], ['Phosphorus', 'phosphorus'],
  ['Iron', 'iron'], ['Serum Iron', 'iron'], ['TIBC', 'tibc'], ['Transferrin Saturation', 'transferrin_sat'], ['Ferritin', 'ferritin'],
  ['TSH (Ultrasensitive)', 'tsh'], ['TSH 3rd Generation', 'tsh'], ['T3, Total', 't3'], ['T4, Total', 't4'], ['Free T3', 'ft3'], ['FT4', 'ft4'],
  ['25-OH Vitamin D (Total)', 'vitamin_d'], ['Vitamin D 25 Hydroxy', 'vitamin_d'], ['Vitamin B12', 'vitamin_b12'], ['Folic Acid', 'folate'],
  ['hs-CRP', 'hs_crp'], ['C-Reactive Protein (CRP)', 'crp'], ['NT-proBNP', 'nt_probnp'], ['Troponin I', 'troponin_i'], ['Homocysteine', 'homocysteine'],
  ['Lipoprotein (a)', 'lpa'], ['Apolipoprotein B', 'apob'], ['Apo A1', 'apoa1'], ['Insulin Fasting', 'insulin'], ['Testosterone Total', 'testosterone'],
  ['Cortisol (Morning)', 'cortisol'], ['Pus Cells', 'urine_pus_cells'], ['Specific Gravity', 'urine_sg'], ['Urine Glucose', 'urine_glucose'],
  ['Nitrite', 'urine_nitrite'], ['Ketone Bodies', 'urine_ketones'], ['Hemoglobin mg/dL', 'hemoglobin'],
];
const NEG_CASES = ['Patient Name', 'Reported On', 'Page 1 of 2', 'Method: Enzymatic', 'CA 125', 'Iron Deficiency Anemia note', 'HDL/LDL interpretation table', 'Free Testosterone', 'Ionized Calcium', 'Urine Creatinine', 'Microalbumin'];
let nameOk = 0;
for (const [raw, want] of NAME_CASES) {
  const got = matchMarkerName(raw)?.id ?? null;
  check(`matchMarkerName(${raw})`, got === want, `got ${got}, want ${want}`);
  if (got === want) nameOk++;
}
for (const raw of NEG_CASES) {
  const got = matchMarkerName(raw)?.id ?? null;
  check(`no false match for "${raw}"`, got === null || (raw === 'Iron Deficiency Anemia note' && got === null), `got ${got}`);
}
check('urine context: Glucose → urine_glucose', matchMarkerName('Glucose', { section: 'urine' })?.id === 'urine_glucose');
check('urine context: Protein → urine_protein', matchMarkerName('Protein', { section: 'urine' })?.id === 'urine_protein');
check('urine context: RBC → urine_rbc', matchMarkerName('RBC', { section: 'urine' })?.id === 'urine_rbc');
console.log(`  names: ${nameOk}/${NAME_CASES.length} positive cases`);

/* ---------------- ranges ---------------- */
section('LOINC');
{
  const { LOINC, isLoincCode } = await import(new URL('../shared/loinc.ts', import.meta.url).href);
  const codes = Object.entries(LOINC);
  check('LOINC: every code passes the mod-10 check digit', codes.every(([, c]) => isLoincCode(c)), codes.filter(([, c]) => !isLoincCode(c)).map(([k]) => k).join(', '));
  check('LOINC: codes are unique', new Set(codes.map(([, c]) => c)).size === codes.length);
  check('LOINC: every code names a catalogue marker', codes.every(([id]) => findMarker(id)?.loinc === LOINC[id]));
  check('LOINC: most markers are coded', codes.length >= BIOMARKERS.length - 5, `${codes.length} of ${BIOMARKERS.length}`);
  check('LOINC: a code finds its marker', findMarker('2093-3')?.id === 'total_cholesterol' && findMarker('4548-4')?.id === 'hba1c');
  check('LOINC: a wrong check digit is not a code', !isLoincCode('2093-4') && isLoincCode('718-7'));
  const csv = parseCsvText('LOINC,Test,Result,Unit\n4548-4,Glycated Hb,6.4,%\n', 'loinc.csv');
  check('LOINC: a CSV LOINC column matches the marker', csv.measurements[0]?.markerId === 'hba1c', JSON.stringify(csv.measurements[0]));
}

section('ranges');
const RANGE_CASES = [
  ['13.0 - 17.0', { low: 13, high: 17 }], ['13-17', { low: 13, high: 17 }], ['< 200', { high: 200 }], ['<=5.7', { high: 5.7 }],
  ['> 40', { low: 40 }], ['≥40', { low: 40 }], ['Upto 40', { high: 40 }], ['Up to 40', { high: 40 }], ['0.4 to 4.0', { low: 0.4, high: 4 }],
  ['Desirable: <200', { high: 200 }], ['4000 - 11000', { low: 4000, high: 11000 }], ['1.5 – 4.1', { low: 1.5, high: 4.1 }],
  ['Desirable: <200 Borderline: 200-239 High: >=240', { high: 200 }],
  ['Non-diabetic: < 5.7 Pre-diabetic: 5.7 - 6.4 Diabetic: >= 6.5', { high: 5.7 }],
  ['Deficiency: <20 Insufficiency: 20-30 Sufficiency: 30-100 Toxicity: >100', { low: 30, high: 100 }],
  ['Male: 13-17 Female: 12-15', { low: 12, high: 17 }], ['Low: <40 High: >=60', { low: 40, high: 60 }],
  ['Optimal: <100 Near optimal: 100-129 Borderline high: 130-159', { high: 100 }],
  ['Low risk: <1.0 Average risk: 1.0-3.0 High risk: >3.0', { high: 3 }],
  ['3.5 - 5.0', { low: 3.5, high: 5 }], ['<1 Low risk; 1 - 3 Average risk; > 3 High risk', { high: 3 }], ['1,50,000 - 4,10,000', { low: 150000, high: 410000 }], ['> 60 mL/min/1.73m2', { low: 60 }],
  ['Less than 150', { high: 150 }], ['0.0 - 0.3', { low: 0, high: 0.3 }],
];
let rangeOk = 0;
for (const [text, want] of RANGE_CASES) {
  const r = parseRangeText(text);
  const got = r ? { ...(r.low != null ? { low: r.low } : {}), ...(r.high != null ? { high: r.high } : {}) } : null;
  const ok = eq(got, want);
  check(`parseRangeText(${text})`, ok, `got ${JSON.stringify(got)}`);
  if (ok) rangeOk++;
}
check('parseRangeText(Negative) → null', parseRangeText('Negative') === null);
check('parseRangeText("") → null', parseRangeText('') === null);
console.log(`  ranges: ${rangeOk}/${RANGE_CASES.length}`);

check('status high', computeStatus(250, { high: 200, source: 'report' }) === 'high');
check('status low', computeStatus(30, { low: 40, source: 'report' }) === 'low');
check('status inclusive bounds', computeStatus(40, { low: 40, high: 60, source: 'report' }) === 'normal');
check('status no range', computeStatus(5, null) === 'unknown');
check('status Negative → normal', computeStatus(null, { text: 'Negative', source: 'report' }, 'Negative') === 'normal');
check('status Positive with neg ref → high', computeStatus(null, { text: 'Negative', source: 'report' }, 'Positive') === 'high');
const ldl = findMarker('ldl');
check('resolveRange report wins', resolveRange(ldl, { high: 130, source: 'report', text: '<130' })?.high === 130);
check('resolveRange typical fallback', resolveRange(ldl, null)?.source === 'typical' && resolveRange(ldl, null)?.high === 100);
const glu = normalizeUnit(findMarker('glucose_fasting'), 5.5, 'mmol/L');
check('normalizeUnit glucose mmol/L → mg/dL', Math.abs(glu.value - 99) < 0.5 && glu.unit === 'mg/dL', JSON.stringify(glu.value));
const chol = normalizeUnit(findMarker('total_cholesterol'), 5.2, 'mmol/l');
check('normalizeUnit cholesterol mmol/L', Math.abs(chol.value - 201) < 1, String(chol.value));
check('normalizeUnit gm% alias', normalizeUnit(findMarker('hemoglobin'), 13, 'gm%').matched);
check('normalizeUnit thousand/cumm alias', normalizeUnit(findMarker('wbc'), 7.8, 'thousand/cumm').matched);
check('normalizeUnit mIU/L ≡ µIU/mL', normalizeUnit(findMarker('tsh'), 2, 'mIU/L').matched);
check('normalizeUnit lakhs/cumm platelets', normalizeUnit(findMarker('platelets'), 2.45, 'lakhs/cumm').value === 245);
check('normalizeUnit cells/cumm WBC', normalizeUnit(findMarker('wbc'), 7800, 'cells/cumm').value === 7.8);
check('normalizeUnit HbA1c mmol/mol', Math.abs(normalizeUnit(findMarker('hba1c'), 48, 'mmol/mol').value - 6.54) < 0.05);
check('formatValue keeps <', formatValue({ value: 0.5, valueText: '<0.5', unit: 'mg/L' }) === '<0.5 mg/L', formatValue({ value: 0.5, valueText: '<0.5', unit: 'mg/L' }));
check('formatValue qualitative', formatValue({ value: null, valueText: 'Negative', unit: '' }) === 'Negative');
check('formatValue converted', formatValue({ value: 99.088, valueText: '5.5', unit: 'mg/dL' }) === '99.1 mg/dL', formatValue({ value: 99.088, valueText: '5.5', unit: 'mg/dL' }));
check('parseValue 1,234', parseValue('1,234').value === 1234);
check('parseValue 13.5 H', parseValue('13.5 H').value === 13.5 && parseValue('13.5 H').flag === 'high');
check('parseValue <0.5', parseValue('<0.5').value === 0.5 && parseValue('<0.5').text === '<0.5');
check('parseValue 2.5 lakhs', parseValue('2.5 lakhs').value === 250000);
check('parseValue Negative', parseValue('Negative').value === null);
check('parseValue 2-4 → 4', parseValue('2-4').value === 4);

/* ---------------- dates ---------------- */
section('dates');
const DATE_CASES = [
  ['Collected On: 28/Oct/2026', '2026-10-28'], ['28-10-2026', '2026-10-28'], ['2026-10-28', '2026-10-28'], ['16 Jul 2026', '2026-07-16'],
  ['Jul 16, 2026', '2026-07-16'], ['10/28/2026', '2026-10-28'], ['05/06/2026', '2026-06-05'], ['28.10.2026', '2026-10-28'],
  ['Reported On: 30/10/2026\nSample Collected: 28/10/2026 08:10', '2026-10-28'],
  ['Date of Birth: 12/03/1992  Collection Date: 2026-07-02', '2026-07-02'],
  ['Printed: 01-Nov-2026  Drawn: 29-Oct-2026', '2026-10-29'],
  ['Patient: X  DOB 01/01/1990 Report date 03/04/2026', '2026-04-03'],
  ['Registered on 16th July 2026', '2026-07-16'],
];
let dateOk = 0;
for (const [text, want] of DATE_CASES) {
  const got = detectReportDate(text);
  check(`detectReportDate(${JSON.stringify(text)})`, got === want, `got ${got}`);
  if (got === want) dateOk++;
}
check('US option', detectReportDate('05/06/2026', { us: true }) === '2026-05-06');
check('invalid date rejected', parseDate('31/02/2026') === null);
check('parseDate compact 20261028', parseDate('20261028') === '2026-10-28');
console.log(`  dates: ${dateOk}/${DATE_CASES.length}`);

/* ---------------- CSV ---------------- */
section('CSV');
const CSV = `Lotus Diagnostics,,,,
Patient,Asha Demo,,,
Investigation,Result,Units,Biological Reference Interval,Date
Haemoglobin,12.1,g/dL,13.0 - 17.0,28/10/2026
Total Leucocyte Count,"7,800",cells/cumm,4000 - 11000,28/10/2026
SGPT (ALT),48,U/L,Upto 40,28/10/2026
Glucose Fasting,5.4,mmol/L,3.9 - 5.6,28/10/2026
HDL Cholesterol,38,mg/dL,> 40,2026-07-02
HDL Cholesterol,44,mg/dL,> 40,2026-10-28
Non-HDL Cholesterol,176,mg/dL,< 130,2026-10-28
Mystery Marker X,3.3,U/L,1-5,2026-10-28
URINE ROUTINE,,,,
Glucose,Negative,,Negative,2026-10-28
Pus Cells,2-4,/hpf,0 - 5,2026-10-28
`;
const csv = parseCsvText(CSV, 'report.csv');
const byId = (r, id, date) => r.measurements.find(m => m.markerId === id && (!date || m.date === date));
check('CSV row count', csv.measurements.length === 10, String(csv.measurements.length));
check('CSV Hb low', byId(csv, 'hemoglobin')?.status === 'low');
check('CSV TLC converted to 10^3/µL', byId(csv, 'wbc')?.value === 7.8 && byId(csv, 'wbc')?.range?.low === 4, JSON.stringify(byId(csv, 'wbc')));
check('CSV ALT high', byId(csv, 'alt')?.status === 'high');
check('CSV glucose mmol→mg/dL', Math.abs((byId(csv, 'glucose_fasting')?.value ?? 0) - 97.3) < 0.5 && byId(csv, 'glucose_fasting')?.status === 'normal', JSON.stringify(byId(csv, 'glucose_fasting')));
check('CSV two HDL dates', byId(csv, 'hdl', '2026-07-02')?.status === 'low' && byId(csv, 'hdl', '2026-10-28')?.status === 'normal');
check('CSV non-HDL not HDL', byId(csv, 'non_hdl')?.value === 176);
check('CSV unmatched kept', csv.measurements.some(m => m.markerId === null && m.rawName === 'Mystery Marker X' && m.confidence === 'low'));
check('CSV urine section glucose', byId(csv, 'urine_glucose')?.status === 'normal', JSON.stringify(byId(csv, 'urine_glucose')));
check('CSV pus cells 2-4', byId(csv, 'urine_pus_cells')?.value === 4 && byId(csv, 'urine_pus_cells')?.valueText === '2-4');
check('CSV high confidence', byId(csv, 'alt')?.confidence === 'high');
const TSV = 'Test\tValue\tUnit\tLow\tHigh\nTSH\t5.2\tmIU/L\t0.4\t4.5\nVitamin D\t18\tng/mL\t30\t100\n';
const tsv = parseCsvText(TSV, 'r.tsv');
check('TSV low/high columns', byId(tsv, 'tsh')?.status === 'high' && byId(tsv, 'vitamin_d')?.status === 'low', JSON.stringify(tsv.measurements.map(m => [m.markerId, m.status])));
check('TSV no date warning', tsv.warnings.some(w => /date/i.test(w)));

/* ---------------- JSON ---------------- */
section('JSON');
const j1 = parseJsonText(JSON.stringify([{ test: 'LDL Cholesterol', result: '142', unit: 'mg/dL', reference: '<100', date: '2026-10-28' }, { test: 'TSH', result: 2.1, unit: 'µIU/mL' }]), 'a.json');
check('JSON rows', j1.measurements.length === 2 && byId(j1, 'ldl')?.status === 'high', JSON.stringify(j1.measurements.map(m => m.markerId)));
check('JSON typical range fallback', byId(j1, 'tsh')?.range?.source === 'typical' && byId(j1, 'tsh')?.status === 'normal');
const j2 = parseJsonText(JSON.stringify({ date: '16 Jul 2026', results: [{ name: 'Ferritin', value: '12', units: 'ng/mL', range: '15 - 150' }] }), 'b.json');
check('JSON {date, results}', byId(j2, 'ferritin')?.date === '2026-07-16' && byId(j2, 'ferritin')?.status === 'low');
const exported = buildExport({ measurements: SAMPLE.measurements, scans: [] });
const j3 = parseJsonText(JSON.stringify(exported), 'export.json');
check('JSON own export round trip', j3.measurements.length === SAMPLE.measurements.length, `${j3.measurements.length} vs ${SAMPLE.measurements.length}`);
check('JSON export statuses preserved', j3.measurements.every((m, i) => m.status === SAMPLE.measurements[i].status));
check('JSON invalid warns', parseJsonText('{oops', 'x.json').warnings.length === 1);

/* ---------------- sample + store ---------------- */
section('sample + store');
const sm = SAMPLE.measurements;
const systems = new Set(sm.map(m => findMarker(m.markerId)?.system));
check('sample ~45 rows', sm.length >= 40 && sm.length <= 50, String(sm.length));
check('sample covers all systems', Object.keys(SYSTEM_LABELS).every(s => systems.has(s)), [...systems].join(','));
check('sample 3 dates', eq(store.dates(sm), ['2026-03-14', '2026-07-02', '2026-10-20']));
check('sample has out-of-range rows', sm.filter(m => m.status !== 'normal').length >= 5);
check('sample all matched', sm.every(m => m.markerId && m.status !== 'unknown'), sm.filter(m => m.status === 'unknown').map(m => m.markerId).join(','));
const latest = store.latestByMarker(sm);
check('latestByMarker picks newest', latest.ldl.date === '2026-10-20' && latest.ldl.value === 112);
const sum = store.organSummary(sm);
check('organSummary heart has LDL high', sum.heart.high >= 1 && sum.heart.total >= 4, JSON.stringify(sum.heart));
const liverRows = store.measurementsForOrgan({ measurements: sm }, 'liver');
check('measurementsForOrgan liver history', liverRows.find(s => s.key === 'alt')?.history.length === 3);
const s = store.useHealth.getState();
await s.loadSample();
check('store loadSample', store.useHealth.getState().measurements.length === sm.length);
await store.useHealth.getState().loadSample();
check('store dedupes on re-add', store.useHealth.getState().measurements.length === sm.length);
const tshRow = store.useHealth.getState().measurements.find(m => m.markerId === 'tsh' && m.date === '2026-10-20');
store.useHealth.getState().updateMeasurement(tshRow.id, { value: 6.1, valueText: '6.1' });
check('updateMeasurement recomputes status', store.useHealth.getState().measurements.find(m => m.id === tshRow.id).status === 'high');
store.useHealth.getState().updateMeasurement(tshRow.id, { markerId: 'ft4', unit: 'ng/dL', range: null });
check('updateMeasurement marker change → typical range', store.useHealth.getState().measurements.find(m => m.id === tshRow.id).range?.source === 'typical');
store.useHealth.getState().updateMeasurement(tshRow.id, { markerId: 'glucose_fasting', unit: 'mmol/L', value: 5.5, valueText: '5.5', range: null });
const conv = store.useHealth.getState().measurements.find(m => m.id === tshRow.id);
check('updateMeasurement converts alt unit', conv.unit === 'mg/dL' && Math.abs(conv.value - 99.1) < 0.2 && conv.status === 'normal', JSON.stringify(conv));
store.useHealth.getState().removeMeasurement(tshRow.id);
check('removeMeasurement', store.useHealth.getState().measurements.length === sm.length - 1);
store.useHealth.getState().selectOrgan('liver');
check('selectOrgan', store.useHealth.getState().selectedOrgan === 'liver');
store.useHealth.getState().removeDocument('missing-doc');
check('removeDocument of unknown id keeps results', store.useHealth.getState().measurements.length === sm.length - 1);
await store.useHealth.getState().clearAll();
check('clearAll', store.useHealth.getState().measurements.length === 0 && store.useHealth.getState().selectedOrgan === null);
await store.useHealth.getState().loadSample();
await store.useHealth.getState().openProfile(null);
check('openProfile(null) clears records', store.useHealth.getState().measurements.length === 0 && store.useHealth.getState().profileId === null);
check('refreshMeasurement export', typeof refreshMeasurement === 'function');

/* ---------------- display units and country policy ---------------- */
section('display units');
{
  const glu = { markerId: 'glucose_fasting', rawName: 'Glucose', value: 99, valueText: '99', unit: 'mg/dL', range: { low: 70, high: 100, text: '70 - 100', source: 'report' }, status: 'normal', date: null, sourceFile: 'x', confidence: 'high' };
  const si = units.displayMeasurement(glu, 'si');
  check('glucose 99 mg/dL → 5.5 mmol/L', si.unit === 'mmol/L' && si.value === 5.5 && si.converted, JSON.stringify(si));
  check('glucose range converted', si.range.low === 3.89 && si.range.high === 5.55 && si.range.text === '3.89 – 5.55', JSON.stringify(si.range));
  check('conventional leaves values alone', units.displayMeasurement(glu, 'conventional').text === '99');
  const crea = units.displayMeasurement({ ...glu, markerId: 'creatinine', value: 0.82, valueText: '0.82', range: { low: 0.6, high: 1.1, source: 'report' } }, 'si');
  check('creatinine 0.82 mg/dL → 72.5 µmol/L', crea.unit === 'µmol/L' && Math.abs(crea.value - 72.5) < 0.6, JSON.stringify(crea));
  const hb = units.displayMeasurement({ ...glu, markerId: 'hemoglobin', value: 12.9, valueText: '12.9', unit: 'g/dL', range: null }, 'si');
  check('hemoglobin 12.9 g/dL → 129 g/L', hb.unit === 'g/L' && hb.value === 129, JSON.stringify(hb));
  const lt = units.displayMeasurement({ ...glu, markerId: 'ldl', value: 100, valueText: '<100', unit: 'mg/dL' }, 'si');
  check('keeps < prefix', lt.text === '<2.59', lt.text);
  check('tsh has no SI conversion', units.siConversion('tsh') === null);
  check('qualitative untouched', units.displayMeasurement({ ...glu, markerId: 'urine_protein', value: null, valueText: 'Negative', unit: '' }, 'si').text === 'Negative');
  check('every SI unit exists in the catalog', Object.keys(units).length > 0 && ['total_cholesterol','triglycerides','creatinine','vitamin_d','ft4','cortisol','hematocrit'].every(id => units.siConversion(id)));
  check('round 3 s.f.', units.roundForDisplay(4.891) === 4.89 && units.roundForDisplay(0.0566) === 0.06 && units.roundForDisplay(129.4) === 129 && units.roundForDisplay(72.46) === 72.5);
}
section('country policy');
{
  check('249 ISO codes, no duplicates', regions.COUNTRY_CODES.length === 249 && new Set(regions.COUNTRY_CODES).size === 249);
  const inp = regions.countryPolicy('in');
  check('India: own cell, partners, grievance officer, adults only', inp.region === 'in' && inp.partnerLabs && inp.grievanceOfficer && inp.minAge === 18 && !inp.crossBorder);
  check('Germany: EU cell, GDPR', regions.countryPolicy('DE').region === 'eu' && regions.countryPolicy('DE').laws[0].includes('GDPR'));
  check('UK: stored in EU, cross-border, SI units', regions.countryPolicy('GB').region === 'eu' && regions.countryPolicy('GB').crossBorder && regions.countryPolicy('GB').units === 'si');
  check('US: US cell, imperial', regions.countryPolicy('US').region === 'us' && regions.countryPolicy('US').measurement === 'us');
  check('UAE not available (in-country health data)', !regions.countryPolicy('AE').available && /UAE/.test(regions.countryPolicy('AE').unavailableReason));
  check('Australia: international cell, own law', regions.countryPolicy('AU').region === 'global' && regions.countryPolicy('AU').laws[0].includes('Privacy Act 1988'));
  check('every country has a region and a law', regions.COUNTRY_CODES.every(c => { const p = regions.countryPolicy(c); return p.region && p.laws.length > 0; }));
  check('isCountryCode', regions.isCountryCode('in') && !regions.isCountryCode('ZZ'));
  check('India first: only India is open', regions.OPEN_COUNTRIES.length === 1 && regions.OPEN_COUNTRIES[0] === 'IN' && regions.countryPolicy('IN').available);
  const de = regions.countryPolicy('DE');
  check('not open yet: keeps its region and laws, says India first', !de.available && de.region === 'eu' && de.unavailableReason === regions.NOT_OPEN_YET);
  check('opening a country makes it available', regions.countryPolicy('DE', ['IN', 'DE']).available);
  check('a legal restriction outranks opening', !regions.countryPolicy('AE', ['AE']).available && /UAE/.test(regions.countryPolicy('AE', ['AE']).unavailableReason));
  const choices = country => ({ country, ageConfirmed: true, consents: { termsAndPrivacy: true, healthData: true, crossBorder: true, marketing: false } });
  const all = ['in', 'eu', 'us', 'global'];
  check('sign-up outside India is refused as not open yet', regions.signUpProblem(choices('FR'), all)?.code === 'country_unavailable' && regions.signUpProblem(choices('FR'), all)?.message === regions.NOT_OPEN_YET);
  check('sign-up in India passes', regions.signUpProblem(choices('IN'), all) === null);
  check('a server that opens France accepts it', regions.signUpProblem(choices('FR'), all, ['IN', 'FR']) === null);
}

/* ---------------- PDF ---------------- */
section('PDF');
const pdfPath = join(fixtures, 'sample-lab-report.pdf');
if (!existsSync(pdfPath)) execFileSync('python3', [join(here, 'make-fixtures.py')], { stdio: 'inherit' });
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

async function pagesOf(path) {
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    pages.push({
      items: tc.items.filter(i => 'str' in i).map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], width: i.width, height: i.height || Math.hypot(i.transform[2], i.transform[3]) })),
    });
  }
  await task.destroy();
  return pages;
}

const pages = await pagesOf(pdfPath);
const lines0 = buildLines(pages[0].items, 0);
check('PDF lines rebuilt', lines0.length > 15, String(lines0.length));
const pdf = parseReportPages(pages, 'sample-lab-report.pdf');
const EXPECT = {
  hemoglobin: [12.1, 'low'], wbc: [7.8, 'normal'], rbc: [4.62, 'normal'], hematocrit: [39.8, 'low'], mcv: [86.1, 'normal'], mch: [26.2, 'low'],
  mchc: [30.4, 'low'], neutrophils_pct: [62, 'normal'], lymphocytes_pct: [30, 'normal'], platelets: [245, 'normal'],
  total_cholesterol: [214, 'high'], triglycerides: [168, 'high'], hdl: [38, 'low'], ldl: [142, 'high'], vldl: [34, 'high'], non_hdl: [176, 'high'],
  tc_hdl_ratio: [5.6, 'high'], bilirubin_total: [0.82, 'normal'], bilirubin_direct: [0.21, 'normal'], ast: [32, 'normal'], alt: [48, 'high'],
  alp: [88, 'normal'], albumin: [4.3, 'normal'], t3: [112, 'normal'], t4: [8.4, 'normal'], tsh: [4.82, 'high'],
};
let pdfOk = 0;
for (const [id, [value, status]] of Object.entries(EXPECT)) {
  const m = byId(pdf, id);
  const ok = !!m && Math.abs(m.value - value) < 1e-6 && m.status === status && m.date === '2026-10-28';
  check(`PDF ${id}`, ok, m ? `value ${m.value} ${m.unit} status ${m.status} date ${m.date} range ${JSON.stringify(m.range)}` : 'missing');
  if (ok) pdfOk++;
}
const extra = pdf.measurements.filter(m => !(m.markerId in EXPECT));
check('PDF no spurious rows', extra.length === 0, extra.map(m => `${m.markerId}:${m.rawName}=${m.valueText}`).join('; '));
check('PDF detected date (collected, not reported/DOB)', pdf.detectedDate === '2026-10-28', String(pdf.detectedDate));
const highConf = pdf.measurements.filter(m => m.confidence === 'high').length;
console.log(`  PDF: ${pdfOk}/${Object.keys(EXPECT).length} expected rows correct, ${pdf.measurements.length} rows total, ${highConf} high-confidence, ${extra.length} spurious`);
for (const m of pdf.measurements) console.log(`    ${m.markerId?.padEnd(18)} ${String(m.valueText).padEnd(7)} ${m.unit.padEnd(9)} ${String(m.range?.text ?? '').padEnd(14)} ${m.status.padEnd(7)} ${m.confidence}`);

// Regression checks for column bleed (MCHC range swallowing the lipid column), units absorbing numbers
// (platelets "lakhs/cumm 1.5"), and lost low bounds (WBC "4000 - 11000").
const rowOf = id => byId(pdf, id);
{
  const k = v => v / 1000, mmol = v => Math.round(v / 18 * 10) / 10; // normalizeUnit's converters round like this
  check('converted range text keeps its printed style', convertRange({ low: 4000, high: 11000, text: '4,000 - 11,000', source: 'report' }, k)?.text === '4 - 11');
  check('converted "<" range keeps its sign', convertRange({ high: 200, text: '<200', source: 'report' }, mmol)?.text === '<11.1');
  check('converted range with extra numbers in its text is written afresh', convertRange({ high: 11000, text: 'Adult (18+): up to 11000', source: 'report' }, k)?.text === '< 11');
}
check('PDF MCHC range stops at its own column', rowOf('mchc')?.range?.text === '31.5 - 34.5', rowOf('mchc')?.range?.text);
check('PDF platelets unit + range', rowOf('platelets')?.unit === '10^3/µL' && rowOf('platelets')?.range?.low === 150 && rowOf('platelets')?.range?.high === 410 && rowOf('platelets')?.range?.text === '150 - 410', JSON.stringify(rowOf('platelets')));
check('PDF WBC range keeps low bound, shown in the converted unit', rowOf('wbc')?.range?.low === 4 && rowOf('wbc')?.range?.high === 11 && rowOf('wbc')?.range?.text === '4 - 11', JSON.stringify(rowOf('wbc')?.range));
check('PDF units never contain digits-only tokens', pdf.measurements.every(m => !/\s\d/.test(m.unit)), pdf.measurements.map(m => m.unit).join(','));
// Same failure modes with merged cells (one text item for "unit + range", side-by-side tables in one cell).
{
  const mk = (y, cells) => ({ page: 0, y, height: 8, cells: cells.map(([t, x]) => ({ text: t, x0: x, x1: x + t.length * 4 })), text: cells.map(c => c[0]).join('  ') });
  const lines = [
    mk(700, [['Test Name', 40], ['Result', 150], ['Unit', 190], ['Bio. Ref. Interval', 230]]),
    mk(686, [['MCHC 30.4 L g/dL 31.5 - 34.5 Chol/HDL Ratio 5.6 H 3.5 - 5.0', 40]]),
    mk(672, [['Platelet Count', 40], ['2.45', 150], ['lakhs/cumm 1.5 - 4.1', 190]]),
    mk(658, [['Total Leucocyte Count (TLC)', 40], ['7,800', 150], ['cells/cumm 4000 - 11000', 190]]),
  ];
  const merged = parseReportPages([{ items: [] }], 'x');
  const rows = findRows(lines);
  const r = id => rows.find(x => x.match.def.id === id);
  check('merged: MCHC range', r('mchc')?.rangeText === '31.5 - 34.5', r('mchc')?.rangeText);
  check('merged: second table row found', r('tc_hdl_ratio')?.valueText === '5.6' && r('tc_hdl_ratio')?.rangeText === '3.5 - 5.0', JSON.stringify(r('tc_hdl_ratio')?.rangeText));
  check('merged: platelets unit/range', r('platelets')?.unit === 'lakhs/cumm' && r('platelets')?.rangeText === '1.5 - 4.1', `${r('platelets')?.unit} | ${r('platelets')?.rangeText}`);
  check('merged: WBC unit/range', r('wbc')?.unit === 'cells/cumm' && r('wbc')?.rangeText === '4000 - 11000', `${r('wbc')?.unit} | ${r('wbc')?.rangeText}`);
  check('empty page warns', merged.warnings.length === 1);
  const more = findRows([
    mk(640, [['Vitamin D 25 Hydroxy', 40], ['18.4', 150], ['ng/mL', 190], ['30 - 100', 230]]),
    mk(626, [['Hemoglobin', 40], ['L', 140], ['12.1', 150], ['g/dL', 190], ['13.0 - 17.0', 230]]),
    mk(612, [['Iron', 40], ['62', 150], ['Photometry', 170], ['µg/dL', 190], ['65 - 175', 230]]),
    mk(598, [['Glucose, Fasting (Plasma)', 40], ['98', 150], ['mg/dL', 190], ['70-100', 230]]),
    mk(584, [['Note: LDL above 160 mg/dL is considered high', 40]]),
    mk(570, [['Desirable: < 200 mg/dL', 230]]),
  ]);
  const m2 = id => more.find(x => x.match.def.id === id);
  check('name containing a number', m2('vitamin_d')?.valueText === '18.4', m2('vitamin_d')?.valueText);
  check('flag before value', m2('hemoglobin')?.valueText === '12.1' && m2('hemoglobin')?.flag === 'L' && m2('hemoglobin')?.name === 'Hemoglobin');
  check('method after value', m2('iron')?.valueText === '62' && m2('iron')?.unit === 'µg/dL' && m2('iron')?.rangeText === '65 - 175', `${m2('iron')?.unit} | ${m2('iron')?.rangeText}`);
  check('plasma suffix', m2('glucose_fasting')?.valueText === '98');
  check('note lines skipped', more.length === 4, more.map(r => r.match.def.id).join(','));
  // A method column after the range (Apollo's Lp(a) and thyroid rows): not part of the range.
  const tail = findRows([
    mk(540, [['LIPOPROTEIN a (Lp-a) , SERUM', 40], ['5.29', 150], ['mg/dL', 190], ['<75', 230], ['Immunoturbidimetric', 280]]),
    mk(526, [['TSH', 40], ['3.413', 150], ['µIU/mL', 190], ['0.35-4.75', 230], ['CLIA', 280]]),
  ]);
  const t2 = id => tail.find(x => x.match.def.id === id);
  check('method after range: Lp(a)', t2('lpa')?.rangeText === '<75', t2('lpa')?.rangeText);
  check('method after range: TSH', t2('tsh')?.rangeText === '0.35-4.75', t2('tsh')?.rangeText);
}

// Second layout: method column, per-word text items, separate flag column, multi-line ranges, urine section.
const hard = parseReportPages(await pagesOf(join(fixtures, 'lab-report-method-column.pdf')), 'lab-report-method-column.pdf');
const EXPECT2 = {
  vitamin_d: [18.4, 'low'], vitamin_b12: [182, 'low'], hba1c: [6.1, 'high'], eag: [128, 'high'], glucose_fasting: [104, 'high'],
  iron: [62, 'low'], tibc: [402, 'normal'], transferrin_sat: [15.4, 'normal'], ferritin: [21.3, 'low'], creatinine: [0.94, 'normal'],
  uric_acid: [7.6, 'high'], egfr: [98, 'normal'], sodium: [139, 'normal'], hs_crp: [3.8, 'high'], urine_ph: [6, 'normal'], urine_sg: [1.02, 'normal'],
  urine_protein: [null, 'normal'], urine_glucose: [null, 'normal'], urine_ketones: [null, 'normal'], urine_pus_cells: [6, 'high'],
  urine_rbc: [null, 'normal'], urine_nitrite: [null, 'normal'],
};
let hardOk = 0;
for (const [id, [value, status]] of Object.entries(EXPECT2)) {
  const m = byId(hard, id);
  const ok = !!m && (value == null ? m.value == null : Math.abs(m.value - value) < 1e-6) && m.status === status && m.date === '2026-07-16' && m.confidence === 'high';
  check(`PDF2 ${id}`, ok, m ? `${m.rawName} = ${m.valueText} ${m.unit} [${m.range?.text}] ${m.status} ${m.confidence} ${m.date}` : 'missing');
  if (ok) hardOk++;
}
const extra2 = hard.measurements.filter(m => !(m.markerId in EXPECT2));
check('PDF2 no spurious rows', extra2.length === 0, extra2.map(m => `${m.markerId}:${m.rawName}=${m.valueText}`).join('; '));
check('PDF2 method column stripped from names', hard.measurements.every(m => !/PHOTOMETRY|C\.L\.I\.A|CALCULATED|DIPSTICK|MICROSCOPY/.test(m.rawName)), hard.measurements.map(m => m.rawName).join(' | '));
check('PDF2 multi-line vitamin D range', byId(hard, 'vitamin_d')?.range?.low === 30 && byId(hard, 'vitamin_d')?.range?.high === 100);
check('PDF2 hs-CRP trailing labels → ≤3', byId(hard, 'hs_crp')?.range?.high === 3 && byId(hard, 'hs_crp')?.range?.low == null, JSON.stringify(byId(hard, 'hs_crp')?.range));
check('PDF2 urine protein keeps printed NEGATIVE range', byId(hard, 'urine_protein')?.range?.text === 'NEGATIVE' && byId(hard, 'urine_protein')?.unit === '');
console.log(`  PDF2: ${hardOk}/${Object.keys(EXPECT2).length} expected rows correct, ${hard.measurements.length} rows total`);

const scanned = parseReportPages(await pagesOf(join(fixtures, 'scanned-report-no-text.pdf')), 'scanned.pdf');
check('PDF without text warns', scanned.measurements.length === 0 && scanned.warnings.some(w => /scanned|image/i.test(w)));

/* ---------------- DICOM ---------------- */
section('DICOM');
const dcm = readFileSync(join(fixtures, 'chest-xray-synthetic.dcm'));
const dcmBytes = new Uint8Array(dcm.buffer, dcm.byteOffset, dcm.byteLength);
check('DICM magic', hasDicmMagic(dcmBytes));
const d = decodeDicom(dcmBytes);
check('DICOM header modality/body/date', d.header.modality === 'CR' && d.header.bodyPart === 'CHEST' && d.header.studyDate === '2026-10-28', JSON.stringify(d.header));
check('DICOM dims/bits', d.header.rows === 64 && d.header.columns === 80 && d.header.bitsAllocated === 16 && d.header.photometric === 'MONOCHROME2');
check('DICOM uncompressed + pixels', !d.header.compressed && d.values?.length === 64 * 80, `compressed=${d.header.compressed}`);
check('DICOM value range', d.min === 0 && d.max === 4000, `${d.min}..${d.max}`);
const w = applyWindow(d);
check('DICOM window from file', w.center === 2048 && w.window === 4096);
check('DICOM rgba size', w.rgba.length === 64 * 80 * 4);
const centre = (32 * 80 + 40) * 4, leftEdge = (2 * 80 + 0) * 4;
check('DICOM disc bright / left edge dark', w.rgba[centre] > 240 && w.rgba[leftEdge] < 10, `${w.rgba[centre]} / ${w.rgba[leftEdge]}`);
const narrow = applyWindow(d, 1000, 200);
check('DICOM custom window saturates', narrow.rgba[centre] === 255 && narrow.center === 1000);
check('DICOM meta has no patient name', !Object.values(headerMeta(d.header)).some(v => /ASHA|DEMO/.test(v)));
if (dicomOrgan) check('DICOM organ CHEST → lungs', dicomOrgan(d.header, 'x.dcm') === 'lungs');
if (displayModality) check('DICOM CR → XR', displayModality('CR') === 'XR');
const ct = decodeDicom(new Uint8Array(readFileSync(join(fixtures, 'ct-abdomen-synthetic.dcm'))));
check('DICOM signed CT + rescale', ct.header.pixelRepresentation === 1 && ct.min === -2048 && ct.max === 1952, `${ct.min}..${ct.max}`);
if (dicomOrgan) check('DICOM organ ABDOMEN → liver', dicomOrgan(ct.header, 'y.dcm') === 'liver');
const mrj = decodeDicom(new Uint8Array(readFileSync(join(fixtures, 'mri-brain-jpeg-synthetic.dcm'))));
check('DICOM JPEG baseline detected as compressed', mrj.header.compressed && mrj.compressedFrame?.[0] === 0xff && mrj.compressedFrame?.[1] === 0xd8 && mrj.values === null);
if (dicomOrgan) check('DICOM HEAD/MRI BRAIN → brain', dicomOrgan(mrj.header, 'z.dcm') === 'brain');
check('DICOM JPEG applyWindow → null', applyWindow(mrj) === null);
const ctw = applyWindow(ct);
check('DICOM CT soft-tissue window', ctw.center === 40 && ctw.window === 400);

/* ---------------- tabular fixtures ---------------- */
section('tabular fixtures');
const fcsv = parseCsvText(readFileSync(join(fixtures, 'results-export.csv'), 'utf8'), 'results-export.csv');
check('fixture CSV 21 rows / 3 dates', fcsv.measurements.length === 21 && store.dates(fcsv.measurements).length === 3, `${fcsv.measurements.length}`);
const fjson = parseJsonText(readFileSync(join(fixtures, 'results-export.json'), 'utf8'), 'results-export.json');
check('fixture JSON platelets lakhs → 260', byId(fjson, 'platelets')?.value === 260 && byId(fjson, 'platelets')?.status === 'normal');
check('fixture JSON glucose mmol → mg/dL', Math.abs((byId(fjson, 'glucose_fasting')?.value ?? 0) - 91.9) < 0.2);

/* ---------------- image hints ---------------- */
section('image hints');
const ORGAN_HINTS = [['chest_xray_2026.jpg', 'lungs'], ['CXR-PA.png', 'lungs'], ['echo report.jpg', 'heart'], ['ECG.png', 'heart'], ['usg_abdomen.jpg', 'liver'],
  ['KUB-ultrasound.png', 'kidneys'], ['MRI Brain.jpg', 'brain'], ['thyroid-usg.jpg', 'thyroid'], ['knee xray.jpeg', 'marrow'], ['DEXA_scan.png', 'marrow'],
  ['IMG_2041.jpg', null], ['lumbarSpine.png', 'marrow']];
for (const [f, want] of ORGAN_HINTS) check(`guessOrgan(${f})`, guessOrgan(f) === want, String(guessOrgan(f)));
const MOD_HINTS = [['chest_xray.jpg', 'XR'], ['x-ray knee.png', 'XR'], ['CT abdomen.png', 'CT'], ['mri_brain.jpg', 'MR'], ['usg.jpg', 'US'], ['echo.png', 'Echo'], ['ecg.png', 'ECG'], ['photo.jpg', null]];
for (const [f, want] of MOD_HINTS) check(`guessModality(${f})`, guessModality(f) === want, String(guessModality(f)));

/* ---------------- app lock (Face ID / fingerprint) ---------------- */
section('app lock');
const { createAppLock } = await import(lib('applock.ts'));

/** Fake platform: `results` queues what each prompt does ('ok', an error code, or a pending promise). */
function lockDeps(settings = null) {
  const d = {
    t: 0, settings, saved: [], privacy: [], prompts: 0, results: [],
    bio: { available: true, deviceSecure: true, method: 'Face ID' },
    async loadSettings() { return d.settings; },
    async saveSettings(s) { d.saved.push(s); d.settings = s; },
    async checkBiometry() { return d.bio; },
    authenticate() {
      d.prompts++;
      const r = d.results.length ? d.results.shift() : 'ok';
      if (r instanceof Promise) return r;
      return r === 'ok' ? Promise.resolve() : Promise.reject(Object.assign(new Error(r), { code: r }));
    },
    async setPrivacyScreen(on) { d.privacy.push(on); },
    now: () => d.t,
  };
  return d;
}
const tick = () => new Promise(r => setTimeout(r, 0));
const ON = { enabled: true, delayMs: 60_000 };
{
  const d = lockDeps();
  const lock = createAppLock(d);
  check('lock: no settings → starts open', (await lock.start()) === 'open' && lock.store.getState().status === 'open');
  check('lock: open → data may load', await Promise.race([lock.ready.then(() => true), tick().then(() => false)]));
  check('lock: off → no prompt, no privacy screen', d.prompts === 0 && d.privacy.length === 0);
}
{
  const d = lockDeps(ON);
  const lock = createAppLock(d);
  check('lock: on → starts locked', (await lock.start()) === 'locked');
  check('lock: on → app switcher privacy screen', eq(d.privacy, [true]));
  check('lock: locked → data stays unloaded', !(await Promise.race([lock.ready.then(() => true), tick().then(() => false)])));
  d.results.push('userCancel');
  check('lock: cancelled prompt stays locked', (await lock.unlock()) === false && lock.store.getState().status === 'locked' && lock.store.getState().message === null);
  d.results.push('authenticationFailed');
  await lock.unlock();
  check('lock: failed face/finger says so', lock.store.getState().status === 'locked' && /Not recognised/.test(lock.store.getState().message));
  check('lock: unlock opens', (await lock.unlock()) === true && lock.store.getState().status === 'open' && lock.store.getState().message === null);
  check('lock: unlocked → data may load', await Promise.race([lock.ready.then(() => true), tick().then(() => false)]));

  // Leaving briefly does not lock; leaving longer than the delay does.
  d.t = 1_000; lock.onPause(); d.t = 31_000; lock.onResume(); await tick();
  check('lock: back within the delay stays open', lock.store.getState().status === 'open');
  const before = d.prompts;
  d.t = 100_000; lock.onPause(); d.t = 200_000; lock.onResume(); await tick();
  check('lock: back after the delay asks again', d.prompts === before + 1 && lock.store.getState().status === 'open');

  // Android shows the prompt in its own activity, which pauses and resumes the app: that must not re-lock.
  let finish;
  d.t = 300_000; lock.onPause(); d.t = 400_000;
  d.results.push(new Promise(r => { finish = r; }));
  lock.onResume(); await tick();
  check('lock: prompt in progress', lock.store.getState().status === 'authenticating');
  const prompts = d.prompts;
  lock.onPause(); d.t = 500_000; lock.onResume(); await tick();
  check('lock: pause/resume around the prompt is ignored', d.prompts === prompts && lock.store.getState().status === 'authenticating');
  finish(); await tick();
  lock.onResume(); await tick();
  check('lock: no re-lock right after unlocking', lock.store.getState().status === 'open' && d.prompts === prompts);
}
{
  const d = lockDeps({ enabled: true, delayMs: 0 });
  const lock = createAppLock(d);
  await lock.start(); await lock.unlock();
  lock.onPause();
  check('lock: "as soon as you leave" locks on leaving', lock.store.getState().status === 'locked');
  lock.onResume(); await tick();
  check('lock: and asks on return', lock.store.getState().status === 'open' && d.prompts === 2);
}
{
  const d = lockDeps('unreadable');
  check('lock: unreadable settings keep the lock on', (await createAppLock(d).start()) === 'locked');
}
{
  // Passcode removed from the phone: the lock cannot work, so it switches itself off instead of locking out.
  const d = lockDeps(ON);
  d.bio = { available: false, deviceSecure: false, method: 'passcode' };
  const lock = createAppLock(d);
  check('lock: no passcode any more → opens', (await lock.start()) === 'open');
  check('lock: … and turns itself off', d.settings.enabled === false && d.privacy.at(-1) === false && /turned off/.test(lock.store.getState().message));
  const d2 = lockDeps(ON);
  const lock2 = createAppLock(d2);
  await lock2.start();
  d2.bio = { available: false, deviceSecure: false, method: 'passcode' };
  d2.results.push('passcodeNotSet');
  check('lock: passcode removed while locked → opens', (await lock2.unlock()) === true && lock2.store.getState().status === 'open' && d2.settings.enabled === false);
}
{
  const d = lockDeps();
  const lock = createAppLock(d);
  await lock.start();
  d.results.push('userCancel');
  check('lock: turning on needs a confirmed prompt', (await lock.setEnabled(true)) === false && d.saved.length === 0);
  check('lock: turning on', (await lock.setEnabled(true)) === true && d.settings.enabled === true && d.privacy.at(-1) === true);
  check('lock: turning on keeps the app open', lock.store.getState().status === 'open');
  await lock.setDelay(300_000);
  check('lock: delay saved', d.settings.delayMs === 300_000 && lock.store.getState().settings.delayMs === 300_000);
  d.results.push('authenticationFailed');
  check('lock: turning off needs a confirmed prompt', (await lock.setEnabled(false)) === false && d.settings.enabled === true);
  check('lock: turning off', (await lock.setEnabled(false)) === true && d.settings.enabled === false && d.privacy.at(-1) === false);
  lock.onPause(); d.t = 10_000_000; lock.onResume(); await tick();
  check('lock: off → leaving and coming back stays open', lock.store.getState().status === 'open');
  const d2 = lockDeps();
  d2.bio = { available: false, deviceSecure: false, method: 'passcode' };
  const lock2 = createAppLock(d2);
  await lock2.start();
  check('lock: cannot turn on without Face ID or a passcode', (await lock2.setEnabled(true)) === false && d2.prompts === 0 && !!lock2.store.getState().message);
}

/* ---------------- phone health import (Apple Health, Health Connect) ---------------- */
section('health import');
{
  process.env.TZ = process.env.TZ || 'UTC';
  const h = await import(lib('health-import.ts'));
  const k = t => h.KIND_BY_TYPE.get(t);
  const today = '2026-11-11';
  // Blood pressure: two readings on one day are averaged, each half becomes its own marker; today is left out.
  const bp = h.dailyValues(k('bloodPressure'), [
    { value: 0, unit: 'mmHg', startDate: '2026-11-09T07:00:00Z', systolic: 128, diastolic: 84 },
    { value: 0, unit: 'mmHg', startDate: '2026-11-09T20:00:00Z', systolic: 121, diastolic: 79 },
    { value: 0, unit: 'mmHg', startDate: '2026-11-10T07:00:00Z', systolic: 118, diastolic: 76 },
    { value: 0, unit: 'mmHg', startDate: '2026-11-11T07:00:00Z', systolic: 140, diastolic: 90 },
  ], today);
  check('health: BP daily mean, split into systolic and diastolic', eq(bp.map(d => [d.markerId, d.date, d.value, d.readings]), [
    ['bp_systolic', '2026-11-09', 125, 2], ['bp_diastolic', '2026-11-09', 82, 2],
    ['bp_systolic', '2026-11-10', 118, 1], ['bp_diastolic', '2026-11-10', 76, 1],
  ]), JSON.stringify(bp));
  // SpO2: HealthKit fractions and Health Connect percentages both become %; an implausible reading is dropped.
  const sp = h.dailyValues(k('oxygenSaturation'), [
    { value: 0.97, unit: 'percent', startDate: '2026-11-08T01:00:00Z' },
    { value: 95, unit: 'percent', startDate: '2026-11-08T03:00:00Z' },
    { value: 12, unit: 'percent', startDate: '2026-11-08T04:00:00Z' },
  ], today);
  check('health: SpO2 fraction and percent, implausible dropped', eq(sp.map(d => [d.value, d.readings]), [[96, 2]]), JSON.stringify(sp));
  const t = h.dailyValues(k('bodyTemperature'), [{ value: 98.6, unit: 'fahrenheit', startDate: '2026-11-01T08:00:00Z' }], today);
  check('health: temperature in °F converted to °C', t[0]?.value === 37, JSON.stringify(t));
  const g = h.dailyValues(k('bloodGlucose'), [{ value: 5.5, unit: 'mmol/L', startDate: '2026-11-01T08:00:00Z' }], today);
  check('health: glucose in mmol/L converted to mg/dL', g[0]?.value === 99, JSON.stringify(g));
  const w = h.dailyValues(k('weight'), [{ value: 72.46, unit: 'kilogram', startDate: '2026-11-01T08:00:00Z' }, { value: NaN, unit: 'kilogram', startDate: '2026-11-01T09:00:00Z' }], today);
  check('health: weight to one decimal, NaN ignored', w.length === 1 && w[0].value === 72.5, JSON.stringify(w));

  const ms = h.toMeasurements(bp, 'apple_health');
  const sys = ms.find(m => m.markerId === 'bp_systolic' && m.date === '2026-11-09');
  check('health: results carry the source, unit, typical range and status', !!sys && sys.sourceFile === 'Apple Health' && sys.unit === 'mmHg' && sys.range?.source === 'typical' && sys.status === 'high' && sys.confidence === 'high', JSON.stringify(sys));
  const fresh = h.onlyNewDays(ms, [{ markerId: 'bp_systolic', date: '2026-11-09', sourceFile: 'Apple Health' }, { markerId: 'bp_diastolic', date: '2026-11-10', sourceFile: 'Sample report' }]);
  check('health: a day already imported from the same source is skipped', fresh.length === 3 && !fresh.some(m => m.markerId === 'bp_systolic' && m.date === '2026-11-09'));
  check('health: next import starts the day after the last one', h.importStart([{ date: '2026-10-30', sourceFile: 'Apple Health' }, { date: '2026-11-05', sourceFile: 'Health Connect' }], 'apple_health', today, 90) === '2026-10-31');
  check('health: first import goes back the chosen number of days', h.importStart([], 'health_connect', today, 30) === '2026-10-12');
  const win = h.monthWindows('2026-09-15', '2026-11-11');
  check('health: reads are split by calendar month', win.length === 3 && win[0].startDate.startsWith('2026-09-15') && win[2].endDate.startsWith('2026-11-11'), JSON.stringify(win));
  check('health: summary line', h.importSummary(ms) === 'Blood pressure: 2 days', h.importSummary(ms));
  check('health: every kind maps to catalogue markers with LOINC codes', h.IMPORT_KINDS.every(x => x.markers.every(id => findMarker(id)?.loinc)));
}

/* ---------------- FHIR R4 (ABDM / ABHA apps) ---------------- */
section('fhir');
{
  const f = await import(lib('parse/fhir.ts'));
  const text = readFileSync(join(fixtures, 'fhir/lab-record-bundle.json'), 'utf8');
  const r = parseJsonText(text, 'lab-record-bundle.json');
  const by = id => r.measurements.find(m => m.markerId === id);
  check('fhir: bundle detected', f.isFhir(JSON.parse(text)));
  check('fhir: LOINC picks the marker (HbA1c by code, name "HbA1c")', by('hba1c')?.value === 6.1 && by('hba1c')?.status === 'high', JSON.stringify(by('hba1c')));
  check('fhir: date from effectiveDateTime', by('hba1c')?.date === '2026-10-20');
  check('fhir: report range kept', by('glucose_fasting')?.range?.low === 70 && by('glucose_fasting')?.range?.high === 100 && by('glucose_fasting')?.range?.source === 'report', JSON.stringify(by('glucose_fasting')?.range));
  check('fhir: unit from the UCUM code when unit is missing', by('hemoglobin')?.unit === 'g/dL' && by('wbc')?.value === 7.8, `${by('hemoglobin')?.unit} ${by('wbc')?.unit} ${by('wbc')?.value}`);
  check('fhir: UCUM u[IU]/mL read as µIU/mL', by('tsh')?.value === 2.4 && by('tsh')?.confidence !== 'low', JSON.stringify(by('tsh')));
  check('fhir: comparator kept (<8)', by('vitamin_d')?.valueText.startsWith('<') && by('vitamin_d')?.status === 'low', JSON.stringify(by('vitamin_d')));
  check('fhir: coded qualitative value', by('urine_protein')?.valueText === 'Negative');
  check('fhir: entered-in-error left out', !r.measurements.some(m => m.value === 999) && r.warnings.some(w => /entered in error/.test(w)));
  check('fhir: preliminary marked for checking', by('ldl')?.confidence === 'low' && r.warnings.some(w => /preliminary/.test(w)));
  check('fhir: BP panel components become systolic and diastolic', by('bp_systolic')?.value === 132 && by('bp_diastolic')?.value === 86 && by('bp_diastolic')?.unit === 'mmHg', `${JSON.stringify(by('bp_systolic'))} ${JSON.stringify(by('bp_diastolic'))}`);
  check('fhir: unknown code kept unmatched for review', r.measurements.some(m => !m.markerId && m.rawName === 'Lipoprotein X index'));
  check('fhir: the panel itself (no value) is not a row', !r.measurements.some(m => /panel/i.test(m.rawName)));
  check('fhir: whose results these are', r.warnings.some(w => w.includes('Asha Rao')));
  check('fhir: 11 rows', r.measurements.length === 11, String(r.measurements.length));
  const single = parseJsonText(JSON.stringify({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '2093-3' }] }, valueQuantity: { value: 5.2, unit: 'mmol/L' }, effectiveDateTime: '2026-01-05' }), 'obs.json');
  check('fhir: single Observation, name from LOINC, mmol/L converted', single.measurements[0]?.markerId === 'total_cholesterol' && Math.round(single.measurements[0].value) === 201, JSON.stringify(single.measurements[0]));
  // Withings daily values as the record agent saves them (server/src/records/api/withings.ts readingsBundle).
  const wd = f.parseFhir(JSON.parse(readFileSync(join(fixtures, 'fhir/withings-daily.json'), 'utf8')), 'withings.json');
  const wdRows = wd.measurements.map(m => `${m.date} ${m.markerId} ${m.value} ${m.unit}`).sort();
  check('fhir: Withings daily vitals become the vitals markers', eq(wdRows, [
    '2026-11-01 body_fat 18.2 %', '2026-11-01 body_weight 72.5 kg', '2026-11-01 bp_diastolic 84 mmHg', '2026-11-01 bp_systolic 128 mmHg',
    '2026-11-01 resting_heart_rate 71 bpm', '2026-11-02 body_temperature 36.8 °C', '2026-11-02 spo2 97 %',
  ]), JSON.stringify(wdRows));
  // Ultrahuman / Oura daily values (server/src/records/api/vitals.ts): breathing rate and sensor glucose too.
  const ud = f.parseFhir(JSON.parse(readFileSync(join(fixtures, 'fhir/ultrahuman-daily.json'), 'utf8')), 'ultrahuman.json');
  const udRows = ud.measurements.map(m => `${m.markerId} ${m.value} ${m.unit}`).sort();
  check('fhir: ring and CGM daily values become the vitals markers', eq(udRows, [
    'glucose_meter 104 mg/dL', 'respiratory_rate 14 breaths/min', 'resting_heart_rate 56 bpm', 'spo2 97 %',
  ]), JSON.stringify(udRows));
  const pdfOnly = JSON.parse(readFileSync(join(fixtures, 'fhir/pdf-only-report.json'), 'utf8'));
  const att = f.fhirAttachments(pdfOnly);
  check('fhir: PDF in presentedForm found', att.length === 1 && att[0].contentType === 'application/pdf' && att[0].title === 'Lipid profile.pdf' && att[0].data.length > 1000);
  check('fhir: UCUM display', f.ucumDisplay('10*3/uL') === '10^3/µL' && f.ucumDisplay('mm[Hg]') === 'mmHg' && f.ucumDisplay('[IU]/L') === 'IU/L' && f.ucumDisplay('Cel') === '°C' && f.ucumDisplay('ug/dL') === 'µg/dL' && f.ucumDisplay('mg/dL') === 'mg/dL');
  check('fhir: not FHIR stays with the generic reader', !f.isFhir({ results: [] }));
}

/* ---------------- home: what needs attention, and where on the body ---------------- */
section('attention');
{
  const a = await import(lib('attention.ts'));
  const { buildSeries } = await import(lib('derive.ts'));
  const m = (markerId, value, date, range, status, valueText = String(value), unit = 'mg/dL') => ({ id: `${markerId}-${date}`, markerId, rawName: markerId, value, valueText, unit, range: { ...range, source: 'report' }, status, date, sourceFile: 'r.pdf', confidence: 'high' });
  const ms = [
    m('ldl', 121, '2026-07-02', { high: 100 }, 'high'), m('ldl', 131, '2026-10-20', { high: 100 }, 'high'),
    m('glucose_fasting', 104, '2026-10-20', { low: 70, high: 100 }, 'high'),
    m('tsh', 2.1, '2026-10-20', { low: 0.4, high: 4.5 }, 'normal'),
    m('vitamin_d', 8, '2026-01-10', { low: 30, high: 100 }, 'low', '8', 'ng/mL'),
  ];
  const now = Date.parse('2026-11-11T00:00:00Z');
  const items = a.attentionItems(buildSeries(ms), now);
  check('attention: only out-of-range results, furthest first', items.map(i => i.name).join(',') === 'Vitamin D (25-OH),LDL cholesterol,Fasting glucose', items.map(i => i.name).join(','));
  const ldl = items.find(i => i.seriesKey === 'ldl');
  check('attention: plain detail with the change', /^131 mg\/dL on .+, up from 121 on .+\.$/.test(ldl.detail), ldl.detail);
  check('attention: far outside (LDL 31% over) vs just outside (glucose 13%)', ldl.level === 'far' && items.find(i => i.seriesKey === 'glucose_fasting').level === 'out');
  check('attention: an old result suggests asking about a repeat', /Last checked 10 months ago/.test(items[0].next), items[0].next);
  const organs = a.organIssues(items);
  check('attention: organs light up by their primary marker', organs.heart === 'far' && organs.pancreas === 'out' && !organs.thyroid, JSON.stringify(organs));
  const due = a.testsDue({ conditions: ['Type 2 diabetes'] }, ms, items, now);
  check('attention: tests due from conditions, not repeating listed items', due.some(f => f.marker === 'HbA1c') && !due.some(f => f.marker === 'LDL cholesterol'), JSON.stringify(due.map(f => f.marker)));
}

/* ---------------- summary ---------------- */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:\n  ' + failures.join('\n  ')); process.exitCode = 1; }
