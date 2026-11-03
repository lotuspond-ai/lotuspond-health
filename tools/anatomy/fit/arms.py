"""Arms group: clavicles, scapulae, humeri, radii, ulnae and all hand bones of both sides, from Z-Anatomy
(za-skeletal) into each HRA body (whose arms are raised ~30 deg in an A-pose, hands open, fingers spread).

    python3 fit/arms.py [male|female|all]

Method (per side)
  1. Shoulder girdle (fit/arms_girdle.py): the clavicle's sternal end is seated on the clavicular notch of the
     trunk-warped manubrium; clavicle and scapula then move as a kinematic chain (clavicle about the SC joint, scapula
     about the AC joint) so the lateral clavicle and the acromion are subcutaneous, both bones are inside the skin,
     the scapula keeps off the chest wall and the humeral head sits under the deltoid.
  2. Skin arm (fit/arms_skin.py): cross-sections perpendicular to the skin arm's centerline; elbow and wrist found by
     matching Z-Anatomy's arm profile (from its skin regions, with its joints known) to the HRA profile, with a prior
     on the forearm / upper-arm ratio.
  3. Articulated chain (fit/arms_chain.py): humerus about the glenohumeral centre, forearm about the elbow (flexion
     about the elbow axis, the rest reported as valgus), radius pronated about the ulna, hand about the wrist (fitted to
     the skin's palm with Z-Anatomy's palm and dorsum skin regions), each finger about MCP / PIP / DIP to follow its
     skin finger's centerline (fit/arms_hand.py segments the skin fingers). Long bones change length in the shaft
     only (articular ends keep their shape), all bones keep the body scale of the trunk warp.
  4. Joint spaces set (glenohumeral, elbow, wrist, MCP / PIP / DIP) and a final rigid push-out pass keeps every bone
     inside the skin with its clearance target and off its neighbours.
Exports arm_deform(sex, side) -> (f, w): f maps Z-Anatomy points of that arm into the body (bone-weighted blend of
the per-bone maps), w(x) in [0, 1] is the arm's share against the trunk warp (0 in the trunk, 1 from the shoulder
joint outwards).
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
        self.skinT = TriMesh(*self.skin)
        self.lungsT = TriMesh(*hra_mesh(sex, ('path', r'lung')))
        sv = self.skin[0]
        self.height = float(sv[:, 1].max() - sv[:, 1].min())
        self.Gu = upper_thorax_rigid(self.W, self.s0)
        self.Rt = self.Gu.A / self.s0  # rotation of the upper thoracic spine (ZA -> HRA)


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
def fit_side(ctx, side, log=log):
    sex = ctx.sex
    t0 = time.time()
    L = Limb(side); J = L.J; sg = L.sg
    s0 = ctx.s0
    sv, sf = ctx.skin
    maps = {}
    info = dict(side=side)
    # 1. girdle -------------------------------------------------------------------------------------------------
    G = fit_girdle(L, ctx.W, ctx.skinT, ctx.lungsT, log=log)
    maps['clav'] = BoneMap(G['clav']); maps['scap'] = BoneMap(G['scap'])
    info['girdle'] = G['info']
    GH = G['scap'](J['gh'][None])[0]
    # 2. skin arm sections from the glenohumeral centre, elbow and wrist by profile matching ----------------------
    m = sg * sv[:, 0] > 0.28
    tip = sv[m][np.argmax(np.linalg.norm(sv[m] - GH, axis=1))]
    secs = arm_sections(sv, sf, GH, tip, sg)
    zp = za_profile(L)
    mj = match_joints(zp['secs'], zp['ze'], zp['zw'], secs)
    info['joints_profile'] = mj
    log(f'  {side}: elbow s={mj["elbow"]:.4f}, wrist s={mj["wrist"]:.4f} (forearm/upper-arm {mj["ratio"]:.3f}, Z-Anatomy {mj["za_ratio"]:.3f}; best-correlation elbow {mj["best_corr"]["elbow"]:.4f} wrist {mj["best_corr"]["wrist"]:.4f})')
    off_e = za_offset(zp['secs'], zp['ze'], J['elbow'], sg)
    off_w = za_offset(zp['secs'], zp['zw'], J['wrist'], sg)
    E_t, d_e = hra_point(secs, mj['elbow'], off_e, sg)
    W_t, d_w = hra_point(secs, mj['wrist'], off_w, sg)
    # 3. humerus: carried by the upper thorax (neutral rotation, as in Z-Anatomy's anatomical position: palms
    #    forward in both bodies) and swung about the glenohumeral centre onto GH -> elbow; shaft stretched to length.
    d_h = J['elbow'] - J['gh']; Lh = np.linalg.norm(d_h)
    R0 = ctx.Rt
    Dh = unit(E_t - GH); tgt = unit(W_t - E_t)
    Rh = swing(R0 @ d_h, Dh) @ R0
    Ah = Aff(s0 * Rh, GH - s0 * Rh @ J['gh'])
    dLh = (np.linalg.norm(E_t - GH) - s0 * Lh) / s0
    maps['hum'] = BoneMap(Ah, Stretch(J['gh'], J['elbow'], dLh))
    E = maps['hum'](J['elbow'][None])[0]
    sh_h = Stretch(J['gh'], J['elbow'], dLh).end_shift()
    Af0 = Aff(np.eye(3), sh_h).then(Ah)          # forearm carried by the humerus (Z-Anatomy elbow relation)
    # 4-5. forearm and hand. The radius turns about the ulna (pronation axis: radial head centre -> ulnar head
    #    centre) together with the hand; the pronation angle comes from fitting Z-Anatomy's palm and dorsum skin to the
    #    skin palm, so it is iterated with the elbow (flexion about the elbow axis onto the skin forearm's axis; any
    #    residual is the carrying-angle difference, reported as valgus) and the forearm length (the hand fit also
    #    slides the wrist along the forearm).
    pa0_za, pa1_za = J['capitulum'], J['ulnar_head']
    pax_za = unit(pa1_za - pa0_za)
    hv, hf = zp['hand_skin']
    Ph0 = sample_surface(hv, hf, 3000, seed=5)
    phi = 0.0; slide_total = 0.0; H = None
    W_goal = W_t.copy()
    for it in range(4):
        Rp = Aff.about(rot_axis(pax_za, phi), pa0_za)          # pronation in Z-Anatomy space (radius + hand)
        Jw = Rp(J['wrist'][None])[0]
        d_f = Jw - J['elbow']
        ax = unit(Af0.vec(J['elbow_axis']))
        cur = unit(Af0.vec(d_f)); tgt = unit(W_goal - E)
        cur_p = unit(cur - (cur @ ax) * ax); tgt_p = unit(tgt - (tgt @ ax) * ax)
        flex = np.arctan2(np.cross(cur_p, tgt_p) @ ax, cur_p @ tgt_p)
        Rflex = rot_axis(ax, flex); cur2 = Rflex @ cur
        Rval = swing(cur2, tgt)
        Af = Af0.then(Aff.about(Rval @ Rflex, E))
        # forearm length: both bones stretched along the pronation axis (keeps the distal radio-ulnar joint)
        k = unit(d_f) @ pax_za
        dLf = (np.linalg.norm(W_goal - E) / s0 - np.linalg.norm(d_f)) / max(k, 0.5)
        stf = Stretch(pa0_za, pa1_za, dLf)
        m_uln = BoneMap(Af, stf)
        m_rad = BoneMap(Af, stf)                               # radius: pronation first (below), then stretch + Af
        Ahd = Rp.then(Aff(np.eye(3), stf.end_shift())).then(Af)   # hand bones: pronated, shifted with the forearm, carried
        Wc = Ahd(J['wrist'][None])[0]
        if H is None: H = analyse_hand(ctx, Wc, tgt, sg, log=log)
        Rw, slide = icp_about_slide(Ahd(Ph0), H['palm'], Wc, tgt, slide=it < 2)
        pax = unit(m_uln(pa1_za[None])[0] - m_uln(pa0_za[None])[0])
        q = _quat(Rw); v = q[1:]; proj = (v @ pax) * pax
        tw = np.r_[q[0], proj]; tw = tw / max(np.linalg.norm(tw), 1e-12)
        dphi = 2 * np.arctan2(np.linalg.norm(tw[1:]) * np.sign(tw[1:] @ pax), tw[0])
        phi += dphi; slide_total += slide
        W_goal = W_goal + slide * tgt
        if abs(dphi) < np.radians(0.5) and abs(slide) < 0.0005: break
    Rpro_h = rot_axis(pax, dphi)
    Rsw = Rw @ Rpro_h.T
    info['pronation_deg'] = float(np.degrees(phi)); info['wrist_swing_deg'] = float(np.degrees(np.arccos(np.clip((np.trace(Rsw) - 1) / 2, -1, 1))))
    info['elbow_flex_deg'] = float(np.degrees(flex)); info['elbow_valgus_adjust_deg'] = float(np.degrees(np.arccos(np.clip(cur2 @ tgt, -1, 1))))
    info['wrist_slide_mm'] = float(slide_total * 1000); info['forearm_stretch_mm'] = float(dLf * s0 * 1000); info['humerus_stretch_mm'] = float(dLh * s0 * 1000)
    # final maps: the radius is pronated in Z-Anatomy space (about the ulna), then stretched and carried
    maps['uln'] = m_uln
    maps['rad'] = BoneMap(Af, stf)
    maps['rad'] = _PreRot(Rp, stf, Af)
    Ahand = Ahd.then(Aff.about(Rpro_h, m_uln(pa0_za[None])[0])).then(Aff.about(Rsw, Wc))
    for b in CARPALS + [f'mc{i}' for i in range(1, 6)]: maps[b] = BoneMap(Ahand)
    log(f'  {side}: elbow flexion {info["elbow_flex_deg"]:.1f} deg (valgus adjust {info["elbow_valgus_adjust_deg"]:.1f}), pronation {info["pronation_deg"]:.1f} deg, wrist swing {info["wrist_swing_deg"]:.1f} deg, wrist slide {info["wrist_slide_mm"]:.1f} mm, humerus {info["humerus_stretch_mm"]:+.1f} mm, forearm {info["forearm_stretch_mm"]:+.1f} mm')
    # 6. fingers -----------------------------------------------------------------------------------------------------
    fit_fingers(L, maps, Ahand, H, ctx, info, log=log)
    info['time_s'] = round(time.time() - t0, 1)
    return dict(L=L, maps=maps, info=info, girdle=G, secs=secs, hand=H, targets=dict(GH=GH, E=E_t, W=W_t))


class _PreRot(BoneMap):
    """Bone map with a Z-Anatomy-space rigid motion first (the radius's pronation about the ulna), then the stretch
    and the affine."""

    def __init__(self, pre, stretch, aff):
        super().__init__(aff, stretch); self.pre = pre

    def __call__(self, x):
        return self.aff(self.stretch(self.pre(np.asarray(x, float))))

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
    line; the chain's joint centres are placed on it at the bones' lengths, with the distal phalanx's tip kept
    `pulp` short of the skin fingertip; each phalanx turns about its proximal joint (MCP: flexion + abduction, no
    twist; PIP / DIP / IP: flexion about the hinge axis), its length set by a shaft stretch."""
    J = L.J; s0 = ctx.s0
    info['fingers'] = {}
    for dg, chain in CHAINS.items():
        f = H['digits'][dg]
        cl = f['cl']
        if len(cl) < 3: raise RuntimeError(f'digit {dg}: skin centerline too short')
        # straight proximal extension of the centerline (into the palm)
        d0 = unit(cl[min(3, len(cl) - 1)] - cl[0])
        ext = np.array([cl[0] - d0 * k * 0.004 for k in range(12, 0, -1)])
        path = np.concatenate([ext, cl])
        # the skin fingertip and the tip target (pulp thickness short of it, along the finger)
        tipv = f['tip']; dtip = unit(cl[-1] - cl[-3])
        pulp = 0.0045 * s0
        tip_t = tipv - dtip * pulp
        # proximal joint of the first moving bone of the chain
        movers = chain[1:] if dg > 1 else chain   # thumb: the metacarpal moves too (carpometacarpal joint)
        if dg == 1:
            piv_za = J['cmc1']
        else:
            piv_za = J[f'{chain[0]}>{chain[1]}']
        piv = maps[chain[0]](piv_za[None])[0] if dg > 1 else Ahand(piv_za[None])[0]
        # Z-Anatomy segment lengths (joint to joint, last to the tip) along the chain
        za_pts = [piv_za] + [J[f'{a}>{b}'] for a, b in zip(chain[:-1], chain[1:]) if dg == 1 or a != chain[0]] + [J[f'{chain[-1]}_tip']]
        if dg == 1:
            za_pts = [J['cmc1'], J['mc1>pp1'], J['pp1>dp1'], J['dp1_tip']]
        za_len = np.array([np.linalg.norm(b - a) for a, b in zip(za_pts[:-1], za_pts[1:])]) * s0
        # total skin length from the pivot to the tip target along the path
        target_total = np.linalg.norm(tip_t - piv) if dg > 1 else None
        # place joints: successive points on the path at the (scaled) bone lengths; scale lengths so the chain ends at tip_t
        def place(k):
            pts = [piv]
            for Lseg in za_len * k:
                pts.append(polyline_point_at(path, Lseg, pts[-1]))
            return pts
        lo, hi = 0.75, 1.35
        for _ in range(40):  # bisection on the chain scale: last joint (tip) at the tip target's arc position
            k = 0.5 * (lo + hi)
            pts = place(k)
            # compare along the finger: projection of tip on dtip
            if (pts[-1] - tip_t) @ dtip > 0: hi = k
            else: lo = k
        k = 0.5 * (lo + hi); pts = place(k)
        info['fingers'][dg] = dict(length_scale=float(k), tip_err_mm=float(np.linalg.norm(pts[-1] - tip_t) * 1000))
        # now pose each moving bone: aim from its proximal joint to the next joint target, stretch to length
        prev_map = maps[chain[0]] if dg > 1 else BoneMap(Ahand)
        for i, b in enumerate(movers):
            if dg == 1:
                p_za, q_za = za_pts[i], za_pts[i + 1]
            else:
                p_za, q_za = za_pts[i], za_pts[i + 1]
            # the bone starts carried by its parent (Z-Anatomy relation), including the parent's stretch shift
            par_shift = prev_map.stretch.end_shift() if prev_map.stretch is not None else np.zeros(3)
            A0 = Aff(np.eye(3), par_shift).then(prev_map.aff)
            P0 = A0(p_za[None])[0]
            cur = unit(A0.vec(q_za - p_za)); tgt = unit(pts[i + 1] - pts[i])
            R = swing(cur, tgt)
            A1 = A0.then(Aff.about(R, P0, pts[i]))
            dL = (np.linalg.norm(pts[i + 1] - pts[i]) - s0 * np.linalg.norm(q_za - p_za)) / s0
            maps[b] = BoneMap(A1, Stretch(p_za, q_za, dL, zone=(0.2, 0.35, 0.65, 0.8)))
            prev_map = maps[b]
        log(f'    digit {dg}: chain length scale {k:.3f}, tip error {info["fingers"][dg]["tip_err_mm"]:.1f} mm')


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
    hc = np.concatenate([meshes[b][0] for b in ALL_BONES if b not in ARM_BONES]).mean(0)
    cams[f'{side}-hand-palmar'] = dict(dir=tuple(n), up=tuple(-e1), target=hc, radius=0.115)
    cams[f'{side}-hand-dorsal'] = dict(dir=tuple(-n), up=tuple(-e1), target=hc, radius=0.115)
    return render_views(items, cams, os.path.join(odir, 'qa'), size=(900, 900))


def save_maps(sex, side, r):
    d = cache_dir(sex)
    data = dict(side=side, maps={b: m.to_dict() for b, m in r['maps'].items()})
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


def run(sex):
    from fit.arms_final import finalize
    from fit.arms_measure import measure_side
    t0 = time.time()
    log(f'== arms {sex}')
    ctx = Ctx(sex)
    res = {}; rep_sides = {}
    for side in SIDES:
        r = fit_side(ctx, side)
        corr, fin = finalize(r['L'], r['maps'], ctx.skinT, log=log)
        for b in ALL_BONES: r['maps'][b] = r['maps'][b].then(corr[b])
        r['info']['final_pass'] = fin
        r['meshes'] = bone_meshes(r['L'], r['maps'])
        meas = measure_side(r['L'], r['maps'], r['meshes'], ctx.skinT, ctx.height, finger_label=r['hand']['label'], skin_v=ctx.skin[0], girdle=r['girdle'], log=log)
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
    report = dict(sex=sex, height_m=ctx.height, body_scale=ctx.s0, sides=rep_sides,
                  notes=['Z-Anatomy has no sesamoid bones of the hand (only of the foot), so none are placed.'])
    d = write_group(sex, GROUP, outputs, _jsonable(report))
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


def _za_points(name, n=4000, seed=2):
    from lib.mesh import source
    v, f = source('za-skeletal').get(name)
    return np.concatenate([v, sample_surface(v, f, n, seed=seed)])


def arm_deform(sex, side, k=4, p=4.0, eps=0.002):
    """(f, w) for one arm of one body, from the saved fit (.cache/fit/<sex>/arms/cache/maps-<side>.json).

    f(x): Z-Anatomy points (n, 3) of that arm -> body coordinates. Each point is carried by the maps of its k nearest
          bones of the limb (clavicle and scapula included), blended with weights 1 / (d + eps)^p of its distance to
          each bone in Z-Anatomy space: rigid on and near a bone, smooth across joints and through the soft tissue.
    w(x): the arm's share against the trunk warp, in [0, 1]: the same kernel's mass on the limb's bones against its
          mass on the trunk skeleton (ribs 1-8 of that side, sternum, vertebrae C4-T8), so it is 0 at the chest wall
          and spine, 1 on the shoulder girdle and the free limb, and smooth in between (axilla, root of the neck).
    Blend for vessels and nerves: x_body = (1 - w(x)) * get_warp(sex, 'trunk')(x) + w(x) * f(x)."""
    key = (sex, side, k, p, eps)
    if key in _DEFORM: return _DEFORM[key]
    maps = load_maps(sex, side)
    bones = [b for b in ALL_BONES if b in maps]
    trees = {b: cKDTree(_za_points(bone_name(b, side), n=1500 if b not in ('scap', 'hum') else 5000)) for b in bones}
    trunk_names = [f'{o}_rib{side}' for o in ('First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth')]
    trunk_names += ['Manubrium_of_sternum', 'Body_of_sternum'] + [f'Vertebra_C{i}' for i in range(4, 8)] + [f'Vertebra_T{i}' for i in range(1, 9)]
    from lib.mesh import source
    s = source('za-skeletal')
    tp = np.concatenate([_za_points(n, n=2000) for n in trunk_names if n in s.by_name])
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
