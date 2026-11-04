"""Geometry helpers for the arms fit (numpy + scipy only).

  TriMesh        exact closest points and signed distances to a closed triangle mesh (angle-weighted pseudo-normals)
  slice_loops    plane sections of a mesh as closed polygons (centroid, area, perimeter)
  fit_sphere     least-squares sphere
  Aff            affine map x -> A x + t (rigid, similarity or a per-bone stretch), composable
  rot_axis       rotation matrix about an axis
"""
import numpy as np
from scipy.spatial import cKDTree


# ------------------------------------------------------------------------------------------------ affine maps
class Aff:
    """x -> A x + t"""

    def __init__(self, A=None, t=None):
        self.A = np.eye(3) if A is None else np.asarray(A, float)
        self.t = np.zeros(3) if t is None else np.asarray(t, float)

    def __call__(self, p):
        return np.asarray(p, float) @ self.A.T + self.t

    def vec(self, d):
        return np.asarray(d, float) @ self.A.T

    def then(self, other):
        """other(self(x))"""
        return Aff(other.A @ self.A, other.A @ self.t + other.t)

    def inverse(self):
        Ai = np.linalg.inv(self.A)
        return Aff(Ai, -Ai @ self.t)

    @staticmethod
    def about(M, c, c_to=None):
        """Linear map M applied about point c (c goes to c_to, default c)."""
        c = np.asarray(c, float); c_to = c if c_to is None else np.asarray(c_to, float)
        return Aff(M, c_to - M @ c)

    @staticmethod
    def from_sim(S):
        return Aff(S.s * S.R, S.t)

    def to_dict(self):
        return dict(A=self.A.tolist(), t=self.t.tolist())


def rot_axis(axis, ang):
    a = np.asarray(axis, float); a = a / np.linalg.norm(a)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(ang) * K + (1 - np.cos(ang)) * (K @ K)


def rot_between(a, b):
    a = np.asarray(a, float) / np.linalg.norm(a); b = np.asarray(b, float) / np.linalg.norm(b)
    v = np.cross(a, b); s = np.linalg.norm(v); c = float(a @ b)
    if s < 1e-12:
        if c > 0: return np.eye(3)
        p = np.cross(a, [1, 0, 0])
        if np.linalg.norm(p) < 1e-6: p = np.cross(a, [0, 1, 0])
        return rot_axis(p, np.pi)
    return rot_axis(v / s, np.arctan2(s, c))


def rot_angle(R):
    return float(np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))))


def unit(v):
    v = np.asarray(v, float); return v / np.linalg.norm(v, axis=-1, keepdims=True)


def stretch(axis, k_axial, k_radial=1.0):
    """Linear map scaling by k_axial along `axis` and by k_radial across it."""
    a = unit(axis)
    return k_radial * np.eye(3) + (k_axial - k_radial) * np.outer(a, a)


def nearest_rotation(M):
    U, _, Vt = np.linalg.svd(M)
    D = np.eye(3); D[2, 2] = np.sign(np.linalg.det(U @ Vt))
    return U @ D @ Vt


# ------------------------------------------------------------------------------------------------ fits
def fit_sphere(p, w=None):
    """Least-squares sphere through points (algebraic fit). Returns (centre, radius)."""
    p = np.asarray(p, float)
    w = np.ones(len(p)) if w is None else np.asarray(w, float)
    A = np.c_[2 * p, np.ones(len(p))]
    b = (p ** 2).sum(1)
    sw = np.sqrt(w)
    x, *_ = np.linalg.lstsq(A * sw[:, None], b * sw, rcond=None)
    c = x[:3]; r = np.sqrt(max(x[3] + c @ c, 1e-12))
    return c, float(r)


def fit_plane(p):
    c = p.mean(0)
    _, _, Vt = np.linalg.svd(p - c, full_matrices=False)
    return c, Vt[2]


def pca_axes(p):
    c = p.mean(0)
    w, V = np.linalg.eigh(np.cov((p - c).T))
    return c, V[:, ::-1], np.sqrt(np.maximum(w[::-1], 0))


