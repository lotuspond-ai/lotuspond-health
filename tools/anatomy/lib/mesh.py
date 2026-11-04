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


def _lattice_box(v, h, pad, origin):
    """Grid corner and size covering points v with `pad` voxels of margin, on the lattice origin + h * integer."""
    lo = origin + h * np.floor((v.min(0) - origin) / h - pad)
    hi = v.max(0) + pad * h
    return lo, np.ceil((hi - lo) / h).astype(int) + 1


def voxel_solid(meshes, lo, n, h, close=2, opening=0, specks=0.02):
    """Solid voxels of (possibly open, overlapping) surface patches on the grid (lo, n, h): rasterise the patches, close
    gaps of up to `close` voxels, fill the inside, optionally open away strands thinner than ~2*opening voxels and drop
    specks smaller than `specks` of the main body."""
    from scipy import ndimage
    v, f = merge(meshes)
    shell = np.zeros(n, bool)
    pts = dense_points(v, f, spacing=h * 0.45)
    ijk = np.round((pts - lo) / h).astype(int)
    ok = np.all((ijk >= 0) & (ijk < n), axis=1); ijk = ijk[ok]
    shell[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    st = ndimage.generate_binary_structure(3, 1)
    shut = ndimage.binary_dilation(shell, st, iterations=close)
    solid = ndimage.binary_fill_holes(shut)
    solid = ndimage.binary_erosion(solid, st, iterations=close) | shell
    solid = ndimage.binary_fill_holes(solid)
    if opening: solid = ndimage.binary_opening(solid, st, iterations=opening)
    return _drop_specks(solid, specks)


def _drop_specks(solid, frac):
    from scipy import ndimage
    lab, k = ndimage.label(solid)
    if k > 1:  # keep the main body (drop specks)
        sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, k + 1))
        solid = np.isin(lab, 1 + np.flatnonzero(sizes >= frac * sizes.max()))
    return solid


def carve_region(carve, lo, n, h):
    """Voxels of the grid (lo, n, h) within `margin` of the solids of `carve` = [(meshes, margin), ...]. Each carving
    solid is voxelised on its own box of the same lattice (so a solid cut by the grid's border still fills), then its
    margin is added by a distance transform and the box is mapped into the grid."""
    from scipy import ndimage
    cut = np.zeros(n, bool)
    for meshes, margin in carve or ():
        meshes = [m for m in meshes if len(m[1])]
        if not meshes: continue
        v = np.concatenate([m[0] for m in meshes])
        pad = int(np.ceil(margin / h)) + 4
        clo, cn = _lattice_box(v, h, pad, lo)
        # only the part that can reach the grid matters
        if np.any(clo > lo + n * h) or np.any(clo + cn * h < lo): continue
        sol = voxel_solid(meshes, clo, cn, h, close=2, specks=0.0)
        if margin > 0: sol = ndimage.distance_transform_edt(~sol) * h <= margin
        o = np.round((clo - lo) / h).astype(int)
        a = np.maximum(o, 0); b = np.minimum(o + cn, n)
        if np.any(b <= a): continue
        cut[a[0]:b[0], a[1]:b[1], a[2]:b[2]] |= sol[a[0] - o[0]:b[0] - o[0], a[1] - o[1]:b[1] - o[1], a[2] - o[2]:b[2] - o[2]]
    return cut


def _extract(solid, lo, h, smooth, src=None, cut=None, gap=None):
    """Closed surface of a voxel solid: zero level of its (slightly blurred) signed distance, Taubin-smoothed, optionally
    projected onto the source patches src = (v, f) where they are near. `gap`: a distance field (metres, on the same
    grid) the surface keeps away from by half its own value (used to leave a thin cleft between neighbouring solids).
    The faces come out of surface_nets wound from the inside to the outside end of each grid edge, that is along the
    field's gradient: checked face by face against the gradient below, and never re-oriented by a breadth-first walk over
    shared edges (which carries a wrong flip through the non-manifold edges surface nets makes at ambiguous cells)."""
    from scipy import ndimage
    sdf = (ndimage.distance_transform_edt(~solid) - ndimage.distance_transform_edt(solid)).astype(np.float32) * h
    if gap is not None: sdf = np.maximum(sdf, gap)
    sdf = ndimage.gaussian_filter(sdf, 0.7)
    rv, rf = surface_nets(sdf / h, lo, h, level=0.0)
    if not len(rf): return rv, rf
    q = ((rv[rf].mean(1) - lo) / h).T
    grad = np.stack([ndimage.map_coordinates(gi, q, order=1, mode='nearest') for gi in np.gradient(sdf)], 1)
    bad = np.einsum('ij,ij->i', face_normals(rv, rf, unit=False), grad) < 0
    rf[bad] = rf[bad][:, ::-1]
    rv = taubin(rv, rf, iters=smooth)
    if src is not None:
        # snap fully where the source surface is near; fade out only across bridged gaps (partial blending would band)
        q, d = closest_on_mesh(src[0], src[1], rv)
        w = np.clip((3.0 * h - d) / (1.5 * h), 0, 1)
        if cut is not None and cut.any():
            # never snap back onto source surface that was carved away (or towards it)
            dc = ndimage.distance_transform_edt(~cut).astype(np.float32) * h
            near = lambda p: ndimage.map_coordinates(dc, ((p - lo) / h).T, order=1, mode='nearest')
            w = np.where((near(q) < 1.5 * h) | (near(rv) < 3.0 * h), 0.0, w)
        rv = rv * (1 - w[:, None]) + q * w[:, None]
    return rv, rf


