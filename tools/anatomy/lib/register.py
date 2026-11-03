"""Registration tools for fitting Z-Anatomy structures into a Visible Human (HRA) body.

  umeyama        least-squares similarity (scale, rotation, translation) between corresponding points
  icp            similarity/rigid ICP of points onto a surface, with outlier trimming
  Warp           smooth space deformation fitted to control-point pairs: a similarity followed by a 3D thin-plate
                 spline (biharmonic kernel |r|, scipy RBFInterpolator), with a smoothing term so noisy pairs bend it less
  nonrigid_icp   surface-to-surface fitting by repeated closest-point matching and progressively less stiff warps
"""
import numpy as np
from scipy.interpolate import RBFInterpolator
from scipy.spatial import cKDTree


class Sim:
    """x -> s R x + t"""

    def __init__(self, s=1.0, R=None, t=None):
        self.s = float(s); self.R = np.eye(3) if R is None else np.asarray(R, float); self.t = np.zeros(3) if t is None else np.asarray(t, float)

    def __call__(self, p):
        return self.s * (np.asarray(p) @ self.R.T) + self.t

    def then(self, other):
        """other(self(x))"""
        return Sim(other.s * self.s, other.R @ self.R, other.s * (other.R @ self.t) + other.t)

    def inverse(self):
        Ri = self.R.T; return Sim(1 / self.s, Ri, -(Ri @ self.t) / self.s)

    def __repr__(self):
        ang = np.degrees(np.arccos(np.clip((np.trace(self.R) - 1) / 2, -1, 1)))
        return f'Sim(s={self.s:.4f}, rot={ang:.1f}°, t={np.round(self.t, 4).tolist()})'


def umeyama(src, dst, scale=True, w=None):
    src = np.asarray(src, float); dst = np.asarray(dst, float)
    w = np.ones(len(src)) if w is None else np.asarray(w, float)
    w = w / w.sum()
    ms, md = w @ src, w @ dst
    xs, xd = src - ms, dst - md
    C = (xd * w[:, None]).T @ xs
    U, S, Vt = np.linalg.svd(C)
    D = np.eye(3); D[2, 2] = np.sign(np.linalg.det(U @ Vt))
    R = U @ D @ Vt
    var = (w * (xs ** 2).sum(1)).sum()
    s = (S * np.diag(D)).sum() / var if scale else 1.0
    return Sim(s, R, md - s * R @ ms)


def icp(src, dst_pts, init=None, iters=40, scale=True, trim=0.9, tol=1e-7, symmetric=True, dst_tree=None, scale_range=(0.85, 1.2)):
    """Align points `src` to the point cloud `dst_pts` (dense surface samples). Returns (Sim, rms residual).
    Scale is kept within scale_range times the initial scale (stops ICP from shrinking onto part of the target)."""
    T = init or Sim()
    s0 = T.s
    tree = dst_tree or cKDTree(dst_pts)
    src = np.asarray(src, float)
    prev = np.inf
    for _ in range(iters):
        p = T(src)
        d, j = tree.query(p)
        keep = d <= np.quantile(d, trim)
        P, Q = src[keep], dst_pts[j[keep]]
        if symmetric:
            # also pull dst points toward the moved source (helps when one surface is only partly covered)
            st = cKDTree(p)
            d2, k = st.query(dst_pts)
            keep2 = d2 <= np.quantile(d2, trim)
            P = np.concatenate([P, src[k[keep2]]]); Q = np.concatenate([Q, dst_pts[keep2]])
        T = umeyama(P, Q, scale=scale)
        if scale and not (scale_range[0] * s0 <= T.s <= scale_range[1] * s0):
            # refit with the scale clamped: rotation from the unscaled fit, translation from the centroids
            s = float(np.clip(T.s, scale_range[0] * s0, scale_range[1] * s0))
            R = umeyama(P, Q, scale=False).R
            T = Sim(s, R, Q.mean(0) - s * (R @ P.mean(0)))
        err = np.sqrt(np.mean(np.sum((T(P) - Q) ** 2, axis=1)))
        if abs(prev - err) < tol: break
        prev = err
    return T, err


