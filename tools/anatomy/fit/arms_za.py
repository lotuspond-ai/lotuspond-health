"""Z-Anatomy side of the arms fit: the bones of one upper limb, their articular surfaces and joint centres.

Joint centres come from the bones themselves, as they articulate in Z-Anatomy's anatomical position: the articular
surface of bone A at joint (A, B) is the part of A within a few millimetres of B; spheres fitted to those surfaces give
the centres of rotation (humeral head, capitulum, metacarpal and phalangeal heads, proximal carpal row).
"""
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import source, sample_surface, area, orient_outward
from fit.arms_geom import TriMesh, fit_sphere, fit_plane, unit, pca_axes

ORD = ['first', 'second', 'third', 'fourth', 'fifth']
CARPALS = ['sca', 'lun', 'tri', 'pis', 'tpm', 'tpd', 'cap', 'ham']
NAMES = dict(clav='Clavicle', scap='Scapula', hum='Humerus', rad='Radius', uln='Ulna', sca='Scaphoid_bone', lun='Lunate_bone',
             tri='Triquetrum_bone', pis='Pisiform_bone', tpm='Trapezium_bone', tpd='Trapezoid_bone', cap='Capitate_bone', ham='Hamate_bone')
for _i, _o in enumerate(ORD): NAMES[f'mc{_i + 1}'] = f'{_o.capitalize()}_metacarpal_bone'
for _i, _o in enumerate(ORD): NAMES[f'pp{_i + 1}'] = f'Proximal_phalanx_of_{_o}_finger_of_hand'
for _i, _o in enumerate(ORD[1:]): NAMES[f'mp{_i + 2}'] = f'Middle_phalanx_of_{_o}_finger_of_hand'
for _i, _o in enumerate(ORD): NAMES[f'dp{_i + 1}'] = f'Distal_phalanx_of_{_o}_finger_of_hand'
ARM_BONES = ['clav', 'scap', 'hum', 'rad', 'uln']
HAND_BONES = CARPALS + [f'mc{i}' for i in range(1, 6)] + [f'pp{i}' for i in range(1, 6)] + [f'mp{i}' for i in range(2, 6)] + [f'dp{i}' for i in range(1, 6)]
ALL_BONES = ARM_BONES + HAND_BONES
# finger chains: (metacarpal, proximal, middle, distal); the thumb has no middle phalanx
CHAINS = {1: ['mc1', 'pp1', 'dp1'], 2: ['mc2', 'pp2', 'mp2', 'dp2'], 3: ['mc3', 'pp3', 'mp3', 'dp3'], 4: ['mc4', 'pp4', 'mp4', 'dp4'], 5: ['mc5', 'pp5', 'mp5', 'dp5']}
PHALANGES = [b for b in HAND_BONES if b[:2] in ('pp', 'mp', 'dp')]
# Z-Anatomy skin regions of the free limb (za-regions), by segment
REGIONS = {
    'upper': ['Deltoid_region', 'Anterior_region_of_arm', 'Posterior_region_of_arm'],
    'elbow': ['Anterior_region_of_elbow', 'Posterior_region_of_elbow'],
    'fore': ['Anterior_region_of_forearm', 'Posterior_region_of_forearm', 'Lateral_border_of_forearm', 'Medial_border_of_forearm'],
    'wrist': ['Anterior_region_of_wrist', 'Posterior_region_of_wrist', 'Radial_foveola'],
    'hand': ['Palm', 'Dorsum_of_hand'],
    'digits': ['Dorsal_surfaces_of_digits_of_hand', 'Palmar_surfaces_of_digits_of_hand'],
}


def bone_name(key, side):
    return NAMES[key] + side


def load_bones(side):
    s = source('za-skeletal')
    out = {}
    for k in ALL_BONES:
        v, f = s.get(bone_name(k, side))
        out[k] = (v, orient_outward(v, f))
    return out


def load_regions(side):
    r = source('za-regions')
    out = {}
    for seg, names in REGIONS.items():
        for n in names:
            v, f = r.get(n + side)
            out[n] = (v, f, seg)
    return out