# ------------------------------------------------------------------------------------------------ exact distances
def closest_on_triangles(p, a, b, c):
    """Closest points q on triangles (a, b, c) to points p, all (n, 3) arrays (Ericson's region tests).
    Returns q and the region: 0 face, 1 edge ab, 2 edge bc, 3 edge ca, 4 vertex a, 5 vertex b, 6 vertex c."""
    ab = b - a; ac = c - a; ap = p - a
    d1 = np.einsum('ij,ij->i', ab, ap); d2 = np.einsum('ij,ij->i', ac, ap)
    bp = p - b
    d3 = np.einsum('ij,ij->i', ab, bp); d4 = np.einsum('ij,ij->i', ac, bp)
    cp = p - c
    d5 = np.einsum('ij,ij->i', ab, cp); d6 = np.einsum('ij,ij->i', ac, cp)
    vc = d1 * d4 - d3 * d2; vb = d5 * d2 - d1 * d6; va = d3 * d6 - d5 * d4
    with np.errstate(divide='ignore', invalid='ignore'):
        den = va + vb + vc
        v_f = np.where(np.abs(den) > 1e-30, vb / den, 1 / 3); w_f = np.where(np.abs(den) > 1e-30, vc / den, 1 / 3)
        q = a + ab * v_f[:, None] + ac * w_f[:, None]
        reg = np.zeros(len(p), np.int8)
        done = np.zeros(len(p), bool)

        def put(mask, qq, r):
            nonlocal q
            m = mask & ~done
            q = np.where(m[:, None], qq, q); reg[m] = r; done[m] = True

        put((d1 <= 0) & (d2 <= 0), a, 4)
        put((d3 >= 0) & (d4 <= d3), b, 5)
        t = d1 / np.where(np.abs(d1 - d3) > 1e-30, d1 - d3, 1e-30)
        put((vc <= 0) & (d1 >= 0) & (d3 <= 0), a + ab * t[:, None], 1)
        put((d6 >= 0) & (d5 <= d6), c, 6)
        t = d2 / np.where(np.abs(d2 - d6) > 1e-30, d2 - d6, 1e-30)
        put((vb <= 0) & (d2 >= 0) & (d6 <= 0), a + ac * t[:, None], 3)
        den2 = (d4 - d3) + (d5 - d6)
        t = (d4 - d3) / np.where(np.abs(den2) > 1e-30, den2, 1e-30)
        put((va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0), b + (c - b) * t[:, None], 2)
    return q, reg


SUB_R = 0.0015   # m: radius of the sub-triangles whose centroids index a TriMesh for the closest-triangle search


def _sub_barycentres(n):
    """Barycentric centroids of the n x n sub-triangles of a triangle."""
    out = []
    for i in range(n):
        for j in range(n - i):
            out.append(((i + 1 / 3) / n, (j + 1 / 3) / n))
            if i + j <= n - 2: out.append(((i + 2 / 3) / n, (j + 2 / 3) / n))
    uv = np.array(out)
    return np.c_[1 - uv.sum(1), uv]


