"""Mesh I/O and geometry helpers shared by the anatomy build steps (numpy + scipy only).

Meshes are (V, F): V float64 (n, 3) metres, F int64 (m, 3). Raw sources live in tools/anatomy/.cache/raw/<source>/
as written by extract.mjs; intermediate meshes are saved as .npz with arrays v and f.
"""
import json, os, re
import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(HERE, '.cache')
RAW = os.path.join(CACHE, 'raw')


# ---------------------------------------------------------------- loading
class Source:
    """One extracted source (e.g. 'hra-male', 'za-skeletal'): an index of named meshes."""

    def __init__(self, sid):
        self.sid = sid
        self.dir = os.path.join(RAW, sid)
        self.index = json.load(open(os.path.join(self.dir, 'index.json')))
        self.by_name = {}
        for o in self.index: self.by_name.setdefault(o['name'], []).append(o)

    def names(self):
        return [o['name'] for o in self.index]

    def load_entry(self, o):
        v = np.fromfile(os.path.join(self.dir, f"{o['i']}.pos"), dtype=np.float32).reshape(-1, 3).astype(np.float64)
        f = np.fromfile(os.path.join(self.dir, f"{o['i']}.idx"), dtype=np.uint32).reshape(-1, 3).astype(np.int64)
        return v, f

    def get(self, name):
        """Mesh by exact name (several entries with the same name are merged)."""
        if name not in self.by_name: raise KeyError(f'{self.sid}: no mesh named {name!r}')
        return merge([self.load_entry(o) for o in self.by_name[name]])

    def select(self, pattern, path=False, exclude=None):
        """Entries whose name (or full node path) matches the regex."""
        rx = re.compile(pattern); ex = re.compile(exclude) if exclude else None
        out = []
        for o in self.index:
            s = o['path'] if path else o['name']
            if rx.search(s) and not (ex and ex.search(s)): out.append(o)
        return out

    def load(self, entries):
        return merge([self.load_entry(o) for o in entries])


_SOURCES = {}
def source(sid):
    if sid not in _SOURCES: _SOURCES[sid] = Source(sid)
    return _SOURCES[sid]


def save(path, v, f, **extra):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    np.savez(path, v=np.asarray(v, np.float32), f=np.asarray(f, np.int32), **extra)


def load(path):
    d = np.load(path)
    return d['v'].astype(np.float64), d['f'].astype(np.int64)


# ---------------------------------------------------------------- basic geometry
def merge(meshes):
    meshes = [(v, f) for v, f in meshes if len(f)]
    if not meshes: return np.zeros((0, 3)), np.zeros((0, 3), np.int64)
    V, F, off = [], [], 0
    for v, f in meshes:
        V.append(v); F.append(f + off); off += len(v)
    return np.concatenate(V), np.concatenate(F)


def compact(v, f):
    """Drop unreferenced vertices."""
    used = np.unique(f)
    remap = -np.ones(len(v), np.int64); remap[used] = np.arange(len(used))
    return v[used], remap[f]


def face_normals(v, f, unit=True):
    n = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    if unit: n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-20)
    return n


def area(v, f):
    return 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1).sum()


def signed_volume(v, f):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    return np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6.0


def components(v, f):
    """Connected components by shared vertices: list of face-index arrays."""
    n = len(v)
    if not len(f): return []
    rows = np.repeat(np.arange(len(f)), 3); cols = f.ravel()
    A = sparse.coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(len(f), n)).tocsr()
    VV = (A.T @ A).tocsr()
    k, lab = connected_components(VV, directed=False)
    flab = lab[f[:, 0]]
    order = np.argsort(flab, kind='stable')
    splits = np.flatnonzero(np.diff(flab[order])) + 1
    return np.split(order, splits)


