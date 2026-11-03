// Step 2 of the anatomy build: convert the fetched sources (GLB and FBX) into flat mesh files that the Python steps read.
//
//   node tools/anatomy/extract.mjs            # every source in sources.json
//   node tools/anatomy/extract.mjs hra-male   # one source
//
// For each source, writes tools/anatomy/.cache/raw/<id>/<n>.pos (float32 xyz, metres) and <n>.idx (uint32 triangles),
// plus index.json listing each mesh's name and its path in the source's node tree. World transforms are applied,
// FBX centimetres become metres, and duplicate vertices are welded (FBX meshes arrive as unindexed triangle soup).
// Axes are left as the sources have them: both use +x = the person's left, +y = up, +z = front.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(fs.readFileSync(path.join(here, 'sources.json'), 'utf8'));
const src = (name, file) => path.join(here, '.cache', 'src', name, path.dirname(file.path), file.member ?? path.basename(file.path));
const JOBS = {
  'hra-male': { kind: 'glb', file: src('hra', sources.hra.files.male), scale: 1 },
  'hra-female': { kind: 'glb', file: src('hra', sources.hra.files.female), scale: 1 },
  ...Object.fromEntries(Object.entries(sources.zanatomy.files).map(([k, f]) => [`za-${k}`, { kind: 'fbx', file: src('zanatomy', f), scale: 0.01 }])),
};

/** Merge vertices closer than 1e-6 m and drop triangles that collapse. */
function weld(P, I) {
  const map = new Map(), remap = new Uint32Array(P.length / 3), out = [];
  for (let i = 0; i < remap.length; i++) {
    const key = `${Math.round(P[i * 3] * 1e6)},${Math.round(P[i * 3 + 1] * 1e6)},${Math.round(P[i * 3 + 2] * 1e6)}`;
    let j = map.get(key);
    if (j === undefined) { j = out.length / 3; map.set(key, j); out.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); }
    remap[i] = j;
  }
  const tris = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = remap[I[t]], b = remap[I[t + 1]], c = remap[I[t + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return [new Float32Array(out), new Uint32Array(tris)];
}

async function readGlb(file) {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder } = await import('meshoptimizer');
  await MeshoptDecoder.ready;
  const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).read(file);
  const meshes = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    const M = node.getWorldMatrix();
    const names = []; for (let n = node; n; n = n.getParentNode()) names.unshift(n.getName());
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const pos = prim.getAttribute('POSITION'); if (!pos) continue;
      const n = pos.getCount(), P = new Float32Array(n * 3), e = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        pos.getElement(i, e);
        P[i * 3] = M[0] * e[0] + M[4] * e[1] + M[8] * e[2] + M[12];
        P[i * 3 + 1] = M[1] * e[0] + M[5] * e[1] + M[9] * e[2] + M[13];
        P[i * 3 + 2] = M[2] * e[0] + M[6] * e[1] + M[10] * e[2] + M[14];
      }
      const ind = prim.getIndices();
      meshes.push({ name: node.getName() || mesh.getName(), path: names.join('/'), P, I: ind ? Uint32Array.from(ind.getArray()) : Uint32Array.from({ length: n }, (_, i) => i) });
    }
  }
  return meshes;
}

async function readFbx(file) {
  // FBXLoader touches a few browser globals for textures; geometry does not need them.
  globalThis.self ??= globalThis; globalThis.window ??= globalThis;
  globalThis.document ??= { createElementNS: () => ({ style: {}, addEventListener() {}, removeEventListener() {} }) };
  const THREE = await import('three');
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const buf = fs.readFileSync(file);
  const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  root.updateMatrixWorld(true);
  const meshes = [], v = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute('position'); if (!pos) return;
    const P = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; }
    const names = []; for (let p = o; p; p = p.parent) names.unshift(p.name);
    meshes.push({ name: o.name, path: names.join('/'), P, I: o.geometry.index ? Uint32Array.from(o.geometry.index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i) });
  });
  return meshes;
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(JOBS);
for (const id of ids) {
  const job = JOBS[id]; if (!job) throw new Error(`unknown source ${id}`);
  const t0 = Date.now();
  const meshes = job.kind === 'glb' ? await readGlb(job.file) : await readFbx(job.file);
  const outDir = path.join(here, '.cache', 'raw', id);
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const index = [];
  meshes.forEach((m, k) => {
    if (job.scale !== 1) for (let i = 0; i < m.P.length; i++) m.P[i] *= job.scale;
    const [P, I] = weld(m.P, m.I);
    if (!I.length) return;
    fs.writeFileSync(path.join(outDir, `${k}.pos`), Buffer.from(P.buffer));
    fs.writeFileSync(path.join(outDir, `${k}.idx`), Buffer.from(I.buffer));
    index.push({ i: k, name: m.name, path: m.path, verts: P.length / 3, tris: I.length / 3 });
  });
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index));
  console.log(`${id}: ${index.length} meshes, ${index.reduce((s, o) => s + o.tris, 0)} triangles (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
