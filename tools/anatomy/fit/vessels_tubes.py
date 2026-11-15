"""Limb and pelvic tubes for the vessels group (fit/vessels.py, the last review step, after the neck tubes): the iliac
arteries rebuilt as round tubes from the HRA aorta's openings through one shared crotch ring, the limb vessels the
push-out crushed swept round again, the axillary veins re-joined to the subclavian veins, and the HRA structures the
assembly inflates (lib/inflate.py) used as the obstacles they become. numpy + scipy only.

Why: the push-out (fit/vessels_fix.py) moves wall vertices one by one (Gaussian-spread). Between two obstacles it
squeezes a tube into a ribbon or folds it inside out: the iliac arteries at the aortic and iliac bifurcations (female
right common iliac p90 section aspect 4.3, the left internal iliac a 0.1 mm sheet, 25 % of it inside out; male right
common iliac up to 14.6:1), the brachial arteries, basilic and axillary veins, deep palmar arches, fibular arteries
(female left brachial artery 1.1 x 11 mm over 9 cm, although its Z-Anatomy source is round). Every move here is a move
of whole cross-sections.

Sweep (sweep_layout): each vertex keeps its Z-Anatomy place on the tube: its arc length (normalised between the two end
rings, so an oblique ring maps to one end) and its angle about the Z-Anatomy centreline (rotation-minimising frames),
read from the vessel's Z-Anatomy mesh, which is round. It goes to the circle of the target radius about the new course
at that arc length and angle (the twist between the frames read off the end rings); toward a held end ring the section
blends into the ring's own shape (geodesic distance on the Z-Anatomy mesh) and the ring itself stays where it is. Side
branches of the trunk (vertices beyond 1.35-1.75 x the trunk radius in Z-Anatomy) ride with their trunk section's centre,
and their own end rings stay where they are. A rebuilt ring (the iliacs' top rings) is a circle in the plane normal to
the course.

Course: the vessel's main-trunk centreline, smoothed (vessels_neck.smooth_course) except at its end rings, then routed
through free space by whole sections (vessels_neck.route: dynamic programming over 3 mm bins, each choosing an offset in
its section plane that trades the squared offset against the squared missing clearance of a ball of the target radius
and the squared change between bins), only over the stretches that lack clearance (plus 15 mm, faded over 10 mm):
bones 0.8 mm, the skin 1.5 mm (a limb vessel stays inside it), organs 0.3 mm, the HRA aorta and veins and the companion
placed vessels 0.5 mm (an artery: the veins; a vein: the arteries).

1. Iliac arteries (iliac_tubes), per side: the common iliac's top ring is rebuilt as a circle seated in the HRA
   descending aorta's opening on that side (centre SEAT_IN inside the opening's rim, radius SEAT_K x the opening's, in
   the opening's plane), and its course leaves the opening along the opening's axis (Hermite) into its own smoothed
   centreline; its calibre widens from the opening's to the pelvic_calibres target over CIA_TOP_BLEND, and its distal
   ring is rebuilt as the crotch ring: a circle of that calibre normal to the course's end. The external and internal
   iliacs both start on that same circle (centre, plane and radius: one shared crotch ring), their courses leaving it
   along the common iliac's end axis (Hermite over CHILD_LEAD) into their own smoothed centrelines; the external iliac
   narrows to its target over EIA_TAPER, the internal iliac to its target (about 5 mm) over IIA_TAPER; their distal
   rings (the femoral artery's ring; the internal iliac's end) stay where they are. The female uterine artery bridges
   (vessels_review.bridges) are then rebuilt onto the new internal iliacs.
2. Limb vessels (limb_tubes): every arm and leg artery and vein (the subclavians excepted: fit/vessels_neck.py) whose
   sections 8 mm in from its end rings are flatter than LIMB_TRIGGER (p90 or max aspect) is swept round at its own
   calibre (the median area-equivalent diameter of its round Z-Anatomy sections, smoothed along the vessel), both end
   rings held, along its smoothed and routed course (bones, skin, companions). This also replaces the superficial veins'
   1.5 mm skin rule by a move of whole sections. A sweep is kept when it is rounder, goes no deeper into a bone than
   before (PEN_TOL), keeps the vessel inside the skin and keeps its junctions passing.
3. Subclavian -> axillary vein (join_axillary): the axillary vein's medial ring is moved onto the subclavian vein's
   lateral ring (the neck steps re-route the subclavian vein with only its venous-angle end held): centre, plane and
   radius, the move faded out along the axillary vein over L_JOIN (raised cosine of geodesic distance; the section is
   scaled about its centreline point), before the limb sweep (which routes the moved stretch out of bone).
4. Inflated HRA (hra_source): where lib/inflate.py has a cache for the body (male: the descending aorta at adult calibre,
   the renal veins and the inferior vena cava pushed out of it), the vessels fit reads those meshes instead of the HRA
   ones for the aorta tube, the inferior vena cava tube and the HRA vein tubes (VESSELS_INFLATED=0 switches it off).
"""
import os
import numpy as np
from scipy.spatial import cKDTree

from fit import vessels_geom as G
from fit import vessels_review as RV
from fit import vessels_neck as NK
from fit import vessels_sep as SP

r2 = NK.r2

SEAT_IN = 0.0010        # the common iliac's top ring centre this far inside the aortic opening (m)
SEAT_K = 0.90           # ... and its radius this fraction of the opening's
CIA_TOP_BLEND = 0.025   # the common iliac widens from the opening's radius to its calibre over this length (m)
CHILD_LEAD = 0.012      # external / internal iliac courses leave the crotch ring along the common iliac's end axis (m)
EIA_TAPER = 0.015       # the external iliac narrows from the crotch ring to its calibre over this length (m)
IIA_TAPER = 0.010       # the internal iliac narrows from the crotch ring to its calibre over this length (m)
CIA_LEAD = 0.028        # the common iliac's course leaves the opening along its axis into its own centreline (m)
LIMB_TRIGGER = (1.8, 3.0)   # (p90, max) section aspect above which a limb vessel is swept round again
LIMB_ART, LIMB_VEIN = 2.0, 2.5   # limb roundness criteria (p90 section aspect, 8 mm in from the rings)
PELVIC_ASPECT, PELVIC_INVERTED = 2.0, 0.005   # pelvic criteria: p90 section aspect; inside-out share of the surface
PEN_TOL = 0.0003        # a sweep may go at most this much deeper into a bone than before (m)
SKIN_CLEAR = 0.0015     # limb vessels stay this far inside the skin (m)
L_JOIN = 0.030          # axillary vein: the re-snap of its medial ring fades out over this length (m) ...
L_JOIN_FULL = 0.018     # ... after acting whole over this first stretch (the stretch its junction angle is measured on)
LIMB_GRID = np.arange(-0.008, 0.00801, 0.001)
TRIM = 0.008            # sections this close to an end ring are junction sections (not measured)


