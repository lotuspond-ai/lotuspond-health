"""Geometry helpers for the skull fit (fit/skull.py): voxel solids from surface patches, labelled outer-surface samples,
label-wise non-rigid ICP, cranial-cavity voxelisation, smooth correction fields and small measurement utilities.
numpy + scipy + the repo's lib/ only."""
import os, sys
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import area, sample_surface, dense_points, merge, sample_grid, face_normals  # noqa: E402
from lib.register import Warp, Sim, umeyama  # noqa: E402


# ------------------------------------------------------------------------------------------------ voxel solids
class VGrid:
    """A regular grid: lo (3,), h, shape."""

    def __init__(self, lo, h, shape):
        self.lo = np.asarray(lo, float); self.h = float(h); self.shape = tuple(int(s) for s in shape)

    @classmethod
    def around(cls, pts, h, pad):
        lo = pts.min(0) - pad; hi = pts.max(0) + pad
        return cls(lo, h, np.ceil((hi - lo) / h).astype(int) + 1)

    def ijk(self, p):
        return np.clip(np.round((np.asarray(p) - self.lo) / self.h).astype(int), 0, np.array(self.shape) - 1)

    def inside_grid(self, p):
        i = np.round((np.asarray(p) - self.lo) / self.h).astype(int)
        return np.all((i >= 0) & (i < np.array(self.shape)), axis=1)

    def sample(self, field, p):
        return sample_grid(field, self, p)

    def centres(self, mask):
        return self.lo + np.argwhere(mask) * self.h


def shell(meshes, g, spacing=None):
    """Voxels touched by the surfaces (dense surface samples)."""
    out = np.zeros(g.shape, bool)
    for v, f in meshes:
        if not len(f): continue
        p = dense_points(v, f, spacing=spacing or g.h * 0.45)
        i = g.ijk(p); out[i[:, 0], i[:, 1], i[:, 2]] = True
    return out


def solid_from_patches(meshes, h=0.0015, close=2, pad=0.01):
    """Filled solid (bool grid) enclosing a set of surface patches: shell -> closing -> fill holes."""
    pts = np.concatenate([m[0] for m in meshes])
    g = VGrid.around(pts, h, pad + (close + 2) * h)
    s = shell(meshes, g)
    st = ndimage.generate_binary_structure(3, 1)
    sol = ndimage.binary_fill_holes(ndimage.binary_closing(s, st, iterations=close) | s)
    return g, sol


def outer_samples(items, n_total=40000, h=0.0015, close=2, depth=None, seed=0):
    """Area-weighted surface samples of several labelled meshes, keeping only those on the outer hull of their union.
    items: list of (mesh, label). Returns (points, labels)."""
    meshes = [m for m, _ in items]
    g, sol = solid_from_patches(meshes, h=h, close=close)
    din = ndimage.distance_transform_edt(sol).astype(np.float32) * h
    areas = np.array([area(*m) for m in meshes]); tot = areas.sum()
    P, L = [], []
    for k, ((v, f), lab) in enumerate(items):
        n = int(max(20, n_total * areas[k] / tot))
        p = sample_surface(v, f, n, seed=seed + k)
        P.append(p); L.append(np.full(n, lab))
    P = np.concatenate(P); L = np.concatenate(L)
    keep = g.sample(din, P) < (depth or 2.0 * h)
    return P[keep], L[keep]


def vertex_normals(v, f):
    n = np.zeros_like(v)
    fn = face_normals(v, f, unit=False)
    for k in range(3): np.add.at(n, f[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-20)


def point_normals(pts, ref_pts, ref_normals, k=8):
    """Normals at points from the k nearest reference points (averaged)."""
    d, j = cKDTree(ref_pts).query(pts, k=k)
    n = ref_normals[j].mean(1)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-20)


