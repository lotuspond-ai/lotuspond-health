// Writes a small text-only PDF lab report for the simulated lab: base-14 Helvetica with WinAnsi encoding,
// laid out like a typical Indian lab report (header block, then Test Name | Result | Unit | Bio. Ref. Interval).
// The browser's PDF parser (src/lib/parse/pdf-text.ts) reads it like any uploaded report.

export interface PdfRow { name: string; value: string; flag: string; unit: string; range: string }
export interface PdfPanel { title: string; rows: PdfRow[] }

export interface PdfReportInput {
  labName: string;
  subtitle: string;
  /** Label/value pairs printed in two columns, e.g. ["Collected On", "03/Nov/2026 08:12 AM"]. */
  header: [string, string][];
  panels: PdfPanel[];
  /** Printed under the tables, e.g. an amendment remark. */
  notes: string[];
  footer: string;
}

interface Op { font: 'F1' | 'F2'; size: number; x: number; y: number; text: string }
interface Line { x1: number; y1: number; x2: number; y2: number }
interface Page { ops: Op[]; lines: Line[] }

const W = 595, H = 842, LEFT = 40, RIGHT = W - 40;
const COLS = [LEFT, 250, 320, 400];
const ROW_H = 14, BOTTOM = 90;

// WinAnsi differs from Latin-1 only in 0x80-0x9F; map the few typographic characters we might print there.
const WIN_ANSI_EXTRA: Record<string, number> = { '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95 };

function pdfString(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    const byte = WIN_ANSI_EXTRA[ch] ?? (code < 0x80 || (code >= 0xa0 && code <= 0xff) ? code : 63);
    const c = String.fromCharCode(byte);
    out += c === '(' || c === ')' || c === '\\' ? `\\${c}` : c;
  }
  return `(${out})`;
}

function layout(input: PdfReportInput): Page[] {
  const pages: Page[] = [];
  let page!: Page;
  let y = 0;

  const newPage = () => {
    page = { ops: [], lines: [] };
    pages.push(page);
    page.ops.push({ font: 'F2', size: 14, x: LEFT, y: H - 50, text: input.labName });
    page.ops.push({ font: 'F1', size: 8, x: LEFT, y: H - 62, text: input.subtitle });
    input.header.forEach(([label, value], i) => {
      const x = i % 2 === 0 ? LEFT : 330;
      page.ops.push({ font: 'F1', size: 9, x, y: H - 90 - Math.floor(i / 2) * 13, text: `${label} : ${value}` });
    });
    y = H - 90 - Math.ceil(input.header.length / 2) * 13 - 4;
    page.lines.push({ x1: LEFT, y1: y, x2: RIGHT, y2: y });
    y -= 22;
  };
  const need = (h: number) => { if (y - h < BOTTOM) newPage(); };

  const tableHeader = (title: string) => {
    page.ops.push({ font: 'F2', size: 10, x: LEFT, y, text: title });
    y -= 15;
    ['Test Name', 'Result', 'Unit', 'Bio. Ref. Interval'].forEach((label, i) => page.ops.push({ font: 'F2', size: 8, x: COLS[i], y, text: label }));
    y -= 4;
    page.lines.push({ x1: LEFT, y1: y, x2: RIGHT, y2: y });
    y -= 12;
  };

  newPage();
  for (const panel of input.panels) {
    need(ROW_H * 3);
    tableHeader(panel.title.toUpperCase());
    for (const r of panel.rows) {
      // A panel that runs onto the next page repeats its title and column headings, as printed reports do.
      if (y - ROW_H < BOTTOM) {
        newPage();
        tableHeader(`${panel.title.toUpperCase()} (CONTD.)`);
      }
      page.ops.push({ font: 'F1', size: 8, x: COLS[0], y, text: r.name });
      page.ops.push(r.flag
        ? { font: 'F2', size: 8, x: COLS[1], y, text: `${r.value} ${r.flag}` }
        : { font: 'F1', size: 8, x: COLS[1], y, text: r.value });
      if (r.unit) page.ops.push({ font: 'F1', size: 8, x: COLS[2], y, text: r.unit });
      if (r.range) page.ops.push({ font: 'F1', size: 8, x: COLS[3], y, text: r.range });
      y -= ROW_H;
    }
    y -= 10;
  }
  for (const note of input.notes) {
    need(ROW_H);
    page.ops.push({ font: 'F1', size: 8, x: LEFT, y, text: note });
    y -= 12;
  }
  pages.forEach((p, i) => {
    p.ops.push({ font: 'F1', size: 7, x: LEFT, y: 50, text: input.footer });
    p.ops.push({ font: 'F1', size: 7, x: RIGHT - 50, y: 50, text: `Page ${i + 1} of ${pages.length}` });
  });
  return pages;
}

function contentStream(p: Page): string {
  let s = '0.5 w\n';
  for (const l of p.lines) s += `${l.x1} ${l.y1} m ${l.x2} ${l.y2} l S\n`;
  for (const o of p.ops) s += `BT /${o.font} ${o.size} Tf ${o.x} ${o.y} Td ${pdfString(o.text)} Tj ET\n`;
  return s;
}

/** Render the report as PDF bytes. */
export function buildReportPdf(input: PdfReportInput): Uint8Array {
  const pages = layout(input);
  // Objects: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, then a page object and a content stream per page.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((p, i) => {
    const pageId = pageIds[i], contentId = pageId + 1;
    const stream = contentStream(p);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
