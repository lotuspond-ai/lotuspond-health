import type { OrganId, SystemId } from '../types';

/** Coordinates are metres in each body model: +x = the person's left, +y = up (soles at y = 0), +z = front, with the
 *  body centred on x = z = 0. The geometry itself (parts, pins, landmark positions) is per body: src/anatomy/bodies. */
export type Vec3 = [number, number, number];

export type Tissue =
  | 'myocardium' | 'valve' | 'artery' | 'vein' | 'portal' | 'brain' | 'csf' | 'lung' | 'cartilage' | 'liver' | 'bile'
  | 'gallbladder' | 'stomach' | 'spleen' | 'pancreas' | 'cortex' | 'medulla' | 'urothelium' | 'adrenal' | 'bladder'
  | 'smallgut' | 'colon' | 'thyroid' | 'parathyroid' | 'pituitary' | 'esophagus' | 'bone' | 'marrow' | 'tooth' | 'ligament'
  | 'muscle' | 'diaphragm' | 'spinal' | 'eye' | 'thymus' | 'reproductive' | 'breast' | 'skin';

export interface LandmarkText { name: string; note: string }

export interface OrganSpec {
  id: OrganId;
  name: string;
  short: string;
  /** Parts (node names in models/anatomy-<body>.glb) used to frame the camera when the organ is opened. */
  focus: string[];
  /** Parts of other organs drawn solid (not as ghosts) in this organ's close-up: the vessels, cartilages and ducts its
   *  landmarks name (tools/anatomy/assemble.py CONTEXT keeps the same lists). */
  context?: string[];
  /** Camera direction to view from when opened (unit-ish vector from target toward camera). */
  view: Vec3;
  systems: SystemId[];
  summary: string;
  facts: { label: string; value: string }[];
  /** Landmark labels, in display order. Each body places the ones it has (tools/anatomy/assemble.py LANDMARKS). */
  landmarks: LandmarkText[];
}

export const TISSUE: Record<Tissue, { color: string; rough: number; clear: number; sheen?: string; inner?: string; opacity?: number }> = {
  myocardium: { color: '#a3302b', rough: 0.42, clear: 0.55, sheen: '#ff9a8a', inner: '#5a1513' },
  valve: { color: '#eedcc0', rough: 0.5, clear: 0.3 },
  artery: { color: '#c5352d', rough: 0.35, clear: 0.7, sheen: '#ff8f80' },
  vein: { color: '#3d5cb3', rough: 0.35, clear: 0.7, sheen: '#8aa4ff' },
  portal: { color: '#6a4ea6', rough: 0.35, clear: 0.7 },
  brain: { color: '#e4b0a8', rough: 0.62, clear: 0.25, sheen: '#ffd6cf', inner: '#c98a83' },
  csf: { color: '#9cc9e6', rough: 0.3, clear: 0.6 },
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
  parathyroid: { color: '#c98652', rough: 0.45, clear: 0.5 },
  pituitary: { color: '#d4917a', rough: 0.45, clear: 0.5, sheen: '#f6c0ad' },
  esophagus: { color: '#c7867d', rough: 0.45, clear: 0.5 },
  bone: { color: '#ebe1cc', rough: 0.55, clear: 0.15 },
  marrow: { color: '#a3383a', rough: 0.6, clear: 0.2 },
  tooth: { color: '#f6f1df', rough: 0.3, clear: 0.6 },
  ligament: { color: '#e6dccb', rough: 0.5, clear: 0.3 },
  muscle: { color: '#a8433d', rough: 0.5, clear: 0.35, sheen: '#e07a70' },
  diaphragm: { color: '#a8473f', rough: 0.5, clear: 0.3, opacity: 0.22 },
  spinal: { color: '#f0e2b6', rough: 0.5, clear: 0.3 },
  eye: { color: '#f2efe9', rough: 0.25, clear: 0.9 },
  thymus: { color: '#d9a99c', rough: 0.55, clear: 0.3 },
  reproductive: { color: '#d59a9a', rough: 0.45, clear: 0.5, sheen: '#f4c4c0', inner: '#a8605e' },
  breast: { color: '#e9c79c', rough: 0.55, clear: 0.3 },
  skin: { color: '#8fd3dc', rough: 1, clear: 0 },
};

