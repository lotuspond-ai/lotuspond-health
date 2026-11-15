"""Organs group: stomach, oesophagus, diaphragm, suprarenal glands, thyroid gland and parathyroid glands.
Usage: python3 fit/organs.py [male|female|all] [--no-render] [--from=<stage>]  (earlier stages from the stage cache)
                              [--redo=<stage>,<stage>...]  (only these stages recomputed, the others from the cache;
                              e.g. --redo=neck,esophagus,final after a change to the thyroid, which only the oesophagus
                              and the final clearances depend on)

Every structure starts from the cached trunk warp (fit.common.get_warp(sex, 'trunk')) and is then refined against the
HRA neighbours it touches (see organs_neck, organs_adrenal, organs_diaphragm, organs_bed, organs_tube, organs_final,
organs_settle):
  1. thyroid + parathyroids  similarity from the larynx cartilages, slide to tracheal rings 2-4, smooth push-out,
                             glands slid onto the lobes' posterior surface
  2. adrenals                undistorted gland (the left one scaled to 1.1 times the right one's volume) laid on its
                             warped pose, free-space pose search, 2 mm off the kidney
  3. diaphragm               as-rigid-as-possible fit (openings follow the HRA IVC / aorta, domes under the lung bases
                             and heart, collision push-out, local thinning); fitted against the liver as assembled
                             (the heart chambers, coronary arteries and cardiac veins plus 4 mm carved out of its dome),
                             a vertex inside the heart leaving it straight down through its inferior surface, so the
                             central tendon lies in the carved space; the glands then re-seated in the remaining
                             free space (the right one behind the IVC) and the crura made to give way to them
  4. stomach                 the smooth boundary of the free part of its bed (organs_bed): the warped Z-Anatomy
                             stomach voxelised, its neighbours (the splenic artery and vein included) subtracted,
                             bridges to the cardiac ring and to the free lipped end of the HRA duodenal bulb (the
                             pyloric canal along the corridor of greatest clearance), nothing behind the bulb's lip
                             plane around the bulb, signed distance smoothed under the no-overlap constraint, surface
                             extracted, orifice rims laid onto their rings
  5. oesophagus              a smooth tube swept along a smoothed route (organs_tube) with Z-Anatomy's own
                             cross-sections, flattened front-to-back where squeezed, ending in the cardiac ring
  6. final clearances        (organs_final) the glands re-seated rigidly off their kidneys (the left one also out of
                             the stage-3 sheet; dense surface samples, then a lift along the kidney's normal); the
                             diaphragm (long edges
                             split) settled locally off our oesophagus (hiatus), stomach and glands and the HRA
                             aorta, its two faces paired so that it thins rather than folds (its domes stay as stage
                             3 balanced them between thorax and abdomen; the liver is measured as assembled, with the
                             heart and its surface vessels + 4 mm carved out); then the crura give way to the glands
                             two-way (a gland's thin edge poking into the sheet: the near face walks inwards past it,
                             the crus thinning before it moves; organs_final.crus_yield)
Stages are cached in .cache/fit/<sex>/organs/cache/stage-*.pkl; --from=<stage> reruns from that stage.
Contacts with our own thin structures are measured with fields that use their own (consistent) face normals, and
the oesophagus, trachea and bronchi count as solid organs (lumen included).
Outputs: .cache/fit/<sex>/organs/ (write_group): one .npz per structure, manifest.json, report.json, qa-*.png.
"""
import os, sys, json, time
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import sample_surface, signed_volume, orient_outward, merge  # noqa: E402
from fit.common import write_group  # noqa: E402
from fit.organs_data import (warped, hra, field, log, level, level_name, VERTS, vertebrae, out_dir, cache_dir, ZA_NAMES, LOBES,  # noqa: E402
                             vessel_centreline, ribs, za_original)
from fit.organs_geom import Field, mesh_field, winding, is_closed  # noqa: E402
from fit.organs_neck import fit_neck, isthmus, ring_profile, PTH  # noqa: E402
from fit.organs_adrenal import fit_adrenals  # noqa: E402
from fit.organs_diaphragm import fit_diaphragm, crossing  # noqa: E402
from fit.organs_gi import loop_axis, esophagus_field, warped_esophagus_field  # noqa: E402
from fit.organs_bed import fit_stomach_bed  # noqa: E402
from fit.organs_tube import fit_esophagus_sweep, profile, end_radius  # noqa: E402
from fit.organs_final import reseat_gland, settle_diaphragm, crus_yield  # noqa: E402

GROUP = 'organs'
DEPTH_MAX = 1.0        # mm
FRAC_MAX = 0.5         # % of the structure's surface


def crit(value, threshold, ok, unit='', **kw):
    d = dict(value=value, threshold=threshold, ok=bool(ok))
    if unit: d['unit'] = unit
    d.update(kw)
    return d


def penetration(mesh, fl, n=20000, seed=3, exclude=None, closed=None):
    """(% of the mesh surface inside fl, deepest mm, samples the field put inside that the exact test clears).
    closed: the neighbour's own closed mesh (v, f) when fl is one of our oriented fields: every sample the field puts
    inside is checked with the exact winding number of that mesh (a voxel field's sign can be wrong in folds and
    narrow pockets of a thin sheet such as the diaphragm's crura)."""
    p = sample_surface(*mesh, n, seed=seed)
    if exclude is not None: p = p[~exclude(p)]
    d = fl(p)
    ins = d < 0
    cleared = 0
    if closed is not None and ins.any():
        w = winding(p[ins], *closed)
        keep = np.abs(w) > 0.5
        cleared = int((~keep).sum())
        idx = np.flatnonzero(ins); ins[idx[~keep]] = False
    depth = float(-d[ins].min()) if ins.any() else 0.0
    return round(float(ins.mean() * 100), 3), round(max(0.0, depth) * 1000, 2), cleared


def pair(mesh, fl, n=20000, exclude=None, listed=True, closed=None):
    frac, depth, cleared = penetration(mesh, fl, n=n, exclude=exclude, closed=closed)
    d = dict(inside_pct=frac, deepest_mm=depth, ok=bool(frac <= FRAC_MAX and depth <= DEPTH_MAX), listed=listed)
    if closed is not None: d['field_flags_cleared_by_winding_number'] = cleared
    return d


def level_crit(sex, y, lo, hi):
    x = level(sex, y)
    a, b = VERTS.index(lo) - 0.5, VERTS.index(hi) + 0.5
    return crit(level_name(x), f'{lo}-{hi}', a <= x <= b, level_index=round(x, 2), y=round(float(y), 4))


from fit.organs_lungs import lung_base  # noqa: E402  (closed lobes; was defined here on the leaking HRA segment field)


