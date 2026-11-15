"""Organs fit, part 13: the parathyroid glands kept clear of the carotid sheath, by the exact distance.

The neck stage seats each gland on its lobe's posterior surface where its voxel fields keep PTH_CLEAR off the neck
neighbours; the final check measured the male right superior gland 0.97 mm inside the right common carotid with the
exact distance (the field missed it: the right lobe lies about 1 mm from the carotid groove at that level, and the
stage's search only tried the posterior surface nearest the gland's carried centre).

clear_sheath(): for a gland whose exact signed distance to a carotid artery or internal jugular vein (the vessels
group's meshes and the HRA carotid stumps the assembly keeps, capped) is below SHEATH_CLEAR, every point of the lobe's
posterior surface on the gland's side, within LEVEL_BAND of the gland's level along the airway, is a candidate seat,
nearest first: the gland is turned with the surface normal (rotation from the old seat's normal to the new one), laid at
its old standoff and re-seated by the exact thyroid distance (organs_thyroid.seat_pth, GAP_PTH off the lobe); the first
seat that keeps SHEATH_CLEAR from every sheath vessel and 0-1 mm from the lobe is taken. The gland's shape is kept.
"""
import os, json
import numpy as np

from lib.mesh import sample_surface, closest_on_mesh, orient_outward, load
from lib.register import rotation_between
from fit.common import FIT, hra_mesh
from fit.organs_data import log
from fit.organs_geom import vertex_normals, cap_loops, is_closed
from fit.organs_thyroid import exact_sd, seat_pth, frame

SHEATH_CLEAR = 0.0006
LEVEL_BAND = 0.006
GAP_MAX = 0.001


def sheath_vessels(sex):
    """[(name, (v, f))] closed (capped) carotid arteries and internal jugular veins beside the thyroid."""
    out = []
    vd = os.path.join(FIT, sex, 'vessels', 'manifest.json')
    if os.path.exists(vd):
        for o in json.load(open(vd)):
            if any(k in o['name'] for k in ('common_carotid', 'internal_jugular', 'internal_carotid', 'external_carotid')):
                out.append((o['name'], load(os.path.join(FIT, sex, 'vessels', o['file']))))
    keep = ['brachiocephalic_artery_b', 'left_common_carotid_artery_a'] + (['left_common_carotid_artery_b'] if sex == 'female' else [])
    for nm in keep:
        v, f = hra_mesh(sex, rf'^VH_[MF]_{nm}$')
        if len(f): out.append(('hra_' + nm, (v, f)))
    res = []
    for nm, (v, f) in out:
        if not is_closed(f): v, f = cap_loops(v, f)
        res.append((nm, (v, orient_outward(v, f))))
    return res


def _clearance(P, vessels, box=0.012):
    """Smallest exact signed distance from points P to the vessels (negative inside), and the vessel's name."""
    best, who = np.inf, None
    lo, hi = P.min(0) - box, P.max(0) + box
    for nm, (v, f) in vessels:
        if np.any(v.max(0) < lo) or np.any(v.min(0) > hi): continue
        d = float(exact_sd(P, (v, f)).min())
        if d < best: best, who = d, nm
    return best, who


def clear_sheath(sex, glands, thy, c0, a, log_=log):
    """glands: {name: (v, f)}; thy: the thyroid (v, f); (c0, a) the airway axis. Returns ({name: (v, f)}, report)."""
    vessels = sheath_vessels(sex)
    ap, lat = frame(a)
    tv, tf = thy; tfo = orient_outward(tv, tf)
    vn = vertex_normals(tv, tfo)
    xl = (tv - c0) @ lat; sl = (tv - c0) @ a
    out, rep = {}, {}
    for k, (v, f) in glands.items():
        P = np.vstack([v, sample_surface(v, f, 400, seed=2)])
        c_before, who = _clearance(P, vessels)
        r = dict(sheath_clearance_before_mm=round(c_before * 1000, 2), nearest_vessel=who)
        if c_before >= SHEATH_CLEAR:
            out[k] = (v, f); r['moved'] = False; rep[k] = r; continue
        cen = v.mean(0)
        q0, d0 = closest_on_mesh(tv, tfo, cen[None]); q0, d0 = q0[0], float(d0[0])
        n0 = (cen - q0) / max(d0, 1e-12)
        sg = 1 if k.endswith('_l') else -1
        s_g = float((cen - c0) @ a)
        cand = np.flatnonzero((vn @ ap < -0.35) & (sg * xl > 0.004) & (np.abs(sl - s_g) < LEVEL_BAND))
        cand = cand[np.argsort(np.linalg.norm(tv[cand] - cen, axis=1))]
        # cheap pre-filter: the candidate centre's unsigned distance to the sheath vessels must leave room for the gland
        # (its largest radius about its centre) plus SHEATH_CLEAR
        rg = float(np.linalg.norm(v - cen, axis=1).max())
        C = tv[cand] + vn[cand] * d0
        dc = np.full(len(C), np.inf)
        for _, (vv, ff) in vessels:
            if np.any(vv.max(0) < C.min(0) - 0.03) or np.any(vv.min(0) > C.max(0) + 0.03): continue
            dc = np.minimum(dc, closest_on_mesh(vv, ff, C)[1])
        cand = cand[dc >= rg + SHEATH_CLEAR]
        best = None; tried = 0
        for i in cand[:60]:
            tried += 1
            R = rotation_between(n0, vn[i])
            w = (v - cen) @ R.T + tv[i] + vn[i] * d0
            w = seat_pth(w, f, (tv, tfo), 0.0003)
            Pw = np.vstack([w, sample_surface(w, f, 400, seed=2)])
            gap = float(exact_sd(Pw, (tv, tfo)).min())
            if not (0.0 <= gap <= GAP_MAX): continue
            c, nm = _clearance(Pw, vessels)
            if best is None or c > best[0]: best = (c, w, i, gap, nm)
            if c >= SHEATH_CLEAR: break
        if best is None or best[0] <= c_before:
            out[k] = (v, f); r.update(moved=False, candidates_tried=tried, note='no seat on the posterior surface at this level improves the clearance')
        else:
            c, w, i, gap, nm = best
            out[k] = (w, f)
            r.update(moved=True, sheath_clearance_after_mm=round(c * 1000, 2), nearest_vessel_after=nm, thyroid_gap_mm=round(gap * 1000, 2),
                     shift_mm=round(float(np.linalg.norm(w.mean(0) - cen) * 1000), 2), level_change_mm=round(float((w.mean(0) - cen) @ a * 1000), 2),
                     medial_shift_mm=round(float(-sg * (w.mean(0) - cen) @ lat * 1000), 2), candidates_tried=tried, seat=np.round(tv[i], 4).tolist())
        log_(sex, f'  {k} sheath clearance: {r}')
        rep[k] = r
    return out, rep
