// Step 5 of the anatomy build: simplify the assembled parts and write the app's models.
//
//   node tools/anatomy/build.mjs [male|female|all]
//
// Reads tools/anatomy/.cache/parts/<sex>/ (assemble.py) and writes public/models/anatomy-<sex>.glb plus the body's rig,
// src/anatomy/bodies/<sex>.json (part metadata, bounds, organ pins and landmark positions). Each part is simplified
// structure by structure, so small structures (a valve, a papilla) keep their share of the part's triangle budget, and
// each structure's true (Hausdorff) error is bounded: the simplifier's quadric error lets thin double-layer shells (the
// eyelid conjunctivae) fold into a crumpled sheet, so the result is checked by sampled distances both ways (at most
// 0.5 % of the probes beyond the structure's tolerance, none beyond twice it) and the structure gets more triangles
// until it is within tolerance; each connected piece is simplified on its own so that small pieces cannot vanish. The
// measured errors of every structure go to .cache/parts/<sex>/simplify.json. One node per part, named by its id, with its organ, tissue
// and flags in the node's extras; no materials. Refuses to build when assemble.py found a part facing inward.
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

/** Connected pieces (triangles joined by shared vertices) of a triangle range, as index arrays. */
function pieces(I) {
  const par = new Map();
  const find = x => { let r = x; while (par.get(r) !== r) r = par.get(r); while (x !== r) { const nx = par.get(x); par.set(x, r); x = nx; } return r; };
  for (const x of I) if (!par.has(x)) par.set(x, x);
  for (let t = 0; t < I.length; t += 3) { const a = find(I[t]); par.set(find(I[t + 1]), a); par.set(find(I[t + 2]), a); }
  const groups = new Map();
  for (let t = 0; t < I.length; t += 3) { const r = find(I[t]); let l = groups.get(r); if (!l) groups.set(r, (l = [])); l.push(I[t], I[t + 1], I[t + 2]); }
  return [...groups.values()].map(l => Uint32Array.from(l));
}

const concat = arrs => { const all = new Uint32Array(arrs.reduce((a, c) => a + c.length, 0)); let o = 0; for (const c of arrs) { all.set(c, o); o += c.length; } return all; };

/** Simplify one structure (a triangle range) towards `target` triangles, never past `tol` of quadric error. Each
 * connected piece is simplified on its own with its share of the target and at least 8 triangles, so a small piece
 * (a cartilage ring, a fragment of a parcel) is reduced instead of collapsing to nothing. */
function simplifyRange(P, I, target, tol) {
  const n = I.length / 3;
  if (target >= n) return I;
  const out = [];
  for (const c of pieces(I)) {
    const nc = c.length / 3, tc = Math.min(nc, Math.max(8, Math.round((target * nc) / n)));
    out.push(tc >= nc ? c : MeshoptSimplifier.simplify(c, P, 3, Math.max(3, tc * 3), tol, ['LockBorder', 'ErrorAbsolute', 'Sparse'])[0]);
  }
  return concat(out);
}

/** Uniform grid over triangles (flat index array I into positions P) for "is any triangle within r" queries. */
function triGrid(P, I, cell) {
  const map = new Map();
  const key = (i, j, k) => (i * 32768 + j) * 32768 + k;
  const c = x => Math.floor(x / cell) + 16384;
  for (let t = 0; t < I.length; t += 3) {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) { const x = P[I[t + v] * 3 + a]; if (x < lo[a]) lo[a] = x; if (x > hi[a]) hi[a] = x; }
    for (let i = c(lo[0]); i <= c(hi[0]); i++) for (let j = c(lo[1]); j <= c(hi[1]); j++) for (let k = c(lo[2]); k <= c(hi[2]); k++) {
      const kk = key(i, j, k); let l = map.get(kk); if (!l) map.set(kk, (l = [])); l.push(t);
    }
  }
  return { map, cell, key, c, P, I };
}

/** Squared distance from point p to triangle (a, b, c) (Ericson). */
function d2tri(p, a, b, c) {
  const sub = (x, y) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]], dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap); let q;
  if (d1 <= 0 && d2 <= 0) q = a;
  else {
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) q = b;
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); q = [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]; }
      else {
        const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) q = c;
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); q = [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); q = [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]; }
            else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]; }
          }
        }
      }
    }
  }
  const d = sub(p, q); return dot(d, d);
}

/** Whether some triangle of the grid lies within r (r <= cell) of p. */
function near(g, p, r) {
  const r2 = r * r, { P, I } = g; const pt = k => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
  const ci = g.c(p[0]), cj = g.c(p[1]), ck = g.c(p[2]);
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (let k = ck - 1; k <= ck + 1; k++) {
    const l = g.map.get(g.key(i, j, k)); if (!l) continue;
    for (const t of l) if (d2tri(p, pt(I[t]), pt(I[t + 1]), pt(I[t + 2])) <= r2) return true;
  }
  return false;
}

/** Points to check a surface by: its vertices (strided to at most m) and its triangle centroids (strided). */
function probes(P, I, m) {
  const out = []; const nt = I.length / 3; const st = Math.max(1, Math.floor(nt / m));
  for (let t = 0; t < nt; t += st) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    out.push([P[a], P[a + 1], P[a + 2]]);
    out.push([(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3]);
  }
  return out;
}