def arcuate(sex, dv):
    """Where the aorta leaves the thorax behind the median arcuate ligament: going down the HRA abdominal aorta from
    its top, the last station (of the run that starts at the top) with diaphragm vertices directly in front of the
    vessel (within 60 % of its radius of its midline, up to 2 cm in front of its anterior wall)."""
    av = hra(sex, 'aorta_abd')[0]
    Ca = vessel_centreline(av)
    Ca = Ca[np.argsort(-Ca[:, 1])]
    last, miss = None, 0.0
    for c in Ca:
        sl = av[np.abs(av[:, 1] - c[1]) < 0.002]
        if len(sl) < 5: continue
        r = float(np.median(np.linalg.norm((sl - c)[:, [0, 2]], axis=1))); zf = sl[:, 2].max()
        band = np.abs(dv[:, 1] - c[1]) < 0.0025
        m = band & (np.abs(dv[:, 0] - c[0]) < 0.6 * r) & (dv[:, 2] > zf - 0.002) & (dv[:, 2] < zf + 0.02)
        if m.sum() >= 3:
            side = lambda sg: int((band & (np.abs(dv[:, 2] - c[2]) < r) & (sg * (dv[:, 0] - c[0]) > 0.8 * r) & (sg * (dv[:, 0] - c[0]) < r + 0.02)).sum())
            last = dict(y=float(c[1]), gap_mm=round(float((dv[m, 2].min() - zf) * 1000), 1), crura=dict(right=side(-1), left=side(1)))
            miss = 0.0
        elif last is not None:
            miss += 0.002
            if miss > 0.004: break
    return last