export const ORGANS: OrganSpec[] = [
  {
    id: 'brain', name: 'Brain', short: 'Brain', focus: ['brain'], view: [1, 0.25, 0.2],
    systems: [], summary: 'Two cerebral hemispheres, the cerebellum and the brainstem, with the pituitary gland hanging beneath. The pituitary makes TSH and the hormones that control the adrenal glands, ovaries and testes. Routine blood tests do not measure brain structure.',
    facts: [{ label: 'Weight', value: 'about 1.3–1.4 kg' }, { label: 'Blood flow', value: 'about 15% of cardiac output' }],
    landmarks: [
      { name: 'Frontal lobe', note: 'Planning, decision-making and voluntary movement.' },
      { name: 'Motor cortex', note: 'The precentral gyrus: starts voluntary movement on the opposite side of the body.' },
      { name: 'Sensory cortex', note: 'The postcentral gyrus: receives touch, pain and position sense from the opposite side.' },
      { name: 'Temporal lobe', note: 'Hearing, language and memory.' },
      { name: 'Occipital lobe', note: 'Vision.' },
      { name: 'Cerebellum', note: 'Balance and coordination.' },
      { name: 'Brainstem', note: 'Midbrain, pons and medulla: connect the brain to the spinal cord and control breathing and heart rate.' },
      { name: 'Hypothalamus', note: 'Controls hunger, thirst and temperature, and tells the pituitary gland what to release.' },
      { name: 'Pituitary gland', note: 'Makes TSH, which sets how hard the thyroid works, and the hormones that steer the adrenal glands, ovaries and testes.' },
      { name: 'Lateral ventricles', note: 'Fluid-filled spaces deep in each hemisphere; visible in cross-section.' },
      { name: 'Corpus callosum', note: 'The band of nerve fibres linking the two hemispheres, deep between them.' },
    ],
  },
  {
    id: 'thyroid', name: 'Thyroid gland', short: 'Thyroid', focus: ['thyroid', 'parathyroids'], context: ['airway'], view: [0.25, 0.1, 1],
    systems: ['thyroid'], summary: 'A butterfly-shaped gland wrapped around the front of the windpipe. TSH, T3 and T4 reflect how its hormone output is regulated. The four parathyroid glands behind it control calcium.',
    facts: [{ label: 'Weight', value: 'about 10–20 g' }, { label: 'Hormones', value: 'T4, T3, calcitonin' }],
    landmarks: [
      { name: 'Right lobe', note: 'Each lobe sits beside the larynx and trachea.' },
      { name: 'Left lobe', note: 'Each lobe sits beside the larynx and trachea.' },
      { name: 'Isthmus', note: 'Bridge of tissue crossing in front of the trachea, just below the cricoid cartilage.' },
      { name: 'Pyramidal lobe', note: 'A thin strip of thyroid rising from the isthmus in front of the larynx, found in about half of people: what remains of the duct the gland descended along.' },
      { name: 'Parathyroid glands', note: 'Four rice-sized glands behind the thyroid that control calcium.' },
      { name: 'Thyroid cartilage', note: 'Front of the voice box (the Adam’s apple), just above the gland.' },
    ],
  },
  {
    id: 'airway', name: 'Larynx & trachea', short: 'Airway', focus: ['airway'], view: [0.3, 0.1, 1],
    systems: [], summary: 'The airway from the voice box down to the two main bronchi.', facts: [{ label: 'Trachea length', value: 'about 8–12 cm (shorter in women)' }],
    landmarks: [
      { name: 'Epiglottis', note: 'Flap that closes over the larynx when you swallow.' },
      { name: 'Thyroid cartilage', note: 'The largest cartilage of the voice box (the Adam’s apple).' },
      { name: 'Cricoid cartilage', note: 'Ring of cartilage at the bottom of the larynx, where the trachea begins.' },
      { name: 'Trachea', note: 'The windpipe, held open by C-shaped rings of cartilage.' },
      { name: 'Carina', note: 'Where the trachea splits into left and right bronchi.' },
      { name: 'Right main bronchus', note: 'Steeper than the left, and usually shorter and wider, so inhaled objects tend to go right.' },
      { name: 'Left main bronchus', note: 'Longer and more horizontal, passing under the aortic arch.' },
    ],
  },
  {
    id: 'lungs', name: 'Lungs', short: 'Lungs', focus: ['lung_r_upper', 'lung_r_middle', 'lung_r_lower', 'lung_l_upper', 'lung_l_lower'], view: [0.2, 0.15, 1],
    systems: [], summary: 'The right lung has three lobes and the left has two, making room for the heart. Blood tests rarely measure the lungs directly; imaging and breathing tests do.',
    facts: [{ label: 'Lobes', value: '3 right, 2 left' }, { label: 'Surface for gas exchange', value: 'about 70 m²' }],
    landmarks: [
      { name: 'Right upper lobe', note: 'Separated from the middle lobe by the horizontal fissure.' },
      { name: 'Right middle lobe', note: 'Right lung only, between the horizontal and oblique fissures.' },
      { name: 'Right lower lobe', note: 'Below the oblique fissure, resting on the diaphragm.' },
      { name: 'Left upper lobe', note: 'Includes the lingula; the left lung has no middle lobe.' },
      { name: 'Lingula', note: 'Tongue-shaped part of the left upper lobe beside the heart.' },
      { name: 'Left lower lobe', note: 'Below the oblique fissure, resting on the diaphragm.' },
      { name: 'Bronchial tree', note: 'Airways branch about 23 times before reaching the air sacs.' },
      { name: 'Diaphragm', note: 'The main breathing muscle, domed under the lungs.' },
    ],
  },
  {
    id: 'heart', name: 'Heart & vessels', short: 'Heart', focus: ['heart', 'valves', 'coronary'], view: [0.35, 0.12, 1],
    systems: ['heart', 'metabolic', 'inflammation'], summary: 'A four-chambered muscular pump with its own coronary blood supply. Lipids, apolipoproteins, troponins, NT-proBNP and hs-CRP relate to the heart and arteries but are not images of them.',
    facts: [{ label: 'Size', value: 'about a closed fist' }, { label: 'Output at rest', value: 'about 5 L per minute' }, { label: 'Wall of left ventricle', value: 'about 1 cm thick' }],
    landmarks: [
      { name: 'Left ventricle', note: 'Thickest chamber; pumps blood to the whole body.' },
      { name: 'Right ventricle', note: 'Pumps blood to the lungs.' },
      { name: 'Right atrium', note: 'Receives blood from the body via the venae cavae.' },
      { name: 'Left atrium', note: 'Receives oxygenated blood from the lungs.' },
      { name: 'Interventricular septum', note: 'The muscular wall between the two ventricles, inside the heart.' },
      { name: 'Mitral valve', note: 'Two leaflets between the left atrium and left ventricle.' },
      { name: 'Tricuspid valve', note: 'Three leaflets between the right atrium and right ventricle.' },
      { name: 'Aortic valve', note: 'Opens to let the left ventricle push blood into the aorta.' },
      { name: 'Pulmonary valve', note: 'Opens to let the right ventricle push blood toward the lungs.' },
      { name: 'Aortic arch', note: 'Main artery leaving the heart, curving over to the left.' },
      { name: 'Pulmonary trunk', note: 'Carries blood from the right ventricle to the lungs.' },
      { name: 'Superior vena cava', note: 'Returns blood from the head and arms.' },
      { name: 'Coronary arteries', note: 'Supply the heart muscle itself; the left anterior descending artery runs down the front.' },
      { name: 'Apex', note: 'Tip of the heart, pointing down, forward and to the left.' },
    ],
  },
  {
    id: 'esophagus', name: 'Esophagus', short: 'Esophagus', focus: ['esophagus'], view: [0.8, 0.1, 0.6],
    systems: [], summary: 'Muscular tube carrying food from the throat, behind the trachea and heart, to the stomach.', facts: [{ label: 'Length', value: 'about 25 cm' }],
    landmarks: [
      { name: 'Esophagus', note: 'Moves food down by waves of contraction.' },
      { name: 'Gastro-esophageal junction', note: 'Where the esophagus joins the stomach, just below the diaphragm.' },
    ],
  },
  {
    id: 'liver', name: 'Liver & gallbladder', short: 'Liver', focus: ['liver', 'gallbladder'], view: [-0.45, 0.1, 1],
    systems: ['liver'], summary: 'The largest internal organ, under the right ribs. ALT, AST, ALP, GGT, bilirubin and blood proteins relate to how it is working.',
    facts: [{ label: 'Weight', value: 'about 1.2–2.2 kg' }, { label: 'Blood supply', value: '75% portal vein, 25% hepatic artery' }],
    landmarks: [
      { name: 'Right lobe', note: 'Much the larger lobe.' },
      { name: 'Left lobe', note: 'Thinner lobe extending across the midline over the stomach.' },
      { name: 'Caudate lobe', note: 'Small lobe at the back, beside the inferior vena cava.' },
      { name: 'Quadrate lobe', note: 'Small lobe on the underside, between the gallbladder and the round ligament.' },
      { name: 'Falciform ligament', note: 'Fold that attaches the liver to the front of the abdomen and marks the left lobe.' },
      { name: 'Gallbladder', note: 'Stores bile, under the liver’s right lobe.' },
      { name: 'Porta hepatis', note: 'Doorway on the underside where the portal vein, hepatic artery and bile ducts pass.' },
      { name: 'Hepatic artery', note: 'Brings oxygen-rich blood from the aorta: about a quarter of the liver’s supply.' },
      { name: 'Hepatic veins', note: 'Drain the liver into the inferior vena cava.' },
      { name: 'Portal vein', note: 'Brings nutrient-rich blood from the gut.' },
      { name: 'Common bile duct', note: 'Carries bile down to the small intestine.' },
    ],
  },
  {
    id: 'stomach', name: 'Stomach', short: 'Stomach', focus: ['stomach'], view: [0.5, 0.1, 1],
    systems: ['nutrition'], summary: 'J-shaped muscular sac below the left dome of the diaphragm. Its lining makes the intrinsic factor needed to absorb vitamin B12.',
    facts: [{ label: 'Capacity', value: 'about 1–1.5 L' }],
    landmarks: [
      { name: 'Fundus', note: 'Dome-shaped top under the diaphragm.' },
      { name: 'Body', note: 'Main part where food is churned.' },
      { name: 'Greater curvature', note: 'The long outer border of the stomach.' },
      { name: 'Pylorus', note: 'Valve into the duodenum.' },
    ],
  },
  {
    id: 'spleen', name: 'Spleen', short: 'Spleen', focus: ['spleen'], context: ['arteries', 'portal_vein'], view: [-0.5, 0.15, 0.85],
    systems: ['blood'], summary: 'Filters ageing red blood cells and stores platelets, tucked behind the stomach on the left.',
    facts: [{ label: 'Length', value: 'about 10–14 cm' }],
    landmarks: [
      { name: 'Hilum', note: 'Where its artery and vein enter.' },
      { name: 'Splenic artery', note: 'Winds along the top of the pancreas from the coeliac trunk.' },
      { name: 'Splenic vein', note: 'Runs behind the pancreas to join the portal vein.' },
    ],
  },
  {
    id: 'pancreas', name: 'Pancreas', short: 'Pancreas', focus: ['pancreas'], context: ['bile_ducts'], view: [0.1, 0.4, 1],
    systems: ['metabolic'], summary: 'Lies behind the stomach. It makes insulin and digestive enzymes; fasting glucose and HbA1c reflect blood-sugar control.',
    facts: [{ label: 'Length', value: 'about 12–20 cm' }],
    landmarks: [
      { name: 'Head', note: 'Sits inside the C-shaped loop of the duodenum.' },
      { name: 'Neck', note: 'Narrow part in front of the portal vein.' },
      { name: 'Body', note: 'Crosses in front of the aorta.' },
      { name: 'Tail', note: 'Reaches toward the spleen.' },
      { name: 'Uncinate process', note: 'Hook of the head that tucks behind the superior mesenteric vessels.' },
      { name: 'Pancreatic duct', note: 'Runs inside the gland from tail to head, carrying digestive enzymes to the duodenum, where it joins the bile duct.' },
    ],
  },
  {
    id: 'kidneys', name: 'Kidneys & urinary tract', short: 'Kidneys', focus: ['kidneys'], context: ['arteries', 'veins'], view: [-0.15, 0.1, -1],
    systems: ['kidney', 'urine'], summary: 'Two bean-shaped filters against the back wall of the abdomen, each capped by an adrenal gland. Creatinine, eGFR, urea, electrolytes and urine tests relate to the kidneys; cortisol comes from the adrenal glands.',
    facts: [{ label: 'Length', value: 'about 10–12 cm each' }, { label: 'Filtration', value: 'about 180 L of plasma a day' }],
    landmarks: [
      { name: 'Renal cortex', note: 'Outer layer containing the filtering glomeruli.' },
      { name: 'Medullary pyramids', note: 'Cone-shaped tissue that concentrates urine; see cross-section.' },
      { name: 'Renal pelvis', note: 'Funnel collecting urine into the ureter.' },
      { name: 'Ureter', note: 'Carries urine down to the bladder.' },
      { name: 'Adrenal gland', note: 'Hormone gland capping each kidney; makes cortisol and adrenaline.' },
      { name: 'Renal artery', note: 'Branch of the aorta; the kidneys receive about a fifth of the heart’s output.' },
      { name: 'Renal vein', note: 'Returns filtered blood to the inferior vena cava.' },
      { name: 'Bladder', note: 'Stores urine; urinalysis samples what it collects.' },
    ],
  },
  {
    id: 'intestine', name: 'Small intestine', short: 'Small intestine', focus: ['small_int'], context: ['bile_ducts'], view: [0.1, 0.2, 1],
    systems: ['nutrition'], summary: 'Coiled tube where most nutrients are absorbed, including vitamin B12 in its last section.',
    facts: [{ label: 'Length', value: 'about 6 m' }],
    landmarks: [
      { name: 'Duodenum', note: 'First C-shaped part, wrapping the head of the pancreas.' },
      { name: 'Duodenal papilla', note: 'Inside the duodenum: where bile and pancreatic juice enter the intestine.' },
      { name: 'Jejunum', note: 'Upper coils, where most nutrients are absorbed.' },
      { name: 'Ileum', note: 'Lower coils; absorbs vitamin B12 and bile salts.' },
      { name: 'Terminal ileum', note: 'Last part, joining the colon at the ileocaecal valve.' },
    ],
  },
  {
    id: 'colon', name: 'Large intestine', short: 'Colon', focus: ['colon'], view: [0, 0.15, 1],
    systems: [], summary: 'Frames the small intestine; absorbs water and salts.', facts: [{ label: 'Length', value: 'about 1.5 m' }],
    landmarks: [
      { name: 'Caecum', note: 'Start of the colon, lower right.' },
      { name: 'Appendix', note: 'Narrow pouch hanging from the caecum.' },
      { name: 'Ascending colon', note: 'Rises up the right side.' },
      { name: 'Hepatic flexure', note: 'Bend under the liver.' },
      { name: 'Transverse colon', note: 'Crosses the abdomen below the stomach.' },
      { name: 'Splenic flexure', note: 'Bend under the spleen, higher than the hepatic flexure.' },
      { name: 'Descending colon', note: 'Runs down the left side.' },
      { name: 'Sigmoid colon', note: 'S-shaped loop leading into the rectum.' },
      { name: 'Rectum', note: 'Final part before the anal canal.' },
    ],
  },
  {
    id: 'reproductive', name: 'Reproductive organs', short: 'Reproductive', focus: ['reproductive'], view: [0.2, 0.1, 1],
    systems: ['hormones'], summary: 'The testes and ovaries make sex cells and most sex hormones; the prostate, uterus and the other organs here carry and support them. Testosterone relates to them.',
    facts: [{ label: 'Hormones', value: 'testosterone (testes); estradiol and progesterone (ovaries)' }],
    landmarks: [
      { name: 'Prostate', note: 'Walnut-sized gland below the bladder; it makes PSA and part of semen.' },
      { name: 'Seminal vesicles', note: 'Glands behind the bladder that add fluid to semen.' },
      { name: 'Vas deferens', note: 'Duct carrying sperm from the testes.' },
      { name: 'Testes', note: 'Make sperm and most of the body’s testosterone.' },
      { name: 'Uterus', note: 'Muscular organ in which a pregnancy grows.' },
      { name: 'Cervix', note: 'Lower end of the uterus, opening into the vagina; checked by cervical screening.' },
      { name: 'Ovaries', note: 'Make eggs, estradiol and progesterone.' },
      { name: 'Fallopian tubes', note: 'Carry eggs from the ovaries to the uterus.' },
      { name: 'Vagina', note: 'Muscular passage from the cervix to the outside.' },
    ],
  },
  {
    // only the female body has breast tissue to show; the organ is left out of the male body's lists
    id: 'breast', name: 'Breasts', short: 'Breasts', focus: ['breasts'], view: [0.25, 0.1, 1],
    systems: ['hormones'], summary: 'Milk-producing lobes and the ducts that carry milk to the nipple, set in fat over the chest muscles. Mammograms and breast ultrasound look at them.',
    facts: [{ label: 'Lobes', value: '15–20 in each breast' }],
    landmarks: [
      { name: 'Mammary lobes', note: 'Groups of milk-producing glands, set in fat.' },
      { name: 'Lactiferous ducts', note: 'Carry milk from the lobes and widen into small sinuses just behind the nipple.' },
    ],
  },
  {
    id: 'marrow', name: 'Skeleton & bone marrow', short: 'Bone marrow', focus: ['skel_spine', 'skel_pelvis', 'skel_thorax'], view: [0.3, 0.1, 1],
    systems: ['blood'], summary: 'In adults, red marrow in the spine, ribs, sternum, skull and pelvis makes red cells, white cells and platelets. Blood counts sample the blood, not the marrow.',
    facts: [{ label: 'Bones', value: '206 in adults' }, { label: 'Blood cells made', value: 'hundreds of billions a day' }],
    landmarks: [
      { name: 'Skull', note: 'Protects the brain; its flat bones hold red marrow.' },
      { name: 'Sternum', note: 'A key site of red marrow.' },
      { name: 'Ribs', note: 'Twelve pairs; red marrow fills their spongy bone.' },
      { name: 'Vertebral column', note: 'Vertebral bodies, like this lumbar one, contain red marrow.' },
      { name: 'Iliac crest', note: 'Common site for marrow samples.' },
      { name: 'Red marrow', note: 'Spongy bone of the pelvis, where blood cells are made; see cross-section.' },
      { name: 'Femur', note: 'Upper end holds red marrow in adults.' },
      { name: 'Thymus', note: 'Where T cells mature; it shrinks after puberty.' },
    ],
  },
  {
    id: 'skin', name: 'Skin', short: 'Skin', focus: ['skin'], view: [0, 0, 1],
    systems: [], summary: 'Makes most of the body’s vitamin D with sunlight.', facts: [], landmarks: [],
  },
];

export const ORGAN_BY_ID = Object.fromEntries(ORGANS.map(o => [o.id, o])) as Record<OrganId, OrganSpec>;
export const PICKABLE: OrganId[] = ORGANS.filter(o => o.id !== 'skin').map(o => o.id);
/** Organ spec, or null for an id this version does not know (sent by a newer app). */
export const organOrNull = (id: string | null | undefined): OrganSpec | null => (id && (ORGAN_BY_ID as Record<string, OrganSpec>)[id]) || null;
