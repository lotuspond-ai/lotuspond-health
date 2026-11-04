"""Teeth for the skull fit (fit/skull.py): each dental arch moves rigidly with its jaw, the mandible is seated in centric
occlusion with its condyles in the fossae, and the occlusion is measured.

Why rigid: the head warp and the collision field are smooth over centimetres but the teeth sit right under the lips,
where the warp follows the face skin and the field holds a minimum soft-tissue cover. Carried by them, the crowns were
dented, carried needle spikes, the incisors were tipped by up to 17 degrees and each tooth was scaled by 1.15-1.30 (the
jaws themselves by 1.08-1.13). Here every tooth keeps its Z-Anatomy shape exactly:
  - arch block: one similarity per arch, fitted (Umeyama) from the Z-Anatomy alveolar bone (maxillae for the upper
    teeth, mandible for the lower; bone within ARCH_R of the teeth) to the same bone as placed. The teeth keep the
    Z-Anatomy arch form, inclinations and contacts and follow their sockets on average (tooth scale = that jaw's
    alveolar scale, 1.11-1.16, instead of the 1.15-1.30 the warp gave each tooth),
  - occlusal level: each arch block is then moved along the occlusal normal so that its crowns sit at the level the
    warp gave the teeth (the crowns keep their place under the lips and against the alveolar crest; the roots, shorter
    than the warp's stretched ones, end inside the bone),
  - the upper lateral incisors are moved along their own long axis so that their incisal edges lie LATERAL_STEP above
    the central incisors' (Z-Anatomy has them 1.4 mm below, which looks like hanging laterals),
  - the mandible (with the lower arch) is seated by the smallest rigid move that (i) keeps a joint space of at least
    JS_MIN between each condylar head and its temporal bone, (ii) has the arches in contact without interpenetration
    (centric occlusion), and (iii) gives the best incisor / canine relation (incisal-edge overjet OVERJET, upper canine tip on
    the lower canine / first premolar embrasure, lower and upper dental midlines aligned).
"""
import os, sys, re
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import sample_surface, dense_points, merge, pca  # noqa: E402
from lib.register import umeyama, Sim  # noqa: E402
from fit import skull_geom as G  # noqa: E402

ARCH_R = 0.004          # alveolar bone: jaw-bone vertices within this distance of the arch's teeth (Z-Anatomy space)
LATERAL_STEP = 0.00075  # upper lateral incisal edge this far above the central incisal edge (normal 0.5-1 mm)
JS_MIN = 0.0008         # joint space (articular disc) kept between each condylar head and the temporal bone
JS_MAX = 0.0030         # a condyle further than this from its fossa no longer counts as seated
PEN_TOL = 0.00015       # tooth contact: upper-arch signed distance at the lower-arch samples may reach -PEN_TOL
OVERJET = 0.0025        # overjet target: upper to lower incisal edge, horizontal in the occlusal plane (normal 2-3 mm)
UPPER_BONES, LOWER_BONES = ('maxilla_l', 'maxilla_r'), ('mandible',)


def teeth_of(P, jaw):
    return sorted(n for n in P if n.startswith(jaw + '_') and P[n][2] == 'teeth')


def arch_transform(Z, P, jaw):
    """Similarity from the Z-Anatomy alveolar bone of a jaw to the same bone as placed (P: placed {name: (v, f, part)})."""
    bones = UPPER_BONES if jaw == 'upper' else LOWER_BONES
    zb = np.concatenate([Z[b][0] for b in bones]); pb = np.concatenate([P[b][0] for b in bones])
    zt = np.concatenate([Z[t][0] for t in teeth_of(P, jaw)])
    m = cKDTree(zt).query(zb)[0] < ARCH_R
    T = umeyama(zb[m], pb[m], scale=True)
    r = np.linalg.norm(T(zb[m]) - pb[m], axis=1)
    return T, (zb[m].mean(0), pb[m].mean(0)), dict(n_bone_vertices=int(m.sum()), own_scale=round(float(T.s), 4), bone_rms_mm=round(float(np.sqrt((r ** 2).mean()) * 1000), 2))


