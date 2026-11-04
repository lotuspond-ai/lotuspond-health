"""Geometry helpers for the vessels group (fit/vessels.py): tube centerlines, plane cuts, open ends of HRA stubs,
exact signed distances to bones / skin (closest point on the triangles + ray parity for the sign), geodesic distances
over vessel trees and the smooth rigid snap used at the HRA-to-Z-Anatomy junctions. numpy + scipy only.
"""
import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import dijkstra, connected_components
from scipy.spatial import cKDTree


def unit(a):
    a = np.asarray(a, float)
    return a / np.maximum(np.linalg.norm(a, axis=-1, keepdims=True), 1e-20)


def smoothstep(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def rotvec_matrix(r):
    """Rodrigues: rotation vector (axis * angle) -> 3x3 matrix."""
    r = np.asarray(r, float); th = np.linalg.norm(r)
    if th < 1e-12: return np.eye(3)
    k = r / th; K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * K @ K


def rotvec_between(a, b):
    """Rotation vector turning direction a onto direction b (smallest rotation)."""
    a = unit(a); b = unit(b)
    ax = np.cross(a, b); s = np.linalg.norm(ax); c = float(np.clip(a @ b, -1, 1))
    if s < 1e-12:
        if c > 0: return np.zeros(3)
        p = np.cross(a, [1, 0, 0]);
        if np.linalg.norm(p) < 1e-6: p = np.cross(a, [0, 1, 0])
        return unit(p) * np.pi
    return ax / s * np.arctan2(s, c)


def angle_deg(a, b):
    return float(np.degrees(np.arccos(np.clip(unit(a) @ unit(b), -1, 1))))


# ------------------------------------------------------------------------------------------------ mesh graph
def edge_list(f):
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    return np.unique(np.sort(e, axis=1), axis=0)


def graph(v, f, extra=None):
    """Sparse symmetric graph of mesh edges weighted by length; `extra` adds (i, j) pairs (e.g. contacts)."""
    e = edge_list(f)
    if extra is not None and len(extra): e = np.concatenate([e, np.asarray(extra, np.int64)])
    w = np.linalg.norm(v[e[:, 0]] - v[e[:, 1]], axis=1) + 1e-9
    n = len(v)
    G = sparse.coo_matrix((np.concatenate([w, w]), (np.concatenate([e[:, 0], e[:, 1]]), np.concatenate([e[:, 1], e[:, 0]]))), shape=(n, n)).tocsr()
    return G


def geodesic(G, sources, limit=np.inf):
    """Shortest path length from the nearest of `sources` (vertex indices) to every vertex (inf beyond `limit`)."""
    d = dijkstra(G, directed=False, indices=np.atleast_1d(sources), min_only=True, limit=limit)
    return d


def boundary_loops(f):
    """Ordered boundary loops (vertex index arrays) of a triangle mesh."""
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    k = np.sort(e, 1)
    _, inv, cnt = np.unique(k, axis=0, return_inverse=True, return_counts=True)
    b = e[cnt[inv.ravel()] == 1]
    if not len(b): return []
    nxt = {}
    for a, c in b.tolist(): nxt.setdefault(a, []).append(c)
    used = set(); loops = []
    for a, c in b.tolist():
        if (a, c) in used: continue
        loop = [a]; used.add((a, c)); cur = c
        while cur != a:
            loop.append(cur)
            cand = [x for x in nxt.get(cur, []) if (cur, x) not in used]
            if not cand: break
            used.add((cur, cand[0])); cur = cand[0]
        loops.append(np.array(loop))
    return loops


def ring_frame(p):
    """Centre, unit normal (least-squares plane) and mean radius of a ring of points."""
    c = p.mean(0)
    _, _, Vt = np.linalg.svd(p - c)
    return c, Vt[2], float(np.linalg.norm(p - c, axis=1).mean())


# ------------------------------------------------------------------------------------------------ centerlines
def centerline(v, f, start, h=0.0015, smooth=2):
    """Centerline of a tube by geodesic level sets from `start` (vertex indices, e.g. the end ring).
    Returns dict(p=(k, 3) points, r=(k,) mean radii, s=(k,) arc length, t=(k, 3) unit tangents, gd=(n,) vertex geodesic
    distance from the start, bin=(n,) level index of each vertex). Vertices not reachable get bin -1."""
    G = graph(v, f)
    gd = geodesic(G, start)
    ok = np.isfinite(gd)
    b = np.full(len(v), -1); b[ok] = (gd[ok] / h).astype(int)
    nb = b.max() + 1
    P = np.zeros((nb, 3)); cnt = np.bincount(b[ok], minlength=nb).astype(float)
    for a in range(3): P[:, a] = np.bincount(b[ok], weights=v[ok, a], minlength=nb)
    keep = cnt > 0
    P = P[keep] / cnt[keep, None]
    idx = np.flatnonzero(keep)
    for _ in range(smooth):
        if len(P) > 2: P[1:-1] = 0.25 * P[:-2] + 0.5 * P[1:-1] + 0.25 * P[2:]
    remap = -np.ones(nb, int); remap[idx] = np.arange(len(idx))
    vb = np.where(b >= 0, remap[np.maximum(b, 0)], -1)
    R = np.zeros(len(P))
    for k in range(len(P)):
        m = vb == k
        if m.any(): R[k] = np.linalg.norm(v[m] - P[k], axis=1).mean()
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    T = np.gradient(P, axis=0) if len(P) > 1 else np.array([[0, 1, 0.]])
    return dict(p=P, r=R, s=s, t=unit(T), gd=gd, bin=vb)


def polyline_tangent(P, i, span=3):
    a = P[max(i - span, 0)]; b = P[min(i + span, len(P) - 1)]
    return unit(b - a)


def nearest_on_polyline(P, x):
    """(index of the polyline vertex nearest to x, distance)."""
    d = np.linalg.norm(P - x, axis=1); i = int(np.argmin(d)); return i, float(d[i])


# ------------------------------------------------------------------------------------------------ plane cut
def plane_cut(v, f, p, n, keep_near=None):
    """Cut a mesh by the plane through p with normal n and keep the part on the +n side. Triangles crossing the plane
    are split so the cut is a clean ring. If keep_near (a point) is given, only the connected piece nearest to it is
    kept. Returns (v2, f2, ring) where ring indexes the new vertices on the plane."""
    n = unit(n)
    s = (v - p) @ n
    inside = s >= 0
    fi = inside[f]; cnt = fi.sum(1)
    keepf = f[cnt == 3]
    cross = f[(cnt == 1) | (cnt == 2)]
    newv = []; key = {}
    base = len(v)

    def cut_point(a, b):
        k = (a, b) if a < b else (b, a)
        if k not in key:
            t = s[a] / (s[a] - s[b])
            key[k] = base + len(newv); newv.append(v[a] + t * (v[b] - v[a]))
        return key[k]

    tris = [keepf]
    out = []
    for tri in cross.tolist():
        ins = [inside[x] for x in tri]
        # rotate so the pattern starts consistently, keeping orientation
        for r in range(3):
            a, b, c = tri[r], tri[(r + 1) % 3], tri[(r + 2) % 3]
            ia, ib, ic = inside[a], inside[b], inside[c]
            if sum(ins) == 1 and ia:
                ab = cut_point(a, b); ac = cut_point(a, c)
                out.append([a, ab, ac]); break
            if sum(ins) == 2 and ia and ib:
                bc = cut_point(b, c); ac = cut_point(a, c)
                out.append([a, b, bc]); out.append([a, bc, ac]); break
    if out: tris.append(np.array(out, np.int64))
    F = np.concatenate(tris) if tris else np.zeros((0, 3), np.int64)
    V = np.concatenate([v, np.array(newv).reshape(-1, 3)])
    ring_new = np.arange(base, base + len(newv))
    used = np.unique(F)
    remap = -np.ones(len(V), np.int64); remap[used] = np.arange(len(used))
    V2 = V[used]; F2 = remap[F]; ring = remap[ring_new]; ring = ring[ring >= 0]
    if keep_near is not None and len(F2):
        comps = mesh_components(len(V2), F2)
        if comps.max() > 0:
            j = int(np.argmin(np.linalg.norm(V2 - keep_near, axis=1)))
            mf = comps[F2[:, 0]] == comps[j]
            F3 = F2[mf]; used = np.unique(F3)
            remap = -np.ones(len(V2), np.int64); remap[used] = np.arange(len(used))
            ring = remap[ring]; ring = ring[ring >= 0]
            V2, F2 = V2[used], remap[F3]
    return V2, F2, ring


def mesh_components(n, f):
    """Component label per vertex (by shared edges)."""
    e = edge_list(f)
    A = sparse.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n))
    _, lab = connected_components(A, directed=False)
    return lab


