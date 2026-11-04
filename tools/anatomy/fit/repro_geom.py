"""Geometry helpers for fit/repro.py: local signed distance grids, transformed-solid queries, swept tubes and curves."""
import os, sys
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import grid_for, sample_grid, signed_volume, closest_on_mesh, face_normals  # noqa: E402


class LocalSDF:
    """Signed distance (m, negative inside) of one closed mesh on its own fine voxel grid (ray parity, so the winding of
    the mesh does not matter). `at(p, T)` reads the solid after a similarity T = (c, R, k, t): p' = (p - c) R^T k + c + t,
    whose signed distance at p is k * sdf(T^-1 p)."""

    def __init__(self, mesh, h=0.0004, pad=0.012):
        self.g = grid_for([mesh], h, pad=pad)
        self.sdf = self.g.sdf().astype(np.float32)
        self.h = h

    def __call__(self, p):
        return sample_grid(self.sdf, self.g, p)

    def at(self, p, T):
        c, R, k, t = T
        q = (np.asarray(p) - c - t) @ R / k + c
        return k * self(q)


def resample(poly, step):
    """Polyline resampled at (about) equal arc-length steps; returns (points, arc lengths)."""
    seg = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(int(np.ceil(s[-1] / step)), 1) + 1
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, poly[:, a]) for a in range(3)], 1), t


def bezier(ctrl, n):
    """Points of the Bezier curve with control points ctrl (k, 3) at n parameters (de Casteljau)."""
    t = np.linspace(0, 1, n)[:, None, None]
    P = np.repeat(np.asarray(ctrl, float)[None], n, 0)
    while P.shape[1] > 1: P = (1 - t) * P[:, :-1] + t * P[:, 1:]
    return P[:, 0]


def hermite(p0, d0, p1, d1, n):
    """Cubic Hermite curve from p0 (tangent d0) to p1 (tangent d1); tangents scaled to the chord length."""
    L = np.linalg.norm(p1 - p0)
    t = np.linspace(0, 1, n)[:, None]
    h00 = 2 * t ** 3 - 3 * t ** 2 + 1; h10 = t ** 3 - 2 * t ** 2 + t; h01 = -2 * t ** 3 + 3 * t ** 2; h11 = t ** 3 - t ** 2
    return h00 * p0 + h10 * L * d0 + h01 * p1 + h11 * L * d1


