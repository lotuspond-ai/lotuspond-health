"""Acceptance measurements for the vessels group (fit/vessels.py), all on the final meshes.

 - junctions: for every HRA-to-Z-Anatomy junction, the gap between the continuing vessel's end ring centre and the HRA
   stub's end centre and the angle between their axes (Z-Anatomy: main-trunk centerline leaving the ring; HRA: the
   section-fitted end axis). At a fork (the stub ends where a Z-Anatomy parent that is not placed divides) the
   children's start rings must sit on the stub's end (gap per child) and the parent axis they carry, recovered from the
   children's final start axes (Kabsch fit of their original directions onto the final ones), must lie within 20
   degrees of the stub's axis; their branch angles stay Z-Anatomy's. A side junction (a vessel ending on the wall of an
   HRA vessel) is measured by how far its end ring centre lies outside that vessel (0 = on or inside the wall).
 - bone penetration: surface samples of each vessel against every bone (exact closest-point distance, inside test by
   majority vote of three ray-parity tests, five when they disagree): fraction inside and deepest penetration, samples in a bony canal or foramen
   reported apart; vertebral arteries also through each transverse foramen of
   C6-C1 (the centerline point at the foramen's level is enclosed by the vertebra in its transverse plane and the
   vessel keeps clear of the bone).
 - skin: limb vessels' surface samples against the skin (exact distance, sign from the skin solid).
 - femoral vein medial to the femoral artery in the femoral triangle (every cm over the first 8 cm below the
   inguinal ligament, medial = toward the midline perpendicular to the femoral shaft).
 - brachial artery medial to the humerus shaft (every cm over the middle 60 % of the placed humerus; medial = the
   medial epicondyle's side, from the Z-Anatomy epicondyles carried by the placed humerus's vertex correspondence).
 - Z-Anatomy-to-Z-Anatomy continuity (informative): end rings that touched another placed vessel in Z-Anatomy space,
   offset from their partner after the deformation.
"""
import os, sys, json, re
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, load, sample_surface, area  # noqa: E402
from fit.common import FIT  # noqa: E402
from fit import vessels_geom as G  # noqa: E402

GAP_MAX, ANGLE_MAX, BONE_MAX = 0.0015, 20.0, 0.0005


def r3(x, k=2):
    return round(float(x), k)


def loops(v, f):
    out = []
    for l in G.boundary_loops(f):
        if len(l) < 5: continue
        c, n, r = G.ring_frame(v[l]); out.append(dict(idx=l, c=c, r=r))
    return out


def trunk(v, f, ring):
    c0 = v[ring].mean(0)
    L = [l for l in loops(v, f) if np.linalg.norm(l['c'] - c0) > 0.002]
    if not L: return G.centerline(v, f, ring)
    other = max(L, key=lambda l: np.linalg.norm(l['c'] - c0))
    return G.trunk_centerline(v, f, ring, other['idx'])


def axis_from(cl, s0, s1):
    P, s = cl['p'], cl['s']
    m = (s >= s0) & (s <= s1)
    if m.sum() < 3:
        m = np.zeros(len(P), bool); k = int(np.searchsorted(s, s0)); m[max(0, k - 2):k + 3] = True
    Q = P[m]
    if len(Q) < 2: return G.unit(P[min(len(P) - 1, 1)] - P[0])
    a = G.pca_axis(Q)
    return a if a @ (Q[-1] - Q[0]) >= 0 else -a


def start_frame(v, f, near, span=0.015):
    """(ring centre, ring radius, leaving axis) of the end ring of a vessel nearest to a point."""
    L = loops(v, f)
    l = min(L, key=lambda l: np.linalg.norm(l['c'] - near))
    cl = trunk(v, f, l['idx'])
    return l['c'], l['r'], axis_from(cl, l['r'], l['r'] + span)


def kabsch_dirs(A, B):
    """Rotation best mapping unit directions A (k, 3) onto B (k, 3) (with their cross products when k == 2)."""
    A = np.asarray(A); B = np.asarray(B)
    if len(A) == 1: return G.rotvec_matrix(G.rotvec_between(A[0], B[0]))
    if len(A) == 2:
        A = np.vstack([A, G.unit(np.cross(A[0], A[1]))]); B = np.vstack([B, G.unit(np.cross(B[0], B[1]))])
    H = A.T @ B
    U, S, Vt = np.linalg.svd(H)
    D = np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))])
    return Vt.T @ D @ U.T


