// DOM-free DICOM decoding: header fields + uncompressed pixel data → windowed RGBA.
import * as dicomNs from 'dicom-parser';
import type { DataSet, Element } from 'dicom-parser';

// dicom-parser is a UMD bundle: bundlers expose named exports, Node exposes only `default`.
const dicomParser: typeof dicomNs = (dicomNs as unknown as { default?: typeof dicomNs }).default ?? dicomNs;

export const TAG = {
  transferSyntax: 'x00020010',
  modality: 'x00080060',
  studyDate: 'x00080020',
  seriesDate: 'x00080021',
  acquisitionDate: 'x00080022',
  contentDate: 'x00080023',
  studyDescription: 'x00081030',
  seriesDescription: 'x0008103e',
  manufacturer: 'x00080070',
  bodyPart: 'x00180015',
  samplesPerPixel: 'x00280002',
  photometric: 'x00280004',
  planar: 'x00280006',
  frames: 'x00280008',
  rows: 'x00280010',
  columns: 'x00280011',
  bitsAllocated: 'x00280100',
  bitsStored: 'x00280101',
  pixelRepresentation: 'x00280103',
  windowCenter: 'x00281050',
  windowWidth: 'x00281051',
  rescaleIntercept: 'x00281052',
  rescaleSlope: 'x00281053',
  pixelData: 'x7fe00010',
} as const;

const UNCOMPRESSED = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2', '1.2.840.10008.1.2.1.99']);
const BIG_ENDIAN = '1.2.840.10008.1.2.2';
export const JPEG_BASELINE = new Set(['1.2.840.10008.1.2.4.50']);

const TS_NAMES: Record<string, string> = {
  '1.2.840.10008.1.2': 'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
  '1.2.840.10008.1.2.2': 'Explicit VR Big Endian',
  '1.2.840.10008.1.2.1.99': 'Deflated Explicit VR Little Endian',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless SV1',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS Near-lossless',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.5': 'RLE Lossless',
  '1.2.840.10008.1.2.4.201': 'HTJ2K Lossless',
  '1.2.840.10008.1.2.4.203': 'HTJ2K',
};

export interface DicomHeader {
  modality: string | null;
  bodyPart: string | null;
  studyDate: string | null;
  studyDescription: string | null;
  seriesDescription: string | null;
  transferSyntax: string;
  rows: number;
  columns: number;
  frames: number;
  bitsAllocated: number;
  bitsStored: number;
  pixelRepresentation: number;
  samplesPerPixel: number;
  planar: number;
  photometric: string;
  slope: number;
  intercept: number;
  windowCenter: number | null;
  windowWidth: number | null;
  compressed: boolean;
  hasPixels: boolean;
}

export interface DicomDecoded {
  header: DicomHeader;
  dataSet: DataSet;
  /** Modality-LUT values (slope/intercept applied) for the first frame, grayscale only. */
  values: Float32Array | null;
  /** RGB(A) pixels for colour images. */
  rgb: Uint8ClampedArray | null;
  min: number;
  max: number;
  /** Raw bytes of the first compressed frame (encapsulated transfer syntaxes). */
  compressedFrame: Uint8Array | null;
}

/** True when the buffer has the "DICM" magic at byte 128. */
export function hasDicmMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
}

function parse(bytes: Uint8Array): DataSet {
  if (hasDicmMagic(bytes)) return dicomParser.parseDicom(bytes);
  // Some files are a raw dataset without the preamble/meta header.
  return dicomParser.parseDicom(bytes, { TransferSyntaxUID: '1.2.840.10008.1.2' });
}

const str = (ds: DataSet, tag: string): string | null => {
  try { const v = ds.string(tag); return v && v.trim() ? v.trim() : null; } catch { return null; }
};
const num = (ds: DataSet, tag: string, fallback: number): number => {
  const el = ds.elements[tag];
  if (!el || !el.length) return fallback;
  try {
    const v = el.vr === 'DS' || el.vr === 'IS' ? ds.floatString(tag) : ds.uint16(tag);
    if (v != null && Number.isFinite(v)) return v;
    const f = ds.floatString(tag);
    return f != null && Number.isFinite(f) ? f : fallback;
  } catch { return fallback; }
};
const floatStr = (ds: DataSet, tag: string): number | null => {
  try { const v = ds.floatString(tag, 0); return v != null && Number.isFinite(v) ? v : null; } catch { return null; }
};

