// Biomarker catalog: names, aliases, canonical units and generic adult ranges.
// Ranges are broad, sex-neutral adult ranges used only when a report does not print its own.
import type { BiomarkerDef, OrganId, SystemId } from './types.ts';

export const SYSTEM_LABELS: Record<SystemId, string> = {
  heart: 'Heart & lipids',
  metabolic: 'Blood sugar',
  liver: 'Liver',
  kidney: 'Kidneys & electrolytes',
  blood: 'Blood count',
  thyroid: 'Thyroid',
  nutrition: 'Vitamins & iron',
  inflammation: 'Inflammation',
  hormones: 'Hormones',
  urine: 'Urine',
};

type Extra = Pick<BiomarkerDef, 'altUnits' | 'typical' | 'lowerIsBetter'>;

function def(
  id: string, name: string, unit: string, system: SystemId, organs: OrganId[],
  aliases: string[], about: string, extra: Extra = {},
): BiomarkerDef {
  const all = new Set<string>([id.replace(/_/g, ' '), name.toLowerCase(), ...aliases.map(a => a.toLowerCase())]);
  return { id, name, aliases: [...all], unit, system, organs, about, ...extra };
}

// Common conversion factors (value_in_canonical = value * factor).
const CHOL_MMOL = { unit: 'mmol/L', factor: 38.67 };
const GLU_MMOL = { unit: 'mmol/L', factor: 18.016 };
const CELLS_CUMM = [
  { unit: 'cells/cumm', factor: 0.001 }, { unit: '/cumm', factor: 0.001 },
  { unit: 'cells/µL', factor: 0.001 }, { unit: '/µL', factor: 0.001 }, { unit: 'cells/mm3', factor: 0.001 },
];
const G_L = { unit: 'g/L', factor: 0.1 };

const LIPIDS: BiomarkerDef[] = [
  def('total_cholesterol', 'Total cholesterol', 'mg/dL', 'heart', ['heart'],
    ['cholesterol', 'cholesterol total', 'total cholesterol', 'serum cholesterol', 'tc', 't chol', 'chol', 'cholesterol, total', 'total cholestrol', 'cholesterol serum'],
    'All the cholesterol carried in your blood, including the "good" and "bad" kinds.',
    { altUnits: [CHOL_MMOL], typical: { high: 200 }, lowerIsBetter: true }),
  def('hdl', 'HDL cholesterol', 'mg/dL', 'heart', ['heart'],
    ['hdl', 'hdl cholesterol', 'hdl-c', 'hdl c', 'hdl chol', 'cholesterol hdl', 'hdl cholesterol direct', 'hdl direct', 'direct hdl', 'high density lipoprotein', 'high density lipoprotein cholesterol', 'hdl-cholesterol'],
    'Often called "good" cholesterol because it helps carry cholesterol away from blood vessels.',
    { altUnits: [CHOL_MMOL], typical: { low: 40 } }),
  def('ldl', 'LDL cholesterol', 'mg/dL', 'heart', ['heart'],
    ['ldl', 'ldl cholesterol', 'ldl-c', 'ldl c', 'ldl chol', 'cholesterol ldl', 'ldl calculated', 'ldl cholesterol calculated', 'ldl direct', 'direct ldl', 'ldl cholesterol direct', 'low density lipoprotein', 'low density lipoprotein cholesterol', 'ldl-cholesterol'],
    'Often called "bad" cholesterol; higher levels can build up in artery walls over time.',
    { altUnits: [CHOL_MMOL], typical: { high: 100 }, lowerIsBetter: true }),
  def('vldl', 'VLDL cholesterol', 'mg/dL', 'heart', ['heart'],
    ['vldl', 'vldl cholesterol', 'vldl-c', 'vldl chol', 'cholesterol vldl', 'very low density lipoprotein', 'vldl calculated'],
    'Cholesterol carried by particles that mostly transport triglycerides; usually calculated from triglycerides.',
    { altUnits: [CHOL_MMOL], typical: { high: 30 }, lowerIsBetter: true }),
  def('non_hdl', 'Non-HDL cholesterol', 'mg/dL', 'heart', ['heart'],
    ['non hdl', 'non-hdl', 'non hdl cholesterol', 'non-hdl cholesterol', 'non hdl c', 'non-hdl-c', 'non hdl chol', 'cholesterol non hdl'],
    'Total cholesterol minus HDL: a combined measure of the cholesterol types linked to artery build-up.',
    { altUnits: [CHOL_MMOL], typical: { high: 130 }, lowerIsBetter: true }),
  def('triglycerides', 'Triglycerides', 'mg/dL', 'heart', ['heart', 'liver'],
    ['triglycerides', 'triglyceride', 'tg', 'trig', 'trigs', 'serum triglycerides', 'triglycerides serum', 'tryglycerides'],
    'A type of fat in the blood that rises after meals and with excess sugar or alcohol.',
    { altUnits: [{ unit: 'mmol/L', factor: 88.57 }], typical: { high: 150 }, lowerIsBetter: true }),
  def('tc_hdl_ratio', 'Total cholesterol / HDL ratio', 'ratio', 'heart', ['heart'],
    ['tc/hdl ratio', 'tc hdl ratio', 'chol/hdl ratio', 'cholesterol/hdl ratio', 'total cholesterol/hdl ratio', 'total cholesterol hdl ratio', 'total chol/hdl ratio', 'cholesterol hdl ratio', 'chol hdl ratio', 'tc/hdl cholesterol ratio', 'total cholesterol hdl cholesterol ratio', 'castelli index', 'chol/hdl', 'tc/hdl', 'cholesterol/hdl', 'total cholesterol/hdl', 'tc:hdl'],
    'Total cholesterol divided by HDL; a lower number generally means a better balance.',
    { typical: { high: 5 }, lowerIsBetter: true }),
  def('ldl_hdl_ratio', 'LDL / HDL ratio', 'ratio', 'heart', ['heart'],
    ['ldl/hdl ratio', 'ldl hdl ratio', 'ldl/hdl cholesterol ratio', 'ldl cholesterol hdl cholesterol ratio', 'ldl c hdl c ratio', 'ldl/hdl', 'ldl:hdl'],
    'LDL divided by HDL; a lower number generally means a better balance.',
    { typical: { high: 3.5 }, lowerIsBetter: true }),
  def('apoa1', 'Apolipoprotein A1', 'mg/dL', 'heart', ['heart'],
    ['apoa1', 'apo a1', 'apo a-1', 'apo-a1', 'apo a i', 'apolipoprotein a1', 'apolipoprotein a-1', 'apolipoprotein a i', 'apolipoprotein a'],
    'The main protein in HDL particles.',
    { altUnits: [{ unit: 'g/L', factor: 100 }], typical: { low: 100 } }),
  def('apob', 'Apolipoprotein B', 'mg/dL', 'heart', ['heart'],
    ['apob', 'apo b', 'apo-b', 'apo b100', 'apolipoprotein b', 'apolipoprotein b100', 'apolipoprotein b-100'],
    'The protein on LDL and similar particles; reflects the number of cholesterol-carrying particles.',
    { altUnits: [{ unit: 'g/L', factor: 100 }], typical: { high: 100 }, lowerIsBetter: true }),
  def('lpa', 'Lipoprotein(a)', 'mg/dL', 'heart', ['heart'],
    ['lp(a)', 'lp a', 'lpa', 'lipoprotein a', 'lipoprotein(a)', 'lipoprotein little a'],
    'A cholesterol particle whose level is largely inherited and changes little over life.',
    { altUnits: [{ unit: 'nmol/L', factor: 0.4167 }], typical: { high: 30 }, lowerIsBetter: true }),
];

