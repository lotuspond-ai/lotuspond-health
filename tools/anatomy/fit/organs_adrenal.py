"""Organs fit, part 4: suprarenal (adrenal) glands.

The trunk warp distorts the small glands (it bends strongly between the HRA kidneys, liver and spleen: the left gland
comes out 1.5-2.5 times its volume), so each gland is placed with a similarity instead: the one that aligns the
Z-Anatomy kidney of that side with the HRA kidney (ICP, started from the warp's best similarity at the kidney). The gland
keeps its shape, size relative to the kidney, and its seat on the kidney's superomedial pole. A rigid refinement then
sets the gland-to-kidney gap (1-5 mm, aiming at 2 mm) and moves it off its other neighbours; a final smooth push-out
removes what a rigid motion cannot.
"""
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import sample_surface, dense_points, orient_outward
from lib.register import umeyama, icp, Sim
from fit.organs_data import hra, field, za_original, log
from fit.organs_geom import push_out

GAP_TARGET = 0.002
CLEAR = 0.0006


def kidney_similarity(sex, side, W):
    """Similarity mapping Z-Anatomy space onto the HRA kidney of this side."""
    zv, zf = za_original(f'ref_kidney_{side}')
    wv = W[f'ref_kidney_{side}'][0]
    S0 = umeyama(zv, wv, scale=True)                      # the warp's best similarity at the kidney
    hv, hf = hra(sex, f'kidney_{side}_capsule')
    H = dense_points(hv, hf, 0.001); tree = cKDTree(H)
    Z = sample_surface(zv, zf, 4000, seed=1)
    # the kidney sets position and orientation; the size is the body's overall scale (the trunk warp's global
    # similarity): the HRA kidneys are much thicker than Z-Anatomy's, and matching them would inflate the gland
    import os
    from fit.common import FIT
    sg = float(np.load(os.path.join(FIT, sex, 'warp-trunk.npz'))['s'])
    T, err = icp(Z, H, init=S0, iters=80, scale=True, trim=0.95, symmetric=True, dst_tree=tree, scale_range=(sg / S0.s, sg / S0.s))
    return T, err, S0


def rigid_refine(v, kfl, others, iters=60, log_=None):
    """Rigid motion of the gland: nearest kidney gap -> GAP_TARGET, other neighbours cleared by CLEAR."""
    v = v.copy()
    for it in range(iters):
        src, dst, w = [v], [v], [np.full(len(v), 0.02)]      # weak anchor: everything stays put unless pushed
        dk = kfl(v)
        near = dk < GAP_TARGET + 0.0015
        # kidney: vertices nearer than the target move out to it; if the gland floats, its nearest vertices move in
        if dk.min() > GAP_TARGET + 0.0005:
            near = dk < dk.min() + 0.0015
        nk, q = kfl.outward(v[near])
        tgt = v[near] + (GAP_TARGET - dk[near])[:, None] * nk
        # the gap to the kidney must stay >= 1 mm: vertices nearer than 1.2 mm weigh 4x
        src.append(v[near]); dst.append(tgt); w.append(np.where(dk[near] < 0.0012, 4.0, 1.0))
        worst = 0.0
        for fl in others:
            s = fl.coarse(v); cand = s < CLEAR + 0.004
            if not cand.any(): continue
            sd = fl(v[cand]); m = sd < CLEAR
            if not m.any(): continue
            ii = np.flatnonzero(cand)[m]
            n, _ = fl.outward(v[ii])
            src.append(v[ii]); dst.append(v[ii] + (CLEAR - sd[m])[:, None] * n); w.append(np.full(len(ii), 1.0))
            worst = max(worst, float(CLEAR - sd[m].min()))
        S, D, Wt = np.concatenate(src), np.concatenate(dst), np.concatenate(w)
        T = umeyama(S, D, scale=False, w=Wt)
        v_new = T(v)
        step = np.linalg.norm(v_new - v, axis=1).max()
        v = v_new
        if log_ and (it % 10 == 0 or step < 2e-5): log_(f'    rigid {it}: kidney gap {dk.min() * 1000:.2f} mm, worst other {worst * 1000:.2f} mm, step {step * 1000:.3f} mm')
        if step < 2e-5: break
    return v


def rotvec(w):
    th = np.linalg.norm(w)
    if th < 1e-12: return np.eye(3)
    k = w / th; K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * K @ K


def pose_energy(P, kfl, others, c0, lam=0.25, extra=None):
    """Penetration energy of gland points P (m^2): other organs within CLEAR, kidney nearer than 1.5 mm or farther
    than 3.5 mm at its closest, plus a pull to the warp's seat (lam per m^2 of centroid shift)."""
    e = 0.0
    for fl in others:
        d = fl.coarse(P); e += float(np.sum(np.maximum(CLEAR - d, 0) ** 2))
    dk = kfl.coarse(P)
    e += float(np.sum(np.maximum(0.0015 - dk, 0) ** 2)) + len(P) * 0.2 * max(dk.min() - 0.0035, 0) ** 2
    e += lam * len(P) * 1e-2 * float(np.sum((P.mean(0) - c0) ** 2))
    if extra is not None: e += extra(P)
    return e