class TriMesh:
    """Closed triangle mesh with exact closest-point queries and signed distance (negative inside).
    The sign comes from angle-weighted pseudo-normals of the closest feature (Baerentzen & Aanaes), which is exact for
    closed, consistently oriented meshes."""

    def __init__(self, v, f, k=16, sub_r=None, exact_within=0.0045):
        from lib.mesh import orient_outward
        self.v = np.asarray(v, float); self.f = orient_outward(self.v, np.asarray(f, np.int64))
        self.k = k; self.exact_within = exact_within
        sub_r = SUB_R if sub_r is None else sub_r
        v, f = self.v, self.f
        a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
        fn = np.cross(b - a, c - a); fa = np.linalg.norm(fn, axis=1)
        self.fn = fn / np.maximum(fa, 1e-30)[:, None]
        # angle-weighted vertex normals
        vn = np.zeros_like(v)
        for i, (p0, p1, p2) in enumerate(((a, b, c), (b, c, a), (c, a, b))):
            e1 = unit(p1 - p0 + 1e-30); e2 = unit(p2 - p0 + 1e-30)
            ang = np.arccos(np.clip(np.einsum('ij,ij->i', e1, e2), -1, 1))
            np.add.at(vn, f[:, i], self.fn * ang[:, None])
        self.vn = vn
        # edge normals: sum of the two adjacent face normals
        e = np.stack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]], 1).reshape(-1, 2)
        key = np.sort(e, 1)
        uniq, inv = np.unique(key, axis=0, return_inverse=True)
        en = np.zeros((len(uniq), 3))
        np.add.at(en, inv.ravel(), np.repeat(self.fn, 3, axis=0))
        self.en = en; self.fe = inv.reshape(-1, 3)  # face -> edge ids (ab, bc, ca)
        self.cent = (a + b + c) / 3
        # search structure: centroids of the triangles cut into n x n sub-triangles of radius <= SUB_R (the bone meshes
        # have sliver triangles up to 5 cm long on the shafts, whose own centroids can be far from their closest point)
        r = np.sqrt(np.max([((x - self.cent) ** 2).sum(1) for x in (a, b, c)], 0))
        nsub = np.maximum(1, np.ceil(r / sub_r)).astype(int)
        pts, fid = [], []
        for n in np.unique(nsub):
            idx = np.flatnonzero(nsub == n)
            bc = _sub_barycentres(int(n))
            pts.append(np.einsum('kq,mqj->mkj', bc, np.stack([a[idx], b[idx], c[idx]], 1)).reshape(-1, 3))
            fid.append(np.repeat(idx, len(bc)))
        self.spts = np.concatenate(pts); self.sfid = np.concatenate(fid)
        self.rmax = float((r / nsub).max()) * 1.05
        self.tree = cKDTree(self.spts)
        self.vtree = None

    def closest(self, p, k=None, chunk=50000, exact_within=None, k_max=2048):
        """(distance >= 0, closest point, face id, pseudo-normal at the closest feature) for points p.
        Candidates are the triangles of the k nearest sub-triangle centroids; for points within `exact_within` of the
        surface (default: the mesh's own, 4.5 mm for bones; the skin used inside the solvers is approximate) the
        search is widened until it is provably exact (every triangle that could be closer, i.e. with its centroid
        within the found distance plus the largest centroid-to-vertex radius, has been tested). Coarse meshes (the
        carpals have 2-3 mm triangles) need this: a fixed k can miss the closest triangle and flip the sign."""
        p = np.atleast_2d(np.asarray(p, float))
        exact_within = self.exact_within if exact_within is None else exact_within
        nf = len(self.spts)
        k = min(k or self.k, nf)
        D, Q, FI, N, dk = self._closest_k(p, k, chunk)
        todo = np.flatnonzero((D < exact_within) & (dk < D + self.rmax)) if k < nf else np.zeros(0, int)
        while len(todo) and k < min(nf, k_max):
            k = min(4 * k, nf, k_max)
            d2, q2, f2, n2, dk2 = self._closest_k(p[todo], k, chunk)
            D[todo], Q[todo], FI[todo], N[todo] = d2, q2, f2, n2
            todo = todo[(dk2 < d2 + self.rmax)] if k < nf else todo[:0]
        return D, Q, FI, N

    def _closest_k(self, p, k, chunk):
        D = np.empty(len(p)); Q = np.empty_like(p); FI = np.empty(len(p), np.int64); N = np.empty_like(p); DK = np.empty(len(p))
        for s in range(0, len(p), chunk):
            pp = p[s:s + chunk]; n = len(pp)
            dc, cand = self.tree.query(pp, k=k)
            cand = self.sfid[cand.reshape(n, -1)]; DK[s:s + n] = dc.reshape(n, -1)[:, -1] if k < len(self.spts) else np.inf
            P = np.repeat(pp, cand.shape[1], axis=0); C = cand.ravel()
            tri = self.f[C]
            q, reg = closest_on_triangles(P, self.v[tri[:, 0]], self.v[tri[:, 1]], self.v[tri[:, 2]])
            d = np.linalg.norm(P - q, axis=1).reshape(n, -1)
            j = np.argmin(d, axis=1); r = np.arange(n)
            sel = r * cand.shape[1] + j
            D[s:s + n] = d[r, j]; Q[s:s + n] = q[sel]; fi = C[sel]; FI[s:s + n] = fi
            rg = reg[sel]
            nn = self.fn[fi].copy()
            for code, ei in ((1, 0), (2, 1), (3, 2)):
                m = rg == code
                if m.any(): nn[m] = self.en[self.fe[fi[m], ei]]
            for code, vi in ((4, 0), (5, 1), (6, 2)):
                m = rg == code
                if m.any(): nn[m] = self.vn[self.f[fi[m], vi]]
            N[s:s + n] = nn
        return D, Q, FI, N, DK

    def signed(self, p, k=None, exact_within=None):
        d, q, fi, n = self.closest(p, k, exact_within=exact_within)
        s = np.sign(np.einsum('ij,ij->i', np.atleast_2d(p) - q, n))
        s[s == 0] = 1
        return d * s

    def signed_full(self, p, k=None, exact_within=None):
        """(signed distance, closest point, face id, outward unit normal of the closest face)"""
        d, q, fi, n = self.closest(p, k, exact_within=exact_within)
        s = np.sign(np.einsum('ij,ij->i', np.atleast_2d(p) - q, n)); s[s == 0] = 1
        return d * s, q, fi, self.fn[fi]