def orient_outward(v, f):
    """Make each connected component's winding consistent and its normals face outward.
    Closed components: positive signed volume. Open ones: normals point away from the component's centroid on average."""
    f = f.copy()
    if not len(f): return f
    # consistent winding per component by BFS over shared edges
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    fid = np.tile(np.arange(len(f)), 3)
    key = np.sort(e, axis=1)
    order = np.lexsort((key[:, 1], key[:, 0]))
    ks = key[order]; same = np.all(ks[1:] == ks[:-1], axis=1)
    pairs_a = order[:-1][same]; pairs_b = order[1:][same]
    fa, fb = fid[pairs_a], fid[pairs_b]
    # an edge shared with the same direction in both faces means one of them is flipped
    dir_same = np.all(e[pairs_a] == e[pairs_b], axis=1)
    adj = [[] for _ in range(len(f))]
    for a, b, s in zip(fa.tolist(), fb.tolist(), dir_same.tolist()):
        adj[a].append((b, s)); adj[b].append((a, s))
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
        vol = signed_volume(v, sub)
        closed = is_closed(sub)
        if closed:
            if vol < 0: f[comp] = sub[:, ::-1]
        else:
            c = v[np.unique(sub)].mean(0)
            n = face_normals(v, sub, unit=False)
            cent = v[sub].mean(1)
            if np.einsum('ij,ij->i', n, cent - c).sum() < 0: f[comp] = sub[:, ::-1]
    return f


def is_closed(f):
    e = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
    _, cnt = np.unique(e, axis=0, return_counts=True)
    return bool(np.all(cnt == 2))