function dicomDate(ds: DataSet): string | null {
  for (const tag of [TAG.studyDate, TAG.seriesDate, TAG.acquisitionDate, TAG.contentDate]) {
    const v = str(ds, tag)?.replace(/\D/g, '');
    if (v && v.length >= 8) {
      const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8);
      if (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    }
  }
  return null;
}

export function readHeader(ds: DataSet): DicomHeader {
  const transferSyntax = str(ds, TAG.transferSyntax) ?? '1.2.840.10008.1.2';
  const pixel: Element | undefined = ds.elements[TAG.pixelData];
  const bitsAllocated = num(ds, TAG.bitsAllocated, 16);
  return {
    modality: str(ds, TAG.modality),
    bodyPart: str(ds, TAG.bodyPart),
    studyDate: dicomDate(ds),
    studyDescription: str(ds, TAG.studyDescription),
    seriesDescription: str(ds, TAG.seriesDescription),
    transferSyntax,
    rows: num(ds, TAG.rows, 0),
    columns: num(ds, TAG.columns, 0),
    frames: Math.max(1, Math.round(num(ds, TAG.frames, 1))),
    bitsAllocated,
    bitsStored: num(ds, TAG.bitsStored, bitsAllocated),
    pixelRepresentation: num(ds, TAG.pixelRepresentation, 0),
    samplesPerPixel: num(ds, TAG.samplesPerPixel, 1),
    planar: num(ds, TAG.planar, 0),
    photometric: (str(ds, TAG.photometric) ?? 'MONOCHROME2').toUpperCase(),
    slope: floatStr(ds, TAG.rescaleSlope) ?? 1,
    intercept: floatStr(ds, TAG.rescaleIntercept) ?? 0,
    windowCenter: floatStr(ds, TAG.windowCenter),
    windowWidth: floatStr(ds, TAG.windowWidth),
    compressed: !!pixel?.encapsulatedPixelData || !UNCOMPRESSED.has(transferSyntax),
    hasPixels: !!pixel && pixel.length !== 0,
  };
}

function firstCompressedFrame(ds: DataSet): Uint8Array | null {
  const el = ds.elements[TAG.pixelData];
  if (!el?.fragments?.length) return null;
  const bytes = ds.byteArray;
  // Single-frame: concatenate all fragments. Multi-frame with offset table: fragments until next offset.
  const bot = el.basicOffsetTable ?? [];
  const end = bot.length > 1 ? bot[1] : Infinity;
  const parts = el.fragments.filter(f => f.offset < end);
  const total = parts.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const f of parts) { out.set(bytes.subarray(f.position, f.position + f.length), o); o += f.length; }
  return out;
}

