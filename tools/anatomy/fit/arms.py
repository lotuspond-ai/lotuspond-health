"""Arms group: clavicles, scapulae, humeri, radii, ulnae and all hand bones (8 carpals, 5 metacarpals, 14 phalanges)
of both sides, from Z-Anatomy (za-skeletal) into each HRA body, whose arms are raised ~30-35 deg in an A-pose with the
hands open and the fingers spread (Z-Anatomy stands in anatomical position: arms at the sides, palms forward).

    python3 fit/arms.py [male|female|all]
    parts: clavicle, scapula, humerus, radius, ulna -> 'skel_arms'; hand bones -> 'skel_hands'

Method (per side; +x is the person's left, sides are matched by position)
  1. Shoulder girdle (fit/arms_girdle.py, cached): the clavicle's sternal end is seated on the clavicular notch of the
     manubrium where the trunk warp puts Z-Anatomy's 'Manubrium_of_sternum' (as the ribcage group places it); clavicle
     and scapula then move as a kinematic chain (clavicle about the SC joint, scapula about the AC joint) so the
     clavicle and the acromion are subcutaneous, both bones are inside the skin, the scapula keeps off the chest wall,
     the glenoid faces the humeral head and the head sits under the deltoid.
  2. Skin arm (fit/arms_skin.py): cross-sections perpendicular to the skin arm's centerline; elbow and wrist found by
     matching Z-Anatomy's arm profile (from its skin regions, with its joints known) to the HRA profile, with a prior
     on the forearm / upper-arm ratio.
  3. Articulated chain: humerus about the glenohumeral centre, forearm about the elbow (flexion about the elbow axis,
     the remaining carrying angle as valgus about the elbow centre), radius pronated about the
     ulna, hand about the wrist (fitted to the skin palm with Z-Anatomy's palm and dorsum skin regions), each finger
     about MCP / PIP / DIP to follow its skin finger's centerline (fit/arms_hand.py segments the skin fingers). Long
     bones change length in the shaft only (articular ends keep their shape and the trunk warp's body scale); a digit
     whose skin finger is shorter or longer than Z-Anatomy's gets phalanges scaled by up to +-12 % and the rest in the
     shafts. Joint spaces are opened to their targets along the chain.
  4. Limb pass (fit/arms_limb.py): humerus (about the shoulder), forearm and hand moved as rigid segments so the
     subcutaneous landmarks (olecranon, epicondyles, styloid processes) lie 1-4 mm under the skin, every other bone
     surface >= 1.6 mm, with the elbow and wrist joints kept articulated.
  5. Final pass (fit/arms_final.py): small rigid corrections of every bone together (joint spaces in their bands in
     both directions, skin clearance, neighbouring bones apart), then a shape-preserving local push-out of any
     overlap Z-Anatomy's own meshes leave between neighbouring carpals / metacarpal bases.
  Distances to the skin and between bones are exact closest-point distances (fit/arms_geom.TriMesh).

Outputs: .cache/fit/<sex>/arms/ (one .npz per bone, manifest.json, report.json, qa-<side>-arm-{front,back,side}.png
and qa-<side>-hand-{palmar,dorsal}.png). report.json: `criteria` = {side: {criterion: {value, threshold, ok}}} for
every acceptance criterion (l = the left arm), `summary` (both sides per criterion), `failing`, `all_ok`, and per side
the full measurements and fit parameters.

Export for other groups: arm_deform(sex, side) -> (f, w), from the saved per-bone maps
(.cache/fit/<sex>/arms/cache/maps-<side>.json):
  f(x)  maps Z-Anatomy-space points (n, 3) of that arm into the body: each point is carried by the rigid(+shaft
        stretch) maps of its k = 4 nearest bones of the limb (clavicle and scapula included), blended with weights
        1 / (d + 1 mm)^4 of its distance to each bone surface in Z-Anatomy space: rigid on and near a bone, smooth across joints
        and through the soft tissue.
  w(x)  in [0, 1], the arm's share against the trunk warp: the same kernel's mass on the limb's bones against its mass
        on the trunk skeleton (ribs 1-8 of that side, sternum, vertebrae C4-T8): 0 at the chest wall and spine, 1 on
        the shoulder girdle and the free limb, smooth in between (axilla, root of the neck). Blend:
        x_body = (1 - w(x)) * get_warp(sex, 'trunk')(x) + w(x) * f(x).
"""
import os, sys, json, time, pickle
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import merge, sample_surface, orient_outward, area  # noqa: E402
from fit.common import get_warp, skin, hra_mesh, write_group, FIT  # noqa: E402
from fit.arms_geom import Aff, TriMesh, unit, rot_axis, rot_between, fit_sphere  # noqa: E402
from fit.arms_za import Limb, load_regions, ARM_BONES, HAND_BONES, ALL_BONES, CHAINS, PHALANGES, CARPALS, NAMES, bone_name, contact  # noqa: E402
from fit.arms_skin import arm_sections, za_sections, match_joints, section_at_s, frame_perp  # noqa: E402
from fit.arms_hand import hand_region, segment_fingers, finger_centerline  # noqa: E402
from fit.arms_chain import BoneMap, Stretch, swing  # noqa: E402
from fit.arms_girdle import fit_girdle, upper_thorax_rigid  # noqa: E402

GROUP = 'arms'
SIDES = ('l', 'r')


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def out_dir(sex):
    d = os.path.join(FIT, sex, GROUP); os.makedirs(d, exist_ok=True); return d


def cache_dir(sex):
    d = os.path.join(out_dir(sex), 'cache'); os.makedirs(d, exist_ok=True); return d