def occlusal_frame(P):
    """(centre, occlusal normal pointing up, forward) from the upper arch: plane through the lowest point of each upper
    tooth (cusp tips and incisal edges), forward from the first molars to the central incisors."""
    up = teeth_of(P, 'upper')
    tips = []
    for k in up:
        v = P[k][0]; tips.append(v[v[:, 1] < v[:, 1].min() + 0.0003].mean(0))
    tips = np.array(tips); c = tips.mean(0)
    _, _, V = np.linalg.svd(tips - c); n = V[2] if V[2][1] > 0 else -V[2]
    mol = np.mean([P[k][0].mean(0) for k in up if 'first_molar' in k], 0)
    inc = np.mean([P[k][0].mean(0) for k in up if 'medial_incisor' in k], 0)
    fw = inc - mol; fw -= (fw @ n) * n; fw /= np.linalg.norm(fw)
    return c, n, fw


def long_axis(v, n):
    a = pca(v)[1][:, 0]
    return a if a @ n > 0 else -a


def place_arches(Z, P, log=print):
    """Teeth placed rigidly: one similarity per arch (alveolar bone), then the upper lateral incisors stepped up along
    their axes. Returns (P updated, per-tooth transforms {name: (s, R, t)}, info)."""
    info, tr, fits = {}, {}, {}
    warped = {n: P[n][0] for n in P if P[n][2] == 'teeth'}
    cw, nw, _ = occlusal_frame(P)
    for jaw in ('upper', 'lower'):
        T, mus, inf = arch_transform(Z, P, jaw); info[jaw + '_arch'] = inf; fits[jaw] = (T, mus)
    # each arch takes its own jaw's alveolar scale (the teeth follow their sockets; a common scale for both arches was
    # tried: it keeps the Z-Anatomy tooth-size match but leaves the female incisors edge to edge, overjet < 1 mm)
    for jaw in ('upper', 'lower'):
        T = fits[jaw][0]
        for n in teeth_of(P, jaw):
            P[n] = (T(Z[n][0]), P[n][1], P[n][2]); tr[n] = Sim(T.s, T.R, T.t)
    # occlusal level: the arch's crowns stay at the level the warp gave them (the face height there is set by the skin,
    # the condyles and the maxilla), so each arch block is moved along the occlusal normal until its mean cusp-tip /
    # incisal-edge height equals the warped teeth's. The jaw scale is smaller than the warp's local tooth stretch, so
    # without this the arches would end up apart (male: about 10 mm) and closing the jaw that far would move the chin.
    for jaw, ext in (('upper', np.min), ('lower', np.max)):
        tn = teeth_of(P, jaw)
        hw = np.mean([ext((warped[n] - cw) @ nw) for n in tn]); hb = np.mean([ext((P[n][0] - cw) @ nw) for n in tn])
        d = (hw - hb) * nw
        for n in tn:
            P[n] = (P[n][0] + d, P[n][1], P[n][2]); tr[n] = Sim(tr[n].s, tr[n].R, tr[n].t + d)
        info[jaw + '_arch']['moved_to_warped_occlusal_level_mm'] = round(float((hw - hb) * 1000), 2)
    c, nrm, fw = occlusal_frame(P)
    steps = {}
    for s in 'lr':
        cen, lat = f'upper_medial_incisor_{s}', f'upper_lateral_incisor_{s}'
        hc = ((P[cen][0] - c) @ nrm).min(); hl = ((P[lat][0] - c) @ nrm).min()
        need = hc + LATERAL_STEP - hl
        a = long_axis(P[lat][0], nrm)
        d = a * (need / (a @ nrm))
        P[lat] = (P[lat][0] + d, P[lat][1], P[lat][2])
        tr[lat] = Sim(tr[lat].s, tr[lat].R, tr[lat].t + d)
        steps[lat] = dict(edge_below_central_before_mm=round(float((hc - hl) * 1000), 2), moved_along_axis_mm=round(float(np.linalg.norm(d) * 1000), 2))
    info['upper_lateral_incisor_step'] = steps
    log('teeth: rigid arches', info)
    return P, tr, info