const METABOLIC: BiomarkerDef[] = [
  def('glucose_fasting', 'Fasting glucose', 'mg/dL', 'metabolic', ['pancreas'],
    ['glucose fasting', 'fasting glucose', 'fasting blood sugar', 'fbs', 'fbg', 'fpg', 'fasting plasma glucose', 'blood sugar fasting', 'plasma glucose fasting', 'glucose f', 'glucose fasting plasma', 'blood glucose fasting', 'fasting blood glucose', 'sugar fasting', 'glucose', 'blood glucose', 'plasma glucose', 'blood sugar', 'glucose fasting f'],
    'Sugar in the blood after not eating for 8 or more hours.',
    { altUnits: [GLU_MMOL], typical: { low: 70, high: 100 } }),
  def('glucose_pp', 'Post-meal glucose', 'mg/dL', 'metabolic', ['pancreas'],
    ['glucose pp', 'glucose post prandial', 'post prandial glucose', 'postprandial glucose', 'ppbs', 'pp blood sugar', 'post prandial blood sugar', 'postprandial blood sugar', 'blood sugar pp', 'plasma glucose pp', 'glucose 2 hr pp', '2 hr pp', 'glucose ppbs', 'blood sugar post prandial', 'plasma glucose post prandial', 'ppg'],
    'Sugar in the blood about two hours after a meal.',
    { altUnits: [GLU_MMOL], typical: { high: 140 } }),
  def('glucose_random', 'Random glucose', 'mg/dL', 'metabolic', ['pancreas'],
    ['glucose random', 'random glucose', 'random blood sugar', 'rbs', 'random blood glucose', 'blood sugar random', 'plasma glucose random', 'rbg'],
    'Sugar in the blood at any time of day, regardless of meals.',
    { altUnits: [GLU_MMOL], typical: { low: 70, high: 140 } }),
  def('hba1c', 'HbA1c', '%', 'metabolic', ['pancreas'],
    ['hba1c', 'hb a1c', 'a1c', 'glycated hemoglobin', 'glycosylated hemoglobin', 'glycated haemoglobin', 'glycosylated haemoglobin', 'hemoglobin a1c', 'haemoglobin a1c', 'glyco hemoglobin', 'hba1c glycated hemoglobin', 'glycated hb'],
    'Shows your average blood sugar over roughly the last three months.',
    { typical: { low: 4, high: 5.7 }, lowerIsBetter: true }),
  def('eag', 'Estimated average glucose', 'mg/dL', 'metabolic', ['pancreas'],
    ['estimated average glucose', 'eag', 'average blood glucose', 'mean blood glucose', 'mbg', 'mean plasma glucose', 'average glucose', 'estimated average glucose eag', 'abg'],
    'Your HbA1c translated into an average blood sugar number.',
    { altUnits: [GLU_MMOL], typical: { high: 117 }, lowerIsBetter: true }),
  def('insulin', 'Fasting insulin', 'µIU/mL', 'metabolic', ['pancreas'],
    ['insulin', 'insulin fasting', 'fasting insulin', 'serum insulin', 'insulin serum', 'insulin f'],
    'The hormone from the pancreas that moves sugar from blood into cells.',
    { altUnits: [{ unit: 'pmol/L', factor: 0.1667 }], typical: { low: 2, high: 25 } }),
  def('homa_ir', 'HOMA-IR', 'index', 'metabolic', ['pancreas'],
    ['homa ir', 'homa-ir', 'homa ir index', 'homa index', 'insulin resistance index', 'homa'],
    'An estimate of insulin resistance calculated from fasting glucose and insulin.',
    { typical: { high: 2.5 }, lowerIsBetter: true }),
];

const CARDIAC: BiomarkerDef[] = [
  def('hs_crp', 'hs-CRP', 'mg/L', 'heart', ['heart'],
    ['hs crp', 'hs-crp', 'hscrp', 'high sensitivity crp', 'high sensitivity c reactive protein', 'highly sensitive c reactive protein', 'hs c reactive protein', 'c reactive protein high sensitivity', 'crp high sensitivity', 'cardiac crp', 'crp hs'],
    'A sensitive measure of low-level inflammation, often used alongside cholesterol for heart health.',
    { altUnits: [{ unit: 'mg/dL', factor: 10 }], typical: { high: 3 }, lowerIsBetter: true }),
  def('troponin_i', 'Troponin I', 'pg/mL', 'heart', ['heart'],
    ['troponin i', 'trop i', 'tni', 'ctni', 'hs troponin i', 'hs-troponin i', 'high sensitivity troponin i', 'cardiac troponin i', 'troponin i hs', 'hs tni'],
    'A heart-muscle protein; very small amounts are normal in the blood.',
    { altUnits: [{ unit: 'ng/mL', factor: 1000 }], typical: { high: 26 }, lowerIsBetter: true }),
  def('troponin_t', 'Troponin T', 'pg/mL', 'heart', ['heart'],
    ['troponin t', 'trop t', 'tnt', 'ctnt', 'hs troponin t', 'hs-troponin t', 'high sensitivity troponin t', 'cardiac troponin t', 'troponin t hs', 'hs tnt'],
    'A heart-muscle protein; very small amounts are normal in the blood.',
    { altUnits: [{ unit: 'ng/mL', factor: 1000 }], typical: { high: 14 }, lowerIsBetter: true }),
  def('nt_probnp', 'NT-proBNP', 'pg/mL', 'heart', ['heart'],
    ['nt probnp', 'nt-probnp', 'nt pro bnp', 'n terminal pro bnp', 'n-terminal pro b-type natriuretic peptide', 'nt pro b type natriuretic peptide', 'probnp', 'pro bnp'],
    'A hormone released when the heart muscle is stretched.',
    { altUnits: [{ unit: 'pmol/L', factor: 8.457 }], typical: { high: 125 }, lowerIsBetter: true }),
  def('homocysteine', 'Homocysteine', 'µmol/L', 'heart', ['heart'],
    ['homocysteine', 'homocystine', 'hcy', 'serum homocysteine', 'homocysteine serum', 'plasma homocysteine'],
    'An amino acid influenced by B12, folate and B6 levels.',
    { typical: { low: 5, high: 15 }, lowerIsBetter: true }),
  def('lp_pla2', 'Lp-PLA2', 'nmol/min/mL', 'heart', ['heart'],
    ['lp pla2', 'lp-pla2', 'lppla2', 'lipoprotein associated phospholipase a2', 'plac test', 'plac activity'],
    'An enzyme linked to inflammation inside blood vessel walls.',
    { typical: { high: 225 }, lowerIsBetter: true }),
];

