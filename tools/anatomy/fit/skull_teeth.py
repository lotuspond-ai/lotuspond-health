"""Teeth for the skull fit (fit/skull.py): each dental arch moves rigidly with its jaw, the mandible is seated in centric
occlusion with its condyles in the fossae, and the occlusion is measured.

Why rigid: the head warp and the collision field are smooth over centimetres but the teeth sit right under the lips,
where the warp follows the face skin and the field holds a minimum soft-tissue cover. Carried by them, the crowns were
dented, carried needle spikes, the incisors were tipped by up to 17 degrees and each tooth was scaled by 1.15-1.30 (the
jaws themselves by 1.08-1.13). Here every tooth keeps its Z-Anatomy shape exactly:
  - arch block: one similarity per arch, fitted (Umeyama) from the Z-Anatomy alveolar bone (maxillae for the upper
    teeth, mandible for the lower; bone within ARCH_R of the teeth) to the same bone as placed. The teeth keep the
    Z-Anatomy arch form, inclinations and contacts and follow their sockets on average,
  - the upper lateral incisors are moved along their own long axis so that their incisal edges lie LATERAL_STEP above
    the central incisors' (Z-Anatomy has them 1.4 mm below, which looks like hanging laterals),
  - the mandible (with the lower arch) is seated by the smallest rigid move that (i) keeps a joint space of at least
    JS_MIN between each condylar head and its temporal bone, (ii) has the arches in contact without interpenetration
    (centric occlusion), and (iii) gives the best incisor / canine relation (labial overjet OVERJET, upper canine tip on
    the lower canine / first premolar embrasure, lower and upper dental midlines aligned).
"""
import os, sys
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
OVERJET = 0.0025        # labial overjet target (upper incisal edge to the lower incisor labial face), normal 2-3 mm
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
    return T, dict(n_bone_vertices=int(m.sum()), scale=round(float(T.s), 4), bone_rms_mm=round(float(np.sqrt((r ** 2).mean()) * 1000), 2))


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
    info, tr = {}, {}
    for jaw in ('upper', 'lower'):
        T, inf = arch_transform(Z, P, jaw); info[jaw + '_arch'] = inf
        for n in teeth_of(P, jaw):
            P[n] = (T(Z[n][0]), P[n][1], P[n][2]); tr[n] = Sim(T.s, T.R, T.t)
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
        Lc = D[f'lower_medial_incisor_{s}']; lt = Lc[H(Lc) > H(Lc).max() - 0.002]
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
            oj = F(q['ue']) - F(mv_(q['lt'], R, t)).max()
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
