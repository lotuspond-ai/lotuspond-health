"""Acceptance measurements for the foot fit (fit/foot.py). All distances are exact (closest points on triangles, ray casts
against the skin mesh); bone surfaces are sampled densely (vertices plus area-weighted samples).

Definitions (foot frame from the fitted skeleton: long axis = calcaneal tuberosity -> 2nd metatarsal head, plantar
direction = the Z-Anatomy 'down' carried by the posed calcaneus / midfoot):
  mortise gap      signed distance from the HRA plafond / medial malleolar / lateral malleolar facet points to the talus
                   (facets = the Z-Anatomy tibia/fibula surface within 4 mm of its own talus, carried onto the HRA bones);
                   reported per facet as p10 / median / p90; penetration = deepest talus surface point inside the HRA
                   tibia or fibula (and facet points inside the talus)
  inside skin      fraction of foot bone surface samples with negative signed distance to the skin
  heel pad         ray from the most plantar point of the calcaneus along the plantar direction to the skin
  forefoot pad     the same from the most plantar bone point under each metatarsal head (sesamoids count for the 1st)
  dorsal clearance smallest distance to the skin from bone points whose outward normal is within 45 deg of dorsal
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


# Z-Anatomy's own talus in its own mortise, same facet definition (median / p10 / p90 mm, fraction within 1..4 mm)
ZA_MORTISE = dict(plafond=dict(p10=1.10, median=2.91, p90=3.82, in_1_4mm=0.92), medial=dict(p10=0.65, median=1.56, p90=2.11, in_1_4mm=0.70),
                  lateral=dict(p10=0.23, median=1.39, p90=3.40, in_1_4mm=0.58))


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
        gaps[k] = dict(p10=round(float(np.quantile(g, 0.1) * 1000), 2), median=round(float(np.median(g) * 1000), 2), p75=round(float(np.quantile(g, 0.75) * 1000), 2),
                       p90=round(float(np.quantile(g, 0.9) * 1000), 2), in_1_4mm=round(float(np.mean((g >= 0.001) & (g <= 0.004))), 3), n=int(len(P)),
                       za_reference=ZA_MORTISE.get(k))
    tp = dense(meshes['Talus'], seed=2)
    pen_t = max(float(-min(tg.tib_tm.signed(tp).min(), 0)), float(-min(tg.fib_tm.signed(tp).min(), 0)))
    pen_f = max(float(-min(tal.signed(P).min(), 0)) for P in facets.values())
    med_ok = all(1.0 <= gaps[k]['median'] <= 4.0 for k in gaps)
    band_ok = all(gaps[k]['p10'] >= 1.0 and gaps[k]['p75'] <= 4.0 for k in gaps)
    out['mortise_gap_mm'] = dict(value=gaps, threshold='joint space 1..4 mm over each articular facet (plafond, medial, lateral malleolar facet = the Z-Anatomy '
                                 'tibia/fibula surface within 4 mm of its own talus, carried onto the HRA bones): median in 1..4 mm, 10th percentile >= 1 mm '
                                 '(no thin spots) and 75th percentile <= 4 mm; p90 and the fraction in 1..4 mm are reported with the Z-Anatomy reference '
                                 '(its own talus in its own mortise, same facets)', ok=bool(med_ok and band_ok))
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
    # dorsal = bone surface facing within 45 degrees of the dorsal direction of the foot; the medial and lateral borders
    # (e.g. the medial eminence of the 1st metatarsal head) are reported separately
    dors = N @ fr['up'] >= np.cos(np.radians(45))
    sides = np.abs(N @ fr['lat']) >= np.cos(np.radians(45))
    worst = np.flatnonzero(dors)[np.argmax(sd[dors])]
    out['dorsal_clearance_mm'] = item(float(-sd[dors].max() * 1000), lo=2.0, at=str(owner[worst]), min_overall_mm=round(float(-sd.max() * 1000), 2),
                                      border_min_mm=round(float(-sd[sides].max() * 1000), 2), border_at=str(owner[np.flatnonzero(sides)[np.argmax(sd[sides])]]))
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


def skin_toes(tg, meshes, maps, F, fr, step=0.002, dw=0.0005, prom=0.0008, win=0.006):
    """Skin toes of the HRA forefoot, slice by slice. In the foot frame (u along the foot, w lateral, n dorsal) the dorsal
    and plantar skin heights are found by exact ray casts across the toes every `step` from the MTP joints to the tip.
    In each slice, a cleft between toes k and k+1 is the deepest dorsal groove (local minimum of the dorsal height) or
    plantar sulcus (local maximum of the plantar height) deeper than `prom` on both sides within `win`, or a run where
    the skin is split (rays miss), lying between the two toes' centrelines in that slice. `prom` = 0.8 mm: shallower
    undulations are at the resolution of the Visible Human skin segmentation (1 mm slices) and do not separate toes. A groove anywhere between the
    centrelines counts, also one that runs over a phalanx: that is what the check must catch.
    Returns ({(k, k+1): dict(found, slices, u_from, u_to, depth_mm)}, info with the per-slice cleft lines)."""
    ax, up, lat = fr['axis'], fr['up'], fr['lat']
    S = tg.skin_tm
    sv = tg.skin[0]
    mtp = {k: maps[METATARSALS[k - 1]](F.toes[k]['joints'][0].c[None])[0] for k in range(1, 6)}
    ph = {k: np.concatenate([dense(meshes[b], n=800, seed=1) for b in toe_bones(k)]) for k in range(1, 6)}
    u_start = min(float(mtp[k] @ ax) for k in range(1, 6)) + 0.004
    u_tip = float((sv @ ax).max())
    top, bot = float((sv @ up).max()) + 0.02, float((sv @ up).min()) - 0.02
    lines = {(k, k + 1): [] for k in range(1, 5)}
    nwin = int(round(win / dw))
    for u0 in np.arange(u_start, u_tip - 0.002, step):
        band = {k: p[np.abs(p @ ax - u0) < step / 2] for k, p in ph.items()}
        have = [k for k in range(1, 6) if len(band[k])]
        if len(have) < 2: continue
        cen = {k: float(np.median(band[k] @ lat)) for k in have}
        wl = min(float((band[k] @ lat).min()) for k in have) - 0.006; wr = max(float((band[k] @ lat).max()) for k in have) + 0.006
        ws = np.arange(wl, wr, dw)
        O = ax[None] * u0 + lat[None] * ws[:, None]
        hd = top - S.ray(O + up * top, np.repeat(-up[None], len(ws), 0), tmax=top - bot)
        hp = bot + S.ray(O + up * bot, np.repeat(up[None], len(ws), 0), tmax=top - bot)
        split = ~np.isfinite(hd)
        for k in range(1, 5):
            if k not in cen or k + 1 not in cen: continue
            a, b = cen[k], cen[k + 1]
            inb = np.flatnonzero((ws > min(a, b)) & (ws < max(a, b)))
            if not len(inb): continue
            best = None
            # a split skin between the toes: the middle of the run of misses
            sp = inb[split[inb]]
            if len(sp): best = (np.inf, float(ws[sp].mean()))
            for prof, sign in ((hd, 1.0), (hp, -1.0)):
                v = sign * prof
                for i in inb:
                    if best is not None and not np.isfinite(best[0]): break
                    if not np.isfinite(v[i]) or i < 2 or i > len(ws) - 3: continue
                    if v[i] > np.nanmin(v[i - 2:i + 3]): continue
                    left, right = v[max(0, i - nwin):i], v[i + 1:i + 1 + nwin]
                    if not (np.isfinite(left).any() and np.isfinite(right).any()): continue
                    depth = min(np.nanmax(left) - v[i], np.nanmax(right) - v[i])
                    if depth > prom and (best is None or depth > best[0]): best = (float(depth), float(ws[i]))
            if best is not None: lines[(k, k + 1)].append((float(u0), best[1], best[0]))
    clefts = {}
    for key, L in lines.items():
        c = dict(found=len(L) >= 2, slices=len(L))
        if L:
            c.update(u_from_mm=round((min(l[0] for l in L) - u_start) * 1000, 1), u_to_mm=round((max(l[0] for l in L) - u_start) * 1000, 1),
                     depth_mm=round(float(np.median([l[2] if np.isfinite(l[2]) else 9.9 for l in L])) * 1000, 2), split_slices=int(sum(1 for l in L if not np.isfinite(l[2]))))
        clefts[key] = c
    return clefts, dict(u_start=u_start, step=step, lines=lines)


def toes_in_skin(tg, meshes, clefts, info, fr):
    """Per toe: fraction of phalanx surface inside the skin, and inside its skin toe: inside the skin and, in every slice
    where a cleft to a neighbouring toe was found, on the toe's own side of that cleft."""
    out = {}
    ax, lat = fr['axis'], fr['lat']
    step = info['step']
    for k in range(1, 6):
        P = np.concatenate([dense(meshes[b], n=1500, seed=2) for b in toe_bones(k)])
        sd = tg.skin_tm.signed(P)
        u, w = P @ ax, P @ lat
        ok_side = np.ones(len(P), bool)
        bounds = []
        for (a, b), c in clefts.items():
            if k not in (a, b) or not c['found']: continue
            bounds.append(f'{"lateral" if a == k else "medial"} cleft {a}/{b} ({c["slices"]} slices)')
            for u0, wc, _ in info['lines'][(a, b)]:
                sl = np.abs(u - u0) < step / 2
                ok_side[sl] &= (w[sl] < wc) if a == k else (w[sl] > wc)
        fused = [f'{a}/{b}' for (a, b), c in clefts.items() if not c['found'] and k in (a, b)]
        out[k] = dict(inside_skin=round(float((sd < 0).mean()), 4), inside_skin_toe=round(float(((sd < 0) & ok_side).mean()), 4),
                      min_clearance_mm=round(float(-sd.max() * 1000), 2), bounded_by=bounds, fused_with=fused)
    return out