const INFLAMMATION: BiomarkerDef[] = [
  def('crp', 'C-reactive protein', 'mg/L', 'inflammation', ['spleen', 'marrow'],
    ['crp', 'c reactive protein', 'c-reactive protein', 'crp quantitative', 'c reactive protein quantitative', 'crp serum', 'quantitative crp', 'c reactive protein crp'],
    'A protein made by the liver that rises with inflammation or infection anywhere in the body.',
    { altUnits: [{ unit: 'mg/dL', factor: 10 }], typical: { high: 5 }, lowerIsBetter: true }),
  def('esr', 'ESR', 'mm/hr', 'inflammation', ['marrow', 'spleen'],
    ['esr', 'erythrocyte sedimentation rate', 'sed rate', 'sedimentation rate', 'esr westergren', 'westergren esr', 'esr 1st hour'],
    'How quickly red cells settle in a tube; it tends to rise with inflammation.',
    { typical: { high: 20 }, lowerIsBetter: true }),
];

const LIVER: BiomarkerDef[] = [
  def('alt', 'ALT (SGPT)', 'U/L', 'liver', ['liver'],
    ['alt', 'sgpt', 'alt (sgpt)', 'sgpt (alt)', 'alt sgpt', 'sgpt alt', 'alanine aminotransferase', 'alanine transaminase', 'alanine amino transferase', 'serum glutamic pyruvic transaminase', 'alt/sgpt', 'sgpt/alt', 'alat', 'gpt'],
    'A liver enzyme; small amounts in blood are normal and levels rise when liver cells are stressed.',
    { typical: { high: 40 }, lowerIsBetter: true }),
  def('ast', 'AST (SGOT)', 'U/L', 'liver', ['liver'],
    ['ast', 'sgot', 'ast (sgot)', 'sgot (ast)', 'ast sgot', 'sgot ast', 'aspartate aminotransferase', 'aspartate transaminase', 'aspartate amino transferase', 'serum glutamic oxaloacetic transaminase', 'ast/sgot', 'sgot/ast', 'asat', 'got'],
    'An enzyme found in the liver, heart and muscles; it can rise after liver stress or hard exercise.',
    { typical: { high: 40 }, lowerIsBetter: true }),
  def('ast_alt_ratio', 'AST / ALT ratio', 'ratio', 'liver', ['liver'],
    ['sgot/sgpt ratio', 'sgot sgpt ratio', 'ast/alt ratio', 'ast alt ratio', 'de ritis ratio', 'sgot sgpt'],
    'AST divided by ALT; sometimes printed to help interpret liver enzymes together.'),
  def('alp', 'Alkaline phosphatase', 'U/L', 'liver', ['liver', 'marrow'],
    ['alp', 'alkaline phosphatase', 'alk phos', 'alk phosphatase', 'alkp', 'sap', 'serum alkaline phosphatase', 'alkaline phosphatase alp', 'alkaline phosphotase'],
    'An enzyme from the liver, bile ducts and bones.',
    { typical: { low: 40, high: 130 } }),
  def('ggt', 'GGT', 'U/L', 'liver', ['liver'],
    ['ggt', 'gamma gt', 'gamma-gt', 'ggtp', 'gamma glutamyl transferase', 'gamma glutamyl transpeptidase', 'gamma glutamyltransferase', 'g gt', 'y gt'],
    'A liver and bile-duct enzyme that is sensitive to alcohol and some medicines.',
    { typical: { high: 55 }, lowerIsBetter: true }),
  def('bilirubin_total', 'Total bilirubin', 'mg/dL', 'liver', ['liver'],
    ['bilirubin', 'bilirubin total', 'total bilirubin', 'tbil', 't bil', 'serum bilirubin', 'bilirubin t', 'bilirubin serum total', 'serum bilirubin total'],
    'A yellow pigment from the normal breakdown of red cells, cleared by the liver.',
    { altUnits: [{ unit: 'µmol/L', factor: 0.05848 }], typical: { high: 1.2 }, lowerIsBetter: true }),
  def('bilirubin_direct', 'Direct bilirubin', 'mg/dL', 'liver', ['liver'],
    ['bilirubin direct', 'direct bilirubin', 'conjugated bilirubin', 'bilirubin conjugated', 'dbil', 'd bil', 'bilirubin d', 'serum bilirubin direct'],
    'The part of bilirubin the liver has already processed.',
    { altUnits: [{ unit: 'µmol/L', factor: 0.05848 }], typical: { high: 0.3 }, lowerIsBetter: true }),
  def('bilirubin_indirect', 'Indirect bilirubin', 'mg/dL', 'liver', ['liver'],
    ['bilirubin indirect', 'indirect bilirubin', 'unconjugated bilirubin', 'bilirubin unconjugated', 'ibil', 'bilirubin i', 'serum bilirubin indirect'],
    'The part of bilirubin not yet processed by the liver.',
    { altUnits: [{ unit: 'µmol/L', factor: 0.05848 }], typical: { high: 0.9 }, lowerIsBetter: true }),
  def('albumin', 'Albumin', 'g/dL', 'liver', ['liver'],
    ['albumin', 'serum albumin', 'albumin serum', 'alb'],
    'The main protein made by the liver; it keeps fluid in blood vessels and carries nutrients.',
    { altUnits: [G_L], typical: { low: 3.5, high: 5.2 } }),
  def('globulin', 'Globulin', 'g/dL', 'liver', ['liver'],
    ['globulin', 'serum globulin', 'globulin serum', 'glob', 'globulin calculated'],
    'A group of blood proteins that includes antibodies; usually calculated as total protein minus albumin.',
    { altUnits: [G_L], typical: { low: 2, high: 3.5 } }),
  def('total_protein', 'Total protein', 'g/dL', 'liver', ['liver'],
    ['total protein', 'protein total', 'serum protein', 'total proteins', 'tp', 'protein', 'serum total protein', 'proteins total'],
    'Albumin plus globulins: the total amount of protein in the blood.',
    { altUnits: [G_L], typical: { low: 6, high: 8.3 } }),
  def('ag_ratio', 'Albumin / globulin ratio', 'ratio', 'liver', ['liver'],
    ['a/g ratio', 'a g ratio', 'ag ratio', 'albumin/globulin ratio', 'albumin globulin ratio', 'alb/glob ratio', 'albumin : globulin ratio'],
    'Albumin divided by globulin; helps describe the balance of blood proteins.',
    { typical: { low: 0.9, high: 2 } }),
];

