// The browser's OCR engine: Tesseract (tesseract.js) in a Web Worker, with its worker, core and English data served
// by LotusPond itself from /ocr/<version>/ (tools/ocr-assets.ts), never from a CDN. Loaded only when a photo or a
// scanned PDF needs reading; the English data (about 3 MB) is cached by the browser after the first use.
import { baselineAt, type OcrEngine, type OcrImage, type OcrPage, type OcrWord } from './ocr.ts';

declare const __OCR_BASE__: string | null;

/** Where the OCR files are, or null in builds without them (the server-less preview). */
export const OCR_BASE: string | null = typeof __OCR_BASE__ === 'undefined' ? null : __OCR_BASE__;

let worker: Promise<import('tesseract.js').Worker> | null = null;

function absolute(path: string): string {
  return new URL(path, document.baseURI).href;
}

async function getWorker() {
  if (!OCR_BASE) throw new Error('Reading photos is not available in this version of the app.');
  worker ??= (async () => {
    const { createWorker, OEM } = await import('tesseract.js');
    return createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: absolute(`${OCR_BASE}worker.min.js`),
      corePath: absolute(`${OCR_BASE}core`),
      langPath: absolute(`${OCR_BASE}lang`),
      // Served uncompressed (the server compresses it on the wire); Tesseract need not gunzip it.
      gzip: false,
      workerBlobURL: false,
    });
  })();
  try {
    return await worker;
  } catch (e) {
    worker = null;
    throw e;
  }
}

interface TBox { x0: number; y0: number; x1: number; y1: number }
interface TWord { text: string; confidence: number; bbox: TBox }
interface TBlock { paragraphs?: { lines?: { words?: TWord[]; baseline?: TBox }[] }[] }

export const browserOcr: OcrEngine = {
  async recognize(image: OcrImage): Promise<OcrPage> {
    const w = await getWorker();
    const { data } = await w.recognize(image as Parameters<typeof w.recognize>[0], {}, { blocks: true });
    const words: OcrWord[] = [];
    const baselines: OcrWord['bbox'][] = [];
    for (const b of (data.blocks ?? []) as TBlock[]) {
      for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) {
        if (l.baseline) baselines.push(l.baseline);
        for (const wd of l.words ?? []) {
          words.push({ text: wd.text, confidence: wd.confidence, bbox: wd.bbox, ...(l.baseline ? { baseline: baselineAt(l.baseline, wd.bbox.x0) } : {}) });
        }
      }
    }
    const size = await imageSize(image);
    return { width: size.width, height: size.height, words, confidence: data.confidence, baselines };
  },
};

async function imageSize(image: OcrImage): Promise<{ width: number; height: number }> {
  if (typeof image !== 'string' && 'width' in image && 'height' in image) return { width: image.width, height: image.height };
  const bmp = await createImageBitmap(typeof image === 'string' ? await (await fetch(image)).blob() : image);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

/** Free the worker (about 30 MB) when the upload dialog closes. */
export async function releaseOcr(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await (await w).terminate().catch(() => {});
}
