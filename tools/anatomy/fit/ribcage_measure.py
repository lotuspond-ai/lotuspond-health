"""Ribcage fit, part 4: the acceptance measurements (all distances in mm in the report).

Every distance that decides pass/fail is an exact point-to-triangle distance; voxel fields only give the inside/outside
sign away from the surface (see ribcage_data.Target.exact).
"""
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import sample_surface, area, dense_points, closest_on_mesh, merge


def mm(x, nd=2):
    return round(float(x) * 1000, nd)


def crit(value_mm, threshold_mm, ok, **extra):
    return dict(value=value_mm, threshold=threshold_mm, ok=bool(ok), **extra)


def samples(mesh, per_cm2=40, seed=0, nmin=500):
    v, f = mesh
    n = int(max(nmin, area(v, f) * 1e4 * per_cm2))
    return sample_surface(v, f, n, seed=seed)


def signed(target, p):
    """Exact signed distance where it matters (within 15 mm of the surface), the field elsewhere."""
    d = target.sdf(p)
    near = d < 0.015
    if near.any(): d[near] = target.exact(p[near])
    return d


def unsigned(target, p):
    _, d = closest_on_mesh(*target.mesh, p, k=12)
    return d


def ribs_in_lungs(ribs, lungs, zones=None, overlap=None):
    """ribs: {(n, side): mesh}. Fraction of rib surface inside the lungs and the deepest point, over all rib surface
    and outside the lung/spine conflict zone (zones: {(n, side): per-vertex mask}, see ribcage_ribs.conflict_zone)."""
    from scipy.spatial import cKDTree
    per, allin, alld, allz = {}, [], [], []
    for key, (v, f) in ribs.items():
        p = samples((v, f), seed=key[0])
        d = signed(lungs, p)
        z = zones[key][cKDTree(v).query(p)[1]] if zones is not None else np.zeros(len(p), bool)
        e = dict(inside_pct=round(float((d < 0).mean() * 100), 3), deepest_mm=mm(max(0, -d.min())))
        if z.any():
            e.update(in_conflict_zone_pct=round(float(z.mean() * 100), 1),
                     outside_zone_inside_pct=round(float((d[~z] < 0).mean() * 100), 3) if (~z).any() else 0.0,
                     outside_zone_deepest_mm=mm(max(0, -d[~z].min())) if (~z).any() else 0.0)
        per[f'{key[0]}{key[1]}'] = e
        allin.append(d < 0); alld.append(d); allz.append(z)
    allin = np.concatenate(allin); alld = np.concatenate(alld); allz = np.concatenate(allz)
    frac = float(allin.mean()); deep = max(0.0, float(-alld.min()))
    out = dict(inside_fraction=crit(round(frac * 100, 3), 0.5, frac < 0.005, unit='% of rib surface'),
               deepest=crit(mm(deep), 1.0, deep <= 0.001))
    if zones is not None:
        o = ~allz
        f2 = float(allin[o].mean()); d2 = max(0.0, float(-alld[o].min()))
        out['outside_conflict_zone'] = dict(inside_fraction=crit(round(f2 * 100, 3), 0.5, f2 < 0.005, unit='% of rib surface outside the zone'),
                                            deepest=crit(mm(d2), 1.0, d2 <= 0.001), zone_share_pct=round(float(allz.mean() * 100), 2))
        if overlap:
            out['conflict'] = dict(note='The HRA lung meshes overlap the HRA vertebrae themselves (no real lung can enter bone) and fill the '
                                        'paravertebral gutter up to the transverse processes, where the rib necks lie. A rib seated on its '
                                        'costovertebral and costotransverse joints there cannot be outside the lung, so the joint segment (head, '
                                        'neck and tubercle, up to 10 mm past the tubercle; ribs 11-12: 30 mm past the head) of ribs at '
                                        'overlapped levels (T(n-1), T(n) or T(n+1) on that side) is reported separately; the rest of every rib '
                                        'must meet the criterion.',
                                   lung_into_vertebra_mm={f'{k[0]}{"L" if k[1] == "l" else "R"}': mm(v, 1) for k, v in sorted(overlap.items())})
    out['per_rib'] = per
    return out


