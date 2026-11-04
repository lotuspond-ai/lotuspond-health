"""Final pass of the arms fit: joint spaces, skin clearance and bone-bone contacts, solved together as small rigid
corrections of every bone (fit/arms_solve.py), then a local push-out of the overlaps Z-Anatomy's meshes leave.

  joint spaces   the articular surfaces' closest approach is brought into a band per joint (glenohumeral, humero-
                 ulnar, humero-radial, radio-scaphoid, radio-lunate, MCP / PIP / DIP / IP), sampled on both bones
                 where they face each other, which also keeps every chain connected while its bones move
  skin           every bone at least CLEAR mm inside the skin; subcutaneous landmarks (olecranon, epicondyles,
                 styloids, acromion, clavicle, knuckles) at least LANDMARK_LO mm and, softly, no deeper than
                 LANDMARK_HI mm
  contacts       neighbouring bones (Z-Anatomy pairs closer than 4 mm: carpals, metacarpal bases, radius-ulna, ...)
                 kept from interpenetrating
  push-out       pushout() / residual_pushout(): a neighbour pair that still interpenetrates is separated by a small
                 smooth local deformation of both surfaces at the contact (shape kept elsewhere)
Small motions are preferred (rotation 2 deg, translation 2 mm scales; girdle 1 deg, 1 mm).
"""
import numpy as np

from fit.arms_geom import TriMesh, Aff, unit
from fit.arms_solve import Bodies, solve, term_surface_band, term_body_gap_local, term_regular
from fit.arms_za import ALL_BONES, ARM_BONES, CHAINS, CARPALS, contact
from fit.arms_measure import landmark_zones

JOINT_BANDS = {  # (proximal bone, distal bone): (lo, hi) mm of closest approach
    ('scap', 'hum'): (2.0, 4.0),
    ('hum', 'uln'): (1.3, 3.0), ('hum', 'rad'): (1.5, 3.5),
    ('rad', 'sca'): (1.3, 3.0), ('rad', 'lun'): (1.3, None),
}
FINGER_BAND = (0.9, 2.0)
CLEAR = 1.4
LANDMARK_LO, LANDMARK_HI = 0.8, 4.5
KNUCKLE_W = 0.4
LANDMARK_W = {'acromion': 0.5, 'olecranon': 0.3, 'medial epicondyle': 0.3, 'lateral epicondyle': 0.3, 'ulnar styloid': 0.3,
              'radial styloid': 0.3}   # depth upper bounds (weights): set mainly by the girdle and the limb pass


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
        # articular samples of each bone facing the other in the current placement (both directions, every sample
        # closer than lo is pushed back) and the joint kept closed (closest approach at most hi)
        for x, y in ((b, a), (a, b)):
            m = np.abs(T0[y].signed(P[x])) < 0.006
            if m.sum() < 10: continue
            Px = sub(P[x][m], 900)
            terms.append(term_body_gap_local(x, Px, y, T0[y], lo=lo * 1e-3, w=2.0)); names.append(f'gap {x}-{y} lo')
            if hi is not None and x == b:
                terms.append(term_body_gap_local(x, Px, y, T0[y], hi=hi * 1e-3, w=1.0, mode='min')); names.append(f'gap {x}-{y} hi')
    # other contacts
    joint_set = set(pairs) | {(b, a) for a, b in pairs}
    for a, b in neighbour_pairs(L):
        if (a, b) in joint_set: continue
        for x, y in ((a, b), (b, a)):
            m = np.abs(L.T[y].signed(L.P[x])) < 0.004
            if m.sum() < 5: continue
            terms.append(term_body_gap_local(x, sub(P[x][m], 1500), y, T0[y], lo=0.3e-3, w=2.0)); names.append(f'contact {x}-{y}')
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
                wl = LANDMARK_W.get(name, KNUCKLE_W if name.startswith('knuckle') else None)
                if wl:
                    terms.append(term_surface_band(b, sub(Pz, 600), skinT, hi=LANDMARK_HI * 1e-3, w=wl, mode='min')); names.append(f'skin {name} hi')
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


# ------------------------------------------------------------------------------------------------ residual overlaps
def sample_bary(L, b):
    """(triangle vertex ids, barycentric weights) of the Z-Anatomy samples L.P[b] on their bone's mesh, so per-vertex
    displacements of the bone can be carried over to the samples (cached on L)."""
    cache = L.__dict__.setdefault('_bary', {})
    if b not in cache:
        T = L.T[b]
        _, Q, FI, _ = T.closest(L.P[b])
        tri = T.f[FI]; a, bb, c = T.v[tri[:, 0]], T.v[tri[:, 1]], T.v[tri[:, 2]]
        v0, v1, v2 = bb - a, c - a, Q - a
        d00 = np.einsum('ij,ij->i', v0, v0); d01 = np.einsum('ij,ij->i', v0, v1); d11 = np.einsum('ij,ij->i', v1, v1)
        d20 = np.einsum('ij,ij->i', v2, v0); d21 = np.einsum('ij,ij->i', v2, v1)
        den = np.where(np.abs(d00 * d11 - d01 ** 2) < 1e-30, 1e-30, d00 * d11 - d01 ** 2)
        wv = (d11 * d20 - d01 * d21) / den; ww = (d00 * d21 - d01 * d20) / den
        cache[b] = (tri, np.stack([1 - wv - ww, wv, ww], 1))
    return cache[b]