# ------------------------------------------------------------------------------------------------ occlusion metrics
def occlusion(P, frame=None):
    """Overbite, overjet, incisor inclinations, canine / molar relations, contacts and tooth lengths (the definitions
    of the anatomy review: occlusal plane through the upper cusp tips and incisal edges, forward from the first molars to
    the central incisors). Distances in mm, angles in degrees."""
    D = {k: dense_points(*P[k][:2], 0.0002) for k in P if P[k][2] == 'teeth'}
    c, n, fw = frame or occlusal_frame(P)
    H = lambda p: (p - c) @ n; F = lambda p: (p - c) @ fw
    out = {}
    for side in 'rl':
        U = D['upper_medial_incisor_' + side]; L = D['lower_medial_incisor_' + side]
        ue = U[H(U) < H(U).min() + 0.0005]; le = L[H(L) > H(L).max() - 0.0005]; lt = L[H(L) > H(L).max() - 0.002]
        a1 = long_axis(U, n); a2 = long_axis(L, n)
        u1 = np.degrees(np.arctan2(a1 @ fw, a1 @ n)); l1 = np.degrees(np.arctan2(a2 @ fw, a2 @ n))
        o = dict(overbite_mm=(H(le).mean() - H(ue).mean()) * 1e3, overjet_edge_mm=(F(ue).mean() - F(le).mean()) * 1e3,
                 overjet_labial_mm=(F(ue).mean() - F(lt).max()) * 1e3, upper_incisor_axis_deg=u1, lower_incisor_axis_deg=l1,
                 interincisal_angle_deg=180 - abs(u1) - abs(l1))
        ul = D['upper_lateral_incisor_' + side]
        o['upper_lateral_edge_above_central_edge_mm'] = (H(ul).min() - H(U).min()) * 1e3
        uc = D['upper_canine_' + side]; tip = uc[H(uc) < H(uc).min() + 0.0003].mean(0)
        lc = D['lower_canine_' + side]; lp = D['lower_first_premolar_' + side]
        d, i = cKDTree(lp).query(lc); j = d.argmin(); emb = (lc[j] + lp[i[j]]) / 2
        t = lp.mean(0) - lc.mean(0); t -= (t @ n) * n; t /= np.linalg.norm(t)
        o['canine_tip_distal_of_embrasure_mm'] = (tip - emb) @ t * 1e3
        um = D['upper_first_molar_' + side]; lm = D['lower_first_molar_' + side]
        t2 = D['lower_second_molar_' + side].mean(0) - D['lower_first_premolar_' + side].mean(0); t2 -= (t2 @ n) * n; t2 /= np.linalg.norm(t2)
        o['molar_upper_mesial_face_distal_of_lower_mm'] = (((um - c) @ t2).min() - ((lm - c) @ t2).min()) * 1e3
        out[side] = {k: round(float(v), 2) for k, v in o.items()}
    up = [k for k in D if k.startswith('upper')]; lo = [k for k in D if k.startswith('lower')]
    tr = cKDTree(np.concatenate([D[k] for k in up]))
    out['min_gap_to_upper_arch_mm'] = {k: round(float(tr.query(D[k])[0].min() * 1e3), 2) for k in sorted(lo)}
    lat = np.cross(n, fw)
    mu = (D['upper_medial_incisor_l'].mean(0) + D['upper_medial_incisor_r'].mean(0)) / 2
    ml = (D['lower_medial_incisor_l'].mean(0) + D['lower_medial_incisor_r'].mean(0)) / 2
    out['lower_midline_to_upper_midline_mm'] = round(float((ml - mu) @ lat * 1e3), 2)
    return out


# ------------------------------------------------------------------------------------------------ seating in occlusion
def rotation_axis(axis, th):
    a = np.asarray(axis, float); a = a / np.linalg.norm(a)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * K @ K


