"""Shoulder girdle: clavicle and scapula from the trunk warp, refined against the skin and the thorax.

Start: each bone takes the similarity that best matches the trunk warp over it (shape kept). Then a joint rigid
refinement (clavicle about the sternoclavicular joint, scapula about the acromioclavicular joint) keeps
  - the clavicle's sternal end on the manubrium's clavicular notch (the manubrium is warped with the trunk warp,
    exactly as the thorax group places it),
  - the acromial end on the acromion,
  - the clavicle (lateral two thirds) and the acromion subcutaneous (they are palpable along their length),
  - the scapula off the warped ribs (subscapularis / serratus space) and the clavicle off the first rib,
  - all of both bones inside the skin,
with small rotations preferred.
"""
import numpy as np

from lib.mesh import source, sample_surface
from lib.register import umeyama
from fit.arms_geom import Aff, TriMesh, unit, ray_exit, FrontBack
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


MANUBRIUM_MAX_RMS = 0.012


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


def fit_girdle(L, W, skinT, lungsT, log=print):
    """Shoulder girdle as a kinematic chain: the clavicle turns about the sternoclavicular joint, which sits on the
    warped manubrium's clavicular notch; the scapula hangs from the clavicle's acromial end and turns about the
    acromioclavicular joint. Six angles are fitted (least squares) to: acromion and lateral clavicle subcutaneous,
    both bones inside the skin, scapula off the chest wall and the clavicle above the lung apex (measured against the
    HRA lungs, which are real: the warped ribs are distorted at the shoulders), the clavicle off the manubrium, humeral
    head under the deltoid and centred front-to-back in the shoulder as in Z-Anatomy, small rotations preferred.
    Two starts are tried (the warp's rotation over each bone, and the rigid motion of the upper thoracic spine) and the
    better fit is kept: the trunk warp is an extrapolation at the shoulders and can be badly distorted there.
    Returns dict(clav=Aff, scap=Aff, man=(v, f) warped, info, ...)."""
    from scipy.optimize import least_squares
    J = L.J
    cv, cf = L.M['clav']; sv_, sf_ = L.M['scap']
    s0 = float(W.pre.s)
    se0, _ = contact(L.P['clav'], L.Tman, 0.006)
    c_se = se0.mean(0)
    mv, mf = L.man
    man = manubrium_placement(W, mv, mf)
    Mfun = man['map']
    sc_target = Mfun(c_se[None])[0]       # the sternal facet on the manubrium's clavicular notch
    man_w = man['mesh']
    Tman = TriMesh(*man_w)
    rv, rf = za_ribs(L.side)
    ribs = TriMesh(W(rv), rf)
    Pc = L.P['clav']; Ps = L.P['scap']
    Pm = _samples(L.man)
    notch, _ = contact(Pm, L.T['clav'], 0.006)
    ae, _ = contact(Pc, L.T['scap'], 0.004)
    af, _ = contact(Ps, L.T['clav'], 0.004)
    za_sc = np.linalg.norm(se0.mean(0) - notch.mean(0)); za_ac = np.linalg.norm(ae.mean(0) - af.mean(0))
    acr = acromion_points(L, Ps)
    rng = np.random.default_rng(3)
    def sub(P, n): return P if len(P) <= n else P[rng.choice(len(P), n, replace=False)]
    Pc_z = sub(Pc, 600); Ps_z = sub(Ps, 900); acr_z = sub(acr, 150)
    hp = L.P['hum']; head = hp[np.linalg.norm(hp - J['gh'], axis=1) < J['gh_r'] + 0.003]
    head_z = sub(head[(head - J['gh']) @ J['glenoid_n'] > 0.3 * J['gh_r']], 150)  # the part of the head under the deltoid
    ap_za = za_shoulder_ap(L)
    xs = Pc_z[:, 0] * L.sg
    edges = np.linspace(xs.min(), xs.max(), 8)
    seg = np.clip(np.searchsorted(edges, xs) - 1, 0, 6)
    fb = FrontBack(skinT, W(J['gh'][None])[0], half=0.06, step=0.005)

    def soft_min(c, tau=0.4):
        m = c.min(); return m - tau * np.log(np.exp(-(c - m) / tau).sum())

    def band(v, lo=None, hi=None):
        r = 0.0
        if lo is not None and v < lo: r += lo - v
        if hi is not None and v > hi: r += v - hi
        return r

    def run(Gc, Gs):
        sc_h = Gc(c_se[None])[0]
        ac_h0 = Gc(J['ac'][None])[0]

        def maps(x):
            Rc = _rot(x[:3]); Rs = _rot(x[3:6])
            C = Gc.then(Aff.about(Rc, sc_h))
            S = Gs.then(Aff.about(Rs, ac_h0)).then(Aff.about(Rc, sc_h))  # scapula turns about AC, then rides the clavicle
            return C, S

        def resid(x, detail=False):
            C, S = maps(x)
            pc = C(Pc_z); ps = S(Ps_z); pa = S(acr_z); ph = S(head_z)
            clc = -skinT.signed(pc) * 1e3; cls = -skinT.signed(ps) * 1e3; cla = -skinT.signed(pa) * 1e3; clh = -skinT.signed(ph) * 1e3
            ls = lungsT.closest(ps)[0] * 1e3; lc = lungsT.closest(pc)[0] * 1e3; mc = Tman.signed(pc) * 1e3
            out = {}
            out['acromion'] = 2.0 * band(soft_min(cla), 1.5, 4.5)
            out['clav_lat'] = 2.0 * band(soft_min(clc[seg == 6]), 1.5, 5.0)
            for k in range(1, 6): out[f'clav_seg{k}'] = 0.3 * band(soft_min(clc[seg == k]), None, 5.0)
            out['clav_in'] = 1.0 * np.sqrt(np.sum(np.maximum(0, 1.0 - clc) ** 2))
            out['scap_in'] = 1.0 * np.sqrt(np.sum(np.maximum(0, 1.0 - cls) ** 2))
            out['scap_lung'] = 1.0 * np.sqrt(np.sum(np.maximum(0, 12.0 - ls) ** 2))   # Z-Anatomy: 17 mm (ribs, muscles)
            out['clav_lung'] = 1.0 * np.sqrt(np.sum(np.maximum(0, 3.0 - lc) ** 2))    # Z-Anatomy: 4-7 mm (first rib)
            out['clav_man'] = 0.3 * np.sqrt(np.sum(np.maximum(0, 0.3 - mc) ** 2))
            out['head_deltoid'] = 1.0 * band(soft_min(clh), 12.0, None)
            gh = S(J['gh'][None])[0]
            fr, bk = fb(gh)
            out['gh_ap'] = 1.0 * band((fr - bk) * 0.5e3 - ap_za, -6.0, 6.0)
            if detail: return out
            return np.r_[np.array(list(out.values())), x / np.radians(10.0)]

        res = least_squares(resid, np.zeros(6), method='trf', diff_step=1e-3, max_nfev=120, x_scale=np.full(6, 0.05))
        C, S = maps(res.x)
        return res, C, S, {k: round(float(v), 2) for k, v in resid(res.x, detail=True).items()}

    # start A: the warp's rotation over each bone at the body scale (the warp's local scale at the shoulders swings
    # between 0.4 and 1.9, the bones' size should not); start B: the upper thoracic spine's rigid motion
    med = cv[(cv[:, 0] - c_se[0]) * L.sg < 0.06]
    GcA, _ = local_similarity(W, med, scale=s0); GsA, _ = local_similarity(W, sv_, scale=s0)
    Gu = upper_thorax_rigid(W, s0)
    best = None
    for name, Gc, Gs in (('warp', GcA, GsA), ('spine', Gu, Gu)):
        Gc = Aff(Gc.A, Gc.t + (sc_target - Gc(c_se[None])[0]))                     # sternal facet on the notch
        Gs = Aff(Gs.A, Gs.t + (Gc(J['ac'][None])[0] - Gs(J['ac'][None])[0]))       # acromion on the clavicle's end
        res, C, S, terms = run(Gc, Gs)
        log(f'  girdle {L.side} start {name}: cost {res.cost:.2f}, clavicle {np.degrees(np.linalg.norm(res.x[:3])):.1f} deg, scapula {np.degrees(np.linalg.norm(res.x[3:])):.1f} deg')
        if best is None or res.cost < best[0].cost: best = (res, C, S, terms, name)
    res, C, S, terms, name = best
    info = dict(scale=s0, start=name, manubrium=man['how'], manubrium_warp_rms_mm=man['rms_mm'],
                sternal_facet_to_warped_notch_mm=float(np.linalg.norm(C(se0).mean(0) - W(notch).mean(0)) * 1e3), rot_clav_deg=float(np.degrees(np.linalg.norm(res.x[:3]))), rot_scap_deg=float(np.degrees(np.linalg.norm(res.x[3:]))),
                cost=float(res.cost), notch=W(notch).mean(0).tolist(), za_sc_mm=float(za_sc * 1e3), za_ac_mm=float(za_ac * 1e3), terms=terms)
    log(f'  girdle {L.side}: kept start {name}, {terms}')
    return dict(clav=C, scap=S, man=man_w, info=info, notch_pts=Mfun(notch), notch_pts_warp=W(notch), se=se0, ae=ae, af=af, acr=acr, ribs=(W(rv), rf))