def remesh_solid(meshes, h=0.0012, close=2, smooth=4, project=True, opening=0, carve=None):
    """One closed surface enclosing the union of (possibly open, overlapping) surface patches.
    Rasterises the patches into voxels, closes gaps of up to `close` voxels, fills the inside, removes the solids of
    `carve` = [(meshes, margin), ...] grown by their margins (room for a neighbour), extracts the zero level of a signed
    distance field and projects it onto the original patches where they are close (keeping their detail)."""
    v, f = merge(meshes)
    lo, n = _lattice_box(v, h, close + 4, v.min(0))
    solid = voxel_solid(meshes, lo, n, h, close=close, opening=opening)
    cut = None
    if carve:
        cut = carve_region(carve, lo, n, h)
        solid = _drop_specks(solid & ~cut, 0.02)
    return _extract(solid, lo, h, smooth, src=(v, f) if project else None, cut=cut)


def remesh_solids(groups, h=0.0012, close=2, smooth=4, project=True, opening=0, carve=None, cleft=0.0006):
    """remesh_solid for neighbouring organs whose patches overlap (lung lobes): all solids on one grid; a voxel claimed by
    several goes to the one it lies deepest in (the overlap is split along its medial surface, like a fissure), the
    solids of `carve` plus their margins are removed, and neighbours keep a cleft of `cleft` metres between them.
    groups: {key: [meshes]}; returns {key: (v, f)}."""
    from scipy import ndimage
    keys = list(groups)
    allv = np.concatenate([merge(groups[k])[0] for k in keys])
    lo, n = _lattice_box(allv, h, close + 4, allv.min(0))
    solids = {k: voxel_solid(groups[k], lo, n, h, close=close, opening=opening) for k in keys}
    owner = -np.ones(n, np.int8); best = np.zeros(n, np.float32)
    for i, k in enumerate(keys):
        d = ndimage.distance_transform_edt(solids[k]).astype(np.float32)
        m = d > best; owner[m] = i; best[m] = d[m]
    del best
    cut = carve_region(carve, lo, n, h) if carve else None
    if cut is not None: owner[cut] = -1
    out = {}
    for i, k in enumerate(keys):
        sol = _drop_specks(owner == i, 0.02)
        idx = np.argwhere(sol)
        if not len(idx): continue
        a = np.maximum(idx.min(0) - close - 4, 0); b = np.minimum(idx.max(0) + close + 5, n)
        sl = tuple(slice(a[j], b[j]) for j in range(3))
        others = (owner[sl] >= 0) & (owner[sl] != i)
        # the voxel faces between two owners lie h/2 from the other's voxel centres: keep the surface cleft/2 beyond them
        gap = (0.5 * (h + cleft) - ndimage.distance_transform_edt(~others) * h).astype(np.float32) if cleft and others.any() else None
        src = merge(groups[k]) if project else None
        out[k] = _extract(sol[sl], lo + a * h, h, smooth, src=src, cut=None if cut is None else cut[sl], gap=gap)
    return out


# ---------------------------------------------------------------- exact orientation tests
def _manifold_pairs(f):
    """Face pairs across manifold edges (edges with exactly two faces) and whether both run the edge the same way."""
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    fid = np.tile(np.arange(len(f)), 3)
    key = np.sort(e, axis=1)
    order = np.lexsort((key[:, 1], key[:, 0]))
    ks = key[order]
    new = np.concatenate([[True], np.any(ks[1:] != ks[:-1], axis=1)])
    start = np.flatnonzero(new); cnt = np.diff(np.append(start, len(ks)))
    s2 = start[cnt == 2]
    a, b = order[s2], order[s2 + 1]
    return fid[a], fid[b], np.all(e[a] == e[b], axis=1)