# ------------------------------------------------------------------------------------------------ inflated HRA
_INFL = {}


class _Inflated:
    """source(f'hra-{sex}') with the inflated structures (lib/inflate.py) in place of the HRA ones."""

    def __init__(self, S, m):
        self.S, self.m, self.by_name = S, m, S.by_name

    def get(self, name):
        return self.m[name] if name in self.m else self.S.get(name)


def inflated(sex):
    """{HRA name: (v, f)} of the inflated structures, or {} (no cache, switched off, or an error: recorded)."""
    if sex in _INFL: return _INFL[sex]
    m = {}
    if os.environ.get('VESSELS_INFLATED', '1') != '0':
        try:
            from lib.inflate import inflated_hra
            m = dict(inflated_hra(sex))
            _INFL['info_' + sex] = dict(used=True, structures=sorted(m))
        except Exception as ex:  # noqa: BLE001
            _INFL['info_' + sex] = dict(used=False, error=repr(ex))
    else:
        _INFL['info_' + sex] = dict(used=False, note='switched off (VESSELS_INFLATED=0)')
    _INFL[sex] = m
    return m


def inflated_info(sex):
    inflated(sex)
    return _INFL.get('info_' + sex, {})


def hra_source(sex):
    from lib.mesh import source
    S = source(f'hra-{sex}')
    m = inflated(sex)
    return _Inflated(S, m) if m else S


# ------------------------------------------------------------------------------------------------ obstacles
class SkinShell:
    """The skin as an obstacle for vessels_sep.deficit_fn: signed distance from outside the body (positive inside it)."""
    lo = np.full(3, -np.inf)
    hi = np.full(3, np.inf)

    def __init__(self, skin):
        self.skin = skin

    def query(self, p, band=None):
        sd, g = self.skin(np.atleast_2d(p))
        return -sd, -g, None


def obstacles(n, VES, F, aorta, hra_veins, skin=False, organs=True, aorta_ok=True):
    obs, labels, names = NK.obstacles_for(n, VES, F, aorta if aorta_ok else None, hra_veins)
    if not organs:
        k = labels.index('organ'); obs.pop(k); labels.pop(k)
    if skin:
        obs.append((SkinShell(F.skin), SKIN_CLEAR)); labels.append('skin')
    return obs, labels, names


# ------------------------------------------------------------------------------------------------ layout and sweep
def layout_params(x, A, B):
    """Per vertex, from the vessel's Z-Anatomy mesh (round): normalised arc length u between rings A and B, angle th
    about the Z-Anatomy trunk centreline, trunk weight tw (0 on side branches), has (a Z-Anatomy counterpart), lay
    (Z-Anatomy positions, current ones where there is none). None when the layout cannot be read."""
    v, f = x['v'], x['f']; n = len(v)
    zv, zf = np.asarray(x['za_v'], float), np.asarray(x['za_f'])
    oi = x.get('orig_index')
    lay = np.full((n, 3), np.nan)
    if oi is None:
        if len(zv) != n: return None
        lay[:] = zv
    else:
        oi = np.asarray(oi); ok = (oi >= 0) & (oi < n); lay[oi[ok]] = zv[ok]
    has = np.isfinite(lay[:, 0])
    if has.mean() < 0.8: return None
    LZ = RV.end_loops(zv, zf)
    if len(LZ) < 2: return None

    def zc(R):
        h = has[R['idx']]
        return lay[R['idx']][h].mean(0) if h.any() else None
    ca, cb = zc(A), zc(B)
    if ca is None or cb is None: return None
    la = min(LZ, key=lambda l: np.linalg.norm(l['c'] - ca)); lb = min(LZ, key=lambda l: np.linalg.norm(l['c'] - cb))
    if la is lb: return None
    cl = G.trunk_centerline(zv, zf, la['idx'], lb['idx'])
    P = list(cl['p'][1:])
    while len(P) > 1 and np.linalg.norm(P[-1] - lb['c']) < 0.002: P.pop()
    Qz, sz = NK.resample(np.vstack([la['c']] + P + [lb['c']]))
    Tz, Uz, Wz = NK.frames(Qz)
    L0 = np.where(has[:, None], lay, 0.0)
    _, iz = cKDTree(Qz).query(L0)
    th, rz = NK.polar(L0 - Qz[iz], Tz[iz], Uz[iz], Wz[iz])
    # normalised arc length from the geodesic distances to the two end rings on the Z-Anatomy mesh: each ring maps to
    # exactly one end, smoothly (an oblique or D-shaped ring included)
    Gz = G.graph(np.where(has[:, None], lay, v), f)
    gA = G.geodesic(Gz, A['idx'].tolist()); gB = G.geodesic(Gz, B['idx'].tolist())
    okg = np.isfinite(gA) & np.isfinite(gB) & ((gA + gB) > 0)
    u = np.where(okg, gA / np.where(okg, gA + gB, 1.0), sz[iz] / sz[-1])
    step = 0.003
    b = np.minimum((u * sz[-1] / step).astype(int), int(sz[-1] / step))
    rb = np.full(b.max() + 1, np.nan)
    for k in range(len(rb)):
        m = has & (b == k)
        if m.sum() >= 3: rb[k] = np.median(rz[m])
    ok = np.isfinite(rb)
    if ok.sum() < 2: return None
    kk = np.arange(len(rb)); rb = np.interp(kk, kk[ok], rb[ok])
    tw = np.where(has, 1.0 - G.smoothstep((rz / np.maximum(rb[b], 1e-5) - 1.35) / 0.4), 0.0)
    if len(RV.end_loops(v, f)) <= 2: tw = np.ones(n)     # no side branches: every vertex is on the trunk
    # the trunk's own radius per bin from its trunk vertices only, kept within 0.6-1.4 x its median (a bin crowded by
    # side-branch vertices reads too wide)
    rb2 = np.full(len(rb), np.nan)
    for k in range(len(rb2)):
        m = has & (b == k) & (tw > 0.5)
        if m.sum() >= 3: rb2[k] = np.median(rz[m])
    ok2 = np.isfinite(rb2)
    if ok2.sum() >= 2:
        rb = np.interp(kk, kk[ok2], rb2[ok2])
    med = float(np.median(rb)); rb = np.clip(rb, 0.6 * med, 1.4 * med)
    # the trunk's own Z-Anatomy radius (m) along u (for the calibre)
    sk = (kk + 0.5) * step / sz[-1]
    return dict(u=u, th=th, tw=tw, has=has, lay=np.where(has[:, None], lay, v), rz=rz, rb=(np.clip(sk, 0, 1), rb), Lz=float(sz[-1]))