def measure(sex, out, aux):
    """All acceptance criteria. out: {name: (v, f)}; aux: fit by-products."""
    R = {}
    F = lambda k: field(sex, k)
    own = {}
    for k in ('stomach', 'diaphragm', 'adrenal_l', 'adrenal_r', 'thyroid'):
        own[k] = mesh_field(*out[k], 0.0006, cap=(k == 'stomach'))
    own['esophagus'] = esophagus_field(*out['esophagus'], aux['esophagus_centreline'])
    # exact inside test for our own closed meshes (diaphragm, glands, thyroid)
    cl = {k: (out[k] if is_closed(out[k][1]) else None) for k in ('diaphragm', 'adrenal_l', 'adrenal_r', 'thyroid')}
    st, es, di = out['stomach'], out['esophagus'], out['diaphragm']
    pyl, car, ring = aux['stomach_loops']
    cc, cn, crad = loop_axis(st[0][car])
    near_junction = lambda p: np.linalg.norm(p - cc, axis=1) < 0.012
    pc = st[0][pyl].mean(0)
    near_pylorus = lambda p: np.linalg.norm(p - pc, axis=1) < 0.012
    pairs = {}
    # stomach
    pairs['stomach'] = {k: pair(st, F(k)) for k in ('liver', 'spleen', 'pancreas', 'colon', 'kidney_l', 'kidney_r')}
    pairs['stomach']['diaphragm'] = pair(st, own['diaphragm'], closed=cl['diaphragm'])
    pairs['stomach']['gallbladder'] = pair(st, F('gallbladder'), listed=False)
    pairs['stomach']['duodenum (beyond the pylorus)'] = pair(st, F('duodenum'), exclude=near_pylorus, listed=False)
    # the splenic artery and vein run behind the stomach's posterior wall, along the pancreas's upper border; measured
    # both ways (the share of the stomach's surface inside the vessel, and of the vessel's inside the stomach)
    for k in ('splenic_a', 'splenic_v'):
        pairs['stomach'][k] = pair(st, F(k))
        pairs[k] = {'stomach': pair(hra(sex, k), own['stomach'])}
    pairs['stomach']['adrenal_l'] = pair(st, own['adrenal_l'], listed=False, closed=cl['adrenal_l'])
    # oesophagus
    pairs['esophagus'] = {k: pair(es, F(k)) for k in ('trachea', 'trach_cart', 'la', 'pulm_veins', 'aorta', 'spine')}
    pairs['esophagus']['diaphragm'] = pair(es, own['diaphragm'], closed=cl['diaphragm'])
    for k in ('heart', 'bronchi', 'cricoid', 'thyroid_cart', 'liver'):
        pairs['esophagus'][k] = pair(es, F(k), listed=False)
    pairs['esophagus']['thyroid'] = pair(es, own['thyroid'], listed=False, closed=cl['thyroid'])
    pairs['esophagus']['stomach (beyond the junction)'] = pair(es, own['stomach'], exclude=near_junction, listed=False)
    # diaphragm
    from fit.organs_final import liver_carved, HEART_CARVE
    pairs['diaphragm'] = {k: pair(di, F(k), n=40000) for k in ('heart', 'spleen', 'ivc', 'aorta')}
    # the lungs exactly: samples inside or within 1.5 mm of the closed lobes' field tested by ray parity on the lobes,
    # depth by the exact closest point (organs_lungs.lungs_exact_pair)
    from fit.organs_lungs import lungs_exact_pair
    lx = lungs_exact_pair(sex, di)
    pairs['diaphragm']['lungs'] = dict(lx, ok=bool(lx['inside_pct'] <= FRAC_MAX and lx['deepest_mm'] <= DEPTH_MAX), listed=True)
    # the liver as assembled (assemble.py carves the heart plus 4 mm out of the HRA liver dome the heart sinks into);
    # the uncarved HRA liver is reported alongside
    pairs['diaphragm']['liver'] = pair(di, liver_carved(sex), n=40000)
    pairs['diaphragm']['liver'].update(carved=f'HRA liver minus (heart + {HEART_CARVE * 1000:.0f} mm), as assemble.py builds it')
    pairs['diaphragm']['liver (HRA, uncarved)'] = pair(di, F('liver'), n=40000, listed=False)
    pairs['diaphragm']['stomach'] = pair(di, own['stomach'], n=40000)
    pairs['diaphragm']['esophagus'] = pair(di, own['esophagus'], n=40000)
    for k in ('kidney_l', 'kidney_r', 'colon', 'pancreas', 'spine', 'ribs'):
        pairs['diaphragm'][k] = pair(di, F(k), n=40000, listed=False)
    # adrenals: touching nothing but their kidney
    for s in 'lr':
        a = out[f'adrenal_{s}']
        pairs[f'adrenal_{s}'] = {k: pair(a, F(k), n=6000) for k in ('ivc', 'liver', 'spleen', 'pancreas', 'aorta', 'duodenum', 'colon', 'spine',
                                                                    f'kidney_{s}')}
        pairs[f'adrenal_{s}']['diaphragm'] = pair(a, own['diaphragm'], n=6000, closed=cl['diaphragm'])
        pairs[f'adrenal_{s}']['stomach'] = pair(a, own['stomach'], n=6000)
    # thyroid
    pairs['thyroid'] = {k: pair(out['thyroid'], F(k), n=10000) for k in ('thyroid_cart', 'cricoid', 'trachea', 'trach_cart')}
    pairs['thyroid']['esophagus'] = pair(out['thyroid'], own['esophagus'], n=10000, listed=False)
    R['contact_pairs'] = pairs
    listed = [(o, k, v) for o, d in pairs.items() for k, v in d.items() if v['listed']]
    R['contact_pairs_summary'] = crit(sum(v['ok'] for _, _, v in listed), len(listed), all(v['ok'] for _, _, v in listed),
                                      unit='listed pairs passing (<= 1 mm deep and <= 0.5 % of surface)',
                                      failing=[f'{o} x {k}: {v["inside_pct"]}% / {v["deepest_mm"]} mm' for o, k, v in listed if not v['ok']])
    # the diaphragm's mesh after the final settle (organs_final.settle_diaphragm re-splits stretched edges between its
    # rounds): its longest edge, and its triangles' interiors (7 barycentric points per triangle) against the aorta
    # (capped; the inflated one where lib.inflate has inflated it) and the IVC (lumen filled)
    from fit.organs_final import max_edge, EDGE_CAP
    el = max_edge(*di)
    R['diaphragm_longest_edge_mm'] = crit(round(el * 1000, 2), EDGE_CAP * 1000, el <= EDGE_CAP + 1e-9, unit='mm',
                                          aorta_source='inflated (lib.inflate)' if 'aorta' in _inflated_keys(sex) else 'HRA')
    R['diaphragm_triangles_in_vessels'] = triangles_in(di, [(k, F(k)) for k in ('aorta', 'ivc')])
    # joins
    from lib.mesh import closest_on_mesh
    _, d = closest_on_mesh(*es, st[0][car])
    R['cardia_join_gap_mm'] = crit(round(float(d.max() * 1000), 2), 2.0, d.max() <= 0.002, mean=round(float(d.mean() * 1000), 2))
    seg = np.concatenate([np.linspace(ring[i], ring[(i + 1) % len(ring)], 8, endpoint=False) for i in range(len(ring))])
    d2, _ = cKDTree(seg).query(st[0][pyl])
    R['pylorus_join_gap_mm'] = crit(round(float(d2.max() * 1000), 2), 2.0, d2.max() <= 0.002, mean=round(float(d2.mean() * 1000), 2),
                                    ring='the outer wall of the HRA duodenal bulb (ampulla) 1 mm behind the crest of its free lipped end')
    # the pylorus opens into the bulb's free lipped end: the stomach's pyloric rim centred on the lip, and no gastric
    # tissue behind the lip plane around the bulb (a blind antrum carrying on past the pylorus, or a stomach wrapped
    # round the bulb's side)
    from fit.organs_gi import bulb_opening
    from fit.organs_bed import PYL_CONE
    _, bc, bn, br, binfo = bulb_opening(sex)
    crest = np.array(binfo['crest_centre'])
    off = float(np.linalg.norm(pc - bc) * 1000)
    x = st[0] - bc; ax_ = -(x @ bn); rad = np.linalg.norm(x + np.outer(ax_, bn), axis=1)
    ang, depth = PYL_CONE
    behind = (ax_ > 0.001) & (np.linalg.norm(x, axis=1) < depth)
    rc = br + 0.002 + np.tan(ang) * ax_
    # depth into the pylorus's shadow (the cone the bed leaves free behind the lip plane, about the bulb's axis): the
    # smoothed surface may graze its boundary by the smoothing's reach
    into = np.where(behind, (rc - rad) * np.cos(ang), -np.inf)
    deep_in = float(max(0.0, into.max()) * 1000) if behind.any() else 0.0
    near_bulb = behind & (rad < rc + 0.01)
    gap_b = round(float(F('duo_bulb')(st[0][near_bulb]).min() * 1000), 2) if near_bulb.any() else None
    R['pylorus_on_bulb_lip'] = crit(round(off, 2), '<= 2 mm from the lip ring centre; <= 2 mm into the pylorus shadow (behind the lip plane, '
                                    f'{np.degrees(ang):.0f} deg about the bulb axis from the ring radius + 2 mm)',
                                    off <= 2.0 and deep_in <= 2.0, unit='mm (pyloric rim centre to the bulb ring centre)',
                                    shadow_depth_mm=round(deep_in, 2), bulb_gap_behind_lip_plane_mm=gap_b,
                                    stomach_behind_lip_plane_within_cone_max_mm=round(float(ax_[behind & (rad < rc)].max() * 1000), 2) if (behind & (rad < rc)).any() else 0.0,
                                    bulb_axis=binfo['axis'], crest_centre=binfo['crest_centre'], crest_radius_mm=binfo['crest_radius_mm'],
                                    ring_radius_mm=binfo['ring_radius_mm'], rim_to_crest_plane_mm=round(float((crest - pc) @ bn * 1000), 2))
    # levels
    R['ge_junction_level'] = level_crit(sex, cc[1], 'T10', 'T12')
    C = aux['esophagus_centreline']
    cov, i = crossing(di[0], C)
    R['esophageal_hiatus_level'] = level_crit(sex, C[i][1], 'T9', 'T11') if i is not None else crit(None, 'T9-T11', False)
    if i is not None: R['esophageal_hiatus_level']['coverage'] = round(cov, 2)
    arc = arcuate(sex, di[0])
    if arc is None: R['aortic_hiatus_level'] = crit(None, 'T11-L1', False)
    else:
        R['aortic_hiatus_level'] = level_crit(sex, arc['y'], 'T11', 'L1')
        R['aortic_hiatus_level'].update(method='lower border of the median arcuate ligament: the lowest level of the HRA aorta with '
                                               'diaphragm directly in front of it, crura on both sides', gap_in_front_mm=arc['gap_mm'],
                                        crura_beside=arc['crura'])
    Ci = vessel_centreline(hra(sex, 'ivc')[0])
    Ci = Ci[Ci[:, 1] > di[0][:, 1].max() - 0.06]
    cov, i = crossing(di[0], Ci, first=0.7)
    R['caval_opening_level'] = level_crit(sex, Ci[i][1], 'T8', 'T9') if i is not None else crit(None, 'T8-T9', False)
    if i is not None: R['caval_opening_level']['coverage'] = round(cov, 2)
    # lungs' diaphragmatic surfaces within 0-6 mm of the diaphragm
    P = lung_base(sex)
    q, d = closest_on_mesh(*di, P)
    sd = own['diaphragm'](P)
    dist = np.where(sd < 0, sd, d)
    within = (dist >= -0.001) & (dist <= 0.006)
    R['lung_base_to_diaphragm_mm'] = crit(round(float(within.mean() * 100), 1), 90.0, within.mean() >= 0.9,
                                          unit='% of lung-base samples within 0-6 mm of the diaphragm (overlaps up to 1 mm count as touching, '
                                               'the contact-pair tolerance)', inside_pct=round(float((dist < 0).mean() * 100), 1),
                                          p5=round(float(np.percentile(dist, 5) * 1000), 2), median=round(float(np.median(dist) * 1000), 2),
                                          p95=round(float(np.percentile(dist, 95) * 1000), 2), samples=int(len(P)))
    # adrenals on the kidneys
    for s in 'lr':
        a = out[f'adrenal_{s}']; p = sample_surface(*a, 6000, seed=1)
        g = float(F(f'kidney_{s}')(p).min() * 1000)
        R[f'adrenal_{s}_kidney_gap_mm'] = crit(round(g, 2), '1-5', 1.0 <= g <= 5.0)
    va = {s: abs(signed_volume(*out[f'adrenal_{s}'])) * 1e6 for s in 'lr'}
    R['adrenal_volumes_cm3'] = crit(dict(l=round(va['l'], 2), r=round(va['r'], 2)), 'each 3-7 cm3 (adult glands weigh about 4-6 g), left / right 0.8-1.4',
                                    all(3.0 <= x <= 7.0 for x in va.values()) and 0.8 <= va['l'] / va['r'] <= 1.4, ratio=round(va['l'] / va['r'], 2))
    # right adrenal behind the IVC: where they overlap side to side, the IVC lies in front
    a = out['adrenal_r'][0]; iv = hra(sex, 'ivc')[0]
    band = iv[(iv[:, 1] > a[:, 1].min()) & (iv[:, 1] < a[:, 1].max())]
    medial = a[a[:, 0] > np.percentile(a[:, 0], 70)]
    R['adrenal_r_behind_ivc'] = crit(round(float((band[:, 2].min() - medial[:, 2].mean()) * 1000), 1), '> 0 (IVC back wall in front of the gland\'s medial part)',
                                     band[:, 2].min() > medial[:, 2].mean() if len(band) else False, unit='mm',
                                     x_overlap_mm=round(float((min(band[:, 0].max(), a[:, 0].max()) - max(band[:, 0].min(), a[:, 0].min())) * 1000), 1) if len(band) else None)
    # thyroid
    ax = aux['airway_axis']; c0, av = ax
    ic, _ = isthmus(out['thyroid'][0], sex, ax)
    depth = float((ic - c0) @ av) * 1000
    cv = hra(sex, 'cricoid')[0]
    R['isthmus_below_cricoid_mm'] = crit(round(depth, 1), '5-25', 5 <= depth <= 25, along='airway axis',
                                         vertical=round(float((cv[:, 1].min() - ic[1]) * 1000), 1))
    rings = ring_profile(sex, c0, av)
    ri = [j + 1 for j, (a0, a1) in enumerate(rings) if a0 - 0.002 <= depth / 1000 <= a1 + 0.002]
    # tracheal rings proper: the profile's bands that start below the cricoid's lower border (bands above it are the
    # cricoid arch itself), numbered from the first
    below = [(a0, a1) for a0, a1 in rings if a0 >= -0.001]
    ri2 = [j + 1 for j, (a0, a1) in enumerate(below) if a0 - 0.002 <= depth / 1000 <= a1 + 0.002]
    if not ri2 and below:
        ri2 = [1 + int(np.argmin([min(abs(depth / 1000 - a0), abs(depth / 1000 - a1)) for a0, a1 in below]))]
    tv = out['thyroid'][0]; sv = (tv - c0) @ av
    R['thyroid_rings'] = dict(rings_mm=[(round(a0 * 1000, 1), round(a1 * 1000, 1)) for a0, a1 in rings], isthmus_ring=ri,
                              isthmus_tracheal_ring=ri2, isthmus_in_front_of_rings_2_4=bool(ri2 and min(ri2) <= 4 and max(ri2) >= 2),
                              lobes_from_mm=round(float(sv.min() * 1000), 1), lobes_to_mm=round(float(sv.max() * 1000), 1),
                              note='distances below the cricoid\'s lower border along the airway; rings from the anterior tracheal cartilage profile')
    # parathyroids
    from fit.organs_thyroid import exact_sd
    for k in PTH:
        p = sample_surface(*out[k], 800, seed=1); d = exact_sd(p, out['thyroid'])
        R[f'{k}_to_thyroid'] = crit(round(float(d.min() * 1000), 2), '0-1 mm, none inside', (d.min() <= 0.001) and (d >= 0).all(),
                                    inside_pct=round(float((d < 0).mean() * 100), 2), centre=np.round(out[k][0].mean(0), 4).tolist(),
                                    method='exact distance to the thyroid mesh, inside by its winding number')
    # parathyroids clear of the carotid sheath (exact signed distance to the carotid arteries and internal jugular veins)
    from fit.organs_pth import sheath_vessels, _clearance, SHEATH_CLEAR
    sv_ = sheath_vessels(sex); sc = {}
    for k in PTH:
        P_ = np.vstack([out[k][0], sample_surface(*out[k], 400, seed=2)]); c_, who_ = _clearance(P_, sv_); sc[k] = (round(c_ * 1000, 2), who_)
    R['parathyroid_sheath_clearance_mm'] = crit({k: x[0] for k, x in sc.items()}, f'>= 0 mm (outside every carotid artery and jugular vein; target {SHEATH_CLEAR * 1000:.1f})',
                                                all(x[0] >= 0 for x in sc.values()), nearest={k: x[1] for k, x in sc.items()},
                                                method='exact signed distance (closest point, inside by winding number) to the vessels group\'s carotid arteries and '
                                                       'internal jugular veins and the HRA carotid stumps, capped')
    # the gland does not pass through itself (exact test: lib.mesh ray-parity votes on every face, confirmed by the
    # winding number; the facing assemble.py measures)
    from fit.organs_thyroid import fold_faces
    tv_, tf_ = out['thyroid']; tf_ = orient_outward(tv_, tf_)
    bad = fold_faces(tv_, tf_)
    ar_ = 0.5 * np.linalg.norm(np.cross(tv_[tf_[:, 1]] - tv_[tf_[:, 0]], tv_[tf_[:, 2]] - tv_[tf_[:, 0]]), axis=1)
    R['thyroid_self_overlap_pct'] = crit(round(float(ar_[bad].sum() / ar_.sum() * 100), 3), 0.1, ar_[bad].sum() / ar_.sum() * 100 <= 0.1,
                                         unit='% of the surface where the gland passes through itself', faces=int(len(bad)))
    # the gland's size, extent, bed and neck contacts; the parathyroids' size and levels (organs_thyroid)
    from fit.organs_thyroid import thyroid_measures
    R.update(thyroid_measures(sex, out['thyroid'], {k: out[k] for k in PTH}, c0, av, aux.get('neck_neighbours')))
    # the oesophagus's course: gentle curves (route bend per cm above its distal 3 cm turn into the cardia; and the
    # bends between 8 mm horizontal slab centroids of the mesh, the way the anatomy review measured the female S-kink)
    from fit.organs_tube import bend_per_cm, BEND_MAX, BEND_FREE_END, BEND_FREE_TOP
    sC = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(C, axis=0), axis=1))])
    bC = bend_per_cm(C, sC); span = (sC > BEND_FREE_TOP) & (sC < sC[-1] - BEND_FREE_END)
    yv = es[0][:, 1]; kk = np.floor((yv - yv.min()) / 0.008).astype(int)
    Cs = np.array([es[0][kk == i].mean(0) for i in np.unique(kk) if (kk == i).sum() > 20])
    Ds = np.diff(Cs, axis=0); Ds /= np.linalg.norm(Ds, axis=1, keepdims=True)
    bs = np.degrees(np.arccos(np.clip(np.einsum('ij,ij->i', Ds[:-1], Ds[1:]), -1, 1)))
    above = Cs[1:-1, 1] > cc[1] + 0.03                      # slab bends above the abdominal turn into the cardia
    R['esophagus_bend_deg_per_cm'] = crit(round(float(bC[span].max()), 1), BEND_MAX, bC[span].max() <= BEND_MAX + 0.5,
                                          unit='deg per cm along the route, below its top 2 cm and above its distal 3 cm', at_y=round(float(C[span][np.argmax(bC[span]), 1]), 4),
                                          top_2cm_max_deg=round(float(bC[sC <= BEND_FREE_TOP].max()), 1),
                                          slab_bends_max_deg=round(float(bs[above].max()), 1) if above.any() else None,
                                          slab_bends_deg=[round(float(x), 1) for x in bs], slab_y=[round(float(x), 4) for x in Cs[1:-1, 1]],
                                          method='slab bends: angle between consecutive chords of 8 mm horizontal slab centroids of the mesh')
    # level of the oesophagus's upper end
    top = es[0][es[0][:, 1] > es[0][:, 1].max() - 0.003].mean(0)
    R['esophagus_top'] = dict(level=level_name(level(sex, top[1])), above_cricoid_lower_border_mm=round(float((cv[:, 1].min() - top[1]) * -1000), 1),
                              behind_cricoid=bool(top[2] < cv[:, 2].min() + 0.004))
    # volumes against Z-Anatomy (scaled by the body)
    vol = {}
    for k in ('stomach', 'esophagus', 'diaphragm', 'adrenal_l', 'adrenal_r', 'thyroid'):
        vol[k] = round(abs(signed_volume(*out[k])) * 1e6, 2)
    R['volumes_cm3'] = vol
    # stomach shape: the fundus rises above the cardia, to its left, under the left dome of the diaphragm
    sv = st[0]
    apex = sv[int(np.argmax(sv[:, 1]))]
    _, dd = closest_on_mesh(*di, apex[None])
    R['fundus_under_left_dome'] = crit(round(float((apex[1] - cc[1]) * 1000), 1), '> 0 above the GE junction, left of it, <= 15 mm below the diaphragm',
                                       bool(apex[1] > cc[1] and apex[0] > cc[0] and dd[0] <= 0.015), unit='mm above the GE junction',
                                       apex=np.round(apex, 4).tolist(), left_of_cardia_mm=round(float((apex[0] - cc[0]) * 1000), 1),
                                       gap_to_diaphragm_mm=round(float(dd[0] * 1000), 1),
                                       pylorus_right_of_cardia_mm=round(float((cc[0] - pc[0]) * 1000), 1),
                                       lowest_point_below_cardia_mm=round(float((cc[1] - sv[:, 1].min()) * 1000), 1))
    return R


