"""Organs fit, part 3b: the thyroid gland at adult size on its larynx and trachea, and the parathyroid glands.

Z-Anatomy's gland (4.8 cm3, lobes about 3 cm long, the isthmus at the lobes' lower ends) is a third of adult size. After
the cartilage similarity and the slide that puts the isthmus over tracheal rings 2-4 (organs_neck), the gland is grown
about its isthmus to the landmarks that bound it in life:
  * along the airway, piecewise about the isthmus centre: the upper poles reach the oblique line of the thyroid lamina
    (the lower third of the lamina at the lobe's footprint), the lower poles the middle of tracheal ring 5; the midline
    (isthmus and pyramidal lobe) grows less (PYR_STRETCH), blended to the lobes over the lobes' medial edges;
  * across, by thickening about its bed: every point moves away from the airway by THICKEN - 1 times its distance from
    the larynx / trachea, so the surfaces on the airway stay on it and the gland gets THICKEN times thicker;
then pushed out of the airway, the cricothyroid muscles, the carotid sheaths' vessels and the oesophagus with a smooth
(bi-Laplacian) displacement, and laid back onto its bed (isthmus and pyramidal lobe on the cricoid arch and trachea,
lobes' medial surfaces on the airway) with soft attraction targets solved together with the push-out.
Each parathyroid follows the same growth at its centre, is reshaped to an adult gland (a flattened oval PTH_EXT, about
30 mm3, its flat side on the lobe, its long axis along the lobe) and slid onto the lobe's posterior surface.
"""
import os, json, pickle
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import sample_surface, dense_points, orient_outward, merge, load, signed_volume, compact
from fit.organs_data import hra, field, log, cache_dir, FIT, has_hra
from fit.organs_geom import Field, push_out, mesh_field, laplacian, smoothstep, vertex_normals, winding, is_closed

PYR_STRETCH = 1.2            # along-airway growth of the isthmus / pyramidal lobe band (the lobes take their own)
THICKEN = 1.45               # growth of the gland's thickness about its airway bed
K_RANGE = (1.0, 2.3)         # bounds on the lobes' along-airway stretch
LOBE_MAX = 0.058             # cap on a lobe's craniocaudal length (adult lobes are 4-6 cm)
OBLIQUE = 0.25               # upper pole target: this share of the lamina's height above its lower border
CLEAR = 0.0005               # clearance from the airway, cartilages, muscles and the oesophagus
CLEAR_VESSEL = 0.0010        # from the carotid arteries and jugular veins (the carotid sheath)
CLEAR_MUSCLE = 0.0008        # from the cricothyroid muscles (thin sheets: face samples come closer than vertices)
PTH_EXT = (0.0056, 0.0038, 0.0024)   # parathyroid gland: length, width, thickness (m)
PTH_VOL = 30e-9              # target volume (m3): adult glands are 25-40 mm3


def frame(a):
    ap = np.cross(a, [1.0, 0, 0]); ap = ap if ap[2] > 0 else -ap
    ap = ap / np.linalg.norm(ap)
    lat = np.cross(ap, a); lat = lat / np.linalg.norm(lat)
    if lat[0] < 0: lat = -lat
    return ap, lat


def local(p, c0, a):
    ap, lat = frame(a)
    r = np.asarray(p) - c0
    return r @ a, r @ lat, r @ ap


def isthmus_depth(rings_below, default=0.014):
    """Centre of tracheal rings 2-4 below the cricoid's lower border (m), from the anterior ring profile."""
    if len(rings_below) >= 4:
        return float(np.clip(0.5 * (rings_below[1][0] + rings_below[3][1]), 0.007, 0.02))
    return default


def lower_target(rings_below, s_i):
    """Lower poles: between tracheal rings 5 and 6 (Gray's: the poles reach ring 5 or 6)."""
    if len(rings_below) >= 6:
        return 0.5 * (rings_below[4][1] + rings_below[5][0])
    if len(rings_below) >= 5:
        return rings_below[4][1]
    return s_i + 0.012