def kabsch_points(P, Q):
    """Rotation of the best rigid fit of point set P onto Q."""
    a = P - P.mean(0); b = Q - Q.mean(0)
    U, S, Vt = np.linalg.svd(a.T @ b)
    D = np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))])
    return Vt.T @ D @ U.T


def junctions(J, VES):
    rows = []
    for j in J:
        e = j['end']; row = dict(key=j['key'], kind=j['kind'], part=j['part'], hra=j['info']['hra'], vessels=j['vessels'])
        if j['kind'] == 'side':
            x = VES[j['vessels'][0]]
            c, r, t = start_frame(x['v'], x['f'], j['c'])
            hv, hf = j['hra_mesh']
            sd, _ = G.TriSet(hv, hf).signed(c[None], band=0.05)
            gap = max(0.0, float(sd[0]))
            row.update(gap_mm=r3(gap * 1000), ring_centre_signed_dist_to_hra_mm=r3(sd[0] * 1000), angle_deg=None,
                       angle_note='side branch: no axis to continue', za_r_mm=r3(r * 1000), pass_gap=bool(gap <= GAP_MAX), pass_angle=None)
        elif j['kind'] == 'chain':
            x = VES[j['vessels'][0]]
            c, r, t = start_frame(x['v'], x['f'], e['c'])
            gap = float(np.linalg.norm(c - e['c'])); ang = G.angle_deg(t, e['n'])
            row.update(gap_mm=r3(gap * 1000), angle_deg=r3(ang, 1), za_r_mm=r3(r * 1000), hra_r_mm=r3(e['r'] * 1000),
                       pass_gap=bool(gap <= GAP_MAX), pass_angle=bool(ang <= ANGLE_MAX))
        else:
            gaps, A, B, kids = [], [], [], {}
            hv, hf = j['hra_mesh']; TS = G.TriSet(hv, hf)
            for k in j['vessels']:
                x = VES[k]
                c, r, t = start_frame(x['v'], x['f'], e['c'])
                # the child's start ring must sit on the stub: its centre on the stub's end disc or inside the stub
                sd, _ = TS.signed(c[None], band=0.05)
                g = min(float(np.linalg.norm(c - e['c'])), max(0.0, float(sd[0]))); gaps.append(g)
                A.append(j['za_child_dirs'][k]); B.append(t)
                kids[k] = dict(gap_mm=r3(g * 1000), r_mm=r3(r * 1000), angle_to_hra_axis_deg=r3(G.angle_deg(t, e['n']), 1),
                               za_branch_angle_deg=r3(G.angle_deg(j['za_child_dirs'][k], j['za_dir']), 1))
            # the rotation the children's rigid stretch actually underwent (positions before the snap -> final)
            Pp = np.concatenate([pre for loc, pre in j['rigid'].values()]); Qq = np.concatenate([VES[nm]['v'][loc] for nm, (loc, pre) in j['rigid'].items()])
            R = kabsch_points(Pp, Qq) if len(Pp) >= 4 else kabsch_dirs(A, B)
            ang = G.angle_deg(R @ j['za_dir'], e['n'])
            gap = max(gaps)
            row.update(gap_mm=r3(gap * 1000), angle_deg=r3(ang, 1), angle_note='parent axis carried by the children vs the stub axis',
                       hra_r_mm=r3(e['r'] * 1000), children=kids, pass_gap=bool(gap <= GAP_MAX), pass_angle=bool(ang <= ANGLE_MAX))
        row['snap'] = dict(rotation_deg=j['info'].get('rotation_deg', 0.0), shift_mm=j['info'].get('shift_mm'), za_cut=j['info'].get('za_cut'))
        rows.append(row)
    return rows


def samples(v, f, per_cm2=40, nmin=200, nmax=6000, seed=3):
    n = int(np.clip(area(v, f) * 1e4 * per_cm2, nmin, nmax))
    return sample_surface(v, f, n, seed=seed)


