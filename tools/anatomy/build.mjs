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
// until it is within tolerance; each connected piece is simplified on its own so that small pieces cannot vanish. Where
// the simplifier folds faces over (an output face whose normal opposes the source's vertex normals at all three of its
// corners: every output vertex is a source vertex), the source vertices under the folded faces are locked and the
// structure is simplified again, so it keeps the source's triangles there (the brain's white matter, the thin bronchial
// cartilages); vertices whose position another structure of the part also uses (two structures sharing a rim) are
// locked like borders. The
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
function simplifyRange(P, I, target, tol, lock) {
  const n = I.length / 3;
  if (target >= n) return I;
  const out = [], flags = ['LockBorder', 'ErrorAbsolute', 'Sparse'];
  for (const c of pieces(I)) {
    const nc = c.length / 3, tc = Math.min(nc, Math.max(8, Math.round((target * nc) / n)));
    let locked = false; if (lock) for (const x of c) if (lock[x]) { locked = true; break; }
    out.push(tc >= nc ? c : locked
      ? MeshoptSimplifier.simplifyWithAttributes(c, P, 3, zeros(P.length / 3), 1, [0], lock, Math.max(3, tc * 3), tol, flags)[0]
      : MeshoptSimplifier.simplify(c, P, 3, Math.max(3, tc * 3), tol, flags)[0]);
  }
  return concat(out);
}

/** Vertices whose position (exact) is also used by a vertex of another structure of the part (seg: structure ranges):
 * two structures sharing a rim or a wall. Locked like borders, so that the shared vertices stay in both. Returns a
 * vertex lock array (with a zero attribute array for simplifyWithAttributes) and the count, or null when none. */
function sharedLock(P, I, seg) {
  const nv = P.length / 3, sv = new Int32Array(nv).fill(-1), U = new Uint32Array(P.buffer, P.byteOffset, P.length);
  for (let s = 0; s + 1 < seg.length; s++) for (let i = seg[s] * 3; i < seg[s + 1] * 3; i++) sv[I[i]] = s;
  const key = v => `${U[v * 3]},${U[v * 3 + 1]},${U[v * 3 + 2]}`, owner = new Map();
  for (let v = 0; v < nv; v++) {
    if (sv[v] < 0) continue;
    const k = key(v), o = owner.get(k);
    if (o === undefined) owner.set(k, sv[v]); else if (o !== sv[v]) owner.set(k, -2);
  }
  const lock = new Uint8Array(nv); let count = 0;
  for (let v = 0; v < nv; v++) if (sv[v] >= 0 && owner.get(key(v)) === -2) { lock[v] = 1; count++; }
  if (!count) return null;
  lock.count = count;
  return lock;
}

let ZERO = new Float32Array(0);
const zeros = nv => (ZERO.length === nv ? ZERO : (ZERO = new Float32Array(nv)));  // the (weightless) attribute of simplifyWithAttributes

/** The lock array `lock` (or none) plus the source vertices of the structure I lying under the folded output faces
 * `bad` (offsets into `out`): those within 1.25 times the face's circumradius-like reach of its centroid. */
function lockUnder(P, I, out, bad, lock) {
  const nv = P.length / 3, lk = new Uint8Array(nv); if (lock) lk.set(lock);
  const vs = [...new Set(I)];
  for (const t of bad) {
    const a = out[t] * 3, b = out[t + 1] * 3, c = out[t + 2] * 3;
    const g = [0, 1, 2].map(k => (P[a + k] + P[b + k] + P[c + k]) / 3);
    let r2 = 0; for (const v of [a, b, c]) r2 = Math.max(r2, (P[v] - g[0]) ** 2 + (P[v + 1] - g[1]) ** 2 + (P[v + 2] - g[2]) ** 2);
    r2 *= 1.5625;
    for (const v of vs) { const dx = P[v * 3] - g[0]; if (dx * dx > r2) continue; if (dx * dx + (P[v * 3 + 1] - g[1]) ** 2 + (P[v * 3 + 2] - g[2]) ** 2 <= r2) lk[v] = 1; }
  }
  return lk;
}