def lateral_gap(ribs, lungs, side_sign):
    """Gap between the inner rib surface and the lung where the costal surface faces sideways (|n_x| >= 0.7)."""
    out, allg = {}, []
    for key, (v, f) in ribs.items():
        p = samples((v, f), per_cm2=60, seed=11 + key[0])
        d = lungs.sdf(p)
        g = lungs.field.grad(p)
        s = side_sign[key[1]]
        # inner surface: the lung is the nearest thing in the direction the bone surface faces inwards; use points
        # whose nearest lung surface is within 20 mm and faces this side laterally
        lat = (g[:, 0] * s >= 0.7) & (d < 0.02)
        if lat.sum() < 20: continue
        dd = signed(lungs, p[lat])
        # keep the inner half: the points nearest the lung in each 5 mm band of height
        y = p[lat, 1]; keep = np.zeros(len(dd), bool)
        for y0 in np.arange(y.min(), y.max() + 0.005, 0.005):
            m = np.flatnonzero((y >= y0) & (y < y0 + 0.005))
            if len(m): keep[m[dd[m] <= np.quantile(dd[m], 0.25)]] = True
        gg = dd[keep]
        allg.append(gg)
        out[f'{key[0]}{key[1]}'] = dict(n=int(len(gg)), min=mm(gg.min(), 1), p10=mm(np.quantile(gg, 0.1), 1), median=mm(np.median(gg), 1), p90=mm(np.quantile(gg, 0.9), 1))
    allg = np.concatenate(allg) if allg else np.zeros(1)
    q = [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1]
    return dict(definition='inner rib surface (nearest quarter per 5 mm height band) where the lung surface faces sideways (|n_x| >= 0.7); signed distance to the lung, mm',
                overall={f'p{int(a * 100)}': mm(np.quantile(allg, a), 1) for a in q}, per_rib=out)


def facet_distance(points, target):
    """(median, p90, min) exact unsigned distance (m) and the deepest penetration (m) of facet points."""
    d = unsigned(target, points)
    s = signed(target, points)
    pen = max(0.0, float(-s.min()))
    return float(np.median(d)), float(np.quantile(d, 0.9)), float(d.min()), pen


def joints(ribgeoms, ribs, verts, cord=None):
    """Rib head and tubercle seating. ribgeoms/ribs: {(n, side): RibGeom / mesh}; verts: {'T1': Target, ...}."""
    head, tub = {}, {}
    ok_h, ok_t, worst_h, worst_t = True, True, 0.0, 0.0
    for key, rg in ribgeoms.items():
        n, s = key; v = ribs[key][0]; name = f'{n}{s}'
        i, _ = rg.facets['head_lo']
        med, p90, mn, pen = facet_distance(v[i], verts[f'T{n}'])
        e = dict(vertebrae=[f'T{n}'], lower_facet_to=f'T{n}', lower_median_mm=mm(med), lower_p90_mm=mm(p90), penetration_mm=mm(pen))
        vals = [med]
        if 2 <= n <= 9:
            iu, _ = rg.facets['head_up']
            medu, p90u, mnu, penu = facet_distance(v[iu], verts[f'T{n - 1}'])
            e.update(vertebrae=[f'T{n - 1}', f'T{n}'], upper_facet_to=f'T{n - 1}', upper_median_mm=mm(medu), upper_p90_mm=mm(p90u), penetration_mm=mm(max(pen, penu)))
            vals.append(medu)
        # level check: the head centre is nearer its own vertebra(e) than to any other
        hc = v[np.concatenate([rg.facets[k][0] for k in ('head_lo', 'head_up') if k in rg.facets])].mean(0)[None]
        dist = {k: float(unsigned(t, hc)[0]) for k, t in verts.items() if k.startswith('T') or k in ('C7', 'L1')}
        nearest = sorted(dist, key=dist.get)[:2]
        right = set(e['vertebrae'])
        level_ok = nearest[0] in right and (len(right) == 1 or set(nearest) == right)
        e['nearest_to_head_centre'] = nearest
        e['level_ok'] = bool(level_ok)
        val = max(vals)
        e['value'] = mm(val); e['threshold'] = 3.0; e['ok'] = bool(val <= 0.003 and level_ok)
        ok_h &= e['ok']; worst_h = max(worst_h, val)
        head[name] = e
        if n <= 10:
            it, _ = rg.facets['tub']
            med, p90, mn, pen = facet_distance(v[it], verts[f'T{n}'])
            # the nearest vertebra surface must be the transverse process: well lateral of the vertebral body
            q, _ = closest_on_mesh(*verts[f'T{n}'].mesh, v[it], k=12)
            # the contact must be on the transverse process: well away from the spinal canal (the cord), where the
            # costal facets of the body lie ~15-20 mm from it and the tips of the transverse processes 25-35 mm
            qc = q.mean(0)
            if cord is not None and len(cord):
                cc = cord[np.abs(cord[:, 1] - qc[1]) < 0.006]
                ref = cc.mean(0) if len(cc) > 10 else verts[f'T{n}'].mesh[0].mean(0)
            else:
                ref = verts[f'T{n}'].mesh[0].mean(0)
            lat = float(np.linalg.norm((qc - ref)[[0, 2]]))
            ok = med <= 0.003 and lat > 0.022
            tub[name] = dict(value=mm(med), threshold=3.0, ok=bool(ok), p90_mm=mm(p90), penetration_mm=mm(pen), contact_from_canal_mm=mm(lat, 1), vertebra=f'T{n}')
            ok_t &= ok; worst_t = max(worst_t, med)
    return dict(head=dict(ok=bool(ok_h), worst_mm=mm(worst_h), threshold=3.0, per_rib=head),
                tubercle=dict(ok=bool(ok_t), worst_mm=mm(worst_t), threshold=3.0, per_rib=tub))