# ------------------------------------------------------------------------------------------------ registration
def nricp_labels(src, sl, dst, dl, pre, schedule=(3e2, 1e2, 3e1, 1e1, 3, 1), n_ctrl=2500, trim=0.9, seed=0,
                 extra=None, extra_rep=1):
    """Label-wise non-rigid ICP: every stage matches each source point to the nearest destination point with the same
    label (and destination points back to the source), then refits ONE thin-plate spline from the original space with
    the given smoothing (large = stiff). `extra` = (src, dst) pairs honoured at every stage (other anchors).
    Returns (warp, warped src)."""
    rng = np.random.default_rng(seed)
    labs = np.unique(sl)
    trees = {k: cKDTree(dst[dl == k]) for k in labs}
    dsts = {k: dst[dl == k] for k in labs}
    cur = pre(src); W = None
    for sm in schedule:
        S, D = [], []
        for k in labs:
            ms = np.flatnonzero(sl == k)
            if not len(ms) or k not in trees: continue
            cs = cur[ms]
            d, j = trees[k].query(cs); keep = d <= np.quantile(d, trim)
            S.append(src[ms][keep]); D.append(dsts[k][j[keep]])
            d2, i2 = cKDTree(cs).query(dsts[k]); keep2 = d2 <= np.quantile(d2, trim)
            S.append(src[ms][i2[keep2]]); D.append(dsts[k][keep2])
        S = np.concatenate(S); D = np.concatenate(D)
        if len(S) > n_ctrl:
            idx = rng.choice(len(S), n_ctrl, replace=False); S, D = S[idx], D[idx]
        if extra is not None:
            S = np.concatenate([S] + [extra[0]] * extra_rep); D = np.concatenate([D] + [extra[1]] * extra_rep)
        W = Warp(S, D, pre=pre, smoothing=sm * len(S) * 1e-6, max_points=10 ** 9)
        cur = W(src)
    return W, cur


def project_labels(p, pl, dst, dl):
    """Nearest destination point with the same label."""
    out = np.empty_like(p); dist = np.empty(len(p))
    for k in np.unique(pl):
        m = pl == k; t = cKDTree(dst[dl == k]); d, j = t.query(p[m]); out[m] = dst[dl == k][j]; dist[m] = d
    return out, dist


def jacobian_det(warp, p, e=5e-4):
    J = np.zeros((len(p), 3, 3))
    for a in range(3):
        d = np.zeros(3); d[a] = e
        J[:, :, a] = (warp(p + d) - warp(p - d)) / (2 * e)
    return np.linalg.det(J), J


# ------------------------------------------------------------------------------------------------ cranial cavity
def cavity_grid(bone_meshes, plug_meshes=(), h=0.001, ball=0.005, pad=0.02):
    """Voxel cranial cavity: space enclosed by the bones that a ball of radius `ball` cannot reach from outside
    (seals sutures and foramina narrower than 2*ball; the foramen magnum is sealed by the plug meshes).
    Returns (grid, cavity bool, bone bool, exterior bool)."""
    pts = np.concatenate([m[0] for m in bone_meshes])
    g = VGrid.around(pts, h, pad + ball)
    bone = shell(list(bone_meshes), g)
    wall = bone | shell(list(plug_meshes), g) if len(plug_meshes) else bone.copy()
    wall = ndimage.binary_dilation(wall, iterations=1)
    dfree = ndimage.distance_transform_edt(~wall) * h
    free = dfree > ball
    lab, k = ndimage.label(free)
    border = np.unique(np.concatenate([lab[0].ravel(), lab[-1].ravel(), lab[:, 0].ravel(), lab[:, -1].ravel(), lab[:, :, 0].ravel(), lab[:, :, -1].ravel()]))
    border = border[border > 0]
    centres = np.isin(lab, border)
    ext = ndimage.distance_transform_edt(~centres) * h <= ball + 0.5 * h
    cav = ~ext & ~wall
    # keep the largest enclosed component (the cranial cavity proper; drops sinuses and small pockets)
    lab2, k2 = ndimage.label(cav)
    if k2 > 1:
        sizes = ndimage.sum(np.ones_like(lab2), lab2, index=np.arange(1, k2 + 1))
        cav = lab2 == (1 + int(np.argmax(sizes)))
    return g, cav, bone, ext