const KIDNEY: BiomarkerDef[] = [
  def('creatinine', 'Creatinine', 'mg/dL', 'kidney', ['kidneys'],
    ['creatinine', 'serum creatinine', 'creatinine serum', 's creatinine', 'creat', 'cr', 'creatinine blood', 'scr'],
    'A waste product from muscle that healthy kidneys filter out.',
    { altUnits: [{ unit: 'µmol/L', factor: 0.01131 }], typical: { low: 0.5, high: 1.3 } }),
  def('urea', 'Urea', 'mg/dL', 'kidney', ['kidneys'],
    ['urea', 'blood urea', 'serum urea', 'urea serum', 'urea blood'],
    'A waste product from protein breakdown, filtered by the kidneys.',
    { altUnits: [{ unit: 'mmol/L', factor: 6.006 }], typical: { low: 15, high: 45 } }),
  def('bun', 'Blood urea nitrogen', 'mg/dL', 'kidney', ['kidneys'],
    ['bun', 'blood urea nitrogen', 'urea nitrogen', 'serum urea nitrogen', 'bun serum', 'urea nitrogen blood'],
    'The nitrogen part of urea; another way of reporting the same kidney waste product.',
    { altUnits: [{ unit: 'mmol/L', factor: 2.801 }], typical: { low: 7, high: 20 } }),
  def('bun_creatinine_ratio', 'BUN / creatinine ratio', 'ratio', 'kidney', ['kidneys'],
    ['bun/creatinine ratio', 'bun creatinine ratio', 'bun/creat ratio', 'bun cr ratio', 'urea nitrogen creatinine ratio', 'bun : creatinine ratio'],
    'BUN divided by creatinine; helps put the two kidney numbers in context.',
    { typical: { low: 10, high: 20 } }),
  def('egfr', 'eGFR', 'mL/min/1.73m²', 'kidney', ['kidneys'],
    ['egfr', 'e gfr', 'gfr', 'estimated gfr', 'estimated glomerular filtration rate', 'glomerular filtration rate', 'egfr ckd epi', 'egfr creatinine', 'gfr estimated', 'egfr non african american', 'egfr mdrd'],
    'An estimate of how much blood the kidneys filter each minute; above 90 is typical and 60–89 can be normal with age.',
    { altUnits: [{ unit: 'mL/min', factor: 1 }, { unit: 'mL/min/1.73m2', factor: 1 }, { unit: 'ml/min/1.73 m2', factor: 1 }, { unit: 'mL/min/1.73 sq.m', factor: 1 }], typical: { low: 60 } }),
  def('uric_acid', 'Uric acid', 'mg/dL', 'kidney', ['kidneys'],
    ['uric acid', 'serum uric acid', 'uric acid serum', 'urate', 'ua', 's uric acid'],
    'A waste product from breaking down purines in food and cells, cleared by the kidneys.',
    { altUnits: [{ unit: 'µmol/L', factor: 0.01681 }, { unit: 'mmol/L', factor: 16.81 }], typical: { low: 2.5, high: 7 } }),
  def('sodium', 'Sodium', 'mmol/L', 'kidney', ['kidneys'],
    ['sodium', 'na', 'na+', 'serum sodium', 'sodium serum', 's sodium'],
    'A key salt that controls fluid balance; the kidneys keep it in a narrow range.',
    { altUnits: [{ unit: 'mEq/L', factor: 1 }], typical: { low: 135, high: 145 } }),
  def('potassium', 'Potassium', 'mmol/L', 'kidney', ['kidneys', 'heart'],
    ['potassium', 'k', 'k+', 'serum potassium', 'potassium serum', 's potassium'],
    'A salt important for nerve and heart-muscle signals; balanced by the kidneys.',
    { altUnits: [{ unit: 'mEq/L', factor: 1 }], typical: { low: 3.5, high: 5.1 } }),
  def('chloride', 'Chloride', 'mmol/L', 'kidney', ['kidneys'],
    ['chloride', 'cl', 'cl-', 'serum chloride', 'chloride serum', 's chloride', 'chlorides'],
    'A salt that works with sodium to balance fluids and acidity.',
    { altUnits: [{ unit: 'mEq/L', factor: 1 }], typical: { low: 98, high: 107 } }),
  def('bicarbonate', 'Bicarbonate', 'mmol/L', 'kidney', ['kidneys', 'lungs'],
    ['bicarbonate', 'hco3', 'hco3-', 'total co2', 'co2', 'carbon dioxide', 'serum bicarbonate', 'tco2', 'carbon dioxide total', 'bicarbonate serum', 'co2 total'],
    'A buffer that keeps blood from becoming too acidic; balanced by the kidneys and lungs.',
    { altUnits: [{ unit: 'mEq/L', factor: 1 }], typical: { low: 22, high: 29 } }),
  def('calcium', 'Calcium', 'mg/dL', 'kidney', ['kidneys', 'marrow'],
    ['calcium', 'ca', 'serum calcium', 'calcium serum', 'calcium total', 'total calcium', 's calcium', 'ca++'],
    'A mineral for bones, muscles and nerves; its level is tightly controlled by hormones and the kidneys.',
    { altUnits: [{ unit: 'mmol/L', factor: 4.008 }, { unit: 'mEq/L', factor: 2.004 }], typical: { low: 8.5, high: 10.5 } }),
  def('magnesium', 'Magnesium', 'mg/dL', 'kidney', ['kidneys'],
    ['magnesium', 'mg', 'serum magnesium', 'magnesium serum', 's magnesium', 'mg++'],
    'A mineral used by muscles, nerves and hundreds of enzymes.',
    { altUnits: [{ unit: 'mmol/L', factor: 2.431 }, { unit: 'mEq/L', factor: 1.215 }], typical: { low: 1.6, high: 2.6 } }),
  def('phosphorus', 'Phosphorus', 'mg/dL', 'kidney', ['kidneys', 'marrow'],
    ['phosphorus', 'phosphate', 'inorganic phosphorus', 'serum phosphorus', 'phosphorus inorganic', 'phos', 'po4', 'serum phosphate', 'phosphorous'],
    'A mineral that works with calcium in bones and energy use.',
    { altUnits: [{ unit: 'mmol/L', factor: 3.097 }], typical: { low: 2.5, high: 4.5 } }),
];

