"""Shoulder girdle: clavicle and scapula placed on the rib cage group's final thorax, refined against the skin.

The thorax the girdle articulates with is the rib cage group's output (.cache/fit/<sex>/ribcage/: ribs, manubrium,
first costal cartilage, same HRA frame, same vertex order as Z-Anatomy). Start (the same rule on both sides): the
scapula keeps its Z-Anatomy relation to the posterior chest wall (the rigid motion, at the body scale, that carries
Z-Anatomy's ribs 2-8 under the scapula onto the final ribs), the clavicle's sternal facet sits on the final manubrium's
clavicular notch and the clavicle is aimed at that scapula's acromion. Then a kinematic chain (clavicle about the
sternoclavicular joint with a small glide, scapula about the acromioclavicular joint with a small glide, riding on the
clavicle) is fitted by least squares to
  - the scapulothoracic gap: every sample of the scapula's costal surface at its Z-Anatomy distance from the ribs
    (subscapularis and serratus anterior lie between; Z-Anatomy p5/p50 5.3/11.6 mm) within a two-sided band, the
    inferior angle at its Z-Anatomy distance, no part of the scapula closer than 3 mm to a rib,
  - joint spaces: sternoclavicular (clavicle to the final manubrium) and acromioclavicular closest approach 1.2-2.8 mm,
    with each facet facing its partner (facet centre to centre within Z-Anatomy's distance + 3 / 2 mm),
  - the costoclavicular space: the clavicle at least 6 mm from rib 1 and its cartilage lateral to the sternal end
    (subclavius and the subclavian vein pass there), 3 mm over the medial 25 mm (articular disc, costoclavicular ligament),
  - the clavicle (lateral two thirds) and the acromion subcutaneous, both bones inside the skin, the humeral head under
    the deltoid and centred front-to-back in the shoulder as in Z-Anatomy,
  - priors: the scapula's tilt, upward rotation and internal rotation relative to the chest wall as in Z-Anatomy, small
    clavicle rotations and joint glides.
"""
import os
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import source, sample_surface, load, merge
from lib.register import umeyama
from fit.arms_geom import Aff, TriMesh, unit, ray_exit, FrontBack, rot_between
from fit.arms_solve import Bodies, solve, term_surface_band, term_body_gap, term_point_target, term_points_pair, term_regular
from fit.arms_za import contact, _samples


def local_similarity(W, v, n=3000, seed=0, scale=None):
    """The similarity closest to the warp W over the points v. With `scale` given, only rotation and translation are
    fitted (the trunk warp's local scale varies between the two shoulders, the bones' size should not)."""
    rng = np.random.default_rng(seed)
    p = v if len(v) <= n else v[rng.choice(len(v), n, replace=False)]
    if scale is None:
        S = umeyama(p, W(p), scale=True)
        return Aff(S.s * S.R, S.t), S.s
    S = umeyama(scale * p, W(p), scale=False)
    return Aff(scale * S.R, S.t), scale