class Ctx:
    """Per-sex inputs: trunk warp, skin (mesh + exact distance), lungs."""

    def __init__(self, sex):
        self.sex = sex
        self.W = get_warp(sex, 'trunk')
        self.s0 = float(self.W.pre.s)
        self.skin = skin(sex)
        # skin distances inside the solvers: nearest of 24 candidate triangles (fast); the measurements are exact
        self.skinT = TriMesh(*self.skin, k=24, sub_r=1.0, exact_within=0.0)
        self._lungsT = None
        sv = self.skin[0]
        self.height = float(sv[:, 1].max() - sv[:, 1].min())
        self.Gu = upper_thorax_rigid(self.W, self.s0)
        self.Rt = self.Gu.A / self.s0  # rotation of the upper thoracic spine (ZA -> HRA)

    @property
    def lungsT(self):
        if self._lungsT is None: self._lungsT = TriMesh(*hra_mesh(self.sex, ('path', r'lung')))
        return self._lungsT


GIRDLE_KEYS = ('clav', 'scap', 'info', 'notch_pts', 'notch_pts_warp', 'se', 'ae', 'af', 'acr')


def girdle_cached(ctx, L, side, log=log):
    """fit_girdle, cached in .cache/fit/<sex>/arms/cache/girdle-<side>.pkl (keyed on the girdle and solver code and the
    trunk warp file; ARMS_REBUILD=1 forces a refit)."""
    import hashlib
    h = hashlib.sha1()
    for fn in ('arms_girdle.py', 'arms_solve.py', 'arms_za.py', 'arms_geom.py'):
        h.update(open(os.path.join(HERE, 'fit', fn), 'rb').read())
    wp = os.path.join(FIT, ctx.sex, 'warp-trunk.npz')
    h.update(str(os.path.getmtime(wp) if os.path.exists(wp) else 0).encode())
    from fit.arms_girdle import ribcage_files
    rf = ribcage_files(ctx.sex, side)
    for fp in rf['ribs'] + [rf['man'], rf['rib1'], rf['cc1']]:   # the rib cage group's final thorax
        h.update(open(fp, 'rb').read())
    key = h.hexdigest()[:16]
    path = os.path.join(cache_dir(ctx.sex), f'girdle-{side}.pkl')
    if os.path.exists(path) and not os.environ.get('ARMS_REBUILD'):
        try:
            d = pickle.load(open(path, 'rb'))
            if d.get('key') == key:
                log(f'  girdle {side}: cached ({path})'); return d['G']
        except Exception as e:  # noqa: BLE001
            log(f'  girdle {side}: cache unreadable ({e}), refitting')
    G = fit_girdle(L, ctx.W, ctx.skinT, ctx.lungsT, ctx.sex, log=log)
    G = {k: G[k] for k in GIRDLE_KEYS}
    pickle.dump(dict(key=key, G=G), open(path, 'wb'))
    return G


# ------------------------------------------------------------------------------------------------ Z-Anatomy profile
_ZA_CACHE = {}


def za_profile(L):
    if L.side in _ZA_CACHE: return _ZA_CACHE[L.side]
    J = L.J
    R = load_regions(L.side)
    rv, rf = merge([(v, f) for v, f, seg in R.values() if seg != 'digits'])
    zs, cum = za_sections(rv, rf, [J['gh'], J['elbow'], J['wrist'], J['mc3>pp3']], L.sg)
    hand_skin = merge([(v, f) for v, f, seg in R.values() if seg == 'hand'])
    out = dict(secs=zs, ze=float(cum[1]), zw=float(cum[2]), regions=R, hand_skin=hand_skin)
    _ZA_CACHE[L.side] = out
    return out


def za_offset(secs, s, p, sg):
    """(anterior, lateral) offset of point p from the Z-Anatomy section centroid at s, relative to the section's
    width and depth."""
    c, d, ext = section_at_s(secs, s)
    ant, lat = frame_perp(d, sg)
    r = p - c
    ap = ext['ant'] + ext['post']; ml = ext['med'] + ext['lat']
    return np.array([(r @ ant) / ap, (r @ lat) / ml])


def hra_point(secs, s, off, sg):
    c, d, ext = section_at_s(secs, s)
    ant, lat = frame_perp(d, sg)
    ap = ext['ant'] + ext['post']; ml = ext['med'] + ext['lat']
    return c + off[0] * ap * ant + off[1] * ml * lat, d


# ------------------------------------------------------------------------------------------------ hand analysis
def analyse_hand(ctx, wrist_c, wrist_d, sg, log=log):
    sv, sf = ctx.skin
    verts = hand_region(sv, sf, wrist_c, wrist_d)
    seg = segment_fingers(sv, sf, verts, wrist_c, wrist_d)
    V = seg['V']; dist = seg['dist']
    fingers = []
    for k, (tp, web) in enumerate(zip(seg['tips'], seg['web'])):
        m = seg['label'] == k
        cl, lev = finger_centerline(V, dist, m, web)
        fingers.append(dict(k=k, tip=V[tp], tip_dist=float(dist[tp]), web=float(web), mask=m, cl=cl, lev=lev, n=int(m.sum())))
    if len(fingers) != 5:
        raise RuntimeError(f'expected 5 skin fingers, found {len(fingers)}')
    # thumb: the finger whose web is deepest (meets the hand earliest); the others ordered by distance from it
    th = min(fingers, key=lambda f: f['web'])
    rest = [f for f in fingers if f is not th]
    base = lambda f: f['cl'][0] if len(f['cl']) else f['tip']
    rest.sort(key=lambda f: np.linalg.norm(base(f) - base(th)))
    digits = {1: th}
    for i, f in enumerate(rest): digits[i + 2] = f
    # palm: hand vertices outside the fingers, beyond the first centimetre
    palm = V[(seg['label'] < 0) & (dist > 0.01)]
    label = -np.ones(len(sv), np.int64)
    for d, f in digits.items(): label[verts[f['mask']]] = d
    log('    skin fingers: ' + ', '.join(f"{d}: {f['tip_dist'] - f['web']:.3f} m beyond web" for d, f in digits.items()))
    return dict(verts=verts, seg=seg, digits=digits, palm=palm, label=label)


