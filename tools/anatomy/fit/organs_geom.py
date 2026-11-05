"""Organs fit, part 2: geometry tools.

  Field              signed distance to an HRA neighbour (negative inside): inside/outside from a voxel solid that is
                     robust to open and overlapping surface patches (ray parity along x, y and z, majority vote), the
                     distance near the surface from the exact closest point on the mesh
  smooth_solve       smooth displacement field over a mesh (bi-Laplacian energy) meeting soft per-vertex targets, with
                     optional fixed vertices: the shape-preserving deformation behind every push-out and snap below
  push_out           collision push-out: vertices closer than a clearance to (or inside) neighbours get targets on the
                     neighbour surface + clearance; the rest of the surface follows smoothly
  boundary_loops     ordered boundary loops of an open mesh
  Tube               centreline, rotation-minimising frames and per-vertex tube coordinates of a tubular mesh, so the
                     tube can be re-routed along a new centreline with its cross-sections unchanged
"""
import os
import numpy as np
from scipy import sparse, ndimage
from scipy.sparse.linalg import splu
from scipy.spatial import cKDTree


# ------------------------------------------------------------------------------------------------ signed distance
def _parity_fill(v, f, lo, h, n, axis):
    """Inside occupancy by ray parity along `axis` through every grid line (vectorised)."""
    b, c = [a for a in range(3) if a != axis]
    tri = v[f]
    P = tri[:, :, [b, c]]
    lo2 = lo[[b, c]]
    mn = np.ceil((P.min(1) - lo2) / h).astype(np.int64)
    mx = np.floor((P.max(1) - lo2) / h).astype(np.int64)
    mn = np.maximum(mn, 0); mx = np.minimum(mx, np.array([n[b], n[c]]) - 1)
    nb = np.maximum(mx[:, 0] - mn[:, 0] + 1, 0); nc = np.maximum(mx[:, 1] - mn[:, 1] + 1, 0)
    cnt = nb * nc
    keep = cnt > 0
    tid = np.repeat(np.flatnonzero(keep), cnt[keep])
    if not len(tid): return np.zeros(n, bool)
    start = np.repeat(np.cumsum(cnt[keep]) - cnt[keep], cnt[keep])
    local = np.arange(len(tid)) - start
    ib = mn[tid, 0] + local // nc[tid]; ic = mn[tid, 1] + local % nc[tid]
    X = lo2[0] + h * ib; Y = lo2[1] + h * ic
    A, B, C = P[tid, 0], P[tid, 1], P[tid, 2]
    d = (B[:, 1] - C[:, 1]) * (A[:, 0] - C[:, 0]) + (C[:, 0] - B[:, 0]) * (A[:, 1] - C[:, 1])
    ok = np.abs(d) > 1e-20
    d = np.where(ok, d, 1.0)
    l1 = ((B[:, 1] - C[:, 1]) * (X - C[:, 0]) + (C[:, 0] - B[:, 0]) * (Y - C[:, 1])) / d
    l2 = ((C[:, 1] - A[:, 1]) * (X - C[:, 0]) + (A[:, 0] - C[:, 0]) * (Y - C[:, 1])) / d
    l3 = 1 - l1 - l2
    m = ok & (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
    za = l1 * tri[tid, 0, axis] + l2 * tri[tid, 1, axis] + l3 * tri[tid, 2, axis]
    k = np.ceil((za[m] - lo[axis]) / h).astype(np.int64)
    ib, ic = ib[m], ic[m]
    inr = (k >= 0) & (k < n[axis])
    tog = np.zeros(n, np.int8)
    idx = [None, None, None]; idx[axis] = k[inr]; idx[b] = ib[inr]; idx[c] = ic[inr]
    flat = np.ravel_multi_index(tuple(idx), n)
    cntv = np.bincount(flat, minlength=int(np.prod(n))).reshape(n)
    occ = (np.cumsum(cntv % 2, axis=axis, dtype=np.int32) % 2).astype(bool)
    return occ


def cap_loops(v, f, max_len=400):
    """Close every boundary loop of an open surface with a fan around its centroid (open-ended vessels and gut)."""
    loops = boundary_loops(f)
    V, F = [v], [f]; n = len(v)
    for lp in loops:
        if len(lp) < 3 or len(lp) > max_len: continue
        c = v[lp].mean(0); V.append(c[None]); ci = n; n += 1
        a = np.array(lp); b = np.roll(a, -1)
        F.append(np.column_stack([a, b, np.full(len(a), ci)]))
    return np.concatenate(V), np.concatenate(F)


def voxel_solid(v, f, lo, h, n, close=2, parity=False, slice_axis=None):
    """Inside occupancy of a surface that may be made of several overlapping or double-walled patches: the rasterised
    surface, gaps of up to `close` voxels closed, enclosed space filled (flood fill from outside). parity=True also unites
    ray-parity occupancy along x, y and z (majority vote)."""
    from lib.mesh import dense_points
    p = dense_points(v, f, spacing=h * 0.5)
    ijk = np.round((p - lo) / h).astype(int)
    okk = np.all((ijk >= 0) & (ijk < n), axis=1); ijk = ijk[okk]
    sh = np.zeros(n, bool); sh[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    st = ndimage.generate_binary_structure(3, 1)
    shut = ndimage.binary_dilation(sh, st, iterations=close) if close else sh
    occ = ndimage.binary_fill_holes(shut)
    if close: occ = ndimage.binary_erosion(occ, st, iterations=close, border_value=0) | (occ & sh)
    if parity:
        occ |= (_parity_fill(v, f, lo, h, n, 0).astype(np.int8) + _parity_fill(v, f, lo, h, n, 1) + _parity_fill(v, f, lo, h, n, 2)) >= 2
    if slice_axis is not None:
        occ |= slice_hull_fill(sh, slice_axis)
    return occ


def slice_hull_fill(sh, axis, grow=2):
    """Fill the convex hull of each connected cross-section of a rasterised vessel wall, slice by slice across `axis`
    (vessel walls with side openings, where a flood fill leaks)."""
    from scipy.spatial import Delaunay
    out = np.zeros_like(sh)
    st2 = ndimage.generate_binary_structure(2, 2)
    for k in range(sh.shape[axis]):
        sl = np.take(sh, k, axis=axis)
        if sl.sum() < 6: continue
        lab, nl = ndimage.label(ndimage.binary_dilation(sl, st2, iterations=grow), st2)
        fill = np.zeros_like(sl)
        for j, obj in enumerate(ndimage.find_objects(lab)):
            pts = np.argwhere((lab[obj] == j + 1) & sl[obj])
            if len(pts) < 6 or np.linalg.matrix_rank(pts - pts.mean(0)) < 2: continue
            try: tri = Delaunay(pts)
            except Exception: continue
            g = np.argwhere(np.ones(lab[obj].shape, bool))
            inside = tri.find_simplex(g) >= 0
            sub = np.zeros(lab[obj].shape, bool); sub[tuple(g[inside].T)] = True
            fill[obj] |= sub
        idx = [slice(None)] * 3; idx[axis] = k
        out[tuple(idx)] = fill
    return out


def _trilinear(field, lo, h, p):
    q = ((np.asarray(p, float) - lo) / h).T
    return ndimage.map_coordinates(field, q, order=1, mode='nearest')


class Field:
    """Signed distance to a closed-ish surface (metres, negative inside)."""

    def __init__(self, v, f, lo, h, sdf, oriented=False):
        self.v, self.f = np.asarray(v, float), np.asarray(f, np.int64)
        self.lo, self.h, self.sdf = np.asarray(lo, float), float(h), sdf.astype(np.float32)
        self.hi = self.lo + h * (np.array(sdf.shape) - 1)
        A, B, C = self.v[self.f[:, 0]], self.v[self.f[:, 1]], self.v[self.f[:, 2]]
        n = np.cross(B - A, C - A); fn = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-20)
        cen = (A + B + C) / 3
        self.oriented = oriented
        if oriented:
            # one of our own closed, consistently wound meshes: its own face normals are exact, whereas normals taken
            # from the voxel field's gradient are unreliable across sheets and walls only a few voxels thick
            self.fsel = np.arange(len(self.f)); self.tree = cKDTree(cen); self.fn = fn
            return
        # only faces on the solid's outer boundary take part in exact distances: inner walls of double-walled capsules
        # and faces buried inside overlapping patches face the wrong way or lie deep inside
        # face normals made to agree with the solid (open patches have no reliable winding of their own), and only
        # faces on the solid's boundary take part in exact distances (not faces buried inside overlapping patches)
        g = self.gradient(cen)
        fn = fn * np.where(np.einsum('ij,ij->i', fn, g) < 0, -1.0, 1.0)[:, None]
        valid = self.coarse(cen) > -1.0 * h
        if valid.sum() < 0.2 * len(valid): valid[:] = True
        self.fsel = np.flatnonzero(valid)
        self.tree = cKDTree(cen[self.fsel])
        self.fn = fn

    @classmethod
    def build(cls, v, f, h, pad=0.012, crop=None, cap=False, close=2, parity=False, slice_axis=None, oriented=False):
        lo = v.min(0) - pad; hi = v.max(0) + pad
        if crop is not None:
            lo = np.maximum(lo, crop[0]); hi = np.minimum(hi, crop[1])
        n = np.ceil((hi - lo) / h).astype(int) + 1
        vv, ff = cap_loops(v, f) if cap else (v, f)
        occ = voxel_solid(vv, ff, lo, h, n, close=close, parity=parity, slice_axis=slice_axis)
        sdf = (ndimage.distance_transform_edt(~occ) - ndimage.distance_transform_edt(occ)).astype(np.float32) * h
        # voxel centres sit h/2 either side of the true surface: shift so the zero level lies between them
        sdf = sdf - np.sign(sdf) * 0.5 * h
        return cls(v, f, lo, h, sdf, oriented=oriented)

    @classmethod
    def cached(cls, v, f, h, path, **kw):
        if os.path.exists(path):
            d = np.load(path)
            if int(d['nv']) == len(v) and int(d['nf']) == len(f) and abs(float(d['h']) - h) < 1e-9:
                return cls(v, f, d['lo'], float(d['h']), d['sdf'].astype(np.float32))
        fl = cls.build(v, f, h, **kw)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        np.savez(path, lo=fl.lo, h=fl.h, sdf=fl.sdf.astype(np.float16), nv=len(v), nf=len(f))
        return fl

    def coarse(self, p):
        p = np.asarray(p, float)
        d = _trilinear(self.sdf, self.lo, self.h, p)
        # outside the grid: at least the distance to the grid box
        out = np.maximum(self.lo - p, 0) + np.maximum(p - self.hi, 0)
        far = np.linalg.norm(out, axis=1)
        return np.where(far > 0, np.maximum(d, 0) + far, d)

    def closest(self, p, k=12, pseudo=False):
        """Closest surface point, its distance and face; pseudo=True also returns the mean normal of all candidate
        faces that share that closest point (an edge or vertex of the mesh): the sign test there."""
        p = np.asarray(p, float)
        _, cand = self.tree.query(p, k=min(k, len(self.fsel)))
        if cand.ndim == 1: cand = cand[:, None]
        cand = self.fsel[cand]
        from lib.mesh import _closest_point_triangle
        best_d = np.full(len(p), np.inf); best_q = np.zeros_like(p); best_t = np.zeros(len(p), np.int64)
        A, B, C = self.v[self.f[:, 0]], self.v[self.f[:, 1]], self.v[self.f[:, 2]]
        D = np.zeros(cand.shape)
        for j in range(cand.shape[1]):
            t = cand[:, j]
            q = _closest_point_triangle(p, A[t], B[t], C[t])
            d = np.linalg.norm(q - p, axis=1); D[:, j] = d
            m = d < best_d; best_d[m] = d[m]; best_q[m] = q[m]; best_t[m] = t[m]
        if not pseudo: return best_q, best_d, best_t
        tie = D <= best_d[:, None] + 1e-7
        nrm = np.einsum('ij,ijk->ik', tie.astype(float), self.fn[cand])
        return best_q, best_d, best_t, nrm

    def __call__(self, p, band=None):
        """Signed distance: voxel value away from the surface, exact distance (sign from the voxel solid, or from the
        closest face's normal very near the surface) within `band` of it."""
        p = np.asarray(p, float)
        s = self.coarse(p)
        band = 2.5 * self.h if band is None else band
        if self.oriented: band = max(band, 4.0 * self.h)
        near = np.abs(s) < band
        if near.any():
            if self.oriented:
                q, d, t, nps = self.closest(p[near], pseudo=True)
                sgn_n = np.sign(np.einsum('ij,ij->i', p[near] - q, nps))
            else:
                q, d, t = self.closest(p[near])
                sgn_n = np.sign(np.einsum('ij,ij->i', p[near] - q, self.fn[t]))
            sv = s[near]
            # oriented meshes: the exact sign everywhere in the band (a thin sheet's voxels are too coarse for it)
            sgn = sgn_n if self.oriented else np.where(np.abs(sv) > 1.2 * self.h, np.sign(sv), sgn_n)
            sgn[sgn == 0] = 1
            s = s.copy(); s[near] = sgn * d
        return s

    def outward(self, p):
        """Unit direction out of the solid at (or near) p: the closest face normal."""
        q, d, t = self.closest(p)
        return self.fn[t], q

    def gradient(self, p, e=None):
        e = e or self.h
        out = np.zeros((len(p), 3))
        for a in range(3):
            dd = np.zeros(3); dd[a] = e
            out[:, a] = (self.coarse(p + dd) - self.coarse(p - dd)) / (2 * e)
        return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)