TRI_BARY = np.array([[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0.0], [0.0, 0.5, 0.5], [0.5, 0.0, 0.5], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6],
                     [1 / 6, 1 / 6, 2 / 3]])


def _inflated_keys(sex):
    from fit.organs_data import _INFLATED_KEYS
    return _INFLATED_KEYS.get(sex, set())


def triangles_in(mesh, fields, band=0.004):
    """Triangle interiors of a sheet inside neighbours: 7 points per triangle (centroid, edge midpoints and three inner
    points) of every triangle with a vertex within `band` of the neighbour; a triangle counts when any of its points is
    inside. ok: no point deeper than DEPTH_MAX and at most FRAC_MAX % of the sheet's area."""
    v, f = mesh
    ar = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
    out, ok = {}, True
    for name, fl in fields:
        near = fl.coarse(v) < band
        fi = np.flatnonzero(near[f].any(1))
        deep = np.zeros(len(fi))
        for b in TRI_BARY:
            P = np.einsum('k,ikj->ij', b, v[f[fi]])
            deep = np.maximum(deep, -fl(P))
        hit = fi[deep > 0]
        pct = float(ar[hit].sum() / ar.sum() * 100)
        dmm = float(max(0.0, deep.max()) * 1000) if len(fi) else 0.0
        out[name] = dict(triangles=int(len(hit)), area_cm2=round(float(ar[hit].sum() * 1e4), 2), area_pct=round(pct, 3), deepest_mm=round(dmm, 2),
                         ok=bool(dmm <= DEPTH_MAX and pct <= FRAC_MAX))
        ok &= out[name]['ok']
    return crit({k: d['deepest_mm'] for k, d in out.items()}, f'<= {DEPTH_MAX} mm deep and <= {FRAC_MAX} % of the sheet', ok,
                unit='mm (deepest triangle-interior point inside the vessel)', per_vessel=out,
                method='7 barycentric points per triangle near the vessel; aorta field capped, IVC field with its lumen filled')