def lower_min(rings_below, s_i):
    """The highest the lower poles are drawn up to when a lobe would be too long: tracheal ring 5 (its upper edge)."""
    if len(rings_below) >= 5:
        return rings_below[4][0]
    return s_i + 0.010


def lamina_target(sex, c0, a, P_top=None, sg=1):
    """The thyroid lamina on one side: (lower border s, height, target s for the lobe's upper pole: OBLIQUE of the
    height above the lower border, where the oblique line runs above the inferior thyroid tubercle). Read per 3 mm band
    front to back: the inferior horn is the band reaching lowest; the lamina proper is the three bands from 6 mm in
    front of it (medians of their lower borders and tops)."""
    th = hra(sex, 'thyroid_cart')[0]
    s, x, z = local(th, c0, a)
    lam = sg * x > 0.006
    rows = []
    for zb in np.arange(z[lam].min(), z[lam].max() + 1e-9, 0.003):
        m = lam & (np.abs(z - zb) < 0.0015)
        if m.sum() < 8: continue
        rows.append((zb, np.percentile(s[m], 98), np.percentile(s[m], 2)))
    rows = np.array(rows)
    horn = rows[int(np.argmax(rows[:, 1])), 0]
    ant = rows[rows[:, 0] >= horn + 0.006][:3]
    if len(ant) < 2: ant = rows[-3:]
    lb = float(np.median(ant[:, 1])); top = float(np.median(ant[:, 2]))
    H = lb - top
    return lb, H, lb - OBLIQUE * H


def stretch_fn(s_i, k_up, k_dn, k_mid, w=0.004):
    """Along-airway map t -> t' (t = s - s_i, the isthmus centre at 0) for points at lateral offset x: above the isthmus
    the lobes stretch by k_up[side], the midline band by k_mid; below by k_dn; blended smoothly (C1) across."""
    def f(s, x):
        t = s - s_i
        wl = smoothstep(np.clip((x - 0.004) / 0.006, 0, 1)); wr = smoothstep(np.clip((-x - 0.004) / 0.006, 0, 1))
        ku = wl * k_up[1] + wr * k_up[-1] + (1 - wl - wr) * k_mid
        kd = wl * k_dn[1] + wr * k_dn[-1] + (1 - wl - wr) * max(k_mid, 0.5 * (k_dn[1] + k_dn[-1]))
        b = smoothstep(np.clip((t + w) / (2 * w), 0, 1))
        k = ku + (kd - ku) * b
        return s_i + t * k
    return f


class SheathField:
    """The carotid sheath as seen by the gland, one-sided: the lobes lie anteromedial to it and never wrap round behind
    or beside it. The artery (a tube along the neck, read as a centreline with radii from slices across the airway axis)
    defines a wall: within a window of its width (plus WALL_MARGIN) the space behind the plane tangent to the artery's
    anteromedial side is closed to the gland, and its signed distance is measured along the anteromedial direction
    only, so a lobe the artery runs through is moved off it to one side (in front and medial), never split round it
    (a two-sided push-out leaves faces bridging the vessel). Field-like: coarse, __call__, outward."""

    def __init__(self, v, c0, a, step=0.0015, margin=0.004, depth=0.025):
        self.c0, self.a = np.asarray(c0, float), np.asarray(a, float)
        ap, lat = frame(a)
        s, x, z = local(v, c0, a)
        S, C, R = [], [], []
        for t in np.arange(s.min() + step / 2, s.max(), step):
            m = np.abs(s - t) < step
            if m.sum() < 6: continue
            c = v[m].mean(0); q = v[m] - c; q = q - np.outer(q @ self.a, self.a)
            S.append(t); C.append(c); R.append(np.median(np.linalg.norm(q, axis=1)))
        self.S, self.C, self.R = np.array(S), np.array(C), np.array(R)
        side = 1.0 if np.mean(x) > 0 else -1.0
        n = ap - 0.75 * side * lat; n = n - (n @ self.a) * self.a
        self.n = n / np.linalg.norm(n)
        self.e = np.cross(self.a, self.n)
        self.margin, self.depth = margin, depth

    def _eval(self, p):
        p = np.atleast_2d(np.asarray(p, float))
        if len(self.S) < 2: return np.ones(len(p)), np.tile(self.n, (len(p), 1)), p
        s = (p - self.c0) @ self.a
        ok = (s >= self.S[0]) & (s <= self.S[-1])
        c = np.stack([np.interp(s, self.S, self.C[:, k]) for k in range(3)], 1)
        r = np.interp(s, self.S, self.R)
        q = p - c
        t = q @ self.n; w = q @ self.e
        d = t - r
        inwin = ok & (np.abs(w) < r + self.margin) & (t > -r - self.depth)
        d = np.where(inwin, d, np.maximum(np.abs(d), 0.01))
        nrm = np.tile(self.n, (len(p), 1))
        return d, nrm, p - d[:, None] * nrm

    def coarse(self, p):
        return self._eval(p)[0]

    def __call__(self, p, band=None):
        return self._eval(p)[0]

    def outward(self, p):
        _, n, q = self._eval(p)
        return n, q


