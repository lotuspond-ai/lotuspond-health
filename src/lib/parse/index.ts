// Entry point: read any supported file into a ParseResult. Everything runs in the browser.
import type { ParseResult } from '../../types';
import { parseCsvText } from './csv.ts';
import { parseJsonText } from './json.ts';
import { looksLikeDicom, parseDicomFile } from './dicom.ts';
import { parseImage } from './image.ts';

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
export async function parseFile(file: File): Promise<ParseResult> {
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
      return parsePdf(file);
    }
    case 'text': {
      if (file.size > MAX_TEXT) return empty('This file is too large to read as a table.');
      const text = await file.text();
      const trimmed = text.replace(/^﻿/, '').trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJsonText(text, file.name);
      return parseCsvText(text, file.name);
    }
    case 'json': {
      if (file.size > MAX_TEXT) return empty('This file is too large to read.');
      return parseJsonText(await file.text(), file.name);
    }
    case 'dicom':
      return parseDicomFile(file);
    case 'image':
      return parseImage(file);
    default:
      return empty('This file type is not supported. Use a PDF lab report, CSV or JSON export, DICOM (.dcm) or an image.');
  }
}
