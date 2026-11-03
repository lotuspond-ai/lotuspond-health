"""Geometry helpers for the foot fit (fit/foot.py); numpy + scipy only.

  submesh / crop_box     parts of a mesh by face mask or bounding box (unused vertices dropped)
  outer_layer            the outward-facing layer of Z-Anatomy skin-region shells (they are ~3 mm thick closed plates)
  TriMesh                exact closest points, signed distances (angle-weighted pseudo-normals) and ray casts
  VoxelField             signed distance on a regular grid (from a voxelised closed mesh) with trilinear lookup
  fit_sphere / fit_axis  least-squares sphere; axis of a surface of revolution (cylinder / cone section)
  rot_axis, rotvec       rotation helpers; Sim4 a 3x4 similarity/rigid map that composes
"""
import numpy as np
from scipy import ndimage, optimize
from scipy.spatial import cKDTree

from lib.mesh import compact, face_normals, Grid


# ------------------------------------------------------------------------------------------------ mesh parts
def submesh(mesh, face_mask):
    v, f = mesh
    return compact(v, f[np.asarray(face_mask, bool)])


def crop_box(mesh, lo, hi):
    """Faces whose three vertices all lie inside [lo, hi]."""
    v, f = mesh
    inside = np.all((v >= lo) & (v <= hi), axis=1)
    return submesh(mesh, inside[f].all(1))


def outer_layer(mesh, core_pts):
    """Faces of a thin closed shell whose normal points away from the nearest core point (the bones)."""
    v, f = mesh
    n = face_normals(v, f); c = v[f].mean(1)
    _, j = cKDTree(core_pts).query(c)
    return submesh(mesh, np.einsum('ij,ij->i', n, c - core_pts[j]) > 0)


# ------------------------------------------------------------------------------------------------ rotations / maps
def rot_axis(axis, ang):
    a = np.asarray(axis, float); a = a / np.linalg.norm(a)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(ang) * K + (1 - np.cos(ang)) * (K @ K)


def rotvec(r):
    r = np.asarray(r, float); th = np.linalg.norm(r)
    if th < 1e-12: return np.eye(3)
    return rot_axis(r / th, th)


def rotvec_of(R):
    """Rotation vector of a rotation matrix."""
    c = np.clip((np.trace(R) - 1) / 2, -1, 1); th = np.arccos(c)
    if th < 1e-9: return np.zeros(3)
    w = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
    if np.sin(th) < 1e-6:  # ~180 degrees
        M = (R + np.eye(3)) / 2; k = np.argmax(np.diag(M)); a = M[:, k] / np.sqrt(M[k, k]); return a * th
    return w / (2 * np.sin(th)) * th


class Sim4:
    """x -> A x + t with A = s R (similarity) or any 3x3 matrix; composes with `then`."""

    def __init__(self, A=None, t=None):
        self.A = np.eye(3) if A is None else np.asarray(A, float)
        self.t = np.zeros(3) if t is None else np.asarray(t, float)

    def __call__(self, p):
        return np.asarray(p, float) @ self.A.T + self.t

    def vec(self, d):
        return np.asarray(d, float) @ self.A.T

    def then(self, other):
        """other(self(x))"""
        return Sim4(other.A @ self.A, other.A @ self.t + other.t)

    def inverse(self):
        Ai = np.linalg.inv(self.A); return Sim4(Ai, -Ai @ self.t)

    @staticmethod
    def about(M, c):
        """Linear map M about the point c."""
        c = np.asarray(c, float); return Sim4(M, c - M @ c)

    @staticmethod
    def from_sim(S):
        return Sim4(S.s * S.R, S.t)

    def scale(self):
        return float(np.cbrt(abs(np.linalg.det(self.A))))

    def to_list(self):
        return np.concatenate([self.A, self.t[:, None]], 1).tolist()

    @staticmethod
    def from_list(L):
        M = np.asarray(L, float); return Sim4(M[:, :3], M[:, 3])