def enclosed(p, axis, obstacles, reach=0.010, need=6):
    """Is a point inside a bony canal or foramen: rays from it in 8 directions perpendicular to the vessel's axis hit
    bone within `reach` in at least `need` of them."""
    u = G.unit(np.cross(axis, [0, 0, 1.0]) if abs(axis[2]) < 0.9 else np.cross(axis, [1.0, 0, 0])); w = np.cross(axis, u)
    hits = 0
    for ang in np.linspace(0, 2 * np.pi, 8, endpoint=False):
        d = np.cos(ang) * u + np.sin(ang) * w
        q = p + d[None] * np.linspace(0.0015, reach, 10)[:, None]
        sd, _, _ = obstacles.query(q, band=0.002)
        hits += bool((sd < 0.0003).any())
    return hits >= need


def bones(VES, names, obstacles):
    """Penetration of each vessel into bone. Samples inside a bone that are enclosed by bone around the vessel's axis
    (a bony canal or foramen: carotid canal, transverse foramina...) are reported apart and do not count against the
    0.5 mm criterion, which is for penetration outside the foramina."""
    rows = {}
    for n in names:
        x = VES[n]; p = samples(x['v'], x['f'])
        sd, _, who = obstacles.query(p)
        ins = np.flatnonzero(sd < 0)
        canal = np.zeros(len(p), bool)
        if len(ins):
            tree = cKDTree(x['v'])
            for i in ins[np.argsort(sd[ins])][:60]:
                # from the vessel's local axis point (the centroid of its vertices around the sample): a canal holds the
                # vessel's axis in free space ringed by bone; an axis point inside the bone is a plain penetration
                nb = x['v'][tree.query_ball_point(p[i], 0.006)]
                if len(nb) < 3: continue
                c = nb.mean(0); ax = G.pca_axis(nb)
                sc, _, _ = obstacles.query(c[None])
                canal[i] = bool(sc[0] > 0) and enclosed(c, ax, obstacles, reach=0.012)
            # the shallower ones take the class of their nearest classified neighbour
            done = ins[np.argsort(sd[ins])][:60]
            rest = np.setdiff1d(ins, done)
            if len(rest): canal[rest] = canal[done][cKDTree(p[done]).query(p[rest])[1]]
        out_ = sd.copy(); out_[canal] = np.inf
        depth = max(0.0, -out_.min()) if np.isfinite(out_).any() else 0.0
        cdepth = max(0.0, -sd[canal].min()) if canal.any() else 0.0
        rows[n] = dict(inside_frac=r3((sd < 0).mean(), 4), max_depth_mm=r3(depth * 1000), in_canal_max_depth_mm=r3(cdepth * 1000),
                       in_canal_frac=r3(canal.mean(), 4), min_clearance_mm=r3(sd.min() * 1000),
                       worst_bone=obstacles.names[who[np.argmin(out_)]] if np.isfinite(out_).any() and who[np.argmin(out_)] >= 0 else None,
                       pass_=bool(depth <= BONE_MAX))
    return rows


def stub_conflicts(VES, J, bone_rows, obstacles):
    """Informative, for the vessels that fail the bone criterion and join an HRA stub: how deep that HRA stub itself lies
    in the same bone, and how far the vessel's deepest sample is from the junction (an HRA vessel that penetrates a bone
    another group placed leaves no clear position for the vessel that must meet its end)."""
    out = {}
    for n, b in bone_rows.items():
        if b['pass_'] or b['worst_bone'] not in obstacles.names: continue
        T = obstacles.sets[obstacles.names.index(b['worst_bone'])]
        x = VES[n]; ps = samples(x['v'], x['f']); sdv, _ = T.signed(ps, band=0.01); i = int(np.argmin(sdv))
        for j in J:
            if n not in j['vessels']: continue
            hv, hf = j['hra_mesh']
            p = np.concatenate([hv, sample_surface(hv, hf, 4000, seed=1)])
            sd, _ = T.signed(p, band=0.01)
            out[n] = dict(junction=j['key'], hra=j['info']['hra'], bone=b['worst_bone'], hra_stub_max_depth_mm=r3(max(0.0, -float(np.min(sd))) * 1000),
                          vessel_max_depth_mm=r3(max(0.0, -float(sdv[i])) * 1000), deepest_point_to_junction_mm=r3(np.linalg.norm(ps[i] - j['c']) * 1000))
    return out