def rigid_about(P, Q, c, w=None):
    """Rotation R about the fixed point c minimising sum |R (P - c) + c - Q|^2."""
    w = np.ones(len(P)) if w is None else w
    A = (P - c); B = (Q - c)
    H = (A * w[:, None]).T @ B
    U, _, Vt = np.linalg.svd(H)
    D = np.eye(3); D[2, 2] = np.sign(np.linalg.det(Vt.T @ U.T))
    return Vt.T @ D @ U.T


def icp_about_slide(P, target_pts, c, axis, iters=40, trim=0.8, slide=True, max_slide=0.03):
    """ICP of points P onto target points: rotation about c, plus (optionally) a slide along `axis` (both move c).
    Returns (R, slide distance)."""
    tree = cKDTree(target_pts)
    R = np.eye(3); t = 0.0; a = unit(axis)
    for _ in range(iters):
        cc = c + t * a
        X = (P - c) @ R.T + cc
        d, j = tree.query(X)
        keep = d <= np.quantile(d, trim)
        Q = target_pts[j[keep]]
        if slide:
            t = float(np.clip(t + np.mean((Q - X[keep]) @ a), -max_slide, max_slide)); cc = c + t * a
        R = rigid_about(P[keep] - c + cc, Q, cc)
    return R, t


def icp_about(P, target_pts, c, iters=30, trim=0.8):
    """ICP of points P onto target points with rotation about c only. Returns R."""
    tree = cKDTree(target_pts)
    R = np.eye(3)
    for _ in range(iters):
        X = (P - c) @ R.T + c
        d, j = tree.query(X)
        keep = d <= np.quantile(d, trim)
        R = rigid_about(P[keep], target_pts[j[keep]], c)
        # (P - c) R^T + c vs Q
    return R


# ------------------------------------------------------------------------------------------------ one arm
GAP_TARGET = dict(gh=2.5, hu=1.5, hr=2.0, rs=1.6, finger=1.2, cmc1=1.0)   # joint spaces set in the chain (mm)
TIP_PULP = 0.005           # m: distal phalanx tip to the skin fingertip along the digit (pulp and hyponychium)
OLECRANON_DEPTH = 4.0      # mm: the olecranon is subcutaneous; the elbow may move back up to OLECRANON_MAX_SHIFT
OLECRANON_MAX_SHIFT = 0.012


def _gap(Pa, Tb):
    return float(Tb.signed(Pa).min())


