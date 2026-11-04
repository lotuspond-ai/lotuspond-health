"""Organs group: stomach, oesophagus, diaphragm, suprarenal glands, thyroid gland and parathyroid glands.
Usage: python3 fit/organs.py [male|female|all] [--no-render]

Every structure starts from the cached trunk warp (fit.common.get_warp(sex, 'trunk')) and is then refined against the
HRA neighbours it touches (see organs_neck, organs_adrenal, organs_diaphragm, organs_gi for each method):
  1. thyroid + parathyroids  similarity from the larynx cartilages, slide to tracheal rings 2-4, smooth push-out,
                             glands slid onto the lobes' posterior surface
  2. diaphragm               as-rigid-as-possible fit: openings follow the HRA IVC / aorta, domes 1.5 mm under the
                             lung bases and heart, collision push-out, local thinning where HRA leaves no room
  3. adrenals                undistorted gland laid on its warped pose, free-space pose search, 2 mm off the kidney
  4. stomach                 as-rigid-as-possible fit: pylorus snapped onto the duodenal opening, push-out
  5. oesophagus              tube re-routed to the cardia through the hiatus, cross-sections kept, junction snapped
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
from fit.organs_geom import Field, mesh_field  # noqa: E402
from fit.organs_neck import fit_neck, isthmus, ring_profile, PTH  # noqa: E402
from fit.organs_adrenal import fit_adrenals  # noqa: E402
from fit.organs_diaphragm import fit_diaphragm, crossing  # noqa: E402
from fit.organs_gi import fit_stomach, fit_esophagus, loop_axis  # noqa: E402

GROUP = 'organs'
DEPTH_MAX = 1.0        # mm
FRAC_MAX = 0.5         # % of the structure's surface


def crit(value, threshold, ok, unit='', **kw):
    d = dict(value=value, threshold=threshold, ok=bool(ok))
    if unit: d['unit'] = unit
    d.update(kw)
    return d


def penetration(mesh, fl, n=20000, seed=3, exclude=None):
    """(% of the mesh surface inside fl, deepest mm)."""
    p = sample_surface(*mesh, n, seed=seed)
    if exclude is not None: p = p[~exclude(p)]
    d = fl(p)
    ins = d < 0
    return round(float(ins.mean() * 100), 3), round(float(max(0.0, -d.min()) * 1000), 2)


def pair(mesh, fl, n=20000, exclude=None, listed=True):
    frac, depth = penetration(mesh, fl, n=n, exclude=exclude)
    return dict(inside_pct=frac, deepest_mm=depth, ok=bool(frac <= FRAC_MAX and depth <= DEPTH_MAX), listed=listed)


def level_crit(sex, y, lo, hi):
    x = level(sex, y)
    a, b = VERTS.index(lo) - 0.5, VERTS.index(hi) + 0.5
    return crit(level_name(x), f'{lo}-{hi}', a <= x <= b, level_index=round(x, 2), y=round(float(y), 4))


def lung_base(sex):
    """Samples of the lungs' diaphragmatic surfaces: downward-facing lung surface (normal y < -0.5), not on a fissure
    (>= 4 mm from another lobe), the lowest lung surface in its 4 mm column, below the heart's top."""
    path = os.path.join(cache_dir(sex), 'lung-base.npz')
    if os.path.exists(path): return np.load(path)['p']
    P = []
    lobes = {k: hra(sex, k) for k in LOBES}
    for k, (v, f) in lobes.items():
        fl = Field.build(v, f, 0.001)
        p = sample_surface(v, f[fl.fsel], 30000, seed=1)
        q, d, t = fl.closest(p); nrm = fl.fn[t]
        others = np.concatenate([lobes[o][0] for o in LOBES if o != k])
        dz, _ = cKDTree(others).query(p)
        P.append(p[(nrm[:, 1] < -0.5) & (dz > 0.004)])
    P = np.concatenate(P)
    allv = np.concatenate([lobes[k][0] for k in LOBES])
    key = np.floor(allv[:, [0, 2]] / 0.004).astype(np.int64)
    low = {}
    for kk, y in zip(map(tuple, key), allv[:, 1]):
        if y < low.get(kk, 9): low[kk] = y
    kp = np.floor(P[:, [0, 2]] / 0.004).astype(np.int64)
    lowest = np.array([low.get(tuple(k), 9) for k in kp])
    P = P[P[:, 1] < lowest + 0.012]
    # not the parts lying on the heart (cardiac impression) or on the mediastinum above it
    hd = field(sex, 'heart')(P)
    P = P[hd > 0.015]
    np.savez(path, p=P)
    return P