/** Parse a DICOM buffer and decode its first frame's pixels (uncompressed only). */
export function decodeDicom(buffer: ArrayBuffer | Uint8Array): DicomDecoded {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ds = parse(bytes);
  const h = readHeader(ds);
  const empty: DicomDecoded = { header: h, dataSet: ds, values: null, rgb: null, min: 0, max: 0, compressedFrame: null };
  if (!h.hasPixels || !h.rows || !h.columns) return empty;
  if (h.compressed) return { ...empty, compressedFrame: firstCompressedFrame(ds) };

  const el = ds.elements[TAG.pixelData];
  const n = h.rows * h.columns;
  const spp = h.samplesPerPixel;
  const bytesPer = h.bitsAllocated / 8;
  const start = el.dataOffset;
  const available = Math.min(el.length > 0 ? el.length : Infinity, ds.byteArray.length - start);
  const big = h.transferSyntax === BIG_ENDIAN;

  if (spp === 3) {
    if (h.bitsAllocated !== 8 || available < n * 3) return empty;
    const src = ds.byteArray.subarray(start, start + n * 3);
    const rgb = new Uint8ClampedArray(n * 4);
    const ybr = h.photometric.startsWith('YBR_FULL');
    for (let i = 0; i < n; i++) {
      let r: number, g: number, b: number;
      if (h.planar === 1) { r = src[i]; g = src[n + i]; b = src[2 * n + i]; }
      else { r = src[3 * i]; g = src[3 * i + 1]; b = src[3 * i + 2]; }
      if (ybr) {
        const y = r, cb = g - 128, cr = b - 128;
        r = y + 1.402 * cr; g = y - 0.344136 * cb - 0.714136 * cr; b = y + 1.772 * cb;
      }
      rgb[4 * i] = r; rgb[4 * i + 1] = g; rgb[4 * i + 2] = b; rgb[4 * i + 3] = 255;
    }
    return { ...empty, rgb, min: 0, max: 255 };
  }
  if (spp !== 1 || ![8, 16, 32].includes(h.bitsAllocated) || available < n * bytesPer) return empty;
  if (h.bitsAllocated === 1) return empty;

  const view = new DataView(ds.byteArray.buffer, ds.byteArray.byteOffset + start, n * bytesPer);
  const stored = Math.min(h.bitsStored || h.bitsAllocated, h.bitsAllocated);
  const signed = h.pixelRepresentation === 1;
  const mask = stored >= 32 ? 0xffffffff : (2 ** stored) - 1;
  const signBit = 2 ** (stored - 1);
  const values = new Float32Array(n);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    let raw: number;
    if (bytesPer === 1) raw = view.getUint8(i);
    else if (bytesPer === 2) raw = view.getUint16(i * 2, !big);
    else raw = view.getUint32(i * 4, !big);
    if (stored < h.bitsAllocated) raw = (raw & mask) >>> 0;
    if (signed && raw >= signBit) raw -= 2 * signBit;
    const v = raw * h.slope + h.intercept;
    values[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { ...empty, values, min, max };
}

export interface Windowed { rgba: Uint8ClampedArray; width: number; height: number; center: number; window: number }

/** Default window: from the file if present, else the full value range. */
export function defaultWindow(d: DicomDecoded): { center: number; width: number } {
  const h = d.header;
  if (h.windowCenter != null && h.windowWidth != null && h.windowWidth > 0) return { center: h.windowCenter, width: h.windowWidth };
  if (d.rgb) return { center: 128, width: 256 };
  const width = Math.max(1, d.max - d.min);
  return { center: d.min + width / 2, width };
}

/** Apply a linear VOI window (DICOM PS3.3 C.11.2.1.2) and photometric inversion → RGBA bytes. */
export function applyWindow(d: DicomDecoded, center?: number, width?: number): Windowed | null {
  const h = d.header;
  const def = defaultWindow(d);
  const c = center ?? def.center;
  const w = Math.max(1, width ?? def.width);
  const n = h.rows * h.columns;
  const out = new Uint8ClampedArray(n * 4);
  const lo = c - 0.5 - (w - 1) / 2, hi = c - 0.5 + (w - 1) / 2;
  if (d.rgb) {
    const scale = 255 / w, offset = c - w / 2;
    for (let i = 0; i < n * 4; i += 4) {
      out[i] = (d.rgb[i] - offset) * scale; out[i + 1] = (d.rgb[i + 1] - offset) * scale; out[i + 2] = (d.rgb[i + 2] - offset) * scale; out[i + 3] = 255;
    }
    return { rgba: out, width: h.columns, height: h.rows, center: c, window: w };
  }
  if (!d.values) return null;
  const invert = h.photometric === 'MONOCHROME1';
  const denom = w - 1 || 1;
  for (let i = 0; i < n; i++) {
    const x = d.values[i];
    let g: number;
    if (x <= lo) g = 0;
    else if (x > hi) g = 255;
    else g = ((x - (c - 0.5)) / denom + 0.5) * 255;
    if (invert) g = 255 - g;
    const j = i * 4;
    out[j] = g; out[j + 1] = g; out[j + 2] = g; out[j + 3] = 255;
  }
  return { rgba: out, width: h.columns, height: h.rows, center: c, window: w };
}

/** Readable header summary (no patient identifiers). */
export function headerMeta(h: DicomHeader): Record<string, string> {
  const meta: Record<string, string> = {};
  const put = (k: string, v: string | number | null | undefined) => { if (v != null && v !== '') meta[k] = String(v); };
  put('Modality', h.modality);
  put('Body part', h.bodyPart);
  put('Study date', h.studyDate);
  put('Study', h.studyDescription);
  put('Series', h.seriesDescription);
  put('Size', h.rows && h.columns ? `${h.columns} × ${h.rows}` : null);
  if (h.frames > 1) put('Frames', h.frames);
  put('Bits', `${h.bitsStored}/${h.bitsAllocated}${h.pixelRepresentation === 1 ? ' signed' : ''}`);
  put('Photometric', h.photometric);
  if (h.slope !== 1 || h.intercept !== 0) put('Rescale', `× ${h.slope} + ${h.intercept}`);
  if (h.windowCenter != null && h.windowWidth != null) put('Window', `C ${h.windowCenter} / W ${h.windowWidth}`);
  put('Transfer syntax', TS_NAMES[h.transferSyntax] ?? h.transferSyntax);
  return meta;
}

export function transferSyntaxName(uid: string): string {
  return TS_NAMES[uid] ?? uid;
}
