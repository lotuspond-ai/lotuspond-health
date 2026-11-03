"""Acceptance measurements for the foot fit (fit/foot.py). All distances are exact (closest points on triangles, ray casts
against the skin mesh); bone surfaces are sampled densely (vertices plus area-weighted samples).

Definitions (foot frame from the fitted skeleton: long axis = calcaneal tuberosity -> 2nd metatarsal head, plantar
direction = the Z-Anatomy 'down' carried by the posed calcaneus / midfoot):
  mortise gap      signed distance from the HRA plafond / medial malleolar / lateral malleolar facet points to the talus
                   (facets = the Z-Anatomy tibia/fibula surface within 5.5 mm of its own talus, carried onto the HRA bones);
                   reported per facet as p10 / median / p90; penetration = deepest talus surface point inside the HRA
                   tibia or fibula (and facet points inside the talus)
  inside skin      fraction of foot bone surface samples with negative signed distance to the skin
  heel pad         ray from the most plantar point of the calcaneus along the plantar direction to the skin
  forefoot pad     the same from the most plantar bone point under each metatarsal head (sesamoids count for the 1st)
  dorsal clearance smallest distance to the skin from bone points whose outward normal faces dorsally
  foot length      extent along the long axis: bones (calcaneus to the tip of the longest toe) / skin of the foot
  bone-bone        deepest surface sample of one foot bone inside another
  toes             each toe's phalanges inside the skin, and inside the skin toe: on the correct side of the inter-toe
                   grooves detected on the HRA skin (see foot.skin_toes)
"""
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import sample_surface
from fit.foot_geom import TriMesh
from fit.foot_model import toe_bones, METATARSALS


def dense(mesh, n=None, spacing=0.0008, seed=0):
    v, f = mesh
    from lib.mesh import area
    if n is None: n = int(np.clip(area(v, f) / spacing ** 2, 300, 60000))
    return np.concatenate([v, sample_surface(v, f, n, seed=seed)])


def item(value, lo=None, hi=None, unit='mm', nd=2, **extra):
    ok = True
    if lo is not None: ok &= bool(value >= lo)
    if hi is not None: ok &= bool(value <= hi)
    thr = (f'>= {lo}' if hi is None else f'<= {hi}' if lo is None else f'{lo}..{hi}') + (f' {unit}' if unit else '')
    d = dict(value=round(float(value), nd), threshold=thr, ok=bool(ok))
    d.update(extra)
    return d


def bone_bone(meshes, pairs_dist=0.004, n=2500):
    """Deepest penetration (mm) between any two bones, per pair above 0.05 mm."""
    names = list(meshes)
    tms = {b: TriMesh(*meshes[b]) for b in names}
    pts = {b: dense(meshes[b], n=n, seed=1) for b in names}
    lo = {b: meshes[b][0].min(0) for b in names}; hi = {b: meshes[b][0].max(0) for b in names}
    worst = {}
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if np.any(lo[a] > hi[b] + pairs_dist) or np.any(lo[b] > hi[a] + pairs_dist): continue
            depth = 0.0
            for x, y in ((a, b), (b, a)):
                p = pts[x]; m = np.all((p > lo[y] - 1e-4) & (p < hi[y] + 1e-4), axis=1)
                if not m.any(): continue
                sd = tms[y].signed(p[m])
                if (sd < 0).any(): depth = max(depth, float(-sd.min()))
            if depth > 5e-5: worst[f'{a}|{b}'] = round(depth * 1000, 2)
    return worst


def foot_frame(maps, F):
    """Long axis, dorsal and lateral unit vectors of the posed foot (HRA space) from the calcaneus and midfoot maps."""
    def unit(v): return v / np.linalg.norm(v)
    mid = maps['Second_metatarsal_bone']
    cal = maps['Calcaneus']
    up = unit(mid.vec(F.up) + cal.vec(F.up))
    ax = unit(mid.vec(F.axis)); ax = unit(ax - (ax @ up) * up)
    lat = np.cross(up, ax); lat = lat if lat @ mid.vec(F.lat) > 0 else -lat
    return dict(axis=ax, up=up, lat=unit(lat), up_heel=unit(cal.vec(F.up)), up_fore=unit(mid.vec(F.up)))