def mesh_field(v, f, h, pad=0.012, **kw):
    """A Field around one of our own meshes (not cached). Our closed meshes are consistently wound, so their own face
    normals give the inside/outside sign near the surface (oriented=True, unless the mesh is open and capped)."""
    kw.setdefault('oriented', not kw.get('cap', False))
    return Field.build(v, f, h, pad=pad, **kw)


# ------------------------------------------------------------------------------------------------ smooth deformation
def edges_of(f):
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    e = np.sort(e, axis=1)
    return np.unique(e, axis=0)


def laplacian(n, f, extra=None, w_extra=1.0):
    e = edges_of(f)
    w = np.ones(len(e))
    if extra is not None and len(extra):
        e = np.concatenate([e, extra]); w = np.concatenate([w, np.full(len(extra), w_extra)])
    A = sparse.coo_matrix((np.concatenate([w, w]), (np.concatenate([e[:, 0], e[:, 1]]), np.concatenate([e[:, 1], e[:, 0]]))), shape=(n, n)).tocsr()
    deg = np.asarray(A.sum(1)).ravel()
    return (sparse.diags(deg) - A).tocsr(), deg


def smooth_solve(n, f, idx, targets, weights=1.0, fixed=None, fixed_val=None, eps=1e-4, L=None, order=2, w_scale=None):
    """Displacement field u (n x 3) minimising |L u|^2 (order 2: bi-Laplacian, smooth bending) + eps |u|^2 +
    sum_k w_k |u[idx_k] - targets_k|^2, with u[fixed] = fixed_val exactly. Returns u."""
    if L is None: L, deg = laplacian(n, f)
    else: deg = np.asarray(L.diagonal()).ravel()
    K = (L.T @ L) if order == 2 else L.copy()
    scale = float(np.mean(deg) ** order) if w_scale is None else w_scale
    w = np.zeros(n); rhs = np.zeros((n, 3))
    idx = np.asarray(idx, np.int64)
    wt = np.broadcast_to(np.asarray(weights, float), (len(idx),)) * scale
    np.add.at(w, idx, wt); np.add.at(rhs, idx, wt[:, None] * np.asarray(targets, float))
    K = (K + sparse.diags(w + eps * scale)).tocsc()
    u = np.zeros((n, 3))
    if fixed is not None and len(fixed):
        fixed = np.asarray(fixed, np.int64)
        fv = np.zeros((len(fixed), 3)) if fixed_val is None else np.asarray(fixed_val, float)
        free = np.ones(n, bool); free[fixed] = False
        fi = np.flatnonzero(free)
        Kff = K[fi][:, fi].tocsc(); Kfx = K[fi][:, fixed]
        r = rhs[fi] - Kfx @ fv
        lu = splu(Kff)
        u[fi] = np.column_stack([lu.solve(r[:, a]) for a in range(3)])
        u[fixed] = fv
    else:
        lu = splu(K)
        u = np.column_stack([lu.solve(rhs[:, a]) for a in range(3)])
    return u