def fit_side(ctx, side, log=log):
    from fit.arms_measure import landmark_zones
    t0 = time.time()
    L = Limb(side); J = L.J; sg = L.sg
    s0 = ctx.s0
    sv, sf = ctx.skin
    maps = {}
    info = dict(side=side)
    # 1. girdle -------------------------------------------------------------------------------------------------
    G = girdle_cached(ctx, L, side, log=log)
    maps['clav'] = BoneMap(G['clav']); maps['scap'] = BoneMap(G['scap'])
    info['girdle'] = G['info']
    GH0 = G['scap'](J['gh'][None])[0]
    # 2. skin arm sections from the glenohumeral centre, elbow and wrist by profile matching ----------------------
    m = sg * sv[:, 0] > 0.28
    tip = sv[m][np.argmax(np.linalg.norm(sv[m] - GH0, axis=1))]
    secs = arm_sections(sv, sf, GH0, tip, sg)
    zp = za_profile(L)
    mj = match_joints(zp['secs'], zp['ze'], zp['zw'], secs)
    info['joints_profile'] = mj
    log(f'  {side}: elbow s={mj["elbow"]:.4f}, wrist s={mj["wrist"]:.4f} (forearm/upper-arm {mj["ratio"]:.3f}, Z-Anatomy {mj["za_ratio"]:.3f}; best-correlation elbow {mj["best_corr"]["elbow"]:.4f} wrist {mj["best_corr"]["wrist"]:.4f})')
    off_e = za_offset(zp['secs'], zp['ze'], J['elbow'], sg)
    off_w = za_offset(zp['secs'], zp['zw'], J['wrist'], sg)
    E_t, d_e = hra_point(secs, mj['elbow'], off_e, sg)
    W_t, d_w = hra_point(secs, mj['wrist'], off_w, sg)
    post = -frame_perp(d_e, sg)[0]
    # articular samples (Z-Anatomy contact regions) for measuring the joint spaces while placing
    def art(a, b, d=0.006): return L.P[a][np.abs(L.T[b].signed(L.P[a])) < d]
    head = art('hum', 'scap', 0.010); notch_u = art('uln', 'hum'); head_r = art('rad', 'hum'); prow = np.concatenate([art('sca', 'rad'), art('lun', 'rad')])
    zones = dict((k, v) for k, v in (z for b in ('uln',) for z in landmark_zones(L)[b]))
    olec = L.P['uln'][zones['olecranon']]
    Tscap = TriMesh(G['scap'](L.M['scap'][0]), L.M['scap'][1], k=10)
    n_g = unit(G['scap'].vec(J['glenoid_n']))
    pa0_za, pa1_za = J['capitulum'], J['ulnar_head']
    pax_za = unit(pa1_za - pa0_za)
    hv, hf = zp['hand_skin']
    Ph0 = sample_surface(hv, hf, 3000, seed=5)
    R0 = ctx.Rt
    # unknowns iterated together: GH distraction, elbow shift (olecranon), pronation, wrist slide, forearm distraction,
    # radius shift relative to the ulna, wrist distraction
    gh_d = 0.0; e_sh = 0.0; phi = 0.0; W_goal = W_t.copy(); f_d = 0.0; r_d = 0.0; w_d = 0.0
    H = None
    for it in range(6):
        Rp_za = Aff.about(rot_axis(pax_za, phi), pa0_za)
        GH = GH0 + n_g * gh_d
        E_goal = E_t + post * e_sh
        # 3. humerus: carried by the upper thorax (neutral rotation, palms forward in both bodies), swung about the GH
        #    centre onto GH -> elbow, shaft stretched to length
        d_h = J['elbow'] - J['gh']; Lh = np.linalg.norm(d_h)
        Dh = unit(E_goal - GH); tgt0 = unit(W_goal - E_goal)
        Rsw0 = swing(R0 @ d_h, Dh) @ R0
        # humeral rotation (within +-12 deg of neutral) that lets the elbow's hinge come closest to the skin forearm
        # (Z-Anatomy's forearm has almost no carrying angle; the HRA skin's has ~11 deg)
        alpha = np.arccos(np.clip(unit(Rp_za(J['wrist'][None])[0] - J['elbow']) @ unit(J['elbow_axis']), -1, 1))
        th_best, err_best = 0.0, None
        for th in np.radians(np.arange(-12, 12.5, 0.5)):
            axh = rot_axis(Dh, th) @ Rsw0 @ unit(J['elbow_axis'])
            err = abs(np.arccos(np.clip(axh @ tgt0, -1, 1)) - alpha) + 0.02 * abs(th)
            if err_best is None or err < err_best: th_best, err_best = th, err
        Rh = rot_axis(Dh, th_best) @ Rsw0
        Ah = Aff(s0 * Rh, GH - s0 * Rh @ J['gh'])
        dLh = (np.linalg.norm(E_goal - GH) - s0 * Lh) / s0
        st_h = Stretch(J['gh'], J['elbow'], dLh)
        m_hum = BoneMap(Ah, st_h)
        E = m_hum(J['elbow'][None])[0]
        # 4. forearm: carried by the humerus; the radius pronated about the ulna (ZA space) with the hand; flexed about
        #    the elbow axis onto the skin forearm (the rest of the angle is the carrying-angle difference, as valgus);
        #    distracted at the elbow, the radius slid along the ulna, stretched so the wrist lands on W_goal
        Af0 = Aff(np.eye(3), st_h.end_shift()).then(Ah)
        Rp = Rp_za
        Jw = Rp(J['wrist'][None])[0]
        d_f = Jw - J['elbow']
        ax = unit(Af0.vec(J['elbow_axis']))
        cur = unit(Af0.vec(d_f)); tgt = unit(W_goal - E)
        cur_p = unit(cur - (cur @ ax) * ax); tgt_p = unit(tgt - (tgt @ ax) * ax)
        flex = np.arctan2(np.cross(cur_p, tgt_p) @ ax, cur_p @ tgt_p)
        Rflex = rot_axis(ax, flex); cur2 = Rflex @ cur
        Rval = swing(cur2, tgt)
        # the hinge first (about the elbow centre), then the remaining carrying angle, also about the elbow centre
        # (midway between the capitulum and trochlea centres): a valgus closes the lateral (radiocapitellar) compartment
        # and opens the medial one, so pivoting there shares it between the two instead of driving the radial head
        # into the capitulum (as a pivot on the medial edge of the humero-ulnar joint would)
        Af = Af0.then(Aff.about(Rval @ Rflex, E))
        A_ul = Af.then(Aff(np.eye(3), f_d * tgt)); A_ra = Af.then(Aff(np.eye(3), (f_d - r_d) * tgt))
        kk = unit(d_f) @ pax_za
        dLf = ((np.linalg.norm(W_goal - E) - (f_d - r_d) - w_d) / s0 - np.linalg.norm(d_f)) / max(kk, 0.5)
        stf = Stretch(pa0_za, pa1_za, dLf)
        m_uln = BoneMap(A_ul, stf); m_rad = _PreRot(Rp, stf, A_ra)
        # 5. hand: carried by the radius (with the wrist distraction), fitted to the skin palm with Z-Anatomy's palm
        #    and dorsum skin regions: rotation about the wrist (its twist about the forearm is pronation, done by the
        #    radius next round) and a slide along the forearm (the forearm's length)
        Ahd = Rp.then(Aff(np.eye(3), stf.end_shift())).then(A_ra).then(Aff(np.eye(3), w_d * tgt))
        Wc = Ahd(J['wrist'][None])[0]
        if H is None: H = analyse_hand(ctx, Wc, tgt, sg, log=log)
        Rw, slide = icp_about_slide(Ahd(Ph0), H['palm'], Wc, tgt, slide=it < 4)
        pax = unit(m_uln(pa1_za[None])[0] - m_uln(pa0_za[None])[0])
        q = _quat(Rw); v = q[1:]; proj = (v @ pax) * pax
        tw = np.r_[q[0], proj]; tw = tw / max(np.linalg.norm(tw), 1e-12)
        dphi = 2 * np.arctan2(np.linalg.norm(tw[1:]) * np.sign(tw[1:] @ pax), tw[0])
        Rsw = Rw @ rot_axis(pax, dphi).T
        # joint spaces and the olecranon's depth in this placement
        Thum = TriMesh(m_hum(L.M['hum'][0]), L.M['hum'][1], k=10)
        Trad = TriMesh(m_rad(L.M['rad'][0]), L.M['rad'][1], k=10)
        Ahand_try = Ahd.then(Aff.about(Rsw, Wc))
        g_gh = _gap(m_hum(head), Tscap) * 1e3
        g_hu = _gap(m_uln(notch_u), Thum) * 1e3; g_hr = _gap(m_rad(head_r), Thum) * 1e3
        g_rs = _gap(Ahand_try(prow), Trad) * 1e3
        c_ol = float(-ctx.skinT.signed(m_uln(olec)).max() * 1e3)
        log(f'    round {it}: GH {g_gh:.2f} HU {g_hu:.2f} HR {g_hr:.2f} RC {g_rs:.2f} mm, olecranon {c_ol:.1f} mm deep, pronation {np.degrees(phi):.1f}+{np.degrees(dphi):.1f} deg, slide {slide * 1e3:.1f} mm')
        done = (abs(dphi) < np.radians(0.3) and abs(slide) < 3e-4 and abs(g_gh - GAP_TARGET['gh']) < 0.15 and abs(g_hu - GAP_TARGET['hu']) < 0.15
                and abs(g_hr - GAP_TARGET['hr']) < 0.2 and abs(g_rs - GAP_TARGET['rs']) < 0.15)
        if it == 5 or done: break
        phi += dphi; W_goal = W_goal + slide * tgt
        gh_d += (GAP_TARGET['gh'] - g_gh) * 1e-3
        f_new = float(np.clip(f_d + (GAP_TARGET['hu'] - g_hu) * 1e-3, -0.001, 0.0025)); df = f_new - f_d; f_d = f_new
        r_d = float(np.clip(r_d + (g_hr * 1e-3 + df) - GAP_TARGET['hr'] * 1e-3, -0.004, 0.004))
        w_d = float(np.clip(w_d + (GAP_TARGET['rs'] - g_rs) * 1e-3, -0.002, 0.003))
        e_sh = float(np.clip(e_sh + (c_ol - OLECRANON_DEPTH) * 1e-3, 0.0, OLECRANON_MAX_SHIFT))
    maps['hum'] = m_hum; maps['uln'] = m_uln; maps['rad'] = m_rad
    Ahand = Ahand_try
    for b in CARPALS + [f'mc{i}' for i in range(1, 6)]: maps[b] = BoneMap(Ahand)
    info.update(humeral_rotation_deg=float(np.degrees(th_best)), pronation_deg=float(np.degrees(phi)), wrist_swing_deg=float(np.degrees(np.arccos(np.clip((np.trace(Rsw) - 1) / 2, -1, 1)))),
                elbow_flex_deg=float(np.degrees(flex)), elbow_valgus_adjust_deg=float(np.degrees(np.arccos(np.clip(cur2 @ tgt, -1, 1)))),
                wrist_slide_mm=float(np.linalg.norm(W_goal - W_t) * 1e3), elbow_back_shift_mm=float(e_sh * 1e3),
                gh_distraction_mm=float(gh_d * 1e3), elbow_distraction_mm=float(f_d * 1e3), radius_shift_proximal_mm=float(r_d * 1e3),
                wrist_distraction_mm=float(w_d * 1e3), humerus_stretch_mm=float(dLh * s0 * 1e3), forearm_stretch_mm=float(dLf * s0 * 1e3),
                gaps_after_chain_mm=dict(gh=g_gh, hu=g_hu, hr=g_hr, radiocarpal=g_rs), olecranon_depth_mm=c_ol)
    log(f'  {side}: humeral rotation {info["humeral_rotation_deg"]:.1f} deg, elbow flexion {info["elbow_flex_deg"]:.1f} deg (valgus {info["elbow_valgus_adjust_deg"]:.1f}), pronation {info["pronation_deg"]:.1f}, wrist swing {info["wrist_swing_deg"]:.1f} deg; '
        f'humerus {info["humerus_stretch_mm"]:+.1f} mm, forearm {info["forearm_stretch_mm"]:+.1f} mm, elbow back {info["elbow_back_shift_mm"]:.1f} mm, radius up {info["radius_shift_proximal_mm"]:.1f} mm')
    # 6. fingers -----------------------------------------------------------------------------------------------------
    fit_fingers(L, maps, Ahand, H, ctx, info, log=log)
    info['time_s'] = round(time.time() - t0, 1)
    return dict(L=L, maps=maps, info=info, girdle=G, secs=secs, hand=H, targets=dict(GH=GH, E=E_goal, W=W_goal))


