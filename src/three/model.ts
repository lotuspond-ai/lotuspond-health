import { preload, suspend } from 'suspend-react';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/** Binary .glb by default; hosts that cannot serve binary models get a base64 text copy (see tools/build-artifact.mjs). */
export const MODEL_URL = `${import.meta.env.BASE_URL}${import.meta.env.VITE_MODEL_PATH ?? 'models/anatomy.glb'}`;

async function load(url: string): Promise<GLTF> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The anatomy model could not be downloaded (${res.status}).`);
  let buf: ArrayBuffer;
  if (url.endsWith('.txt')) {
    const s = atob((await res.text()).trim());
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    buf = bytes.buffer;
  } else buf = await res.arrayBuffer();
  await MeshoptDecoder.ready;
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf, '');
}

const KEY = ['lotuspond-anatomy'];
export const useAnatomyModel = () => suspend(() => load(MODEL_URL), KEY);
export const preloadAnatomyModel = () => preload(() => load(MODEL_URL), KEY);