def push_out(v, f, fields, clearance=0.0006, iters=12, fixed=None, fixed_val=None, eps=1e-4, max_step=None, extra_targets=None,
             L=None, log=None, tol=0.00005, weight=1.0, band=0.004):
    """Move a mesh out of neighbour fields with a smooth displacement (bi-Laplacian), keeping `fixed` vertices where
    `fixed_val` puts them (absolute positions). fields: list of (Field, clearance or None).
    extra_targets: (idx, positions, weight) soft targets kept in every solve. Returns new vertices."""
    v0 = v.copy(); v = v.copy(); n = len(v)
    if L is None: L, _ = laplacian(n, f)
    active = {}
    for it in range(iters):
        need = np.zeros((n, 3)); hit = np.zeros(n, bool); worst = 0.0
        for fl, c in fields:
            c = clearance if c is None else c
            s = fl.coarse(v)
            cand = np.flatnonzero(s < c + band)
            if not len(cand): continue
            sd = fl(v[cand])
            m = sd < c
            if not m.any(): continue
            ii = cand[m]
            nrm, q = fl.outward(v[ii])
            # the outward direction: from the closest surface point to the vertex when clearly outside, else face normal
            dvec = v[ii] - q; dl = np.linalg.norm(dvec, axis=1)
            use = (sd[m] > 0.3 * c) & (dl > 1e-6)
            dirn = np.where(use[:, None], dvec / np.maximum(dl, 1e-12)[:, None], nrm)
            push = (c - sd[m])[:, None] * dirn
            need[ii] += push; hit[ii] = True
            worst = max(worst, float((c - sd[m]).max()))
        if log: log(f'    push-out iter {it}: {int(hit.sum())} vertices, worst {worst * 1000:.2f} mm')
        if worst < tol: break
        for i in np.flatnonzero(hit):
            active[i] = v[i] + need[i]
        # targets: every vertex ever pushed keeps its last target (so it does not fall back in)
        ai = np.fromiter(active.keys(), np.int64); at = np.array([active[i] for i in ai])
        # refresh the targets of active vertices that are now clear: keep them where they are
        keep_t = at.copy()
        clear = ~hit[ai]; keep_t[clear] = np.where(np.linalg.norm(v[ai[clear]] - at[clear], axis=1)[:, None] < 0.002, at[clear], v[ai[clear]])
        idx = ai; tgt = keep_t - v0[ai]; wts = np.full(len(ai), weight)
        if extra_targets is not None:
            ei, ep, ew = extra_targets
            idx = np.concatenate([idx, ei]); tgt = np.concatenate([tgt, ep - v0[ei]]); wts = np.concatenate([wts, np.broadcast_to(ew, (len(ei),))])
        fv = None if fixed is None else (np.asarray(fixed_val) - v0[fixed])
        u = smooth_solve(n, f, idx, tgt, wts, fixed=fixed, fixed_val=fv, eps=eps, L=L)
        v = v0 + u
    return v


