import type { OrganId, SystemId } from '../types';

/** Coordinates are metres in the model: +x = the person's left, +y = up, +z = front. */
export type Vec3 = [number, number, number];

export type Tissue =
  | 'myocardium' | 'valve' | 'artery' | 'vein' | 'portal' | 'brain' | 'lung' | 'cartilage' | 'liver' | 'bile'
  | 'gallbladder' | 'stomach' | 'spleen' | 'pancreas' | 'cortex' | 'medulla' | 'urothelium' | 'adrenal' | 'bladder'
  | 'smallgut' | 'colon' | 'thyroid' | 'esophagus' | 'bone' | 'diaphragm' | 'skin';

export interface MeshSpec {
  id: string;          // node name in anatomy.glb
  tissue: Tissue;
  /** Shell whose inside should be visible in cross-sections (renders its back faces as cut tissue). */
  hollow?: boolean;
  /** Part that becomes see-through in x-ray mode so inner structures show. */
  shell?: boolean;
}

export interface Landmark { name: string; at: Vec3; note: string }

export interface OrganSpec {
  id: OrganId;
  name: string;
  short: string;
  meshes: MeshSpec[];
  /** Meshes used to frame the camera when the organ is opened. */
  focus: string[];
  /** Where the status pin sits on the overview. */
  pin: Vec3;
  /** Camera direction to view from when opened (unit-ish vector from target toward camera). */
  view: Vec3;
  systems: SystemId[];
  summary: string;
  facts: { label: string; value: string }[];
  landmarks: Landmark[];
}

export const TISSUE: Record<Tissue, { color: string; rough: number; clear: number; sheen?: string; inner?: string; opacity?: number }> = {
  myocardium: { color: '#a3302b', rough: 0.42, clear: 0.55, sheen: '#ff9a8a', inner: '#5a1513' },
  valve: { color: '#eedcc0', rough: 0.5, clear: 0.3 },
  artery: { color: '#c5352d', rough: 0.35, clear: 0.7, sheen: '#ff8f80' },
  vein: { color: '#3d5cb3', rough: 0.35, clear: 0.7, sheen: '#8aa4ff' },
  portal: { color: '#6a4ea6', rough: 0.35, clear: 0.7 },
  brain: { color: '#e4b0a8', rough: 0.62, clear: 0.25, sheen: '#ffd6cf', inner: '#c98a83' },
  lung: { color: '#efa7b2', rough: 0.55, clear: 0.2, opacity: 0.42 },
  cartilage: { color: '#efe4d2', rough: 0.45, clear: 0.35 },
  liver: { color: '#7a2b20', rough: 0.3, clear: 0.85, sheen: '#c2584a', inner: '#4e1912' },
  bile: { color: '#7fa346', rough: 0.35, clear: 0.6 },
  gallbladder: { color: '#5c8c3a', rough: 0.25, clear: 0.95 },
  stomach: { color: '#d99686', rough: 0.45, clear: 0.6, sheen: '#ffc4b5', inner: '#b8665a' },
  spleen: { color: '#6b2644', rough: 0.35, clear: 0.7, sheen: '#b0507a' },
  pancreas: { color: '#e2bd78', rough: 0.68, clear: 0.2, sheen: '#ffe2a8' },
  cortex: { color: '#8f362e', rough: 0.35, clear: 0.7, sheen: '#d0675a', inner: '#7a2a23' },
  medulla: { color: '#5e1d19', rough: 0.5, clear: 0.3 },
  urothelium: { color: '#e8d09d', rough: 0.45, clear: 0.4 },
  adrenal: { color: '#d69f3c', rough: 0.55, clear: 0.3 },
  bladder: { color: '#dfc28c', rough: 0.4, clear: 0.6 },
  smallgut: { color: '#e2a294', rough: 0.45, clear: 0.6, sheen: '#ffd0c4' },
  colon: { color: '#c39270', rough: 0.5, clear: 0.45, sheen: '#e8bc98' },
  thyroid: { color: '#b4534a', rough: 0.4, clear: 0.6, sheen: '#e88a7d' },
  esophagus: { color: '#c7867d', rough: 0.45, clear: 0.5 },
  bone: { color: '#ebe1cc', rough: 0.55, clear: 0.15 },
  diaphragm: { color: '#a8473f', rough: 0.5, clear: 0.3, opacity: 0.22 },
  skin: { color: '#8fd3dc', rough: 1, clear: 0 },
};