def manubrium():
    v, f = source('za-skeletal').get('Manubrium_of_sternum')
    return v, orient_outward(v, f)


def _samples(m, per_mm2=1.0, nmin=1500, nmax=60000, seed=1):
    v, f = m
    n = int(np.clip(area(v, f) * 1e6 * per_mm2, nmin, nmax))
    return sample_surface(v, f, n, seed=seed)


def contact(PA, TB, d):
    """Samples of A (PA) within distance d of mesh B."""
    dist = np.abs(TB.signed(PA))
    return PA[dist < d], dist[dist < d]


def refine_sphere(P, c, r, band=0.003, iters=4, keep=None):
    """Sphere fit to the points of P lying within `band` of the current sphere (grows over the articular head)."""
    for _ in range(iters):
        dd = np.abs(np.linalg.norm(P - c, axis=1) - r)
        m = dd < band
        if keep is not None: m &= keep(P)
        if m.sum() < 30: break
        c, r = fit_sphere(P[m])
    return c, r


# Radiocarpal seating. Z-Anatomy's carpus sits one fossa too far ulnar on the radius: its lunate is only ~20 % over the
# radius (centre 6 mm ulnar of the radius's ulnar edge, 4.7 mm from the radius, 1.4 mm from the ulnar head, i.e. on the
# ulna with no room for the articular disc) and its scaphoid spans both fossae. The hand (carpus, metacarpals, digits,
# their joints kept) is translated radially, in Z-Anatomy space, until LUNATE_COVER of the lunate's width lies over the
# radius (lunate fossa; the rest over the triangular fibrocartilage), and along the forearm so the proximal row is
# RC_SPACE from the radius (the scaphoid then rests in the scaphoid fossa). Z-Anatomy's lunate fossa is deeper than its
# lunate's convexity: with the scaphoid seated the lunate stays ~5 mm from the radius (no rigid seating closes both).
LUNATE_COVER = 0.5
RC_SPACE = 0.0018


def _wrist_frame(M, sg):
    """Distal-radius frame in Z-Anatomy space: fa (along the forearm, distal), ru (ulnar -> radial), and the radius's
    distal articular surface samples."""
    rv, rf = M['rad']; uv, _ = M['uln']
    P = sample_surface(rv, rf, 20000, seed=4)
    T = TriMesh(rv, rf)
    _, _, _, nrm = T.signed_full(P)
    c = rv.mean(0); w, V = np.linalg.eigh(np.cov((rv - c).T)); fa = V[:, -1]
    if fa[1] > 0: fa = -fa                                   # distal = down in anatomical position
    dist_r = rv[(rv - c) @ fa > ((rv - c) @ fa).max() - 0.02].mean(0)
    dist_u = uv[(uv - c) @ fa > ((uv - c) @ fa).max() - 0.02].mean(0)
    ru = dist_r - dist_u; ru = unit(ru - (ru @ fa) * fa)
    t = (P - c) @ fa
    art = P[(t > t.max() - 0.012) & (nrm @ fa > 0.6)]       # distal-facing surface of the distal 12 mm
    return fa, ru, art, T


def _coverage(M, fa, ru, d):
    """Share of the lunate's width (along ru) radial of the radius's ulnar edge at the lunate's level, for the hand
    translated by d (the review's measure)."""
    rv = M['rad'][0]; lv = M['lun'][0] + d
    tl = (lv - rv.mean(0)) @ fa; tr = (rv - rv.mean(0)) @ fa
    e = (rv[tr > tl.min() - 0.012] @ ru).min()
    lr = lv @ ru
    return float(np.clip((lr.max() - max(lr.min(), e)) / (lr.max() - lr.min()), 0, 1))