/** Unit area-weighted vertex normals of the source (zero where undefined: a vertex between opposite faces). */
function sourceNormals(P, I) {
  const N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    for (const v of [a, b, c]) { N[v] += nx; N[v + 1] += ny; N[v + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]);
    if (l > 1e-14) { N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; } else N[i] = N[i + 1] = N[i + 2] = 0;
  }
  return N;
}

/** [folded area, total area] of a triangle list: a face is folded over when its normal opposes the source vertex
 * normals N at all three corners (the simplifier keeps a subset of the source vertices, so N is defined at every corner). */
function folds(P, N, I, bad = null) {
  let fa = 0, ta = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, ar = Math.hypot(nx, ny, nz) / 2;
    ta += ar;
    if (N[a] * nx + N[a + 1] * ny + N[a + 2] * nz < 0 && N[b] * nx + N[b + 1] * ny + N[b + 2] * nz < 0 && N[c] * nx + N[c + 1] * ny + N[c + 2] * nz < 0) { fa += ar; if (bad) bad.push(t); }
  }
  return [fa, ta];
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

/** Error tolerance of a structure: 4 % of its size, between 0.25 mm and `cap` (1 mm; SHEET_TOL for translucent sheets). */
function tolerance(P, I, cap = 0.001) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < I.length; i++) for (let a = 0; a < 3; a++) { const x = P[I[i] * 3 + a]; if (x < lo[a]) lo[a] = x; if (x > hi[a]) hi[a] = x; }
  return Math.min(cap, Math.max(0.00025, 0.04 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])));
}
// translucent sheets (parts flagged 'noinner': the diaphragm, drawn at 22 % opacity over the lungs and liver) take a
// looser tolerance and are capped at their budget: at 1 mm the diaphragm needed 4x its budget (40,000 triangles) and the
// female's still 40,000 at 2.5 mm (her diaphragm's long bridging faces fold when collapsed), 20,000 at 4 mm; a sheet is
// simplified to its budget at SHEET_TOL (folds mended by locking the vertices under them when that is cheap) and its
// remaining errors are reported (simplify.json sheets_capped), never raised by doubling
const SHEET_TOL = 0.0025;
const tolCap = part => ((part.flags || []).includes('noinner') ? SHEET_TOL : 0.001);

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
// and when the area it folds over (beyond the source's own) is at most FOLD of its area, or a sliver under FOLD_MM2
const FOLD = 1e-3, FOLD_MM2 = 1.0;
const within = e => Math.max(e[0], e[2]) <= FAR && e[1] === 0 && e[3] === 0 && (e[4] ?? 0) <= Math.max(FOLD, FOLD_MM2 / Math.max(e[5] ?? 1, 1e-9));

/** Simplify towards target until both directions are within tolerance and no more than FOLD of the area is folded
 * over: folds are mended by locking the source vertices under them (up to 3 rounds, when the ~2 triangles per locked
 * vertex cost less than doubling the target), else by one doubling of the target; distance errors by doubling it. err = [orig->new beyond tol, beyond 2 tol, new->orig beyond tol, beyond 2 tol] (fractions of probes), folded
 * area beyond the source's own (fraction), area (mm2) of the result. */
