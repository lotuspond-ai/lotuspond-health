// Guess the body region and modality of a scan from its file name or DICOM tags.
import type { OrganId } from '../../types';

const ORGAN_RULES: [RegExp, OrganId][] = [
  [/\b(?:brain|head|skull|cranial|cranium|mri\s*brain|cerebr\w*|neuro|orbit|sinus\w*|pituitary|iam)\b/, 'brain'],
  [/\b(?:thyroid|neck|cervical\s*soft|parathyroid)\b/, 'thyroid'],
  [/\b(?:echo|echocardiogra\w*|ecg|ekg|heart|cardiac|cardio\w*|coronary|angio\w*|cta\s*coronary)\b/, 'heart'],
  [/\b(?:chest|lungs?|cxr|thorax|thoracic|pulmonary|hrct|pa\s*view|cxr\w*)\b/, 'lungs'],
  [/\b(?:prostat\w*|uterus|uterine|endometri\w*|ovary|ovaries|ovarian|adnex\w*|testis|testes|testicular|scrot\w*|tvs|transvaginal|cervix|mammo\w*|breasts?)\b/, 'reproductive'],
  [/\b(?:kidneys?|kub|renal|ivp|urogra\w*|bladder|ureter\w*)\b/, 'kidneys'],
  [/\b(?:liver|hepat\w*|abdomen|abdominal|abd|usg|ultrasound|sonogra\w*|gall\s*bladder|gallbladder|biliary|mrcp)\b/, 'liver'],
  [/\b(?:pancrea\w*)\b/, 'pancreas'],
  [/\b(?:spleen|splenic)\b/, 'spleen'],
  [/\b(?:stomach|gastric|endoscopy|ugi|egd)\b/, 'stomach'],
  [/\b(?:esophag\w*|oesophag\w*|barium\s*swallow)\b/, 'esophagus'],
  [/\b(?:colon|colonoscopy|rectum|rectal|sigmoid\w*)\b/, 'colon'],
  [/\b(?:bowel|intestin\w*|enterogra\w*)\b/, 'intestine'],
  [/\b(?:airway|trachea|larynx|laryn\w*|nasal|pns)\b/, 'airway'],
  [/\b(?:knee|spine|spinal|lumbar|lspine|cspine|dspine|bone|bones|dexa|dxa|hip|pelvis|femur|shoulder|wrist|ankle|elbow|hand|foot|joint|skeletal|marrow|fracture|ortho\w*)\b/, 'marrow'],
  [/\b(?:skin|derma\w*|mole|rash|lesion|nevus|naevus)\b/, 'skin'],
];

/** Separate words in file names: "MRI_brain-2026.jpg" → "mri brain 2026 jpg". */
export function nameWords(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/x[\s_-]?ray/g, 'xray')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2')
    .trim();
}

export function guessOrgan(...hints: (string | null | undefined)[]): OrganId | null {
  const text = ` ${hints.filter(Boolean).map(h => nameWords(h ?? '')).join(' ')} `;
  for (const [re, organ] of ORGAN_RULES) if (re.test(text)) return organ;
  return null;
}

const MODALITY_RULES: [RegExp, string][] = [
  [/\b(?:xray|xr|cxr|radiograph\w*|dx|cr)\b/, 'XR'],
  [/\b(?:ct|cect|ncct|hrct|cta|cat\s*scan)\b/, 'CT'],
  [/\b(?:mri|mr|mra|mrcp|fmri)\b/, 'MR'],
  [/\b(?:usg|ultrasound|sonogra\w*|us|doppler)\b/, 'US'],
  [/\b(?:echo|echocardiogra\w*)\b/, 'Echo'],
  [/\b(?:ecg|ekg|electrocardiogra\w*)\b/, 'ECG'],
  [/\b(?:pet|pet\s*ct)\b/, 'PET'],
  [/\b(?:dexa|dxa)\b/, 'DEXA'],
  [/\b(?:mammo\w*)\b/, 'MG'],
  [/\b(?:endoscopy|colonoscopy)\b/, 'Endoscopy'],
];

export function guessModality(fileName: string): string | null {
  const text = ` ${nameWords(fileName)} `;
  for (const [re, m] of MODALITY_RULES) if (re.test(text)) return m;
  return null;
}

/** Human-friendly body part from a DICOM BodyPartExamined code ("CHEST" → "Chest", "ABDOMENPELVIS" → "Abdomen pelvis"). */
export function prettyBodyPart(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  const t = code.trim().toLowerCase().replace(/_/g, ' ').replace(/^abdomenpelvis$/, 'abdomen pelvis').replace(/^chestabdomen$/, 'chest abdomen');
  return t ? t[0].toUpperCase() + t.slice(1) : undefined;
}
