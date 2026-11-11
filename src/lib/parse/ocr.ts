// Reading photographed and scanned lab reports on the device. OCR (Tesseract, run in a Web Worker by ocr-engine.ts)
// turns each image into positioned words; this module turns those into the positioned text items the PDF parser
// already reads (pdf-text.ts), so a photo goes through the same row finding, marker matching and ranges as a PDF.
// Nothing here leaves the device. When the read is poor, the upload review offers the optional Claude read
// (docs/report-reading.md), which needs the person's consent for that upload.
import type { FileRead, Measurement, ParseResult } from '../../types';
import { parseReportPages, type PdfPageText, type PdfTextItem } from './pdf-text.ts';

export interface OcrWord {
  text: string;
  /** 0-100, from Tesseract. */
  confidence: number;
  /** Pixel box, origin top-left. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /**
   * The baseline of the word's text line at the word's left edge (pixels from the top). Better than the box's bottom,
   * which sits lower for words with descenders ("ng/mL") and would split a table row.
   */
  baseline?: number;
}

/** Where a line's baseline (x0,y0)-(x1,y1) is at x. */
export function baselineAt(b: { x0: number; y0: number; x1: number; y1: number }, x: number): number {
  return b.x1 === b.x0 ? b.y0 : b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0);
}

/**
 * Common OCR slips in lab reports: "HbAlc" for HbA1c, "ulU/mL" for µIU/mL, the letters O and l inside numbers.
 * Applied to each word before parsing.
 */
export function fixOcrWord(text: string): string {
  let t = text;
  if (/^hba[li|]c$/i.test(t)) return 'HbA1c';
  t = t.replace(/^[uµ][li]U\/m[lL]$/, 'µIU/mL').replace(/^m[li]U\/m[lL]$/, 'mIU/mL');
  // Inside something that is otherwise a number: O → 0, l or I → 1 ("1O.2", "l2.5").
  if (/^[<>]?[\dOolI.,-]+$/.test(t) && /\d/.test(t)) t = t.replace(/[Oo]/g, '0').replace(/[lI]/g, '1');
  return t;
}

export interface OcrPage {
  width: number;
  height: number;
  words: OcrWord[];
  /** Mean word confidence, 0-100. */
  confidence: number;
  /** Tesseract's text-line baselines, used to straighten a tilted photo (pageSkew). */
  baselines?: OcrWord['bbox'][];
}

/** Anything that can OCR one image. ocr-engine.ts provides the browser one; tests use Tesseract in Node. */
export interface OcrEngine {
  recognize(image: OcrImage): Promise<OcrPage>;
}

/** What the engine accepts: a canvas, an image bitmap, a Blob or a URL (Tesseract takes all of these). */
export type OcrImage = Blob | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | string;

/** How well a device read went, so the review can offer a better read. */
export interface ReadQuality {
  method: 'ocr';
  /** Mean OCR word confidence, 0-100. */
  confidence: number;
  /** Results read. */
  found: number;
  /** Few results or low confidence: the review offers the Claude read. */
  poor: boolean;
}

const MIN_WORD_CONFIDENCE = 30;

/**
 * OCR words → PDF-style items. PDF coordinates grow upwards from the bottom, so y flips; low-confidence words with no
 * letters or digits (specks, table rules read as dashes) are dropped.
 */
export function ocrToPageText(page: OcrPage): PdfPageText {
  const items: PdfTextItem[] = [];
  // A photo is rarely straight: across a 1,000-pixel row, 2 degrees drifts 35 pixels, enough to split a table row
  // in two. Rotate each word back about the page centre by the tilt the baselines show.
  const skew = pageSkew(page);
  const cx = page.width / 2, cy = page.height / 2, cos = Math.cos(-skew), sin = Math.sin(-skew);
  for (const w of page.words) {
    const str = fixOcrWord(w.text.trim());
    // Tesseract sometimes scores real words 0 ("TOTAL T3" in a clean row), so only symbol-only specks are dropped.
    if (!str || (w.confidence < MIN_WORD_CONFIDENCE && !/[A-Za-z0-9]/.test(str))) continue;
    const { x0, y0, x1, y1 } = w.bbox;
    const height = Math.max(1, y1 - y0);
    // The word's start on its line's baseline, straightened.
    const dx = x0 - cx, dy = (w.baseline ?? y1) - cy;
    const x = cx + dx * cos - dy * sin, y = cy + dx * sin + dy * cos;
    items.push({ str, x, y: page.height - y, width: Math.max(1, x1 - x0), height });
  }
  return { items };
}