# ------------------------------------------------------------------------------------------------ plane sections
def slice_loops(v, f, origin, normal, faces=None):
    """Closed polygons where the plane through `origin` with `normal` cuts the mesh.
    Returns a list of (n, 3) vertex arrays (ordered around each loop). `faces` limits the search to those faces."""
    normal = unit(normal)
    F = f if faces is None else f[faces]
    sd = (v - origin) @ normal
    s = sd[F]
    pos = s > 0
    cnt = pos.sum(1)
    hit = (cnt == 1) | (cnt == 2)
    if not hit.any(): return []
    F = F[hit]; s = s[hit]; pos = pos[hit]
    # each crossing face has exactly two crossing edges; points are keyed by their (sorted) mesh edge
    segs = []
    keys = []
    for (i, j) in ((0, 1), (1, 2), (2, 0)):
        m = pos[:, i] != pos[:, j]
        keys.append(np.where(m[:, None], np.sort(F[:, [i, j]], 1), -1))
    keys = np.stack(keys, 1)  # (m, 3, 2)
    valid = keys[:, :, 0] >= 0
    # pairs of crossing edges per face
    e_pairs = []
    for r in range(len(F)):
        ks = keys[r][valid[r]]
        if len(ks) == 2: e_pairs.append((tuple(ks[0]), tuple(ks[1])))
    if not e_pairs: return []
    # point on each edge
    allk = {}
    for a_, b_ in e_pairs:
        for k_ in (a_, b_):
            if k_ not in allk:
                i, j = k_; t = sd[i] / (sd[i] - sd[j])
                allk[k_] = v[i] + t * (v[j] - v[i])
    adj = {}
    for a_, b_ in e_pairs:
        adj.setdefault(a_, []).append(b_); adj.setdefault(b_, []).append(a_)
    loops = []; seen = set()
    for start in adj:
        if start in seen: continue
        loop = [start]; seen.add(start); prev = None; cur = start
        while True:
            nxt = [x for x in adj[cur] if x != prev and x not in seen]
            if not nxt: break
            prev, cur = cur, nxt[0]; seen.add(cur); loop.append(cur)
        if len(loop) >= 3: loops.append(np.array([allk[k_] for k_ in loop]))
    return loops


def polygon_props(P, normal):
    """Area, centroid and perimeter of a planar polygon (n, 3) with the given plane normal."""
    normal = unit(normal)
    c0 = P.mean(0)
    a = P - c0; b = np.roll(P, -1, 0) - c0
    cr = np.cross(a, b) @ normal
    A = 0.5 * cr.sum()
    if abs(A) < 1e-14: return 0.0, c0, float(np.linalg.norm(np.roll(P, -1, 0) - P, axis=1).sum())
    cen = c0 + ((a + b) * cr[:, None]).sum(0) / (6 * A)
    per = float(np.linalg.norm(np.roll(P, -1, 0) - P, axis=1).sum())
    return abs(A), cen, per