def organs(VES, names, obstacles):
    """Penetration of each vessel into the solid organs (fit/vessels_fix.organ_meshes), informative: deepest per vessel."""
    rows = {}
    for n in names:
        x = VES[n]; p = samples(x['v'], x['f'], per_cm2=20)
        sd, _, who = obstacles.query(p)
        if not (sd < 0).any(): continue
        k = int(np.argmin(sd))
        rows[n] = dict(inside_frac=r3((sd < 0).mean(), 4), max_depth_mm=r3(-sd[k] * 1000), organ=obstacles.names[who[k]] if who[k] >= 0 else None)
    return rows


def skin_check(VES, names, skin):
    rows = {}
    for n in names:
        x = VES[n]; p = samples(x['v'], x['f'])
        sd, _ = skin(p)
        rows[n] = dict(outside_frac=r3((sd > 0).mean(), 4), max_outside_mm=r3(max(0.0, sd.max()) * 1000), min_depth_mm=r3(-sd.max() * 1000),
                       pass_=bool(sd.max() <= 0))
    return rows


def vessel_trunk(x):
    L = loops(x['v'], x['f'])
    top = max(L, key=lambda l: l['c'][1])
    return trunk(x['v'], x['f'], top['idx'])


def femoral(VES, sex, side):
    """Femoral vein medial to the femoral artery over the first 8 cm below the inguinal ligament."""
    a, v = VES.get(f'Femoral_artery{side}'), VES.get(f'Femoral_vein{side}')
    if a is None or v is None: return None
    S = source(f'hra-{sex}')
    fem = S.get(f'VH_{"M" if sex == "male" else "F"}_femur_{"L" if side == "l" else "R"}')[0]
    if (fem[:, 0].mean() > 0) != (side == 'l'):                     # match the femur by position
        fem = S.get(f'VH_{"M" if sex == "male" else "F"}_femur_{"R" if side == "l" else "L"}')[0]
    ax = G.pca_axis(fem); ax = ax if ax[1] < 0 else -ax
    med = np.array([-1.0 if side == 'l' else 1.0, 0, 0]); med = G.unit(med - (med @ ax) * ax)
    ca, cv = vessel_trunk(a), vessel_trunk(v)
    vals = []
    for s in np.arange(0.0, 0.0801, 0.01):
        pa = ca['p'][min(int(np.searchsorted(ca['s'], s)), len(ca['p']) - 1)]
        # vein point at the same level along the shaft
        hv = (cv['p'] - pa) @ ax
        pv = cv['p'][int(np.argmin(np.abs(hv)))]
        vals.append(float((pv - pa) @ med))
    vals = np.array(vals)
    return dict(levels=len(vals), vein_medial_offset_mm=[r3(x * 1000, 1) for x in vals], min_offset_mm=r3(vals.min() * 1000, 1),
                medial_levels=int((vals > 0).sum()), pass_=bool((vals > 0).all()))


def brachial(VES, sex, side):
    """Brachial artery medial to the humerus shaft over the middle 60 % of the placed humerus."""
    a = VES.get(f'Brachial_artery{side}')
    path = os.path.join(FIT, sex, 'arms', f'Humerus{side}.npz')
    if a is None or not os.path.exists(path): return None
    hv = load(path)[0]; zv = source('za-skeletal').get(f'Humerus{side}')[0]
    if len(zv) != len(hv): return dict(note='placed humerus does not keep the Z-Anatomy vertex order')
    ax = G.pca_axis(hv); top = hv[np.argmax(hv @ ax)]; ax = ax if (hv.mean(0) - top) @ ax < 0 else -ax   # ax points distally
    h = (hv - hv.mean(0)) @ ax; L = h.max() - h.min()
    dist = h > h.max() - 0.15 * L
    # Z-Anatomy anatomical position: the medial epicondyle is the distal vertex nearest the midline
    zi = np.flatnonzero(dist)
    zx = zv[zi, 0] * (1 if side == 'l' else -1)
    mi, li = zi[np.argmin(zx)], zi[np.argmax(zx)]
    med = hv[mi] - hv[li]; med = G.unit(med - (med @ ax) * ax)
    ca = vessel_trunk(a)
    vals = []
    for t in np.linspace(0.2, 0.8, 7):
        level = h.min() + t * L
        m = np.abs(h - level) < 0.004
        c = hv[m].mean(0)
        pa = ca['p'][int(np.argmin(np.abs((ca['p'] - c) @ ax)))]
        vals.append(float((pa - c) @ med))
    vals = np.array(vals)
    return dict(levels=len(vals), artery_medial_offset_mm=[r3(x * 1000, 1) for x in vals], min_offset_mm=r3(vals.min() * 1000, 1),
                medial_levels=int((vals > 0).sum()), pass_=bool((vals > 0).all()))


