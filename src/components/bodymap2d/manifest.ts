// The pre-rendered body map (tools/render-bodymap.mjs): image names, organ colours in the ID maps, and projected
// pin, landmark and box positions. manifest.json here is the tool's copy of public/bodymap/manifest.json, bundled
// with the app so the first view needs no extra request (Vite does not let code import files from public/).
import data from './manifest.json';
import type { OrganId } from '../../types';

/** x and y as fractions of the image (y down), then metres in front of (+) or behind (-) the view centre. */
export type Point = [number, number, number];
export type Density = '1x' | '2x';

export interface AngleView {
  deg: number;
  image: Record<Density, string>;
  id: string;
  pins: Partial<Record<OrganId, Point>>;
  /** x0, y0, x1, y1 as fractions of the image. */
  boxes: Partial<Record<OrganId, [number, number, number, number]>>;
}

export interface CloseUp { image: Record<Density, string>; landmarks: Point[] }

export interface BodyMapManifest {
  version: number;
  model: { path: string; sha: string; bytes: number };
  sizes: Record<Density, [number, number]>;
  idSize: [number, number];
  /** Background colour of the images, which the stage takes on so their edges disappear. */
  background?: string;
  organs: { id: OrganId; index: number; color: string }[];
  angles: AngleView[];
  closeups: Partial<Record<OrganId, CloseUp>>;
}

export const MANIFEST = data as unknown as BodyMapManifest;

export const bodymapUrl = (file: string) => `${import.meta.env.BASE_URL}bodymap/${file}`;

const [w1, h1] = MANIFEST.sizes['1x'] ?? [2, 3];
export const ASPECT = w1 / h1;

/** Organ for each ID-map index (0 is empty space). */
export const ID_ORGAN: (OrganId | null)[] = [null];
for (const o of MANIFEST.organs) ID_ORGAN[o.index] = o.id;
export const ORGAN_INDEX = Object.fromEntries(MANIFEST.organs.map(o => [o.id, o.index])) as Record<OrganId, number>;

const PALETTE = MANIFEST.organs.map(o => [o.index, parseInt(o.color.slice(1, 3), 16), parseInt(o.color.slice(3, 5), 16), parseInt(o.color.slice(5, 7), 16)]);
const EXACT = new Map(PALETTE.map(([i, r, g, b]) => [(r << 16) | (g << 8) | b, i]));

/** Index for a decoded colour. Exact in practice; the nearest match covers browsers that add noise to canvas reads. */
function indexOf(r: number, g: number, b: number, misses: Map<number, number>) {
  const key = (r << 16) | (g << 8) | b;
  const hit = EXACT.get(key) ?? misses.get(key);
  if (hit !== undefined) return hit;
  let best = 0, bestD = 24 * 24 * 3;
  for (const [i, pr, pg, pb] of PALETTE) { const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2; if (d < bestD) { bestD = d; best = i; } }
  misses.set(key, best);
  return best;
}

export interface IdMap { width: number; height: number; ids: Uint8Array }

async function decode(url: string): Promise<IdMap> {
  const blob = await (await fetch(url)).blob();
  let src: CanvasImageSource;
  try { src = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
  catch {
    const img = new Image(); img.src = URL.createObjectURL(blob);
    await img.decode(); URL.revokeObjectURL(img.src); src = img;
  }
  const [width, height] = MANIFEST.idSize;
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, 0, 0, width, height);
  if ('close' in src) src.close();
  const px = g.getImageData(0, 0, width, height).data;
  const ids = new Uint8Array(width * height), misses = new Map<number, number>();
  for (let i = 0, j = 0; i < ids.length; i++, j += 4) ids[i] = px[j] === 0 && px[j + 1] === 0 && px[j + 2] === 0 ? 0 : indexOf(px[j], px[j + 1], px[j + 2], misses);
  return { width, height, ids };
}

const cache = new Map<string, Promise<IdMap>>();

/** Decoded ID map of an angle (decoded once, a few kept). */
export function loadIdMap(angle: number): Promise<IdMap> {
  const url = bodymapUrl(MANIFEST.angles[angle].id);
  let p = cache.get(url);
  if (!p) {
    p = decode(url);
    p.catch(() => cache.delete(url));
    cache.set(url, p);
    if (cache.size > 6) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Start downloading an image without showing it. */
const warm = new Set<string>();
export function preload(url: string) {
  if (warm.has(url)) return;
  warm.add(url);
  const img = new Image(); img.decoding = 'async'; img.src = url;
}