def sweep_layout(x, P, Qo, so, Qn, sn, rfun, A, B, lenA, lenB, rebuildA=False, rebuildB=False, hold=()):
    """New vertex positions (module docstring, 'Sweep'). rebuildA / rebuildB: that ring becomes the circle rfun(0) /
    rfun(L) normal to the course (no blend into its old shape, not held). hold: other rings (side-branch ends) kept."""
    v, f = x['v'], x['f']
    Tn, Un, Wn = NK.frames(Qn); L = sn[-1]
    u = P['u']; sp = u * L
    kn = np.clip(np.searchsorted(sn, sp), 0, len(sn) - 1)

    def ring_phase(R, k):
        idx = R['idx']; h = P['has'][idx]
        if not h.any(): return None
        m = len(idx)
        ta, _ = NK.polar(v[idx] - Qn[k], np.tile(Tn[k], (m, 1)), np.tile(Un[k], (m, 1)), np.tile(Wn[k], (m, 1)))
        return float(np.angle(np.mean(np.exp(1j * (ta[h] - P['th'][idx][h])))))
    phA = None if rebuildA else ring_phase(A, 0)
    phB = None if rebuildB else ring_phase(B, -1)
    if phA is None and phB is None: phA = phB = 0.0
    elif phA is None: phA = phB
    elif phB is None: phB = phA
    th = P['th'] + phA + u * np.angle(np.exp(1j * (phB - phA)))
    e = np.cos(th)[:, None] * Un[kn] + np.sin(th)[:, None] * Wn[kn]
    Gr = G.graph(P['lay'], f)

    def geo(R, lim):
        g = G.geodesic(Gr, R['idx'].tolist(), limit=lim + 0.01)
        return np.where(np.isfinite(g), g, 1.0)
    gA = geo(A, max(lenA, NK.RING_KEEP)); gB = geo(B, max(lenB, NK.RING_KEEP))
    a = np.zeros(len(v)) if rebuildA else RV.raised(gA / lenA)
    b = np.zeros(len(v)) if rebuildB else RV.raised(gB / lenB)
    tot = np.maximum(1.0, a + b); a = a / tot; b = b / tot
    R = (1 - a - b) * rfun(sp)
    if not rebuildA:
        nA = len(A['idx'])
        thA, rA = NK.polar(v[A['idx']] - Qn[0], np.tile(Tn[0], (nA, 1)), np.tile(Un[0], (nA, 1)), np.tile(Wn[0], (nA, 1)))
        R = R + a * NK.periodic(th, thA, rA)
    if not rebuildB:
        nB = len(B['idx'])
        thB, rB = NK.polar(v[B['idx']] - Qn[-1], np.tile(Tn[-1], (nB, 1)), np.tile(Un[-1], (nB, 1)), np.tile(Wn[-1], (nB, 1)))
        R = R + b * NK.periodic(th, thB, rB)
    vt = Qn[kn] + R[:, None] * e
    # side branches ride with their trunk section's centre (old course -> new course at the same normalised arc length)
    _, io = cKDTree(Qo).query(v)
    kno = np.clip(np.searchsorted(sn, so[io] / so[-1] * L), 0, len(sn) - 1)
    carry = v + (Qn[kno] - Qo[io])
    tw = P['tw']
    vn = tw[:, None] * vt + (1 - tw)[:, None] * carry
    keep = np.zeros(len(v))
    if not rebuildA: keep = np.maximum(keep, RV.raised(gA / NK.RING_KEEP))
    if not rebuildB: keep = np.maximum(keep, RV.raised(gB / NK.RING_KEEP))
    for R_ in hold:
        keep = np.maximum(keep, RV.raised(geo(R_, NK.RING_LEN) / NK.RING_LEN))
    return vn + keep[:, None] * (v - vn)


# ------------------------------------------------------------------------------------------------ courses
def lead_course(c0, t0, Qo, so, lead, straight=0.0):
    """A straight stretch of length `straight` from c0 along the unit tangent t0, then a Hermite curve into the old
    course at arc length `lead` (+ straight), then the old course: (Q, s)."""
    c0 = np.asarray(c0, float); t0 = G.unit(np.asarray(t0, float))
    k1 = int(np.clip(np.searchsorted(so, lead + straight), 1, len(so) - 2))
    P1 = Qo[k1]; T1 = G.unit(np.gradient(Qo, axis=0)[k1])
    c1 = c0 + straight * t0
    D = float(np.linalg.norm(P1 - c1))
    H = RV.hermite(c1, t0 * D, P1, T1 * D, step=0.0005)
    S0 = c0[None] + np.linspace(0.0, straight, max(2, int(straight / 0.0005) + 1))[:-1, None] * t0[None] if straight > 0 else np.zeros((0, 3))
    return NK.resample(np.vstack([S0, H[:-1], Qo[k1:]]))