class _PreRot(BoneMap):
    """Bone map with a Z-Anatomy-space rigid motion first (the radius's pronation about the ulna), then the stretch
    and the affine."""

    def __init__(self, pre, stretch, aff):
        super().__init__(aff, stretch); self.pre = pre

    def __call__(self, x):
        y = self.pre(np.asarray(x, float))
        if self.stretch is not None: y = self.stretch(y)
        return self.aff(y)

    def then(self, aff2):
        return _PreRot(self.pre, self.stretch, self.aff.then(aff2))

    def to_dict(self):
        d = super().to_dict(); d['pre'] = self.pre.to_dict(); return d


def _quat(R):
    t = np.trace(R)
    if t > 0:
        s = np.sqrt(t + 1.0) * 2; w = 0.25 * s
        x = (R[2, 1] - R[1, 2]) / s; y = (R[0, 2] - R[2, 0]) / s; z = (R[1, 0] - R[0, 1]) / s
    else:
        i = int(np.argmax(np.diag(R)))
        if i == 0:
            s = np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2; w = (R[2, 1] - R[1, 2]) / s; x = 0.25 * s; y = (R[0, 1] + R[1, 0]) / s; z = (R[0, 2] + R[2, 0]) / s
        elif i == 1:
            s = np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2; w = (R[0, 2] - R[2, 0]) / s; x = (R[0, 1] + R[1, 0]) / s; y = 0.25 * s; z = (R[1, 2] + R[2, 1]) / s
        else:
            s = np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2; w = (R[1, 0] - R[0, 1]) / s; x = (R[0, 2] + R[2, 0]) / s; y = (R[1, 2] + R[2, 1]) / s; z = 0.25 * s
    q = np.array([w, x, y, z]); return q / np.linalg.norm(q)


