// Photos / exported images of scans (JPEG, PNG, WebP, HEIC where the browser can decode it).
import type { ParseResult, ScanItem } from '../../types';
import { uid } from '../id.ts';
import { parseDate } from './dates.ts';
import { guessModality, guessOrgan } from './organs.ts';

export const THUMB_MAX = 360;

type Drawable = ImageBitmap | HTMLImageElement;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Placeholder thumbnail (neutral tile with a short label) as a PNG/SVG data URL. */
export function placeholderThumb(label: string): string {
  const safe = label.replace(/[^\w .+-]/g, '').slice(0, 12) || 'Scan';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="270" viewBox="0 0 360 270"><rect width="360" height="270" fill="#1f2a2e"/><rect x="24" y="24" width="312" height="222" rx="14" fill="none" stroke="#5f7a7f" stroke-width="3" stroke-dasharray="10 8"/><text x="180" y="146" font-family="system-ui,sans-serif" font-size="34" fill="#a9c2c4" text-anchor="middle">${safe}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function decode(blob: Blob): Promise<{ img: Drawable; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      return { img: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch { /* fall back to <img> (Safari HEIC, some WebP) */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** Downscale to fit THUMB_MAX and encode as JPEG. */
export function thumbFromDrawable(img: CanvasImageSource, width: number, height: number, max = THUMB_MAX): string {
  const s = Math.min(1, max / Math.max(width, height));
  const w = Math.max(1, Math.round(width * s)), h = Math.max(1, Math.round(height * s));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  if (!ctx) return placeholderThumb('Image');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.82);
}

/** Date embedded in a file name such as "CXR_2026-10-28.jpg" or "usg 28-10-2026.png". */
function dateFromName(name: string): string | null {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, '-');
  return parseDate(base);
}

export async function parseImage(file: File): Promise<ParseResult> {
  const blobKey = uid();
  const result: ParseResult = { measurements: [], scans: [], blobs: { [blobKey]: file }, warnings: [], detectedDate: null };
  let thumb: string;
  let width: number | undefined, height: number | undefined;
  try {
    const d = await decode(file);
    width = d.width; height = d.height;
    thumb = thumbFromDrawable(d.img, d.width, d.height);
    d.close();
  } catch {
    thumb = placeholderThumb(/heic|heif/i.test(file.type + file.name) ? 'HEIC' : 'Image');
    result.warnings.push(/heic|heif/i.test(file.type + file.name)
      ? 'This browser cannot display HEIC photos. The file is kept, but convert it to JPEG to see it here.'
      : 'This image could not be displayed; the file is kept as-is.');
  }
  const date = dateFromName(file.name) ?? null;
  const scan: ScanItem = {
    id: uid(),
    fileName: file.name,
    kind: 'image',
    organ: guessOrgan(file.name),
    modality: guessModality(file.name) ?? 'Photo',
    date,
    thumbDataUrl: thumb,
    blobKey,
    width,
    height,
  };
  result.scans.push(scan);
  result.detectedDate = date;
  return result;
}