export const ORGANS: OrganSpec[] = [
  {
    id: 'brain', name: 'Brain', short: 'Brain',
    meshes: [{ id: 'brain', tissue: 'brain', hollow: true }], focus: ['brain'], pin: [0.035, 1.725, 0.02], view: [0.55, 0.25, 0.8],
    systems: [], summary: 'Two cerebral hemispheres, the cerebellum and the brainstem. Routine blood tests do not measure brain structure.',
    facts: [{ label: 'Weight', value: 'about 1.3–1.4 kg' }, { label: 'Blood flow', value: 'about 15% of cardiac output' }],
    landmarks: [
      { name: 'Frontal lobe', at: [0.03, 1.70, 0.06], note: 'Planning, decision-making and voluntary movement.' },
      { name: 'Longitudinal fissure', at: [0, 1.735, 0.0], note: 'Deep groove separating the left and right hemispheres.' },
      { name: 'Temporal lobe', at: [0.068, 1.640, 0.012], note: 'Hearing, language and memory.' },
      { name: 'Cerebellum', at: [0.03, 1.615, -0.085], note: 'Balance and coordination; note the fine folia.' },
      { name: 'Brainstem', at: [0, 1.585, -0.03], note: 'Connects the brain to the spinal cord; controls breathing and heart rate.' },
      { name: 'Lateral ventricles', at: [0.015, 1.69, -0.01], note: 'Fluid-filled spaces; visible in cross-section.' },
    ],
  },
  {
    id: 'thyroid', name: 'Thyroid gland', short: 'Thyroid',
    meshes: [{ id: 'thyroid', tissue: 'thyroid' }], focus: ['thyroid', 'airway'], pin: [0.026, 1.465, 0.027], view: [0.25, 0.1, 1],
    systems: ['thyroid'], summary: 'A butterfly-shaped gland wrapped around the front of the windpipe. TSH, T3 and T4 reflect how its hormone output is regulated.',
    facts: [{ label: 'Weight', value: 'about 15–25 g' }, { label: 'Hormones', value: 'T4, T3, calcitonin' }],
    landmarks: [
      { name: 'Right lobe', at: [-0.022, 1.468, 0.022], note: 'Each lobe sits beside the trachea.' },
      { name: 'Left lobe', at: [0.022, 1.468, 0.022], note: 'Each lobe sits beside the trachea.' },
      { name: 'Isthmus', at: [0, 1.450, 0.031], note: 'Bridge of tissue crossing in front of the trachea.' },
      { name: 'Larynx', at: [0, 1.512, 0.045], note: 'Voice box, just above the gland.' },
    ],
  },
  {
    id: 'airway', name: 'Larynx & trachea', short: 'Airway',
    meshes: [{ id: 'airway', tissue: 'cartilage' }], focus: ['airway'], pin: [0, 1.40, 0.0], view: [0.3, 0.1, 1],
    systems: [], summary: 'The airway from the voice box down to the two main bronchi.', facts: [{ label: 'Trachea length', value: 'about 10–12 cm' }],
    landmarks: [{ name: 'Carina', at: [0, 1.345, -0.022], note: 'Where the trachea splits into left and right bronchi.' }],
  },
  {
    id: 'lungs', name: 'Lungs', short: 'Lungs',
    meshes: [{ id: 'lung_r', tissue: 'lung', shell: true }, { id: 'lung_l', tissue: 'lung', shell: true }, { id: 'bronchi', tissue: 'cartilage' }, { id: 'diaphragm', tissue: 'diaphragm' }],
    focus: ['lung_r', 'lung_l'], pin: [-0.095, 1.37, 0.045], view: [0.2, 0.15, 1],
    systems: [], summary: 'The right lung has three lobes and the left has two, making room for the heart. Blood tests rarely measure the lungs directly; imaging and breathing tests do.',
    facts: [{ label: 'Lobes', value: '3 right, 2 left' }, { label: 'Surface for gas exchange', value: 'about 70 m²' }],
    landmarks: [
      { name: 'Upper lobe', at: [-0.085, 1.42, 0.03], note: 'Separated from the lower lobe by the oblique fissure.' },
      { name: 'Middle lobe', at: [-0.10, 1.29, 0.055], note: 'Right lung only, below the horizontal fissure.' },
      { name: 'Lower lobe', at: [-0.11, 1.26, -0.06], note: 'The largest lobe, resting on the diaphragm.' },
      { name: 'Cardiac notch', at: [0.06, 1.28, 0.06], note: 'Indent in the left lung where the heart sits.' },
      { name: 'Bronchial tree', at: [0.07, 1.33, -0.02], note: 'Airways branch about 23 times before reaching the air sacs.' },
      { name: 'Diaphragm', at: [0.03, 1.20, 0.06], note: 'The main breathing muscle, domed under the lungs.' },
    ],
  },
  {
    id: 'heart', name: 'Heart & vessels', short: 'Heart',
    meshes: [
      { id: 'heart', tissue: 'myocardium', hollow: true, shell: true }, { id: 'valves', tissue: 'valve' }, { id: 'coronary', tissue: 'artery' },
      { id: 'cardiac_veins', tissue: 'vein' }, { id: 'arteries', tissue: 'artery' }, { id: 'veins', tissue: 'vein' },
    ],
    focus: ['heart'], pin: [0.065, 1.27, 0.062], view: [0.35, 0.12, 1],
    systems: ['heart', 'metabolic', 'inflammation'], summary: 'A four-chambered muscular pump with its own coronary blood supply. Lipids, apolipoproteins, troponins, NT-proBNP and hs-CRP relate to the heart and arteries but are not images of them.',
    facts: [{ label: 'Size', value: 'about a closed fist' }, { label: 'Output at rest', value: 'about 5 L per minute' }, { label: 'Wall of left ventricle', value: 'about 1 cm thick' }],
    landmarks: [
      { name: 'Left ventricle', at: [0.045, 1.272, 0.02], note: 'Thickest chamber; pumps blood to the whole body.' },
      { name: 'Right ventricle', at: [0.005, 1.282, 0.052], note: 'Pumps blood to the lungs.' },
      { name: 'Right atrium', at: [-0.055, 1.305, 0.01], note: 'Receives blood from the body via the venae cavae.' },
      { name: 'Left atrium', at: [0.02, 1.338, -0.035], note: 'Receives oxygenated blood from the lungs.' },
      { name: 'Aortic arch', at: [0.006, 1.410, -0.018], note: 'Main artery leaving the heart, curving over to the left.' },
      { name: 'Pulmonary trunk', at: [0.02, 1.352, 0.040], note: 'Carries blood from the right ventricle to the lungs.' },
      { name: 'Coronary arteries', at: [0.045, 1.282, 0.066], note: 'Supply the heart muscle itself; the LAD runs down the front.' },
      { name: 'Superior vena cava', at: [-0.036, 1.40, 0.004], note: 'Returns blood from the head and arms.' },
      { name: 'Apex', at: [0.078, 1.243, 0.058], note: 'Tip of the heart, pointing down and to the left.' },
    ],
  },
  {
    id: 'esophagus', name: 'Esophagus', short: 'Esophagus',
    meshes: [{ id: 'esophagus', tissue: 'esophagus' }], focus: ['esophagus'], pin: [0.004, 1.38, -0.04], view: [0.8, 0.1, 0.6],
    systems: [], summary: 'Muscular tube carrying food from the throat, behind the heart, to the stomach.', facts: [{ label: 'Length', value: 'about 25 cm' }],
    landmarks: [{ name: 'Gastro-oesophageal junction', at: [0.03, 1.212, -0.01], note: 'Where the esophagus joins the stomach below the diaphragm.' }],
  },
  {
    id: 'liver', name: 'Liver & gallbladder', short: 'Liver',
    meshes: [
      { id: 'liver', tissue: 'liver', shell: true }, { id: 'gallbladder', tissue: 'gallbladder' }, { id: 'hepatic_veins', tissue: 'vein' },
      { id: 'portal_vein', tissue: 'portal' }, { id: 'bile_ducts', tissue: 'bile' },
    ],
    focus: ['liver'], pin: [-0.10, 1.19, 0.05], view: [-0.45, 0.1, 1],
    systems: ['liver'], summary: 'The largest internal organ, under the right ribs. ALT, AST, ALP, GGT, bilirubin and blood proteins relate to how it is working.',
    facts: [{ label: 'Weight', value: 'about 1.5 kg' }, { label: 'Blood supply', value: '75% portal vein, 25% hepatic artery' }],
    landmarks: [
      { name: 'Right lobe', at: [-0.10, 1.20, 0.04], note: 'Much the larger lobe.' },
      { name: 'Left lobe', at: [0.04, 1.225, 0.05], note: 'Thinner lobe extending across the midline over the stomach.' },
      { name: 'Gallbladder', at: [-0.068, 1.108, 0.075], note: 'Stores bile; its tip peeks below the liver edge.' },
      { name: 'Hepatic veins', at: [-0.03, 1.238, -0.005], note: 'Drain the liver into the inferior vena cava.' },
      { name: 'Portal vein', at: [-0.02, 1.13, 0.004], note: 'Brings nutrient-rich blood from the gut.' },
      { name: 'Common bile duct', at: [-0.05, 1.095, 0.014], note: 'Carries bile down to the small intestine.' },
    ],
  },
  {
    id: 'stomach', name: 'Stomach', short: 'Stomach',
    meshes: [{ id: 'stomach', tissue: 'stomach' }], focus: ['stomach'], pin: [0.092, 1.15, 0.045], view: [0.5, 0.1, 1],
    systems: ['nutrition'], summary: 'J-shaped muscular sac below the left dome of the diaphragm. Its lining makes the intrinsic factor needed to absorb vitamin B12.',
    facts: [{ label: 'Capacity', value: 'about 1–1.5 L' }],
    landmarks: [
      { name: 'Fundus', at: [0.062, 1.236, -0.02], note: 'Dome-shaped top under the diaphragm.' },
      { name: 'Body', at: [0.10, 1.16, 0.02], note: 'Main part where food is churned.' },
      { name: 'Pylorus', at: [-0.03, 1.11, 0.045], note: 'Valve into the duodenum.' },
    ],
  },
  {
    id: 'spleen', name: 'Spleen', short: 'Spleen',
    meshes: [{ id: 'spleen', tissue: 'spleen' }], focus: ['spleen'], pin: [0.122, 1.17, -0.04], view: [1, 0.15, -0.3],
    systems: ['blood'], summary: 'Filters ageing red blood cells and stores platelets, tucked behind the stomach on the left.',
    facts: [{ label: 'Length', value: 'about 11–12 cm' }], landmarks: [{ name: 'Hilum', at: [0.085, 1.16, -0.03], note: 'Where its artery and vein enter.' }],
  },
  {
    id: 'pancreas', name: 'Pancreas', short: 'Pancreas',
    meshes: [{ id: 'pancreas', tissue: 'pancreas' }], focus: ['pancreas'], pin: [0.046, 1.115, 0.008], view: [0.1, 0.4, 1],
    systems: ['metabolic'], summary: 'Lies behind the stomach. It makes insulin and digestive enzymes; fasting glucose and HbA1c reflect blood-sugar control.',
    facts: [{ label: 'Length', value: 'about 15 cm' }],
    landmarks: [
      { name: 'Head', at: [-0.045, 1.07, 0.024], note: 'Sits inside the C-shaped loop of the duodenum.' },
      { name: 'Body', at: [0.02, 1.105, 0.012], note: 'Crosses in front of the aorta.' },
      { name: 'Tail', at: [0.085, 1.14, -0.04], note: 'Reaches toward the spleen.' },
    ],
  },
  {
    id: 'kidneys', name: 'Kidneys & urinary tract', short: 'Kidneys',
    meshes: [
      { id: 'kidneys', tissue: 'cortex', hollow: true, shell: true }, { id: 'kidney_medulla', tissue: 'medulla' }, { id: 'kidney_pelvis', tissue: 'urothelium' },
      { id: 'adrenals', tissue: 'adrenal' }, { id: 'bladder', tissue: 'bladder' },
    ],
    focus: ['kidneys'], pin: [-0.085, 1.09, -0.07], view: [-0.15, 0.1, -1],
    systems: ['kidney', 'urine'], summary: 'Two bean-shaped filters against the back wall of the abdomen. Creatinine, eGFR, urea, electrolytes and urine tests relate to them.',
    facts: [{ label: 'Length', value: 'about 10–12 cm each' }, { label: 'Filtration', value: 'about 180 L of plasma a day' }],
    landmarks: [
      { name: 'Renal cortex', at: [0.09, 1.11, -0.07], note: 'Outer layer containing the filtering glomeruli.' },
      { name: 'Medullary pyramids', at: [0.075, 1.12, -0.064], note: 'Cone-shaped tissue that concentrates urine; see cross-section.' },
      { name: 'Renal pelvis', at: [0.042, 1.098, -0.05], note: 'Funnel collecting urine into the ureter.' },
      { name: 'Adrenal gland', at: [0.05, 1.165, -0.066], note: 'Hormone gland capping each kidney.' },
      { name: 'Ureter', at: [0.04, 1.0, -0.042], note: 'Carries urine down to the bladder.' },
      { name: 'Bladder', at: [0, 0.93, 0.03], note: 'Stores urine; urinalysis samples what it collects.' },
    ],
  },
  {
    id: 'intestine', name: 'Small intestine', short: 'Small intestine',
    meshes: [{ id: 'small_int', tissue: 'smallgut' }], focus: ['small_int'], pin: [-0.02, 0.99, 0.06], view: [0.1, 0.2, 1],
    systems: ['nutrition'], summary: 'Coiled tube where most nutrients are absorbed, including vitamin B12 in its last section.',
    facts: [{ label: 'Length', value: 'about 6 m' }],
    landmarks: [{ name: 'Duodenum', at: [-0.06, 1.07, 0.01], note: 'First C-shaped part wrapping the pancreas.' }, { name: 'Jejunum & ileum', at: [0.02, 1.0, 0.055], note: 'The long coiled middle and final parts.' }],
  },
  {
    id: 'colon', name: 'Large intestine', short: 'Colon',
    meshes: [{ id: 'colon', tissue: 'colon' }], focus: ['colon'], pin: [-0.095, 1.04, 0.045], view: [0, 0.15, 1],
    systems: [], summary: 'Frames the small intestine; absorbs water and salts.', facts: [{ label: 'Length', value: 'about 1.5 m' }],
    landmarks: [{ name: 'Caecum & appendix', at: [-0.07, 0.93, 0.03], note: 'Start of the colon, lower right.' }, { name: 'Haustra', at: [0.0, 1.05, 0.085], note: 'The pouches along the colon wall.' }],
  },
  {
    id: 'marrow', name: 'Skeleton & bone marrow', short: 'Bone marrow',
    meshes: [{ id: 'skel_axial', tissue: 'bone' }, { id: 'skel_limbs', tissue: 'bone' }, { id: 'ribs', tissue: 'bone' }, { id: 'cartilage', tissue: 'cartilage' }],
    focus: ['skel_axial'], pin: [0.125, 1.025, 0.02], view: [0.3, 0.1, 1],
    systems: ['blood'], summary: 'In adults, red marrow in the spine, ribs, sternum and pelvis makes red cells, white cells and platelets. Blood counts sample the blood, not the marrow.',
    facts: [{ label: 'Bones', value: '206 in adults' }, { label: 'Blood cells made', value: 'hundreds of billions a day' }],
    landmarks: [
      { name: 'Sternum', at: [0, 1.33, 0.095], note: 'A key site of red marrow.' },
      { name: 'Iliac crest', at: [0.12, 1.035, 0.0], note: 'Common site for marrow samples.' },
      { name: 'Vertebral column', at: [0, 1.25, -0.09], note: 'Vertebral bodies contain red marrow.' },
      { name: 'Femur', at: [0.11, 0.70, 0.01], note: 'Upper end holds red marrow in adults.' },
    ],
  },
  {
    id: 'skin', name: 'Skin', short: 'Skin',
    meshes: [{ id: 'skin', tissue: 'skin' }], focus: ['skin'], pin: [0, 1.6, 0.1], view: [0, 0, 1],
    systems: [], summary: 'Makes most of the body’s vitamin D with sunlight.', facts: [], landmarks: [],
  },
];

export const ORGAN_BY_ID = Object.fromEntries(ORGANS.map(o => [o.id, o])) as Record<OrganId, OrganSpec>;
export const MESH_TO_ORGAN: Record<string, OrganId> = Object.fromEntries(ORGANS.flatMap(o => o.meshes.map(m => [m.id, o.id])));
export const PICKABLE: OrganId[] = ORGANS.filter(o => o.id !== 'skin').map(o => o.id);