def search_pose(v, kfl, others, radius=0.015, step=0.003, angles=(0.0, 0.26), log_=None, extra=None):
    """Rigid pose of the gland in the free space next to the kidney: candidates translated within `radius` of the warp's
    seat (on a grid) and turned by +-15 degrees about each axis; the lowest pose_energy wins. Returns the moved vertices."""
    rng = np.random.default_rng(0)
    P = v[rng.choice(len(v), min(400, len(v)), replace=False)]
    c = v.mean(0)
    rots = [np.eye(3)]
    for a in angles[1:]:
        for ax in np.eye(3):
            rots += [rotvec(a * ax), rotvec(-a * ax)]
    g = np.arange(-radius, radius + 1e-9, step)
    T = np.stack(np.meshgrid(g, g, g, indexing='ij'), -1).reshape(-1, 3)
    T = T[np.linalg.norm(T, axis=1) <= radius + 1e-9]
    best = (pose_energy(P, kfl, others, c, extra=extra), np.eye(3), np.zeros(3))
    for R in rots:
        Q = (P - c) @ R.T + c
        for t in T:
            e = pose_energy(Q + t, kfl, others, c, extra=extra)
            if e < best[0]: best = (e, R, t)
    e, R, t = best
    if log_: log_(f'    pose search: energy {e:.3e}, shift {np.linalg.norm(t) * 1000:.1f} mm, rotation {np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))):.0f} deg')
    return (v - c) @ R.T + c + t


def seat_on_kidney(v, kfl, target=GAP_TARGET, iters=40):
    """Translate the gland along the kidney's outward normal (averaged under the gland) until its nearest point is
    `target` from the kidney surface."""
    for _ in range(iters):
        dk = kfl(v)
        near = dk < dk.min() + 0.003
        n, _ = kfl.outward(v[near])
        dirn = n.mean(0); dirn /= np.linalg.norm(dirn)
        step = target - dk.min()
        if abs(step) < 2e-5: break
        v = v + 0.9 * step * dirn
    return v


def fit_adrenals(sex, W, extra=()):
    """extra: (name, Field) of our own fitted neighbours (diaphragm, stomach). Returns {side: (v, f)}, report.
    The trunk warp puts each gland on its HRA kidney (the kidneys anchor the warp) but inflates it; the undistorted
    Z-Anatomy gland, scaled by the body's overall scale, is laid rigidly onto the warped one (least squares), then seated
    2 mm off the kidney along the kidney's normal, then pushed off the other neighbours with a smooth displacement."""
    import os
    from fit.common import FIT
    sg = float(np.load(os.path.join(FIT, sex, 'warp-trunk.npz'))['s'])
    out, rep = {}, {}
    for side in 'lr':
        zv, zf = za_original(f'adrenal_{side}')
        wv = W[f'adrenal_{side}'][0]
        c = zv.mean(0); zs = c + sg * (zv - c)
        R = umeyama(zs, wv, scale=False)
        v = R(zs)
        kfl = field(sex, f'kidney_{side}')
        v0 = v.copy()
        names = ['ivc', 'liver', 'spleen', 'pancreas', 'aorta', 'duodenum', 'colon', 'celiac', 'spine']
        others = [field(sex, k) for k in names] + [fl for _, fl in extra]
        v = search_pose(v, kfl, others, log_=log)
        v = search_pose(v, kfl, others, radius=0.003, step=0.001, angles=(0.0, 0.09), log_=log)
        v = seat_on_kidney(v, kfl)
        seat = float(np.linalg.norm(v.mean(0) - v0.mean(0)))
        fields = [(kfl, 0.0012)] + [(fl, CLEAR) for fl in others]
        v2 = push_out(v, zf, fields, clearance=CLEAR, iters=12, log=log)
        out[side] = (v2, orient_outward(v2, zf))
        wvol = abs(float(np.einsum('ij,ij->i', wv[zf[:, 0]], np.cross(wv[zf[:, 1]], wv[zf[:, 2]])).sum() / 6))
        zvol = abs(float(np.einsum('ij,ij->i', zv[zf[:, 0]], np.cross(zv[zf[:, 1]], zv[zf[:, 2]])).sum() / 6))
        rep[side] = dict(scale=round(sg, 4), warp_volume_ratio=round(wvol / zvol, 2), seat_shift_mm=round(seat * 1000, 2),
                         pushout_max_mm=round(float(np.linalg.norm(v2 - v, axis=1).max() * 1000), 2))
        log(f'  adrenal {side}: {rep[side]}')
    return out, rep