# ------------------------------------------------------------------------------------------------ topology
def boundary_loops(f):
    """Ordered boundary loops (lists of vertex ids), longest first."""
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    key = np.sort(e, axis=1)
    _, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    b = e[cnt[inv.ravel()] == 1]
    nxt = {}
    for a, c in b.tolist(): nxt.setdefault(a, []).append(c)
    loops, seen = [], set()
    for s in list(nxt):
        if s in seen: continue
        loop = [s]; seen.add(s); cur = s
        while True:
            cands = [x for x in nxt.get(cur, []) if x not in seen]
            if not cands: break
            cur = cands[0]; loop.append(cur); seen.add(cur)
        loops.append(loop)
    return sorted(loops, key=len, reverse=True)


def vertex_normals(v, f):
    n = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    vn = np.zeros_like(v)
    for k in range(3): np.add.at(vn, f[:, k], n)
    return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-20)


def geodesic_like(v, f, seeds, maxd=0.1):
    """Graph (edge-length) distance from seed vertices, for falloffs."""
    from scipy.sparse.csgraph import dijkstra
    e = edges_of(f); w = np.linalg.norm(v[e[:, 0]] - v[e[:, 1]], axis=1)
    n = len(v)
    G = sparse.coo_matrix((np.concatenate([w, w]), (np.concatenate([e[:, 0], e[:, 1]]), np.concatenate([e[:, 1], e[:, 0]]))), shape=(n, n)).tocsr()
    d = dijkstra(G, directed=False, indices=np.asarray(seeds), limit=maxd, min_only=True)
    return d