def seat_occlusion(P, L, fmn, log=print):
    """Rigid seating of the mandible with the lower arch: condyles in the fossae (joint space JS_MIN..JS_MAX), the arches
    in contact without interpenetration, and the best incisor / canine / midline relation. Search: for each sagittal and
    lateral shift (dz, dx) and vertical shift dy, the jaw is closed about the bicondylar axis until the teeth touch
    (bisection on the angle); among the poses whose condyles are seated, the one with the smallest occlusion error wins
    (ties broken by the smallest motion). Returns (P updated, info with the rigid transform x' = R x + t)."""
    mv, mf = P['mandible'][:2]
    heads = {}
    for S in 'LR':
        sel = np.isin(mf, L[f'mand_condyle_{S}']).all(1)
        heads[S] = sample_surface(mv, mf[sel], 1200, seed=1)
    cL, cR = heads['L'].mean(0), heads['R'].mean(0)
    lat = cL - cR; lat /= np.linalg.norm(lat)
    up = fmn - (fmn @ lat) * lat; up /= np.linalg.norm(up)
    fw = np.cross(lat, up)
    if fw[2] < 0: fw = -fw
    piv = (cL + cR) / 2
    sdfs = {S: G.local_sdf([P[tn][:2]], h=0.00035, pad=0.004, close=1) for S, tn in (('L', 'temporal_bone_l'), ('R', 'temporal_bone_r'))}
    lower = teeth_of(P, 'lower'); upper = teeth_of(P, 'upper')
    U = merge([P[n][:2] for n in upper]); Lw = merge([P[n][:2] for n in lower])
    gu, su = G.local_sdf([U], h=0.00025, pad=0.005)
    pl = sample_surface(*Lw, 8000, seed=2)
    # occlusion landmarks (upper fixed, lower moving)
    c, n, ofw = occlusal_frame(P)
    olat = np.cross(n, ofw)
    D = {k: dense_points(*P[k][:2], 0.0003) for k in upper + lower}
    H = lambda p: (p - c) @ n; F = lambda p: (p - c) @ ofw
    lm = {}
    for s in 'lr':
        Uc = D[f'upper_medial_incisor_{s}']; ue = Uc[H(Uc) < H(Uc).min() + 0.0005].mean(0)
        Lc = D[f'lower_medial_incisor_{s}']; lt = Lc[H(Lc) > H(Lc).max() - 0.0005]
        uc = D[f'upper_canine_{s}']; tip = uc[H(uc) < H(uc).min() + 0.0003].mean(0)
        lc = D[f'lower_canine_{s}']; lp = D[f'lower_first_premolar_{s}']
        d, i = cKDTree(lp).query(lc); j = d.argmin(); emb = (lc[j] + lp[i[j]]) / 2
        t = lp.mean(0) - lc.mean(0); t -= (t @ n) * n; t /= np.linalg.norm(t)
        lm[s] = dict(ue=ue, lt=lt, tip=tip, emb=emb, t=t)
    mu = (D['upper_medial_incisor_l'].mean(0) + D['upper_medial_incisor_r'].mean(0)) / 2
    ml = (D['lower_medial_incisor_l'].mean(0) + D['lower_medial_incisor_r'].mean(0)) / 2
    inc = Lw[0][np.argmax(Lw[0] @ fw)]

    def pose(th, dy, dz, dx):
        R = rotation_axis(lat, th); t = piv - R @ piv + dy * up + dz * fw + dx * lat
        return R, t

    def mv_(p, R, t): return p @ R.T + t

    def joint(R, t): return min(float(g.sample(f_, mv_(heads[S], R, t)).min()) for S, (g, f_) in sdfs.items())

    def contact(R, t): return float(gu.sample(su, mv_(pl, R, t)).min())

    def occl_err(R, t):
        e_oj, e_can = [], []
        for s in 'lr':
            q = lm[s]
            oj = F(q['ue']) - F(mv_(q['lt'], R, t)).mean()
            e_oj.append(oj - OVERJET)
            e_can.append((q['tip'] - mv_(q['emb'][None], R, t)[0]) @ q['t'])
        mid = (mv_(ml[None], R, t)[0] - mu) @ olat
        err = np.sqrt(np.mean(np.square(e_oj)) + 0.5 * np.mean(np.square(e_can)) + 0.5 * mid ** 2)
        return err, [float(x) for x in e_oj], [float(x) for x in e_can], float(mid)

    def close(dy, dz, dx, lo=np.radians(-6.0), hi=np.radians(5.0)):
        """Closing angle at first contact (contact(th) decreases as th closes the jaw: negative th closes)."""
        # th > 0 opens (incisors down and back), th < 0 closes; find the most closed th with contact >= -PEN_TOL
        Rl, tl = pose(lo, dy, dz, dx)
        if contact(Rl, tl) >= -PEN_TOL: return lo
        Rh, th_ = pose(hi, dy, dz, dx)
        if contact(Rh, th_) < -PEN_TOL: return None
        a, b = lo, hi
        for _ in range(14):
            m = (a + b) / 2; R, t = pose(m, dy, dz, dx)
            if contact(R, t) >= -PEN_TOL: b = m
            else: a = m
        return b

    R0, t0 = pose(0.0, 0.0, 0.0, 0.0)
    before = dict(min_joint_space_mm=round(joint(R0, t0) * 1000, 2), teeth_min_signed_gap_mm=round(contact(R0, t0) * 1000, 2),
                  occlusion_error_mm=round(occl_err(R0, t0)[0] * 1000, 2))
    best = None; tried = 0
    for dz in np.arange(-0.004, 0.00401, 0.0005):
        for dx in np.arange(-0.001, 0.00101, 0.0005):
            for dy in np.arange(-0.004, 0.00201, 0.0005):
                th = close(dy, dz, dx); tried += 1
                if th is None: continue
                R, t = pose(th, dy, dz, dx)
                js = joint(R, t)
                if js < JS_MIN or js > JS_MAX: continue
                err = occl_err(R, t)[0]
                motion = float(np.linalg.norm(mv_(np.array([cL, cR, inc]), R, t) - np.array([cL, cR, inc]), axis=1).max())
                score = err + 0.05 * motion + 0.2 * max(0.0, js - 0.0015)
                if best is None or score < best[0]: best = (score, th, dy, dz, dx)
    if best is None:
        return P, dict(result='no seating found', before=before, transform=dict(R=np.eye(3).tolist(), t=[0.0, 0.0, 0.0]))
    # local refinement around the best grid pose
    _, th, dy, dz, dx = best
    for step in (0.00025, 0.000125):
        improved = True
        while improved:
            improved = False
            for ddy, ddz, ddx in ((step, 0, 0), (-step, 0, 0), (0, step, 0), (0, -step, 0), (0, 0, step), (0, 0, -step)):
                y, z, x = dy + ddy, dz + ddz, dx + ddx
                th2 = close(y, z, x)
                if th2 is None: continue
                R, t = pose(th2, y, z, x); js = joint(R, t)
                if js < JS_MIN or js > JS_MAX: continue
                err = occl_err(R, t)[0]
                motion = float(np.linalg.norm(mv_(np.array([cL, cR, inc]), R, t) - np.array([cL, cR, inc]), axis=1).max())
                score = err + 0.05 * motion + 0.2 * max(0.0, js - 0.0015)
                if score < best[0] - 1e-7: best = (score, th2, y, z, x); th, dy, dz, dx = th2, y, z, x; improved = True
    R, t = pose(th, dy, dz, dx)
    for nm in ['mandible'] + lower:
        v, f, part = P[nm]; P[nm] = (mv_(v, R, t), f, part)
    err, eoj, ecan, mid = occl_err(R, t)
    info = dict(result='seated in centric occlusion', candidates=tried, before=before,
                rotation_deg=round(float(np.degrees(th)), 2), up_mm=round(dy * 1000, 2), forward_mm=round(dz * 1000, 2), left_mm=round(dx * 1000, 2),
                after=dict(min_joint_space_mm=round(joint(R, t) * 1000, 2), teeth_min_signed_gap_mm=round(contact(R, t) * 1000, 2),
                           overjet_minus_target_mm=[round(x * 1000, 2) for x in eoj], canine_tip_distal_of_embrasure_mm=[round(x * 1000, 2) for x in ecan],
                           lower_midline_to_upper_mm=round(mid * 1000, 2), occlusion_error_mm=round(err * 1000, 2)),
                transform=dict(R=R.tolist(), t=t.tolist()))
    log('mandible seating (occlusion)', {k: v for k, v in info.items() if k != 'transform'})
    return P, info