def measure(sex, out, aux):
    """All acceptance criteria. out: {name: (v, f)}; aux: fit by-products."""
    R = {}
    F = lambda k: field(sex, k)
    own = {}
    for k in ('stomach', 'esophagus', 'diaphragm', 'adrenal_l', 'adrenal_r', 'thyroid'):
        own[k] = mesh_field(*out[k], 0.0006, cap=(k == 'stomach'))
    st, es, di = out['stomach'], out['esophagus'], out['diaphragm']
    pyl, car, ring = aux['stomach_loops']
    cc, cn, crad = loop_axis(st[0][car])
    near_junction = lambda p: np.linalg.norm(p - cc, axis=1) < 0.012
    pc = st[0][pyl].mean(0)
    near_pylorus = lambda p: np.linalg.norm(p - pc, axis=1) < 0.012
    pairs = {}
    # stomach
    pairs['stomach'] = {k: pair(st, F(k)) for k in ('liver', 'spleen', 'pancreas', 'colon', 'kidney_l', 'kidney_r')}
    pairs['stomach']['diaphragm'] = pair(st, own['diaphragm'])
    pairs['stomach']['gallbladder'] = pair(st, F('gallbladder'), listed=False)
    pairs['stomach']['duodenum (beyond the pylorus)'] = pair(st, F('duodenum'), exclude=near_pylorus, listed=False)
    pairs['stomach']['adrenal_l'] = pair(st, own['adrenal_l'], listed=False)
    # oesophagus
    pairs['esophagus'] = {k: pair(es, F(k)) for k in ('trachea', 'trach_cart', 'la', 'aorta', 'spine')}
    pairs['esophagus']['diaphragm'] = pair(es, own['diaphragm'])
    for k in ('heart', 'bronchi', 'cricoid', 'thyroid_cart', 'liver'):
        pairs['esophagus'][k] = pair(es, F(k), listed=False)
    pairs['esophagus']['thyroid'] = pair(es, own['thyroid'], listed=False)
    pairs['esophagus']['stomach (beyond the junction)'] = pair(es, own['stomach'], exclude=near_junction, listed=False)
    # diaphragm
    pairs['diaphragm'] = {k: pair(di, F(k), n=40000) for k in ('lungs', 'heart', 'liver', 'spleen', 'ivc', 'aorta')}
    pairs['diaphragm']['stomach'] = pair(di, own['stomach'], n=40000)
    pairs['diaphragm']['esophagus'] = pair(di, own['esophagus'], n=40000)
    for k in ('kidney_l', 'kidney_r', 'colon', 'pancreas', 'spine', 'ribs'):
        pairs['diaphragm'][k] = pair(di, F(k), n=40000, listed=False)
    # adrenals: touching nothing but their kidney
    for s in 'lr':
        a = out[f'adrenal_{s}']
        pairs[f'adrenal_{s}'] = {k: pair(a, F(k), n=6000) for k in ('ivc', 'liver', 'spleen', 'pancreas', 'aorta', 'duodenum', 'colon', 'spine',
                                                                    f'kidney_{s}')}
        pairs[f'adrenal_{s}']['diaphragm'] = pair(a, own['diaphragm'], n=6000)
        pairs[f'adrenal_{s}']['stomach'] = pair(a, own['stomach'], n=6000)
    # thyroid
    pairs['thyroid'] = {k: pair(out['thyroid'], F(k), n=10000) for k in ('thyroid_cart', 'cricoid', 'trachea', 'trach_cart')}
    pairs['thyroid']['esophagus'] = pair(out['thyroid'], own['esophagus'], n=10000, listed=False)
    R['contact_pairs'] = pairs
    listed = [(o, k, v) for o, d in pairs.items() for k, v in d.items() if v['listed']]
    R['contact_pairs_summary'] = crit(sum(v['ok'] for _, _, v in listed), len(listed), all(v['ok'] for _, _, v in listed),
                                      unit='listed pairs passing (<= 1 mm deep and <= 0.5 % of surface)',
                                      failing=[f'{o} x {k}: {v["inside_pct"]}% / {v["deepest_mm"]} mm' for o, k, v in listed if not v['ok']])
    # joins
    from lib.mesh import closest_on_mesh
    _, d = closest_on_mesh(*es, st[0][car])
    R['cardia_join_gap_mm'] = crit(round(float(d.max() * 1000), 2), 2.0, d.max() <= 0.002, mean=round(float(d.mean() * 1000), 2))
    seg = np.concatenate([np.linspace(ring[i], ring[(i + 1) % len(ring)], 8, endpoint=False) for i in range(len(ring))])
    d2, _ = cKDTree(seg).query(st[0][pyl])
    R['pylorus_join_gap_mm'] = crit(round(float(d2.max() * 1000), 2), 2.0, d2.max() <= 0.002, mean=round(float(d2.mean() * 1000), 2))
    # levels
    R['ge_junction_level'] = level_crit(sex, cc[1], 'T10', 'T12')
    C = aux['esophagus_centreline']
    cov, i = crossing(di[0], C)
    R['esophageal_hiatus_level'] = level_crit(sex, C[i][1], 'T9', 'T11') if i is not None else crit(None, 'T9-T11', False)
    if i is not None: R['esophageal_hiatus_level']['coverage'] = round(cov, 2)
    Ca = vessel_centreline(hra(sex, 'aorta_abd')[0])
    cov, i = crossing(di[0], Ca)
    R['aortic_hiatus_level'] = level_crit(sex, Ca[i][1], 'T11', 'L1') if i is not None else crit(None, 'T11-L1', False)
    if i is not None: R['aortic_hiatus_level']['coverage'] = round(cov, 2)
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
    within = (dist >= 0) & (dist <= 0.006)
    R['lung_base_to_diaphragm_mm'] = crit(round(float(within.mean() * 100), 1), 90.0, within.mean() >= 0.9, unit='% of lung-base samples within 0-6 mm',
                                          p5=round(float(np.percentile(dist, 5) * 1000), 2), median=round(float(np.median(dist) * 1000), 2),
                                          p95=round(float(np.percentile(dist, 95) * 1000), 2), samples=int(len(P)))
    # adrenals on the kidneys
    for s in 'lr':
        a = out[f'adrenal_{s}']; p = sample_surface(*a, 6000, seed=1)
        g = float(F(f'kidney_{s}')(p).min() * 1000)
        R[f'adrenal_{s}_kidney_gap_mm'] = crit(round(g, 2), '1-5', 1.0 <= g <= 5.0)
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
    tv = out['thyroid'][0]; sv = (tv - c0) @ av
    R['thyroid_rings'] = dict(rings_mm=[(round(a0 * 1000, 1), round(a1 * 1000, 1)) for a0, a1 in rings], isthmus_ring=ri,
                              lobes_from_mm=round(float(sv.min() * 1000), 1), lobes_to_mm=round(float(sv.max() * 1000), 1),
                              note='distances below the cricoid\'s lower border along the airway; rings from the anterior tracheal cartilage profile')
    # parathyroids
    tfl = aux['thyroid_field']
    for k in PTH:
        p = sample_surface(*out[k], 800, seed=1); d = tfl(p)
        R[f'{k}_to_thyroid'] = crit(round(float(d.min() * 1000), 2), '0-1 mm, none inside', (d.min() <= 0.001) and (d >= 0).all(),
                                    inside_pct=round(float((d < 0).mean() * 100), 2), centre=np.round(out[k][0].mean(0), 4).tolist())
    # level of the oesophagus's upper end
    top = es[0][es[0][:, 1] > es[0][:, 1].max() - 0.003].mean(0)
    R['esophagus_top'] = dict(level=level_name(level(sex, top[1])), above_cricoid_lower_border_mm=round(float((cv[:, 1].min() - top[1]) * -1000), 1),
                              behind_cricoid=bool(top[2] < cv[:, 2].min() + 0.004))
    # volumes against Z-Anatomy (scaled by the body)
    vol = {}
    for k in ('stomach', 'esophagus', 'diaphragm', 'adrenal_l', 'adrenal_r', 'thyroid'):
        vol[k] = round(abs(signed_volume(*out[k])) * 1e6, 2)
    R['volumes_cm3'] = vol
    return R


