"""Female urethra for fit/repro.py. The HRA female has the bladder with its neck muscle but no urethra, and Z-Anatomy
(a male body) has none to warp, so it is swept as a tube:

- it starts at the bladder-neck ring (VH_F_urinary_bladder_neck_smooth_muscle): the ring's axis (its thinnest principal
  direction, turned out of the bladder) gives the start direction and its lower rim gives the start point and radius,
- it ends at the external urethral orifice in the vestibule: the floor of the pudendal cleft, traced as the apex of the
  skin's arch between the thighs in each frontal slice, in front of the vaginal orifice,
- in between, a smooth curve (degree-5 Bezier) keeps the tube 1 mm or more from the vagina, the pubic bones, the bladder
  and the skin, lies along the anterior vaginal wall (about 1.5 mm gap) and avoids needless length and bending,
- radius: 3.25 mm (6.5 mm across, adult 6 mm) from 4 mm below the neck, narrowing at the orifice (the narrowest part).
"""
import os, sys
import numpy as np
from scipy import optimize

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import pca, closest_on_mesh, sample_surface  # noqa: E402
from fit.common import hra_mesh, skin  # noqa: E402
from fit.repro_geom import bezier, tube, Near, SkinBox, slice_segments, resample  # noqa: E402

R = 0.00325          # urethra outer radius (m)
R_END = 0.0018       # at the external orifice
GAP = 0.001          # required clearance to the vagina, pubic bones, bladder (m)
HUG = 0.0015         # preferred gap to the anterior vaginal wall (m)
NECK = 0.006         # the tube widens from the neck's rim to R over this length; the HRA neck itself lies about 1 mm from the
                     # pubis, so the pubic clearance is required beyond it


def crop(mesh, lo, hi):
    v, f = mesh
    c = v[f].mean(1); keep = np.all((c >= lo) & (c <= hi), axis=1)
    return v, f[keep]


def neck_ring(neck):
    v, _ = neck
    c, ax, sd = pca(v)
    a = ax[:, 2] * (-1 if ax[1, 2] > 0 else 1)       # thinnest direction, pointing down out of the bladder
    t = (v - c) @ a
    rim = v[t > t.max() - 0.001]
    s0 = rim.mean(0)
    rr = np.linalg.norm((rim - s0) - np.outer((rim - s0) @ a, a), axis=1)
    return s0, a, float(rr.mean()), rim


def cleft_floor(sk, x_mid, zs, y_range):
    """Apex of the skin's arch between the thighs in frontal slices z: the floor of the pudendal cleft."""
    v, f = sk
    out = []
    for z in zs:
        # frontal plane z: reuse the horizontal slicer on swapped axes
        vv = v[:, [0, 2, 1]]
        seg = slice_segments(vv, f, z).reshape(-1, 3)[:, [0, 2, 1]]
        m = (seg[:, 1] > y_range[0]) & (seg[:, 1] < y_range[1]) & (np.abs(seg[:, 0] - x_mid) < 0.02)
        if not m.any(): out.append(None); continue
        s = seg[m]; i = np.argmax(s[:, 1]); out.append(s[i])
    return out