# ------------------------------------------------------------------------------------------------ fingers
def polyline_point_at(P, dist_from, start):
    """The point at Euclidean distance `dist_from` from `start`, going forward along polyline P from the point of P
    nearest to `start` (beyond the end, along the last segment's direction)."""
    # nearest point of P to start (segment index and parameter)
    best = (np.inf, 0, 0.0)
    for i, (a, b) in enumerate(zip(P[:-1], P[1:])):
        u = b - a; t = float(np.clip((start - a) @ u / max(u @ u, 1e-18), 0, 1))
        d = np.linalg.norm(a + t * u - start)
        if d < best[0]: best = (d, i, t)
    _, i0, t0 = best
    pts = [P[i0] + t0 * (P[i0 + 1] - P[i0])] + list(P[i0 + 1:])
    for a, b in zip(pts[:-1], pts[1:]):
        if np.linalg.norm(b - a) < 1e-9: continue
        if np.linalg.norm(b - start) >= dist_from:
            u = b - a; w0 = a - start
            A = u @ u; B = 2 * u @ w0; C = w0 @ w0 - dist_from ** 2
            t = (-B + np.sqrt(max(B * B - 4 * A * C, 0))) / (2 * A)
            return a + np.clip(t, 0, 1) * u
    u = unit(P[-1] - P[-2]); w0 = P[-1] - start
    B = 2 * u @ w0; C = w0 @ w0 - dist_from ** 2
    t = (-B + np.sqrt(max(B * B - 4 * C, 0))) / 2
    return P[-1] + t * u


def fit_fingers(L, maps, Ahand, H, ctx, info, log=log):
    """Each digit's chain follows its skin finger. The centerline (web -> tip) is extended proximally in a straight
    line; the chain's joint centres are placed on it at the bones' lengths plus the joint spaces (Z-Anatomy's finger
    joints overlap by up to 1.2 mm, they are opened to GAP_TARGET['finger']), with the distal phalanx's tip kept a
    pulp's thickness short of the skin fingertip. Each bone turns about its proximal joint without axial twist
    (relative to its parent). A digit shorter or longer than Z-Anatomy's (scale k) gets smaller or larger phalanges
    (isotropic scale k clipped to 0.88-1.12, keeping the joints congruent) and the rest of k in the shafts."""
    J = L.J; s0 = ctx.s0
    info['fingers'] = {}
    for dg, chain in CHAINS.items():
        f = H['digits'][dg]
        cl = f['cl']
        if len(cl) < 3: raise RuntimeError(f'digit {dg}: skin centerline too short')
        d0 = unit(cl[min(3, len(cl) - 1)] - cl[0])
        ext = np.array([cl[0] - d0 * k * 0.004 for k in range(14, 0, -1)])
        path = np.concatenate([ext, cl])
        tipv = f['tip']; dtip = unit(cl[-1] - cl[-3])
        tip_t = tipv - dtip * TIP_PULP
        movers = chain[1:] if dg > 1 else chain   # thumb: the metacarpal moves too (carpometacarpal joint)
        if dg == 1:
            za_pts = [J['cmc1'], J['mc1>pp1'], J['pp1>dp1'], J['dp1_tip']]
            g_za = [float(min(L.T['tpm'].signed(L.P['mc1']).min(), L.T['mc1'].signed(L.P['tpm']).min()) * 1e3),
                    L.gaps[('mc1', 'pp1')] * 1e3, L.gaps[('pp1', 'dp1')] * 1e3]
            gaps = [GAP_TARGET['cmc1'] - g_za[0]] + [GAP_TARGET['finger'] - g for g in g_za[1:]]
            piv = Ahand(J['cmc1'][None])[0]
        else:
            za_pts = [J[f'{a}>{b}'] for a, b in zip(chain[:-1], chain[1:])] + [J[f'{chain[-1]}_tip']]
            gaps = [GAP_TARGET['finger'] - L.gaps[(a, b)] * 1e3 for a, b in zip(chain[:-1], chain[1:])]
            piv = maps[chain[0]](za_pts[0][None])[0]
        gaps = np.maximum(np.array(gaps), 0.0) * 1e-3          # opening along the chain at each joint (m)
        za_len = np.array([np.linalg.norm(b - a) for a, b in zip(za_pts[:-1], za_pts[1:])]) * s0

        def place(k):
            starts, ends = [], []
            cur = piv
            for Lseg, g in zip(za_len * k, gaps):
                # the joint space opens along the bone's own direction: the bone starts g beyond the previous joint
                en = polyline_point_at(path, Lseg + g, cur)
                st = cur + g * unit(en - cur)
                starts.append(st); ends.append(en); cur = en
            return starts, ends
        lo, hi = 0.7, 1.4
        for _ in range(40):
            k = 0.5 * (lo + hi)
            _, ends = place(k)
            if (ends[-1] - tip_t) @ dtip > 0: hi = k
            else: lo = k
        k = 0.5 * (lo + hi); starts, ends = place(k)
        s_iso = float(np.clip(k, 0.88, 1.12))
        info['fingers'][dg] = dict(length_scale=float(k), iso_scale=s_iso, tip_err_mm=float(np.linalg.norm(ends[-1] - tip_t) * 1e3),
                                   joint_opening_mm=[round(g * 1e3, 2) for g in gaps], tip_target=tip_t.tolist())
        prev = maps[chain[0]] if dg > 1 else BoneMap(Ahand)
        for i, b in enumerate(movers):
            p_za, q_za = za_pts[i], za_pts[i + 1]
            A0 = prev.aff if prev.stretch is None else Aff(np.eye(3), prev.stretch.end_shift()).then(prev.aff)
            Rpar = A0.A / np.cbrt(np.linalg.det(A0.A))
            R = swing(Rpar @ (q_za - p_za), ends[i] - starts[i]) @ Rpar
            A = s0 * s_iso * R
            aff = Aff(A, starts[i] - A @ p_za)
            dL = np.linalg.norm(q_za - p_za) * (k / s_iso - 1.0)
            maps[b] = BoneMap(aff, Stretch(p_za, q_za, dL, zone=(0.2, 0.35, 0.65, 0.8)))
            prev = maps[b]
        log(f'    digit {dg}: length scale {k:.3f} (bones x{s_iso:.3f}), tip error {info["fingers"][dg]["tip_err_mm"]:.1f} mm, joints opened {np.round(gaps * 1e3, 1).tolist()} mm')