def fit(sex, render=True):
    t0 = time.time()
    od = out_dir(sex); os.makedirs(od, exist_ok=True)
    W = warped(sex)
    rep = dict(sex=sex, group=GROUP, ribs_source=ribs(sex)[1])
    out, aux = {}, {}
    log(sex, 'neck')
    thy, pth, rep['thyroid'], tfl, ax = fit_neck(sex, W)
    out['thyroid'] = thy; out.update(pth); aux['thyroid_field'] = tfl; aux['airway_axis'] = ax
    log(sex, 'adrenals')
    ad, rep['adrenals'] = fit_adrenals(sex, W)
    out['adrenal_l'], out['adrenal_r'] = ad['l'], ad['r']
    afl = {s: mesh_field(*ad[s], 0.0005) for s in 'lr'}
    log(sex, 'diaphragm')
    eso_proxy = mesh_field(*W['esophagus'], 0.0008)
    (dv, df), rep['diaphragm'], _ = fit_diaphragm(sex, W, extra=[('esophagus', eso_proxy), ('adrenal_l', afl['l']), ('adrenal_r', afl['r'])])
    out['diaphragm'] = (dv, df)
    dfl = mesh_field(dv, df, 0.0006)
    # the glands are much finer meshes than the sheet: let them clear the fitted crura (kidney gap kept >= 1.2 mm)
    from fit.organs_adrenal import CLEAR as ACLEAR
    from fit.organs_geom import push_out
    for s_ in 'lr':
        v_, f_ = ad[s_]
        nbs = [(field(sex, f'kidney_{s_}'), 0.0012), (dfl, 0.0005)] + [(field(sex, k), ACLEAR) for k in ('ivc', 'liver', 'spleen', 'pancreas', 'aorta', 'duodenum', 'colon', 'spine')]
        v2 = push_out(v_, f_, nbs, clearance=ACLEAR, iters=10)
        ad[s_] = (v2, orient_outward(v2, f_))
    out['adrenal_l'], out['adrenal_r'] = ad['l'], ad['r']
    afl = {s_: mesh_field(*ad[s_], 0.0005) for s_ in 'lr'}
    log(sex, 'stomach')
    st, rep['stomach'], loops = fit_stomach(sex, W, own=[('diaphragm', dfl), ('adrenal_l', afl['l'])])
    out['stomach'] = st; aux['stomach_loops'] = loops
    log(sex, 'oesophagus')
    sfl = mesh_field(*st, 0.0008, cap=True)
    thf = mesh_field(*thy, 0.0005)
    es, erep, tube = fit_esophagus(sex, W, st, loops[1], own=[('thyroid', thf), ('diaphragm', dfl), ('stomach', sfl)])
    aux['esophagus_centreline'] = erep.pop('centreline'); rep['esophagus'] = erep
    out['esophagus'] = es
    log(sex, 'measuring')
    rep['criteria'] = measure(sex, out, aux)
    crit_keys = [k for k, v in rep['criteria'].items() if isinstance(v, dict) and 'ok' in v]
    rep['ok'] = all(rep['criteria'][k]['ok'] for k in crit_keys)
    rep['runtime_s'] = round(time.time() - t0, 1)
    outputs = []
    src = lambda k: ZA_NAMES.get(k) or za_original(k) and ZA_NAMES.get(k)
    names = [('stomach', 'stomach', 'stomach'), ('esophagus', 'esophagus', 'esophagus'), ('diaphragm', 'diaphragm', 'diaphragm'),
             ('adrenal_l', 'adrenal_gland_l', 'adrenals'), ('adrenal_r', 'adrenal_gland_r', 'adrenals'), ('thyroid', 'thyroid_gland', 'thyroid'),
             ('pth_sup_l', 'parathyroid_superior_l', 'parathyroids'), ('pth_sup_r', 'parathyroid_superior_r', 'parathyroids'),
             ('pth_inf_l', 'parathyroid_inferior_l', 'parathyroids'), ('pth_inf_r', 'parathyroid_inferior_r', 'parathyroids')]
    for key, name, part in names:
        v, f = out[key]
        outputs.append(dict(name=name, part=part, mesh=(v, orient_outward(v, f)), source=[src(key)]))
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
    ge_items = [dict(mesh=out['stomach'], color=COL['stomach'], opacity=0.85), dict(mesh=out['esophagus'], color=COL['esophagus']),
                dict(mesh=out['diaphragm'], color=COL['diaphragm'], opacity=0.5), dict(mesh=hra(sex, 'aorta'), color='#e74c3c', opacity=0.6),
                dict(mesh=hra(sex, 'liver'), color='#7b4a36', opacity=0.25), dict(mesh=hra(sex, 'spine'), color='#e5e5e5', opacity=0.4)]
    render_views(ge_items, {'ge-junction-front': dict(dir=(0.3, 0.2, 1), target=cc, radius=0.05), 'ge-junction-back': dict(dir=(-0.2, 0.2, -1), target=cc, radius=0.05)},
                 os.path.join(od, 'qa'))
    py_items = [dict(mesh=out['stomach'], color=COL['stomach'], opacity=0.9), dict(mesh=hra(sex, 'duodenum'), color='#ca9a5c', opacity=0.9),
                dict(mesh=hra(sex, 'pancreas'), color='#d4ac0d', opacity=0.4), dict(mesh=hra(sex, 'liver'), color='#7b4a36', opacity=0.2),
                dict(mesh=hra(sex, 'gallbladder'), color='#27ae60', opacity=0.5)]
    render_views(py_items, {'pylorus-front': dict(dir=(0, 0.2, 1), target=pc, radius=0.045), 'pylorus-below': dict(dir=(0, -1, 0.3), target=pc, radius=0.045)},
                 os.path.join(od, 'qa'))
    for s in 'lr':
        a = out[f'adrenal_{s}']
        ad_items = [dict(mesh=a, color=COL['adrenal']), dict(mesh=hra(sex, f'kidney_{s}'), color='#a04000', opacity=0.6), dict(mesh=hra(sex, 'ivc'), color='#2e4c9a', opacity=0.6),
                    dict(mesh=hra(sex, 'aorta'), color='#e74c3c', opacity=0.5), dict(mesh=hra(sex, 'liver' if s == 'r' else 'spleen'), color='#7b4a36', opacity=0.25),
                    dict(mesh=out['diaphragm'], color=COL['diaphragm'], opacity=0.3), dict(mesh=hra(sex, 'pancreas'), color='#d4ac0d', opacity=0.3)]
        ca = a[0].mean(0)
        render_views(ad_items, {f'adrenal-{s}-back': dict(dir=(0, 0.3, -1), target=ca, radius=0.045), f'adrenal-{s}-front': dict(dir=(0, 0.3, 1), target=ca, radius=0.045)},
                     os.path.join(od, 'qa'))
    th_items = [dict(mesh=out['thyroid'], color=COL['thyroid'], opacity=0.9), dict(mesh=hra(sex, 'thyroid_cart'), color='#f0f0f0', opacity=0.7),
                dict(mesh=hra(sex, 'cricoid'), color='#d6eaf8', opacity=0.8), dict(mesh=hra(sex, 'trachea'), color='#abebc6', opacity=0.5),
                dict(mesh=hra(sex, 'trach_cart'), color='#d5f5e3', opacity=0.7), dict(mesh=out['esophagus'], color=COL['esophagus'], opacity=0.8)]
    th_items += [dict(mesh=out[k], color=COL['pth']) for k in PTH]
    ct = out['thyroid'][0].mean(0)
    render_views(th_items, {'thyroid-front': dict(dir=(0, 0, 1), target=ct, radius=0.04), 'thyroid-left': dict(dir=(1, 0, 0), target=ct, radius=0.04),
                            'thyroid-back': dict(dir=(0, 0, -1), target=ct, radius=0.04)}, os.path.join(od, 'qa'))


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    which = args[0] if args else 'all'
    for sex in (['male', 'female'] if which == 'all' else [which]):
        fit(sex, render='--no-render' not in sys.argv)