def neck_neighbours(sex):
    """Fields of what the gland lies against besides the airway: cricothyroid muscles (HRA in the male body, the larynx
    group's in the female one), the carotid arteries and jugular veins (vessels group, and the HRA carotid stumps that
    the assembly keeps), and our oesophagus (stage cache), as [(name, Field, clearance)]."""
    out = []
    mus = []
    for nm in ('cricothyroid_R', 'cricothyroid_L'):
        from fit.common import hra_mesh
        v, f = hra_mesh(sex, rf'^VH_[MF]_{nm}$')
        if len(f): mus.append((v, orient_outward(v, f)))
    lar = os.path.join(FIT, sex, 'larynx', 'manifest.json')
    if os.path.exists(lar):
        for o in json.load(open(lar)):
            if 'cricothyroid' in o['name']:
                v, f = load(os.path.join(FIT, sex, 'larynx', o['file'])); mus.append((v, f))
    if mus:
        v, f = merge(mus)
        out.append(('cricothyroid', Field.build(v, f, 0.0005, pad=0.006), CLEAR_MUSCLE))
    ves = []
    vd = os.path.join(FIT, sex, 'vessels', 'manifest.json')
    if os.path.exists(vd):
        for o in json.load(open(vd)):
            if 'common_carotid' in o['name'] or 'internal_jugular' in o['name'] or 'internal_carotid' in o['name']:
                ves.append((o['name'], load(os.path.join(FIT, sex, 'vessels', o['file']))))
    from fit.common import hra_mesh
    keep = ['brachiocephalic_artery_b', 'left_common_carotid_artery_a'] + (['left_common_carotid_artery_b'] if sex == 'female' else [])
    for nm in keep:
        v, f = hra_mesh(sex, rf'^VH_[MF]_{nm}$')
        if len(f): ves.append(('hra_' + nm, (v, f)))
    from fit.organs_neck import airway_axis
    c0, a = airway_axis(sex)
    for nm, (v, f) in ves:
        try:
            out.append((nm, Field.build(v, f, 0.0005, pad=0.006, cap=not is_closed(f)), CLEAR_VESSEL))
        except Exception as e:                                        # a vessel that does not voxelise: skip it, say so
            log(sex, f'  neck neighbour {nm} skipped: {e}'); continue
        if 'common_carotid' in nm or 'brachiocephalic' in nm:
            out.append((nm + ' (sheath)', SheathField(v, c0, a), CLEAR_VESSEL))
    es = os.path.join(cache_dir(sex), 'stage-esophagus.pkl')
    if os.path.exists(es):
        from fit.organs_gi import esophagus_field
        with open(es, 'rb') as fh: (ev, ef), erep = pickle.load(fh)
        out.append(('esophagus', esophagus_field(ev, ef, erep['centreline']), CLEAR))
    return out


