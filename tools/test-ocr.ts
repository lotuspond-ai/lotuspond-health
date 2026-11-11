// On-device report reading, measured: the real Tesseract engine (tesseract.js in Node, with the same English data the
// app serves) reads the five synthetic photographed reports in tools/fixtures/report-photos/, and the app's parser
// turns the words into results. Each value is checked against the truth in report-photos.json.
//   npm run test:ocr
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker, OEM, type Worker } from 'tesseract.js';
import { baselineAt, fixOcrWord, looksLikeReport, parseOcrPages, readQuality, type OcrPage, type OcrWord } from '../src/lib/parse/ocr.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, 'report-photos.json'), 'utf8')) as {
  reports: { file: string; layout: string; truth: Record<string, number> }[];
};
const LANG = path.join(here, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int');

let worker: Worker;
before(async () => {
  worker = await createWorker('eng', OEM.LSTM_ONLY, { langPath: LANG, cachePath: path.join(here, '..', 'node_modules', '.cache', 'tesseract') });
});
after(async () => { await worker?.terminate(); });

interface TWord { text: string; confidence: number; bbox: OcrWord['bbox'] }
async function ocr(file: string): Promise<OcrPage> {
  const { data } = await worker.recognize(path.join(fixtures, 'report-photos', file), {}, { blocks: true });
  const words: OcrWord[] = [];
  const baselines: OcrWord['bbox'][] = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
    baselines.push(l.baseline);
    for (const w of l.words as TWord[]) words.push({ text: w.text, confidence: w.confidence, bbox: w.bbox, baseline: baselineAt(l.baseline, w.bbox.x0) });
  }
  // The fixtures are 1240 × 1754 (A4 at 150 dpi).
  return { width: 1240, height: 1754, words, confidence: data.confidence, baselines };
}

const totals = { expected: 0, correct: 0 };

describe('photographed reports', () => {
  for (const r of manifest.reports) {
    test(`${r.file} (${r.layout})`, async () => {
      const page = await ocr(r.file);
      const parsed = parseOcrPages([page], r.file);
      const byId = new Map(parsed.measurements.filter(m => m.markerId).map(m => [m.markerId!, m]));
      const wrong: string[] = [];
      for (const [id, value] of Object.entries(r.truth)) {
        totals.expected++;
        const m = byId.get(id);
        if (m?.value === value) { totals.correct++; continue; }
        wrong.push(`${id}: read ${m?.value ?? 'nothing'}, expected ${value}`);
        // A misread value must not look certain: the review highlights it for checking.
        if (m) assert.notEqual(m.confidence, 'high', `${id} misread as ${m.value} but marked high confidence`);
      }
      const share = 1 - wrong.length / Object.keys(r.truth).length;
      console.log(`  ${r.file}: ${Math.round(share * 100)}% of values right, OCR confidence ${parsed.read.confidence}${wrong.length ? `; ${wrong.join('; ')}` : ''}`);
      assert.ok(looksLikeReport([page], parsed.measurements.length), 'recognised as a report');
      assert.ok(share >= 0.75, `at least 3 in 4 values right: ${wrong.join('; ')}`);
      assert.equal(parsed.detectedDate, '2026-11-04', 'the sample date is read');
    });
  }

  test('overall accuracy', () => {
    const share = totals.correct / totals.expected;
    console.log(`  overall: ${totals.correct}/${totals.expected} values right (${Math.round(share * 100)}%)`);
    assert.ok(share >= 0.85, `overall at least 85%, got ${Math.round(share * 100)}%`);
  });
});

describe('OCR clean-up', () => {
  test('common slips are fixed before parsing', () => {
    assert.equal(fixOcrWord('HbAlc'), 'HbA1c');
    assert.equal(fixOcrWord('ulU/mL'), 'µIU/mL');
    assert.equal(fixOcrWord('1O.2'), '10.2');
    assert.equal(fixOcrWord('l2.5'), '12.5');
    assert.equal(fixOcrWord('Total'), 'Total', 'words are left alone');
    assert.equal(fixOcrWord('Ol'), 'Ol', 'no digits, not a number');
  });

  test('a tilted page is straightened from its baselines', async () => {
    const { pageSkew, ocrToPageText } = await import('../src/lib/parse/ocr.ts');
    const tilt = 0.03; // about 1.7 degrees
    const line = (y: number) => ({ x0: 100, y0: y, x1: 1100, y1: y + 1000 * Math.tan(tilt) });
    const page: OcrPage = { width: 1200, height: 1600, confidence: 90, words: [], baselines: [line(400), line(460), line(520)] };
    assert.ok(Math.abs(pageSkew(page) - tilt) < 1e-6);
    // Two words on one tilted row land on the same straightened line.
    page.words = [
      { text: 'Haemoglobin', confidence: 90, bbox: { x0: 100, y0: 380, x1: 300, y1: 400 }, baseline: 400 },
      { text: '13.2', confidence: 90, bbox: { x0: 1000, y0: 380 + 900 * Math.tan(tilt), x1: 1060, y1: 400 + 900 * Math.tan(tilt) }, baseline: 400 + 900 * Math.tan(tilt) },
    ];
    const [a, b] = ocrToPageText(page).items;
    assert.ok(Math.abs(a.y - b.y) < 0.5, `${a.y} vs ${b.y}`);
  });
});

describe('read quality', () => {
  test('few results or low confidence is a poor read', () => {
    const page = (confidence: number): OcrPage => ({ width: 10, height: 10, confidence, words: [{ text: 'x', confidence, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] });
    assert.equal(readQuality([page(90)], 6).poor, false);
    assert.equal(readQuality([page(90)], 2).poor, true);
    assert.equal(readQuality([page(55)], 6).poor, true);
  });
});