def sample_surface(v, f, n, seed=0):
    """Area-weighted random points on the surface."""
    rng = np.random.default_rng(seed)
    a = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
    if a.sum() <= 0: return v[f[:, 0]][:n]
    idx = rng.choice(len(f), size=n, p=a / a.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    A, B, C = v[f[idx, 0]], v[f[idx, 1]], v[f[idx, 2]]
    return (1 - s)[:, None] * A + (s * (1 - r2))[:, None] * B + (s * r2)[:, None] * C


def dense_points(v, f, spacing=0.002):
    """Surface samples roughly `spacing` apart (for nearest-surface queries)."""
    n = int(np.clip(area(v, f) / spacing ** 2, 200, 400000))
    return np.concatenate([v, sample_surface(v, f, n)])


class Surface:
    """Nearest-point queries against a mesh surface, approximated by dense samples."""

    def __init__(self, v, f, spacing=0.0015):
        self.pts = dense_points(v, f, spacing)
        self.tree = cKDTree(self.pts)

    def dist(self, p):
        d, _ = self.tree.query(p); return d

    def nearest(self, p):
        d, i = self.tree.query(p); return self.pts[i], d


def pca(points):
    c = points.mean(0)
    w, V = np.linalg.eigh(np.cov((points - c).T))
    return c, V[:, ::-1], np.sqrt(np.maximum(w[::-1], 0))  # centre, axes (columns, largest first), std devs


def bbox(v):
    return v.min(0), v.max(0)


# ---------------------------------------------------------------- inside tests via voxel grids
class Grid:
    """Solid voxelisation of closed (or nearly closed) meshes, for inside tests and signed distances."""

    def __init__(self, lo, hi, h):
        self.lo = np.asarray(lo, float) - 2 * h; self.h = h
        self.n = np.ceil((np.asarray(hi, float) + 2 * h - self.lo) / h).astype(int) + 1
        self.occ = np.zeros(self.n, bool)

    def add(self, v, f):
        """Fill the inside of a mesh by ray parity along z through each (x, y) column."""
        h, lo = self.h, self.lo
        tri = v[f]
        xs = lo[0] + h * np.arange(self.n[0]); ys = lo[1] + h * np.arange(self.n[1])
        tmin, tmax = tri[:, :, :2].min(1), tri[:, :, :2].max(1)
        ix0 = np.clip(np.ceil((tmin[:, 0] - lo[0]) / h).astype(int), 0, self.n[0] - 1)
        ix1 = np.clip(np.floor((tmax[:, 0] - lo[0]) / h).astype(int), 0, self.n[0] - 1)
        iy0 = np.clip(np.ceil((tmin[:, 1] - lo[1]) / h).astype(int), 0, self.n[1] - 1)
        iy1 = np.clip(np.floor((tmax[:, 1] - lo[1]) / h).astype(int), 0, self.n[1] - 1)
        hits = {}
        for t in np.flatnonzero((ix1 >= ix0) & (iy1 >= iy0)):
            A, B, C = tri[t]
            gx = xs[ix0[t]:ix1[t] + 1]; gy = ys[iy0[t]:iy1[t] + 1]
            X, Y = np.meshgrid(gx, gy, indexing='ij')
            d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1])
            if abs(d) < 1e-18: continue
            l1 = ((B[1] - C[1]) * (X - C[0]) + (C[0] - B[0]) * (Y - C[1])) / d
            l2 = ((C[1] - A[1]) * (X - C[0]) + (A[0] - C[0]) * (Y - C[1])) / d
            l3 = 1 - l1 - l2
            m = (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
            if not m.any(): continue
            z = l1 * A[2] + l2 * B[2] + l3 * C[2]
            ii, jj = np.nonzero(m)
            for a, b, zz in zip((ii + ix0[t]).tolist(), (jj + iy0[t]).tolist(), z[m].tolist()):
                hits.setdefault((a, b), []).append(zz)
        zs = lo[2] + h * np.arange(self.n[2])
        for (a, b), zl in hits.items():
            zl = np.sort(np.asarray(zl))
            # collapse near-duplicate hits (shared edges) so parity stays right
            keep = np.concatenate([[True], np.diff(zl) > 1e-9])
            zl = zl[keep]
            if len(zl) % 2: zl = zl[:-1]
            for z0, z1 in zip(zl[0::2], zl[1::2]):
                k0 = int(np.ceil((z0 - lo[2]) / h)); k1 = int(np.floor((z1 - lo[2]) / h))
                if k1 >= k0: self.occ[a, b, max(k0, 0):min(k1, self.n[2] - 1) + 1] = True
        return self

    def index(self, p):
        return np.round((np.asarray(p) - self.lo) / self.h).astype(int)

    def inside(self, p):
        i = self.index(p)
        ok = np.all((i >= 0) & (i < self.n), axis=1)
        out = np.zeros(len(p), bool)
        j = i[ok]; out[ok] = self.occ[j[:, 0], j[:, 1], j[:, 2]]
        return out

    def sdf(self):
        """Signed distance on the grid (negative inside), in metres."""
        from scipy.ndimage import distance_transform_edt
        outside = distance_transform_edt(~self.occ) * self.h
        inside = distance_transform_edt(self.occ) * self.h
        return outside - inside


def grid_for(meshes, h, pad=0.02):
    lo = np.min([v.min(0) for v, _ in meshes], axis=0) - pad
    hi = np.max([v.max(0) for v, _ in meshes], axis=0) + pad
    g = Grid(lo, hi, h)
    for v, f in meshes: g.add(v, f)
    return g


def sample_grid(field, g, p):
    """Trilinear sample of a grid field at points p."""
    from scipy.ndimage import map_coordinates
    q = ((np.asarray(p) - g.lo) / g.h).T
    return map_coordinates(field, q, order=1, mode='nearest')


def grid_gradient(field, g):
    return [np.gradient(field, g.h, axis=a) for a in range(3)]


def laplacian_smooth_field(f, values, iters=10, lam=0.5):
    """Smooth per-vertex vectors over the mesh graph (umbrella operator)."""
    n = len(values)
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    W = sparse.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    deg = np.asarray(W.sum(1)).ravel(); deg[deg == 0] = 1
    x = values.copy()
    for _ in range(iters): x = x + lam * ((W @ x) / deg[:, None] - x)
    return x


# ---------------------------------------------------------------- voxel remeshing of organs given as surface patches
CORNERS = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]])
EDGES = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]