const meanEdge = (P, I) => {
  let s = 0, n = 0; const st = Math.max(3, Math.floor(I.length / 3 / 500) * 3);
  for (let t = 0; t + 2 < I.length; t += st) { const a = I[t] * 3, b = I[t + 1] * 3; s += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]); n++; }
  return n ? s / n : 0;
};

/** Error tolerance of a structure: 4 % of its size, between 0.25 and 1 mm. */
function tolerance(P, I) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < I.length; i++) for (let a = 0; a < 3; a++) { const x = P[I[i] * 3 + a]; if (x < lo[a]) lo[a] = x; if (x > hi[a]) hi[a] = x; }
  return Math.min(0.001, Math.max(0.00025, 0.04 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])));
}

/** Fractions of the probes of surface A farther than tol and farther than 2 tol from surface B (sampled one-sided
 * Hausdorff test). */
function outside(P, A, B, tol, m = 3000) {
  const g = triGrid(P, B, Math.max(2 * tol, meanEdge(P, B)));
  const pr = probes(P, A, m); let far = 0, far2 = 0;
  for (const p of pr) if (!near(g, p, tol)) { far++; if (!near(g, p, 2 * tol)) far2++; }
  return pr.length ? [far / pr.length, far2 / pr.length] : [0, 0];
}

// a simplified structure is within tolerance when, both ways, at most FAR of its probes lie beyond its tolerance and
// none beyond twice it (the true error is bounded; a single probe a hair past the tolerance does not cost full detail)
const FAR = 0.005;
const within = e => Math.max(e[0], e[2]) <= FAR && e[1] === 0 && e[3] === 0;

/** Simplify towards target, doubling the target until both directions are within tolerance. err = [orig->new beyond
 * tol, beyond 2 tol, new->orig beyond tol, beyond 2 tol] (fractions of probes) of the result. */
function simplifyBounded(P, I, target) {
  const n = I.length / 3, tol = tolerance(P, I);
  for (let t = target, tries = 0; ; tries++, t = Math.min(n, t * 2)) {
    const out = t >= n ? I : simplifyRange(P, I, t, tol);
    if (out.length >= I.length) return { out: I, tol, raised: tries, target, err: [0, 0, 0, 0] };
    const err = [...outside(P, I, out, tol), ...outside(P, out, I, tol)];
    if (within(err) || tries === 7) return { out, tol, raised: tries, target, err };
  }
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
  if (rig.inward_failing && Object.keys(rig.inward_failing).length)
    throw new Error(`${sex}: parts with more than ${rig.inward_max * 100} % of their area facing inward: ${JSON.stringify(rig.inward_failing)} (assemble.py)`);
  const names = JSON.parse(fs.readFileSync(path.join(dir, 'structures.json'), 'utf8'));
  const raised = [], errors = [], failing = [];
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
      const r = simplifyBounded(P, I.subarray(seg[s] * 3, seg[s + 1] * 3), target);
      const name = `${pid}/${names[pid]?.[s]?.name ?? s}`;
      if (r.raised) raised.push(`${name} ${n}->${target}->${r.out.length / 3} (tol ${(r.tol * 1000).toFixed(2)} mm)`);
      errors.push({ name, tris: n, target, out: r.out.length / 3, tol_mm: +(r.tol * 1000).toFixed(2), err: r.err.map(x => +x.toFixed(4)) });
      if (!within(r.err)) failing.push(name);
      chunks.push(r.out);
    });
    const all = concat(chunks);
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
  asset.copyright = `${sources.outputLicense.text} ${sources.outputLicense.url} ${sources.outputLicense.details}`;
  asset.extras = {
    license: sources.outputLicense.spdx, licenseUrl: sources.outputLicense.url, sex,
    credits: [sources.hra.files[sex].credit, sources.hra.brain[sex], sources.hra.brain.basedOn, sources.hra.library, sources.hra.basedOn, sources.zanatomy.credit],
    changes: sources.outputLicense.changes, details: sources.outputLicense.details,
  };
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const glb = path.join(root, 'public', 'models', `anatomy-${sex}.glb`);
  await io.write(glb, doc);
  const bodies = path.join(root, 'src', 'anatomy', 'bodies');
  fs.mkdirSync(bodies, { recursive: true });
  fs.writeFileSync(path.join(bodies, `${sex}.json`), JSON.stringify({ ...out, triangles: total, license: sources.outputLicense.spdx }, null, 1) + '\n');
  // every structure's sampled error both ways: [orig->GLB beyond tol, beyond 2 tol, GLB->orig beyond tol, beyond 2 tol]
  fs.writeFileSync(path.join(dir, 'simplify.json'), JSON.stringify({ rule: `at most ${FAR * 100} % of probes beyond tol, none beyond 2 tol, both ways`, raised, failing, structures: errors }, null, 0));
  const worst = errors.filter(e => e.out < e.tris).sort((a, b) => Math.max(b.err[0], b.err[2]) - Math.max(a.err[0], a.err[2]))[0];
  console.log(`${sex}: ${Object.keys(out.parts).length} parts, ${total} triangles, ${(fs.statSync(glb).size / 1e6).toFixed(2)} MB, ${raised.length} structures given more triangles to stay within tolerance, `
    + `${failing.length} outside it${failing.length ? ' ' + JSON.stringify(failing) : ''}; worst ${worst?.name} ${JSON.stringify(worst?.err)} at ${worst?.tol_mm} mm (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

const which = process.argv[2] ?? 'all';
for (const sex of which === 'all' ? ['male', 'female'] : [which]) await build(sex);