/** The page's tilt in radians (positive: text rises to the right in image coordinates), from long baselines. */
export function pageSkew(page: OcrPage): number {
  const slopes = (page.baselines ?? [])
    .filter(b => b.x1 - b.x0 > page.width * 0.25)
    .map(b => Math.atan2(b.y1 - b.y0, b.x1 - b.x0))
    .filter(a => Math.abs(a) < 0.2) // ignore anything steeper than ~11 degrees
    .sort((a, b) => a - b);
  return slopes.length ? slopes[Math.floor(slopes.length / 2)] : 0;
}

/** A read is poor when it found fewer than 3 results, or the words were read with under 70% confidence on average. */
export function readQuality(pages: OcrPage[], found: number): ReadQuality {
  const words = pages.flatMap(p => p.words);
  const confidence = words.length ? Math.round(words.reduce((n, w) => n + w.confidence, 0) / words.length) : 0;
  return { method: 'ocr', confidence, found, poor: found < 3 || confidence < 70 };
}

/** OCR pages → results, through the same parser as text PDFs, with the read quality attached. */
export function parseOcrPages(pages: OcrPage[], sourceFile: string): ParseResult & { read: ReadQuality } {
  const result = parseReportPages(pages.map(ocrToPageText), sourceFile);
  // The PDF wording ("has no readable text… upload a photo") does not fit a photo that was already read.
  result.warnings = result.warnings.map(w => /no readable text/.test(w) ? 'No text could be read from this image. Try a sharper, well-lit photo taken straight on.' : w)
    .map(w => w.replace('in this PDF', 'in this image'));
  const read = readQuality(pages, result.measurements.length);
  for (const m of result.measurements) {
    if (doubtful(m)) m.confidence = 'low';
    else if (read.confidence < 80 && m.confidence === 'high') m.confidence = 'medium';
  }
  return { ...result, read };
}

/**
 * OCR mostly fails by losing a decimal point ("415" for 41.5, "15-41" for 1.5-4.1), so a value far outside its own
 * printed range, or a percentage over 100, is marked for checking. A genuinely extreme result is only flagged, not
 * changed: the person confirms every value in the review.
 */
export function doubtful(m: Measurement): boolean {
  if (m.value == null) return false;
  if (m.unit.trim() === '%' && m.value > 100) return true;
  const r = m.range;
  if (!r || r.source !== 'report') return false;
  const top = r.high ?? r.low, bottom = r.low ?? r.high;
  if (top != null && top > 0 && m.value > top * 4) return true;
  if (bottom != null && bottom > 0 && m.value < bottom / 4) return true;
  return false;
}

/** True when an OCR'd page looks like a lab report rather than a photo of something else (a scan, an X-ray). */
export function looksLikeReport(pages: OcrPage[], found: number): boolean {
  if (found >= 2) return true;
  const text = pages.flatMap(p => p.words.map(w => w.text)).join(' ').toLowerCase();
  return /\b(reference|ref\.?\s*range|bio\.?\s*ref|result|investigation|observed value|units?)\b/.test(text) && found >= 1;
}

/** A device read worth improving with the Claude read: few results, low confidence, or values marked for checking. */
export function worthBetterRead(read: FileRead, draft: Pick<ParseResult, 'measurements'>): boolean {
  if (read.method !== 'ocr') return false;
  return read.poor || draft.measurements.some(m => m.sourceFile === read.fileName && m.confidence === 'low');
}