# ------------------------------------------------------------------------------------------------ exact signed distance
class TriSet:
    """Exact closest-point distance to a triangle mesh plus the inside test by ray parity (rays along +z, -z and +x;
    majority vote, so small holes in a mesh do not flip the sign)."""

    def __init__(self, v, f, cell=0.002):
        self.v = np.asarray(v, float); self.f = np.asarray(f, np.int64)
        A, B, C = self.v[self.f[:, 0]], self.v[self.f[:, 1]], self.v[self.f[:, 2]]
        self.A, self.B, self.C = A, B, C
        self.tree = cKDTree((A + B + C) / 3)
        self.lo = self.v.min(0); self.hi = self.v.max(0)
        self.maxedge = float(np.max([np.linalg.norm(A - B, axis=1).max(), np.linalg.norm(B - C, axis=1).max(), np.linalg.norm(C - A, axis=1).max()]))
        self.cell = cell
        self.bins = {ax: self._bin(ax) for ax in (2, 0)}

    def _bin(self, ax):
        """Triangles binned by their bounding box in the plane perpendicular to axis ax: (sorted cell keys, start
        offsets, triangle ids)."""
        u, w = [a for a in range(3) if a != ax]
        T = np.stack([self.A, self.B, self.C], 1)
        lo = T[:, :, [u, w]].min(1); hi = T[:, :, [u, w]].max(1)
        i0 = np.floor((lo - self.lo[[u, w]]) / self.cell).astype(np.int64); i1 = np.floor((hi - self.lo[[u, w]]) / self.cell).astype(np.int64)
        nu = i1[:, 0] - i0[:, 0] + 1; nw = i1[:, 1] - i0[:, 1] + 1; cnt = nu * nw
        tid = np.repeat(np.arange(len(T)), cnt)
        k = np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt)
        a = np.repeat(i0[:, 0], cnt) + k // np.repeat(nw, cnt); b = np.repeat(i0[:, 1], cnt) + k % np.repeat(nw, cnt)
        key = a * 1000003 + b
        o = np.argsort(key, kind='stable'); key, tid = key[o], tid[o]
        uk, st = np.unique(key, return_index=True)
        return uk, np.append(st, len(key)), tid

    def _parity(self, p, ax, sgn):
        """Odd number of crossings of the ray from each point along sgn * axis ax."""
        u, w = [a for a in range(3) if a != ax]
        uk, st, tid = self.bins[ax]
        out = np.zeros(len(p), bool)
        cu = np.floor((p[:, u] - self.lo[u]) / self.cell).astype(np.int64); cw = np.floor((p[:, w] - self.lo[w]) / self.cell).astype(np.int64)
        key = cu * 1000003 + cw
        pos = np.searchsorted(uk, key); pos = np.minimum(pos, len(uk) - 1)
        has = uk[pos] == key
        if not has.any(): return out
        order = np.argsort(key[has], kind='stable'); pts = np.flatnonzero(has)[order]
        ks = key[pts]; brk = np.flatnonzero(np.diff(ks)) + 1
        for grp in np.split(pts, brk):
            c = pos[grp[0]]; t = tid[st[c]:st[c + 1]]
            a, b, cc = self.A[t], self.B[t], self.C[t]
            x = p[grp, u][:, None]; y = p[grp, w][:, None]
            d = (b[:, w] - cc[:, w]) * (a[:, u] - cc[:, u]) + (cc[:, u] - b[:, u]) * (a[:, w] - cc[:, w])
            ok = np.abs(d) > 1e-18; d = np.where(ok, d, 1)
            l1 = ((b[:, w] - cc[:, w]) * (x - cc[:, u]) + (cc[:, u] - b[:, u]) * (y - cc[:, w])) / d
            l2 = ((cc[:, w] - a[:, w]) * (x - cc[:, u]) + (a[:, u] - cc[:, u]) * (y - cc[:, w])) / d
            l3 = 1 - l1 - l2
            hit = ok & (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
            z = l1 * a[:, ax] + l2 * b[:, ax] + l3 * cc[:, ax]
            ahead = hit & (sgn * (z - p[grp, ax][:, None]) > 0)
            # crossings through a shared edge or vertex are counted once: unique z per point
            for r in np.flatnonzero(ahead.any(1)):
                zz = np.unique(np.round(z[r, ahead[r]], 9)); out[grp[r]] = len(zz) % 2 == 1
        return out

    def closest(self, p, k=10, with_tri=False):
        from lib.mesh import _closest_point_triangle
        p = np.atleast_2d(np.asarray(p, float))
        kk = min(k, len(self.f))
        _, cand = self.tree.query(p, k=kk)
        if cand.ndim == 1: cand = cand[:, None]
        best = np.full(len(p), np.inf); bq = np.zeros_like(p); bt = np.zeros(len(p), np.int64)
        for j in range(cand.shape[1]):
            t = cand[:, j]
            q = _closest_point_triangle(p, self.A[t], self.B[t], self.C[t])
            d = np.linalg.norm(q - p, axis=1); m = d < best; best[m] = d[m]; bq[m] = q[m]; bt[m] = t[m]
        return (bq, best, bt) if with_tri else (bq, best)

    def inside(self, p):
        p = np.atleast_2d(np.asarray(p, float))
        inb = np.all((p >= self.lo) & (p <= self.hi), axis=1)
        res = np.zeros(len(p), bool)
        if inb.any():
            q = p[inb]
            votes = self._parity(q, 2, 1).astype(int) + self._parity(q, 2, -1).astype(int) + self._parity(q, 0, 1).astype(int)
            res[inb] = votes >= 2
        return res

    def signed(self, p, band=0.004):
        """(signed distance (negative inside), closest points) for points; points farther than `band` from the bounding
        box get +inf without any work."""
        p = np.atleast_2d(np.asarray(p, float))
        sd = np.full(len(p), np.inf); q = np.zeros_like(p)
        near = np.all((p >= self.lo - band) & (p <= self.hi + band), axis=1)
        if near.any():
            qq, d = self.closest(p[near])
            ins = self.inside(p[near])
            sd[near] = np.where(ins, -d, d); q[near] = qq
        return sd, q


class Obstacles:
    """A set of closed meshes (bones, ...) with names: signed distance to the nearest one and the push direction."""

    def __init__(self, meshes, band=0.004):
        self.names = [n for n, _ in meshes]
        self.sets = [TriSet(v, f) for _, (v, f) in meshes]
        self.band = band

    def query(self, p, band=None):
        """-> (sd (n,), outward unit direction (n, 3), index of the nearest obstacle (n,), -1 if none within band)."""
        band = self.band if band is None else band
        p = np.atleast_2d(np.asarray(p, float))
        sd = np.full(len(p), np.inf); dirn = np.zeros_like(p); who = -np.ones(len(p), int)
        for k, T in enumerate(self.sets):
            m = np.all((p >= T.lo - band) & (p <= T.hi + band), axis=1)
            if not m.any(): continue
            s, q = T.signed(p[m], band)
            idx = np.flatnonzero(m)
            better = s < sd[idx]
            if not better.any(): continue
            ii = idx[better]
            sd[ii] = s[better]; who[ii] = k
            g = unit(p[ii] - q[better])
            dirn[ii] = np.where((s[better] < 0)[:, None], -g, g)
        return sd, dirn, who


# ------------------------------------------------------------------------------------------------ smooth fields on vessel trees
def kernel_field(x, src_idx, vec, sigma, tree=None, groups=None):
    """Smooth displacement from sparse vectors: field(i) = A(i) * sum_j K_ij vec_j / sum_j K_ij over the sources j
    (K Gaussian of the distance, sigma), with A(i) = max_j K_ij so the field is the full push at a source and fades
    smoothly away from it. `groups` (int label per point) restricts the influence to the same group."""
    out = np.zeros_like(x)
    if not len(src_idx): return out
    S = x[src_idx]
    st = cKDTree(S)
    nb = st.query_ball_point(x, 3 * sigma)
    for i, js in enumerate(nb):
        if not js: continue
        js = np.asarray(js)
        if groups is not None:
            js = js[groups[src_idx[js]] == groups[i]]
            if not len(js): continue
        d = np.linalg.norm(S[js] - x[i], axis=1)
        K = np.exp(-0.5 * (d / sigma) ** 2)
        out[i] = K.max() * (K @ vec[js]) / K.sum()
    return out


# ------------------------------------------------------------------------------------------------ open ends of HRA stubs
def _cap_frame(v, G, tip, outward_hint=None):
    """Frame of a capped tube end at vertex `tip`: the ring of vertices about one radius back from the tip."""
    gd = geodesic(G, [tip], limit=0.03)
    ring = (gd >= 0.004) & (gd <= 0.006)
    if ring.sum() < 4: ring = np.isfinite(gd) & (gd >= np.nanmax(gd[np.isfinite(gd)]) * 0.5)
    c, n, r = ring_frame(v[ring])
    for _ in range(2):
        lo = max(r * 0.9, 0.0015)
        ring2 = (gd >= lo) & (gd <= lo + 0.002)
        if ring2.sum() < 4: break
        c, n, r = ring_frame(v[ring2])
    if n @ (v[tip] - c) < 0: n = -n
    return dict(c=c, n=n, r=r, kind='capped', tip=v[tip])


def stub_ends(v, f, min_r=0.0012):
    """Candidate ends of an HRA vessel mesh: every boundary loop of at least min_r radius (open ends, normal pointing out
    of the vessel) and every capped end (geodesic extremes away from the loops)."""
    G = graph(v, f)
    out = []
    loops = [l for l in boundary_loops(f) if len(l) >= 6]
    for l in loops:
        c, n, r = ring_frame(v[l])
        if r < min_r: continue
        # outward: away from the vessel's own nearby surface
        near = np.linalg.norm(v - c, axis=1) < 3 * r + 0.004
        if n @ (c - v[near].mean(0)) < 0: n = -n
        out.append(dict(c=c, n=n, r=r, kind='open', loop=l))
    if loops:
        src = np.concatenate(loops)
        gd = geodesic(G, src)
    else:
        gd0 = geodesic(G, [0]); a = int(np.argmax(np.where(np.isfinite(gd0), gd0, -1)))
        out.append(_cap_frame(v, G, a))
        gd = geodesic(G, [a])
    fin = np.isfinite(gd)
    if fin.any():
        tip = int(np.argmax(np.where(fin, gd, -1)))
        if gd[tip] > 0.008:
            out.append(_cap_frame(v, G, tip))
    return out


def pick_end(ends, near):
    """The end nearest to a point."""
    d = [np.linalg.norm(e['c'] - near) for e in ends]
    return ends[int(np.argmin(d))]


class SkinField:
    """Signed distance to the skin (negative inside): exact closest-point distance to the skin triangles, with the
    sign from the cached coarse skin SDF (fit.common.skin_solid) away from the surface and from the closest triangle's
    outward normal within 4 mm of it."""

    def __init__(self, v, f, solid):
        from lib.mesh import orient_outward, signed_volume
        f = np.asarray(f, np.int64)
        if signed_volume(v, f) < 0: f = f[:, ::-1]
        self.v, self.f, self.solid = np.asarray(v, float), f, solid
        self.A, self.B, self.C = self.v[f[:, 0]], self.v[f[:, 1]], self.v[f[:, 2]]
        self.N = unit(np.cross(self.B - self.A, self.C - self.A))
        self.tree = cKDTree((self.A + self.B + self.C) / 3)

    def __call__(self, p, k=12):
        from lib.mesh import _closest_point_triangle
        p = np.atleast_2d(np.asarray(p, float))
        _, cand = self.tree.query(p, k=k)
        best = np.full(len(p), np.inf); bq = np.zeros_like(p); bt = np.zeros(len(p), int)
        for j in range(cand.shape[1]):
            t = cand[:, j]
            q = _closest_point_triangle(p, self.A[t], self.B[t], self.C[t])
            d = np.linalg.norm(q - p, axis=1); m = d < best; best[m] = d[m]; bq[m] = q[m]; bt[m] = t[m]
        coarse = self.solid(p)
        sgn_n = np.sign(np.einsum('ij,ij->i', p - bq, self.N[bt])); sgn_n[sgn_n == 0] = 1
        sgn = np.where(np.abs(coarse) > 0.004, np.sign(coarse), sgn_n)
        sd = sgn * best
        g = unit(p - bq) * sgn[:, None]          # outward direction
        return sd, g


def tip_frame(v, hint, near=None, reach=0.04):
    """Frame of the end of a vessel mesh facing `hint`: the extreme vertex along hint (within `reach` of `near` if
    given), the local axis from the centroids of two slabs behind it, the outer radius (75th percentile of the slab's
    distances to the axis: HRA vessels are often double-walled) and the centre on the axis one radius back from the tip."""
    hint = unit(hint)
    cand = np.arange(len(v)) if near is None else np.flatnonzero(np.linalg.norm(v - near, axis=1) < reach)
    if not len(cand): cand = np.arange(len(v))
    tip = v[cand[np.argmax(v[cand] @ hint)]]
    loc = v[np.linalg.norm(v - tip, axis=1) < 0.02]
    a = pca_axis(loc); a = a if a @ hint > 0 else -a
    for _ in range(3):
        h = (v - tip) @ a
        rad = np.linalg.norm((v - tip) - np.outer(h, a), axis=1)
        s1 = (h > -0.012) & (h < -0.003) & (rad < 0.015)
        s2 = (h > -0.022) & (h < -0.012) & (rad < 0.015)
        if s1.sum() < 6: break
        c1 = v[s1].mean(0)
        if s2.sum() >= 6:
            a2 = unit(c1 - v[s2].mean(0))
            if a2 @ a > 0.5: a = a2
    h = (v - tip) @ a
    s1 = (h > -0.012) & (h < -0.003)
    c1 = v[s1].mean(0) if s1.sum() else tip
    d = v[s1] - c1; r = float(np.quantile(np.linalg.norm(d - np.outer(d @ a, a), axis=1), 0.75)) if s1.sum() else 0.002
    depth = (tip - c1) @ a
    c = c1 + a * (depth - r)
    return dict(c=c, n=a, r=r, kind='tip', tip=tip)


def pca_axis(p):
    c = p.mean(0); w, V = np.linalg.eigh(np.cov((p - c).T)); return V[:, -1]


def merge_loops(ends, tol=0.002):
    """Drop open ends that duplicate a larger one at the same place (inner and outer walls of a double-walled vessel)."""
    ends = sorted(ends, key=lambda e: -e['r'])
    out = []
    for e in ends:
        if any(np.linalg.norm(e['c'] - o['c']) < max(tol, 0.5 * o['r']) for o in out): continue
        out.append(e)
    return out


# ------------------------------------------------------------------------------------------------ plane sections
def slice_loops(v, f, p, n):
    """Closed section polygons of a mesh with the plane (p, n): list of (k, 3) point arrays."""
    n = unit(n)
    s = (v - p) @ n
    sg = s >= 0
    cr = sg[f].sum(1); f = f[(cr == 1) | (cr == 2)]
    if not len(f): return []
    segs = []; ekey = []
    for a, b in ((0, 1), (1, 2), (2, 0)):
        ia, ib = f[:, a], f[:, b]
        m = sg[ia] != sg[ib]
        t = np.where(m, s[ia] / np.where(m, s[ia] - s[ib], 1), 0)
        pt = v[ia] + t[:, None] * (v[ib] - v[ia])
        segs.append((m, pt, np.minimum(ia, ib) * 10000019 + np.maximum(ia, ib)))
    # each crossing triangle gives one segment between its two crossed edges (keyed by the edge)
    A, B = [], []
    for i in range(len(f)):
        e = [(segs[k][2][i], segs[k][1][i]) for k in range(3) if segs[k][0][i]]
        if len(e) == 2: A.append(e[0]); B.append(e[1])
    adj = {}; pos = {}
    for (ka, pa), (kb, pb) in zip(A, B):
        adj.setdefault(ka, []).append(kb); adj.setdefault(kb, []).append(ka); pos[ka] = pa; pos[kb] = pb
    seen = set(); loops = []
    for k0 in adj:
        if k0 in seen: continue
        loop = [k0]; seen.add(k0); prev, cur = None, k0
        while True:
            nx = [x for x in adj[cur] if x != prev and x not in seen]
            if not nx: break
            prev, cur = cur, nx[0]; seen.add(cur); loop.append(cur)
        if len(loop) >= 3: loops.append(np.array([pos[k] for k in loop]))
    return loops


def polygon_area_centroid(P, n):
    """Area and centroid of a planar polygon (points in 3D, plane normal n)."""
    n = unit(n); c0 = P.mean(0)
    u = unit(np.cross(n, [1, 0, 0] if abs(n[0]) < 0.9 else [0, 1, 0])); w = np.cross(n, u)
    x = (P - c0) @ u; y = (P - c0) @ w
    x1, y1 = np.roll(x, -1), np.roll(y, -1)
    cr = x * y1 - x1 * y
    a = cr.sum() / 2
    if abs(a) < 1e-12: return 0.0, c0
    cx = ((x + x1) * cr).sum() / (6 * a); cy = ((y + y1) * cr).sum() / (6 * a)
    return abs(a), c0 + cx * u + cy * w


def section_frame(v, f, hint, near=None, reach=0.05, depths=np.arange(0.002, 0.0241, 0.002)):
    """End frame of a vessel from plane sections: the extreme vertex along the current axis (started at `hint`; near
    `near` if given), sections perpendicular to the axis every 2 mm down to 24 mm behind it, in each the largest polygon
    (the outer wall of a double-walled vessel, the whole mouth of a collapsed vein). The reference area is the median of
    the sections 10-24 mm deep; sections with less than half of it are the tapering tip of a capped end and are skipped.
    The axis is refitted through the valid section centroids. Returns dict(c=centroid of the shallowest valid section,
    n=outward axis, r=radius of a circle of the reference area, kind='section', tip, centres)."""
    hint = unit(hint)
    cand = np.arange(len(v)) if near is None else np.flatnonzero(np.linalg.norm(v - near, axis=1) < reach)
    if not len(cand): cand = np.arange(len(v))
    a = hint; C = None
    for it in range(4):
        tip = v[cand[np.argmax(v[cand] @ a)]]
        D, Cn, An = [], [], []
        for d in depths:
            Ls = slice_loops(v, f, tip - d * a, a)
            if not Ls: continue
            AC = [polygon_area_centroid(L, a) for L in Ls]
            AC = [x for x in AC if np.linalg.norm(x[1] - tip) < 0.04] or AC
            k = int(np.argmax([x[0] for x in AC]))
            if AC[k][0] <= 0: continue
            D.append(d); Cn.append(AC[k][1]); An.append(AC[k][0])
        if len(Cn) < 3: break
        D, Cn, An = np.array(D), np.array(Cn), np.array(An)
        deep = D >= 0.010
        Aref = float(np.median(An[deep])) if deep.sum() >= 2 else float(np.median(An))
        ok = An >= 0.5 * Aref
        if ok.sum() < 3: ok = np.ones(len(An), bool)
        C, A_, Dv = Cn[ok], An[ok], D[ok]
        a2 = pca_axis(C); a2 = a2 if a2 @ a > 0 else -a2
        if a2 @ hint < 0.3 or a2 @ a > 0.9995: break
        a = a2
    if C is None or not len(C):
        tip = v[cand[np.argmax(v[cand] @ hint)]]
        return dict(c=tip, n=hint, r=0.002, kind='section', tip=tip, centres=[])
    k = int(np.argmin(Dv))
    return dict(c=C[k], n=a, r=float(np.sqrt(Aref / np.pi)), kind='section', tip=tip, centres=C, area_mm2=round(Aref * 1e6, 1))


def march(v, f, p0, a0, step=0.002, length=0.06, r0=0.004):
    """Centerline of a tube by marching plane sections from a point p0 at one end along a0 (pointing into the tube):
    at each step the section through the next point perpendicular to the running axis, whose largest polygon near the
    axis (the outer wall of a double-walled HRA vessel) gives the next centre; the axis follows the last centres.
    Returns dict(p=(k, 3) centres, a=(k,) section areas (m2), s=(k,) arc length from p0)."""
    a = unit(a0); P = [np.asarray(p0, float)]; A = [0.0]; r = r0
    for _ in range(int(length / step)):
        q = P[-1] + step * a
        best = None
        for L in slice_loops(v, f, q, a):
            ar, c = polygon_area_centroid(L, a)
            if ar <= 0 or np.linalg.norm(c - q) > max(2.0 * r, 0.004): continue
            if best is None or ar > best[0]: best = (ar, c)
        if best is None: break
        P.append(best[1]); A.append(best[0]); r = 0.7 * r + 0.3 * np.sqrt(best[0] / np.pi)
        if len(P) >= 4: a = unit(0.5 * a + 0.5 * unit(P[-1] - P[-4]))
    P = np.array(P); A = np.array(A)
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    return dict(p=P, a=A, s=s)


def march_frame(v, f, p0, a0, length=0.05, near=0.006, span=0.012):
    """End frame of a tube from a marched centerline (see march) started at p0 going in along a0: the end centre is the
    first section of at least half the reference area (median of the sections 6-20 mm in: the tapering tip of a capped
    end is skipped), the outward axis is fitted through the centres over `span` from there."""
    m = march(v, f, p0, a0, length=length)
    P, A, s = m['p'], m['a'], m['s']
    if len(P) < 4: return None, m
    ref = A[(s >= near) & (s <= 0.020)]
    Aref = float(np.median(ref)) if len(ref) else float(np.median(A[1:]))
    ok = np.flatnonzero((A >= 0.5 * Aref) & (np.arange(len(A)) > 0))
    k = int(ok[0]) if len(ok) else 1
    w = (s >= s[k]) & (s <= s[k] + span)
    Q = P[w] if w.sum() >= 3 else P[k:k + 4]
    ax = pca_axis(Q) if len(Q) >= 2 else unit(a0)
    if ax @ unit(a0) > 0: ax = -ax                      # outward
    return dict(c=P[k], n=ax, r=float(np.sqrt(Aref / np.pi)), area_mm2=round(Aref * 1e6, 1), depth_mm=round(float(s[k]) * 1000, 1)), m


def trunk_centerline(v, f, a, b, h=0.0015, smooth=2):
    """Centerline of the main tube of a vessel mesh between its end rings a and b (vertex index arrays), from a.
    Vertices of the main tube: those whose geodesic distances to both rings add up to within max(4 radii, 10 % of the
    length, 3 edges) of the shortest such sum (side branches and their caps are left out). The centerline is a kernel
    regression of their positions on their geodesic distance from a (Gaussian, bandwidth 1.2 median edge lengths, at
    least 2 mm), sampled every h: Z-Anatomy vessel meshes are coarse (the abdominal aorta has 425 vertices over
    23 cm), so plain level-set bins hold a vertex or two and zig-zag. Returns dict(p, s, t, gd)."""
    G_ = graph(v, f)
    ga = geodesic(G_, a); gb = geodesic(G_, b)
    tot = ga + gb
    ok = np.isfinite(tot)
    el = np.linalg.norm(v[edge_list(f)[:, 0]] - v[edge_list(f)[:, 1]], axis=1)
    e = float(np.median(el)) if len(el) else 0.002
    if not ok.any(): return centerline(v, f, a, h=h, smooth=smooth)
    L = float(tot[ok].min())
    r = 0.5 * (ring_frame(v[a])[2] + ring_frame(v[b])[2])
    m = ok & (tot <= L + max(4 * r, 0.1 * L, 3 * e))
    sig = max(1.2 * e, 0.002)
    g = ga[m]; X = v[m]
    grid = np.arange(0.0, g.max() + 1e-9, h)
    W = np.exp(-0.5 * ((g[None, :] - grid[:, None]) / sig) ** 2)
    sw = W.sum(1)
    good = sw > 1e-6
    P = (W[good] @ X) / sw[good, None]
    for _ in range(smooth):
        if len(P) > 2: P[1:-1] = 0.25 * P[:-2] + 0.5 * P[1:-1] + 0.25 * P[2:]
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s_ = np.concatenate([[0], np.cumsum(seg)])
    T = np.gradient(P, axis=0) if len(P) > 1 else np.array([[0, 1, 0.]])
    return dict(p=P, r=np.zeros(len(P)), s=s_, t=unit(T), gd=ga, bin=None)


def refine(v, f, max_edge=0.003, iters=8):
    """Conforming refinement of a triangle mesh until no edge is longer than max_edge: every triangle marks its
    longest edge if it is too long, marked edges get their midpoint, and each triangle is split by its 1, 2 or 3
    marked edges (2, 3 or 4 triangles, winding kept). New vertices lie on the old facets, so the shape is unchanged; a
    smooth deformation applied afterwards is sampled finely (Z-Anatomy vessels have edges up to 2 cm)."""
    v = np.asarray(v, float); f = np.asarray(f, np.int64)
    for _ in range(iters):
        E = np.stack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]], 1)          # (m, 3, 2): edge k joins corner k, k+1
        L = np.linalg.norm(v[E[:, :, 0]] - v[E[:, :, 1]], axis=2)
        k = np.argmax(L, 1); long = L[np.arange(len(f)), k] > max_edge
        if not long.any(): break
        key = np.sort(E, 2); kk = key[:, :, 0] * (len(v) + 1) + key[:, :, 1]
        marked_keys = np.unique(kk[np.arange(len(f)), k][long])
        mk = np.isin(kk, marked_keys)                                        # (m, 3) marked edges per triangle
        uk, inv = np.unique(kk[mk], return_inverse=True)
        a = (uk // (len(v) + 1)).astype(np.int64); b = (uk % (len(v) + 1)).astype(np.int64)
        mid = np.full(kk.shape, -1, np.int64); mid[mk] = len(v) + inv
        v = np.concatenate([v, 0.5 * (v[a] + v[b])])
        out = [f[mk.sum(1) == 0]]
        for r in range(3):
            # one marked edge, at position r
            m1 = (mk.sum(1) == 1) & mk[:, r]
            if m1.any():
                t = f[m1]; c0, c1, c2 = t[:, r], t[:, (r + 1) % 3], t[:, (r + 2) % 3]; mm = mid[m1, r]
                out += [np.stack([c0, mm, c2], 1), np.stack([mm, c1, c2], 1)]
            # two marked edges: the unmarked one at position r (edges r+1 and r+2 marked)
            m2 = (mk.sum(1) == 2) & ~mk[:, r]
            if m2.any():
                t = f[m2]; c0, c1, c2 = t[:, r], t[:, (r + 1) % 3], t[:, (r + 2) % 3]
                m_12, m_20 = mid[m2, (r + 1) % 3], mid[m2, (r + 2) % 3]
                out += [np.stack([m_12, c2, m_20], 1), np.stack([c0, c1, m_12], 1), np.stack([c0, m_12, m_20], 1)]
        m3 = mk.sum(1) == 3
        if m3.any():
            t = f[m3]; m01, m12, m20 = mid[m3, 0], mid[m3, 1], mid[m3, 2]
            out += [np.stack([t[:, 0], m01, m20], 1), np.stack([m01, t[:, 1], m12], 1), np.stack([m20, m12, t[:, 2]], 1), np.stack([m01, m12, m20], 1)]
        f = np.concatenate(out)
    return v, f