def patch_gap(points, mesh):
    _, d = closest_on_mesh(*mesh, points, k=12)
    return float(np.median(d)), float(np.quantile(d, 0.9)), float(d.max())


def cartilage_joints(contacts, carts, ribs, sternum):
    """contacts[(n, side)] = dict(rib=idx, sternum=idx, above=idx) (cartilage vertex indices from Z-Anatomy)."""
    out, ok_all, worst = {}, True, 0.0
    for key, c in contacts.items():
        n, s = key; v = carts[key][0]; e = {}
        med, p90, mx = patch_gap(v[c['rib']], ribs[key]); e['to_rib'] = dict(median_mm=mm(med), p90_mm=mm(p90), max_mm=mm(mx))
        vals = [p90]
        if n <= 7:
            med, p90, mx = patch_gap(v[c['sternum']], sternum); e['to_sternum'] = dict(median_mm=mm(med), p90_mm=mm(p90), max_mm=mm(mx)); vals.append(p90)
        else:
            med, p90, mx = patch_gap(v[c['above']], carts[(n - 1, s)]); e[f'to_cartilage_{n - 1}'] = dict(median_mm=mm(med), p90_mm=mm(p90), max_mm=mm(mx)); vals.append(p90)
        val = max(vals)
        e.update(value=mm(val), threshold=2.0, ok=bool(val <= 0.002), measure='p90 of the joint patch distance')
        ok_all &= e['ok']; worst = max(worst, val)
        out[f'{n}{s}'] = e
    return dict(ok=bool(ok_all), worst_mm=mm(worst), threshold=2.0, per_cartilage=out)


def clearance(meshes, target, inside=True, per_cm2=30):
    """Smallest distance of mesh surfaces to a target surface: inside=True means the meshes should be inside it (skin),
    False means outside (organs). Returns (min clearance m, fraction on the wrong side, deepest wrong-side m)."""
    p = np.concatenate([samples(m, per_cm2=per_cm2, seed=5) for m in meshes])
    d = signed(target, p)
    c = -d if inside else d
    return float(c.min()), float((c < 0).mean()), float(max(0, -c.min()))