def grow_gland(sex, tv, tf, c0, a, s_i, rings_below, hull, rep):
    """The along-airway stretch and the thickening (see the module docstring). Returns (new vertices, map of a point)."""
    s, x, z = local(tv, c0, a)
    k_up, k_dn, info = {}, {}, {}
    s_dn = lower_target(rings_below, s_i)
    for sg, nm in ((1, 'left'), (-1, 'right')):
        lobe = sg * x > 0.006
        U = s_i - s[lobe].min(); Lo = s[lobe].max() - s_i
        top = tv[lobe & (s < s[lobe].min() + 0.25 * (s[lobe].max() - s[lobe].min()))]
        lb, H, s_up = lamina_target(sex, c0, a, top, sg)
        s_lo = s_dn
        if s_lo - s_up > LOBE_MAX:
            # too long for an adult lobe (a long larynx: the male lamina's lower border lies 2.4 cm above the cricoid's):
            # the lower pole gives way first, up to tracheal ring 5 (the poles' range is rings 4-7), and
            # only past that the upper pole, which must reach the lamina's oblique line
            s_lo = max(lower_min(rings_below, s_i), s_up + LOBE_MAX)
            s_up = max(s_up, s_lo - LOBE_MAX)
        k_up[sg] = float(np.clip((s_i - s_up) / max(U, 1e-3), *K_RANGE))
        k_dn[sg] = float(np.clip((s_lo - s_i) / max(Lo, 1e-3), *K_RANGE))
        info[nm] = dict(upper_extent_mm=round(U * 1000, 1), lower_extent_mm=round(Lo * 1000, 1), lamina_lower_border_mm=round(lb * 1000, 1),
                        lamina_height_mm=round(H * 1000, 1), upper_target_mm=round(s_up * 1000, 1), lower_target_mm=round(s_lo * 1000, 1),
                        ring_5_6_mm=round(s_dn * 1000, 1), k_up=round(k_up[sg], 3), k_down=round(k_dn[sg], 3))
    f_s = stretch_fn(s_i, k_up, k_dn, PYR_STRETCH)

    def along(p):
        sp, xp, _ = local(p, c0, a)
        return p + (f_s(sp, xp) - sp)[:, None] * a
    v1 = along(tv)
    # thickening about the bed: away from the airway hull by (THICKEN - 1) x the distance to it
    d = hull(v1)
    q = hull.outward(v1)[1]
    dirn = v1 - q; dl = np.linalg.norm(dirn, axis=1)
    dirn = dirn / np.maximum(dl, 1e-9)[:, None]
    grow = (THICKEN - 1.0) * np.clip(d, 0.0, 0.03)
    # smooth the growth field over the mesh (a few Laplacian passes) so that it does not crease where the closest
    # airway point jumps (between the laminae and the trachea)
    disp = grow[:, None] * dirn
    for _ in range(20):
        disp = 0.5 * disp + 0.5 * _avg(tf, disp)
    v2 = v1 + disp
    rep['growth'] = dict(isthmus_centre_mm=round(s_i * 1000, 1), pyramidal_stretch=PYR_STRETCH, thicken=THICKEN, lobes=info,
                         thicken_max_mm=round(float(np.linalg.norm(disp, axis=1).max() * 1000), 2))

    def point_map(p):
        p1 = along(np.atleast_2d(p))
        _, j = cKDTree(v1).query(p1, k=6)
        return p1 + disp[j].mean(1)
    return v2, point_map


def _avg(f, x):
    """Mean of each vertex's neighbours (uniform umbrella), for smoothing a per-vertex field."""
    n = len(x)
    acc = np.zeros_like(x); cnt = np.zeros(n)
    for i, j in ((0, 1), (1, 2), (2, 0), (1, 0), (2, 1), (0, 2)):
        np.add.at(acc, f[:, i], x[f[:, j]]); np.add.at(cnt, f[:, i], 1)
    return acc / np.maximum(cnt, 1)[:, None]


def taubin(v, f, iters=10, lam=0.5, mu=-0.53):
    """Taubin (lambda|mu) smoothing of the whole surface: removes the creases the stretch and push-out leave without
    shrinking the gland."""
    v = v.copy()
    for _ in range(iters):
        for k in (lam, mu):
            v = v + k * (_avg(f, v) - v)
    return v