STAGES = ('neck', 'adrenals', 'diaphragm', 'stomach', 'esophagus', 'final', 'measure')   # --from=measure: re-measure only
REDO = None                                                                                 # --redo: set of stages to recompute


def _stage(sex, name, frm, compute):
    """Run one fitting stage, or (with --from=<later stage>) load its result from the stage cache."""
    import pickle
    path = os.path.join(cache_dir(sex), f'stage-{name}.pkl')
    cached = (REDO is not None and name not in REDO) or (frm is not None and STAGES.index(name) < STAGES.index(frm))
    if cached and os.path.exists(path):
        log(sex, name, '(stage cache)')
        with open(path, 'rb') as fh: return pickle.load(fh)
    res = compute()
    with open(path, 'wb') as fh: pickle.dump(res, fh)
    return res


def reseat_adrenals(sex, ad, dfl):
    """The diaphragm's crura may now touch the glands: re-seat each gland rigidly (shape kept) in the remaining free
    space next to its kidney, then a rigid refinement clears what the pose grid leaves (kidney gap kept near 2 mm)."""
    from fit.organs_adrenal import search_pose, rigid_refine, free_space_seat, penetration_depth, FREE_SEAT_SIDES
    out = {}
    iv = hra(sex, 'ivc')[0]

    def behind_ivc(P):
        # right gland: its medial part lies behind the IVC (energy when the IVC's back wall is not >= 1.5 mm in front)
        band = iv[(iv[:, 1] > P[:, 1].min()) & (iv[:, 1] < P[:, 1].max())]
        if not len(band): return 0.0
        med = P[P[:, 0] > np.percentile(P[:, 0], 70)]
        return len(P) * 0.5 * max(0.0, 0.0015 - (band[:, 2].min() - med[:, 2].mean())) ** 2
    for s_ in 'lr':
        v_, f_ = ad[s_]
        kfl = field(sex, f'kidney_{s_}')
        oth = [dfl] + [field(sex, k) for k in ('ivc', 'liver', 'spleen', 'pancreas', 'aorta', 'duodenum', 'colon', 'celiac', 'spine')]
        ex = behind_ivc if s_ == 'r' else None
        v2 = search_pose(v_, kfl, oth, radius=0.0045, step=0.0009, angles=(0.0, 0.07), log_=log, extra=ex)
        v2 = rigid_refine(v2, kfl, oth, iters=60, log_=log)
        # still more than 1 mm into the fitted sheet or a neighbour (no free pose within 4.5 mm): the wide free-space
        # seat on the kidney (organs_adrenal.free_space_seat) with the fitted sheet as an obstacle, then the refinement
        depth, _ = penetration_depth(v2, f_, oth)
        if s_ in FREE_SEAT_SIDES and depth > 0.001:
            v3, _r = free_space_seat(v2, f_, kfl, oth, v2.mean(0), rot_max=np.radians(30), radius=0.012, log_=log)
            v3 = rigid_refine(v3, kfl, oth, iters=60, log_=log)
            d3, _ = penetration_depth(v3, f_, oth)
            log(f'    adrenal {s_} re-seat: {depth * 1000:.2f} mm deep after the local search, {d3 * 1000:.2f} mm after the free-space seat')
            if d3 < depth and (ex is None or ex(v3) <= ex(v2) + 1e-12): v2 = v3
        out[s_] = (v2, orient_outward(v2, f_))
    return out