const BLOOD: BiomarkerDef[] = [
  def('hemoglobin', 'Hemoglobin', 'g/dL', 'blood', ['marrow', 'spleen'],
    ['hemoglobin', 'haemoglobin', 'hb', 'hgb', 'hemoglobin hb', 'haemoglobin hb', 'hb haemoglobin', 'blood hemoglobin'],
    'The oxygen-carrying protein inside red blood cells.',
    { altUnits: [G_L, { unit: 'mmol/L', factor: 1.611 }], typical: { low: 12, high: 17 } }),
  def('rbc', 'Red blood cells', '10^6/µL', 'blood', ['marrow', 'spleen'],
    ['rbc', 'rbc count', 'red blood cells', 'red blood cell count', 'red cell count', 'total rbc count', 'rbc total', 'erythrocytes', 'erythrocyte count', 'total rbc', 'red blood cell', 'rbc red blood cell count'],
    'How many red cells, which carry oxygen, are in a small volume of blood.',
    { altUnits: [{ unit: 'cells/cumm', factor: 0.000001 }], typical: { low: 3.8, high: 5.8 } }),
  def('hematocrit', 'Hematocrit (PCV)', '%', 'blood', ['marrow', 'spleen'],
    ['hematocrit', 'haematocrit', 'hct', 'pcv', 'packed cell volume', 'hematocrit hct', 'pcv packed cell volume', 'packed cell volume pcv', 'hct pcv'],
    'The share of blood volume made up of red cells.',
    { altUnits: [{ unit: 'L/L', factor: 100 }], typical: { low: 36, high: 50 } }),
  def('mcv', 'MCV', 'fL', 'blood', ['marrow'],
    ['mcv', 'mean corpuscular volume', 'mean cell volume', 'mcv mean corpuscular volume'],
    'The average size of your red blood cells.',
    { typical: { low: 80, high: 100 } }),
  def('mch', 'MCH', 'pg', 'blood', ['marrow'],
    ['mch', 'mean corpuscular hemoglobin', 'mean cell hemoglobin', 'mean corpuscular haemoglobin', 'mch mean corpuscular hemoglobin'],
    'The average amount of hemoglobin in each red cell.',
    { typical: { low: 27, high: 33 } }),
  def('mchc', 'MCHC', 'g/dL', 'blood', ['marrow'],
    ['mchc', 'mean corpuscular hemoglobin concentration', 'mean cell hemoglobin concentration', 'mean corpuscular haemoglobin concentration', 'mchc mean corpuscular hemoglobin concentration'],
    'How concentrated the hemoglobin is inside red cells.',
    { altUnits: [G_L], typical: { low: 31.5, high: 36 } }),
  def('rdw', 'RDW-CV', '%', 'blood', ['marrow'],
    ['rdw', 'rdw cv', 'rdw-cv', 'red cell distribution width', 'red cell distribution width cv', 'rdw cv red cell distribution width', 'red blood cell distribution width'],
    'How much red cell sizes vary from one another.',
    { typical: { low: 11.5, high: 14.5 } }),
  def('rdw_sd', 'RDW-SD', 'fL', 'blood', ['marrow'],
    ['rdw sd', 'rdw-sd', 'red cell distribution width sd'],
    'Red cell size variation, expressed in femtolitres.',
    { typical: { low: 37, high: 54 } }),
  def('wbc', 'White blood cells', '10^3/µL', 'blood', ['marrow', 'spleen'],
    ['wbc', 'wbc count', 'white blood cells', 'white blood cell count', 'white cell count', 'tlc', 'total leucocyte count', 'total leukocyte count', 'total wbc count', 'leucocyte count', 'leukocyte count', 'leukocytes', 'leucocytes', 'total count', 'tc wbc', 'total leucocytes count', 'white blood cell', 'wbc total'],
    'The infection-fighting cells of the immune system.',
    { altUnits: CELLS_CUMM, typical: { low: 4, high: 11 } }),
  def('neutrophils_pct', 'Neutrophils %', '%', 'blood', ['marrow', 'spleen'],
    ['neutrophils', 'neutrophil', 'neutrophils %', 'neut', 'neu', 'polymorphs', 'polymorphonuclear', 'segmented neutrophils', 'neutrophils percent', 'pmn', 'segs', 'neutrophil percentage'],
    'The share of white cells that are neutrophils, the first responders to bacterial infection.',
    { typical: { low: 40, high: 80 } }),
  def('lymphocytes_pct', 'Lymphocytes %', '%', 'blood', ['marrow', 'spleen'],
    ['lymphocytes', 'lymphocyte', 'lymphocytes %', 'lymph', 'lym', 'lymphs', 'lymphocytes percent', 'lymphocyte percentage'],
    'The share of white cells that are lymphocytes, which make antibodies and fight viruses.',
    { typical: { low: 20, high: 40 } }),
  def('monocytes_pct', 'Monocytes %', '%', 'blood', ['marrow', 'spleen'],
    ['monocytes', 'monocyte', 'monocytes %', 'mono', 'mon', 'monos', 'monocytes percent', 'monocyte percentage'],
    'The share of white cells that are monocytes, which clean up debris and germs.',
    { typical: { low: 2, high: 10 } }),
  def('eosinophils_pct', 'Eosinophils %', '%', 'blood', ['marrow', 'spleen'],
    ['eosinophils', 'eosinophil', 'eosinophils %', 'eos', 'eosinophils percent', 'eosinophil percentage', 'esinophils', 'eo', 'eo%'],
    'The share of white cells that are eosinophils, involved in allergies and parasites.',
    { typical: { high: 6 } }),
  def('basophils_pct', 'Basophils %', '%', 'blood', ['marrow', 'spleen'],
    ['basophils', 'basophil', 'basophils %', 'baso', 'bas', 'basophils percent', 'basophil percentage'],
    'The share of white cells that are basophils, a small group involved in allergic reactions.',
    { typical: { high: 2 } }),
  def('neutrophils_abs', 'Neutrophils (absolute)', '10^3/µL', 'blood', ['marrow', 'spleen'],
    ['absolute neutrophil count', 'anc', 'neutrophils absolute', 'absolute neutrophils', 'neutrophil absolute count', 'neutrophils absolute count', 'absolute neutrophil', 'neut absolute', 'neutrophil count absolute'],
    'The actual number of neutrophils in a small volume of blood.',
    { altUnits: CELLS_CUMM, typical: { low: 2, high: 7 } }),
  def('lymphocytes_abs', 'Lymphocytes (absolute)', '10^3/µL', 'blood', ['marrow', 'spleen'],
    ['absolute lymphocyte count', 'alc', 'lymphocytes absolute', 'absolute lymphocytes', 'lymphocyte absolute count', 'lymphocytes absolute count', 'absolute lymphocyte', 'lymph absolute', 'lym absolute'],
    'The actual number of lymphocytes in a small volume of blood.',
    { altUnits: CELLS_CUMM, typical: { low: 1, high: 3 } }),
  def('monocytes_abs', 'Monocytes (absolute)', '10^3/µL', 'blood', ['marrow', 'spleen'],
    ['absolute monocyte count', 'amc', 'monocytes absolute', 'absolute monocytes', 'monocyte absolute count', 'monocytes absolute count', 'absolute monocyte', 'mono absolute', 'mon absolute'],
    'The actual number of monocytes in a small volume of blood.',
    { altUnits: CELLS_CUMM, typical: { low: 0.2, high: 1 } }),
  def('eosinophils_abs', 'Eosinophils (absolute)', '10^3/µL', 'blood', ['marrow', 'spleen'],
    ['absolute eosinophil count', 'aec', 'eosinophils absolute', 'absolute eosinophils', 'eosinophil absolute count', 'eosinophils absolute count', 'absolute eosinophil', 'eos absolute', 'eo absolute', 'eo#'],
    'The actual number of eosinophils in a small volume of blood.',
    { altUnits: CELLS_CUMM, typical: { high: 0.5 } }),
  def('basophils_abs', 'Basophils (absolute)', '10^3/µL', 'blood', ['marrow', 'spleen'],
    ['absolute basophil count', 'abc', 'basophils absolute', 'absolute basophils', 'basophil absolute count', 'basophils absolute count', 'absolute basophil', 'baso absolute'],
    'The actual number of basophils in a small volume of blood.',
    { altUnits: CELLS_CUMM, typical: { high: 0.1 } }),
  def('platelets', 'Platelets', '10^3/µL', 'blood', ['marrow', 'spleen'],
    ['platelets', 'platelet', 'platelet count', 'plt', 'plt count', 'platelet count plt', 'thrombocytes', 'thrombocyte count', 'total platelet count', 'platelets count'],
    'Small cell fragments that help blood clot.',
    { altUnits: [{ unit: 'lakhs/cumm', factor: 100 }, { unit: 'lakh/cumm', factor: 100 }, { unit: 'lakhs/µL', factor: 100 }, ...CELLS_CUMM], typical: { low: 150, high: 410 } }),
  def('mpv', 'MPV', 'fL', 'blood', ['marrow'],
    ['mpv', 'mean platelet volume', 'mpv mean platelet volume'],
    'The average size of your platelets.',
    { typical: { low: 7.5, high: 11.5 } }),
];

