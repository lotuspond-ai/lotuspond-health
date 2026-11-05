"""Organs fit, part 4: suprarenal (adrenal) glands.

The trunk warp distorts the small glands (it bends strongly between the HRA kidneys, liver and spleen: the left gland
comes out 1.5-2.5 times its volume), so each gland is placed with a similarity instead: the undistorted Z-Anatomy gland,
scaled, laid rigidly onto the warped one, then a pose search next to its kidney, a seat 2 mm off the kidney and a smooth
push-out off the other neighbours. The right gland takes the body's overall scale (the trunk warp's global similarity);
Z-Anatomy's left gland is 1.75 times the volume of its right one, which at body scale is 9-10 cm3, above the adult range
(each gland 4-6 cm3, the left usually slightly the larger): the left gland takes the uniform scale that makes it
LEFT_RIGHT times the right gland's volume. The rigid refinements later keep the gland-to-kidney gap at 1-5 mm.

The pose search sees the HRA organs only; the crura of the diaphragm are fitted later (stage 3) and cannot give way
much (they lie on the vertebral bodies). When the searched pose still lies in the crus of the warped Z-Anatomy diaphragm
(the crus's place before the fit; the male left gland: the warp seats it 9.6 mm into the HRA spleen, the 15 mm search
then took it back between the spine and the kidney, into the crus, where the stage-3 sheet and the later rigid
refinements could not clear it: 19 % of its surface 3.9 mm inside the crus, 7.6 % in the spine), free_space_seat
re-seats it: a multi-start rigid search (turns up to 45 degrees, shifts up to 24 mm) on a lattice of the distance to
everything around it, the warped diaphragm included, so that the gland ends on its kidney's superomedial pole in front
of the crus, where the crus fitted afterwards has room behind it.
"""
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import sample_surface, dense_points, orient_outward
from lib.register import umeyama, icp, Sim
from fit.organs_data import hra, field, za_original, log
from fit.organs_geom import push_out

GAP_TARGET = 0.002
CLEAR = 0.0006
LEFT_RIGHT = 1.1     # left gland volume / right gland volume (adult glands: the left usually slightly the larger)
FREE_SEAT_SIDES = ('l',)   # glands that get the wide free-space seat when the local search leaves them in the crus: the
                           # left one (its warp seat lies in the HRA spleen); the right one is boxed in behind the IVC by
                           # the liver's bare area and the kidney, and its diaphragm-stage re-seat keeps it behind the IVC


def _volume(v, f):
    return abs(float(np.einsum('ij,ij->i', v[f[:, 0]], np.cross(v[f[:, 1]], v[f[:, 2]])).sum() / 6))


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


def free_space_seat(v, f, kfl, others, c_seat, rot_max=np.radians(45), radius=0.024, h=0.00075, n_rot=150, seed=0, log_=None):
    """Rigid pose of the gland in the free space next to its kidney, searched widely: the minimum distance to every
    neighbour (`others`, Field-like) and the kidney's distance sampled once on a lattice (h) round the warp's seat
    c_seat; candidates = n_rot rotations within rot_max x a 3 mm grid of shifts within `radius`, scored by pose_energy's
    terms (neighbours within CLEAR, kidney nearer than 1.5 mm or farther than 3.5 mm, pull to the seat); the best ten
    refined by a random-descent of turns and shifts. Returns (moved vertices, report)."""
    from scipy import ndimage
    rng = np.random.default_rng(seed)
    lo = c_seat - (radius + 0.022); n = np.full(3, int(np.ceil(2 * (radius + 0.022) / h)) + 1)
    g = [lo[i] + h * np.arange(n[i]) for i in range(3)]
    G = np.stack(np.meshgrid(*g, indexing='ij'), -1).reshape(-1, 3)
    OB = np.min([fl.coarse(G) for fl in others], axis=0).reshape(n).astype(np.float32)
    KD = kfl.coarse(G).reshape(n).astype(np.float32)
    look = lambda A, P: ndimage.map_coordinates(A, ((P - lo) / h).T, order=1, mode='nearest')
    P0 = sample_surface(v, f, 300, seed=2); c0 = v.mean(0)

    def energy(P):
        d = look(OB, P); dk = look(KD, P)
        return (float(np.sum(np.maximum(CLEAR - d, 0) ** 2)) + float(np.sum(np.maximum(0.0015 - dk, 0) ** 2))
                + len(P) * 0.2 * max(float(dk.min()) - 0.0035, 0) ** 2 + 0.25 * len(P) * 1e-2 * float(np.sum((P.mean(0) - c_seat) ** 2)))
    rots = [np.eye(3)]
    for _ in range(n_rot):
        ax = rng.normal(size=3); ax /= np.linalg.norm(ax)
        rots.append(rotvec(rot_max * rng.random() ** (1 / 3) * ax))
    gg = np.arange(-radius, radius + 1e-9, 0.003)
    T = np.stack(np.meshgrid(gg, gg, gg, indexing='ij'), -1).reshape(-1, 3); T = T[np.linalg.norm(T, axis=1) <= radius + 1e-9]
    cand = []
    for ri, R in enumerate(rots):
        Q = (P0 - c0) @ R.T + c_seat
        cand += [(energy(Q + t), ri, t) for t in T]
    cand.sort(key=lambda x: x[0])
    best = None
    for e, ri, t in cand[:10]:
        R = rots[ri]; t = t.copy()
        for _ in range(300):
            R2 = rotvec(rng.normal(size=3) * np.radians(3)) @ R; t2 = t + rng.normal(size=3) * 0.0008
            e2 = energy((P0 - c0) @ R2.T + c_seat + t2)
            if e2 < e: e, R, t = e2, R2, t2
        if best is None or e < best[0]: best = (e, R, t)
    e, R, t = best
    v2 = (v - c0) @ R.T + c_seat + t
    Q = (P0 - c0) @ R.T + c_seat + t
    rep = dict(energy=float(e), shift_from_seat_mm=round(float(np.linalg.norm(v2.mean(0) - c_seat) * 1000), 1),
               turn_deg=round(float(np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1)))), 1),
               lattice_min_clearance_mm=round(float(look(OB, Q).min() * 1000), 2), lattice_kidney_gap_mm=round(float(look(KD, Q).min() * 1000), 2))
    if log_: log_(f'    free-space seat: {rep}')
    return v2, rep


