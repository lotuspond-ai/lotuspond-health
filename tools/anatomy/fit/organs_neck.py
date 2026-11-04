"""Organs fit, part 3: thyroid gland and parathyroid glands.

The thyroid wraps the larynx and upper trachea, so it follows them: the Z-Anatomy thyroid and cricoid cartilages and the
trachea go through the trunk warp, each is aligned to its HRA counterpart on its own (similarity ICP, symmetric) and its
samples are projected onto the HRA surface; a thin-plate spline through those pairs carries the warped thyroid into the
HRA neck. What is still inside a cartilage or the trachea is pushed out with a smooth, shape-preserving displacement.
Each parathyroid gland follows the same local warp, then slides rigidly along the thyroid's surface normal until it lies
on the posterior surface of its lobe (0.3 mm off it): a gland keeps its shape and never enters the thyroid.
"""
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import sample_surface, dense_points, components, orient_outward
from lib.register import Sim, icp, Warp, umeyama
from fit.organs_data import hra, field, log, za_original, ZA_NAMES
from fit.organs_geom import Field, push_out, mesh_field

PTH = ['pth_sup_l', 'pth_sup_r', 'pth_inf_l', 'pth_inf_r']
ISTHMUS_DEPTH = 0.014          # isthmus centre below the cricoid's lower border along the airway (rings 2-4)
GAP_PTH = 0.0003


def neck_similarity(sex, W, rep):
    """Similarity from Z-Anatomy space onto the HRA larynx and cervical trachea: started from the trunk warp's best
    similarity at these cartilages, refined by ICP onto the HRA thyroid cartilage, cricoid and cervical trachea."""
    cric_lo = hra(sex, 'cricoid')[0][:, 1].min()
    Z, Zw, H = [], [], []
    for zk, hk in (('ref_thyroid_cart', 'thyroid_cart'), ('ref_cricoid', 'cricoid'), ('ref_trachea', 'trachea')):
        zv, zf = za_original(zk); wv = W[zk][0]; hv, hf = hra(sex, hk)
        if hk == 'trachea':
            # only the cervical trachea, which the thyroid wraps (5.5 cm below the cricoid)
            keep_z = np.all(wv[zf][:, :, 1] > cric_lo - 0.055, axis=1); zf = zf[keep_z]
            keep_h = np.all(hv[hf][:, :, 1] > cric_lo - 0.06, axis=1); hf = hf[keep_h]
        used = np.unique(zf)
        Z.append(zv[used]); Zw.append(wv[used]); H.append(dense_points(hv, hf, 0.0005))
        zs = sample_surface(zv, zf, 1500, seed=1); Z.append(zs); Zw.append(None)
    S0 = umeyama(np.concatenate([z for z, w in zip(Z, Zw) if w is not None]), np.concatenate([w for w in Zw if w is not None]), scale=True)
    Zs = np.concatenate([z for z, w in zip(Z, Zw) if w is None]); Hs = np.concatenate(H)
    T, err = icp(Zs, Hs, init=S0, iters=80, scale=True, trim=0.9, symmetric=True, scale_range=(0.97, 1.03))
    d = cKDTree(Hs).query(T(Zs))[0]
    rep['cartilage_similarity'] = dict(warp_similarity_scale=round(S0.s, 4), icp_scale=round(T.s, 4), icp_rms_mm=round(err * 1000, 2),
                                       mean_mm=round(float(d.mean() * 1000), 2), p90_mm=round(float(np.quantile(d, 0.9) * 1000), 2))
    return T


def airway_field(sex):
    """Solid of the larynx and trachea: the cartilages and trachea with each horizontal slice filled to its convex hull,
    so the gland is pushed out laterally (never through the thin thyroid laminae into the larynx)."""
    from fit.organs_data import cache_dir
    import os
    from lib.mesh import merge
    from fit.organs_geom import Field
    cric = hra(sex, 'cricoid')[0]
    m = merge([hra(sex, k) for k in ('thyroid_cart', 'cricoid', 'trachea', 'trach_cart')])
    v, f = m
    keep = np.all(v[f][:, :, 1] > cric[:, 1].min() - 0.07, axis=1)
    from lib.mesh import compact
    v, f = compact(v, f[keep])
    return Field.cached(v, f, 0.0005, os.path.join(cache_dir(sex), 'field-airway-hull.npz'), slice_axis=1)


def tracheal_rings(sex):
    """Tracheal cartilage rings top to bottom: list of dict(y_top, y_bottom, centre). Components whose centres lie
    within 2.5 mm in height are one ring (some rings are split)."""
    v, f = hra(sex, 'trach_cart')
    comps = components(v, f)
    cs = []
    for c in comps:
        p = v[np.unique(f[c])]
        if len(p) < 30: continue
        cs.append((p[:, 1].mean(), p))
    cs.sort(key=lambda x: -x[0])
    rings = []
    for y, p in cs:
        if rings and abs(rings[-1]['yc'] - y) < 0.0025:
            r = rings[-1]; r['p'] = np.concatenate([r['p'], p]); r['yc'] = r['p'][:, 1].mean()
        else: rings.append(dict(yc=y, p=p))
    out = []
    for r in rings:
        p = r['p']; out.append(dict(y_top=float(p[:, 1].max()), y_bottom=float(p[:, 1].min()), centre=p.mean(0).tolist(), front_z=float(p[:, 2].max())))
    return out