def frames(C, ref=None):
    """Rotation-minimising frames (T, N, B) along a polyline, the first normal taken from `ref` (or any perpendicular)."""
    T = np.gradient(C, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    ref = np.array([1.0, 0, 0]) if ref is None else np.asarray(ref, float)
    n = ref - (ref @ T[0]) * T[0]
    if np.linalg.norm(n) < 1e-6: n = np.cross(T[0], [0, 1, 0])
    N = [n / np.linalg.norm(n)]
    for i in range(1, len(C)):
        v = N[-1] - (N[-1] @ T[i]) * T[i]
        N.append(v / np.linalg.norm(v))
    N = np.array(N); B = np.cross(T, N)
    return T, N, B


def tube(C, r, n=18, caps=(True, True)):
    """Closed tube swept along centre points C (m, 3) with radii r (scalar or (m,)): rings joined by quads, the ends
    closed by flat discs. Faces wound outward."""
    C = np.asarray(C, float); m = len(C)
    r = np.broadcast_to(np.asarray(r, float), (m,))
    T, N, B = frames(C)
    th = 2 * np.pi * np.arange(n) / n
    V = (C[:, None, :] + r[:, None, None] * (np.cos(th)[None, :, None] * N[:, None, :] + np.sin(th)[None, :, None] * B[:, None, :])).reshape(-1, 3)
    F = []
    for i in range(m - 1):
        a = i * n + np.arange(n); b = i * n + (np.arange(n) + 1) % n
        F.append(np.stack([a, b, b + n], 1)); F.append(np.stack([a, b + n, a + n], 1))
    F = list(F)
    V = list(V)
    if caps[0]:
        V.append(C[0]); c = len(V) - 1; a = np.arange(n); b = (a + 1) % n
        F.append(np.stack([np.full(n, c), b, a], 1))
    if caps[1]:
        V.append(C[-1]); c = len(V) - 1; a = (m - 1) * n + np.arange(n); b = (m - 1) * n + (np.arange(n) + 1) % n
        F.append(np.stack([np.full(n, c), a, b], 1))
    V = np.array(V); F = np.concatenate(F).astype(np.int64)
    if signed_volume(V, F) < 0: F = F[:, ::-1]
    return V, F


def centreline(v, f, start, step=0.001):
    """Centre line of a thin tube mesh: vertices ordered by geodesic distance from the vertex nearest `start`, binned
    every `step` and averaged, then lightly smoothed."""
    from scipy import sparse
    from scipy.sparse.csgraph import dijkstra
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    w = np.linalg.norm(v[e[:, 0]] - v[e[:, 1]], axis=1)
    G = sparse.coo_matrix((w, (e[:, 0], e[:, 1])), shape=(len(v), len(v))).tocsr(); G = G + G.T
    i0 = int(np.argmin(np.linalg.norm(v - start, axis=1)))
    d = dijkstra(G, indices=i0)
    ok = np.isfinite(d)
    k = np.floor(d[ok] / step).astype(int)
    pts = np.array([v[ok][k == j].mean(0) for j in np.unique(k)])
    for _ in range(3): pts[1:-1] = 0.25 * pts[:-2] + 0.5 * pts[1:-1] + 0.25 * pts[2:]
    return pts


class Near:
    """Unsigned distance to a mesh surface from dense samples (fast), with an exact refinement for reporting."""

    def __init__(self, mesh, spacing=0.0004):
        from lib.mesh import dense_points
        self.v, self.f = mesh
        self.pts = dense_points(self.v, self.f, spacing)
        self.tree = cKDTree(self.pts)

    def __call__(self, p):
        return self.tree.query(p)[0]

    def exact(self, p):
        return closest_on_mesh(self.v, self.f, p)[1]


# ------------------------------------------------------------------------------------------------ skin slices
def slice_segments(v, f, y):
    """Segments where the horizontal plane at height y cuts the mesh: (k, 2, 3)."""
    d = v[:, 1] - y
    s = np.sign(d[f]); keep = (s.min(1) < 0) & (s.max(1) > 0)
    tri = f[keep]
    segs = []
    for a, b in ((0, 1), (1, 2), (2, 0)):
        da, db = d[tri[:, a]], d[tri[:, b]]
        m = (da < 0) != (db < 0)
        t = np.where(m, da / np.where(m, da - db, 1), 0)
        segs.append((m, v[tri[:, a]] + t[:, None] * (v[tri[:, b]] - v[tri[:, a]])))
    M = np.stack([s_[0] for s_ in segs], 1)
    P = np.stack([s_[1] for s_ in segs], 1)
    two = M.sum(1) == 2
    M, P = M[two], P[two]
    order = np.argsort(~M, axis=1, kind='stable')[:, :2]
    return np.take_along_axis(P, order[:, :, None], 1)


def fill_layer(segs, xs, zs):
    """Even-odd scanline fill of a slice's outlines on the (z, x) grid."""
    a, b = segs[:, 0][:, [0, 2]], segs[:, 1][:, [0, 2]]
    mask = np.zeros((len(zs), len(xs)), bool)
    for i, z in enumerate(zs):
        c = (a[:, 1] <= z) != (b[:, 1] <= z)
        if not c.any(): continue
        t = (z - a[c, 1]) / (b[c, 1] - a[c, 1])
        x = np.sort(a[c, 0] + t * (b[c, 0] - a[c, 0]))
        mask[i] = np.searchsorted(x, xs) % 2 == 1
    return mask


class SkinBox:
    """Signed distance (m, negative inside) to the skin inside a box, from even-odd filled horizontal slices.
    Indexed [y, z, x] internally; call with (n, 3) points."""

    def __init__(self, mesh, box, h=0.0005):
        v, f = mesh
        self.h = h
        self.lo = np.array([box['x'][0], box['y'][0], box['z'][0]])
        xs = np.arange(*box['x'], h) + h / 2; ys = np.arange(*box['y'], h) + h / 2; zs = np.arange(*box['z'], h) + h / 2
        vol = np.zeros((len(ys), len(zs), len(xs)), bool)
        for j, y in enumerate(ys):
            s = slice_segments(v, f, y)
            if len(s): vol[j] = fill_layer(s, xs, zs)
        self.vol = vol
        inside = ndimage.distance_transform_edt(vol) * h
        outside = ndimage.distance_transform_edt(~vol) * h
        self.sdf = np.where(vol, -inside + h / 2, outside - h / 2).astype(np.float32)

    def __call__(self, p):
        q = (np.asarray(p) - self.lo) / self.h - 0.5
        return ndimage.map_coordinates(self.sdf, [q[:, 1], q[:, 2], q[:, 0]], order=1, mode='nearest')