def seat_carpus(M, sg, cover=LUNATE_COVER, log=None):
    """Z-Anatomy-space translation of the hand bones that seats the proximal carpal row on the radius: the smallest
    radial shift that puts `cover` of the lunate's width over the radius (lunate fossa), with the proximal row moved
    along the forearm so its closest approach to the radius is RC_SPACE (the scaphoid then rests in its fossa)."""
    fa, ru, art, Trad = _wrist_frame(M, sg)
    Ps = {k: sample_surface(*M[k], 3000, seed=7) for k in ('sca', 'lun')}

    def place(r):
        d = r * ru
        for _ in range(3):
            g = min(float(Trad.signed(Ps[k] + d).min()) for k in ('sca', 'lun'))
            d = d + (RC_SPACE - g) * fa
        return d
    c0 = _coverage(M, fa, ru, np.zeros(3))
    r = 0.0
    while r < 0.008 and _coverage(M, fa, ru, place(r)) < cover: r += 0.0005
    d = place(r)
    info = dict(delta_mm=(d * 1e3).round(2).tolist(), radial_mm=round(r * 1e3, 2), along_forearm_mm=round(float(d @ fa) * 1e3, 2),
                lunate_cover_before_pct=round(100 * c0, 1), lunate_cover_after_pct=round(100 * _coverage(M, fa, ru, d), 1),
                radius_scaphoid_mm=round(float(Trad.signed(Ps['sca'] + d).min()) * 1e3, 2), radius_lunate_mm=round(float(Trad.signed(Ps['lun'] + d).min()) * 1e3, 2))
    return d, info


def seat_lunate(M, sg, n_s=1500):
    """The lunate is the intercalated segment of the proximal row, between the radius's lunate fossa and the head of the
    capitate. Z-Anatomy's carpus is packed (lunate-capitate 0.1 mm, no midcarpal space) and, with the scaphoid seated,
    its lunate stands ~5.4 mm off the radius. The lunate alone is translated toward the radius (directions within 40 deg
    of proximal along the forearm, none ulnar, so its cover by the radius is kept) to where its joint spaces to the
    radius and to the capitate are equal (never closer than RC_SPACE to the radius), without overlapping the scaphoid,
    triquetrum or hamate more than Z-Anatomy's own packing (+0.2 mm); of those placements the most congruent (smallest
    joint spaces) is kept. Returns (Z-Anatomy-space translation, info)."""
    fa, ru, _, Tr = _wrist_frame(M, sg)
    Tl = TriMesh(*M['lun']); Pl = sample_surface(*M['lun'], n_s, seed=7)
    Tc = TriMesh(*M['cap']); Pc = sample_surface(*M['cap'], n_s, seed=7)
    nb = {b: (TriMesh(*M[b]), sample_surface(*M[b], n_s, seed=7)) for b in ('sca', 'tri', 'ham')}

    def gaps(d):
        return float(Tr.signed(Pl + d).min()), float(min(Tc.signed(Pl + d).min(), Tl.signed(Pc - d).min()))

    def nbgap(d):
        return {b: float(min(T.signed(Pl + d).min(), Tl.signed(P - d).min())) for b, (T, P) in nb.items()}
    g_r0, g_c0 = gaps(np.zeros(3)); nb0 = nbgap(np.zeros(3))
    floor = {b: min(v, 0.0) - 0.0002 for b, v in nb0.items()}
    e1 = unit(np.cross(fa, ru)); e2 = unit(np.cross(fa, e1))
    dirs = [-fa]
    for th in (15, 30, 40):
        for ph in range(0, 360, 45):
            t, f = np.radians(th), np.radians(ph)
            u = unit(-np.cos(t) * fa + np.sin(t) * (np.cos(f) * e1 + np.sin(f) * e2))
            if u @ ru >= -1e-9: dirs.append(u)      # never ulnar: the lunate stays over the lunate fossa (seat_carpus)
    best = (max(g_r0, g_c0), 0.0, np.zeros(3), g_r0, g_c0)
    for u in dirs:
        prev = None
        for s in np.arange(0.0004, g_r0, 0.0004):
            d = s * u; g_r, g_c = gaps(d)
            if g_r < RC_SPACE: break
            ok = all(v >= floor[b] for b, v in nbgap(d).items())
            if not ok: break
            prev = (max(g_r, g_c), s, d, g_r, g_c)
            if g_c >= g_r: break                       # spaces equal (or the capitate side now the larger)
        if prev is not None and prev[0] < best[0] - 1e-5: best = prev
    m, s, d, g_r, g_c = best
    info = dict(delta_mm=(d * 1e3).round(2).tolist(), shift_mm=round(s * 1e3, 2),
                radius_lunate_before_mm=round(g_r0 * 1e3, 2), capitate_lunate_before_mm=round(g_c0 * 1e3, 2),
                radius_lunate_mm=round(g_r * 1e3, 2), capitate_lunate_mm=round(g_c * 1e3, 2),
                lunate_to_before_mm={b: round(v * 1e3, 2) for b, v in nb0.items()}, lunate_to_mm={b: round(v * 1e3, 2) for b, v in nbgap(d).items()},
                lunate_cover_pct=round(100 * _coverage(M, fa, ru, d), 1))
    return d, info


