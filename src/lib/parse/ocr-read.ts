// Photos and scanned PDFs → results, on the device: prepare the image (orientation, size), OCR it (ocr-engine.ts),
// parse the words (ocr.ts). Loaded only when such a file is uploaded.
import type { ParseResult } from '../../types';
import { browserOcr } from './ocr-engine.ts';
import { looksLikeReport, parseOcrPages, type OcrPage } from './ocr.ts';
import type { ParseProgress } from './index.ts';

/** Tesseract reads best at roughly 150-300 dpi; a phone photo is scaled to at most this many pixels on its long side. */
const MAX_SIDE = 2400;
const MIN_SIDE = 1400;
const MAX_PAGES = 10;

/** The photo upright (EXIF orientation applied) and at a size Tesseract reads well. */
export async function prepareImage(blob: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const long = Math.max(bmp.width, bmp.height);
  const scale = long > MAX_SIDE ? MAX_SIDE / long : long < MIN_SIDE ? MIN_SIDE / long : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas;
}

function asResult(read: ReturnType<typeof parseOcrPages>, fileName: string): ParseResult {
  const { read: q, ...result } = read;
  return { ...result, reads: [{ fileName, method: 'ocr', confidence: q.confidence, found: q.found, poor: q.poor }] };
}

/** A photo of a lab report → results; null when it does not look like a report (it is then kept as a scan). */
export async function readReportPhoto(file: File, onProgress?: ParseProgress): Promise<ParseResult | null> {
  onProgress?.(`Reading the text in ${file.name}…`);
  const page = await browserOcr.recognize(await prepareImage(file));
  const read = parseOcrPages([page], file.name);
  return looksLikeReport([page], read.measurements.length) ? asResult(read, file.name) : null;
}

/** A PDF without a text layer → render each page and read it. */
export async function readScannedPdf(file: File, onProgress?: ParseProgress): Promise<ParseResult> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages: OcrPage[] = [];
  const count = Math.min(doc.numPages, MAX_PAGES);
  try {
    for (let p = 1; p <= count; p++) {
      onProgress?.(`Reading page ${p} of ${count} of ${file.name}…`);
      const page = await doc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(4, MAX_SIDE / Math.max(base.width, base.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      pages.push(await browserOcr.recognize(canvas));
      page.cleanup();
    }
  } finally {
    void task.destroy();
  }
  const read = asResult(parseOcrPages(pages, file.name), file.name);
  if (doc.numPages > MAX_PAGES) read.warnings.push(`Only the first ${MAX_PAGES} pages were read.`);
  return read;
}