def route_windowed(Q, s, hA, hB, rfun, deficit, grid=NK.GRID):
    """vessels_neck.route over the stretches that lack clearance (plus 15 mm, faded over 10 mm); the held ends stay."""
    nb = max(3, int(round(s[-1] / NK.RT_STEP)) + 1); sk = np.linspace(0.0, s[-1], nb)
    C = np.stack([np.interp(sk, s, Q[:, a]) for a in range(3)], 1)
    hold = NK.hold_profile(sk, s[-1], hA, hB)
    d = deficit(C, rfun(sk) + NK.PAD) * (hold > 0.02)
    if d.max() < 1e-4: return Q, s, float(d.max()), float(d.max()), 0.0
    bad = sk[d > 1e-4]
    dist = np.min(np.abs(sk[:, None] - bad[None]), axis=1)
    win = 1.0 - G.smoothstep((dist - 0.015) / 0.010)
    uk = sk / s[-1]
    wfun = lambda q: NK.hold_profile(q, q[-1], hA, hB) * np.interp(q / q[-1], uk, win)
    Q, s, d0, d1, sh = NK.route(Q, s, wfun, rfun, deficit, grid=grid)
    # the route's offsets can bend the course tighter than the tube's radius (a fold on the inside of the bend): the
    # routed stretch is smoothed again over twice the largest radius (at least 6 mm)
    sig = max(0.006, 2.0 * float(np.max(rfun(s))))
    Q, s = NK.smooth_course(Q, s, wfun(s), sigma=sig)
    nb2 = max(3, int(round(s[-1] / NK.RT_STEP)) + 1); sk2 = np.linspace(0.0, s[-1], nb2)
    C2 = np.stack([np.interp(sk2, s, Q[:, a]) for a in range(3)], 1)
    d2 = float((deficit(C2, rfun(sk2)) * (NK.hold_profile(sk2, s[-1], hA, hB) > 0.02)).max())
    return Q, s, d0, d2, sh


# ------------------------------------------------------------------------------------------------ measures
def section_metrics(v, f, start=None, trim=TRIM, step=0.003):
    """(p90 aspect, max aspect, sections flatter than 2, sections, worst 'width x minor' mm) over the sections `trim`
    in from the end rings (vessels_review.calibre_profile along the main trunk from the ring nearest `start`)."""
    cl = RV.trunk(v, f, start=start)
    if cl is None: return None
    rows = RV.calibre_profile(v, f, cl, step=step)
    L = cl['s'][-1]; rr = [r for r in rows if trim < r['s'] < L - trim]
    if not rr: return None
    a = np.array([r['aspect'] for r in rr]); w = max(rr, key=lambda r: r['aspect'])
    return dict(p90=r2(np.quantile(a, 0.9)), max=r2(a.max()), flat=int((a > 2).sum()), sections=len(a),
                worst_mm=f"{w['width'] * 1000:.1f} x {w['minor'] * 1000:.1f}", d_eq_median_mm=r2(np.median([r['d_eq'] for r in rr]) * 1000, 1),
                length_mm=r2(L * 1000, 0))


def inverted_share(v, f, n=1500, eps=3e-4, seed=0):
    """Share of the surface that is inside out: sampled face centres whose outer side (along the face normal) is inside
    the mesh and whose inner side is not (ray parity)."""
    from lib.mesh import RayParity, face_normals
    from fit.vessels import orient
    f = orient(v, np.asarray(f))
    a = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
    s = np.random.default_rng(seed).choice(len(f), min(n, len(f)), replace=False, p=a / a.sum())
    c = v[f[s]].mean(1); nn = face_normals(v, f[s]); r = RayParity(v, f)
    po, pi = r.inside(c + eps * nn), r.inside(c - eps * nn)
    return float((po & ~pi).mean())


def skin_max(v, F):
    return float(np.max(F.skin(v)[0]))


# ------------------------------------------------------------------------------------------------ 1. iliac arteries
def aortic_opening(j, side):
    hv, hf = j['hra_mesh']
    ends = [e for e in G.stub_ends(hv, hf, min_r=0.0015) if e['kind'] == 'open' and np.linalg.norm(e['c'] - j['end']['c']) < 0.03 and e['n'][1] < -0.3]
    if not ends: return None
    return max(ends, key=lambda e: e['n'][0]) if side == 'l' else min(ends, key=lambda e: e['n'][0])


def iliac_targets(sex, review):
    pc = (review or {}).get('pelvic_calibres') or {}
    out = {}
    for side in 'lr':
        c = pc.get(f'CIA_{side}', {}).get('target_mm'); e = pc.get(f'EIA_{side}', {}).get('target_mm'); i = pc.get(f'IIA_{side}', {}).get('target_mm')
        cia = (c or RV.CIA_MAX[sex] * 1000) / 2000
        eia = min((e or RV.PELVIC_D[sex]['EIA'] * 1000) / 2000, 0.95 * cia)
        iia = min((i or RV.PELVIC_D[sex]['IIA'] * 1000) / 2000, eia)
        out[side] = (cia, eia, iia)
    return out


def ring_pair(x, near):
    L = RV.end_loops(x['v'], x['f'])
    if len(L) < 2: return None
    for l in L: l['c'] = x['v'][l['idx']].mean(0)
    A = min(L, key=lambda l: np.linalg.norm(l['c'] - near))
    B = max([l for l in L if l is not A], key=lambda l: np.linalg.norm(l['c'] - A['c']))
    others = [l for l in L if l is not A and l is not B]
    return A, B, others


def contact_at(VES, n, R, tol=0.003):
    """Whether another placed vessel of the same part touches ring R of vessel n (within the ring radius + tol)."""
    x = VES[n]; P = x['v'][R['idx']]; c = P.mean(0); r = float(np.linalg.norm(P - c, axis=1).mean())
    for m, y in VES.items():
        if m == n or not y['placed'] or y.get('dropped') or y['part'] != x['part'] or y.get('bridge') is not None: continue
        if np.linalg.norm(y['v'] - c, axis=1).min() < r + tol: return True
    return False