const NUTRITION: BiomarkerDef[] = [
  def('iron', 'Iron', 'µg/dL', 'nutrition', ['marrow', 'intestine'],
    ['iron', 'serum iron', 'iron serum', 'fe', 's iron', 'iron total'],
    'Iron circulating in the blood, used to build hemoglobin.',
    { altUnits: [{ unit: 'µmol/L', factor: 5.585 }], typical: { low: 50, high: 170 } }),
  def('tibc', 'TIBC', 'µg/dL', 'nutrition', ['marrow', 'intestine'],
    ['tibc', 'total iron binding capacity', 'iron binding capacity total', 'iron binding capacity', 'tibc total iron binding capacity'],
    'How much iron the blood proteins could carry; it tends to rise when iron stores are low.',
    { altUnits: [{ unit: 'µmol/L', factor: 5.585 }], typical: { low: 250, high: 450 } }),
  def('uibc', 'UIBC', 'µg/dL', 'nutrition', ['marrow', 'intestine'],
    ['uibc', 'unsaturated iron binding capacity', 'unbound iron binding capacity'],
    'The spare iron-carrying capacity in the blood that is not yet filled.',
    { altUnits: [{ unit: 'µmol/L', factor: 5.585 }], typical: { low: 110, high: 370 } }),
  def('transferrin_sat', 'Transferrin saturation', '%', 'nutrition', ['marrow', 'intestine'],
    ['transferrin saturation', 'tsat', 'iron saturation', 'percent saturation', '% saturation', 'saturation', 'transferrin saturation %', 'iron saturation %', 'tibc saturation', 'saturation transferrin'],
    'The share of the blood’s iron carrier that is filled with iron.',
    { typical: { low: 20, high: 50 } }),
  def('ferritin', 'Ferritin', 'ng/mL', 'nutrition', ['marrow', 'intestine', 'liver'],
    ['ferritin', 'serum ferritin', 'ferritin serum', 's ferritin'],
    'A protein that stores iron; it reflects the body’s iron reserves and also rises with inflammation.',
    { altUnits: [{ unit: 'pmol/L', factor: 0.445 }], typical: { low: 15, high: 300 } }),
  def('vitamin_d', 'Vitamin D (25-OH)', 'ng/mL', 'nutrition', ['intestine', 'skin'],
    ['vitamin d', '25 oh vitamin d', '25-oh vitamin d', '25 hydroxy vitamin d', '25-hydroxy vitamin d', '25 hydroxyvitamin d', '25-hydroxyvitamin d', 'vitamin d total', 'vitamin d 25 hydroxy', 'vitamin d3', 'vit d', 'vit d3', 'vitamin d 25 oh', 'total vitamin d', '25 oh d', 'cholecalciferol', 'vitamin d2 d3', '25 oh vit d', 'vitamin d 25 hydroxy total', '25 hydroxy cholecalciferol'],
    'Made in the skin from sunlight and absorbed from food; important for bones and muscles.',
    { altUnits: [{ unit: 'nmol/L', factor: 0.4006 }], typical: { low: 30, high: 100 } }),
  def('vitamin_b12', 'Vitamin B12', 'pg/mL', 'nutrition', ['intestine', 'stomach'],
    ['vitamin b12', 'vit b12', 'b12', 'cobalamin', 'cyanocobalamin', 'vitamin b 12', 'serum b12', 'vitamin b12 cyanocobalamin', 'b 12', 'serum vitamin b12'],
    'A vitamin for nerves and red-cell production; absorbing it relies on the stomach and small intestine.',
    { altUnits: [{ unit: 'pmol/L', factor: 1.355 }, { unit: 'ng/L', factor: 1 }], typical: { low: 200, high: 900 } }),
  def('folate', 'Folate', 'ng/mL', 'nutrition', ['intestine', 'marrow'],
    ['folate', 'folic acid', 'serum folate', 'vitamin b9', 'folate serum', 'serum folic acid', 'vit b9'],
    'A B vitamin needed to make new cells, including red blood cells.',
    { altUnits: [{ unit: 'nmol/L', factor: 0.441 }, { unit: 'µg/L', factor: 1 }], typical: { low: 4 } }),
];

const THYROID: BiomarkerDef[] = [
  def('tsh', 'TSH', 'µIU/mL', 'thyroid', ['thyroid', 'brain'],
    ['tsh', 'thyroid stimulating hormone', 'thyrotropin', 'tsh ultrasensitive', 'ultrasensitive tsh', 'us tsh', 'tsh 3rd generation', 'third generation tsh', 'tsh 3rd gen', 'serum tsh', 'hs tsh', 'tsh serum', 'thyroid stimulating hormone tsh'],
    'A signal from the pituitary gland telling the thyroid how hard to work.',
    { typical: { low: 0.4, high: 4.5 } }),
  def('t3', 'Total T3', 'ng/dL', 'thyroid', ['thyroid'],
    ['t3', 'total t3', 't3 total', 'triiodothyronine', 'total triiodothyronine', 'triiodothyronine total', 'tt3', 'serum t3', 't3 triiodothyronine'],
    'The active thyroid hormone, measured as both bound and free forms.',
    { altUnits: [{ unit: 'ng/mL', factor: 100 }, { unit: 'nmol/L', factor: 65.1 }], typical: { low: 80, high: 200 } }),
  def('t4', 'Total T4', 'µg/dL', 'thyroid', ['thyroid'],
    ['t4', 'total t4', 't4 total', 'thyroxine', 'total thyroxine', 'thyroxine total', 'tt4', 'serum t4', 't4 thyroxine'],
    'The main hormone released by the thyroid, measured as both bound and free forms.',
    { altUnits: [{ unit: 'nmol/L', factor: 0.0777 }], typical: { low: 5, high: 12.5 } }),
  def('ft3', 'Free T3', 'pg/mL', 'thyroid', ['thyroid'],
    ['free t3', 'ft3', 't3 free', 'free triiodothyronine', 'triiodothyronine free', 'ft 3'],
    'The unbound, active form of T3 available to the body’s cells.',
    { altUnits: [{ unit: 'pmol/L', factor: 0.651 }], typical: { low: 2, high: 4.4 } }),
  def('ft4', 'Free T4', 'ng/dL', 'thyroid', ['thyroid'],
    ['free t4', 'ft4', 't4 free', 'free thyroxine', 'thyroxine free', 'ft 4'],
    'The unbound form of T4 available to the body’s cells.',
    { altUnits: [{ unit: 'pmol/L', factor: 0.0777 }], typical: { low: 0.8, high: 1.8 } }),
];