# ------------------------------------------------------------------------------------------------ exact queries
class TriMesh:
    """Closest points, signed distances (negative inside, angle-weighted pseudo-normals) and ray casts on a triangle mesh.
    The mesh should be closed and wound outward for the sign to mean inside/outside."""

    def __init__(self, v, f):
        self.v = np.asarray(v, float); self.f = np.asarray(f, np.int64)
        A, B, C = self.v[self.f[:, 0]], self.v[self.f[:, 1]], self.v[self.f[:, 2]]
        self.A, self.B, self.C = A, B, C
        self.cent = (A + B + C) / 3
        self.rad = np.max(np.stack([np.linalg.norm(X - self.cent, axis=1) for X in (A, B, C)], 1), 1)
        self.tree = cKDTree(self.cent)
        n = np.cross(B - A, C - A); self.fn = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-30)
        # angle-weighted vertex normals
        vn = np.zeros_like(self.v)
        for i in range(3):
            p0 = self.v[self.f[:, i]]; p1 = self.v[self.f[:, (i + 1) % 3]]; p2 = self.v[self.f[:, (i + 2) % 3]]
            e1 = p1 - p0; e2 = p2 - p0
            ang = np.arccos(np.clip(np.einsum('ij,ij->i', e1, e2) / np.maximum(np.linalg.norm(e1, axis=1) * np.linalg.norm(e2, axis=1), 1e-30), -1, 1))
            np.add.at(vn, self.f[:, i], self.fn * ang[:, None])
        self.vn = vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-30)
        # edge normals: sum of the adjacent face normals
        e = np.concatenate([self.f[:, [0, 1]], self.f[:, [1, 2]], self.f[:, [2, 0]]])
        key = np.sort(e, 1); fid = np.tile(np.arange(len(self.f)), 3)
        uniq, inv = np.unique(key, axis=0, return_inverse=True)
        en = np.zeros((len(uniq), 3)); np.add.at(en, inv.ravel(), self.fn[fid])
        self.edge_of = inv.reshape(3, -1).T  # face -> edge ids for (01, 12, 20)
        self.en = en / np.maximum(np.linalg.norm(en, axis=1, keepdims=True), 1e-30)
        self.rmax = float(self.rad.max())

    def closest(self, p, k=12):
        """(closest points, distances, face ids, feature normals)."""
        p = np.atleast_2d(np.asarray(p, float))
        k = min(k, len(self.f))
        _, cand = self.tree.query(p, k=k)
        if cand.ndim == 1: cand = cand[:, None]
        best_d = np.full(len(p), np.inf); best_q = np.zeros_like(p); best_f = np.zeros(len(p), np.int64); best_n = np.zeros_like(p)
        for j in range(cand.shape[1]):
            t = cand[:, j]
            q, nrm = self._closest_tri(p, t)
            d = np.linalg.norm(q - p, axis=1)
            m = d < best_d
            best_d[m] = d[m]; best_q[m] = q[m]; best_f[m] = t[m]; best_n[m] = nrm[m]
        return best_q, best_d, best_f, best_n

    def signed(self, p, k=12):
        q, d, fi, n = self.closest(p, k)
        s = np.sign(np.einsum('ij,ij->i', np.atleast_2d(p) - q, n)); s[s == 0] = 1
        return s * d

    def _closest_tri(self, p, t):
        """Ericson's closest point on triangles t to points p, with the pseudo-normal of the feature reached."""
        a, b, c = self.A[t], self.B[t], self.C[t]
        ab, ac, ap = b - a, c - a, p - a
        d1 = np.einsum('ij,ij->i', ab, ap); d2 = np.einsum('ij,ij->i', ac, ap)
        bp = p - b; d3 = np.einsum('ij,ij->i', ab, bp); d4 = np.einsum('ij,ij->i', ac, bp)
        cp = p - c; d5 = np.einsum('ij,ij->i', ab, cp); d6 = np.einsum('ij,ij->i', ac, cp)
        vc = d1 * d4 - d3 * d2; vb = d5 * d2 - d1 * d6; va = d3 * d6 - d5 * d4
        den = va + vb + vc; den = np.where(np.abs(den) < 1e-30, 1e-30, den)
        out = a + ab * (vb / den)[:, None] + ac * (vc / den)[:, None]
        nrm = self.fn[t].copy()
        F = self.f[t]; E = self.edge_of[t]
        # edge bc
        m = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0)
        w = (d4 - d3) / np.where((d4 - d3) + (d5 - d6) == 0, 1e-30, (d4 - d3) + (d5 - d6))
        out[m] = (b + (c - b) * w[:, None])[m]; nrm[m] = self.en[E[m, 1]]
        # edge ac
        m = (vb <= 0) & (d2 >= 0) & (d6 <= 0)
        w = d2 / np.where(d2 - d6 == 0, 1e-30, d2 - d6)
        out[m] = (a + ac * w[:, None])[m]; nrm[m] = self.en[E[m, 2]]
        # edge ab
        m = (vc <= 0) & (d1 >= 0) & (d3 <= 0)
        w = d1 / np.where(d1 - d3 == 0, 1e-30, d1 - d3)
        out[m] = (a + ab * w[:, None])[m]; nrm[m] = self.en[E[m, 0]]
        # vertices
        m = (d6 >= 0) & (d5 <= d6); out[m] = c[m]; nrm[m] = self.vn[F[m, 2]]
        m = (d3 >= 0) & (d4 <= d3); out[m] = b[m]; nrm[m] = self.vn[F[m, 1]]
        m = (d1 <= 0) & (d2 <= 0); out[m] = a[m]; nrm[m] = self.vn[F[m, 0]]
        return out, nrm

    def ray(self, o, d, tmax=0.2, chunk=256):
        """Distance along unit directions d from origins o to the first surface crossing (inf if none within tmax)."""
        o = np.atleast_2d(np.asarray(o, float)); d = np.atleast_2d(np.asarray(d, float))
        d = d / np.linalg.norm(d, axis=1, keepdims=True)
        out = np.full(len(o), np.inf)
        e1 = self.B - self.A; e2 = self.C - self.A
        for i in range(0, len(o), chunk):
            O = o[i:i + chunk]; D = d[i:i + chunk]
            # candidate faces: centroid within (tmax + radius) of the origin and close to the ray line
            lo = np.minimum(O, O + D * tmax).min(0) - self.rmax; hi = np.maximum(O, O + D * tmax).max(0) + self.rmax
            cf = np.flatnonzero(np.all((self.cent >= lo) & (self.cent <= hi), axis=1))
            if not len(cf): continue
            A = self.A[cf]; E1 = e1[cf]; E2 = e2[cf]
            h = np.cross(D[:, None, :], E2[None])                       # (r, f, 3)
            a = np.einsum('fj,rfj->rf', E1, h)
            ok = np.abs(a) > 1e-16
            inv = np.where(ok, 1.0 / np.where(ok, a, 1), 0)
            s = O[:, None, :] - A[None]
            u = np.einsum('rfj,rfj->rf', s, h) * inv
            q = np.cross(s, E1[None])
            v = np.einsum('rj,rfj->rf', D, q) * inv
            t = np.einsum('fj,rfj->rf', E2, q) * inv
            hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-9) & (t <= tmax)
            t = np.where(hit, t, np.inf)
            out[i:i + chunk] = t.min(1)
        return out