def isthmus(v, sex, axis=None):
    """Isthmus of a thyroid mesh: the lowest 8 mm (along the airway) of the gland's anterior midline band (a pyramidal
    lobe, when present, rises from it). Returns (centre, mask)."""
    c0, a = axis if axis is not None else airway_axis(sex)
    ap = np.cross(a, [1.0, 0, 0]); ap = ap if ap[2] > 0 else -ap
    lat = np.cross(ap, a)
    r = v - c0; s = r @ a
    band = (np.abs(r @ lat) < 0.004) & (r @ ap > 0)
    m = band & (s > s[band].max() - 0.008)
    return v[m].mean(0), m


def airway_axis(sex):
    """(c0, a): centre of the cricoid's lower border and the unit direction down the cervical trachea (line through the
    centroids of 2 mm slices of the trachea from the cricoid down 6 cm)."""
    cv = hra(sex, 'cricoid')[0]; tv = hra(sex, 'trachea')[0]
    y0 = cv[:, 1].min()
    cs = []
    for y in np.arange(y0 - 0.06, y0 + 0.0001, 0.002):
        m = np.abs(tv[:, 1] - y) < 0.001
        if m.sum() > 10: cs.append(tv[m].mean(0))
    cs = np.array(cs)
    a = np.linalg.svd(cs - cs.mean(0))[2][0]
    a = a if a[1] < 0 else -a
    # the cricoid's lower border: its lowest 3 % along the axis
    s = (cv - cs.mean(0)) @ a
    lb = cv[s > np.quantile(s, 0.97)]
    c0 = cs.mean(0) + (float((lb.mean(0) - cs.mean(0)) @ a)) * a
    return c0, a


def ring_profile(sex, c0, a):
    """Tracheal rings along the airway from the anterior midline cartilage profile: list of (start, end) distances below
    the cricoid's lower border (m), ring 1 first."""
    from lib.mesh import sample_surface
    v, f = hra(sex, 'trach_cart')
    p = sample_surface(v, f, 60000, seed=0)
    s = (p - c0) @ a
    r = (p - c0) - s[:, None] * a
    ap = np.cross(a, [1.0, 0, 0]); ap = ap if ap[2] > 0 else -ap
    lat = np.cross(ap, a)
    ant = p[(r @ ap > 0.004) & (np.abs(r @ lat) < 0.006)]
    sa = (ant - c0) @ a
    bins = np.arange(sa.min() - 0.0005, sa.max() + 0.001, 0.0005)
    h, e = np.histogram(sa, bins=bins)
    hs = np.convolve(h, np.ones(3) / 3, mode='same')
    thr = 0.35 * np.median(hs[hs > 0])
    rings, start = [], None
    for i, x in enumerate(hs):
        if x > thr and start is None: start = e[i]
        if x <= thr and start is not None:
            if e[i] - start > 0.0015: rings.append((float(start), float(e[i])))
            start = None
    if start is not None: rings.append((float(start), float(e[-1])))
    return rings


def fit_neck(sex, W, extra_fields=()):
    rep = {}
    T = neck_similarity(sex, W, rep)
    c0, a = airway_axis(sex)
    zv, tf = za_original('thyroid')
    tv = T(zv)
    # Z-Anatomy seats the gland on the thyroid cartilage, its lower border at the cricoid: about 2 cm too high (the
    # isthmus belongs in front of tracheal rings 2-4, the lower poles at rings 5-6). Slide it down the airway axis until
    # the isthmus centre lies ISTHMUS_DEPTH below the cricoid's lower border, then back/forward until the isthmus rests
    # on the rings.
    ic, _ = isthmus(tv, sex, (c0, a))
    shift = float(ISTHMUS_DEPTH - (ic - c0) @ a)
    tv = tv + shift * a
    hull = airway_field(sex)
    ic, im = isthmus(tv, sex, (c0, a))
    ap = np.cross(a, [1.0, 0, 0]); ap = ap if ap[2] > 0 else -ap          # forward, perpendicular to the airway
    gap = float(hull(tv[im]).min())
    tv = tv - (gap - 0.0005) * ap
    rep['slide_down_airway_mm'] = round(-shift * 1000, 1); rep['isthmus_ap_shift_mm'] = round(-(gap - 0.0005) * 1000, 2)
    moved = tv.copy()
    fields = [(hull, None)] + [(field(sex, k), None) for k in ('thyroid_cart', 'cricoid', 'trachea', 'trach_cart')] + [(fl, None) for fl in extra_fields]
    tv2 = push_out(tv, tf, fields, clearance=0.0005, iters=16, log=log)
    rep['thyroid_pushed_max_mm'] = round(float(np.linalg.norm(tv2 - moved, axis=1).max() * 1000), 2)
    tf = orient_outward(tv2, tf)
    thy = (tv2, tf)
    # parathyroids: the same similarity and slide, then onto the posterior surface of the lobe
    tfl = mesh_field(tv2, tf, 0.0003, pad=0.01)
    pth = {}
    for k in PTH:
        v, f = za_original(k)
        v = T(v) + shift * a - (gap - 0.0005) * ap
        # follow the thyroid's push-out: displacement of the nearest thyroid vertices
        _, j = cKDTree(moved).query(v.mean(0), k=8)
        v = v + (tv2[j] - moved[j]).mean(0)
        for _ in range(80):
            sd = tfl(v)
            i = int(np.argmin(sd))
            nrm, q = tfl.outward(v[i:i + 1])
            step = GAP_PTH - sd[i]
            if abs(step) < 2e-5: break
            v = v + 0.8 * step * nrm[0]
        pth[k] = (v, orient_outward(v, f))
    rep['parathyroid_source'] = {k: ZA_NAMES.get(k) for k in PTH}
    return thy, pth, rep, tfl, (c0, a)