def build_tube(n, x, A, B, others, Qn, sn, rfun, rebuildA, rebuildB, lenA=NK.RING_LEN, lenB=NK.RING_LEN):
    """Sweep vessel x along course (Qn, sn) (A at its start). Returns new vertices or None (no layout)."""
    P = layout_params(x, A, B)
    if P is None: return None
    Qo, so = NK.old_course(x, A, B)
    if Qo is None: return None
    return sweep_layout(x, P, Qo, so, Qn, sn, rfun, A, B, lenA, lenB, rebuildA=rebuildA, rebuildB=rebuildB, hold=others)


def iliac_tubes(sex, VES, J, F, aorta, hra_veins, review, log=print):
    from fit import vessels_measure as VM
    out = {}
    tg = iliac_targets(sex, review)
    for side in 'lr':
        cia_n, eia_n, iia_n = f'Common_iliac_artery{side}', f'External_iliac_artery{side}', f'Internal_iliac_artery{side}'
        if any(VES.get(k) is None or VES[k].get('dropped') or not VES[k]['placed'] for k in (cia_n, eia_n, iia_n)):
            out[side] = dict(skipped='iliac arteries not all placed'); continue
        jb = next((j for j in J if j['key'] == f'aortic_bifurcation:common_iliac_artery_{side}'), None)
        if jb is None: out[side] = dict(skipped='no aortic bifurcation junction'); continue
        op = aortic_opening(jb, side)
        if op is None: out[side] = dict(skipped='no aortic opening'); continue
        r_cia, r_eia, r_iia = tg[side]
        old = {k: VES[k]['v'].copy() for k in (cia_n, eia_n, iia_n)}
        before = {k: section_metrics(VES[k]['v'], VES[k]['f'], start=jb['end']['c']) for k in (cia_n, eia_n, iia_n)}
        inv_before = {k: r2(inverted_share(VES[k]['v'], VES[k]['f']) * 100, 1) for k in (cia_n, eia_n, iia_n)}
        Jn = [j for j in J if set(j.get('vessels', ())) & {cia_n, eia_n, iia_n}]
        jr0 = VM.junctions(Jn, VES)
        jb.pop('seat', None)
        info = dict(opening=dict(c=np.round(op['c'], 4).tolist(), r_mm=r2(op['r'] * 1000, 2), n=np.round(op['n'], 3).tolist()),
                    target_r_mm=dict(CIA=r2(r_cia * 1000, 2), EIA=r2(r_eia * 1000, 2), IIA=r2(r_iia * 1000, 2)))
        try:
            # ---- common iliac: from the opening to the crotch ring
            x = VES[cia_n]
            A, B, oth = ring_pair(x, jb['end']['c'])
            Qo, so = NK.old_course(x, A, B)
            rA = SEAT_K * op['r']; cA = op['c'] - SEAT_IN * op['n']
            # it leaves the opening along the opening's axis over the stretch its leaving axis is measured on (one radius
            # + 15 mm), then bends into its own course
            Ls = min(rA + 0.015, 0.3 * so[-1])
            Q, s = lead_course(cA, op['n'], Qo, so, max(CIA_LEAD, 0.55 * so[-1] - Ls), straight=Ls)
            hA = Ls + 0.002
            w = NK.hold_profile(s, s[-1], hA, NK.B_HOLD)
            Q, s = NK.smooth_course(Q, s, w, sigma=max(NK.COURSE_SIGMA, 2.0 * r_cia))    # no bend tighter than the tube
            rf_c = lambda t, rA=rA, rc=r_cia: rc + (rA - rc) * RV.raised(np.asarray(t, float) / CIA_TOP_BLEND)
            obs, labels, _ = obstacles(cia_n, VES, F, None, hra_veins)
            Q, s, d0, d1, sh = route_windowed(Q, s, hA, NK.B_HOLD, rf_c, SP.deficit_fn(obs))
            vn = build_tube(cia_n, x, A, B, oth, Q, s, rf_c, True, True)
            if vn is None: raise RuntimeError('common iliac: no Z-Anatomy layout')
            x['v'] = vn
            # the junction is now a chain onto the opening (vessels_measure.junctions measures it so)
            jb['seat'] = dict(c=np.asarray(op['c'], float), n=np.asarray(op['n'], float), r=float(op['r']))
            Tq = G.unit(np.gradient(Q, axis=0))
            cC, tC = Q[-1].copy(), Tq[-1].copy()
            info['CIA'] = dict(course_mm=r2(s[-1] * 1000, 1), route_deficit_mm=[r2(d0 * 1000, 1), r2(d1 * 1000, 1)], course_shift_mm=r2(sh * 1000, 1),
                               crotch=dict(c=np.round(cC, 4).tolist(), r_mm=r2(r_cia * 1000, 2)))
            # ---- external and internal iliac: from the crotch ring
            for nm, rt, taper, key in ((eia_n, r_eia, EIA_TAPER, 'EIA'), (iia_n, r_iia, IIA_TAPER, 'IIA')):
                y = VES[nm]
                A2, B2, oth2 = ring_pair(y, cC)
                # the internal iliac's distal end joins nothing placed (its branches are not modelled): rebuilt round and
                # smoothed to its end; the external iliac's distal ring is the femoral artery's and stays
                free = key == 'IIA' and not contact_at(VES, nm, B2)
                hB = 0.0005 if free else NK.B_HOLD
                Qo2, so2 = NK.old_course(y, A2, B2)
                Q2, s2 = lead_course(cC, tC, Qo2, so2, min(max(CHILD_LEAD, 0.3 * so2[-1]), 0.45 * so2[-1]))
                w2 = G.smoothstep((s2 - 0.003) / NK.HOLD_FADE) if free else NK.hold_profile(s2, s2[-1], 0.003, hB)
                Q2, s2 = NK.smooth_course(Q2, s2, w2, sigma=0.015 if free else max(NK.COURSE_SIGMA, 2.0 * rt))
                rf = lambda t, rc=r_cia, rt=rt, L=taper: rt + (rc - rt) * RV.raised(np.asarray(t, float) / L)
                obs2, lab2, _ = obstacles(nm, VES, F, aorta, hra_veins)
                Q2, s2, e0, e1, sh2 = route_windowed(Q2, s2, 0.004, hB, rf, SP.deficit_fn(obs2))
                # the course's first point is the crotch centre and its first tangent the common iliac's end axis
                vn2 = build_tube(nm, y, A2, B2, oth2, Q2, s2, rf, True, free)
                if vn2 is None: raise RuntimeError(f'{key}: no Z-Anatomy layout')
                y['v'] = vn2
                info[key] = dict(course_mm=r2(s2[-1] * 1000, 1), route_deficit_mm=[r2(e0 * 1000, 1), r2(e1 * 1000, 1)], course_shift_mm=r2(sh2 * 1000, 1),
                                 missing_clearance_after=NK.deficit_report(y, obs2, lab2))
            info['CIA']['missing_clearance_after'] = NK.deficit_report(x, obs, labels)
        except Exception as ex:  # noqa: BLE001
            import traceback; traceback.print_exc()
            for k, v0 in old.items(): VES[k]['v'] = v0
            jb.pop('seat', None)
            out[side] = dict(error=repr(ex), **info); continue
        after = {k: section_metrics(VES[k]['v'], VES[k]['f'], start=jb['end']['c']) for k in (cia_n, eia_n, iia_n)}
        inv_after = {k: r2(inverted_share(VES[k]['v'], VES[k]['f']) * 100, 1) for k in (cia_n, eia_n, iia_n)}
        jr1 = VM.junctions(Jn, VES)
        jfail = [r['key'] for r0_, r in zip(jr0, jr1) if (r0_['pass_gap'] and not r['pass_gap']) or (r0_.get('pass_angle') and r.get('pass_angle') is False)]
        pen = {k: NK.penetration(VES[k]['v'], F) for k in (cia_n, eia_n, iia_n)}
        info.update(sections_before=before, sections_after=after, inverted_pct_before=inv_before, inverted_pct_after=inv_after, penetration_mm_after=pen,
                    junctions=[dict(key=r['key'], gap_mm=[r0_['gap_mm'], r['gap_mm']], angle_deg=[r0_.get('angle_deg'), r.get('angle_deg')]) for r0_, r in zip(jr0, jr1)])
        if jfail:
            info['junction_fails'] = jfail
        info['kept'] = True
        out[side] = info
        log(f'  iliac tubes {side}: {info}')
    return out