# ------------------------------------------------------------------------------------------------ voxel signed distance
class VoxelField:
    """Signed distance (m, negative inside) of closed meshes on a grid of spacing h over the box [lo, hi]."""

    def __init__(self, meshes, lo, hi, h):
        g = Grid(lo, hi, h)
        for v, f in meshes: g.add(v, f)
        self.lo, self.h = g.lo, h
        occ = g.occ
        self.sdf = (ndimage.distance_transform_edt(~occ) * h - ndimage.distance_transform_edt(occ) * h).astype(np.float32)
        # the EDT of a binary grid is off by about half a voxel at the surface: shift toward the true zero level
        self.sdf = np.where(occ, self.sdf + 0.5 * h, self.sdf - 0.5 * h).astype(np.float32)
        self.shape = np.array(self.sdf.shape)

    def __call__(self, p):
        q = ((np.asarray(p, float) - self.lo) / self.h).T
        return ndimage.map_coordinates(self.sdf, q, order=1, mode='nearest')

    def gradient(self, p):
        e = self.h
        out = np.zeros((len(p), 3))
        for a in range(3):
            dv = np.zeros(3); dv[a] = e
            out[:, a] = (self(p + dv) - self(p - dv)) / (2 * e)
        return out


# ------------------------------------------------------------------------------------------------ joint fits
def fit_sphere(p):
    """Least-squares sphere through points: (centre, radius)."""
    p = np.asarray(p, float)
    A = np.c_[2 * p, np.ones(len(p))]; b = (p ** 2).sum(1)
    x, *_ = np.linalg.lstsq(A, b, rcond=None)
    c = x[:3]; r = np.sqrt(max(x[3] + c @ c, 1e-12))
    return c, float(r)


def fit_axis(p, c0, d0, cone=True):
    """Axis (point c, unit direction d) about which the points p form a surface of revolution (cylinder, or a cone section
    when cone=True: radius varying linearly along the axis). Returns (c, d, r0, slope, rms)."""
    p = np.asarray(p, float); d0 = np.asarray(d0, float) / np.linalg.norm(d0)
    # parametrise the direction by two angles about d0 and the point by two offsets perpendicular to it
    e1 = np.cross(d0, [1, 0, 0]);
    if np.linalg.norm(e1) < 0.1: e1 = np.cross(d0, [0, 1, 0])
    e1 /= np.linalg.norm(e1); e2 = np.cross(d0, e1)

    def geom(x):
        d = d0 + x[0] * e1 + x[1] * e2; d /= np.linalg.norm(d)
        c = c0 + x[2] * e1 + x[3] * e2
        return c, d

    def res(x):
        c, d = geom(x)
        q = p - c; t = q @ d
        r = np.linalg.norm(q - np.outer(t, d), axis=1)
        if cone:
            A = np.c_[np.ones(len(t)), t]; coef, *_ = np.linalg.lstsq(A, r, rcond=None); return r - A @ coef
        return r - r.mean()

    sol = optimize.least_squares(res, np.zeros(4), x_scale=[0.1, 0.1, 0.01, 0.01])
    c, d = geom(sol.x)
    q = p - c; t = q @ d; r = np.linalg.norm(q - np.outer(t, d), axis=1)
    A = np.c_[np.ones(len(t)), t]; coef, *_ = np.linalg.lstsq(A, r, rcond=None)
    # move c to the middle of the points along the axis
    c = c + d * t.mean()
    return c, d, float(coef[0] + coef[1] * t.mean()), float(coef[1]), float(np.sqrt(np.mean(sol.fun ** 2)))


def smoothstep(x):
    x = np.clip(x, 0, 1); return x * x * (3 - 2 * x)
