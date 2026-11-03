// Step 5 of the anatomy build: simplify the assembled parts and write the app's models.
//
//   node tools/anatomy/build.mjs [male|female|all]
//
// Reads tools/anatomy/.cache/parts/<sex>/ (assemble.py) and writes public/models/anatomy-<sex>.glb plus the body's rig,
// src/anatomy/bodies/<sex>.json (part metadata, bounds, organ pins and landmark positions). Each part is simplified
// structure by structure, so small structures (a valve, a papilla) keep their share of the part's triangle budget.
// One node per part, named by its id, with its organ, tissue and flags in the node's extras; no materials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const sources = JSON.parse(fs.readFileSync(path.join(here, 'sources.json'), 'utf8'));
await MeshoptSimplifier.ready; await MeshoptEncoder.ready;

const read = (file, T) => { const b = fs.readFileSync(file); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

/** Simplify one structure (a triangle range) towards `target` triangles, never past 1.5 mm of error. */
function simplifyRange(P, I, target) {
  const n = I.length / 3;
  if (target >= n) return I;
  const [out] = MeshoptSimplifier.simplify(I, P, 3, Math.max(3, target * 3), 0.0015, ['LockBorder', 'ErrorAbsolute']);
  return out;
}

/** Drop unused vertices; returns [positions, indices]. */
function compact(P, I) {
  const remap = new Int32Array(P.length / 3).fill(-1); const pos = []; const idx = new Uint32Array(I.length);
  for (let i = 0; i < I.length; i++) {
    let j = remap[I[i]];
    if (j < 0) { j = remap[I[i]] = pos.length / 3; pos.push(P[I[i] * 3], P[I[i] * 3 + 1], P[I[i] * 3 + 2]); }
    idx[i] = j;
  }
  return [new Float32Array(pos), idx];
}

/** Angle-weighted vertex normals. */
function normals(P, I) {
  const N = new Float32Array(P.length);
  const v = k => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = a => Math.hypot(a[0], a[1], a[2]) || 1e-20;
  for (let t = 0; t < I.length; t += 3) {
    const ids = [I[t], I[t + 1], I[t + 2]]; const p = ids.map(v);
    const e1 = sub(p[1], p[0]), e2 = sub(p[2], p[0]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const ln = len(n); if (ln < 1e-24) continue;
    for (let c = 0; c < 3; c++) {
      const a = sub(p[(c + 1) % 3], p[c]), b = sub(p[(c + 2) % 3], p[c]);
      const ang = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (len(a) * len(b)))));
      for (let k = 0; k < 3; k++) N[ids[c] * 3 + k] += (n[k] / ln) * ang;
    }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]);
    if (l > 1e-12) { N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; } else { N[i] = 0; N[i + 1] = 1; N[i + 2] = 0; }
  }
  return N;
}

async function build(sex) {
  const t0 = Date.now();
  const dir = path.join(here, '.cache', 'parts', sex);
  const rig = JSON.parse(fs.readFileSync(path.join(dir, 'rig.json'), 'utf8'));
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('anatomy');
  const out = { ...rig, parts: {} };
  let total = 0;
  for (const [pid, part] of Object.entries(rig.parts)) {
    const P = read(path.join(dir, `${pid}.pos`), Float32Array);
    const I = read(path.join(dir, `${pid}.idx`), Uint32Array);
    const seg = read(path.join(dir, `${pid}.seg`), Uint32Array);
    // share the budget across structures: larger ones are reduced more, small ones keep enough to read
    const sizes = []; for (let s = 0; s + 1 < seg.length; s++) sizes.push(seg[s + 1] - seg[s]);
    const w = sizes.map(n => Math.pow(n, 0.7)); const W = w.reduce((a, b) => a + b, 0) || 1;
    const chunks = [];
    sizes.forEach((n, s) => {
      if (!n) return;
      const target = Math.min(n, Math.max(Math.min(n, 60), Math.round((part.budget * w[s]) / W)));
      chunks.push(simplifyRange(P, I.subarray(seg[s] * 3, seg[s + 1] * 3), target));
    });
    const all = new Uint32Array(chunks.reduce((a, c) => a + c.length, 0));
    let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const [pos, idx] = compact(P, all);
    const nor = normals(pos, idx);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nor).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(pos.length / 3 < 65536 ? Uint16Array.from(idx) : idx).setBuffer(buffer));
    const node = doc.createNode(pid).setMesh(doc.createMesh(pid).addPrimitive(prim))
      .setExtras({ organ: part.organ, tissue: part.tissue, flags: part.flags, double: part.double });
    scene.addChild(node);
    const tris = idx.length / 3; total += tris;
    out.parts[pid] = { organ: part.organ, tissue: part.tissue, flags: part.flags, double: part.double, bounds: part.bounds, tris, sources: part.sources };
  }
  const asset = doc.getRoot().getAsset();
  asset.generator = 'LotusPond anatomy build (tools/anatomy)';
  asset.copyright = `${sources.outputLicense.text} ${sources.outputLicense.url}`;
  asset.extras = { license: sources.outputLicense.spdx, sex, credits: [sources.hra.files[sex].credit, sources.hra.basedOn, sources.zanatomy.credit] };
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const glb = path.join(root, 'public', 'models', `anatomy-${sex}.glb`);
  await io.write(glb, doc);
  const bodies = path.join(root, 'src', 'anatomy', 'bodies');
  fs.mkdirSync(bodies, { recursive: true });
  fs.writeFileSync(path.join(bodies, `${sex}.json`), JSON.stringify({ ...out, triangles: total, license: sources.outputLicense.spdx }, null, 1) + '\n');
  console.log(`${sex}: ${Object.keys(out.parts).length} parts, ${total} triangles, ${(fs.statSync(glb).size / 1e6).toFixed(2)} MB (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

const which = process.argv[2] ?? 'all';
for (const sex of which === 'all' ? ['male', 'female'] : [which]) await build(sex);
