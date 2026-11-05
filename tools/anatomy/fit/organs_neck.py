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
    """The gland: cartilage similarity, slide so the isthmus lies over tracheal rings 2-4, growth to adult size about
    the isthmus (organs_thyroid: upper poles to the laminae's oblique lines, lower poles to ring 5, thickened about
    its bed), push-out and seating on the airway; the parathyroids follow and are reshaped to adult glands."""
    from fit.organs_thyroid import isthmus_depth, grow_gland, place_gland, pth_shape, seat_pth, seat_pth_field, frame, PTH_EXT, unfold_union, CLEAR
    from lib.mesh import signed_volume
    from fit.organs_geom import vertex_normals
    rep = {}
    T = neck_similarity(sex, W, rep)
    c0, a = airway_axis(sex)
    zv, tf = za_original('thyroid')
    from fit.organs_geom import refine_long_edges
    rep['za_vertices'] = len(zv)
    zv, tf = refine_long_edges(zv, tf, 0.0011)              # finer mesh: the gland is stretched up to 2.3x along the airway
    tv = T(zv)
    rep['za_volume_cm3'] = round(abs(signed_volume(zv, tf)) * 1e6, 2); rep['similarity_volume_cm3'] = round(abs(signed_volume(tv, tf)) * 1e6, 2)
    # Z-Anatomy seats the gland on the thyroid cartilage, its lower border at the cricoid: slide it down the airway axis
    # until the isthmus centre lies over the middle of tracheal rings 2-4, then back until the isthmus rests on them
    rings = ring_profile(sex, c0, a); below = [(a0, a1) for a0, a1 in rings if a0 >= -0.001]
    depth = isthmus_depth(below, ISTHMUS_DEPTH)
    ic, _ = isthmus(tv, sex, (c0, a))
    shift = float(depth - (ic - c0) @ a)
    tv = tv + shift * a
    hull = airway_field(sex)
    ic, im = isthmus(tv, sex, (c0, a))
    ap, lat = frame(a)
    gap = float(hull(tv[im]).min())
    tv = tv - (gap - 0.0005) * ap
    rep['isthmus_depth_mm'] = round(depth * 1000, 1)
    rep['slide_down_airway_mm'] = round(-shift * 1000, 1); rep['isthmus_ap_shift_mm'] = round(-(gap - 0.0005) * 1000, 2)
    s_i = float((isthmus(tv, sex, (c0, a))[0] - c0) @ a)
    grown, pmap = grow_gland(sex, tv, tf, c0, a, s_i, below, hull, rep)
    rep['grown_volume_cm3'] = round(abs(signed_volume(grown, tf)) * 1e6, 2)
    airway = [field(sex, k) for k in ('thyroid_cart', 'cricoid', 'trachea', 'trach_cart')]
    tv2, nb = place_gland(sex, grown, tf, c0, a, hull, airway, rep, extra_fields)
    tf = orient_outward(tv2, tf)
    placed = tv2                                            # vertex for vertex with `grown`: carries the parathyroids
    # the placement presses one sheet of a lobe through another where the lobe wraps the airway: one closed sheet round
    # the gland's own volume instead (organs_thyroid.unfold_union), the clearances kept
    fields = [(hull, CLEAR)] + [(fl, CLEAR) for fl in airway] + [(fl, c) for _, fl, c in nb] + [(fl, CLEAR) for fl in extra_fields]
    (tv2, tf), rep['unfold'] = unfold_union(tv2, tf, fields)
    thy = (tv2, tf)
    rep['volume_cm3'] = round(abs(signed_volume(tv2, tf)) * 1e6, 2)
    # parathyroids: their centres follow the gland's growth and placement; each is reshaped to an adult gland and laid
    # on the posterior surface of its lobe (0.3 mm off it)
    tfl = mesh_field(tv2, tf, 0.0003, pad=0.01)
    vn = vertex_normals(tv2, tf)
    rl = tv2 - c0; xl = rl @ lat
    pth, prep = {}, {}
    for k in PTH:
        v, f = za_original(k)
        v = T(v) + shift * a - (gap - 0.0005) * ap
        c = pmap(v.mean(0)[None])[0]
        _, j = cKDTree(grown).query(c, k=8)
        c = c + (placed[j] - grown[j]).mean(0)
        sg = 1 if k.endswith('_l') else -1
        # the lobe's posterior surface (facing back) on the gland's own side: its point nearest the carried centre
        cand = np.flatnonzero((vn @ ap < -0.35) & (sg * xl > 0.004))
        i = cand[int(np.argmin(np.linalg.norm(tv2[cand] - c, axis=1)))]
        nrm = vn[i] / np.linalg.norm(vn[i])
        centre = tv2[i] + nrm * (0.5 * PTH_EXT[2] + GAP_PTH)
        w = pth_shape(v, f, centre, nrm, a)
        w = seat_pth(seat_pth_field(w, f, tfl, GAP_PTH), f, thy, GAP_PTH)
        pth[k] = (w, orient_outward(w, f))
        prep[k] = dict(carried_to_seat_mm=round(float(np.linalg.norm(tv2[i] - c) * 1000), 2), seat=np.round(tv2[i], 4).tolist())
    rep['parathyroids'] = prep
    rep['parathyroid_source'] = {k: ZA_NAMES.get(k) for k in PTH}
    return thy, pth, rep, tfl, (c0, a)