# ------------------------------------------------------------------------------------------------ smooth correction fields
class GaussField:
    """Smooth displacement field u(x) = sum_j K(x, c_j) w_j with a Gaussian kernel, fitted by ridge regression to
    target displacements at control points (zero-displacement anchors keep it local)."""

    def __init__(self, ctrl, disp, sigma, ridge=1e-3, weights=None):
        self.c = np.asarray(ctrl, float); self.sigma = float(sigma)
        K = self._k(self.c, self.c)
        w = np.ones(len(self.c)) if weights is None else np.asarray(weights, float)
        A = K * w[:, None]
        A = K.T @ A + ridge * np.eye(len(self.c))
        b = K.T @ (w[:, None] * np.asarray(disp, float))
        self.w = np.linalg.solve(A, b)

    def _k(self, a, b):
        d2 = ((a[:, None, :] - b[None, :, :]) ** 2).sum(-1)
        return np.exp(-d2 / (2 * self.sigma ** 2))

    def __call__(self, p, chunk=20000):
        p = np.asarray(p, float); out = np.zeros_like(p)
        for i in range(0, len(p), chunk): out[i:i + chunk] = self._k(p[i:i + chunk], self.c) @ self.w
        return out


def fps(points, n, seed=0):
    """Farthest-point subsample (indices)."""
    n = min(n, len(points))
    rng = np.random.default_rng(seed)
    idx = np.empty(n, np.int64); idx[0] = rng.integers(len(points))
    d = np.linalg.norm(points - points[idx[0]], axis=1)
    for i in range(1, n):
        idx[i] = int(np.argmax(d)); d = np.minimum(d, np.linalg.norm(points - points[idx[i]], axis=1))
    return idx


def sphere_fit(p):
    """Least-squares sphere: (centre, radius)."""
    A = np.c_[2 * p, np.ones(len(p))]; b = (p ** 2).sum(1)
    x, *_ = np.linalg.lstsq(A, b, rcond=None)
    c = x[:3]; r = np.sqrt(max(x[3] + c @ c, 0))
    return c, r


def ray_first_hit(orig, dirs, v, f, tmax=1.0):
    """Distance along each ray (orig[i] + t dirs[i]) to the first triangle hit (inf if none). Brute force in chunks."""
    A = v[f[:, 0]]; E1 = v[f[:, 1]] - A; E2 = v[f[:, 2]] - A
    out = np.full(len(dirs), np.inf)
    for k in range(len(dirs)):
        o = orig[k] if orig.ndim == 2 else orig; d = dirs[k]
        p = np.cross(d, E2); det = np.einsum('ij,ij->i', E1, p)
        ok = np.abs(det) > 1e-14
        inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
        tv = o - A
        u = np.einsum('ij,ij->i', tv, p) * inv
        q = np.cross(tv, E1)
        w = (q @ d) * inv
        t = np.einsum('ij,ij->i', E2, q) * inv
        m = ok & (u >= 0) & (w >= 0) & (u + w <= 1) & (t > 1e-7) & (t < tmax)
        if m.any(): out[k] = t[m].min()
    return out


def ray_hits_accel(orig, dirs, v, f, tmax=0.03, step=0.002, rad=None):
    """First-hit distance for many rays (inf if none within tmax), testing only triangles near each ray segment."""
    A = v[f[:, 0]]; B = v[f[:, 1]]; C = v[f[:, 2]]
    cen = (A + B + C) / 3
    ext = np.max(np.stack([np.linalg.norm(A - cen, axis=1), np.linalg.norm(B - cen, axis=1), np.linalg.norm(C - cen, axis=1)], 1), 1)
    rad = rad or (float(np.quantile(ext, 0.999)) + step)
    tree = cKDTree(cen)
    ts = np.arange(0, tmax + step, step)
    out = np.full(len(dirs), np.inf)
    for k in range(len(dirs)):
        o, d = orig[k], dirs[k]
        cand = tree.query_ball_point(o + ts[:, None] * d, rad)
        idx = np.unique(np.concatenate([np.asarray(c, np.int64) for c in cand])) if len(cand) else np.zeros(0, np.int64)
        if not len(idx): continue
        a = A[idx]; e1 = B[idx] - a; e2 = C[idx] - a
        p = np.cross(d, e2); det = np.einsum('ij,ij->i', e1, p)
        ok = np.abs(det) > 1e-14
        inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
        tv = o - a
        u = np.einsum('ij,ij->i', tv, p) * inv
        q = np.cross(tv, e1)
        w = (q @ d) * inv
        t = np.einsum('ij,ij->i', e2, q) * inv
        m = ok & (u >= -1e-9) & (w >= -1e-9) & (u + w <= 1 + 1e-9) & (t > 1e-7) & (t < tmax)
        if m.any(): out[k] = t[m].min()
    return out