def smoothstep(x):
    x = np.clip(x, 0, 1); return x * x * (3 - 2 * x)


# ------------------------------------------------------------------------------------------------ tubes
def resample_polyline(P, n):
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    t = np.linspace(0, s[-1], n)
    return np.column_stack([np.interp(t, s, P[:, a]) for a in range(3)]), t


def smooth_polyline(P, sigma_pts, keep_ends=True):
    Q = ndimage.gaussian_filter1d(P, sigma_pts, axis=0, mode='nearest')
    if keep_ends: Q[0], Q[-1] = P[0], P[-1]
    return Q


def rmf(P, n0):
    """Rotation-minimising frames (double reflection) along polyline P, starting with normal n0. Returns T, N, B."""
    T = np.gradient(P, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    N = np.zeros_like(P)
    n0 = n0 - (n0 @ T[0]) * T[0]; N[0] = n0 / np.linalg.norm(n0)
    for i in range(len(P) - 1):
        v1 = P[i + 1] - P[i]; c1 = v1 @ v1
        if c1 < 1e-20: N[i + 1] = N[i]; continue
        rL = N[i] - (2 / c1) * (v1 @ N[i]) * v1; tL = T[i] - (2 / c1) * (v1 @ T[i]) * v1
        v2 = T[i + 1] - tL; c2 = v2 @ v2
        N[i + 1] = rL - (2 / c2) * (v2 @ rL) * v2 if c2 > 1e-20 else rL
        N[i + 1] /= np.linalg.norm(N[i + 1])
    B = np.cross(T, N)
    return T, N, B


class Tube:
    """A tubular mesh described along a centreline: each vertex as (arc length s, offsets along the frame N, B, T)."""

    def __init__(self, v, centreline, n0=(0, 0, 1)):
        self.C = np.asarray(centreline, float)
        self.s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(self.C, axis=0), axis=1))])
        self.T, self.N, self.B = rmf(self.C, np.asarray(n0, float))
        # project each vertex onto the polyline
        seg_a, seg_b = self.C[:-1], self.C[1:]
        tree = cKDTree((seg_a + seg_b) / 2)
        _, cand = tree.query(v, k=min(6, len(seg_a)))
        best = np.full(len(v), np.inf); bs = np.zeros(len(v)); bi = np.zeros(len(v), np.int64)
        for j in range(cand.shape[1]):
            i = cand[:, j]; a, b = seg_a[i], seg_b[i]
            ab = b - a; t = np.clip(np.einsum('ij,ij->i', v - a, ab) / np.maximum(np.einsum('ij,ij->i', ab, ab), 1e-20), 0, 1)
            q = a + t[:, None] * ab; d = np.linalg.norm(v - q, axis=1)
            m = d < best; best[m] = d[m]; bs[m] = (self.s[i] + t * (self.s[i + 1] - self.s[i]))[m]; bi[m] = i[m]
        self.vs = bs
        F = self.frame_at(bs)
        c = self.point_at(bs)
        r = v - c
        self.local = np.column_stack([np.einsum('ij,ij->i', r, F[1]), np.einsum('ij,ij->i', r, F[2]), np.einsum('ij,ij->i', r, F[0])])

    def point_at(self, s, C=None, sgrid=None):
        C = self.C if C is None else C; sg = self.s if sgrid is None else sgrid
        return np.column_stack([np.interp(s, sg, C[:, a]) for a in range(3)])

    def frame_at(self, s, T=None, N=None, B=None, sgrid=None):
        T = self.T if T is None else T; N = self.N if N is None else N; B = self.B if B is None else B
        sg = self.s if sgrid is None else sgrid
        out = []
        for M in (T, N, B):
            X = np.column_stack([np.interp(s, sg, M[:, a]) for a in range(3)])
            out.append(X / np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12))
        return out

    def rebuild(self, C2, n0=None, scale=None):
        """Vertices of the tube moved onto centreline C2 (same number of stations; arc length rescaled uniformly).
        scale: optional (nstations, 2) per-station factors on the N and B offsets."""
        s2 = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(C2, axis=0), axis=1))])
        n0 = self.N[0] if n0 is None else n0
        T2, N2, B2 = rmf(C2, np.asarray(n0, float))
        u = self.vs / self.s[-1] * s2[-1]
        c = self.point_at(u, C2, s2)
        Tq, Nq, Bq = self.frame_at(u, T2, N2, B2, s2)
        a, b, t = self.local[:, 0].copy(), self.local[:, 1].copy(), self.local[:, 2] * (s2[-1] / self.s[-1])
        if scale is not None:
            a *= np.interp(self.vs, self.s, scale[:, 0]); b *= np.interp(self.vs, self.s, scale[:, 1])
        return c + a[:, None] * Nq + b[:, None] * Bq + t[:, None] * Tq