def inflate(v, f, fields, target, iters=10):
    """Give back the volume the push-out squeezed out (soft tissue pressed by its neighbours bulges where it is free):
    the surface moves out along its normals, only where it is more than 0.5 mm clear of every neighbour (full speed
    from 3 mm), by a smoothed uniform offset sized to the missing volume, never more than 80 % of its own gap."""
    f = orient_outward(v, f); v = v.copy()
    for _ in range(iters):
        vol = abs(signed_volume(v, f))
        if vol >= 0.995 * target: break
        n = vertex_normals(v, f)
        gap = np.full(len(v), 0.05)
        for fl, c in fields:
            sc = fl.coarse(v); near = sc < c + 0.006
            if near.any(): gap[near] = np.minimum(gap[near], fl(v[near]) - c)
        w = smoothstep(np.clip((gap - 0.0005) / 0.0025, 0, 1))
        fa = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
        A = np.zeros(len(v)); np.add.at(A, f.ravel(), np.repeat(fa / 3, 3))
        delta = min((target - vol) / max(float((w * A).sum()), 1e-12), 0.0015)
        disp = (delta * w)[:, None] * n
        for _ in range(6): disp = 0.5 * disp + 0.5 * _avg(f, disp)
        L_ = np.linalg.norm(disp, axis=1); cap = np.maximum(0.8 * gap, 0.0)
        disp *= np.minimum(1.0, cap / np.maximum(L_, 1e-12))[:, None]
        v = v + disp
    return v


def bed_targets(v, f, c0, a, beds, clear=CLEAR):
    """Attraction targets that lay the gland on its bed: the posterior surface of the isthmus / pyramidal band (|x| < 6
    mm, facing back, up to 12 mm off the bed) and the lobes' medial surfaces facing the airway (up to 4 mm off)."""
    n = vertex_normals(v, f)
    ap, lat = frame(a)
    s, x, z = local(v, c0, a)
    d = np.full(len(v), np.inf); q = v.copy()
    for fl in beds:
        dd = fl(v); m = dd < d
        if m.any():
            qq = fl.outward(v[m])[1]; d[m] = dd[m]; q[m] = qq
    towards = np.einsum('ij,ij->i', n, q - v) / np.maximum(np.linalg.norm(q - v, axis=1), 1e-9)
    mid = (np.abs(x) < 0.006) & (n @ ap < -0.3) & (d > clear) & (d < 0.012)
    med = (np.abs(x) >= 0.006) & (towards > 0.5) & (d > clear) & (d < 0.004)
    idx = np.flatnonzero(mid | med)
    u = (q[idx] - v[idx]) / np.maximum(np.linalg.norm(q[idx] - v[idx], axis=1), 1e-9)[:, None]
    tgt = v[idx] + (d[idx] - clear)[:, None] * u
    return idx, tgt, dict(midline=int(mid.sum()), medial=int(med.sum()), midline_gap_max_mm=round(float(d[mid].max() * 1000), 2) if mid.any() else 0.0)