NORMAL_LENGTH_MM = {'upper_medial_incisor': 23.5, 'upper_lateral_incisor': 22.0, 'upper_canine': 27.0, 'upper_first_premolar': 22.5,
                    'upper_second_premolar': 22.5, 'upper_first_molar': 20.5, 'upper_second_molar': 20.0, 'lower_medial_incisor': 21.5,
                    'lower_lateral_incisor': 23.5, 'lower_canine': 27.0, 'lower_first_premolar': 22.5, 'lower_second_premolar': 22.5,
                    'lower_first_molar': 21.0, 'lower_second_molar': 19.5}   # overall tooth lengths (Wheeler)


def occlusion_criteria(Z, P, za_reference=None, skin_signed=None):
    """Acceptance criteria for the dentition: (criteria list, details)."""
    from fit.skull_measure import crit
    o = occlusion(P)
    sides = [o['r'], o['l']]
    g = lambda k: [s[k] for s in sides]
    post = [v for k, v in o['min_gap_to_upper_arch_mm'].items() if re.search('molar|premolar', k)]
    by_side = {s: min(v for k, v in o['min_gap_to_upper_arch_mm'].items() if re.search('molar|premolar', k) and k.endswith('_' + s)) for s in 'lr'}
    rig = []
    for n in P:
        if P[n][2] != 'teeth': continue
        T = umeyama(Z[n][0], P[n][0], scale=True); rig.append(float(np.linalg.norm(T(Z[n][0]) - P[n][0], axis=1).max()))
    lens = {}
    for n in P:
        if P[n][2] != 'teeth': continue
        X = P[n][0]; c, ax, _ = pca(X); L = float(np.ptp((X - c) @ ax[:, 0])) * 1000
        lens[n] = dict(length_mm=round(L, 1), ratio_to_normal=round(L / NORMAL_LENGTH_MM[n[:-2]], 2))
    out = [
        crit('incisor overjet (upper to lower central incisal edge, horizontal in the occlusal plane; right, left)', g('overjet_edge_mm'), '2-3 mm',
             all(2.0 <= x <= 3.0 for x in g('overjet_edge_mm')), unit='mm', labial_overjet_mm=g('overjet_labial_mm'),
             note='labial overjet: upper incisal edge to the most labial point of the lower incisor crown (its top 2 mm)'),
        crit('incisor overbite (vertical overlap of the central incisal edges; right, left)', g('overbite_mm'), '2-3 mm', all(2.0 <= x <= 3.0 for x in g('overbite_mm')),
             unit='mm', note='with the arches in contact (centric occlusion); limited by the Z-Anatomy incisor form, see details'),
        crit('canine relation (upper canine tip to the lower canine / first premolar embrasure, + = distal; right, left)', g('canine_tip_distal_of_embrasure_mm'),
             '|x| <= 1.5 mm (Class I)', all(abs(x) <= 1.5 for x in g('canine_tip_distal_of_embrasure_mm')), unit='mm'),
        crit('posterior teeth in contact or within a 1-3 mm freeway space (smallest premolar / molar gap to the upper arch, per side)', [by_side['r'], by_side['l']],
             '<= 3 mm each side', all(x <= 3.0 for x in by_side.values()), unit='mm'),
        crit('upper lateral incisor edges above the central incisor edges (right, left)', g('upper_lateral_edge_above_central_edge_mm'), '0.5-1.0 mm',
             all(0.5 <= x <= 1.0 for x in g('upper_lateral_edge_above_central_edge_mm')), unit='mm'),
        crit('teeth keep their Z-Anatomy shape (largest vertex deviation from a similarity copy of the source tooth)', round(max(rig) * 1000, 3), '<= 0.01 mm',
             max(rig) <= 1e-5, unit='mm'),
        crit('interincisal angle (right, left)', g('interincisal_angle_deg'), 'report (normal 125-135 deg; Z-Anatomy source 119 deg)', True, unit='deg',
             upper_incisor_axis_deg=g('upper_incisor_axis_deg'), lower_incisor_axis_deg=g('lower_incisor_axis_deg')),
    ]
    if skin_signed is not None:
        q = np.concatenate([sample_surface(*P[k][:2], 1500, seed=4) for k in P if P[k][2] == 'teeth'])
        sd = skin_signed(q)
        out.append(crit('teeth inside the lips and cheeks (smallest soft-tissue cover over the teeth)', round(float(-sd.max()) * 1000, 2), '>= 3 mm',
                        float(-sd.max()) >= 0.003, unit='mm', samples_outside_skin=int((sd > 0).sum()), n_samples=int(len(q))))
    det = dict(occlusion=o, tooth_lengths=lens, posterior_min_gaps_mm=post,
               length_note='lengths follow the Z-Anatomy teeth (their roots are 1.0-1.4x the textbook lengths) times the jaws\' common alveolar scale')
    if za_reference is not None: det['za_source_occlusion'] = za_reference
    return out, det