class Limb:
    """Joint centres, axes and articular surfaces of one Z-Anatomy upper limb (in Z-Anatomy space). The hand bones are
    seated on the radius (seat_carpus): L.seat is their Z-Anatomy-space translation, already applied to L.M / L.P; the
    lunate is then seated between the radius and the capitate (seat_lunate): L.seat_bone['lun'] is its own extra
    translation, also applied."""

    def __init__(self, side):
        self.side = side
        self.sg = 1.0 if side == 'l' else -1.0
        self.M = load_bones(side)
        self.seat, self.seat_info = seat_carpus(self.M, self.sg)
        for k in HAND_BONES: self.M[k] = (self.M[k][0] + self.seat, self.M[k][1])
        dl, self.seat_info['lunate'] = seat_lunate(self.M, self.sg)
        self.seat_bone = {'lun': dl}
        self.M['lun'] = (self.M['lun'][0] + dl, self.M['lun'][1])
        self.man = manubrium()
        self.T = {k: TriMesh(*m) for k, m in self.M.items()}
        self.Tman = TriMesh(*self.man)
        self.P = {k: _samples(m) for k, m in self.M.items()}
        self.J = {}
        self._joints()

    # ---------------------------------------------------------------- joints
    def _joints(self):
        M, T, P, J = self.M, self.T, self.P, self.J
        # glenohumeral: humeral head sphere grown from the part facing the glenoid
        hc, _ = contact(P['hum'], T['scap'], 0.008)
        c, r = fit_sphere(hc)
        top = P['hum'][:, 1] > M['hum'][0][:, 1].max() - 0.07
        c, r = refine_sphere(P['hum'], c, r, band=0.0025, keep=lambda X: X[:, 1] > M['hum'][0][:, 1].max() - 0.07)
        J['gh'] = c; J['gh_r'] = r
        gl, _ = contact(P['scap'], T['hum'], 0.008)
        gc, gn = fit_plane(gl)
        if gn @ (c - gc) < 0: gn = -gn
        J['glenoid'] = gc; J['glenoid_n'] = gn
        # elbow: capitulum sphere (faces the radial head) and the trochlea (faces the ulna's trochlear notch)
        cap, _ = contact(P['hum'], T['rad'], 0.008)
        ccap, rcap = fit_sphere(cap)
        tro, _ = contact(P['uln'], T['hum'], 0.004)
        ctro, rtro = fit_sphere(tro)
        J['capitulum'] = ccap; J['capitulum_r'] = rcap; J['trochlea'] = ctro; J['trochlea_r'] = rtro
        J['elbow'] = 0.5 * (ccap + ctro)
        ax = unit(ccap - ctro)  # medial -> lateral
        J['elbow_axis'] = ax
        # distal radio-ulnar joint: ulnar head (faces the radius's ulnar notch)
        uh, _ = contact(P['uln'], T['rad'], 0.004)
        uh = uh[uh[:, 1] < M['uln'][0][:, 1].min() + 0.06]
        cuh, ruh = fit_sphere(uh)
        J['ulnar_head'] = cuh
        J['prono_axis'] = unit(cuh - ccap)
        # radiocarpal: the proximal surfaces of scaphoid and lunate that face the radius
        pr = np.concatenate([contact(P[k], T['rad'], 0.006)[0] for k in ('sca', 'lun')])
        crc, rrc = fit_sphere(pr)
        J['radiocarpal'] = crc; J['radiocarpal_r'] = rrc
        J['wrist'] = crc
        # midcarpal: capitate head (faces lunate and scaphoid)
        ch = np.concatenate([contact(P['cap'], T[k], 0.004)[0] for k in ('lun', 'sca')])
        J['capitate_head'], _ = fit_sphere(ch)
        # finger joints: heads of metacarpals and phalanges, facing the next bone of the chain
        for d, ch in CHAINS.items():
            for a, b in zip(ch[:-1], ch[1:]):
                hd, _ = contact(P[a], T[b], 0.004)
                c0, r0 = fit_sphere(hd)
                # grow over the head (distal part of the bone only)
                axis = unit(c0 - P[a].mean(0))
                c1, r1 = refine_sphere(P[a], c0, r0, band=0.0012, iters=3, keep=lambda X, c0=c0, axis=axis: (X - c0) @ axis > -0.004)
                if not (0.6 * r0 < r1 < 1.6 * r0): c1, r1 = c0, r0
                J[f'{a}>{b}'] = c1; J[f'{a}>{b}_r'] = r1
            # tip of the distal phalanx: farthest point from its proximal joint
            dp = ch[-1]; base = J[f'{ch[-2]}>{dp}']
            pts = M[dp][0]
            J[f'{dp}_tip'] = pts[np.argmax(np.linalg.norm(pts - base, axis=1))]
        # thumb carpometacarpal (saddle): centre of the trapezium-mc1 contact
        cm = np.concatenate([contact(P['mc1'], T['tpm'], 0.003)[0], contact(P['tpm'], T['mc1'], 0.003)[0]])
        J['cmc1'] = cm.mean(0)
        # sternoclavicular and acromioclavicular contacts
        sc = np.concatenate([contact(P['clav'], self.Tman, 0.006)[0], contact(_samples(self.man), T['clav'], 0.006)[0]])
        J['sc'] = sc.mean(0)
        ac = np.concatenate([contact(P['clav'], T['scap'], 0.004)[0], contact(P['scap'], T['clav'], 0.004)[0]])
        J['ac'] = ac.mean(0)
        # Z-Anatomy's own joint spaces (closest approach, negative = the meshes overlap)
        self.gaps = {}
        pairs = [('scap', 'hum'), ('hum', 'uln'), ('hum', 'rad'), ('rad', 'sca'), ('rad', 'lun')]
        for d, ch in CHAINS.items(): pairs += list(zip(ch[:-1], ch[1:]))
        for a, b in pairs:
            self.gaps[(a, b)] = float(min(T[b].signed(P[a]).min(), T[a].signed(P[b]).min()))

    # ---------------------------------------------------------------- frames
    def joint_chain(self, digit):
        """Joint centres along a digit: [proximal joint of the metacarpal or None, MCP, PIP, (DIP), tip]."""
        ch = CHAINS[digit]
        pts = [self.J[f'{a}>{b}'] for a, b in zip(ch[:-1], ch[1:])]
        return pts + [self.J[f'{ch[-1]}_tip']]

    def hand_frame(self):
        """Origin at the radiocarpal centre; e1 along the hand (towards MCP3), e3 palmar normal, e2 = e3 x e1."""
        J = self.J
        o = J['radiocarpal']
        e1 = unit(J['mc3>pp3'] - o)
        mcp = np.array([J[f'mc{i}>pp{i}'] for i in range(2, 6)])
        across = unit(mcp[0] - mcp[-1])  # little -> index (radial)
        n = unit(np.cross(e1, across))
        # palmar side: the hand's palmar surface faces forward (+z) in anatomical position
        if n[2] < 0: n = -n
        e3 = unit(n - (n @ e1) * e1); e2 = np.cross(e3, e1)
        return o, np.stack([e1, e2, e3], 1)