def upper_thorax_rigid(W, s0, levels=('C7', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7')):
    """Rotation + translation (at scale s0) that best carries Z-Anatomy's C7-T7 vertebrae to where the warp puts them."""
    s = source('za-skeletal')
    P = np.concatenate([sample_surface(*s.get('Vertebra_' + k), 400, seed=1) for k in levels])
    S = umeyama(s0 * P, W(P), scale=False)
    return Aff(s0 * S.R, S.t)


def za_shoulder_ap(L):
    """Signed offset (mm) of the humeral head centre from the middle of the shoulder's front and back skin, in
    Z-Anatomy (its deltoid / pectoral / scapular skin regions)."""
    from lib.mesh import merge
    r = source('za-regions')
    ents = [o for o in r.index if o['name'][-1] not in 'ji' and 'Hairs' not in o['path'] and o['name'][-1] == L.side]
    v, f = r.load(ents)
    gh = L.J['gh']
    out = []
    for sgn in (1, -1):
        # nearest patch crossing of the line through gh along z, on each side
        m = (np.abs(v[:, 0] - gh[0]) < 0.006) & (np.abs(v[:, 1] - gh[1]) < 0.006) & ((v[:, 2] - gh[2]) * sgn > 0)
        out.append(np.min(np.abs(v[m, 2] - gh[2])) if m.any() else np.nan)
    fr, bk = out
    return float((fr - bk) * 0.5e3)


# A rigid bone that the warp bends by more than this is not trusted. The male's warped manubrium is 8.6 mm RMS from
# its own shape at body scale, 93 mm along its long axis, with its clavicular notches 18 mm apart in height and 19 mm
# in depth (Z-Anatomy's are level); the upper thoracic spine rule puts them level, 38 mm apart.
MANUBRIUM_MAX_RMS = 0.002


def manubrium_placement(W, mv, mf):
    """The manubrium the clavicles articulate with. As specified, it is Z-Anatomy's manubrium through the trunk warp,
    which is how the thorax places it. The warp has no anchor at the manubrium, so it is checked: if no
    shape-preserving placement (rotation + translation at the body scale) comes within MANUBRIUM_MAX_RMS of the warped
    shape, the warped bone is distorted and the rigid motion of the upper thoracic spine (C7-T7, which the warp fits
    to ~1 mm) places it instead. Returns dict(map, mesh, how, rms_mm)."""
    s0 = float(W.pre.s)
    A, _ = local_similarity(W, mv, scale=s0)
    rms = float(np.sqrt(((A(mv) - W(mv)) ** 2).sum(1).mean()))
    if rms <= MANUBRIUM_MAX_RMS:
        return dict(map=W, mesh=(W(mv), mf), how='trunk warp', rms_mm=rms * 1e3)
    Gu = upper_thorax_rigid(W, s0)
    return dict(map=Gu, mesh=(Gu(mv), mf), how='upper thoracic spine (warped manubrium distorted)', rms_mm=rms * 1e3)


def za_ribs(side):
    s = source('za-skeletal')
    es = [o for o in s.index if o['path'].startswith('/Thoracic_skeletong') and o['name'].endswith(side) and o['name'][-2] != 'j'
          and 'rib' in o['name'] and 'Costal' not in o['name'] and o['name'][:-1] in
          ('First_rib', 'Second_rib', 'Third_rib', 'Fourth_rib', 'Fifth_rib', 'Sixth_rib', 'Seventh_rib', 'Eighth_rib')]
    return s.load(es)


def acromion_points(L, P):
    """Samples of the scapula that belong to the acromion (lateral end of the spine, above the glenoid)."""
    J = L.J
    up = P[:, 1] > J['glenoid'][1] + 0.012
    lat = (P[:, 0] - J['ac'][0]) * L.sg > -0.012
    near = np.linalg.norm(P - J['ac'], axis=1) < 0.045
    return P[up & lat & near]


def _rot(w):
    a = np.linalg.norm(w)
    if a < 1e-12: return np.eye(3)
    k = w / a; K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K


ORD_RIB = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth']
WALL_RIBS = range(1, 11)        # ribs the scapula can face
WALL_TOL = 3.5                  # mm: scapulothoracic gap band around Z-Anatomy's distance
WALL_MIN = 3.0                  # mm: nowhere closer to a rib
JOINT_SPACE = (1.2, 2.8)        # mm: sternoclavicular and acromioclavicular closest approach
COSTOCLAV = (3.0, 6.0)          # mm: clavicle to rib 1 / first costal cartilage at the sternal end, lateral to it
COSTOCLAV_MEDIAL = 0.025        # m (Z-Anatomy): the sternal end region, from the sternal facet centre (costoclavicular
                                # ligament and subclavius tendon; the subclavian vein passes lateral to them)
PRIOR_DEG = dict(up=8.0, tilt=5.0, int=8.0, clav=10.0)
FACET_TOL = dict(sc=3.0, ac=2.0)  # mm beyond Z-Anatomy's facet centre distances (criteria: <= 8 and <= 6 mm)
GLIDE_MM = 2.0


def ribcage_files(sex, side):
    from fit.common import FIT
    d = os.path.join(FIT, sex, 'ribcage')
    return dict(ribs=[os.path.join(d, f'rib_{k}_{side}.npz') for k in WALL_RIBS], man=os.path.join(d, 'manubrium.npz'),
                rib1=os.path.join(d, f'rib_1_{side}.npz'), cc1=os.path.join(d, f'costal_cartilage_1_{side}.npz'))


def za_wall(side):
    s = source('za-skeletal')
    return [s.get(f'{ORD_RIB[k - 1]}_rib{side}') for k in WALL_RIBS]


def wall_rigid(za_ribs, hra_ribs, zscap, s0, ks=range(2, 9), near=0.045):
    """Rotation + translation (at the body scale s0) carrying the Z-Anatomy ribs 2-8 where the scapula lies (vertices
    within `near` of the scapula) onto the final ribs (same vertex order). Returns (Aff, rms mm)."""
    tree = cKDTree(zscap)
    P, Q = [], []
    for k in ks:
        zv = za_ribs[k - 1][0]; hv = hra_ribs[k - 1][0]
        if len(zv) != len(hv): continue
        m = tree.query(zv)[0] < near
        P.append(zv[m]); Q.append(hv[m])
    P = np.concatenate(P); Q = np.concatenate(Q)
    S = umeyama(s0 * P, Q, scale=False)
    A = Aff(s0 * S.R, S.t)
    return A, float(np.sqrt(((A(P) - Q) ** 2).sum(1).mean()) * 1e3)


def local_rigid(zv, hv, centre, s0, r=0.03):
    """Rigid motion at the body scale carrying Z-Anatomy vertices within r of `centre` onto the same vertices of a
    placed copy (the final manubrium). Returns (Aff, rms mm)."""
    m = np.linalg.norm(zv - centre, axis=1) < r
    S = umeyama(s0 * zv[m], hv[m], scale=False)
    A = Aff(s0 * S.R, S.t)
    return A, float(np.sqrt(((A(zv[m]) - hv[m]) ** 2).sum(1).mean()) * 1e3)


def _rotvec(R):
    ang = np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))
    if ang < 1e-9: return np.zeros(3)
    return np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / (2 * np.sin(ang)) * ang