def carry(L, b, D):
    """Per-vertex displacements D of bone b, interpolated at its samples L.P[b]."""
    tri, w = sample_bary(L, b)
    return np.einsum('mk,mkj->mj', w, D[tri])


def _neighbours(f, n):
    from scipy import sparse
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    W = sparse.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    W.data[:] = 1.0
    deg = np.asarray(W.sum(1)).ravel(); deg[deg == 0] = 1
    return W, deg


def pushout(L, maps, meshes, pairs, rings=6, iters=8, log=print):
    """Resolve the overlaps left between neighbouring bones (Z-Anatomy's own meshes interpenetrate by up to 1.4 mm in the
    carpus, often with a coarse triangle of one bone cutting through the other between vertices) by a small local
    deformation that keeps each bone's shape: every surface sample of A (the Z-Anatomy samples, carried by A's map and
    by the displacement so far) closer than `margin` to B, or inside it, asks to move out along B's surface normal by
    half the shortfall (B takes the other half); the requests go to the vertices of the sample's triangle (barycentric
    weights), and the displacement fades out over `rings` vertex rings (harmonic falloff), so only the contact area
    moves. pairs: {(a, b): margin (m)}. Returns ({bone: per-vertex displacement (n, 3)}, {pair: (before, after)
    closest approach in mm})."""
    V0 = {b: meshes[b][0] for b in meshes}
    V = {b: meshes[b][0].copy() for b in meshes}
    F = {b: meshes[b][1] for b in meshes}
    nb = {}

    def samples(x):
        P = maps[x](L.P[x])
        return P + carry(L, x, V[x] - V0[x])
    out = {}
    for (a, b), margin in pairs.items():
        before = None
        for it in range(iters + 1):
            Ta = TriMesh(V[a], F[a], k=8); Tb = TriMesh(V[b], F[b], k=8)
            res = []
            for x, Ty in ((a, Tb), (b, Ta)):
                S = samples(x)
                sd, q, _, _ = Ty.signed_full(S)
                res.append((x, S, sd, q))
            gap = float(min(r[2].min() for r in res))
            if before is None: before = gap
            if gap >= margin - 2e-5 or it == iters: break
            for x, S, sd, q in res:
                m = sd < margin
                if not m.any(): continue
                d = S[m] - q[m]
                u = d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-12) * np.sign(sd[m])[:, None]
                req = 0.5 * (margin - sd[m])[:, None] * u
                tri, w = sample_bary(L, x)
                tri, w = tri[m], np.clip(w[m], 0, 1)
                num = np.zeros_like(V[x]); den = np.zeros(len(V[x]))
                for k in range(3):
                    np.add.at(num, tri[:, k], w[:, k, None] * req); np.add.at(den, tri[:, k], w[:, k])
                fix = den > 1e-6
                D0 = np.zeros_like(V[x]); D0[fix] = num[fix] / den[fix, None]
                if x not in nb: nb[x] = _neighbours(F[x], len(V[x]))
                W, deg = nb[x]
                D = D0.copy()
                for _ in range(rings):
                    D = 0.5 * D + 0.5 * (W @ D) / deg[:, None]
                    D[fix] = D0[fix]
                V[x] = V[x] + D
        out[f'{a}-{b}'] = (round(before * 1e3, 2), round(gap * 1e3, 2))
    disp = {b: V[b] - V0[b] for b in meshes if np.abs(V[b] - V0[b]).max() > 0}
    if out: log(f'    push-out (closest approach of the samples before -> after, mm): {out}')
    return disp, out


def residual_pushout(L, maps, meshes, depth=0.3e-3, margin=0.15e-3, log=print):
    """push-out on the neighbouring bones (not the articulated joints, whose spaces the rigid passes set) that still
    interpenetrate by more than `depth` after the final pass."""
    joints = set(JOINT_BANDS)
    for dg, ch in CHAINS.items(): joints |= set(zip(ch[:-1], ch[1:]))
    pairs = {}
    for a, b in neighbour_pairs(L):
        if (a, b) in joints or (b, a) in joints: continue
        Ta = TriMesh(*meshes[a], k=8); Tb = TriMesh(*meshes[b], k=8)
        pen = max(-Tb.signed(maps[a](L.P[a])).min(), -Ta.signed(maps[b](L.P[b])).min())
        if pen > depth: pairs[(a, b)] = margin
    return pushout(L, maps, meshes, pairs, log=log)