const HORMONES: BiomarkerDef[] = [
  def('testosterone', 'Testosterone (total)', 'ng/dL', 'hormones', ['brain'],
    ['testosterone', 'total testosterone', 'testosterone total', 'serum testosterone', 'testosterone serum'],
    'A sex hormone made mainly by the testes or ovaries, under control of the pituitary gland in the brain. Ranges differ a lot by sex.',
    { altUnits: [{ unit: 'ng/mL', factor: 100 }, { unit: 'nmol/L', factor: 28.84 }] }),
  def('cortisol', 'Cortisol', 'µg/dL', 'hormones', ['kidneys', 'brain'],
    ['cortisol', 'serum cortisol', 'cortisol morning', 'morning cortisol', 'cortisol am', 'am cortisol', 'cortisol serum', 'cortisol 8 am'],
    'A stress hormone from the adrenal glands, which sit on top of the kidneys; it is highest in the morning.',
    { altUnits: [{ unit: 'nmol/L', factor: 0.03625 }], typical: { low: 5, high: 23 } }),
];

const URINE: BiomarkerDef[] = [
  def('urine_ph', 'Urine pH', 'pH', 'urine', ['kidneys'],
    ['urine ph', 'ph', 'reaction', 'urine reaction', 'reaction ph', 'ph urine'],
    'How acidic or alkaline your urine is; it shifts with diet and hydration.',
    { typical: { low: 4.5, high: 8 } }),
  def('urine_sg', 'Urine specific gravity', '', 'urine', ['kidneys'],
    ['specific gravity', 'urine specific gravity', 'sp gravity', 'sp gr', 'sg', 'urine sg', 'specific gravity urine'],
    'How concentrated your urine is; it reflects how much water you have been drinking.',
    { typical: { low: 1.005, high: 1.03 } }),
  def('urine_protein', 'Urine protein', 'mg/dL', 'urine', ['kidneys'],
    ['urine protein', 'urine albumin', 'protein urine', 'albumin urine', 'urine proteins', 'urine protein dipstick'],
    'Healthy kidneys keep almost all protein out of urine, so dipsticks usually read negative.',
    { typical: { high: 15 }, lowerIsBetter: true }),
  def('urine_glucose', 'Urine glucose', 'mg/dL', 'urine', ['kidneys'],
    ['urine glucose', 'urine sugar', 'glucose urine', 'sugar urine'],
    'Sugar spills into urine only when blood sugar is high, so this usually reads negative.',
    { typical: { high: 15 }, lowerIsBetter: true }),
  def('urine_ketones', 'Urine ketones', 'mg/dL', 'urine', ['kidneys'],
    ['urine ketones', 'urine ketone', 'ketone bodies', 'ketones', 'ketone', 'urine ketone bodies', 'acetone'],
    'Made when the body burns fat for fuel, for example after fasting; usually negative.',
    { typical: { high: 5 }, lowerIsBetter: true }),
  def('urine_rbc', 'Urine red cells', '/hpf', 'urine', ['kidneys'],
    ['urine rbc', 'urine red blood cells', 'urine red cells', 'rbc urine', 'urine erythrocytes', 'red blood cells urine', 'urine blood'],
    'Red cells seen under the microscope in urine; a few can be normal.',
    { typical: { high: 2 }, lowerIsBetter: true }),
  def('urine_pus_cells', 'Urine pus cells (WBC)', '/hpf', 'urine', ['kidneys'],
    ['pus cells', 'pus cell', 'urine pus cells', 'urine wbc', 'urine white blood cells', 'wbc urine', 'pus cells wbc', 'urine leukocytes', 'leukocytes urine', 'urine pus cell', 'urine leucocytes', 'leukocyte esterase'],
    'White cells seen in urine; a few are normal and more can appear with irritation or infection.',
    { typical: { high: 5 }, lowerIsBetter: true }),
  def('urine_nitrite', 'Urine nitrite', '', 'urine', ['kidneys'],
    ['nitrite', 'nitrites', 'urine nitrite', 'urine nitrites', 'nitrite urine'],
    'Some bacteria turn nitrate into nitrite, so a positive result can point to bacteria in urine.',
    { lowerIsBetter: true }),
];

export const BIOMARKERS: BiomarkerDef[] = [
  ...LIPIDS, ...METABOLIC, ...CARDIAC, ...INFLAMMATION, ...LIVER, ...KIDNEY,
  ...BLOOD, ...NUTRITION, ...THYROID, ...HORMONES, ...URINE,
];

const BY_ID = new Map(BIOMARKERS.map(b => [b.id, b]));

export function findMarker(id: string | null | undefined): BiomarkerDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/* ---------------- name matching ---------------- */

const UNIT_IN_NAME = /\b(?:m?mol|[mnpu]?g|gm|m?iu|u|meq|cells|mill(?:ion)?s?|thou(?:sand)?|lakhs?|x?10\^?\d+)\s*\/\s*(?:d?l|ml|cumm|cu\s*mm|mm3|ul|hpf|lpf)\b/g;
const FILLER_EDGE = new Set(['s', 'serum', 'plasma']);
const FILLER_ANY = new Set(['level', 'value', 'result', 'test', 'estimation', 'calculated', 'calc', 'method']);
/** Words that change the meaning of a name; a contained alias must also carry them. */
const QUALIFIER_WORDS = ['ratio', 'ionized', 'ionised', 'ionic', 'urine', 'urinary', 'free', 'index', 'non', 'absolute', 'dihydroxy', 'reverse', 'spot', 'csf', 'fluid', 'antibody', 'antibodies', 'anti', 'microalbumin', 'distribution', 'width', 'large', 'nucleated', 'immature', 'reticulocyte', 'electrophoresis', 'clearance', 'tolerance', 'gtt', 'challenge', 'hr', 'hour', 'excretion', 'creatinine', 'globulin', 'albumin', 'unsaturated', 'sd', 'transferrin', 'binding', 'pp', 'random', 'fasting', 'post', 'postprandial', 'prandial', 'direct', 'indirect', 'total', 'uptake', 'receptor', 'stool', 'faecal', 'fecal', 'semen'];
/** Qualifiers that may be ignored when no other alias carries them (e.g. "Calcium Total" → calcium). */
const SOFT_QUALIFIER_WORDS = ['direct', 'total', 'fasting'];
/** Aliases that are only trusted as an exact match, never inside a longer name. */
const EXACT_ONLY = new Set(['mon', 'neu', 'lym', 'bas', 'eos', 'sap', 'got', 'gpt', 'abc', 'alc', 'amc', 'aec', 'anc', 'alb', 'glob', 'chol', 'trig', 'tni', 'tnt', 'hcy', 'co2', 'tco2', 'saturation', 'reaction', 'protein', 'ketone', 'ketones', 'fbg', 'ppg', 'rbg', 'abg', 'mbg', 'homa', 'ggtp', 'hct', 'tlc', 'tibc saturation']);