def fit(sex, render=True, frm=None):
    t0 = time.time()
    od = out_dir(sex); os.makedirs(od, exist_ok=True)
    W = warped(sex)
    rep = dict(sex=sex, group=GROUP, ribs_source=ribs(sex)[1])
    out, aux = {}, {}

    def neck():
        log(sex, 'neck')
        thy, pth, r, tfl, ax = fit_neck(sex, W)
        from fit.organs_thyroid import fold_faces
        tv_, tf_ = thy; bad = fold_faces(tv_, orient_outward(tv_, tf_))
        log(sex, f'thyroid placed: {len(bad)} faces where the gland passes through itself, volume {r.get("volume_cm3")} cm3')
        return thy, pth, r, ax
    thy, pth, rep['thyroid'], ax = _stage(sex, 'neck', frm, neck)
    out['thyroid'] = thy; out.update(pth); aux['airway_axis'] = ax
    aux['thyroid_field'] = mesh_field(*thy, 0.0003, pad=0.01)
    # each parathyroid cleared of its lobe by the exact distance (organs_thyroid.seat_pth; idempotent, so a neck stage
    # cached before this rule is corrected here too)
    from fit.organs_thyroid import seat_pth
    from fit.organs_neck import GAP_PTH
    for k in PTH:
        v_, f_ = out[k]; v2 = seat_pth(v_, f_, thy, GAP_PTH)
        rep['thyroid'].setdefault('parathyroids', {}).setdefault(k, {})['final_seat_shift_mm'] = round(float(np.linalg.norm(v2 - v_, axis=1).max() * 1000), 2)
        out[k] = (v2, f_)
    # each gland clear of the carotid sheath by the exact distance (organs_pth.clear_sheath: re-seated on its lobe's
    # posterior surface at its level, shape kept, 0-1 mm off the lobe)
    from fit.organs_pth import clear_sheath
    pg, prep = clear_sheath(sex, {k: out[k] for k in PTH}, thy, *ax)
    for k in PTH:
        out[k] = pg[k]; rep['thyroid'].setdefault('parathyroids', {}).setdefault(k, {})['sheath'] = prep[k]

    def adrenals():
        log(sex, 'adrenals')
        return fit_adrenals(sex, W)
    ad, rep['adrenals'] = _stage(sex, 'adrenals', frm, adrenals)

    def diaphragm():
        afl = {s: mesh_field(*ad[s], 0.0005) for s in 'lr'}
        log(sex, 'diaphragm')
        eso_proxy = warped_esophagus_field(W)
        (dv, df), r, _ = fit_diaphragm(sex, W, extra=[('esophagus', eso_proxy), ('adrenal_l', afl['l']), ('adrenal_r', afl['r'])])
        ad2 = reseat_adrenals(sex, ad, mesh_field(dv, df, 0.0006))
        log(sex, 'adrenals re-seated')
        # the crura give way locally to the re-seated glands: a settle of the sheet off them, checked over the sheet's
        # triangles (a gland is small against the sheet's triangles and would slip between its vertices)
        from fit.organs_settle import settle
        dv, r['crura_off_glands'] = settle(dv, df, [(f'adrenal_{s_}', mesh_field(*ad2[s_], 0.0005), 0.0006) for s_ in 'lr'],
                                           iters=20, w=8.0, inward=False, log=log, label='crura settle')
        return (dv, orient_outward(dv, df)), r, ad2
    (dv, df), rep['diaphragm'], ad = _stage(sex, 'diaphragm', frm, diaphragm)
    out['diaphragm'] = (dv, df)
    out['adrenal_l'], out['adrenal_r'] = ad['l'], ad['r']
    _dfl = {}

    def dfl():                                          # built only when a stage that needs it runs (about a minute)
        if 'd' not in _dfl: _dfl['d'] = mesh_field(dv, df, 0.0006)
        return _dfl['d']
    afl = {s_: mesh_field(*ad[s_], 0.0005) for s_ in 'lr'}

    prof = profile(W)                                   # Z-Anatomy's oesophagus cross-sections at body scale

    def stomach():
        log(sex, 'stomach')
        return fit_stomach_bed(sex, W, end_radius(prof), own=[('diaphragm', dfl()), ('adrenal_l', afl['l'])])
    st, rep['stomach'], loops = _stage(sex, 'stomach', frm, stomach)
    out['stomach'] = st; aux['stomach_loops'] = loops

    def esophagus():
        log(sex, 'oesophagus')
        sfl = mesh_field(*st, 0.0008, cap=True)
        thf = mesh_field(*thy, 0.0005)
        return fit_esophagus_sweep(sex, W, st, loops[1], own=[('thyroid', thf), ('stomach', sfl)], prof=prof)
    es, erep = _stage(sex, 'esophagus', frm, esophagus)
    erep = dict(erep); aux['esophagus_centreline'] = erep.pop('centreline'); rep['esophagus'] = erep
    out['esophagus'] = es

    def final():
        log(sex, 'final clearances')
        r = {}
        sfl = mesh_field(*st, 0.0008, cap=True)
        ad2 = {}
        for s_ in 'lr':
            # the left gland also keeps out of the stage-3 sheet: the settle below cannot see a gland its left crus
            # encloses (the male gland ended 8 % inside it); the right one is boxed in by the IVC, liver, spine and
            # kidney, and the crus there gives way in the settle (with the sheet as an obstacle it was pushed 1.8 mm
            # into the vertebral body)
            own_ = [('diaphragm', dfl()), ('stomach', sfl)] if s_ == 'l' else []
            ad2[s_], r[f'adrenal_{s_}'] = reseat_gland(sex, s_, out[f'adrenal_{s_}'], own=own_)
        own = [('stomach', sfl), ('esophagus', esophagus_field(*es, aux['esophagus_centreline']))]
        own += [(f'adrenal_{s_}', mesh_field(*ad2[s_], 0.0005)) for s_ in 'lr']
        dia, r['diaphragm'] = settle_diaphragm(sex, out['diaphragm'], own)
        # the crura give way to the glands where a gland's thin edge still pokes into the sheet (two-way: the near
        # face walks inwards past the edge; organs_final.crus_yield)
        dia, r['crus_yield'] = crus_yield(sex, dia, {f'adrenal_{s_}': ad2[s_] for s_ in 'lr'})
        return dia, ad2, r
    dia, ad2, rep['final'] = _stage(sex, 'final', frm, final)
    out['diaphragm'] = dia; out['adrenal_l'], out['adrenal_r'] = ad2['l'], ad2['r']
    log(sex, 'measuring')
    rep['criteria'] = measure(sex, out, aux)
    crit_keys = [k for k, v in rep['criteria'].items() if isinstance(v, dict) and 'ok' in v]
    rep['ok'] = all(rep['criteria'][k]['ok'] for k in crit_keys)
    rep['runtime_s'] = round(time.time() - t0, 1)
    if frm is not None: rep['stages_from_cache'] = list(STAGES[:STAGES.index(frm)])
    if REDO is not None: rep['stages_from_cache'] = [k for k in STAGES[:-1] if k not in REDO]
    from fit.organs_geom import orient_manifold          # winding carried across manifold edges only (the stomach's surface nets)
    outputs = []
    src = lambda k: ZA_NAMES.get(k) or za_original(k) and ZA_NAMES.get(k)
    names = [('stomach', 'stomach', 'stomach'), ('esophagus', 'esophagus', 'esophagus'), ('diaphragm', 'diaphragm', 'diaphragm'),
             ('adrenal_l', 'adrenal_gland_l', 'adrenals'), ('adrenal_r', 'adrenal_gland_r', 'adrenals'), ('thyroid', 'thyroid_gland', 'thyroid'),
             ('pth_sup_l', 'parathyroid_superior_l', 'parathyroids'), ('pth_sup_r', 'parathyroid_superior_r', 'parathyroids'),
             ('pth_inf_l', 'parathyroid_inferior_l', 'parathyroids'), ('pth_inf_r', 'parathyroid_inferior_r', 'parathyroids')]
    for key, name, part in names:
        v, f = out[key]
        outputs.append(dict(name=name, part=part, mesh=(v, orient_manifold(v, f)), source=[src(key)]))
    write_group(sex, GROUP, outputs, json.loads(json.dumps(rep, default=_jsonable)))
    log(sex, 'written', od)
    if render: qa(sex, out, aux)
    summary(rep)
    return rep


