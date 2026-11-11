// Entry point: read any supported file into a ParseResult. Everything runs in the browser.
import type { ParseResult } from '../../types';
import { parseCsvText } from './csv.ts';
import { parseJsonText } from './json.ts';
import { looksLikeDicom, parseDicomFile } from './dicom.ts';
import { parseImage } from './image.ts';
import { OCR_BASE } from './ocr-engine.ts';

export { parseCsvText } from './csv.ts';
export { parseJsonText } from './json.ts';
export { parseReportPages, buildLines, findRows } from './pdf-text.ts';
export { detectReportDate, parseDate, findDates } from './dates.ts';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
const MAX_TEXT = 25 * 1024 * 1024;

function empty(warning: string): ParseResult {
  return { measurements: [], scans: [], blobs: {}, warnings: [warning], detectedDate: null };
}

async function sniff(file: File): Promise<'pdf' | 'json' | 'text' | 'dicom' | 'image' | null> {
  const head = new Uint8Array(await file.slice(0, 132).arrayBuffer());
  const ascii = String.fromCharCode(...head.subarray(0, 8));
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (head.length >= 132 && head[128] === 0x44 && head[129] === 0x49 && head[130] === 0x43 && head[131] === 0x4d) return 'dicom';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'image';
  if (ascii.startsWith('RIFF') || ascii.startsWith('GIF8')) return 'image';
  const lead = ascii.replace(/^﻿/, '').trimStart();
  if (lead.startsWith('{') || lead.startsWith('[')) return 'json';
  if (head.length && head.every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128)) return 'text';
  return null;
}

/** Parse a user file (PDF, CSV/TSV/TXT, JSON, image, DICOM), dispatching by extension, MIME type, then content. */
/** Progress while reading: "Reading the photo…", "Reading page 2 of 3…". */
export type ParseProgress = (message: string) => void;

export async function parseFile(file: File, onProgress?: ParseProgress): Promise<ParseResult> {
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  let kind: Awaited<ReturnType<typeof sniff>> = null;
  if (name.endsWith('.pdf') || type === 'application/pdf') kind = 'pdf';
  else if (/\.(csv|tsv|tab|txt)$/.test(name) || type === 'text/csv' || type === 'text/tab-separated-values' || type === 'text/plain') kind = 'text';
  else if (name.endsWith('.json') || type === 'application/json') kind = 'json';
  else if (await looksLikeDicom(file)) kind = 'dicom';
  else if (IMAGE_EXT.test(name) || type.startsWith('image/')) kind = 'image';
  else if (/\.(xlsx?|ods|numbers)$/.test(name)) return empty('Spreadsheet files cannot be read directly. In Excel or Sheets choose File → Save as / Download → CSV, then upload the CSV.');
  else if (/\.(docx?|rtf|odt)$/.test(name)) return empty('Word documents are not supported. Save the report as PDF and upload that.');
  else kind = await sniff(file);

  switch (kind) {
    case 'pdf': {
      const { parsePdf } = await import('./pdf.ts');
      const r = await parsePdf(file);
      // A scanned PDF has no text layer: read its pages as images on the device.
      if (OCR_BASE && !r.measurements.length && r.warnings.some(w => /no readable text/.test(w))) {
        const { readScannedPdf } = await import('./ocr-read.ts');
        return readScannedPdf(file, onProgress);
      }
      return r;
    }
    case 'text': {
      if (file.size > MAX_TEXT) return empty('This file is too large to read as a table.');
      const text = await file.text();
      const trimmed = text.replace(/^﻿/, '').trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJsonFile(text, file.name);
      return parseCsvText(text, file.name);
    }
    case 'json': {
      if (file.size > MAX_TEXT) return empty('This file is too large to read.');
      return parseJsonFile(await file.text(), file.name);
    }
    case 'dicom':
      return parseDicomFile(file);
    case 'image': {
      // A photo may be a lab report (read it) or a scan, an X-ray or a skin photo (keep it as a scan).
      if (OCR_BASE) {
        const { readReportPhoto } = await import('./ocr-read.ts');
        const read = await readReportPhoto(file, onProgress).catch(() => null);
        if (read) return read;
      }
      return parseImage(file);
    }
    default:
      return empty('This file type is not supported. Use a PDF lab report, CSV or JSON export, DICOM (.dcm) or an image.');
  }
}

/**
 * JSON, with FHIR's embedded reports: a DiagnosticReport that carries only a PDF (common in ABDM records) is read
 * like an uploaded PDF, and its results are added to the review with the bundle as their source.
 */
async function parseJsonFile(text: string, fileName: string): Promise<ParseResult> {
  const r = parseJsonText(text, fileName);
  if (r.measurements.length) return r;
  let data: unknown;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return r; }
  const { isFhir, fhirAttachments, fhirPatientName } = await import('./fhir.ts');
  if (!isFhir(data)) return r;
  const pdfs = fhirAttachments(data).filter(a => /pdf/i.test(a.contentType)).slice(0, 10);
  if (!pdfs.length) return r;
  const { parsePdf } = await import('./pdf.ts');
  const out: ParseResult = { ...r, warnings: r.warnings.filter(w => !/No lab results were found/.test(w)) };
  for (const a of pdfs) {
    try {
      const bytes = Uint8Array.from(atob(a.data.replace(/\s+/g, '')), c => c.charCodeAt(0));
      const read = await parsePdf(new File([bytes], fileName, { type: 'application/pdf' }));
      out.measurements.push(...read.measurements);
      out.warnings.push(...read.warnings.map(w => `${a.title}: ${w}`));
      out.detectedDate ??= read.detectedDate;
    } catch {
      out.warnings.push(`${a.title}: the report attached to this record could not be read.`);
    }
  }
  const who = fhirPatientName(data);
  if (who && out.measurements.length) out.warnings.unshift(`These results are for ${who}. Add them only to that person’s profile.`);
  if (!out.measurements.length && !out.warnings.length) out.warnings.push('No lab results were found in this FHIR file or the report attached to it.');
  return out;
}