# ------------------------------------------------------------------------------------------------ 3. subclavian -> axillary vein
def join_axillary(sex, VES, log=print):
    """Axillary vein's medial ring onto the subclavian vein's lateral ring (module docstring, 3)."""
    out = {}
    for side in 'lr':
        sn_ = ('Left' if side == 'l' else 'Right') + '_subclavian_vein'; an = f'Axillary_vein{side}'
        sv, ax = VES.get(sn_), VES.get(an)
        if sv is None or ax is None or sv.get('dropped') or ax.get('dropped'): continue
        Ls = RV.end_loops(sv['v'], sv['f']); La = RV.end_loops(ax['v'], ax['f'])
        if len(Ls) < 2 or len(La) < 2: continue
        d, ls, la = min(((np.linalg.norm(p['c'] - q['c']), p, q) for p in Ls for q in La), key=lambda t: t[0])
        cs, ns, rs = G.ring_frame(sv['v'][ls['idx']]); ca, na, ra = G.ring_frame(ax['v'][la['idx']])
        # both normals along the vein, toward the arm
        other_a = max(La, key=lambda l: np.linalg.norm(l['c'] - la['c']))['c']
        if ns @ (other_a - cs) < 0: ns = -ns
        if na @ (other_a - ca) < 0: na = -na
        before = dict(ring_centres_mm=r2(d * 1000, 1), r_mm=[r2(rs * 1000, 1), r2(ra * 1000, 1)],
                      ring_to_mesh_max_mm=r2(cKDTree(ax['v']).query(sv['v'][ls['idx']])[0].max() * 1000, 1))
        if d < 0.0005 and abs(rs - ra) < 0.0005:
            out[side] = dict(skipped='joined already', **before); continue
        cl = RV.trunk(ax['v'], ax['f'], start=ca)
        s, q, _, _, _ = RV.param(ax, cl)
        Gr = G.graph(ax['v'], ax['f'])
        g = G.geodesic(Gr, la['idx'].tolist(), limit=L_JOIN + 0.01); g = np.where(np.isfinite(g), g, 1.0)
        w = RV.raised(np.maximum(g - L_JOIN_FULL, 0.0) / L_JOIN)    # whole move over the first L_JOIN_FULL, then faded
        # rotation of the axillary vein's leaving axis onto the subclavian vein's axis there (both as the report measures
        # them: vessels_measure.start_frame) about the ring centre, scaled by w; radial scale toward rs; translation
        from fit import vessels_measure as VM
        t_a = VM.start_frame(ax['v'], ax['f'], la['c'])[2]; t_s = -VM.start_frame(sv['v'], sv['f'], ls['c'])[2]
        ax_ = np.cross(t_a, t_s); sa = np.linalg.norm(ax_); ang = np.arctan2(sa, t_a @ t_s)
        k = rs / max(ra, 1e-5)
        v = ax['v']
        vs = q + (1 + w * (k - 1))[:, None] * (v - q)
        if sa > 1e-9:
            ax_ = ax_ / sa
            th = w * ang
            p = vs - ca
            c_, s_ = np.cos(th)[:, None], np.sin(th)[:, None]
            p = p * c_ + np.cross(ax_, p) * s_ + ax_ * (p @ ax_)[:, None] * (1 - c_)
            vs = ca + p
        vs = vs + w[:, None] * (cs - ca)[None]
        ax['v'] = vs
        # the ring itself exactly onto the subclavian ring (each vertex at its own angle, at the subclavian ring's radius
        # there: the two rings coincide)
        Ls2 = RV.end_loops(ax['v'], ax['f']); l2 = min(Ls2, key=lambda l: np.linalg.norm(l['c'] - cs))
        U = G.unit(np.cross(ns, [1.0, 0, 0] if abs(ns[0]) < 0.9 else [0, 1.0, 0])); W = np.cross(ns, U)
        Ps = sv['v'][ls['idx']] - cs; ths = np.arctan2(Ps @ W, Ps @ U); rss = np.linalg.norm(Ps - np.outer(Ps @ ns, ns), axis=1)
        P = ax['v'][l2['idx']] - cs; P = P - np.outer(P @ ns, ns); tha = np.arctan2(P @ W, P @ U)
        ax['v'][l2['idx']] = cs + NK.periodic(tha, ths, rss)[:, None] * G.unit(P) + np.outer(NK.periodic(tha, ths, Ps @ ns), ns)
        ax['joined'] = True
        after = dict(ring_centres_mm=r2(np.linalg.norm(ax['v'][l2['idx']].mean(0) - cs) * 1000, 1),
                     ring_to_mesh_max_mm=r2(cKDTree(ax['v']).query(sv['v'][ls['idx']])[0].max() * 1000, 1),
                     max_shift_mm=r2(np.linalg.norm(ax['v'] - v, axis=1).max() * 1000, 1), turn_deg=r2(np.degrees(ang), 1))
        out[side] = dict(before=before, after=after)
        log(f'  axillary vein {side} onto the subclavian ring: {out[side]}')
    return out