def place_gland(sex, tv, tf, c0, a, hull, airway_fields, rep, extra_fields=()):
    """Push-out and bed seating, alternated: returns the final vertices."""
    nb = neck_neighbours(sex)
    rep['neighbours'] = [nm for nm, _, _ in nb]
    beds = [hull] + [fl for nm, fl, _ in nb if nm == 'cricothyroid']
    fields = [(hull, CLEAR)] + [(fl, CLEAR) for fl in airway_fields] + [(fl, c) for _, fl, c in nb] + [(fl, CLEAR) for fl in extra_fields]
    v = tv.copy()
    L, _ = laplacian(len(v), tf)
    seat = []
    others = [(fl, c) for nm, fl, c in nb]                 # a target on the cartilage under a muscle is not free

    def free(idx, tgt):
        ok = np.ones(len(idx), bool)
        for fl, c in others: ok &= fl(tgt) >= c
        return idx[ok], tgt[ok]
    for rnd in range(3):
        idx, tgt, info = bed_targets(v, tf, c0, a, beds)
        idx, tgt = free(idx, tgt); info['kept'] = int(len(idx))
        seat.append(info)
        v = push_out(v, tf, fields, clearance=CLEAR, iters=14, extra_targets=(idx, tgt, 0.6), L=L, log=None)
    v = taubin(v, tf, iters=8)
    idx, tgt, info = bed_targets(v, tf, c0, a, beds); idx, tgt = free(idx, tgt); info['kept'] = int(len(idx)); seat.append(info)
    v = push_out(v, tf, fields, clearance=CLEAR, iters=14, extra_targets=(idx, tgt, 0.3), L=L, log=None)
    v = push_out(v, tf, fields, clearance=CLEAR, iters=16, L=L, log=None)
    # the volume the push-out squeezed out comes back where the gland is free; folds faired; then the last word to the
    # clearances
    target = abs(signed_volume(tv, tf))
    rep['squeezed_volume_cm3'] = round(abs(signed_volume(v, tf)) * 1e6, 2)
    v = inflate(v, tf, fields, target)
    from fit.organs_geom import fair_folds
    v, nfair = fair_folds(v, tf, cos_max=0.5, rings=2, iters=20)
    rep['faired_vertices'] = nfair
    v = push_out(v, tf, fields, clearance=CLEAR, iters=12, L=L, log=None)
    rep['seat_rounds'] = seat
    rep['placed_max_move_mm'] = round(float(np.linalg.norm(v - tv, axis=1).max() * 1000), 2)
    return v, nb


def pth_shape(v, f, centre, normal, along):
    """Reshape a parathyroid to an adult gland: PCA axes of the Z-Anatomy gland mapped onto (along the lobe, across,
    the lobe's normal) with extents PTH_EXT, then scaled to PTH_VOL; centred on `centre`."""
    c = v.mean(0); X = v - c
    U = np.linalg.svd(X - X.mean(0), full_matrices=False)[2]          # rows: principal axes, longest first
    proj = X @ U.T
    ext = proj.max(0) - proj.min(0)
    sc = np.array(PTH_EXT) / np.maximum(ext, 1e-6)
    Y = proj * sc
    nrm = normal / np.linalg.norm(normal)
    e1 = along - (along @ nrm) * nrm; e1 /= np.linalg.norm(e1)
    e2 = np.cross(nrm, e1)
    R = np.stack([e1, e2, nrm])                                       # rows: target axes for PCA axes 0, 1, 2
    w = Y @ R
    vol = abs(signed_volume(w, f))
    w = w * (PTH_VOL / max(vol, 1e-15)) ** (1 / 3)
    return w + centre


def exact_sd(P, mesh):
    """Exact signed distance from points to a closed mesh: distance to its surface, negative inside (winding number).
    The gland's voxel field misreads the folds of the stretched lobes' surface (up to 1.3 mm false insides)."""
    from lib.mesh import closest_on_mesh
    _, d = closest_on_mesh(*mesh, P)
    w = winding(P, *mesh)
    return np.where(np.abs(w) > 0.5, -d, d)


def seat_pth_field(v, f, tfl, gap):
    """Slide a gland along the thyroid's normal until its nearest vertex lies `gap` off the gland's surface (voxel
    field: fast, but it misreads folds of the lobes' surface, so seat_pth follows with the exact distance)."""
    for _ in range(80):
        sd = tfl(v)
        i = int(np.argmin(sd))
        nrm, q = tfl.outward(v[i:i + 1])
        step = gap - sd[i]
        if abs(step) < 2e-5: break
        v = v + 0.8 * step * nrm[0]
    return v


def seat_pth(v, f, thy, gap, iters=4):
    """Exact clearance of a seated gland: while its nearest test point (vertices and the faces' samples) is closer than
    `gap` to the thyroid mesh (exact signed distance) the gland moves rigidly along that point's way out of the
    lobe (towards / away from its closest surface point) by the missing amount. Idempotent for a seated gland."""
    from lib.mesh import closest_on_mesh
    P = np.vstack([v, sample_surface(v, f, 800, seed=1)])
    shift = np.zeros(3)
    for _ in range(iters):
        q, d = closest_on_mesh(*thy, P + shift)
        sd = np.where(np.abs(winding(P + shift, *thy)) > 0.5, -d, d)
        i = int(np.argmin(sd))
        if sd[i] >= gap - 1e-5: break
        u = (q[i] - (P[i] + shift)) if sd[i] < 0 else ((P[i] + shift) - q[i])
        shift = shift + (gap - sd[i] + 2e-5) * u / max(np.linalg.norm(u), 1e-12)
    return v + shift