function simplifyBounded(P, I, target, N, lock, cap = 0.001, hard = false) {
  const n = I.length / 3, tol = tolerance(P, I, cap);
  const [f0, a0] = folds(P, N, I), own = f0 / Math.max(a0, 1e-30);
  let lk = lock, mended = 0, foldDoubled = 0;
  for (let t = target, tries = 0; ;) {
    const out = t >= n ? I : simplifyRange(P, I, t, tol, lk);
    if (out.length >= I.length) return { out: I, tol, raised: tries, mended, target, err: [0, 0, 0, 0, 0, a0 * 1e6], own };
    const bad = [], [fa, ta] = folds(P, N, out, bad);
    const err = [...outside(P, I, out, tol), ...outside(P, out, I, tol), Math.max(0, fa / Math.max(ta, 1e-30) - own), ta * 1e6];
    if (within(err) || tries === 7) return { out, tol, raised: tries, mended, target, err, own };
    if (within(err.slice(0, 4)) && mended < 3) {  // only folds: mend them when that costs less than doubling the target
      const lk2 = lockUnder(P, I, out, bad, lk); let added = 0;
      for (let v = 0; v < lk2.length; v++) if (lk2[v] && !(lk && lk[v])) added++;
      if (2 * added < t) { lk = lk2; mended++; continue; }
    }
    if (hard) return { out, tol, raised: tries, mended, target, err, own, capped: true };  // a sheet: folds mended, never doubled
    if (within(err.slice(0, 4))) {  // folds left: at most one doubling for them (the budget), then the result stands
      if (foldDoubled) return { out, tol, raised: tries, mended, target, err, own };
      foldDoubled++;
    }
    tries++; t = Math.min(n, t * 2);
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
  const raised = [], errors = [], failing = [], foldLimited = [], lockedVerts = {}, sheetsCapped = [];
  let foldedMm2 = 0;
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
    const chunks = [], N = sourceNormals(P, I), lock = sharedLock(P, I, seg);
    if (lock) lockedVerts[pid] = lock.count;
    sizes.forEach((n, s) => {
      if (!n) return;
      const target = Math.min(n, Math.max(Math.min(n, 60), Math.round((part.budget * w[s]) / W)));
      const sheet = (part.flags || []).includes('noinner');
      const r = simplifyBounded(P, I.subarray(seg[s] * 3, seg[s + 1] * 3), target, N, lock, tolCap(part), sheet);
      const name = `${pid}/${names[pid]?.[s]?.name ?? s}`;
      if (r.raised || r.mended) raised.push(`${name} ${n}->${target}->${r.out.length / 3} (tol ${(r.tol * 1000).toFixed(2)} mm${r.mended ? `, ${r.mended} fold mends` : ''})`);
      errors.push({ name, tris: n, target, out: r.out.length / 3, tol_mm: +(r.tol * 1000).toFixed(2), err: r.err.map(x => +x.toFixed(5)), src_folded: +r.own.toFixed(5) });
      foldedMm2 += r.err[4] * r.err[5];
      if (sheet) sheetsCapped.push({ name, tris: r.out.length / 3, budget_target: target, tol_mm: +(r.tol * 1000).toFixed(2), within: within(r.err), err: r.err.map(x => +x.toFixed(5)) });
      else if (!within(r.err.slice(0, 4))) failing.push(name); else if (!within(r.err)) foldLimited.push(name);
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
  fs.writeFileSync(path.join(dir, "simplify.json"), JSON.stringify({ rule: `at most ${FAR * 100} % of probes beyond tol, none beyond 2 tol, both ways (tol 4 % of size, 0.25-1 mm; translucent sheets up to ${SHEET_TOL * 1000} mm); folded area beyond the source's own at most ${FOLD * 100} % (or ${FOLD_MM2} mm2)`,
    raised, failing, fold_limited: foldLimited, sheets_capped: sheetsCapped, folded_mm2: +foldedMm2.toFixed(2), locked_shared_vertices: lockedVerts, structures: errors }, null, 0));
  const worst = errors.filter(e => e.out < e.tris).sort((a, b) => Math.max(b.err[0], b.err[2]) - Math.max(a.err[0], a.err[2]))[0];
  console.log(`${sex}: ${Object.keys(out.parts).length} parts, ${total} triangles, ${(fs.statSync(glb).size / 1e6).toFixed(2)} MB, ${raised.length} structures given more triangles to stay within tolerance, `
    + `${failing.length} outside it${failing.length ? ' ' + JSON.stringify(failing) : ''}; worst ${worst?.name} ${JSON.stringify(worst?.err)} at ${worst?.tol_mm} mm; `
    + `folded ${foldedMm2.toFixed(1)} mm2 (${foldLimited.length} structures left with folds after one doubling ${JSON.stringify(foldLimited)}); shared vertices locked ${JSON.stringify(lockedVerts)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

const which = process.argv[2] ?? 'all';
for (const sex of which === 'all' ? ['male', 'female'] : [which]) await build(sex);