def vein_chain_rows(VES):
    """Subclavian -> axillary vein junctions, measured as chain junctions: gap between the ring centres, angle between
    the two veins' axes there (each over one radius + 15 mm of its centreline from the shared ring)."""
    from fit import vessels_measure as VM
    rows = []
    for side in 'lr':
        sn_ = ('Left' if side == 'l' else 'Right') + '_subclavian_vein'; an = f'Axillary_vein{side}'
        sv, ax = VES.get(sn_), VES.get(an)
        if sv is None or ax is None: continue
        Ls = RV.end_loops(sv['v'], sv['f']); La = RV.end_loops(ax['v'], ax['f'])
        if not Ls or not La: continue
        d, ls, la = min(((np.linalg.norm(p['c'] - q['c']), p, q) for p in Ls for q in La), key=lambda t: t[0])
        c1, r1, t1 = VM.start_frame(ax['v'], ax['f'], la['c'])
        c2, r2_, t2 = VM.start_frame(sv['v'], sv['f'], ls['c'])
        gap = float(np.linalg.norm(la['c'] - ls['c']))
        ang = G.angle_deg(t1, -t2)
        rows.append(dict(key=f'subclavian_axillary_vein_{side}', kind='chain', part='veins', vessels=[sn_, an], gap_mm=r2(gap * 1000, 2),
                         angle_deg=r2(ang, 1), r_mm=[r2(ls['r'] * 1000, 1), r2(la['r'] * 1000, 1)],
                         ring_to_mesh_max_mm=r2(cKDTree(ax['v']).query(sv['v'][ls['idx']])[0].max() * 1000, 1),
                         pass_gap=bool(gap <= VM.GAP_MAX), pass_angle=bool(ang <= VM.ANGLE_MAX)))
    return rows


# ------------------------------------------------------------------------------------------------ 2. limb vessels
SKIP_LIMB = ('subclavian',)


def limb_candidates(VES):
    out = []
    for n, x in VES.items():
        if not x['placed'] or x.get('dropped') or x.get('region') not in ('arm', 'leg') or any(k in n.lower() for k in SKIP_LIMB): continue
        m = section_metrics(x['v'], x['f'])
        if m is None: continue
        # an axillary vein moved onto its subclavian ring (join_axillary) is routed out of bone again
        if m['p90'] > LIMB_TRIGGER[0] or m['max'] > LIMB_TRIGGER[1] or x.get('joined'): out.append((n, m))
    return out


def own_radius(P, rfloor=0.0006):
    """Target radius along normalised arc length from the Z-Anatomy trunk radius (bins, smoothed)."""
    uk, rb = P['rb']
    K = np.exp(-0.5 * ((uk[:, None] - uk[None]) * P['Lz'] / 0.006) ** 2); rb = (K @ rb) / K.sum(1)
    rb = np.maximum(rb, rfloor)
    return uk, rb