LIP_MIN = 0.0038   # soft tissue kept over the teeth (the refinement's minimum soft-tissue cover for bone and teeth)
TIP_MAX = 25.0     # largest lingual tipping of one tooth (deg)


def fit_lips(P, skin_signed, log=print):
    """Anterior teeth (incisors and canines) whose crowns would come closer than LIP_MIN to the skin (the Z-Anatomy
    incisors are proclined; the HRA lips are closer) are tipped lingually, each rigidly about a point in its apical
    third (the tipping centre of an incisor), by the smallest angle that gives the cover, as the lips and the tongue
    balance the incisors in life. skin_signed: signed distance to the head skin (negative inside)."""
    from lib.register import Sim as _Sim
    c, n, fw = occlusal_frame(P)
    info, tr = {}, {}
    for jaw in ('upper', 'lower'):
        tn = teeth_of(P, jaw)
        ac = np.mean([P[k][0].mean(0) for k in tn], 0)
        for k in tn:
            if not re.search('incisor|canine', k): continue
            V = P[k][0]
            sub = V[::max(1, len(V) // 1500)]
            d0 = float(skin_signed(sub).max())
            if d0 <= -LIP_MIN: continue
            a = long_axis(V, n); r = a if jaw == 'upper' else -a         # r: towards the root apex
            cc = V.mean(0); t = (V - cc) @ r; L = float(np.ptp(t))
            piv = cc + r * (t.max() - L / 3)
            dl = cc - ac; dl -= (dl @ n) * n; dl /= np.linalg.norm(dl)     # labial direction (in the occlusal plane)
            kx = np.cross(r, dl); kx /= np.linalg.norm(kx)
            best = None
            for phi in np.arange(0.5, TIP_MAX + 0.01, 0.5):
                R = rotation_axis(kx, np.radians(phi))
                if float(skin_signed((sub - piv) @ R.T + piv).max()) <= -LIP_MIN: best = phi; break
            phi = best if best is not None else TIP_MAX
            R = rotation_axis(kx, np.radians(phi))
            P[k] = ((V - piv) @ R.T + piv, P[k][1], P[k][2])
            tr[k] = (R, piv - R @ piv)
            info[k] = dict(skin_signed_before_mm=round(d0 * 1000, 2), lingual_tip_deg=float(phi),
                           skin_signed_after_mm=round(float(skin_signed(P[k][0][::max(1, len(V) // 1500)]).max()) * 1000, 2),
                           reached=best is not None)
    log('teeth: lip cover', info)
    return P, tr, info