def point_in_polygon(P, normal, q):
    """Is q (projected onto the polygon plane) inside the polygon P (n, 3)?"""
    normal = unit(normal)
    u = unit(np.cross(normal, [1, 0, 0] if abs(normal[0]) < 0.9 else [0, 1, 0])); w = np.cross(normal, u)
    x = (P - q) @ u; y = (P - q) @ w
    x2 = np.roll(x, -1); y2 = np.roll(y, -1)
    cross = ((y > 0) != (y2 > 0))
    with np.errstate(divide='ignore', invalid='ignore'):
        xi = x + (0 - y) * (x2 - x) / (y2 - y)
    return bool(np.sum(cross & (xi > 0)) % 2 == 1)


def slice_segments(v, f, origin, normal):
    """All segments (m, 2, 3) where the plane cuts the triangles of a (possibly open) mesh."""
    normal = unit(normal)
    sd = (v - origin) @ normal
    s = sd[f]; pos = s > 0; cnt = pos.sum(1)
    hit = (cnt == 1) | (cnt == 2)
    if not hit.any(): return np.zeros((0, 2, 3))
    F = f[hit]; s = s[hit]; pos = pos[hit]
    out = np.zeros((len(F), 2, 3)); k = np.zeros(len(F), int)
    for (i, j) in ((0, 1), (1, 2), (2, 0)):
        m = pos[:, i] != pos[:, j]
        if not m.any(): continue
        t = s[m, i] / (s[m, i] - s[m, j])
        P = v[F[m, i]] + t[:, None] * (v[F[m, j]] - v[F[m, i]])
        rows = np.flatnonzero(m)
        out[rows, np.minimum(k[rows], 1)] = P
        k[rows] += 1
    return out[k == 2]


def ray_exit(T, p, u, max_len=0.3, eps=2e-4):
    """Distance from an inside point p along direction u to the surface of closed mesh T (sphere tracing)."""
    u = unit(u); t = 0.0
    for _ in range(200):
        q = p + t * u
        d = -T.signed(q[None])[0]
        if d <= eps: return t
        t += max(d, eps)
        if t > max_len: return max_len
    return t


def ray_exit_many(T, P, u, max_len=0.3, eps=2e-4, iters=60):
    """Vectorised ray_exit for many inside points P along one direction (or per-point directions) u."""
    P = np.atleast_2d(np.asarray(P, float)); u = np.asarray(u, float)
    U = np.broadcast_to(unit(u), P.shape)
    t = np.zeros(len(P)); act = np.ones(len(P), bool)
    for _ in range(iters):
        if not act.any(): break
        q = P[act] + t[act, None] * U[act]
        d = -T.signed(q)
        done = d <= eps
        ia = np.flatnonzero(act)
        t[ia[~done]] += np.maximum(d[~done], eps)
        act[ia[done]] = False
        act &= t < max_len
    return np.minimum(t, max_len)


class FrontBack:
    """Front (+z) and back (-z) skin distances on an (x, y) grid around a point, for cheap interpolation."""

    def __init__(self, T, centre, half=0.05, step=0.005):
        self.c = np.asarray(centre, float); self.step = step
        g = np.arange(-half, half + 1e-9, step); self.g = g
        X, Y = np.meshgrid(g, g, indexing='ij')
        P = np.c_[self.c[0] + X.ravel(), self.c[1] + Y.ravel(), np.full(X.size, self.c[2])]
        inside = T.signed(P) < 0
        fr = np.full(len(P), np.nan); bk = np.full(len(P), np.nan)
        fr[inside] = ray_exit_many(T, P[inside], [0, 0, 1]); bk[inside] = ray_exit_many(T, P[inside], [0, 0, -1])
        self.zf = (self.c[2] + fr).reshape(X.shape); self.zb = (self.c[2] - bk).reshape(X.shape)

    def __call__(self, p):
        from scipy.ndimage import map_coordinates
        i = (p[0] - self.c[0] - self.g[0]) / self.step; j = (p[1] - self.c[1] - self.g[0]) / self.step
        zf = map_coordinates(np.nan_to_num(self.zf, nan=self.c[2]), [[i], [j]], order=1, mode='nearest')[0]
        zb = map_coordinates(np.nan_to_num(self.zb, nan=self.c[2]), [[i], [j]], order=1, mode='nearest')[0]
        return zf - p[2], p[2] - zb
