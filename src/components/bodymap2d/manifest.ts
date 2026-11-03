// The pre-rendered body map (tools/render-bodymap.mjs), one image set per body: image names, organ colours in the ID
// maps, and projected pin, landmark and box positions. manifest.<body>.json here is the tool's trimmed copy of
// public/bodymap/manifest.<body>.json, bundled with the app so the first view needs no extra request (Vite does not let
// code import files from public/).
import female from './manifest.female.json';
import male from './manifest.male.json';
import type { OrganId } from '../../types';
import { BODIES, type Body } from '../../lib/body';

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

/** Landmark points with their names (matched to the organ's landmark notes by name). */
export interface CloseUp { image: Record<Density, string>; landmarks: Point[]; names: string[] }

export interface BodyMapManifest {
  version: number;
  body: Body;
  model: { path: string; sha: string; bytes: number };
  sizes: Record<Density, [number, number]>;
  idSize: [number, number];
  /** Background colour of the images, which the stage takes on so their edges disappear. */
  background?: string;
  organs: { id: OrganId; index: number; color: string }[];
  angles: AngleView[];
  closeups: Partial<Record<OrganId, CloseUp>>;
}

export const MANIFESTS: Record<Body, BodyMapManifest> = { female: female as unknown as BodyMapManifest, male: male as unknown as BodyMapManifest };

export const bodymapUrl = (file: string) => `${import.meta.env.BASE_URL}bodymap/${file}`;

interface Derived {
  aspect: number;
  /** Organ for each ID-map index (0 is empty space). */
  idOrgan: (OrganId | null)[];
  organIndex: Partial<Record<OrganId, number>>;
  palette: number[][];
  exact: Map<number, number>;
}

const derived = new Map<Body, Derived>();

/** Values computed once per body from its manifest. */
export function viewOf(body: Body): Derived {
  let d = derived.get(body);
  if (!d) {
    const m = MANIFESTS[body];
    const [w1, h1] = m.sizes['1x'] ?? [2, 3];
    const idOrgan: (OrganId | null)[] = [null];
    for (const o of m.organs) idOrgan[o.index] = o.id;
    const palette = m.organs.map(o => [o.index, parseInt(o.color.slice(1, 3), 16), parseInt(o.color.slice(3, 5), 16), parseInt(o.color.slice(5, 7), 16)]);
    d = {
      aspect: w1 / h1, idOrgan, organIndex: Object.fromEntries(m.organs.map(o => [o.id, o.index])), palette,
      exact: new Map(palette.map(([i, r, g, b]) => [(r << 16) | (g << 8) | b, i])),
    };
    derived.set(body, d);
  }
  return d;
}

/** Index for a decoded colour. Exact in practice; the nearest match covers browsers that add noise to canvas reads. */
function indexOf(v: Derived, r: number, g: number, b: number, misses: Map<number, number>) {
  const key = (r << 16) | (g << 8) | b;
  const hit = v.exact.get(key) ?? misses.get(key);
  if (hit !== undefined) return hit;
  let best = 0, bestD = 24 * 24 * 3;
  for (const [i, pr, pg, pb] of v.palette) { const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2; if (d < bestD) { bestD = d; best = i; } }
  misses.set(key, best);
  return best;
}

export interface IdMap { width: number; height: number; ids: Uint8Array }

async function decode(url: string, body: Body): Promise<IdMap> {
  const blob = await (await fetch(url)).blob();
  let src: CanvasImageSource;
  try { src = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
  catch {
    const img = new Image(); img.src = URL.createObjectURL(blob);
    await img.decode(); URL.revokeObjectURL(img.src); src = img;
  }
  const [width, height] = MANIFESTS[body].idSize;
  const v = viewOf(body);
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, 0, 0, width, height);
  if ('close' in src) src.close();
  const px = g.getImageData(0, 0, width, height).data;
  const ids = new Uint8Array(width * height), misses = new Map<number, number>();
  for (let i = 0, j = 0; i < ids.length; i++, j += 4) ids[i] = px[j] === 0 && px[j + 1] === 0 && px[j + 2] === 0 ? 0 : indexOf(v, px[j], px[j + 1], px[j + 2], misses);
  return { width, height, ids };
}

const cache = new Map<string, Promise<IdMap>>();

/** Decoded ID map of one of a body's angles (decoded once, a few kept). */
export function loadIdMap(body: Body, angle: number): Promise<IdMap> {
  const url = bodymapUrl(MANIFESTS[body].angles[angle].id);
  let p = cache.get(url);
  if (!p) {
    p = decode(url, body);
    p.catch(() => cache.delete(url));
    cache.set(url, p);
    if (cache.size > 6) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Every image file of a body at one density (ID maps included). */
export function bodymapFiles(body: Body, d: Density): string[] {
  const m = MANIFESTS[body];
  return [...m.angles.flatMap(a => [a.image[d], a.id]), ...Object.values(m.closeups).map(c => c!.image[d])].map(bodymapUrl);
}

/** Every body's images at both densities: what the service worker may keep. */
export const allBodymapFiles = () => BODIES.flatMap(b => [...bodymapFiles(b, '1x'), ...bodymapFiles(b, '2x')]);

/** Start downloading an image without showing it. */
const warm = new Set<string>();
export function preload(url: string) {
  if (warm.has(url)) return;
  warm.add(url);
  const img = new Image(); img.decoding = 'async'; img.src = url;
}
