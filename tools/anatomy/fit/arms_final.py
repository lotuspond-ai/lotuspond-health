"""Final pass of the arms fit: joint spaces, skin clearance and bone-bone contacts, solved together as small rigid
corrections of every bone (fit/arms_solve.py).

  joint spaces   the articular surfaces' closest approach is brought into a band per joint (glenohumeral, humero-
                 ulnar, humero-radial, radio-scaphoid, radio-lunate, MCP / PIP / DIP / IP), which also keeps every
                 chain connected while its bones move
  skin           every bone at least CLEAR mm inside the skin; subcutaneous landmarks (olecranon, epicondyles,
                 styloids, acromion, clavicle, knuckles) at least 0.6 mm and, softly, no deeper than 5 mm
  contacts       neighbouring bones (Z-Anatomy pairs closer than 4 mm: carpals, metacarpal bases, radius-ulna, ...)
                 kept from interpenetrating
Small motions are preferred (rotation 2 deg, translation 2 mm scales; girdle 1 deg, 1 mm).
"""
import numpy as np

from fit.arms_geom import TriMesh, Aff, unit
from fit.arms_solve import Bodies, solve, term_surface_band, term_body_gap_local, term_regular
from fit.arms_za import ALL_BONES, ARM_BONES, CHAINS, CARPALS, contact
from fit.arms_measure import landmark_zones

JOINT_BANDS = {  # (proximal bone, distal bone): (lo, hi) mm of closest approach
    ('scap', 'hum'): (2.0, 4.0),
    ('hum', 'uln'): (1.2, 3.0), ('hum', 'rad'): (1.5, 3.5),
    ('rad', 'sca'): (1.2, 3.0), ('rad', 'lun'): (1.2, None),
}
FINGER_BAND = (0.7, 2.0)
CLEAR = 1.4
LANDMARK_LO, LANDMARK_HI = 0.8, 4.8
LANDMARK_W = {'acromion': 0.5}   # depth upper bounds are set by the chain (olecranon) and the girdle (acromion)


def neighbour_pairs(L, d=0.004):
    """Bone pairs (a, b) that come within d of each other in Z-Anatomy."""
    out = []
    lo = {b: L.M[b][0].min(0) - d for b in ALL_BONES}; hi = {b: L.M[b][0].max(0) + d for b in ALL_BONES}
    for i, a in enumerate(ALL_BONES):
        for b in ALL_BONES[i + 1:]:
            if np.any(lo[a] > hi[b]) or np.any(lo[b] > hi[a]): continue
            dd = np.abs(L.T[b].signed(L.P[a][::4]))
            if dd.min() < d: out.append((a, b))
    return out