class Warp:
    """Similarity `pre` followed by a thin-plate-spline displacement fitted to (pre(src) -> dst) pairs."""

    def __init__(self, src, dst, pre=None, smoothing=0.0, max_points=5000, seed=0):
        self.pre = pre or Sim()
        src = np.asarray(src, float); dst = np.asarray(dst, float)
        if len(src) > max_points:
            idx = np.random.default_rng(seed).choice(len(src), max_points, replace=False); src, dst = src[idx], dst[idx]
        x = self.pre(src)
        # merge near-duplicate centres: RBF systems become singular otherwise
        _, uniq = np.unique(np.round(x / 1e-5).astype(np.int64), axis=0, return_index=True)
        x, dst = x[uniq], dst[uniq]
        self.rbf = RBFInterpolator(x, dst - x, kernel='linear', degree=1, smoothing=smoothing)
        self.centres = x

    def __call__(self, p, chunk=200000):
        p = self.pre(np.asarray(p, float))
        out = np.empty_like(p)
        for i in range(0, len(p), chunk): out[i:i + chunk] = p[i:i + chunk] + self.rbf(p[i:i + chunk])
        return out


def nonrigid_icp(src_pts, dst_pts, pre=None, schedule=(1e2, 3e1, 1e1, 3, 1, 0.3), n_ctrl=1500, trim=0.92, seed=0, fixed=None):
    """Deform `src_pts` onto the surface sampled by `dst_pts`. Each stage matches every source point to its closest
    destination point (and destination points back to the source), then fits a TPS warp with the given smoothing
    (large = stiff). `fixed` adds (src, dst) pairs that every stage must honour (e.g. joint centres).
    Returns a callable mapping original-space points to the fitted positions."""
    rng = np.random.default_rng(seed)
    pre = pre or Sim()
    tree_d = cKDTree(dst_pts)
    stages = []
    cur = pre(src_pts)
    def total(p):
        q = pre(p)
        for w in stages: q = w(q)
        return q
    for sm in schedule:
        d, j = tree_d.query(cur)
        keep = d <= np.quantile(d, trim)
        S = cur[keep]; D = dst_pts[j[keep]]
        tree_s = cKDTree(cur); d2, k = tree_s.query(dst_pts); keep2 = d2 <= np.quantile(d2, trim)
        S = np.concatenate([S, cur[k[keep2]]]); D = np.concatenate([D, dst_pts[keep2]])
        if len(S) > n_ctrl:
            idx = rng.choice(len(S), n_ctrl, replace=False); S, D = S[idx], D[idx]
        if fixed is not None:
            fs, fd = fixed; fs_cur = total(np.asarray(fs, float))
            S = np.concatenate([S, np.repeat(fs_cur, 20, axis=0)]); D = np.concatenate([D, np.repeat(np.asarray(fd, float), 20, axis=0)])
        w = Warp(S, D, smoothing=sm * len(S) * 1e-6, max_points=10 ** 9)
        stages.append(w)
        cur = w(cur)
    return total


def rotation_between(a, b):
    """Rotation matrix turning direction a onto direction b."""
    a = np.asarray(a, float) / np.linalg.norm(a); b = np.asarray(b, float) / np.linalg.norm(b)
    v = np.cross(a, b); c = float(a @ b)
    if np.linalg.norm(v) < 1e-12:
        if c > 0: return np.eye(3)
        p = np.cross(a, [1, 0, 0]);
        if np.linalg.norm(p) < 1e-6: p = np.cross(a, [0, 1, 0])
        p /= np.linalg.norm(p); return 2 * np.outer(p, p) - np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K * (1 / (1 + c))


def rotate_about(p, R, centre):
    return (np.asarray(p) - centre) @ R.T + centre