def thyroid_measures(sex, thy, pth, c0, a, nb=None):
    """Size, extent and contact measurements of the gland and the parathyroids (see measure() in organs.py)."""
    from fit.organs_neck import ring_profile, isthmus
    tv, tf = thy
    R = {}
    vol = abs(signed_volume(tv, tf)) * 1e6
    R['thyroid_volume_cm3'] = dict(value=round(vol, 2), threshold='10-18 (adult gland)', ok=bool(10 <= vol <= 18))
    s, x, z = local(tv, c0, a)
    rings = ring_profile(sex, c0, a); below = [(a0, a1) for a0, a1 in rings if a0 >= -0.001]
    p = dense_points(tv, tf, 0.0005); sp, xp, zp = local(p, c0, a)
    lob = {}
    for sg, nm in ((1, 'left'), (-1, 'right')):
        m = sg * xp > 0.006
        q = p[m]; cq = q - q.mean(0)
        U = np.linalg.svd(cq, full_matrices=False)[2]; pr = cq @ U.T
        ext = pr.max(0) - pr.min(0)
        top = q[sp[m] < sp[m].min() + 0.25 * (sp[m].max() - sp[m].min())]
        lb, H, s_up = lamina_target(sex, c0, a, top, sg)
        tip = float(sp[m].min()); low = float(sp[m].max())
        ring = None
        for j, (r0, r1) in enumerate(below):
            if low <= r1 + 0.0015: ring = j + 1; break
        lob[nm] = dict(pca_extents_mm=[round(float(e) * 1000, 1) for e in ext], long_axis=np.round(U[0], 2).tolist(),
                       length_along_airway_mm=round((low - tip) * 1000, 1), upper_pole_mm=round(tip * 1000, 1),
                       lamina_lower_border_mm=round(lb * 1000, 1), lamina_height_mm=round(H * 1000, 1),
                       upper_pole_onto_lamina_mm=round((lb - tip) * 1000, 1), upper_pole_share_of_lamina=round((lb - tip) / max(H, 1e-6), 2),
                       lower_pole_mm=round(low * 1000, 1), lower_pole_ring=ring)
    R['thyroid_lobe_length_mm'] = dict(value=[lob['right']['length_along_airway_mm'], lob['left']['length_along_airway_mm']],
                                       threshold='40-60 craniocaudal, along the airway (right, left)',
                                       ok=bool(all(40 <= lob[k]['length_along_airway_mm'] <= 60 for k in lob)), lobes=lob)
    up = [lob[k]['upper_pole_onto_lamina_mm'] for k in ('right', 'left')]
    sh = [lob[k]['upper_pole_share_of_lamina'] for k in ('right', 'left')]
    R['thyroid_upper_poles_on_lamina'] = dict(value=up, threshold='>= 4 mm onto the thyroid lamina, below its mid-height (right, left)',
                                              ok=bool(all(u >= 4 for u in up) and all(x_ <= 0.55 for x_ in sh)), share_of_lamina_height=sh,
                                              unit='mm above the lamina\'s lower border (along the airway) at the lobe\'s footprint')
    rr = [lob[k]['lower_pole_ring'] for k in ('right', 'left')]
    R['thyroid_lower_poles_ring'] = dict(value=rr, threshold='tracheal ring 4-7 (5-6 typical)', ok=bool(all(r is not None and 4 <= r <= 7 for r in rr)))
    # isthmus / pyramidal lobe on the airway: per 2 mm band along the airway, the gap between the midline band's back
    # surface and the airway's front
    air = np.concatenate([dense_points(*hra(sex, k), 0.0005) for k in ('thyroid_cart', 'cricoid', 'trach_cart', 'trachea')])
    sa, xa, za_ = local(air, c0, a)
    gaps = []
    for s0 in np.arange(sp.min(), sp.max(), 0.002):
        g = (np.abs(xp) < 0.003) & (sp >= s0) & (sp < s0 + 0.002)
        c = (np.abs(xa) < 0.003) & (sa >= s0) & (sa < s0 + 0.002)
        if g.sum() < 3 or c.sum() < 3: continue
        gaps.append((round(float(s0 * 1000), 1), round(float((zp[g].min() - za_[c].max()) * 1000), 1)))
    gmax = max(gg for _, gg in gaps) if gaps else None
    R['thyroid_midline_on_airway_mm'] = dict(value=gmax, threshold='<= 1.5 (isthmus and pyramidal lobe lying on the cricoid and trachea)',
                                             ok=bool(gmax is not None and gmax <= 1.5), profile_mm=gaps,
                                             note='largest gap, per 2 mm band along the airway, between the gland\'s midline back surface and the airway\'s front (|x| < 3 mm)')
    # neighbours: carotid sheath vessels, cricothyroid muscles, oesophagus
    if nb is None: nb = neck_neighbours(sex)
    P = sample_surface(tv, tf, 10000, seed=3)
    con = {}
    for nm, fl, c in nb:
        d = fl(P); ins = d < 0
        con[nm] = dict(inside_pct=round(float(ins.mean() * 100), 3), deepest_mm=round(float(max(0.0, -d.min()) * 1000), 2),
                       min_gap_mm=round(float(d.min() * 1000), 2), ok=bool(ins.mean() <= 0.005 and -d.min() <= 0.001))
    real = {k: v_ for k, v_ in con.items() if '(sheath)' not in k}
    R['thyroid_neck_contacts'] = dict(value=sum(v_['ok'] for v_ in real.values()), threshold=len(real), ok=all(v_['ok'] for v_ in real.values()),
                                      unit='neighbours passing (<= 1 mm deep, <= 0.5 % of the gland surface)', pairs=real,
                                      sheath_guides={k: v_ for k, v_ in con.items() if '(sheath)' in k},
                                      note='sheath guides: the fit\'s one-sided carotid-sheath wall (the space behind the artery\'s anteromedial '
                                           'tangent plane, within its width + 4 mm); not a structure, reported for information')
    # parathyroids
    vol_ok, info = True, {}
    for k, (v, f) in pth.items():
        vv = abs(signed_volume(v, f)) * 1e9
        c = v - v.mean(0); e = np.linalg.svd(c, full_matrices=False)[2]; pr = c @ e.T; ext = pr.max(0) - pr.min(0)
        sc_, xc_, zc_ = local(v.mean(0)[None], c0, a)
        info[k] = dict(volume_mm3=round(vv, 1), extents_mm=[round(float(t) * 1000, 2) for t in ext], level_mm=round(float(sc_[0]) * 1000, 1))
        vol_ok &= (25 <= vv <= 40) and (4.5 <= ext[0] * 1000 <= 7)
    R['parathyroid_size'] = dict(value=[info[k]['volume_mm3'] for k in pth], threshold='25-40 mm3 each, 4.5-7 mm long', ok=bool(vol_ok), glands=info)
    lowL = lob['left']['lower_pole_mm']; lowR = lob['right']['lower_pole_mm']
    lv = dict(pth_sup_l=info['pth_sup_l']['level_mm'], pth_sup_r=info['pth_sup_r']['level_mm'],
              pth_inf_l=info['pth_inf_l']['level_mm'] - lowL, pth_inf_r=info['pth_inf_r']['level_mm'] - lowR)
    ok = all(-18 <= lv[k] <= 6 for k in ('pth_sup_l', 'pth_sup_r')) and all(-14 <= lv[k] <= 0 for k in ('pth_inf_l', 'pth_inf_r'))
    R['parathyroid_levels'] = dict(value={k: round(v_, 1) for k, v_ in lv.items()}, ok=bool(ok),
                                   threshold='superior: -18..+6 mm from the cricoid\'s lower border (at the cricoid); inferior: within 14 mm above its lobe\'s lower pole',
                                   unit='mm along the airway (+ = lower)')
    return R
