// Geometry of each body model, generated with it by tools/anatomy/build.mjs: which parts (glTF nodes) the model has and
// what they are, the body's size, and where organ pins and landmarks sit. Organ text lives in organs.ts.
import female from './bodies/female.json';
import male from './bodies/male.json';
import { ORGANS, TISSUE, type Tissue, type Vec3 } from './organs';
import type { Body } from '../lib/body';
import type { OrganId } from '../types';

export interface PartSpec {
  organ: OrganId;
  tissue: Tissue;
  /** 'shell': see-through in x-ray; 'hollow': inside drawn as cut tissue in cross-sections; 'noinner': see-through without an inner layer. */
  flags: string[];
  /** Thin sheets (valve leaflets, ligaments) drawn from both sides. */
  double?: boolean;
  bounds: [Vec3, Vec3];
  tris: number;
  sources: string[];
}

export interface BodyRig {
  sex: Body;
  /** Standing height in metres (soles at y = 0). */
  height: number;
  /** Skin bounds. */
  bounds: [Vec3, Vec3];
  parts: Record<string, PartSpec>;
  landmarks: Partial<Record<OrganId, { name: string; at: Vec3 }[]>>;
  pins: Partial<Record<OrganId, Vec3>>;
  triangles: number;
  license: string;
}

export const RIGS: Record<Body, BodyRig> = { female: female as unknown as BodyRig, male: male as unknown as BodyRig };

export interface MeshSpec { id: string; organ: OrganId; tissue: Tissue; hollow: boolean; shell: boolean; inner: boolean; double: boolean }

const specs = new Map<Body, Map<string, MeshSpec>>();

/** What each glTF node of a body is. Parts with an unknown organ or tissue are left out (and never drawn). */
export function meshSpecs(body: Body): Map<string, MeshSpec> {
  let m = specs.get(body);
  if (!m) {
    m = new Map();
    const organs = new Set<string>(ORGANS.map(o => o.id));
    for (const [id, p] of Object.entries(RIGS[body].parts)) {
      if (!organs.has(p.organ) || !(p.tissue in TISSUE)) continue;
      const seeThrough = !!TISSUE[p.tissue].opacity;
      m.set(id, {
        id, organ: p.organ, tissue: p.tissue, hollow: p.flags.includes('hollow'), shell: p.flags.includes('shell'),
        inner: p.flags.includes('hollow') || (seeThrough && !p.flags.includes('noinner')), double: !!p.double,
      });
    }
    specs.set(body, m);
  }
  return m;
}

/** Landmarks of an organ in this body, in the organ's display order, with their notes. */
export function landmarksOf(body: Body, organ: OrganId): { name: string; note: string; at: Vec3 }[] {
  const at = new Map((RIGS[body].landmarks[organ] ?? []).map(l => [l.name, l.at]));
  const o = ORGANS.find(x => x.id === organ);
  return (o?.landmarks ?? []).flatMap(l => (at.has(l.name) ? [{ ...l, at: at.get(l.name)! }] : []));
}

export const pinOf = (body: Body, organ: OrganId): Vec3 | null => RIGS[body].pins[organ] ?? null;

/** Organs this body has parts for. */
export function organsIn(body: Body): Set<OrganId> {
  return new Set(Object.values(RIGS[body].parts).map(p => p.organ));
}

/** Focus parts of an organ that exist in this body (falls back to all of the organ's parts). */
export function focusOf(body: Body, organ: OrganId): string[] {
  const parts = RIGS[body].parts;
  const o = ORGANS.find(x => x.id === organ);
  const f = (o?.focus ?? []).filter(id => parts[id]);
  return f.length ? f : Object.keys(parts).filter(id => parts[id].organ === organ);
}

/** Camera framing of the whole body: look-at target and a distance that fits it in a 30° vertical field of view. */
export function homeFraming(body: Body) {
  const h = RIGS[body].height;
  return { target: [0, h * 0.594, 0] as Vec3, distance: h * 1.72 };
}