def centreline(v, start, end, n=80, iters=4, slab=0.003, radius=0.03):
    """Centreline of a tube from near `start` to near `end`: initialised by the straight-ish path of slice centroids,
    refined by re-slicing perpendicular to the current tangent."""
    v = np.asarray(v, float)
    # initial: order vertices by projection onto the start-end line, bin centroids
    axis = np.asarray(end) - np.asarray(start); L = np.linalg.norm(axis); axis /= L
    t = (v - start) @ axis
    bins = np.linspace(t.min(), t.max(), n + 1)
    P = []
    for i in range(n):
        m = (t >= bins[i]) & (t <= bins[i + 1])
        if m.sum() >= 3: P.append(v[m].mean(0))
    P = np.array(P)
    P, _ = resample_polyline(P, n)
    for _ in range(iters):
        T = np.gradient(P, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
        Q = P.copy()
        for i in range(n):
            d = (v - P[i]) @ T[i]
            r = np.linalg.norm((v - P[i]) - d[:, None] * T[i], axis=1)
            m = (np.abs(d) < slab) & (r < radius)
            if m.sum() >= 6: Q[i] = v[m].mean(0)
        P = smooth_polyline(Q, 1.0, keep_ends=False)
        P, _ = resample_polyline(P, n)
    return P


# ------------------------------------------------------------------------------------------------ as-rigid-as-possible
class ARAP:
    """As-rigid-as-possible deformation of a mesh with rest shape `p` (Sorkine & Alexa 2007, uniform weights): each
    vertex's one-ring keeps its rest shape up to a rotation, while soft positional targets pull selected vertices.
    `extra` adds edges (e.g. across a thin sheet) that take part like mesh edges."""

    def __init__(self, p, f, extra=None, extra_w=1.0):
        self.p = np.asarray(p, float); n = len(p)
        e = edges_of(f); w = np.ones(len(e))
        if extra is not None and len(extra):
            ex = np.sort(np.asarray(extra), axis=1); ex = np.unique(ex[ex[:, 0] != ex[:, 1]], axis=0)
            e = np.concatenate([e, ex]); w = np.concatenate([w, np.full(len(ex), extra_w)])
        self.e, self.w, self.n = e, w, n
        A = sparse.coo_matrix((np.concatenate([w, w]), (np.concatenate([e[:, 0], e[:, 1]]), np.concatenate([e[:, 1], e[:, 0]]))), shape=(n, n)).tocsr()
        self.L = (sparse.diags(np.asarray(A.sum(1)).ravel()) - A).tocsc()
        self.ep = self.p[e[:, 0]] - self.p[e[:, 1]]

    def rotations(self, v):
        ev = v[self.e[:, 0]] - v[self.e[:, 1]]
        P = self.w[:, None, None] * np.einsum('ij,ik->ijk', self.ep, ev)
        S = np.zeros((self.n, 3, 3))
        np.add.at(S, self.e[:, 0], P); np.add.at(S, self.e[:, 1], P)
        U, sig, Vt = np.linalg.svd(S)
        R = np.einsum('nji,nkj->nik', Vt, U)            # V U^T
        bad = np.linalg.det(R) < 0
        if bad.any():
            Vt2 = Vt[bad].copy(); Vt2[:, 2, :] *= -1
            R[bad] = np.einsum('nji,nkj->nik', Vt2, U[bad])
        return R

    def solve(self, v, idx, tgt, wts, iters=6, fixed=None):
        """v: starting positions; idx/tgt/wts: soft targets (absolute positions); fixed: vertices held at v."""
        n = self.n
        wv = np.zeros(n); rhs_t = np.zeros((n, 3))
        idx = np.asarray(idx, np.int64)
        wts = np.broadcast_to(np.asarray(wts, float), (len(idx),))
        np.add.at(wv, idx, wts); np.add.at(rhs_t, idx, wts[:, None] * np.asarray(tgt, float))
        if fixed is not None and len(fixed):
            big = 1e4; wv[fixed] += big; rhs_t[fixed] += big * v[fixed]
        lu = splu((self.L + sparse.diags(wv + 1e-9)).tocsc())
        for _ in range(iters):
            R = self.rotations(v)
            Rm = 0.5 * (R[self.e[:, 0]] + R[self.e[:, 1]])
            be = self.w[:, None] * np.einsum('nij,nj->ni', Rm, self.ep)
            b = np.zeros((n, 3)); np.add.at(b, self.e[:, 0], be); np.add.at(b, self.e[:, 1], -be)
            rhs = b + rhs_t
            v = np.column_stack([lu.solve(rhs[:, a]) for a in range(3)])
        return v


def fill_hole(v, f, loop, spacing=None, K=None):
    """Close a boundary loop with a patch of concentric rings, faired (bi-Laplacian, the existing surface held) so it
    continues the surrounding curvature. Returns (v, f, new vertex ids)."""
    loop = np.asarray(loop)
    P = v[loop]; c = P.mean(0); n0 = len(v)
    if spacing is None: spacing = float(np.median(np.linalg.norm(np.diff(np.vstack([P, P[:1]]), axis=0), axis=1)))
    rad = float(np.linalg.norm(P - c, axis=1).mean())
    if K is None: K = max(1, int(round(rad / max(spacing, 1e-4))) - 1)
    V = [v]; F = [f]; prev = loop; nxt_id = n0
    for k in range(1, K + 1):
        t = k / (K + 1)
        ring = c + (P - c) * (1 - t)
        ids = np.arange(nxt_id, nxt_id + len(loop)); nxt_id += len(loop)
        V.append(ring)
        a, b = prev, np.roll(prev, -1); a2, b2 = ids, np.roll(ids, -1)
        F.append(np.column_stack([a, b, b2])); F.append(np.column_stack([a, b2, a2]))
        prev = ids
    V.append(c[None]); ci = nxt_id
    F.append(np.column_stack([prev, np.roll(prev, -1), np.full(len(prev), ci)]))
    v2 = np.concatenate(V); f2 = np.concatenate(F)
    new = np.arange(n0, len(v2))
    # fairing: minimise |L x|^2 over the new vertices with the old ones fixed
    L, _ = laplacian(len(v2), f2)
    K2 = (L.T @ L).tocsr()
    old = np.arange(n0)
    A = K2[new][:, new].tocsc(); B = K2[new][:, old]
    lu = splu(A)
    rhs = -(B @ v2[old])
    v2[new] = np.column_stack([lu.solve(rhs[:, a]) for a in range(3)])
    return v2, f2, new


def refine_long_edges(V, f, lmax, cols=slice(0, 3), max_iter=12):
    """Split every edge longer than lmax (measured on V[:, cols]) at its midpoint, longest first, until none is left;
    each adjacent triangle is halved, so the mesh stays conforming. V may carry several stacked copies of the vertex
    positions (columns), which are all interpolated alike. Returns (V, f)."""
    V = np.asarray(V, float).copy(); f = np.asarray(f, np.int64).copy()
    for _ in range(max_iter):
        e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
        key = np.sort(e, axis=1)
        L = np.linalg.norm(V[key[:, 0], cols] - V[key[:, 1], cols], axis=1)
        long = L > lmax
        if not long.any(): break
        fid = np.tile(np.arange(len(f)), 3)
        order = np.argsort(-L[long])
        cand_keys = key[long][order]; cand_f = fid[long][order]
        # edge -> faces
        e2f = {}
        for k, fi in zip(map(tuple, key.tolist()), fid.tolist()): e2f.setdefault(k, []).append(fi)
        used = np.zeros(len(f), bool)
        newV, newF, kill = [], [], []
        nv = len(V)
        seen = set()
        for k in map(tuple, cand_keys.tolist()):
            if k in seen: continue
            seen.add(k)
            fs = e2f[k]
            if any(used[x] for x in fs): continue
            a, b = k
            m = nv + len(newV); newV.append(0.5 * (V[a] + V[b]))
            for x in fs:
                used[x] = True; kill.append(x)
                t = f[x].tolist()
                i = [j for j in range(3) if {t[j], t[(j + 1) % 3]} == {a, b}][0]
                p, q, r = t[i], t[(i + 1) % 3], t[(i + 2) % 3]
                newF.append([p, m, r]); newF.append([m, q, r])
        if not newV: break
        keep = np.ones(len(f), bool); keep[kill] = False
        V = np.concatenate([V, np.array(newV)]); f = np.concatenate([f[keep], np.array(newF, np.int64)])
    return V, f


# ------------------------------------------------------------------------------------------------ exact inside test
def winding(P, v, f, chunk=16):
    """Generalized winding number of the closed, consistently wound mesh (v, f) at points P (van Oosterom-Strackee
    solid angles): ~1 inside, ~0 outside, exact for closed meshes whatever a voxel field's flood fill makes of folds
    and narrow pockets."""
    P = np.asarray(P, float)
    A, B, C = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    out = np.zeros(len(P))
    for s in range(0, len(P), chunk):
        p = P[s:s + chunk, None, :]
        a, b, c = A[None] - p, B[None] - p, C[None] - p
        la, lb, lc = (np.linalg.norm(x, axis=2) for x in (a, b, c))
        det = np.einsum('ijk,ijk->ij', a, np.cross(b, c))
        den = (la * lb * lc + np.einsum('ijk,ijk->ij', a, b) * lc + np.einsum('ijk,ijk->ij', b, c) * la
               + np.einsum('ijk,ijk->ij', c, a) * lb)
        out[s:s + chunk] = (2 * np.arctan2(det, den)).sum(1) / (4 * np.pi)
    return out


def is_closed(f):
    e = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
    _, cnt = np.unique(e, axis=0, return_counts=True)
    return bool((cnt == 2).all())


def orient_manifold(v, f):
    """lib.mesh.orient_outward with the winding carried only across manifold edges (shared by exactly two faces).
    Surface nets leave a few non-manifold edges where two parts of a solid touch at an ambiguous cell (four faces on
    one edge); a breadth-first walk that pairs those faces at random carries a wrong flip over whole patches of the
    surface (7 % of the female stomach once). Each connected component then faces outward by the same rule as
    orient_outward (closed: positive volume; open: normals away from its centroid on average). Identical to
    orient_outward on an edge-manifold mesh."""
    from lib.mesh import components, signed_volume, face_normals
    f = np.asarray(f).copy()
    if not len(f): return f
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    fid = np.tile(np.arange(len(f)), 3)
    _, inv, cnt = np.unique(np.sort(e, axis=1), axis=0, return_inverse=True, return_counts=True)
    inv = inv.ravel()
    m = np.flatnonzero(cnt[inv] == 2)
    m = m[np.argsort(inv[m], kind='stable')]
    a, b = m[0::2], m[1::2]
    same = np.all(e[a] == e[b], axis=1)                     # traversed the same way: one face flipped
    adj = [[] for _ in range(len(f))]
    for x, y, s in zip(fid[a].tolist(), fid[b].tolist(), same.tolist()):
        adj[x].append((y, s)); adj[y].append((x, s))
    flip = np.zeros(len(f), bool); seen = np.zeros(len(f), bool)
    for start in range(len(f)):
        if seen[start]: continue
        seen[start] = True; stack = [start]
        while stack:
            x = stack.pop()
            for y, s in adj[x]:
                if seen[y]: continue
                seen[y] = True; flip[y] = flip[x] ^ s; stack.append(y)
    f[flip] = f[flip][:, ::-1]
    for comp in components(v, f):
        sub = f[comp]
        if is_closed(sub):
            if signed_volume(v, sub) < 0: f[comp] = sub[:, ::-1]
        else:
            c = v[np.unique(sub)].mean(0)
            if np.einsum('ij,ij->i', face_normals(v, sub, unit=False), v[sub].mean(1) - c).sum() < 0: f[comp] = sub[:, ::-1]
    return f


def fair_folds(v, f, fixed=None, cos_max=0.5, rings=2, iters=30, lam=0.5, mu=-0.53):
    """Taubin (lambda|mu) fairing of the crumpled patches only: vertices of edges whose faces fold sharply (normals
    more than ~60 deg apart), grown by `rings` neighbour rings; every other vertex (and `fixed`) stays. Removes the
    folds and shards a push-out leaves where neighbours press from several sides, without shrinking the organ (the
    mu step undoes the lambda step's shrinkage). Returns (v, number of faired vertices)."""
    v = np.asarray(v, float).copy(); n = len(v)
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-20)
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]); key = np.sort(e, axis=1)
    fid = np.tile(np.arange(len(f)), 3)
    o = np.lexsort((key[:, 1], key[:, 0])); key, fid = key[o], fid[o]
    same = (key[1:] == key[:-1]).all(1)
    a, b = fid[:-1][same], fid[1:][same]
    sharp = np.einsum('ij,ij->i', fn[a], fn[b]) < cos_max
    sel = np.zeros(n, bool); sel[f[a[sharp]].ravel()] = True; sel[f[b[sharp]].ravel()] = True
    E = edges_of(f)
    for _ in range(rings):
        grow = sel.copy(); grow[E[sel[E[:, 0]], 1]] = True; grow[E[sel[E[:, 1]], 0]] = True; sel = grow
    if fixed is not None: sel[np.asarray(fixed)] = False
    idx = np.flatnonzero(sel)
    if not len(idx): return v, 0
    from scipy import sparse
    A = sparse.coo_matrix((np.ones(2 * len(E)), (np.r_[E[:, 0], E[:, 1]], np.r_[E[:, 1], E[:, 0]])), shape=(n, n)).tocsr()
    deg = np.maximum(np.asarray(A.sum(1)).ravel(), 1)
    for _ in range(iters):
        for k in (lam, mu):
            Lv = (A @ v) / deg[:, None] - v
            v[idx] += k * Lv[idx]
    return v, int(len(idx))
