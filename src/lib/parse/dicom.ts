// DICOM files: header → ScanItem, first frame → thumbnail; full-size render with window/level.
import type { OrganId, ParseResult, ScanItem } from '../../types';
import { uid } from '../id.ts';
import { applyWindow, decodeDicom, defaultWindow, hasDicmMagic, headerMeta, JPEG_BASELINE, transferSyntaxName, type DicomDecoded } from './dicom-core.ts';
import { guessModality, guessOrgan, prettyBodyPart } from './organs.ts';
import { placeholderThumb, thumbFromDrawable } from './image.ts';

export { hasDicmMagic };

/** Display modality: CR/DX/RF → 'XR'; others kept as coded (CT, MR, US, MG, NM, PT...). */
export function displayModality(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  const c = code.toUpperCase();
  if (c === 'CR' || c === 'DX' || c === 'RF' || c === 'RG' || c === 'DR') return 'XR';
  return c;
}

const MODALITY_ORGAN: Record<string, OrganId> = { MG: 'breast', ECG: 'heart', IVUS: 'heart', BMD: 'marrow' };

/** Map DICOM tags (and the file name) to an organ. */
export function dicomOrgan(d: { bodyPart: string | null; studyDescription: string | null; seriesDescription: string | null; modality: string | null }, fileName: string): OrganId | null {
  const bp = (d.bodyPart ?? '').toUpperCase();
  // A pelvic ultrasound looks at the uterus and ovaries (or the prostate), not the bones the body part would suggest;
  // one of the bladder or kidneys stays with the urinary tract.
  const words = `${d.studyDescription ?? ''} ${d.seriesDescription ?? ''} ${fileName}`.toUpperCase();
  if (/PELVIS/.test(bp) && (d.modality ?? '').toUpperCase() === 'US' && !/KUB|BLADDER|RENAL|KIDNEY|URINARY/.test(words)) return 'reproductive';
  const organ = guessOrgan(d.bodyPart, d.studyDescription, d.seriesDescription, fileName);
  if (organ) return organ;
  if (/SPINE|PELVIS|HIP|EXTREMITY|KNEE|ANKLE|SHOULDER|ELBOW|WRIST|HAND|FOOT|LEG|ARM|FEMUR|SKULL/.test(bp)) return /SKULL/.test(bp) ? 'brain' : 'marrow';
  if (/ABDOMEN|ABD/.test(bp)) return 'liver';
  if (/BREAST/.test(bp)) return 'breast';
  return d.modality ? MODALITY_ORGAN[d.modality.toUpperCase()] ?? null : null;
}

/* ---------------- full-size render (cached decode) ---------------- */

const cache = new WeakMap<ArrayBuffer, DicomDecoded | null>();

function decodeCached(buffer: ArrayBuffer): DicomDecoded | null {
  if (cache.has(buffer)) return cache.get(buffer) ?? null;
  let d: DicomDecoded | null = null;
  try { d = decodeDicom(buffer); } catch { d = null; }
  cache.set(buffer, d);
  return d;
}

export interface DicomRender {
  imageData: ImageData;
  width: number;
  height: number;
  /** Window centre and width actually applied (feed back into the sliders). */
  center: number;
  width_: number;
  meta: Record<string, string>;
}

/**
 * Render the first frame of an uncompressed DICOM at full size with the given window/level
 * (defaults to the file's window, or the full value range). Returns null when the file cannot be
 * decoded (e.g. compressed transfer syntaxes).
 */
export function renderDicom(buffer: ArrayBuffer, opts?: { center?: number; width?: number }): DicomRender | null {
  const d = decodeCached(buffer);
  if (!d) return null;
  const w = applyWindow(d, opts?.center, opts?.width);
  if (!w) return null;
  const imageData = new ImageData(new Uint8ClampedArray(w.rgba), w.width, w.height);
  return { imageData, width: w.width, height: w.height, center: w.center, width_: w.window, meta: headerMeta(d.header) };
}

/* ---------------- thumbnail ---------------- */

function thumbFromDecoded(d: DicomDecoded): string | null {
  const def = defaultWindow(d);
  const w = applyWindow(d, def.center, def.width);
  if (!w || typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w.width; c.height = w.height;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(w.rgba), w.width, w.height), 0, 0);
  return thumbFromDrawable(c, w.width, w.height);
}

async function thumbFromJpegFrame(frame: Uint8Array): Promise<{ url: string; width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const copy = new Uint8Array(frame.byteLength);
    copy.set(frame);
    const bmp = await createImageBitmap(new Blob([copy], { type: 'image/jpeg' }));
    const url = thumbFromDrawable(bmp, bmp.width, bmp.height);
    const out = { url, width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  } catch { return null; }
}

/** True when the file should be treated as DICOM (extension, MIME, or DICM magic). */
export async function looksLikeDicom(file: File): Promise<boolean> {
  if (/\.(dcm|dicom|dic)$/i.test(file.name) || /dicom/i.test(file.type)) return true;
  if (file.size < 132) return false;
  return hasDicmMagic(new Uint8Array(await file.slice(0, 132).arrayBuffer()));
}

export async function parseDicomFile(file: File): Promise<ParseResult> {
  const blobKey = uid();
  const result: ParseResult = { measurements: [], scans: [], blobs: { [blobKey]: file }, warnings: [], detectedDate: null };
  let d: DicomDecoded;
  try {
    d = decodeDicom(await file.arrayBuffer());
  } catch (e) {
    return { ...result, blobs: {}, warnings: [`This does not look like a readable DICOM file (${e instanceof Error ? e.message : String(e)}).`] };
  }
  const h = d.header;
  let thumb: string | null = null;
  let width: number | undefined = h.columns || undefined, height: number | undefined = h.rows || undefined;
  if (!h.hasPixels) {
    result.warnings.push('This DICOM file has no image data (it may be a report or structured data). It was kept for reference.');
  } else if (h.compressed) {
    // Baseline JPEG frames can be decoded by the browser for a preview.
    if (JPEG_BASELINE.has(h.transferSyntax) && d.compressedFrame) {
      const t = await thumbFromJpegFrame(d.compressedFrame);
      if (t) { thumb = t.url; width = t.width; height = t.height; }
    }
    result.warnings.push(`This scan uses ${transferSyntaxName(h.transferSyntax)} compression, which can't be shown full size here yet. It was saved with ${thumb ? 'a preview' : 'a placeholder picture'}.`);
  } else {
    thumb = thumbFromDecoded(d);
    if (!thumb) result.warnings.push('The image data in this DICOM file could not be decoded.');
  }
  if (h.frames > 1 && !h.compressed) result.warnings.push(`This file has ${h.frames} frames; only the first is shown.`);
  const modality = displayModality(h.modality) ?? guessModality(file.name) ?? undefined;
  const scan: ScanItem = {
    id: uid(),
    fileName: file.name,
    kind: 'dicom',
    organ: dicomOrgan(h, file.name),
    modality,
    bodyPart: prettyBodyPart(h.bodyPart) ?? h.studyDescription ?? undefined,
    date: h.studyDate,
    thumbDataUrl: thumb ?? placeholderThumb(modality ?? 'DICOM'),
    blobKey,
    width,
    height,
  };
  result.scans.push(scan);
  result.detectedDate = h.studyDate;
  return result;
}