def surface_nets(field, lo, h, level=0.0):
    """Closed mesh of {field < level} on a regular grid (naive surface nets: one vertex per crossing cell)."""
    f = field - level
    nx, ny, nz = f.shape
    cv = [f[i:nx - 1 + i, j:ny - 1 + j, k:nz - 1 + k] for i, j, k in CORNERS]
    anyin = np.zeros(cv[0].shape, bool); allin = np.ones(cv[0].shape, bool)
    for c in cv: s = c < 0; anyin |= s; allin &= s
    active = anyin & ~allin
    idx = np.argwhere(active); M = len(idx)
    vals = np.stack([c[active] for c in cv], 1)
    acc = np.zeros((M, 3)); cnt = np.zeros(M)
    for a, b in EDGES:
        fa = vals[:, a]; fb = vals[:, b]; m = (fa < 0) != (fb < 0)
        t = fa[m] / (fa[m] - fb[m])
        acc[m] += CORNERS[a] + t[:, None] * (CORNERS[b] - CORNERS[a]); cnt[m] += 1
    vpos = (idx + acc / np.maximum(cnt, 1)[:, None]) * h + lo
    vid = -np.ones(active.shape, np.int64); vid[active] = np.arange(M)
    inside = f < 0
    quads = []
    ch = inside[:-1, 1:-1, 1:-1] != inside[1:, 1:-1, 1:-1]; e0 = inside[:-1, 1:-1, 1:-1]
    quads.append((vid[:, :-1, :-1][ch], vid[:, 1:, :-1][ch], vid[:, 1:, 1:][ch], vid[:, :-1, 1:][ch], e0[ch]))
    ch = inside[1:-1, :-1, 1:-1] != inside[1:-1, 1:, 1:-1]; e0 = inside[1:-1, :-1, 1:-1]
    quads.append((vid[:-1, :, :-1][ch], vid[:-1, :, 1:][ch], vid[1:, :, 1:][ch], vid[1:, :, :-1][ch], e0[ch]))
    ch = inside[1:-1, 1:-1, :-1] != inside[1:-1, 1:-1, 1:]; e0 = inside[1:-1, 1:-1, :-1]
    quads.append((vid[:-1, :-1, :][ch], vid[1:, :-1, :][ch], vid[1:, 1:, :][ch], vid[:-1, 1:, :][ch], e0[ch]))
    tris = []
    for A, B, C, D, e0 in quads:
        a = A; b = np.where(e0, B, D); c = C; d = np.where(e0, D, B)
        use_ac = np.sum((vpos[a] - vpos[c]) ** 2, 1) <= np.sum((vpos[b] - vpos[d]) ** 2, 1)
        tris.append(np.where(use_ac[:, None], np.stack([a, b, c], 1), np.stack([a, b, d], 1)))
        tris.append(np.where(use_ac[:, None], np.stack([a, c, d], 1), np.stack([b, c, d], 1)))
    return vpos, np.concatenate(tris, 0)


def taubin(v, f, iters=6, lam=0.5, mu=-0.53):
    n = len(v)
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    W = sparse.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    deg = np.asarray(W.sum(1)).ravel(); deg[deg == 0] = 1
    for _ in range(iters):
        for k in (lam, mu): v = v + k * ((W @ v) / deg[:, None] - v)
    return v


def closest_on_mesh(v, f, p, k=8):
    """Exact closest points on a triangle mesh (checks the k triangles with the nearest centroids). Returns (q, d)."""
    p = np.asarray(p, float)
    A, B, C = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    tree = cKDTree((A + B + C) / 3)
    _, cand = tree.query(p, k=min(k, len(f)))
    if cand.ndim == 1: cand = cand[:, None]
    best_d = np.full(len(p), np.inf); best_q = np.zeros_like(p)
    for j in range(cand.shape[1]):
        t = cand[:, j]; a, b, c = A[t], B[t], C[t]
        q = _closest_point_triangle(p, a, b, c)
        d = np.linalg.norm(q - p, axis=1)
        m = d < best_d; best_d[m] = d[m]; best_q[m] = q[m]
    return best_q, best_d