def finalize(L, maps, skinT, log=print, iters=40):
    """Returns {bone: Aff correction (HRA -> HRA)} and a summary."""
    J = L.J
    rng = np.random.default_rng(7)
    def sub(P, n): return P if len(P) <= n else P[rng.choice(len(P), n, replace=False)]
    P = {b: maps[b](L.P[b]) for b in ALL_BONES}
    meshes = {b: (maps[b](L.M[b][0]), L.M[b][1]) for b in ALL_BONES}
    T0 = {b: TriMesh(*meshes[b], k=10) for b in ALL_BONES}
    # pivots
    piv = {}
    piv['clav'] = maps['clav'](J['sc'][None])[0]; piv['scap'] = maps['scap'](J['ac'][None])[0]
    piv['hum'] = maps['hum'](J['gh'][None])[0]
    piv['uln'] = maps['uln'](J['elbow'][None])[0]; piv['rad'] = maps['rad'](J['capitulum'][None])[0]
    for b in CARPALS: piv[b] = P[b].mean(0)
    for dg, ch in CHAINS.items():
        piv[ch[0]] = P[ch[0]].mean(0) if dg > 1 else maps['mc1'](J['cmc1'][None])[0]
        for a, b in zip(ch[:-1], ch[1:]): piv[b] = maps[a](J[f'{a}>{b}'][None])[0]
    B = Bodies(piv)
    terms = []; names = []
    # joint spaces
    pairs = dict(JOINT_BANDS)
    for dg, ch in CHAINS.items():
        for a, b in zip(ch[:-1], ch[1:]): pairs[(a, b)] = FINGER_BAND
    for (a, b), (lo, hi) in pairs.items():
        # articular samples of the distal bone facing the proximal one (Z-Anatomy contact, 6 mm)
        _, dd = contact(L.P[b], L.T[a], 0.006)
        m = np.abs(L.T[a].signed(L.P[b])) < 0.006
        Pb = sub(P[b][m], 600)
        if len(Pb) < 10: continue
        terms.append(term_body_gap_local(b, Pb, a, T0[a], lo=lo * 1e-3, hi=None if hi is None else hi * 1e-3, w=2.0, mode='min'))
        names.append(f'gap {a}-{b}')
        # and no point of the distal bone's articular surface inside the proximal bone
        terms.append(term_body_gap_local(b, Pb, a, T0[a], lo=0.3e-3, w=2.0)); names.append(f'pen {a}-{b}')
    # other contacts
    joint_set = set(pairs) | {(b, a) for a, b in pairs}
    for a, b in neighbour_pairs(L):
        if (a, b) in joint_set: continue
        for x, y in ((a, b), (b, a)):
            m = np.abs(L.T[y].signed(L.P[x])) < 0.004
            if m.sum() < 5: continue
            terms.append(term_body_gap_local(x, sub(P[x][m], 600), y, T0[y], lo=0.3e-3, w=2.0)); names.append(f'contact {x}-{y}')
    # skin
    zones = landmark_zones(L)
    for b in ALL_BONES:
        cl = -skinT.signed(P[b])
        lm = np.zeros(len(cl), bool)
        for name, msk in zones.get(b, []):
            if msk.any():
                lm |= msk
                Pz = P[b][msk]
                terms.append(term_surface_band(b, sub(Pz, 600), skinT, lo=LANDMARK_LO * 1e-3, w=3.0)); names.append(f'skin {name} lo')
                if name in LANDMARK_W:
                    terms.append(term_surface_band(b, sub(Pz, 600), skinT, hi=LANDMARK_HI * 1e-3, w=LANDMARK_W[name], mode='min')); names.append(f'skin {name} hi')
        near = (~lm) & (cl < 0.008)
        if near.any():
            terms.append(term_surface_band(b, sub(P[b][near], 1500), skinT, lo=CLEAR * 1e-3, w=3.0)); names.append(f'skin {b}')
    for b in ALL_BONES:
        sr, st = (np.radians(1), 0.001) if b in ('clav', 'scap') else (np.radians(2), 0.002)
        terms.append(term_regular(b, sr, st)); names.append(f'reg {b}')
    def report():
        out = {}
        for nm, t in zip(names, terms):
            r, _ = t(B); c = float(r @ r) if len(r) else 0.0
            if c > 0.01 and not nm.startswith('reg'): out[nm] = round(c, 2)
        return out
    before = report()
    cost = solve(B, terms, iters=iters)
    after = report()
    corr = {b: Aff.about(B.R[b], B.c[b], B.c[b] + B.t[b]) for b in ALL_BONES}
    moved = {b: (float(np.degrees(np.arccos(np.clip((np.trace(B.R[b]) - 1) / 2, -1, 1)))), float(np.linalg.norm(B.t[b]) * 1000)) for b in ALL_BONES}
    big = {b: (round(a, 1), round(t, 1)) for b, (a, t) in moved.items() if a > 1 or t > 1}
    log(f'    final pass: cost {cost:.2f}; bones moved >1 deg/mm: {big}')
    log(f'    remaining violations: {after}')
    return corr, dict(cost=float(cost), before=before, after=after, moved_deg_mm=big)