def winding_patches(f):
    """Consistent winding propagated over manifold edges only (a non-manifold edge never passes a flip on).
    Returns (flip: faces to reverse, patch: label per face of the consistently wound patches)."""
    F = len(f)
    if not F: return np.zeros(0, bool), np.zeros(0, np.int64)
    a, b, same = _manifold_pairs(f)
    s = same.astype(np.int64)
    # two states per face (kept, reversed); an edge ties the states that make the pair consistent
    rows = np.concatenate([a, a + F]); cols = np.concatenate([b + F * s, b + F * (1 - s)])
    G = sparse.coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(2 * F, 2 * F))
    _, lab = connected_components(G, directed=False)
    c0, c1 = lab[:F], lab[F:]
    return c1 < c0, np.unique(np.minimum(c0, c1), return_inverse=True)[1]


class RayParity:
    """Exact inside test by ray parity against a triangle mesh: crossings of the rays along +z, +x and +y from each
    point, majority vote (a small hole flips one ray at most); crossings through a shared edge or vertex count once.
    With `group` (a label per face, e.g. its connected component) a query only counts the faces of its own group."""

    def __init__(self, v, f, group=None):
        v = np.asarray(v, float); f = np.asarray(f, np.int64)
        self.T = v[f]
        self.group = None if group is None else np.asarray(group, np.int64)
        self.lo = v.min(0)
        span = float((v.max(0) - v.min(0)).max()) or 1e-3
        ext = (self.T.max(1) - self.T.min(1)).max(1)
        self.cell = max(2.0 * float(np.median(ext)), span / 400.0, 1e-6)
        self.bins = {}

    def _bin(self, ax):
        if ax not in self.bins:
            u, w = [a for a in range(3) if a != ax]
            lo2 = self.lo[[u, w]]
            i0 = np.floor((self.T[:, :, [u, w]].min(1) - lo2) / self.cell).astype(np.int64)
            i1 = np.floor((self.T[:, :, [u, w]].max(1) - lo2) / self.cell).astype(np.int64)
            nw = i1[:, 1] - i0[:, 1] + 1; cnt = (i1[:, 0] - i0[:, 0] + 1) * nw
            tid = np.repeat(np.arange(len(self.T)), cnt)
            k = np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt)
            key = (np.repeat(i0[:, 0], cnt) + k // np.repeat(nw, cnt)) * 2000003 + np.repeat(i0[:, 1], cnt) + k % np.repeat(nw, cnt)
            o = np.argsort(key, kind='stable'); key, tid = key[o], tid[o]
            uk, st = np.unique(key, return_index=True)
            self.bins[ax] = (uk, np.append(st, len(key)), tid)
        return self.bins[ax]

    def parity(self, p, ax, group=None, chunk=20000):
        p = np.asarray(p, float)
        out = np.zeros(len(p), bool)
        uk, st, tid = self._bin(ax)
        u, w = [a for a in range(3) if a != ax]
        for c0 in range(0, len(p), chunk):
            q = p[c0:c0 + chunk]
            key = np.floor((q[:, u] - self.lo[u]) / self.cell).astype(np.int64) * 2000003 + np.floor((q[:, w] - self.lo[w]) / self.cell).astype(np.int64)
            pos = np.clip(np.searchsorted(uk, key), 0, len(uk) - 1)
            nn = np.where(uk[pos] == key, st[pos + 1] - st[pos], 0)
            pid = np.repeat(np.arange(len(q)), nn)
            t = tid[np.repeat(st[pos], nn) + np.arange(nn.sum()) - np.repeat(np.cumsum(nn) - nn, nn)]
            if group is not None and self.group is not None:
                m = self.group[t] == np.asarray(group)[c0:c0 + chunk][pid]; pid, t = pid[m], t[m]
            a, b, c = self.T[t, 0], self.T[t, 1], self.T[t, 2]
            x = q[pid, u]; y = q[pid, w]
            d = (b[:, w] - c[:, w]) * (a[:, u] - c[:, u]) + (c[:, u] - b[:, u]) * (a[:, w] - c[:, w])
            ok = np.abs(d) > 1e-24; d = np.where(ok, d, 1.0)
            l1 = ((b[:, w] - c[:, w]) * (x - c[:, u]) + (c[:, u] - b[:, u]) * (y - c[:, w])) / d
            l2 = ((c[:, w] - a[:, w]) * (x - c[:, u]) + (a[:, u] - c[:, u]) * (y - c[:, w])) / d
            l3 = 1 - l1 - l2
            z = l1 * a[:, ax] + l2 * b[:, ax] + l3 * c[:, ax]
            hit = ok & (l1 >= 0) & (l2 >= 0) & (l3 >= 0) & (z > q[pid, ax])
            if hit.any():
                pz = np.unique(np.stack([pid[hit].astype(float), np.round(z[hit], 9)], 1), axis=0)
                out[c0:c0 + chunk] = np.bincount(pz[:, 0].astype(np.int64), minlength=len(q)) % 2 == 1
        return out

    def inside(self, p, group=None):
        return sum(self.parity(p, ax, group).astype(int) for ax in (2, 0, 1)) >= 2


def _face_votes(v, f, faces, group, rays, eps):
    """For sampled faces: +1 where the normal points out of the solid of its group, -1 where it points in, 0 undecided."""
    c = v[f[faces]].mean(1); nrm = face_normals(v, f[faces])
    g = None if group is None else group[faces]
    out_in = rays.inside(c + eps * nrm, g); back_in = rays.inside(c - eps * nrm, g)
    return np.where(~out_in & back_in, 1, np.where(out_in & ~back_in, -1, 0))


def facing(v, f, n=160, eps=2e-4, seed=0):
    """Exact orientation measure: area fractions (outward, inward, undecided) of a mesh's faces whose normal points out
    of / into the solid its connected component encloses. Area-weighted samples per component; each sampled face's
    centroid is offset by eps along +/- its normal and both points are tested by ray parity against that component's
    own faces (overlapping components do not count as inside each other). Open sheets come out 'undecided'."""
    v = np.asarray(v, float); f = np.asarray(f, np.int64)
    if not len(f): return 0.0, 0.0, 0.0
    comps = components(v, f)
    lab = np.zeros(len(f), np.int64)
    for i, cf in enumerate(comps): lab[cf] = i
    ar = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
    tot = ar.sum()
    if tot <= 0: return 0.0, 0.0, 0.0
    rng = np.random.default_rng(seed)
    pick, wt = [], []
    for cf in comps:
        a = ar[cf]; A = a.sum()
        if A <= 0: continue
        k = min(n, len(cf))
        s = rng.choice(cf, size=k, replace=len(cf) < n, p=a / A) if k < len(cf) else cf
        pick.append(s); wt.append(np.full(len(s), A / len(s)) if k < len(cf) else a)
    pick = np.concatenate(pick); wt = np.concatenate(wt)
    vote = _face_votes(v, f, pick, lab, RayParity(v, f, lab), eps)
    return float(wt[vote > 0].sum() / tot), float(wt[vote < 0].sum() / tot), float(wt[vote == 0].sum() / tot)


def orient_exact(v, f, n=48, eps=2e-4, seed=0):
    """Outward winding that does not trust non-manifold edges or centroids: the winding is made consistent over manifold
    edges only (winding_patches), then each patch is turned so that its normals point out of the solid its connected
    component encloses (exact ray-parity votes, see facing). Patches the test cannot decide (open sheets) keep the
    centroid rule of orient_outward."""
    v = np.asarray(v, float); f = np.asarray(f, np.int64).copy()
    if not len(f): return f
    flip, patch = winding_patches(f)
    f[flip] = f[flip][:, ::-1]
    comps = components(v, f)
    lab = np.zeros(len(f), np.int64)
    for i, cf in enumerate(comps): lab[cf] = i
    rays = RayParity(v, f, lab)
    rng = np.random.default_rng(seed)
    order = np.argsort(patch, kind='stable'); brk = np.flatnonzero(np.diff(patch[order])) + 1
    groups = np.split(order, brk)
    ar = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
    pick, pof = [], []
    for j, g in enumerate(groups):
        a = ar[g]
        s = g if len(g) <= n or a.sum() <= 0 else rng.choice(g, size=n, replace=False, p=a / a.sum())
        pick.append(s); pof.append(np.full(len(s), j))
    pick = np.concatenate(pick); pof = np.concatenate(pof)
    vote = _face_votes(v, f, pick, lab, rays, eps)
    score = np.bincount(pof, weights=vote, minlength=len(groups))
    decided = np.bincount(pof, weights=np.abs(vote), minlength=len(groups))
    for j, g in enumerate(groups):
        if decided[j] > 0:
            if score[j] < 0: f[g] = f[g][:, ::-1]
            continue
        # undecided (an open sheet): normals away from its component's centroid on average
        cmp = comps[lab[g[0]]]
        c = v[np.unique(f[cmp])].mean(0)
        nrm = face_normals(v, f[g], unit=False); cent = v[f[g]].mean(1)
        if np.einsum('ij,ij->i', nrm, cent - c).sum() < 0: f[g] = f[g][:, ::-1]
    return f
