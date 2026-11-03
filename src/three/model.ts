import { preload, suspend } from 'suspend-react';
import { Vector3, type BufferGeometry, type Mesh } from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MANIFEST } from '../components/bodymap2d/manifest';

/** Binary .glb by default; hosts that cannot serve binary models get a base64 text copy (see tools/build-artifact.mjs).
 *  The query carries the model's content hash (recorded by tools/render-bodymap.mjs), so the service worker can keep
 *  it on the device and fetch it again only when it changes. */
export const MODEL_URL = `${import.meta.env.BASE_URL}${import.meta.env.VITE_MODEL_PATH ?? 'models/anatomy.glb'}?v=${MANIFEST.model.sha}`;

async function load(url: string): Promise<GLTF> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The anatomy model could not be downloaded (${res.status}).`);
  let buf: ArrayBuffer;
  if (new URL(url, location.href).pathname.endsWith('.txt')) {
    const s = atob((await res.text()).trim());
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    buf = bytes.buffer;
  } else buf = await res.arrayBuffer();
  await MeshoptDecoder.ready;
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf, '');
  gltf.scene.traverse(o => { if ((o as Mesh).isMesh) repairNormals((o as Mesh).geometry); });
  return gltf;
}

/** A few vertices of the generated brain have zero-length normals, which turn into NaN pixels in the lighting (and
 *  bloom spreads them over the whole frame). Point those outward from the mesh centre instead. */
function repairNormals(g: BufferGeometry) {
  const n = g.getAttribute('normal'), p = g.getAttribute('position');
  if (!n || !p) return;
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new Vector3()), v = new Vector3();
  let fixed = 0;
  for (let i = 0; i < n.count; i++) {
    if (Math.abs(n.getX(i)) + Math.abs(n.getY(i)) + Math.abs(n.getZ(i)) > 1e-3) continue;
    v.set(p.getX(i), p.getY(i), p.getZ(i)).sub(c);
    if (v.lengthSq() < 1e-12) v.set(0, 1, 0);
    v.normalize(); n.setXYZ(i, v.x, v.y, v.z); fixed++;
  }
  if (fixed) n.needsUpdate = true;
}

const KEY = ['lotuspond-anatomy'];
export const useAnatomyModel = () => suspend(() => load(MODEL_URL), KEY);
export const preloadAnatomyModel = () => preload(() => load(MODEL_URL), KEY);