function singular(w: string): string {
  return w.length >= 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') ? w.slice(0, -1) : w;
}

/** Normalize a test name: lower-case, strip units/brackets/punctuation, unify spellings. */
export function normalizeName(raw: string): string {
  let s = raw.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[µμ]/g, 'u').replace(/#/g, ' absolute ').replace(/\babs\b\.?/g, ' absolute ');
  s = s.replace(/\b(?:[a-z]\.){2,}[a-z]?\b\.?/g, m => m.replace(/\./g, ''));
  s = s.replace(UNIT_IN_NAME, ' ');
  s = s.replace(/\b(esr|sedimentation rate)\b(.*?)\b(?:1st|first|1)\s*(?:hr|hour)\b/, '$1$2');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  s = s.replace(/\bhaem/g, 'hem').replace(/\bleuc/g, 'leuk').replace(/\bcholestrol\b/g, 'cholesterol')
    .replace(/\boesino|\besino(?=phil)/g, 'eosino').replace(/\bvit\b/g, 'vitamin').replace(/\bthyroxin\b/g, 'thyroxine')
    .replace(/\bpost prandial\b/g, 'postprandial').replace(/\bmicro albumin\b/g, 'microalbumin').replace(/\bglycosylated\b/g, 'glycated').replace(/\btri iodo/g, 'triiodo');
  const words = s.split(' ').filter(Boolean).map(singular);
  while (words.length > 1 && FILLER_EDGE.has(words[0])) words.shift();
  while (words.length > 1 && FILLER_EDGE.has(words[words.length - 1])) words.pop();
  return words.filter((w, i) => i === 0 || !FILLER_ANY.has(singular(w))).join(' ');
}

const normWord = (w: string) => normalizeName(w);
const QUALIFIERS = new Set(QUALIFIER_WORDS.map(normWord));
const SOFT_QUALIFIERS = new Set(SOFT_QUALIFIER_WORDS.map(normWord));

interface AliasEntry { alias: string; def: BiomarkerDef; words: Set<string> }
const ALIASES: AliasEntry[] = [];
const EXACT = new Map<string, BiomarkerDef>();
for (const b of BIOMARKERS) {
  for (const a of b.aliases) {
    const n = normalizeName(a);
    if (!n) continue;
    if (!EXACT.has(n)) EXACT.set(n, b);
    if (n.length <= 2 || EXACT_ONLY.has(n) || EXACT_ONLY.has(a)) continue;
    ALIASES.push({ alias: n, def: b, words: new Set(n.split(' ')) });
  }
}
ALIASES.sort((x, y) => y.alias.length - x.alias.length);

export interface MatchContext {
  /** Section the row was found in; 'urine' prefers urinalysis markers for ambiguous names like "Glucose". */
  section?: 'urine' | null;
}

/** Words that mark a line as prose/notes rather than a test name; they block contained matches. */
const BLOCKERS = new Set(['note', 'notes', 'interpretation', 'table', 'comment', 'deficiency', 'deficient', 'anemia', 'anaemia', 'method', 'guideline', 'reference', 'disease', 'disorder', 'overload', 'profile', 'panel', 'function', 'kit', 'package', 'screening', 'study', 'advised', 'please', 'consult'].map(w => normalizeName(w)));

function containedMatch(n: string, pool: AliasEntry[]): AliasEntry | null {
  const padded = ` ${n} `;
  const words = n.split(' ');
  if (words.some(w => BLOCKERS.has(w))) return null;
  for (const e of pool) {
    if (!padded.includes(` ${e.alias} `)) continue;
    // Reject if the raw name carries a meaning-changing word the alias lacks.
    const missing = words.filter(w => QUALIFIERS.has(w) && !e.words.has(w));
    if (missing.some(w => !SOFT_QUALIFIERS.has(w))) continue;
    if (missing.length) {
      // Soft qualifiers are fine unless another contained alias explicitly carries that word.
      const better = pool.find(o => o.def !== e.def && padded.includes(` ${o.alias} `) && missing.every(w => o.words.has(w))
        && !words.some(w => QUALIFIERS.has(w) && !o.words.has(w) && !SOFT_QUALIFIERS.has(w)));
      if (better) return better;
    }
    return e;
  }
  return null;
}

const URINE_POOL = ALIASES.filter(a => a.def.system === 'urine');
/** Names that look like a marker but are something else (tumour markers "CA 125", vitamin K...). */
const NOT_A_MARKER = /^(?:ca \d|ca 19|vitamin [ack]\b(?! ?\d)|cea\b|psa\b|afp\b|page\b|ref\b|dr\b|reg\b)/;

export interface MarkerMatch {
  def: BiomarkerDef;
  /** Normalized alias that matched. */
  alias: string;
  /** Normalized input name. */
  name: string;
  exact: boolean;
}

/** Like matchMarkerName, but also reports which alias matched and whether it was exact. */
export function matchMarkerDetailed(raw: string, ctx: MatchContext = {}): MarkerMatch | null {
  const n = normalizeName(raw);
  if (!n || n.length > 90 || n.split(' ').length > 10 || NOT_A_MARKER.test(n)) return null;
  if (ctx.section === 'urine') {
    const u = EXACT.get(`urine ${n}`);
    if (u && u.system === 'urine') return { def: u, alias: n, name: n, exact: true };
    const ex = EXACT.get(n);
    if (ex && ex.system === 'urine') return { def: ex, alias: n, name: n, exact: true };
    const c = containedMatch(`urine ${n}`, URINE_POOL);
    if (c) return { def: c.def, alias: c.alias.replace(/^urine /, ''), name: n, exact: false };
  }
  const exact = EXACT.get(n);
  if (exact) return { def: exact, alias: n, name: n, exact: true };
  const c = containedMatch(n, ALIASES);
  return c ? { def: c.def, alias: c.alias, name: n, exact: false } : null;
}

/**
 * Match a raw test name to a catalog marker. Exact alias first, then the longest alias contained as
 * a whole-word phrase (so "Non-HDL Cholesterol" never matches HDL). Returns null when nothing
 * matches confidently.
 */
export function matchMarkerName(raw: string, ctx: MatchContext = {}): BiomarkerDef | null {
  return matchMarkerDetailed(raw, ctx)?.def ?? null;
}

/** Percent ↔ absolute white-cell pairs, used to correct a match using the printed unit. */
export const PERCENT_ABSOLUTE_PAIRS: Record<string, string> = {
  neutrophils_pct: 'neutrophils_abs', lymphocytes_pct: 'lymphocytes_abs', monocytes_pct: 'monocytes_abs',
  eosinophils_pct: 'eosinophils_abs', basophils_pct: 'basophils_abs',
};