def crus_proxy(W):
    """The warped Z-Anatomy diaphragm as a Field (the crura's place before the stage-3 fit)."""
    from fit.organs_geom import mesh_field
    return mesh_field(*W['diaphragm'], 0.0006)


def penetration_depth(v, f, fields, n=3000):
    """Deepest penetration (m) of the gland's surface samples into any of the fields, and the share of samples inside."""
    P = sample_surface(v, f, n, seed=5)
    d = np.min([fl(P) for fl in fields], axis=0)
    return float(max(0.0, -d.min())), float((d < 0).mean())


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
    zvol = {s_: _volume(*za_original(f'adrenal_{s_}')) for s_ in 'lr'}
    # the right gland at the body's scale; the left one LEFT_RIGHT times the right one's volume (a uniform scale of
    # Z-Anatomy's left gland, which is 1.75 times its right one)
    scale = {'r': sg, 'l': sg * (LEFT_RIGHT * zvol['r'] / zvol['l']) ** (1.0 / 3.0)}
    for side in 'lr':
        zv, zf = za_original(f'adrenal_{side}')
        wv = W[f'adrenal_{side}'][0]
        c = zv.mean(0); zs = c + scale[side] * (zv - c)
        R = umeyama(zs, wv, scale=False)
        v = R(zs)
        kfl = field(sex, f'kidney_{side}')
        v0 = v.copy()
        names = ['ivc', 'liver', 'spleen', 'pancreas', 'aorta', 'duodenum', 'colon', 'celiac', 'spine']
        others = [field(sex, k) for k in names] + [fl for _, fl in extra]
        v = search_pose(v, kfl, others, log_=log)
        v = search_pose(v, kfl, others, radius=0.003, step=0.001, angles=(0.0, 0.09), log_=log)
        # still in the crus of the warped diaphragm (or a neighbour): the wide free-space seat, the crus included
        crus = (crus_proxy(W) if side in FREE_SEAT_SIDES else None) if 'crus' not in rep else rep.pop('crus')
        depth, frac = penetration_depth(v, zf, others + ([crus] if crus is not None else []))
        free_rep = dict(before=dict(deepest_mm=round(depth * 1000, 2), inside_pct=round(frac * 100, 2)))
        if side in FREE_SEAT_SIDES and (depth > 0.001 or frac > 0.005):
            v_try, r_ = free_space_seat(v, zf, kfl, others + [crus], wv.mean(0), log_=log)
            d2, f2 = penetration_depth(v_try, zf, others + [crus])
            free_rep.update(search=r_, after=dict(deepest_mm=round(d2 * 1000, 2), inside_pct=round(f2 * 100, 2)))
            if d2 < depth:
                v = search_pose(v_try, kfl, others + [crus], radius=0.003, step=0.001, angles=(0.0, 0.09), log_=log)
                free_rep['used'] = True
        rep['crus'] = crus
        v = seat_on_kidney(v, kfl)
        seat = float(np.linalg.norm(v.mean(0) - v0.mean(0)))
        fields = [(kfl, 0.0012)] + [(fl, CLEAR) for fl in others]
        v2 = push_out(v, zf, fields, clearance=CLEAR, iters=12, log=log)
        out[side] = (v2, orient_outward(v2, zf))
        wvol = _volume(wv, zf)
        rep[side] = dict(scale=round(scale[side], 4), body_scale=round(sg, 4), warp_volume_ratio=round(wvol / zvol[side], 2),
                         za_volume_cm3=round(zvol[side] * 1e6, 2), volume_cm3=round(_volume(v2, zf) * 1e6, 2),
                         seat_shift_mm=round(seat * 1000, 2), pushout_max_mm=round(float(np.linalg.norm(v2 - v, axis=1).max() * 1000), 2),
                         free_space_seat=free_rep)
        log(f'  adrenal {side}: {rep[side]}')
    rep.pop('crus', None)
    return out, rep