# ------------------------------------------------------------------------------------------------ outputs
def bone_meshes(L, maps):
    out = {}
    for b in ALL_BONES:
        v, f = L.M[b]
        vv = maps[b](v)
        out[b] = (vv, orient_outward(vv, f))
    return out


DIGIT_COL = {1: '#e8c27a', 2: '#d9e87a', 3: '#7ae8c2', 4: '#7ab8e8', 5: '#c27ae8'}


def bone_colour(b):
    if b in ARM_BONES: return '#efe6d2'
    if b in CARPALS: return '#d8c8a0'
    return DIGIT_COL[int(b[-1])]


def render_qa(ctx, side, r, odir):
    from lib.qa import render_views
    sv, sf = ctx.skin
    meshes = r['meshes']; L = r['L']; J = L.J; sg = L.sg
    items = [dict(mesh=(sv, sf), color='#d9b59a', opacity=0.22)]
    items += [dict(mesh=meshes[b], color=bone_colour(b)) for b in ALL_BONES]
    GH = r['targets']['GH']; Wt = r['targets']['W']
    tips = np.array([f['tip'] for f in r['hand']['digits'].values()])
    c_arm = 0.5 * (meshes['clav'][0].mean(0) + tips.mean(0))
    rad = 0.5 * np.linalg.norm(tips.mean(0) - meshes['clav'][0].mean(0)) + 0.08
    cams = {f'{side}-arm-front': dict(dir=(0, 0.02, 1), target=c_arm, radius=rad), f'{side}-arm-back': dict(dir=(0, 0.02, -1), target=c_arm, radius=rad),
            f'{side}-arm-side': dict(dir=(sg, 0.02, 0.001), target=c_arm, radius=rad)}
    # hand: palm normal and long axis from the hand's map
    Ah = r['maps']['cap']
    o, R = L.hand_frame()
    n = unit(Ah.aff.vec(R[:, 2])); e1 = unit(Ah.aff.vec(R[:, 0]))
    hp = np.concatenate([meshes[b][0] for b in ALL_BONES if b not in ARM_BONES] + [tips])
    lo_, hi_ = hp.min(0), hp.max(0); hc = 0.5 * (lo_ + hi_); hr = 0.5 * np.linalg.norm(hi_ - lo_) + 0.015
    cams[f'{side}-hand-palmar'] = dict(dir=tuple(n), up=tuple(-e1), target=hc, radius=hr)
    cams[f'{side}-hand-dorsal'] = dict(dir=tuple(-n), up=tuple(-e1), target=hc, radius=hr)
    return render_views(items, cams, os.path.join(odir, 'qa'), size=(900, 900))


def save_maps(sex, side, r):
    """The per-bone maps, each taking raw Z-Anatomy coordinates: the hand bones' maps were fitted on the hand seated on
    the radius (Limb.seat, a Z-Anatomy-space translation), which is folded in here as a pre-translation."""
    d = cache_dir(sex)
    seat = Aff(np.eye(3), np.asarray(r['L'].seat, float))
    out = {}
    for b, m in r['maps'].items():
        if b in HAND_BONES: m = _PreRot(seat, m.stretch, m.aff)
        out[b] = m.to_dict()
    data = dict(side=side, seat_mm=(np.asarray(r['L'].seat) * 1e3).tolist(), maps=out)
    json.dump(data, open(os.path.join(d, f'maps-{side}.json'), 'w'))


def load_maps(sex, side):
    from fit.arms_geom import Aff
    data = json.load(open(os.path.join(cache_dir(sex), f'maps-{side}.json')))
    out = {}
    for b, d in data['maps'].items():
        m = BoneMap.from_dict(d)
        if 'pre' in d: m = _PreRot(Aff(np.array(d['pre']['A']), np.array(d['pre']['t'])), m.stretch, m.aff)
        out[b] = m
    return out


NOTES = (
    'Z-Anatomy has no sesamoid bones of the hand (only of the foot), so none are placed.',
    'criteria: {side: {name: {value, threshold, ok}}}, l = the left arm (+x), r = the right arm; lengths in mm unless named otherwise.',
)


