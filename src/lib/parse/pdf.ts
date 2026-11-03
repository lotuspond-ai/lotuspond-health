// PDF lab reports via pdfjs-dist (text layer only; no OCR).
// Legacy build: the modern one calls Map.getOrInsertComputed, Math.sumPrecise and Promise.try, which iOS
// WebViews before iOS 26 (and older Safari / Android WebView versions) lack.
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { ParseResult } from '../../types';
import { parseReportPages, type PdfPageText, type PdfTextItem } from './pdf-text.ts';

GlobalWorkerOptions.workerSrc = workerUrl;

interface RawItem { str?: unknown; transform?: unknown; width?: unknown; height?: unknown }

function toItem(raw: RawItem): PdfTextItem | null {
  if (typeof raw.str !== 'string' || !Array.isArray(raw.transform)) return null;
  const t = raw.transform as unknown[];
  const [a, b, c, d, e, f] = t.map(v => (typeof v === 'number' ? v : 0));
  // Skip rotated / vertical text (watermarks, side labels).
  if (Math.abs(b) > Math.abs(a) * 0.2 || Math.abs(c) > Math.abs(d) * 0.2) return null;
  const height = typeof raw.height === 'number' && raw.height > 0 ? raw.height : Math.hypot(c, d) || 8;
  return { str: raw.str, x: e, y: f, width: typeof raw.width === 'number' ? raw.width : raw.str.length * height * 0.5, height };
}

/** Extract positioned text from every page. */
export async function extractPdfText(data: ArrayBuffer): Promise<PdfPageText[]> {
  const task = getDocument({ data: new Uint8Array(data) });
  const doc = await task.promise;
  try {
    const pages: PdfPageText[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const it of content.items) {
        const item = toItem(it as RawItem);
        if (item) items.push(item);
      }
      pages.push({ items });
      page.cleanup();
    }
    return pages;
  } finally {
    void task.destroy();
  }
}

export async function parsePdf(file: File): Promise<ParseResult> {
  let pages: PdfPageText[];
  try {
    pages = await extractPdfText(await file.arrayBuffer());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const locked = /password/i.test(msg);
    return {
      measurements: [], scans: [], blobs: {}, detectedDate: null,
      warnings: [locked ? 'This PDF is password-protected. Open it, save an unlocked copy, and upload that.' : `This PDF could not be opened (${msg}).`],
    };
  }
  return parseReportPages(pages, file.name);
}