def foramina(VES, sex, side, obstacles):
    """Vertebral artery through the transverse foramina of C6-C1."""
    x = VES.get(f'Vertebral_artery{side}')
    if x is None: return None
    S = source(f'hra-{sex}'); P = 'VH_M_' if sex == 'male' else 'VH_F_'
    L = loops(x['v'], x['f'])
    low = min(L, key=lambda l: l['c'][1])
    cl = trunk(x['v'], x['f'], low['idx'])
    sgn = 1.0 if side == 'l' else -1.0
    out = {}
    for k in range(6, 0, -1):
        vv, ff = S.get(f'{P}cervical_vertebra_{k}')
        T = G.TriSet(vv, ff)
        # the centerline points within the vertebra's height on that side
        lat = (cl['p'][:, 0] - vv[:, 0].mean()) * sgn > 0.015
        inb = lat & (cl['p'][:, 1] > vv[:, 1].min()) & (cl['p'][:, 1] < vv[:, 1].max())
        if not inb.any():
            out[f'C{k}'] = dict(through=False, note='artery does not reach this level beside the vertebra'); continue
        idx = np.flatnonzero(inb)
        enclosed = []
        for i in idx:
            p = cl['p'][i]; t = cl['t'][i]
            u = G.unit(np.cross(t, [0, 0, 1.0])); w = np.cross(t, u)
            hits = 0
            for ang in np.linspace(0, 2 * np.pi, 8, endpoint=False):
                d = np.cos(ang) * u + np.sin(ang) * w
                q = p + d[None] * np.linspace(0.001, 0.012, 12)[:, None]
                sd, _ = T.signed(q, band=0.002)
                hits += bool((sd < 0.0005).any())
            enclosed.append(hits)
        best = idx[int(np.argmax(enclosed))]
        ps = samples(x['v'], x['f'])
        near = np.linalg.norm(ps - cl['p'][best], axis=1) < 0.012
        sd, _ = T.signed(ps[near], band=0.01) if near.any() else (np.array([np.inf]), None)
        out[f'C{k}'] = dict(through=bool(max(enclosed) >= 6), directions_hitting_bone=int(max(enclosed)), of=8,
                            min_clearance_mm=r3(float(np.min(sd)) * 1000) if np.isfinite(np.min(sd)) else None,
                            touches_bone=bool(np.min(sd) <= 0))
    ok = all(v.get('through') and not v.get('touches_bone') for v in out.values())
    return dict(levels=out, pass_=bool(ok))


def zaza_contacts(VES, names, tol=0.003):
    """Z-Anatomy-space ring contacts between placed vessels: [(child, ring vertex idx (original), parent, partner vertex
    idx (original))]."""
    out = []
    ZV = {n: (VES[n]['za_v'], VES[n]['za_f']) for n in names}
    trees = {n: cKDTree(ZV[n][0]) for n in names}
    for n in names:
        v, f = ZV[n]
        for l in loops(v, f):
            best = None
            for m in names:
                if m == n or VES[m]['part'] != VES[n]['part']: continue
                d, i = trees[m].query(v[l['idx']])
                if d.max() < l['r'] + tol and (best is None or d.mean() < best[1]): best = (m, d.mean(), i)
            if best: out.append((n, l['idx'], best[0], best[2]))
    return out


def zaza(VES, contacts):
    rows = []
    for n, ring, m, part in contacts:
        a, b = VES[n], VES[m]
        if a.get('dropped') or b.get('dropped'): continue
        ia, ib = a['orig_index'], b['orig_index']
        ma = ia[ring] if ia is not None else ring
        mb = ib[part] if ib is not None else part
        ok = (ma >= 0) & (mb >= 0)
        if ok.mean() < 0.8: continue
        off = np.linalg.norm((a['v'][ma[ok]] - b['v'][mb[ok]]).mean(0)) - np.linalg.norm((a['za_v'][ring[ok]] - b['za_v'][part[ok]]).mean(0))
        rows.append(dict(vessel=n, joins=m, offset_change_mm=r3(off * 1000, 1)))
    return rows