def retube_limb(sex, n, VES, J, F, aorta, hra_veins, log=print):
    from fit import vessels_measure as VM
    x = VES[n]
    L = RV.end_loops(x['v'], x['f'])
    if len(L) < 2: return dict(skipped='fewer than two end rings')
    cl = RV.trunk(x['v'], x['f'])
    if cl is None: return dict(skipped='no trunk')
    A, B, oth = ring_pair(x, cl['p'][0])
    P = layout_params(x, A, B)
    if P is None: return dict(skipped='no Z-Anatomy layout')
    Qo, so = NK.old_course(x, A, B)
    if Qo is None: return dict(skipped='no course')
    uk, rb = own_radius(P)
    mb = section_metrics(x['v'], x['f'])
    # the target radius is Z-Anatomy's trunk radius; where that reads far wider than the vessel's own calibre (a trunk
    # through a confluence) it is scaled down to the vessel's median area-equivalent diameter
    if mb is not None and 2 * np.median(rb) > 1.4 * mb['d_eq_median_mm'] / 1000:
        rb = rb * (mb['d_eq_median_mm'] / 1000) / (2 * np.median(rb))
    Lo = so[-1]
    rfun = lambda t, uk=uk, rb=rb, Lo=Lo: np.interp(np.asarray(t, float) / Lo, uk, rb)
    v_old = x['v'].copy()
    pen0 = NK.penetration(v_old, F)['bone']; sk0 = skin_max(v_old, F)
    Jn = [j for j in J if n in j.get('vessels', ())]
    jr0 = VM.junctions(Jn, VES) if Jn else []
    obs, labels, _ = obstacles(n, VES, F, aorta, hra_veins, skin=True, organs=False)
    deficit = SP.deficit_fn(obs)
    hA = 0.004
    w = NK.hold_profile(so, Lo, hA, NK.B_HOLD)
    Q, s = NK.smooth_course(Qo, so, w)
    Q, s, d0, d1, sh = route_windowed(Q, s, hA, NK.B_HOLD, rfun, deficit, grid=LIMB_GRID)
    rf = lambda t, uk=uk, rb=rb, L=s[-1]: np.interp(np.asarray(t, float) / L, uk, rb)
    x['v'] = sweep_layout(x, P, Qo, so, Q, s, rf, A, B, NK.RING_LEN, NK.RING_LEN, hold=oth)
    ma = section_metrics(x['v'], x['f'])
    pen1 = NK.penetration(x['v'], F)['bone']; sk1 = skin_max(x['v'], F)
    jr1 = VM.junctions(Jn, VES) if Jn else []
    jfail = [r['key'] for r0_, r in zip(jr0, jr1) if (r0_['pass_gap'] and not r['pass_gap']) or (r0_.get('pass_angle') and r.get('pass_angle') is False)]
    # a vessel with side branches may keep a flat section where the trunk's section cuts a branch's mouth (its max)
    rounder = ma is not None and mb is not None and ma['p90'] < mb['p90'] and (bool(oth) or ma['max'] <= max(mb['max'], LIMB_VEIN))
    deeper = pen1 > pen0 + PEN_TOL * 1000
    outside = sk1 > max(sk0, -0.0002)
    ok = rounder and not deeper and not outside and not jfail
    info = dict(kept=bool(ok), sections_before=mb, sections_after=ma, target_d_mm=[r2(2 * rb.min() * 1000, 1), r2(2 * np.median(rb) * 1000, 1), r2(2 * rb.max() * 1000, 1)],
                bone_mm=[pen0, pen1], skin_max_signed_mm=[r2(sk0 * 1000, 2), r2(sk1 * 1000, 2)], route_deficit_mm=[r2(d0 * 1000, 1), r2(d1 * 1000, 1)],
                course_shift_mm=r2(sh * 1000, 1), max_vertex_shift_mm=r2(np.linalg.norm(x['v'] - v_old, axis=1).max() * 1000, 1),
                side_branch_rings=len(oth))
    if jfail: info['junction_would_fail'] = jfail
    if deeper: info['deeper_into_bone'] = True
    if outside: info['outside_skin'] = True
    if not ok: x['v'] = v_old
    return info


def limb_tubes(sex, VES, J, F, aorta, hra_veins, log=print):
    out = {}
    cand = limb_candidates(VES)
    log(f'  limb tubes: {[(n, m["p90"], m["max"]) for n, m in cand]}')
    for n, m in sorted(cand, key=lambda c: c[0]):
        try:
            out[n] = retube_limb(sex, n, VES, J, F, aorta, hra_veins, log=log)
        except Exception as ex:  # noqa: BLE001
            import traceback; traceback.print_exc()
            out[n] = dict(error=repr(ex))
        log(f'  limb tube {n}: {out[n]}')
    return out


# ------------------------------------------------------------------------------------------------ the step
def tubes(sex, VES, J, F, aorta=None, hra_veins=None, review=None, log=print):
    """The whole step (module docstring): iliacs, axillary vein joins, limb vessels; then the female uterine artery
    bridges rebuilt onto the new internal iliacs."""
    out = dict(inflated=inflated_info(sex))
    out['iliac'] = iliac_tubes(sex, VES, J, F, aorta, hra_veins, review, log=log)
    out['axillary_join'] = join_axillary(sex, VES, log=log)
    out['limb'] = limb_tubes(sex, VES, J, F, aorta, hra_veins, log=log)
    keys = [k for k, *_ in RV.BRIDGES if sex in _[-1] and k in VES]
    if keys and any(isinstance(v, dict) and v.get('kept') for v in out['iliac'].values()):
        try:
            b = RV.bridges(sex, VES, log=log)
            RV.settle_bridges(F, VES, list(b), log=log)
            out['bridges_rebuilt'] = b
        except Exception as ex:  # noqa: BLE001
            out['bridges_rebuilt'] = dict(error=repr(ex))
    return out


def measure(sex, VES, names, J):
    """Report rows: pelvic sections and inside-out share, limb roundness, fork rings inside the stub lumen."""
    pel = {}
    for n in names:
        if VES[n]['part'] != 'arteries' or not any(k in n for k in ('Common_iliac_artery', 'External_iliac_artery', 'Internal_iliac_artery')): continue
        m = section_metrics(VES[n]['v'], VES[n]['f'])
        if m is None: continue
        m['inverted_pct'] = r2(inverted_share(VES[n]['v'], VES[n]['f']) * 100, 2)
        pel[n] = m
    limb = {}
    for n in names:
        x = VES[n]
        if x.get('region') not in ('arm', 'leg') or any(k in n.lower() for k in SKIP_LIMB): continue
        m = section_metrics(x['v'], x['f'])
        if m is None: continue
        m['threshold'] = LIMB_ART if x['part'] == 'arteries' else LIMB_VEIN
        limb[n] = m
    return dict(pelvic=pel, limb=limb)


def fork_rings(J, VES):
    """Fork junctions: every vertex of each child's start ring against the stub's capped lumen (max distance outside)."""
    from lib.mesh import cap_holes
    rows = {}
    for j in J:
        if j['kind'] != 'fork': continue
        hv, hf = j['hra_mesh']
        cv, cf = cap_holes(hv, hf)
        T = G.TriSet(cv, cf)
        for k in j['vessels']:
            x = VES.get(k)
            if x is None or x.get('dropped'): continue
            L = RV.end_loops(x['v'], x['f'])
            if not L: continue
            l = min(L, key=lambda l: np.linalg.norm(l['c'] - j['end']['c']))
            sd, _ = T.signed(x['v'][l['idx']], band=0.05)
            rows[f"{j['key']}|{k}"] = dict(key=j['key'], vessel=k, ring_outside_max_mm=r2(max(0.0, float(np.max(sd))) * 1000, 2),
                                          ring_vertices=len(l['idx']))
    return rows
