import { clear, preload, suspend } from 'suspend-react';
import { Vector3, type BufferGeometry, type Mesh } from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Body } from '../lib/body';

/** models/anatomy-<body>.glb, or a base64 text copy for hosts that cannot serve binary models (see
 *  tools/build-artifact.mjs). The query carries the model's content hash (vite.config.ts), so the service worker keeps
 *  it on the device and fetches it again only when it changes. */
export function modelUrl(body: Body) {
  const ext = import.meta.env.VITE_MODEL_FORMAT === 'b64' ? 'b64.txt' : 'glb';
  return `${import.meta.env.BASE_URL}models/anatomy-${body}.${ext}?v=${__MODEL_SHA__[body]}`;
}

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

/** Points zero-length normals outward from the mesh centre (they turn into NaN pixels in the lighting, which bloom
 *  spreads over the whole frame). Adds normals if a mesh has none. */
function repairNormals(g: BufferGeometry) {
  const p = g.getAttribute('position');
  if (!p) return;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const n = g.getAttribute('normal');
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

const key = (body: Body) => ['lotuspond-anatomy', modelUrl(body)];
export const useAnatomyModel = (body: Body) => suspend(() => load(modelUrl(body)), key(body));
export const preloadAnatomyModel = (body: Body) => preload(() => load(modelUrl(body)), key(body));
/** Forget a loaded (or failed) model, so the next render downloads it again. */
export const clearAnatomyModel = (body: Body) => clear(key(body));