def _jsonable(o):
    if isinstance(o, np.ndarray): return o.tolist()
    if isinstance(o, (np.floating,)): return float(o)
    if isinstance(o, (np.integer,)): return int(o)
    if isinstance(o, (np.bool_,)): return bool(o)
    return str(o)


def summary(rep):
    c = rep['criteria']
    for k, v in c.items():
        if isinstance(v, dict) and 'ok' in v:
            print(f"  {'PASS' if v['ok'] else 'FAIL'}  {k}: {v['value']} (threshold {v['threshold']})" + (f"  {v.get('failing')}" if v.get('failing') else ''))


# ------------------------------------------------------------------------------------------------ QA renders
COL = dict(stomach='#e8836f', esophagus='#e0a060', diaphragm='#c0392b', adrenal='#f4d03f', thyroid='#a93226', pth='#f7dc6f')


def qa(sex, out, aux):
    from lib.qa import render_views
    od = out_dir(sex)
    nb = [('liver', '#7b4a36', 0.25), ('spleen', '#6c3483', 0.3), ('pancreas', '#d4ac0d', 0.35), ('colon', '#7d8a4a', 0.25), ('kidney_l', '#a04000', 0.4),
          ('kidney_r', '#a04000', 0.4), ('duodenum', '#ca9a5c', 0.45), ('ivc', '#2e4c9a', 0.55), ('aorta', '#e74c3c', 0.45), ('spine', '#e5e5e5', 0.35),
          ('heart', '#922b21', 0.2), ('lungs', '#aed6f1', 0.15), ('gallbladder', '#27ae60', 0.4)]
    items = [dict(mesh=hra(sex, k), color=c, opacity=o) for k, c, o in nb]
    ours = [dict(mesh=out['stomach'], color=COL['stomach']), dict(mesh=out['esophagus'], color=COL['esophagus']),
            dict(mesh=out['adrenal_l'], color=COL['adrenal']), dict(mesh=out['adrenal_r'], color=COL['adrenal']),
            dict(mesh=out['diaphragm'], color=COL['diaphragm'], opacity=0.55)]
    c = out['stomach'][0].mean(0) * 0.5 + out['diaphragm'][0].mean(0) * 0.5
    r = 0.17
    render_views(items + ours, {'abdomen-front': dict(dir=(0, 0.05, 1), target=c, radius=r), 'abdomen-back': dict(dir=(0, 0.05, -1), target=c, radius=r),
                                'abdomen-left': dict(dir=(1, 0.05, 0), target=c, radius=r), 'abdomen-right': dict(dir=(-1, 0.05, 0), target=c, radius=r)},
                 os.path.join(od, 'qa'))
    # close-ups
    pyl, car, ring = aux['stomach_loops']
    cc = out['stomach'][0][car].mean(0); pc = out['stomach'][0][pyl].mean(0)
    ge_items = [dict(mesh=out['stomach'], color=COL['stomach'], opacity=0.9), dict(mesh=out['esophagus'], color=COL['esophagus']),
                dict(mesh=out['diaphragm'], color=COL['diaphragm'], opacity=0.22), dict(mesh=hra(sex, 'aorta'), color='#e74c3c', opacity=0.5),
                dict(mesh=hra(sex, 'liver'), color='#7b4a36', opacity=0.12), dict(mesh=hra(sex, 'spine'), color='#e5e5e5', opacity=0.3)]
    render_views(ge_items, {'ge-junction-front': dict(dir=(0.3, 0.2, 1), target=cc, radius=0.07), 'ge-junction-back': dict(dir=(-0.2, 0.2, -1), target=cc, radius=0.07)},
                 os.path.join(od, 'qa'))
    # the stomach's own shape: with the oesophagus and duodenum only
    st_items = [dict(mesh=out['stomach'], color=COL['stomach']), dict(mesh=out['esophagus'], color=COL['esophagus']),
                dict(mesh=hra(sex, 'duodenum'), color='#ca9a5c', opacity=0.85)]
    cs = out['stomach'][0].mean(0)
    render_views(st_items, {'stomach-front': dict(dir=(0, 0.1, 1), target=cs, radius=0.11), 'stomach-left': dict(dir=(1, 0.1, 0.2), target=cs, radius=0.11)},
                 os.path.join(od, 'qa'))
    py_items = [dict(mesh=out['stomach'], color=COL['stomach'], opacity=0.9), dict(mesh=hra(sex, 'duodenum'), color='#ca9a5c', opacity=0.9),
                dict(mesh=hra(sex, 'pancreas'), color='#d4ac0d', opacity=0.4), dict(mesh=hra(sex, 'liver'), color='#7b4a36', opacity=0.2),
                dict(mesh=hra(sex, 'gallbladder'), color='#27ae60', opacity=0.5)]
    render_views(py_items, {'pylorus-front': dict(dir=(0, 0.2, 1), target=pc, radius=0.045), 'pylorus-below': dict(dir=(0, -1, 0.3), target=pc, radius=0.045)},
                 os.path.join(od, 'qa'))
    for s in 'lr':
        a = out[f'adrenal_{s}']
        # the gland on its kidney with the great vessels; the diaphragm (crura) faint, liver / spleen / pancreas left
        # out so that the gland is visible (they are checked by the contact measurements)
        ad_items = [dict(mesh=a, color=COL['adrenal']), dict(mesh=hra(sex, f'kidney_{s}'), color='#a04000', opacity=0.55),
                    dict(mesh=hra(sex, 'ivc'), color='#2e4c9a', opacity=0.6), dict(mesh=hra(sex, 'aorta'), color='#e74c3c', opacity=0.5),
                    dict(mesh=out['diaphragm'], color=COL['diaphragm'], opacity=0.18)]
        ca = a[0].mean(0); sx = -1 if s == 'r' else 1
        render_views(ad_items, {f'adrenal-{s}-back': dict(dir=(0, 0.3, -1), target=ca, radius=0.06), f'adrenal-{s}-front': dict(dir=(0, 0.3, 1), target=ca, radius=0.06),
                                f'adrenal-{s}-side': dict(dir=(sx, 0.2, 0), target=ca, radius=0.06)}, os.path.join(od, 'qa'))
    th_items = [dict(mesh=out['thyroid'], color=COL['thyroid'], opacity=0.9), dict(mesh=hra(sex, 'thyroid_cart'), color='#f0f0f0', opacity=0.7),
                dict(mesh=hra(sex, 'cricoid'), color='#d6eaf8', opacity=0.8), dict(mesh=hra(sex, 'trachea'), color='#abebc6', opacity=0.5),
                dict(mesh=hra(sex, 'trach_cart'), color='#d5f5e3', opacity=0.7), dict(mesh=out['esophagus'], color=COL['esophagus'], opacity=0.8)]
    th_items += [dict(mesh=out[k], color=COL['pth']) for k in PTH]
    # the carotid sheaths' vessels (vessels group), which the lobes lie in front of and medial to
    vd = os.path.join(os.path.dirname(od), 'vessels')
    if os.path.exists(os.path.join(vd, 'manifest.json')):
        from lib.mesh import load
        for o in json.load(open(os.path.join(vd, 'manifest.json'))):
            if 'common_carotid' in o['name'] or 'internal_jugular' in o['name']:
                th_items.append(dict(mesh=load(os.path.join(vd, o['file'])), color='#e74c3c' if 'carotid' in o['name'] else '#2e4c9a', opacity=0.55))
    ct = out['thyroid'][0].mean(0)
    render_views(th_items, {'thyroid-front': dict(dir=(0, 0, 1), target=ct, radius=0.045), 'thyroid-left': dict(dir=(1, 0, 0.15), target=ct, radius=0.045),
                            'thyroid-right': dict(dir=(-1, 0, 0.15), target=ct, radius=0.045),
                            'thyroid-back': dict(dir=(0, 0.1, -1), target=ct, radius=0.045)}, os.path.join(od, 'qa'))
    # under the heart: the central tendon between the heart and the liver (as assembled: heart + 4 mm carved out)
    hv = hra(sex, 'heart')
    ch = hv[0][hv[0][:, 1] < hv[0][:, 1].min() + 0.02].mean(0)
    ht_items = [dict(mesh=out['diaphragm'], color=COL['diaphragm'], opacity=0.85), dict(mesh=hv, color='#922b21', opacity=0.35),
                dict(mesh=hra(sex, 'liver'), color='#7b4a36', opacity=0.3)]
    render_views(ht_items, {'heart-tendon-front': dict(dir=(0, 0.15, 1), target=ch, radius=0.08), 'heart-tendon-right': dict(dir=(-1, 0.15, 0.2), target=ch, radius=0.08)},
                 os.path.join(od, 'qa'))


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    which = args[0] if args else 'all'
    frm = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--from=')), None)
    assert frm is None or frm in STAGES, f'--from=<one of {STAGES}>'
    redo = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--redo=')), None)
    if redo is not None:
        REDO = set(redo.split(','))
        assert REDO <= set(STAGES), f'--redo=<stages from {STAGES}>'
    for sex in (['male', 'female'] if which == 'all' else [which]):
        fit(sex, render='--no-render' not in sys.argv, frm=frm)