def _closest_point_triangle(p, a, b, c):
    """Vectorised Ericson closest point on triangle (abc) to p."""
    ab, ac, ap = b - a, c - a, p - a
    d1 = np.einsum('ij,ij->i', ab, ap); d2 = np.einsum('ij,ij->i', ac, ap)
    bp = p - b; d3 = np.einsum('ij,ij->i', ab, bp); d4 = np.einsum('ij,ij->i', ac, bp)
    cp = p - c; d5 = np.einsum('ij,ij->i', ab, cp); d6 = np.einsum('ij,ij->i', ac, cp)
    vc = d1 * d4 - d3 * d2; vb = d5 * d2 - d1 * d6; va = d3 * d6 - d5 * d4
    out = np.empty_like(p)
    den = va + vb + vc; den = np.where(np.abs(den) < 1e-30, 1e-30, den)
    v_ = vb / den; w_ = vc / den
    out[:] = a + ab * v_[:, None] + ac * w_[:, None]
    m = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0)
    w = (d4 - d3) / np.where((d4 - d3) + (d5 - d6) == 0, 1e-30, (d4 - d3) + (d5 - d6)); out[m] = (b + (c - b) * w[:, None])[m]
    m = (vb <= 0) & (d2 >= 0) & (d6 <= 0)
    w = d2 / np.where(d2 - d6 == 0, 1e-30, d2 - d6); out[m] = (a + ac * w[:, None])[m]
    m = (vc <= 0) & (d1 >= 0) & (d3 <= 0)
    w = d1 / np.where(d1 - d3 == 0, 1e-30, d1 - d3); out[m] = (a + ab * w[:, None])[m]
    m = (d6 >= 0) & (d5 <= d6); out[m] = c[m]
    m = (d3 >= 0) & (d4 <= d3); out[m] = b[m]
    m = (d1 <= 0) & (d2 <= 0); out[m] = a[m]
    return out


def remesh_solid(meshes, h=0.0012, close=2, smooth=4, project=True, opening=0):
    """One closed surface enclosing the union of (possibly open, overlapping) surface patches.
    Rasterises the patches into voxels, closes gaps of up to `close` voxels, fills the inside, extracts the zero level of
    a signed distance field and projects it onto the original patches where they are close (keeping their detail)."""
    from scipy import ndimage
    v, f = merge(meshes)
    lo = v.min(0) - (close + 4) * h; hi = v.max(0) + (close + 4) * h
    n = np.ceil((hi - lo) / h).astype(int) + 1
    shell = np.zeros(n, bool)
    pts = dense_points(v, f, spacing=h * 0.45)
    ijk = np.clip(np.round((pts - lo) / h).astype(int), 0, n - 1)
    shell[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    st = ndimage.generate_binary_structure(3, 1)
    shut = ndimage.binary_dilation(shell, st, iterations=close)
    solid = ndimage.binary_fill_holes(shut)
    solid = ndimage.binary_erosion(solid, st, iterations=close) | shell
    solid = ndimage.binary_fill_holes(solid)
    if opening: solid = ndimage.binary_opening(solid, st, iterations=opening)  # drop strands thinner than ~2*opening voxels
    lab, k = ndimage.label(solid)
    if k > 1:  # keep the main body (drop specks)
        sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, k + 1))
        solid = np.isin(lab, 1 + np.flatnonzero(sizes >= 0.02 * sizes.max()))
    sdf = (ndimage.distance_transform_edt(~solid) - ndimage.distance_transform_edt(solid)).astype(np.float32)
    sdf = ndimage.gaussian_filter(sdf, 0.7)
    rv, rf = surface_nets(sdf, lo, h, level=0.0)
    rv = taubin(rv, rf, iters=smooth)
    if project:
        # snap fully where the source surface is near; fade out only across bridged gaps (partial blending would band)
        q, d = closest_on_mesh(v, f, rv)
        w = np.clip((3.0 * h - d) / (1.5 * h), 0, 1)[:, None]
        rv = rv * (1 - w) + q * w
    rf = orient_outward(rv, rf)
    return rv, rf