def discs(disc_meshes, levels, verts):
    """levels: [(name, upper key, lower key)]; disc_meshes: {name: (mesh, top idx, bottom idx)}."""
    out, ok_all = {}, True
    worst_pen, worst_gap = 0.0, 0.0
    for name, up, lo in levels:
        if name not in disc_meshes:
            out[name] = dict(present=False, ok=False); ok_all = False; continue
        (v, f), top, bot = disc_meshes[name]
        p = samples((v, f), per_cm2=80, seed=2)
        pen = 0.0
        for k in (up, lo):
            s = signed(verts[k], p)
            pen = max(pen, float(max(0, -s.min())))
        _, gt = closest_on_mesh(*verts[up].mesh, v[top], k=12)
        _, gb = closest_on_mesh(*verts[lo].mesh, v[bot], k=12)
        g95 = float(max(np.quantile(gt, 0.95), np.quantile(gb, 0.95)))
        ok = pen <= 0.0005 and g95 <= 0.0015
        out[name] = dict(present=True, between=[up, lo], penetration_mm=mm(pen), endplate_gap_p95_mm=mm(g95),
                         endplate_gap_median_mm=mm(max(np.median(gt), np.median(gb))), height_mm=None, ok=bool(ok))
        ok_all &= ok; worst_pen = max(worst_pen, pen); worst_gap = max(worst_gap, g95)
    return dict(ok=bool(ok_all), levels=len(levels), present=int(sum(1 for o in out.values() if o.get('present'))),
                penetration=crit(mm(worst_pen), 0.5, worst_pen <= 0.0005), endplate_gap=crit(mm(worst_gap), 1.5, worst_gap <= 0.0015, measure='p95 over each end plate'),
                per_level=out)


def lung_at_joints(ribgeoms, ribs, verts, lungs):
    """Evidence for the paravertebral conflict: signed distance (mm) from the HRA lung surface to the vertebral joint
    surfaces each rib articulates with (the vertebra's closest points to the rib's head and tubercle facets).
    Negative: the lung covers the joint surface itself; below ~6 mm (a rib neck's thickness) the lung fills the
    space the head or neck must occupy."""
    out = {}
    for key, rg in ribgeoms.items():
        n, s = key; v = ribs[key][0]; e = {}
        for fk, vk in (('head_lo', f'T{n}'), ('head_up', f'T{n - 1}'), ('tub', f'T{n}')):
            if fk not in rg.facets or vk not in verts: continue
            q, _ = closest_on_mesh(*verts[vk].mesh, v[rg.facets[fk][0]], k=12)
            e[{'head_lo': 'head', 'head_up': 'head_upper', 'tub': 'tubercle'}[fk]] = mm(signed(lungs, q).min(), 1)
        out[f'{n}{s}'] = e
    return out


def geodesic_length(mesh, n=3000):
    """Length of a bar-shaped mesh: the geodesic diameter over a k-nearest-neighbour graph of surface samples (mm)."""
    from scipy.sparse.csgraph import shortest_path
    from scipy import sparse as sp
    P = sample_surface(mesh[0], mesh[1], n, seed=0)
    d, i = cKDTree(P).query(P, k=8)
    G = sp.coo_matrix((d[:, 1:].ravel(), (np.repeat(np.arange(len(P)), 7), i[:, 1:].ravel())), shape=(len(P), len(P))).tocsr()
    g = shortest_path(G, indices=[0], directed=False)[0]; b = int(np.argmax(np.where(np.isfinite(g), g, -1)))
    g = shortest_path(G, indices=[b], directed=False)[0]
    return float(np.max(np.where(np.isfinite(g), g, -1))) * 1000


def cartilage_symmetry(C, carts, sternum, limit=1.2):
    """Left/right symmetry of the costal cartilages per level: geodesic length of each and the distance of its
    costochondral junction (the centre of its rib joint patch) from the sternum's midline (mm). Criterion: each
    cartilage within `limit` times its contralateral length."""
    xm = float(np.median(sternum[0][:, 0]))
    out, worst = {}, 1.0
    for n in range(1, 11):
        L = {s: geodesic_length(carts[(n, s)]) for s in 'lr'}
        x = {s: abs(float(carts[(n, s)][0][C[(n, s)]['rib']].mean(0)[0]) - xm) * 1000 for s in 'lr'}
        r = max(L.values()) / max(min(L.values()), 1e-9); worst = max(worst, r)
        out[str(n)] = dict(length_mm_l_r=[round(L['l'], 1), round(L['r'], 1)], ratio=round(r, 3), ccj_from_midline_mm_l_r=[round(x['l'], 1), round(x['r'], 1)])
    return dict(length_ratio=crit(round(worst, 3), limit, worst <= limit), per_level=out)