def measure(meshes, maps, F, tg, facets, skin_toes=None, n_inside=4000):
    """All acceptance measurements for one foot. meshes: bone -> (v, f) in the body; maps: bone -> Sim4 used for the frame."""
    fr = foot_frame(maps, F)
    S = tg.skin_tm
    out = {}
    # ---- mortise
    tal = TriMesh(*meshes['Talus'])
    gaps = {}
    for k, P in facets.items():
        g = tal.signed(P)
        gaps[k] = dict(p10=round(float(np.quantile(g, 0.1) * 1000), 2), median=round(float(np.median(g) * 1000), 2), p90=round(float(np.quantile(g, 0.9) * 1000), 2), n=int(len(P)))
    tp = dense(meshes['Talus'], seed=2)
    pen_t = max(float(-min(tg.tib_tm.signed(tp).min(), 0)), float(-min(tg.fib_tm.signed(tp).min(), 0)))
    pen_f = max(float(-min(tal.signed(P).min(), 0)) for P in facets.values())
    med_ok = all(1.0 <= gaps[k]['median'] <= 4.0 for k in gaps)
    spread_ok = all(gaps[k]['p10'] >= 0.5 and gaps[k]['p90'] <= 5.0 for k in gaps)
    out['mortise_gap_mm'] = dict(value=gaps, threshold='median 1..4 mm per facet (p10 >= 0.5, p90 <= 5)', ok=bool(med_ok and spread_ok))
    out['mortise_penetration_mm'] = item(max(pen_t, pen_f) * 1000, hi=1.0)
    # also: other foot bones vs the HRA tibia / fibula
    worst = 0.0
    for b, m in meshes.items():
        if b == 'Talus': continue
        p = dense(m, n=1500, seed=3)
        lo = np.minimum(tg.tibia[0].min(0), tg.fibula[0].min(0)) - 0.002
        sel = np.all(p > lo, axis=1)
        if not sel.any(): continue
        worst = max(worst, float(-min(tg.tib_tm.signed(p[sel]).min(), 0)), float(-min(tg.fib_tm.signed(p[sel]).min(), 0)))
    out['leg_bone_penetration_mm'] = item(worst * 1000, hi=1.0)
    # ---- inside the skin
    allp, alln, owner = [], [], []
    for b, m in meshes.items():
        p = dense(m, n=max(200, int(n_inside * len(m[1]) / 30000)), seed=4)
        n = TriMesh(*m).closest(p)[3]
        allp.append(p); alln.append(n); owner += [b] * len(p)
    P = np.concatenate(allp); N = np.concatenate(alln); owner = np.array(owner)
    sd = S.signed(P)
    out['inside_skin_fraction'] = item(float((sd < 0).mean()), lo=0.995, unit='', nd=4, outside_max_mm=round(float(max(sd.max(), 0) * 1000), 2))
    dors = N @ fr['up'] > 0.3
    out['dorsal_clearance_mm'] = item(float(-sd[dors].max() * 1000), lo=2.0, min_overall_mm=round(float(-sd.max() * 1000), 2))
    # ---- pads
    def pad(points, down):
        p = points[np.argmax(points @ down)]
        return float(S.ray((p + down * 1e-4)[None], down[None], tmax=0.08)[0]), p
    cal = dense(meshes['Calcaneus'], seed=5)
    hp, hpt = pad(cal, -fr['up_heel'])
    out['heel_pad_mm'] = item(hp * 1000, lo=8.0, hi=25.0)
    fore = {}
    for k, mt in enumerate(METATARSALS, 1):
        v = dense(meshes[mt], seed=6)
        u = v @ fr['axis']; head = v[u > u.max() - 0.012]
        if k == 1:
            ses = dense(meshes['Sesamoid_bones_of_foot'], seed=6)
            head = np.concatenate([head, ses])
        d, _ = pad(head, -fr['up_fore'])
        fore[k] = round(d * 1000, 2)
    fv = np.array(list(fore.values()))
    out['forefoot_pad_mm'] = dict(value=fore, threshold='6..15 mm under each metatarsal head', ok=bool(np.all((fv >= 6) & (fv <= 15))))
    # ---- foot length (along the long axis)
    bones_all = np.concatenate([m[0] for m in meshes.values()])
    ub = bones_all @ fr['axis']
    sv = tg.skin[0]
    foot_skin = sv[(sv - hpt) @ fr['up'] < 0.07]          # the foot below the malleoli (7 cm above the heel pad point)
    us = foot_skin @ fr['axis']
    lb, ls = ub.max() - ub.min(), us.max() - us.min()
    out['foot_length_ratio'] = item(lb / ls, lo=0.90, hi=0.97, unit='', nd=3, bone_mm=round(lb * 1000, 1), skin_mm=round(ls * 1000, 1),
                                    heel_soft_mm=round(float((ub.min() - us.min()) * 1000), 1), toe_soft_mm=round(float((us.max() - ub.max()) * 1000), 1))
    # ---- bone-bone
    bb = bone_bone(meshes)
    worst = max(bb.values()) if bb else 0.0
    out['bone_bone_penetration_mm'] = item(worst, hi=1.0, worst_pairs=dict(sorted(bb.items(), key=lambda kv: -kv[1])[:6]))
    return out, fr