def run(sex):
    from fit.arms_final import finalize, residual_pushout
    from fit.arms_limb import limb_pass
    from fit.arms_measure import measure_side, criteria
    t0 = time.time()
    log(f'== arms {sex}')
    ctx = Ctx(sex)
    res = {}; rep_sides = {}
    for side in SIDES:
        r = fit_side(ctx, side)
        tips = {dg: np.array(f['tip_target']) for dg, f in r['info']['fingers'].items()}
        corr_l, lim = limb_pass(r['L'], r['maps'], ctx.skinT, log=log, tips=tips)
        for b, A in corr_l.items(): r['maps'][b] = r['maps'][b].then(A)
        r['info']['limb_pass'] = lim
        corr, fin = finalize(r['L'], r['maps'], ctx.skinT, log=log, tips=tips)
        for b in ALL_BONES: r['maps'][b] = r['maps'][b].then(corr[b])
        r['info']['final_pass'] = fin
        r['meshes'] = bone_meshes(r['L'], r['maps'])
        disp, po = residual_pushout(r['L'], r['maps'], r['meshes'], log=log)
        for b, D in disp.items(): r['meshes'][b] = (r['meshes'][b][0] + D, r['meshes'][b][1])
        r['info']['pushout_mm'] = po
        meas = measure_side(r['L'], r['maps'], r['meshes'], ctx.skinT, ctx.height, finger_label=r['hand']['label'], skin_v=ctx.skin[0], girdle=r['girdle'],
                            disp=disp, log=log)
        r['measure'] = meas
        rep_sides[side] = dict(measurements=meas, fit=r['info'])
        save_maps(sex, side, r)
        res[side] = r
        log(f'  {side} done ({time.time() - t0:.0f} s)')
    outputs = []
    for side in SIDES:
        r = res[side]
        for b in ALL_BONES:
            part = 'skel_arms' if b in ARM_BONES else 'skel_hands'
            outputs.append(dict(name=bone_name(b, side), part=part, mesh=r['meshes'][b], source=[bone_name(b, side)]))
    crit = {side: criteria(res[side]['measure']) for side in SIDES}
    summary = {k: dict(threshold=crit['l'][k]['threshold'], **{side: dict(value=crit[side][k]['value'], ok=crit[side][k]['ok']) for side in SIDES if k in crit[side]})
               for k in crit['l']}
    failing = [f'{k} ({side}: {crit[side][k]["value"]})' for k in crit['l'] for side in SIDES if k in crit[side] and not crit[side][k]['ok']]
    notes = list(NOTES)
    for side in SIDES:
        el = {k: crit[side][f'landmark_{k}_mm']['value'] for k in ('olecranon', 'medial_epicondyle', 'lateral_epicondyle')}
        if all(v > 5.0 for v in el.values()):
            notes.append(f'{side}: all three elbow landmarks lie deeper than 5 mm ({el} mm): the skin elbow is wider and deeper than the '
                         'bone plus 5 mm on every side, so the limb pass shares the excess between them (olecranon weighted double); '
                         'meeting the bound would need a distal humerus enlarged beyond the body scale, which is not done.')
    for side in SIDES:
        fs = res[side]['info']['fingers']
        short = {d: round(f['length_scale'], 3) for d, f in fs.items() if f['length_scale'] < 0.88}
        if short:
            notes.append(f'{side}: skin digits shorter than Z-Anatomy scaled to the body (length scale {short}): phalanges scaled by 0.88 '
                         'and the rest taken up in their shafts so each digit fits its skin finger.')
    report = dict(sex=sex, height_m=ctx.height, body_scale=ctx.s0, all_ok=not failing, failing=failing, criteria=crit, summary=summary,
                  sides=rep_sides, notes=notes)
    d = write_group(sex, GROUP, outputs, _jsonable(report))
    log('  failing: ' + ('; '.join(failing) if failing else 'none'))
    for side in SIDES:
        render_qa(ctx, side, res[side], d)
    log(f'== arms {sex} done in {time.time() - t0:.0f} s')
    return ctx, res


def _jsonable(x):
    if isinstance(x, dict): return {str(k): _jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)): return [_jsonable(v) for v in x]
    if isinstance(x, (np.floating,)): return float(x)
    if isinstance(x, (np.integer,)): return int(x)
    if isinstance(x, (np.bool_,)): return bool(x)
    if isinstance(x, np.ndarray): return x.tolist()
    return x


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    for sex in (('male', 'female') if which == 'all' else (which,)):
        run(sex)


# ------------------------------------------------------------------------------------------------ export for other groups
_DEFORM = {}


def _za_points(name, spacing=0.0007):
    """Dense surface points of a Z-Anatomy bone (vertices plus samples about `spacing` apart)."""
    from lib.mesh import source, dense_points
    v, f = source('za-skeletal').get(name)
    return dense_points(v, f, spacing)


def arm_deform(sex, side, k=4, p=4.0, eps=0.001):
    """(f, w) for one arm of one body, from the saved fit (.cache/fit/<sex>/arms/cache/maps-<side>.json).

    f(x): Z-Anatomy points (n, 3) of that arm -> body coordinates. Each point is carried by the maps of its k nearest
          bones of the limb (clavicle and scapula included), blended with weights 1 / (d + eps)^p of its distance d to
          each bone's surface in Z-Anatomy space (dense surface points, ~0.4 mm accuracy): rigid on and near a bone,
          smooth across joints and through the soft tissue.
    w(x): the arm's share against the trunk warp, in [0, 1]: the same kernel's mass on the limb's bones against its
          mass on the trunk skeleton (ribs 1-8 of that side, sternum, vertebrae C4-T8), so it is 0 at the chest wall
          and spine, 1 on the shoulder girdle and the free limb, and smooth in between (axilla, root of the neck).
    Blend for vessels and nerves: x_body = (1 - w(x)) * get_warp(sex, 'trunk')(x) + w(x) * f(x)."""
    key = (sex, side, k, p, eps)
    if key in _DEFORM: return _DEFORM[key]
    maps = load_maps(sex, side)
    bones = [b for b in ALL_BONES if b in maps]
    trees = {b: cKDTree(_za_points(bone_name(b, side))) for b in bones}
    trunk_names = [f'{o}_rib{side}' for o in ('First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth')]
    trunk_names += ['Manubrium_of_sternum', 'Body_of_sternum'] + [f'Vertebra_C{i}' for i in range(4, 8)] + [f'Vertebra_T{i}' for i in range(1, 9)]
    from lib.mesh import source
    s = source('za-skeletal')
    tp = np.concatenate([_za_points(n, spacing=0.003) for n in trunk_names if n in s.by_name])
    ttree = cKDTree(tp)

    def _dists(x):
        x = np.atleast_2d(np.asarray(x, float))
        D = np.stack([trees[b].query(x)[0] for b in bones], 1)
        return x, D

    def f(x):
        x, D = _dists(x)
        kk = min(k, len(bones))
        idx = np.argsort(D, axis=1)[:, :kk]
        Wt = (np.take_along_axis(D, idx, 1) + eps) ** -p
        Wt /= Wt.sum(1, keepdims=True)
        out = np.zeros_like(x)
        for j, b in enumerate(bones):
            m = (idx == j)
            rows = m.any(1)
            if not rows.any(): continue
            wj = (Wt * m).sum(1)[rows]
            out[rows] += wj[:, None] * maps[b](x[rows])
        return out

    def w(x):
        x, D = _dists(x)
        a = ((D + eps) ** -p).sum(1)
        t = (ttree.query(x)[0] + eps) ** -p
        return a / (a + t)

    _DEFORM[key] = (f, w)
    return f, w
