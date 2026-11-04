"""Limb pass of the arms fit: the free limb's three segments moved as rigid units so the bones sit at their depth under
the skin while the elbow and the wrist stay articulated.

  segments   humerus (about the glenohumeral centre: its head stays in the glenoid), forearm (ulna + radius, about
             the elbow) and hand (carpals, metacarpals, phalanges, about the wrist)
  landmarks  the subcutaneous bony landmarks of the free limb (olecranon, medial and lateral epicondyles, ulnar and
             radial styloid processes, and more gently the knuckles) are drawn into LANDMARK_BAND under the skin; where
             the skin is wider than the bone allows (e.g. a fleshy elbow), the weighted least-squares balance leaves
             the excess shared between opposite landmarks instead of pushing one of them out
  clearance  every other bone sample at least CLEAR under the skin (the phalanges thereby stay in their fingers)
  joints     humero-ulnar, humero-radial and radiocarpal surfaces kept JOINT_BAND apart (closest approach), and the
             segments' joint centres kept within a few millimetres of each other (no dislocation)
The articulated chain (fit/arms.py) puts the segments along the skin arm; this pass only moves them across it (the
humerus by a few degrees about the shoulder, the forearm and hand by millimetres).
"""
import numpy as np

from fit.arms_geom import TriMesh, Aff
from fit.arms_solve import Bodies, solve, term_surface_band, term_body_gap_local, term_points_pair, term_regular
from fit.arms_za import HAND_BONES, CARPALS

SEGMENTS = {'hum': ['hum'], 'fore': ['uln', 'rad'], 'hand': list(HAND_BONES)}
LANDMARK_BAND = (1.0, 4.0)       # mm under the skin
LANDMARK_NAMES = ('olecranon', 'medial epicondyle', 'lateral epicondyle', 'ulnar styloid', 'radial styloid')
# weights of the depth upper bounds: the olecranon counts double, being the one elbow landmark that stays thinly covered
# however much subcutaneous fat there is (skin and bursa over the extensor surface), while the epicondyles carry the
# common flexor and extensor origins; the knuckles are drawn gently
LANDMARK_HI_W = {'olecranon': 2.0, 'medial epicondyle': 1.0, 'lateral epicondyle': 1.0, 'ulnar styloid': 1.0, 'radial styloid': 1.0}
CLEAR = 1.6                      # mm, every other sample
JOINT_BAND = {('hum', 'uln'): (1.3, 3.0), ('hum', 'rad'): (1.3, 3.5), ('rad', 'sca'): (1.3, 3.0), ('rad', 'lun'): (1.3, None)}


def segment_of(b):
    for s, bs in SEGMENTS.items():
        if b in bs: return s
    return None


def limb_pass(L, maps, skinT, log=print, iters=30, seed=5):
    """Returns ({bone: Aff correction (HRA -> HRA)} for the free-limb bones, summary)."""
    from fit.arms_measure import landmark_zones
    J = L.J
    rng = np.random.default_rng(seed)
    def sub(P, n): return P if len(P) <= n else P[rng.choice(len(P), n, replace=False)]
    bones = [b for s in SEGMENTS.values() for b in s]
    P = {b: maps[b](L.P[b]) for b in bones}
    T0 = {b: TriMesh(maps[b](L.M[b][0]), L.M[b][1], k=10) for b in ('hum', 'uln', 'rad', 'sca', 'lun')}
    piv = dict(hum=maps['hum'](J['gh'][None])[0], fore=maps['uln'](J['elbow'][None])[0], hand=maps['cap'](J['wrist'][None])[0])
    B = Bodies(piv)
    terms, names = [], []
    zones = landmark_zones(L)
    # skin: landmarks into their band, everything else at least CLEAR inside
    for b in bones:
        seg = segment_of(b)
        cl = -skinT.signed(P[b])
        lm = np.zeros(len(cl), bool)
        for name, msk in zones.get(b, []):
            if not msk.any(): continue
            lm |= msk
            Pz = sub(P[b][msk], 400)
            terms.append(term_surface_band(seg, Pz, skinT, lo=LANDMARK_BAND[0] * 1e-3, w=3.0)); names.append(f'{name} lo')
            if name in LANDMARK_NAMES or name.startswith('knuckle'):
                terms.append(term_surface_band(seg, Pz, skinT, hi=LANDMARK_BAND[1] * 1e-3, w=LANDMARK_HI_W.get(name, 0.5), mode='min'))
                names.append(f'{name} hi')
        near = (~lm) & (cl < 0.012)
        if near.any():
            terms.append(term_surface_band(seg, sub(P[b][near], 1200), skinT, lo=CLEAR * 1e-3, w=3.0)); names.append(f'skin {b}')
    # joints: closest approach of the articular surfaces in a band (both directions), centres kept together
    for (a, b), (lo, hi) in JOINT_BAND.items():
        for x, y in ((b, a), (a, b)):
            if x not in P or y not in T0: continue
            m = np.abs(T0[y].signed(P[x])) < 0.006
            if m.sum() < 5: continue
            Px = sub(P[x][m], 500)
            terms.append(term_body_gap_local(segment_of(x), Px, segment_of(y), T0[y], lo=lo * 1e-3, w=2.0)); names.append(f'gap {x}-{y} lo')
            if hi is not None and x == b:
                terms.append(term_body_gap_local(segment_of(x), Px, segment_of(y), T0[y], hi=hi * 1e-3, w=1.0, mode='min')); names.append(f'gap {x}-{y} hi')
    terms.append(term_points_pair('hum', maps['hum'](J['elbow'][None])[0], 'fore', maps['uln'](J['elbow'][None])[0], w=1.0, tol=0.0035)); names.append('elbow centre')
    terms.append(term_points_pair('fore', maps['rad'](J['wrist'][None])[0], 'hand', maps['cap'](J['wrist'][None])[0], w=1.0, tol=0.0035)); names.append('wrist centre')
    # the humerus turns about the shoulder (its head stays in the glenoid); forearm and hand move freely but gently
    terms.append(term_regular('hum', np.radians(6), 0.0003)); names.append('reg hum')
    terms.append(term_regular('fore', np.radians(6), 0.010)); names.append('reg fore')
    terms.append(term_regular('hand', np.radians(5), 0.010)); names.append('reg hand')

    def report():
        out = {}
        for nm, t in zip(names, terms):
            r, _ = t(B); c = float(r @ r) if len(r) else 0.0
            if c > 0.01 and not nm.startswith('reg'): out[nm] = round(c, 2)
        return out
    before = report()
    cost = solve(B, terms, iters=iters)
    after = report()
    corr = {}
    for s, bs in SEGMENTS.items():
        A = Aff.about(B.R[s], B.c[s], B.c[s] + B.t[s])
        for b in bs: corr[b] = A
    moved = {s: (round(float(np.degrees(np.arccos(np.clip((np.trace(B.R[s]) - 1) / 2, -1, 1)))), 2), round(float(np.linalg.norm(B.t[s]) * 1000), 2),
                 np.round(B.t[s] * 1000, 2).tolist()) for s in SEGMENTS}
    log(f'    limb pass: cost {cost:.2f}; segments moved (deg, mm, [dx dy dz] mm): {moved}')
    log(f'    limb pass remaining: {after}')
    return corr, dict(cost=float(cost), before=before, after=after, moved_deg_mm=moved)