def costal_samples(L, za_ribs, n=300, seed=3, dmax=0.03):
    """Z-Anatomy samples of the scapula's costal surface (outward normal facing the nearest rib, within dmax of it)
    and their distance to the ribs (m)."""
    sv, sf = L.M['scap']
    P = sample_surface(sv, sf, 6000, seed=seed)
    R = TriMesh(*merge(za_ribs))
    d, q, _, _ = R.closest(P)
    _, _, _, nrm = L.T['scap'].signed_full(P)
    face = np.einsum('ij,ij->i', nrm, (q - P) / np.maximum(d, 1e-9)[:, None])
    m = (face > 0.3) & (d < dmax)
    P, d = P[m], d[m]
    rng = np.random.default_rng(seed)
    k = rng.choice(len(P), min(n, len(P)), replace=False)
    return P[k], d[k]


def fit_girdle(L, W, skinT, lungsT, sex, log=print):
    """Shoulder girdle as a kinematic chain on the final thorax (see the module docstring). Returns dict(clav=Aff,
    scap=Aff, info, notch_pts (the final manubrium's clavicular notch), notch_pts_warp, se, ae, af, acr)."""
    from scipy.optimize import least_squares
    J = L.J; sg = L.sg
    cv, cf = L.M['clav']; sv_, sf_ = L.M['scap']
    s0 = float(W.pre.s)
    files = ribcage_files(sex, L.side)
    hra_ribs = [load(p) for p in files['ribs']]
    za_ribs = za_wall(L.side)
    ribsT = TriMesh(*merge(hra_ribs), k=12)
    man_h = load(files['man']); Tman = TriMesh(*man_h, k=12)
    rcT = TriMesh(*merge([load(files['rib1']), load(files['cc1'])]), k=12)
    # the clavicular notch of the final manubrium (Z-Anatomy's notch carried by the manubrium's local rigid motion)
    se0, _ = contact(L.P['clav'], L.Tman, 0.006)
    c_se = se0.mean(0)
    Pm = _samples(L.man)
    notch, _ = contact(Pm, L.T['clav'], 0.006)
    Gm, man_rms = local_rigid(L.man[0], man_h[0], c_se, s0)
    sc_target = Gm(c_se[None])[0]
    ae, _ = contact(L.P['clav'], L.T['scap'], 0.004)
    af, _ = contact(L.P['scap'], L.T['clav'], 0.004)
    za_sc = np.linalg.norm(se0.mean(0) - notch.mean(0)); za_ac = np.linalg.norm(ae.mean(0) - af.mean(0))
    Pc = L.P['clav']; Ps = L.P['scap']
    acr = acromion_points(L, Ps)
    rng = np.random.default_rng(3)
    def sub(P, n): return P if len(P) <= n else P[rng.choice(len(P), n, replace=False)]
    Pc_z = sub(Pc, 400); Ps_z = sub(Ps, 400); acr_z = sub(acr, 100)
    hp = L.P['hum']; head = hp[np.linalg.norm(hp - J['gh'], axis=1) < J['gh_r'] + 0.003]
    head_z = sub(head[(head - J['gh']) @ J['glenoid_n'] > 0.3 * J['gh_r']], 100)  # the part of the head under the deltoid
    ap_za = za_shoulder_ap(L)
    xs = Pc_z[:, 0] * sg
    edges = np.linspace(xs.min(), xs.max(), 8)
    seg = np.clip(np.searchsorted(edges, xs) - 1, 0, 6)
    fb = FrontBack(skinT, W(J['gh'][None])[0], half=0.06, step=0.005)
    # chest wall: costal-surface samples with their Z-Anatomy gap, the inferior angle, all samples for the minimum
    Pw, dw_za = costal_samples(L, za_ribs)
    lo_w = np.maximum(WALL_MIN + 1.0, s0 * dw_za * 1e3 - WALL_TOL); hi_w = s0 * dw_za * 1e3 + WALL_TOL
    ia = sv_[np.argmin(sv_[:, 1])]
    ia_za = float(TriMesh(*merge(za_ribs)).closest(ia[None])[0][0] * 1e3)
    Pmin = sub(Ps, 250)
    # joints: sternal end, acromial end and acromial facet samples
    Pc_sc = Pc[np.linalg.norm(Pc - c_se, axis=1) < 0.015]
    Pc_ac = Pc[np.linalg.norm(Pc - J['ac'], axis=1) < 0.012]; Ps_ac = Ps[np.linalg.norm(Ps - J['ac'], axis=1) < 0.012]
    Pc_sc = sub(Pc_sc, 150); Pc_ac = sub(Pc_ac, 120); Ps_ac = sub(Ps_ac, 120)
    medial = np.linalg.norm(Pc_z - c_se, axis=1) < COSTOCLAV_MEDIAL
    need_cc = np.where(medial, COSTOCLAV[0], COSTOCLAV[1])
    # articular congruence: each facet faces its partner (centre to centre at most Z-Anatomy's distance + FACET_TOL), so
    # the joint spaces cannot be met by sliding the clavicle's end along the manubrium or the acromion
    notch_c = Gm(notch).mean(0); ae_c = ae.mean(0); af_c = af.mean(0)
    sc_facet_hi = s0 * za_sc * 1e3 + FACET_TOL['sc']; ac_facet_hi = s0 * za_ac * 1e3 + FACET_TOL['ac']

    def soft_min(c, tau=0.4):
        m = c.min(); return m - tau * np.log(np.exp(-(c - m) / tau).sum())

    def band(v, lo=None, hi=None):
        r = 0.0
        if lo is not None and v < lo: r += lo - v
        if hi is not None and v > hi: r += v - hi
        return r

    # start: the scapula on the chest wall as in Z-Anatomy, the clavicle from the notch aimed at its acromion
    Gw, wall_rms = wall_rigid(za_ribs, hra_ribs, sv_, s0)
    Gc = Aff(Gw.A, Gw.t + (sc_target - Gw(c_se[None])[0]))
    ac_s = Gw(J['ac'][None])[0]
    Gc = Gc.then(Aff.about(rot_between(Gc(J['ac'][None])[0] - sc_target, ac_s - sc_target), sc_target))
    Gs = Aff(Gw.A, Gw.t + (Gc(J['ac'][None])[0] - ac_s))
    start_ac_mismatch = float(np.linalg.norm(Gc(J['ac'][None])[0] - ac_s) * 1e3)
    # the scapula's axes in the start pose: plane normal (upward rotation), medio-lateral (tilt), vertical (internal rot.)
    c0 = sv_.mean(0); w_, V_ = np.linalg.eigh(np.cov((sv_ - c0).T))
    n_s = unit(Gs.vec(V_[:, 0])); up = np.array([0.0, 1.0, 0.0])
    e_v = unit(up - (up @ n_s) * n_s); e_ml = np.cross(n_s, e_v)
    sc_h = sc_target; ac_h0 = Gc(J['ac'][None])[0]

    def maps(x):
        Rc = _rot(x[0:3]); Rs = _rot(x[6:9])
        Cm = Aff.about(Rc, sc_h).then(Aff(np.eye(3), x[3:6] * 1e-3))
        C = Gc.then(Cm)
        S = Gs.then(Aff.about(Rs, ac_h0)).then(Aff(np.eye(3), x[9:12] * 1e-3)).then(Cm)   # the scapula rides on the clavicle
        return C, S

    def resid(x, detail=False):
        C, S = maps(x)
        pc = C(Pc_z); ps = S(Ps_z); pa = S(acr_z); ph = S(head_z)
        clc = -skinT.signed(pc) * 1e3; cls = -skinT.signed(ps) * 1e3; cla = -skinT.signed(pa) * 1e3; clh = -skinT.signed(ph) * 1e3
        out = {}
        out['acromion'] = 2.0 * band(soft_min(cla), 1.5, 4.5)
        out['clav_lat'] = 2.0 * band(soft_min(clc[seg == 6]), 1.5, 5.0)
        for k in range(1, 6): out[f'clav_seg{k}'] = 0.3 * band(soft_min(clc[seg == k]), None, 5.0)
        out['clav_in'] = 1.0 * np.sqrt(np.sum(np.maximum(0, 1.0 - clc) ** 2))
        out['scap_in'] = 1.0 * np.sqrt(np.sum(np.maximum(0, 1.0 - cls) ** 2))
        dw = ribsT.closest(S(Pw))[0] * 1e3
        rw = np.maximum(0, lo_w - dw) + np.maximum(0, dw - hi_w)
        out['scap_wall'] = 2.5 * np.sqrt(np.mean(rw ** 2))
        dm = ribsT.closest(S(Pmin))[0] * 1e3
        out['scap_rib_min'] = 1.0 * np.sqrt(np.sum(np.maximum(0, WALL_MIN - dm) ** 2))
        dia = float(ribsT.closest(S(ia[None]))[0][0] * 1e3)
        out['inferior_angle'] = 1.0 * band(dia, s0 * ia_za - 2.5, s0 * ia_za + 2.5)
        ms = Tman.signed(C(Pc_sc)) * 1e3
        out['sc_space'] = 1.5 * band(soft_min(ms, 0.2), *JOINT_SPACE)
        out['sc_min'] = 1.0 * np.sqrt(np.sum(np.maximum(0, 0.8 - ms) ** 2))
        d1 = L.T['scap'].signed(S.inverse()(C(Pc_ac))) * s0 * 1e3
        d2 = L.T['clav'].signed(C.inverse()(S(Ps_ac))) * s0 * 1e3
        dac = np.r_[d1, d2]
        out['ac_space'] = 1.5 * band(soft_min(dac, 0.2), *JOINT_SPACE)
        out['ac_min'] = 1.0 * np.sqrt(np.sum(np.maximum(0, 0.8 - dac) ** 2))
        d_scf = float(np.linalg.norm(C(c_se[None])[0] - notch_c) * 1e3)
        d_acf = float(np.linalg.norm(C(ae_c[None])[0] - S(af_c[None])[0]) * 1e3)
        out['sc_facet'] = 2.0 * band(d_scf, None, sc_facet_hi)
        out['ac_facet'] = 2.0 * band(d_acf, None, ac_facet_hi)
        dcc = rcT.closest(pc)[0] * 1e3
        out['costoclavicular'] = 1.0 * np.sqrt(np.sum(np.maximum(0, need_cc - dcc) ** 2))
        lc = lungsT.closest(pc)[0] * 1e3
        out['clav_lung'] = 1.0 * np.sqrt(np.sum(np.maximum(0, 3.0 - lc) ** 2))
        out['head_deltoid'] = 1.0 * band(soft_min(clh), 12.0, None)
        gh = S(J['gh'][None])[0]
        fr, bk = fb(gh)
        out['gh_ap'] = 1.0 * band((fr - bk) * 0.5e3 - ap_za, -6.0, 6.0)
        wv = _rotvec(_rot(x[0:3]) @ _rot(x[6:9]))
        rot = dict(up=float(wv @ n_s), tilt=float(wv @ e_ml), int=float(wv @ e_v))
        if detail:
            out = {k: float(v) for k, v in out.items()}
            out.update({f'scap_{k}_deg': float(np.degrees(v)) for k, v in rot.items()})
            out.update(wall_p5=float(np.percentile(dw, 5)), wall_p50=float(np.median(dw)), wall_in_band_pct=float(np.mean(rw == 0) * 100),
                       ia_mm=dia, sc_mm=float(ms.min()), ac_mm=float(dac.min()), sc_facet_mm=d_scf, ac_facet_mm=d_acf, costoclav_lat_mm=float(dcc[~medial].min()),
                       costoclav_med_mm=float(dcc[medial].min()) if medial.any() else None)
            return out
        pri = [rot[k] / np.radians(PRIOR_DEG[k]) for k in ('up', 'tilt', 'int')]
        return np.r_[np.array(list(out.values())), pri, x[0:3] / np.radians(PRIOR_DEG['clav']), x[3:6] / GLIDE_MM, x[9:12] / GLIDE_MM]

    x0 = np.zeros(12)
    step = np.r_[np.full(3, 1e-3), np.full(3, 0.05), np.full(3, 1e-3), np.full(3, 0.05)]
    res = least_squares(resid, x0, method='trf', diff_step=step, max_nfev=100, x_scale=np.r_[np.full(3, 0.05), np.ones(3), np.full(3, 0.05), np.ones(3)])
    C, S = maps(res.x)
    terms = {k: round(v, 2) for k, v in resid(res.x, detail=True).items()}
    t0 = {k: round(v, 2) for k, v in resid(x0, detail=True).items()}
    log(f'  girdle {L.side}: wall start (ribs 2-8 rms {wall_rms:.1f} mm, start AC mismatch {start_ac_mismatch:.1f} mm), cost {res.cost:.2f} '
        f'({res.nfev} evaluations); clavicle {np.degrees(np.linalg.norm(res.x[:3])):.1f} deg, scapula {np.degrees(np.linalg.norm(res.x[6:9])):.1f} deg, '
        f'glides SC {np.linalg.norm(res.x[3:6]):.1f} AC {np.linalg.norm(res.x[9:12]):.1f} mm')
    log(f'  girdle {L.side} start terms: {t0}')
    log(f'  girdle {L.side} final terms: {terms}')
    info = dict(scale=s0, start='chest wall (ribs 2-8 of the rib cage group, Z-Anatomy relation)', wall_rigid_rms_mm=wall_rms,
                manubrium='rib cage group final manubrium', manubrium_local_rms_mm=man_rms, start_ac_mismatch_mm=start_ac_mismatch,
                sternal_facet_to_notch_mm=float(np.linalg.norm(C(se0).mean(0) - Gm(notch).mean(0)) * 1e3),
                rot_clav_deg=float(np.degrees(np.linalg.norm(res.x[:3]))), rot_scap_deg=float(np.degrees(np.linalg.norm(res.x[6:9]))),
                glide_sc_mm=float(np.linalg.norm(res.x[3:6])), glide_ac_mm=float(np.linalg.norm(res.x[9:12])),
                cost=float(res.cost), notch=Gm(notch).mean(0).tolist(), za_sc_mm=float(za_sc * 1e3), za_ac_mm=float(za_ac * 1e3),
                za_inferior_angle_mm=ia_za, terms=terms, start_terms=t0,
                ribcage_files={k: (os.path.getmtime(v) if isinstance(v, str) else [os.path.getmtime(p) for p in v]) for k, v in files.items()})
    return dict(clav=C, scap=S, man=man_h, info=info, notch_pts=Gm(notch), notch_pts_warp=W(notch), se=se0, ae=ae, af=af, acr=acr)