def skin_toes(tg, meshes, maps, F, fr, step=0.003, prom=0.0004):
    """Inter-toe clefts on the HRA skin of the forefoot. In the foot frame (u along the foot, w lateral, n dorsal), slices
    across the toes are scanned for dorsal grooves (local minima of the dorsal height) and plantar sulci (local maxima of
    the plantar height) deeper than `prom`; a groove belongs to the cleft between toes k and k+1 when it lies within
    5 mm of the midpoint between their proximal phalanges. Clefts seen in fewer than two slices count as absent (the
    skin toes are fused there). Returns {(k, k+1): dict(found, w (m), u0 (m), slices)} and the frame used."""
    ax, up, lat = fr['axis'], fr['up'], fr['lat']
    sv, sf = tg.skin
    P = dense(tg.skin, spacing=0.0008, seed=9)
    u, w, n = P @ ax, P @ lat, P @ up
    mtp = {k: maps[METATARSALS[k - 1]](F.toes[k]['joints'][0].c[None])[0] for k in range(1, 6)}
    pp = {k: dense(meshes[toe_bones(k)[0]], n=600, seed=1) for k in range(1, 6)}
    wc = {k: float(np.median(pp[k] @ lat)) for k in range(1, 6)}
    u_start = max(float(mtp[k] @ ax) for k in range(1, 6)) + 0.008
    u_tip = float(u.max())
    toe_zone = (u > u_start - 0.01)
    clefts = {}
    for k in range(1, 5):
        clefts[(k, k + 1)] = dict(found=False, w=0.5 * (wc[k] + wc[k + 1]), expected_w=0.5 * (wc[k] + wc[k + 1]), slices=0, grooves=[])
    for u0 in np.arange(u_start, u_tip - 0.004, step):
        sl = toe_zone & (np.abs(u - u0) < 0.0012)
        if sl.sum() < 50: continue
        ws, ns = w[sl], n[sl]
        bins = np.arange(ws.min(), ws.max() + 0.001, 0.001)
        top = np.full(len(bins), np.nan); bot = np.full(len(bins), np.nan)
        ib = np.clip(np.round((ws - bins[0]) / 0.001).astype(int), 0, len(bins) - 1)
        for i in range(len(bins)):
            m = ib == i
            if m.any(): top[i] = ns[m].max(); bot[i] = ns[m].min()
        for prof, sign in ((top, 1), (bot, -1)):
            for i in range(3, len(bins) - 3):
                if not np.isfinite(prof[i]): continue
                lo_, hi_ = max(0, i - 8), min(len(bins), i + 9)
                left, right = prof[lo_:i], prof[i + 1:hi_]
                if not (np.isfinite(left).any() and np.isfinite(right).any()): continue
                v = sign * prof[i]
                if v <= np.nanmin(sign * prof[max(0, i - 2):i + 3]) and \
                        np.nanmax(sign * left) - v > prom and np.nanmax(sign * right) - v > prom:
                    for key, c in clefts.items():
                        if abs(bins[i] - c['expected_w']) < 0.005: c['grooves'].append((float(u0), float(bins[i])))
    for key, c in clefts.items():
        us = sorted({g[0] for g in c['grooves']})
        c['slices'] = len(us)
        if len(us) >= 2:
            c['found'] = True; c['w'] = float(np.median([g[1] for g in c['grooves']])); c['u0'] = float(min(us))
        del c['grooves']
    return clefts, dict(u_start=u_start, wc=wc)


def toes_in_skin(tg, meshes, clefts, info, fr):
    """Per toe: fraction of phalanx surface inside the skin, and inside its skin toe (on the right side of each found
    cleft, distal to where the cleft begins)."""
    out = {}
    ax, lat = fr['axis'], fr['lat']
    for k in range(1, 6):
        P = np.concatenate([dense(meshes[b], n=1500, seed=2) for b in toe_bones(k)])
        sd = tg.skin_tm.signed(P)
        inside = float((sd < 0).mean())
        ok_side = np.ones(len(P), bool)
        bounds = []
        for (a, b), c in clefts.items():
            if not c['found']: continue
            zone = (P @ ax) > c['u0']
            if a == k: ok_side &= ~zone | ((P @ lat) < c['w']); bounds.append(f'lateral cleft {a}/{b}')
            if b == k: ok_side &= ~zone | ((P @ lat) > c['w']); bounds.append(f'medial cleft {a}/{b}')
        fused = [f'{a}/{b}' for (a, b), c in clefts.items() if not c['found'] and k in (a, b)]
        out[k] = dict(inside_skin=round(inside, 4), inside_skin_toe=round(float(((sd < 0) & ok_side).mean()), 4), min_clearance_mm=round(float(-sd.max() * 1000), 2),
                      bounded_by=bounds, fused_with=fused)
    return out