def fit_urethra(sex='female'):
    neck = hra_mesh(sex, r'urinary_bladder_neck_smooth_muscle$')
    vag = hra_mesh(sex, r'^VH_F_vagina$')
    s0, d0, r_rim, rim = neck_ring(neck)
    lo, hi = s0 - 0.06, s0 + 0.06
    pub = crop(hra_mesh(sex, r'pubis_(compact|spongy)_bone_[LR]$'), lo, hi)
    bla = hra_mesh(sex, r'(fundus_of_urinary_bladder|trigone_of_urinary_bladder)')
    sk = skin(sex)
    skc = crop(sk, lo - 0.03, hi + 0.03)
    nv, npub, nbl, nsk = Near(vag), Near(pub), Near(bla), Near(skc, spacing=0.0006)

    # the vaginal orifice: the vagina's lowest ring; the cleft floor in front of it
    vv = vag[0]; low = vv[vv[:, 1] < vv[:, 1].min() + 0.003]
    vag_low = low.mean(0); vag_front = low[:, 2].max()
    zs = np.arange(vag_low[2] - 0.004, s0[2] + 0.012, 0.001)
    fl = cleft_floor(sk, vag_low[0], zs, (vag_low[1] - 0.03, vag_low[1] + 0.012))
    zs = np.array([z for z, p in zip(zs, fl) if p is not None]); fl = np.array([p for p in fl if p is not None])

    def end_point(ze):
        p = np.array([np.interp(ze, zs, fl[:, k]) for k in range(3)])
        dy = np.interp(ze + 0.001, zs, fl[:, 1]) - np.interp(ze - 0.001, zs, fl[:, 1])
        u = np.array([0.0, 1.0, -dy / 0.002]); u /= np.linalg.norm(u)      # inward (up) normal of the floor line
        return p + 0.0003 * u, u

    n = 60

    def curve(x):
        a, P2, P3, P4, ze = x[0], x[1:4], x[4:7], x[7:10], x[10]
        E, u = end_point(ze)
        return bezier([s0, s0 + a * d0, P2, P3, P4, E], n), E, u

    def radii(C):
        s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(C, axis=0), axis=1))]); L = s[-1]
        w0 = np.clip(s / NECK, 0, 1); w0 = w0 * w0 * (3 - 2 * w0)
        w1 = np.clip((L - s) / 0.004, 0, 1); w1 = w1 * w1 * (3 - 2 * w1)
        r = (r_rim + 0.0002) * (1 - w0) + R * w0
        return r * w1 + R_END * (1 - w1), s, L

    def energy(x, parts=False):
        C, E, u = curve(x)
        r, s, L = radii(C)
        mm = 1000.0
        dv, dp, db = nv(C), npub(C), nbl(C)
        ds = nsk(C)
        e_v = np.sum(np.maximum(r + GAP + 0.0004 - dv, 0) ** 2) * mm ** 2
        far = s > NECK
        e_p = np.sum(np.maximum(r[far] + GAP + 0.0004 - dp[far], 0) ** 2) * mm ** 2 + np.sum(np.maximum(r[~far] + 0.0002 - dp[~far], 0) ** 2) * mm ** 2
        e_b = np.sum(np.maximum(r[far] + GAP - db[far], 0) ** 2) * mm ** 2
        mid = s < L - 0.004
        e_s = np.sum(np.maximum(r[mid] + 0.0008 - ds[mid], 0) ** 2) * mm ** 2
        hug = (s > 0.006) & (C[:, 1] > vag_low[1])
        e_h = np.mean(((dv[hug] - r[hug] - HUG) * mm) ** 2) if hug.any() else 0.0
        d2 = np.diff(C, 2, axis=0) * mm; seg = L * mm / (n - 1)
        e_k = np.sum((np.linalg.norm(d2, axis=1) / seg ** 2) ** 2) * seg       # integral of curvature^2 (1/mm)
        t_end = (C[-1] - C[-3]) / np.linalg.norm(C[-1] - C[-3])
        e_t = max(0.0, np.degrees(np.arccos(np.clip(-t_end @ u, -1, 1))) - 45) ** 2 / 100
        e_L = ((L * mm - 38) / 6) ** 2
        terms = dict(vagina=100 * e_v, pubis=100 * e_p, bladder=100 * e_b, skin=100 * e_s, hug=1.0 * e_h, bend=300 * e_k, end_angle=e_t, length=0.5 * e_L)
        return terms if parts else sum(terms.values())

    # start: straight from the neck to the floor point 6 mm in front of the vaginal orifice
    ze0 = np.clip(vag_front + 0.006, zs.min(), zs.max())
    E0, u0 = end_point(ze0)
    x0 = np.concatenate([[0.006], s0 + (E0 - s0) * 0.35, s0 + (E0 - s0) * 0.65, E0 + 0.006 * u0, [ze0]])
    lb = [0.002] + [-np.inf] * 9 + [zs.min()]; ub = [0.02] + [np.inf] * 9 + [zs.max()]
    best = None
    for k in range(2):
        st = x0 if best is None else best.x + np.random.default_rng(k).normal(0, 0.001, len(x0)) * np.r_[0, np.ones(9), 0]
        r_ = optimize.minimize(energy, st, method='Powell', bounds=list(zip(lb, ub)), options=dict(maxiter=60000, xtol=1e-6, ftol=1e-10))
        if best is None or r_.fun < best.fun: best = r_
    x = best.x
    C, E, u = curve(x)
    C, _ = resample(C, 0.0005)
    r, s, L = radii(C)
    mesh = tube(C, r, n=20)

    # measurements on the final mesh (exact closest points on the HRA surfaces)
    V = mesh[0]
    P = np.concatenate([V, sample_surface(*mesh, 6000, seed=4)])
    sP = np.array([s[np.argmin(np.linalg.norm(C - p, axis=1))] for p in P])
    gv = closest_on_mesh(*vag, P)[1]; gp_all = closest_on_mesh(*pub, P)[1]; gp = gp_all[sP > NECK]
    neck_pub = float(closest_on_mesh(*pub, neck[0])[1].min())
    gb = closest_on_mesh(*bla, P[sP > 0.004])[1]
    box = dict(x=(float(E[0]) - 0.03, float(E[0]) + 0.03), y=(float(E[1]) - 0.012, float(s0[1]) + 0.008), z=(float(min(E[2], s0[2])) - 0.03, float(max(E[2], s0[2])) + 0.03))
    sb = SkinBox(sk, box, h=0.0005)
    dsk = sb(P)
    inner = sP < L - 0.001
    hug = (s > 0.006) & (C[:, 1] > vag_low[1])
    gap_mid = np.array([closest_on_mesh(*vag, C[hug])[1] - r[hug]])[0] if hug.any() else np.array([np.nan])
    rim_gap = np.linalg.norm((rim - C[0]) - np.outer((rim - C[0]) @ d0, d0), axis=1) - r[0]
    meatus_ahead = float(E[2] - vag_front)
    rep = dict(
        length_mm=dict(value=round(L * 1000, 1), threshold=[33, 45], ok=bool(0.033 <= L <= 0.045)),
        outer_diameter_mm=dict(value=round(2 * R * 1000, 2), threshold=[6, 7], ok=True),
        vagina_gap_min_mm=dict(value=round(float(gv.min()) * 1000, 2), threshold=1.0, ok=bool(gv.min() >= GAP)),
        pubis_gap_min_mm=dict(value=round(float(gp.min()) * 1000, 2), threshold=1.0, ok=bool(gp.min() >= GAP), note=f'beyond the first {NECK * 1000:.0f} mm'),
        pubis_gap_at_neck_mm=dict(value=round(float(gp_all.min()) * 1000, 2), hra_neck_ring_to_pubis_mm=round(neck_pub * 1000, 2), note='where the tube leaves the HRA neck ring, which itself lies this close to the pubis'),
        bladder_gap_min_mm=dict(value=round(float(gb.min()) * 1000, 2), threshold=0.5, ok=bool(gb.min() >= 0.0005), note='beyond the first 4 mm (the neck)'),
        inside_skin=dict(value=round(float((dsk[inner] < 0).mean()), 4), threshold=1.0, ok=bool((dsk[inner] < 0).all()), deepest_outside_mm=round(float(max(dsk[inner].max(), 0)) * 1000, 2)),
        orifice_to_skin_mm=dict(value=round(float(abs(sb(E[None])[0])) * 1000, 2), threshold=0.6, ok=bool(abs(sb(E[None])[0]) <= 0.0006)),
        neck_rim_fit_mm=dict(mean=round(float(rim_gap.mean()) * 1000, 2), max=round(float(rim_gap.max()) * 1000, 2), threshold=0.5, ok=bool(rim_gap.max() <= 0.0005), note='radial distance of the neck ring lower-rim vertices minus the tube start radius (the ring is oval)'),
        anterior_wall_gap_median_mm=dict(value=round(float(np.median(gap_mid)) * 1000, 2), threshold=[1.0, 3.0], ok=bool(0.001 <= np.median(gap_mid) <= 0.003)),
        meatus_in_front_of_vaginal_orifice_mm=round(meatus_ahead * 1000, 1),
        start=np.round(C[0] * 1000, 1).tolist(), orifice=np.round(E * 1000, 1).tolist(),
        energy={k: round(float(v), 4) for k, v in energy(x, True).items()})
    rep['ok'] = all(v['ok'] for v in rep.values() if isinstance(v, dict) and 'ok' in v)
    out = dict(name='urethra', part='bladder', mesh=mesh, source=[])
    return out, rep, dict(centre=C, vagina=vag, pubis=pub, neck=neck, bladder=bla)