class SignedSurface:
    """Signed distance to a closed, outward-oriented surface near it (positive outside), from dense samples with
    normals: sign of (p - q) . n at the nearest sample q."""

    def __init__(self, v, f, spacing=0.001):
        vn = vertex_normals(v, f)
        pts = dense_points(v, f, spacing)
        self.pts = pts
        self.n = point_normals(pts, v, vn, k=4)
        self.tree = cKDTree(pts)

    def __call__(self, p):
        d, j = self.tree.query(p)
        s = np.sign(np.einsum('ij,ij->i', p - self.pts[j], self.n[j]))
        s[s == 0] = 1
        return d * s


class Correction:
    """Smooth displacement field on fixed Gaussian centres, refitted by weighted ridge regression to target
    displacements at sample points: u(x) = sum_j exp(-|x - c_j|^2 / 2 sigma^2) w_j. Zero far from the centres."""

    def __init__(self, centres, sigma=0.008, ridge=1e-4):
        self.c = np.asarray(centres, float); self.sigma = float(sigma); self.ridge = float(ridge)
        self.w = np.zeros((len(self.c), 3))
        self.tree = cKDTree(self.c)

    def kmat(self, x):
        from scipy import sparse
        r = 3.5 * self.sigma
        D = cKDTree(np.asarray(x, float)).sparse_distance_matrix(self.tree, r, output_type='coo_matrix')
        vals = np.exp(-D.data ** 2 / (2 * self.sigma ** 2))
        K = sparse.csr_matrix((vals, (D.row, D.col)), shape=(len(x), len(self.c)))
        # exact zeros (a point on a centre) are dropped by sparse_distance_matrix: add them back
        d0, j0 = self.tree.query(x)
        z = d0 < 1e-12
        if z.any():
            K = K + sparse.csr_matrix((np.ones(z.sum()), (np.flatnonzero(z), j0[z])), shape=K.shape)
        return K

    def __call__(self, x, chunk=50000):
        x = np.asarray(x, float); out = np.zeros_like(x)
        if not np.any(self.w): return out
        for i in range(0, len(x), chunk): out[i:i + chunk] = self.kmat(x[i:i + chunk]) @ self.w
        return out

    def fit(self, x, target, weights):
        from scipy.sparse.linalg import spsolve
        from scipy import sparse
        K = self.kmat(np.asarray(x, float))
        Wd = sparse.diags(np.asarray(weights, float))
        A = (K.T @ Wd @ K + self.ridge * sparse.eye(len(self.c))).tocsc()
        b = K.T @ (np.asarray(weights, float)[:, None] * np.asarray(target, float))
        self.w = np.stack([spsolve(A, b[:, a]) for a in range(3)], 1)
        return self


def local_sdf(meshes, h=0.00025, pad=0.002, close=1):
    """(grid, signed distance field, negative inside) of the solid enclosed by the meshes, on a tight grid."""
    g, sol = solid_from_patches(meshes, h=h, close=close, pad=pad)
    sdf = (ndimage.distance_transform_edt(~sol) - ndimage.distance_transform_edt(sol)).astype(np.float32) * g.h
    return g, sdf


class HardField:
    """Unsigned distance to a set of surfaces on a voxel grid (for fast ray marching)."""

    def __init__(self, meshes, h=0.0005, pad=0.035):
        pts = np.concatenate([m[0] for m in meshes])
        self.g = VGrid.around(pts, h, pad)
        sh = shell(meshes, self.g)
        self.udf = (ndimage.distance_transform_edt(~sh) * h).astype(np.float32)

    def march(self, orig, dirs, tmax=0.03, step=0.00025, thresh=None):
        """Distance along each ray to the first point closer than `thresh` to a surface (inf if none)."""
        thresh = thresh if thresh is not None else 0.75 * self.g.h
        ts = np.arange(step, tmax + step, step)
        out = np.full(len(orig), np.inf)
        for i in range(0, len(orig), 2000):
            o = orig[i:i + 2000]; d = dirs[i:i + 2000]
            q = o[:, None, :] + ts[None, :, None] * d[:, None, :]
            u = self.g.sample(self.udf, q.reshape(-1, 3)).reshape(len(o), len(ts))
            hit = u < thresh
            any_ = hit.any(1)
            k = np.argmax(hit, 1)
            out[i:i + 2000][any_] = ts[k[any_]]
        return out
