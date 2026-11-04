"""Erectile bodies of the penis for fit/repro.py (male): the Z-Anatomy corpora cavernosa, corpus spongiosum and glans,
carried into the Visible Human penis along its urethra.

The trunk warp places the pelvis well but not the penis: the cadaver's flaccid penis runs forward under the symphysis
for longer and hangs in front of the scrotum, while the warped Z-Anatomy one bends down about 3 cm further back, into
the scrotum. So the bodies follow the urethra, which runs through the corpus spongiosum in both datasets:

1. Centre lines of the HRA urethra (VH_M_other_urethra, from the apex of the prostate to the meatus) and of the warped
   Z-Anatomy urethra are matched by arc length between three landmarks found the same way on both: the infrapubic bend
   (where the urethra turns from descending to running forward, entering the bulb), the penile angle (where it turns
   down again, the root of the pendulous part) and the meatus.
2. Each curve carries rotation-minimising frames (tangent, lateral, dorsal). A vertex is moved by the Gaussian-weighted
   blend of the rigid frame-to-frame maps of the urethra samples near it (smooth skinning along the urethra), so the
   urethra lands on the spongiosum's centre line and the cross-sections keep their shape and arrangement (corpora
   dorsal, spongiosum ventral round the urethra).
3. The crura are fixed to the ischiopubic rami, where the trunk warp is accurate: corpus cavernosum vertices far from the
   urethra blend back to their warped position (smooth falloff 12-30 mm).
4. In the pendulous part each cross-section is scaled (separately left, right, dorsal; and ventral where skin bounds it)
   so the bodies' outline lies GAP inside the skin, with factors smoothed along the shaft; the bulb and root keep their
   warped size.
"""
import os, sys
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import sample_surface, signed_volume, closest_on_mesh  # noqa: E402
from fit.common import get_warp, hra_mesh, za_whole, skin, Solid, FIT  # noqa: E402
from fit.repro_geom import centreline, frames, resample, SkinBox, LocalSDF  # noqa: E402

GAP = 0.0015          # skin, dartos and Buck's fascia between the erectile bodies and the outside (m)
SIGMA = 0.005         # width of the skinning weights along the urethra (m)
CRUS = (0.012, 0.030) # corpus cavernosum vertices this far from the urethra blend back to the trunk warp (m)
MEATUS = 0.002        # the HRA urethra runs this far past the glans tip, to the preputial opening (m)
ROOT = (0.005, 0.020) # past the infrapubic bend the bodies fade from the trunk warp (bulb, crura) to the urethra map (m)
KMIN = 0.5            # smallest cross-section scale (the Z-Anatomy glans corona is wider than the cadaver's penis)
BONE_CLEAR = 0.0005   # erectile bodies pushed this far out of the pubic and ischial bones (m)
BOX = dict(x=(-0.045, 0.05), y=(-0.118, -0.015), z=(0.03, 0.135))
NAMES = ['Corpus_cavernosum_of_penis', 'Corpus_spongiosum_of_penis', 'Glans_penis', 'Urethra']


def orient(v, f):
    return (v, f[:, ::-1].copy()) if signed_volume(v, f) < 0 else (v, f)


def bends(C):
    """Arc length of the infrapubic bend (tangent turns from down to forward past 45 degrees) and of the penile angle
    (turns back down past 45 degrees after running forward)."""
    T = np.gradient(C, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    k = np.ones(7) / 7; tz, ty = np.convolve(T[:, 2], k, 'same'), np.convolve(T[:, 1], k, 'same')
    phi = np.degrees(np.arctan2(tz, -ty))
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(C, axis=0), axis=1))]
    i1 = int(np.argmax(phi >= 45)); i_fw = i1 + int(np.argmax(phi[i1:] >= 70))
    i2 = i_fw + int(np.argmax(phi[i_fw:] <= 45))
    return s, float(s[i1]), float(s[i2]), phi


def ray_exit(sdf, p, d, rmax=0.04, step=0.00025):
    r = np.arange(step, rmax, step)
    P = p[None] + r[:, None] * d[None]
    out = sdf(P) > 0
    return float(r[np.argmax(out)]) if out.any() else rmax


def fit_penis(sex, testes):
    """testes: list of fitted testis meshes (kept clear of). Returns outputs, report, aux (for QA)."""
    warp = get_warp(sex, 'trunk')
    za = {o['name']: None for o in za_whole('za-visceral', r'^(' + '|'.join(NAMES) + r')$')}
    from lib.mesh import source
    src = source('za-visceral')
    W = {n: (warp(src.get(n)[0]), src.get(n)[1]) for n in NAMES if n in za}
    for n in ('Corpus_cavernosum_of_penis', 'Corpus_spongiosum_of_penis', 'Glans_penis'): W[n] = subdivide(*W[n])
    hu = hra_mesh(sex, r'other_urethra$')
    Ch = centreline(*hu, hu[0][np.argmax(hu[0][:, 1])], step=0.001)
    Ch, _ = resample(Ch, 0.0005)
    zu = W['Urethra']
    Cz = centreline(*zu, zu[0][np.argmax(zu[0][:, 1])], step=0.001)
    Cz = Cz[int(np.argmin(np.linalg.norm(Cz - Ch[0], axis=1))):]
    Cz, _ = resample(Cz, 0.001)
    sh, h1, h2, _ = bends(Ch); sz, z1, z2, _ = bends(Cz)
    # the skeleton: in the shaft the centre line of the Z-Anatomy spongiosum (its urethra runs eccentric, near the
    # ventral surface), so the HRA urethra ends up on the spongiosum's centre line; in the bulb (where the urethra
    # really is dorsal) and in the glans the Z-Anatomy urethra itself, with smooth transitions
    Tz0 = np.gradient(Cz, axis=0); Tz0 /= np.linalg.norm(Tz0, axis=1, keepdims=True)
    sp = W['Corpus_spongiosum_of_penis']
    offs = np.full((len(Cz), 3), np.nan)
    for j in range(len(Cz)):
        if z1 + ROOT[1] <= sz[j]:
            c = section_centroid(*sp, Cz[j], Tz0[j])
            if c is not None: offs[j] = c - Cz[j]
    ok = ~np.isnan(offs[:, 0]) & (np.linalg.norm(np.nan_to_num(offs), axis=1) < 0.006)
    s_end = sz[ok].max() if ok.any() else sz[-1]
    for a in range(3): offs[:, a] = np.interp(sz, sz[ok], offs[ok, a]) if ok.any() else 0
    for _ in range(4): offs[1:-1] = 0.25 * offs[:-2] + 0.5 * offs[1:-1] + 0.25 * offs[2:]
    b_in = np.clip((sz - z1 - ROOT[1]) / 0.015, 0, 1); b_out = np.clip((s_end - 0.002 - sz) / 0.008, 0, 1)
    beta = (b_in * b_in * (3 - 2 * b_in)) * (b_out * b_out * (3 - 2 * b_out))
    Cz = Cz + beta[:, None] * offs
    recentre_mm = float(np.linalg.norm(offs[beta > 0.99], axis=1).mean() * 1000) if (beta > 0.99).any() else 0.0
    # the meatus opens at the tip of the glans, under the prepuce: the HRA urethra's last 2 mm reach the skin
    kz = [0, z1, z2, sz[-1]]; kh = [0, h1, h2, sh[-1] - MEATUS]
    m = np.interp(sz, kz, kh)                                   # matched HRA arc length of each Z-Anatomy sample
    ih = np.clip(np.round(m / 0.0005).astype(int), 0, len(Ch) - 1)
    Tz, Nz, Bz = frames(Cz, ref=(1, 0, 0)); Th, Nh, Bh = frames(Ch, ref=(1, 0, 0))
    Fz = np.stack([Tz, Nz, Bz], 2); Fh = np.stack([Th, Nh, Bh], 2)[ih]      # columns: tangent, lateral (+x), dorsal

    def local(p):
        d2 = ((p[:, None, :] - Cz[None]) ** 2).sum(2)
        w = np.exp(-(d2 - d2.min(1, keepdims=True)) / (2 * SIGMA ** 2)); w /= w.sum(1, keepdims=True)
        q = np.einsum('pjk,jkl->pjl', p[:, None, :] - Cz[None], Fz)       # (t, u, v) in each sample's frame
        return w, q, np.sqrt(d2.min(1))

    def place(w, q, K=None):
        if K is not None:
            u, v = q[..., 1], q[..., 2]
            a = (np.arctan2(v, u) % (2 * np.pi)) / (np.pi / 4); a0 = np.floor(a).astype(int) % 8; t = a - np.floor(a)
            k = K[ih[None, :], a0] * (1 - t) + K[ih[None, :], (a0 + 1) % 8] * t
            q = np.stack([q[..., 0], u * k, v * k], -1)
        return np.einsum('pj,pjk->pk', w, Ch[ih][None] + np.einsum('jkl,pjl->pjk', Fh, q))

    # first pass (no skin scaling) on dense surface samples, to measure the bodies' extent in each HRA cross-section
    names = {'cavernosum': 'Corpus_cavernosum_of_penis', 'spongiosum': 'Corpus_spongiosum_of_penis', 'glans': 'Glans_penis'}
    samp = {k: sample_surface(*W[n], 6000, seed=5) for k, n in names.items()}
    L = {k: local(P) for k, P in samp.items()}
    sk = skin(sex); sb = SkinBox(sk, BOX, h=0.0005)
    s_pend = h2 - 0.01                                           # the skin fit starts 1 cm before the penile angle
    def placed(k):
        w, q, _ = L[k]; g = np.clip(((w * sz[None]).sum(1) - z1 - ROOT[0]) / (ROOT[1] - ROOT[0]), 0, 1); g = g * g * (3 - 2 * g)
        return place(w, q) * g[:, None] + samp[k] * (1 - g[:, None])
    P1 = np.concatenate([placed(k) for k in names])
    tree = cKDTree(Ch); di, ii = tree.query(P1)
    loc = np.einsum('pk,pkl->pl', P1 - Ch[ii], np.stack([Th, Nh, Bh], 2)[ii])
    tsdf = [LocalSDF(t, h=0.0005) for t in testes]
    K = np.ones((len(Ch), 8)); raw = []
    ang = np.arctan2(loc[:, 2], loc[:, 1]); rad = np.hypot(loc[:, 1], loc[:, 2])
    for i in range(len(Ch)):
        if sh[i] < s_pend: continue
        sel = np.abs(ii - i) <= 4
        if sel.sum() < 20: continue
        k = np.ones(8); ext = np.zeros(8); R = np.zeros(8)
        for a in range(8):
            th = a * np.pi / 4; d = np.cos(th) * Nh[i] + np.sin(th) * Bh[i]
            near = sel & (np.abs((ang - th + np.pi) % (2 * np.pi) - np.pi) < np.pi / 8)
            ext[a] = rad[near].max() if near.any() else 0.0
            R[a] = ray_exit(sb, Ch[i], d)
            if a in (5, 6, 7) or ext[a] <= 0: continue          # ventral: the penis lies on the scrotum (no skin)
            x = (R[a] - GAP) / ext[a]
            # grow only toward skin within reach (the root inside the body is not bounded: keep its size), easing back
            # to 1 between ratios 1.4 and 1.8
            k[a] = np.clip(x if x <= 1.4 else max(1.0, 1.4 - (x - 1.4)), KMIN, 1.4)
        # mirror symmetry about the dorsoventral plane (the corpora are paired about the spongiosum); the ventrolateral
        # directions take the lateral factor half way, the ventral keeps the warped size
        for a, b in ((0, 4), (1, 3)): k[a] = k[b] = min(k[a], k[b])
        k[5] = k[7] = 0.5 * (1 + k[0]); k[6] = 1.0
        K[i] = k; raw.append(dict(s_mm=round(sh[i] * 1000, 1), extent_mm=np.round(ext * 1000, 1).tolist(), room_mm=np.round(R * 1000, 1).tolist(), k=np.round(k, 2).tolist()))
    # smooth the factors along the shaft and fade them in over the penile angle
    on = sh >= s_pend
    for a in range(8):
        x = K[:, a].copy()
        for _ in range(3): x[1:-1] = np.where(on[1:-1], 0.25 * x[:-2] + 0.5 * x[1:-1] + 0.25 * x[2:], x[1:-1])
        fade = np.clip((sh - s_pend) / 0.012, 0, 1); fade = fade * fade * (3 - 2 * fade)
        K[:, a] = 1 + (x - 1) * fade

    bones = [hra_mesh(sex, rf'{b}_{t}_bone_{side}$') for b in ('pubis', 'ischium') for t in ('compact', 'spongy') for side in 'LR']
    bsolid = Solid(bones, h=0.001, cache=os.path.join(FIT, sex, 'repro', 'pelvis-bone-sdf.npz'))
    outputs, final = [], {}
    for key, n in names.items():
        v, f = W[n]
        w, q, dmin = local(v)
        v2 = place(w, q, K)
        g = np.clip(((w * sz[None]).sum(1) - z1 - ROOT[0]) / (ROOT[1] - ROOT[0]), 0, 1); g = g * g * (3 - 2 * g)
        v2 = v2 * g[:, None] + v * (1 - g[:, None])
        if key == 'cavernosum':
            a = np.clip((dmin - CRUS[0]) / (CRUS[1] - CRUS[0]), 0, 1); a = a * a * (3 - 2 * a)
            v2 = v2 * (1 - a[:, None]) + v * a[:, None]
        if key != 'glans': v2 = push_out(v2, f, bsolid)
        final[key] = orient(v2, f)
        outputs.append(dict(name={'cavernosum': 'corpora_cavernosa', 'spongiosum': 'corpus_spongiosum', 'glans': 'glans_penis'}[key],
                            part='reproductive', mesh=final[key], source=[n]))
    s_shaft = float(np.interp(z1 + ROOT[1] + 0.015, kz, kh))
    rep = measure(sex, final, W, Ch, sh, h1, h2, Cz, sz, z1, z2, sb, tsdf, s_pend, s_shaft)
    rep['skeleton_recentred_mm'] = round(recentre_mm, 2)
    rep['scale_factors'] = dict(note='radial cross-section scale of the pendulous part in 8 directions from the person-left lateral (0) through dorsal (2), right (4) and ventral (6); 1 = warped size; every 4 mm',
                                rows=raw[::8])
    return outputs, rep, dict(final=final, urethra=hu, Ch=Ch)


def subdivide(v, f):
    """One midpoint subdivision (each triangle into four); the surface is unchanged."""
    e = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
    ue, inv = np.unique(e, axis=0, return_inverse=True)
    mid = len(v) + inv.reshape(3, -1).T                       # midpoints of edges (01, 12, 20) of each face
    v2 = np.concatenate([v, (v[ue[:, 0]] + v[ue[:, 1]]) / 2])
    a, b, c = f[:, 0], f[:, 1], f[:, 2]; ab, bc, ca = mid[:, 0], mid[:, 1], mid[:, 2]
    f2 = np.concatenate([np.stack([a, ab, ca], 1), np.stack([ab, b, bc], 1), np.stack([ca, bc, c], 1), np.stack([ab, bc, ca], 1)])
    return v2, f2


def push_out(v, f, solid, iters=12):
    """Collision push-out from a solid with a smooth displacement: penetrating vertices move out along the gradient,
    and the accumulated displacement is diffused over the mesh (so the surface bends, not dents)."""
    from scipy import sparse
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    A = sparse.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(len(v), len(v))).tocsr(); A = ((A + A.T) > 0).astype(float)
    Dinv = sparse.diags(1 / np.maximum(np.asarray(A.sum(1)).ravel(), 1))
    v0 = v.copy(); v = v.copy()
    for it in range(iters):
        if it:
            disp = v - v0
            for _ in range(2): disp = 0.5 * disp + 0.5 * (Dinv @ (A @ disp))
            v = v0 + np.where((np.linalg.norm(disp, axis=1) > np.linalg.norm(v - v0, axis=1))[:, None], disp, v - v0)
        d = solid(v); bad = d < BONE_CLEAR
        if not bad.any(): break
        g = solid.gradient(v[bad]); g /= np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-9)
        v[bad] += (BONE_CLEAR - d[bad])[:, None] * g
    return v


def section_centroid(v, f, p, n):
    """Centroid of the cross-section outline of a closed mesh by the plane (p, n), from its boundary segments."""
    d = (v - p) @ n
    s = np.sign(d[f]); keep = (s.min(1) < 0) & (s.max(1) > 0)
    if not keep.any(): return None
    tri = f[keep]; pts = []
    for a, b in ((0, 1), (1, 2), (2, 0)):
        da, db = d[tri[:, a]], d[tri[:, b]]
        mm = (da < 0) != (db < 0)
        t = np.where(mm, da / np.where(mm, da - db, 1), 0)
        pts.append(np.where(mm[:, None], v[tri[:, a]] + t[:, None] * (v[tri[:, b]] - v[tri[:, a]]), np.nan))
    P = np.stack(pts, 1)
    seg = np.array([row[~np.isnan(row[:, 0])][:2] for row in P if (~np.isnan(row[:, 0])).sum() == 2])
    if not len(seg): return None
    # keep the loop nearest the plane point (the spongiosum may be cut twice near the bends)
    mid = seg.mean(1); near = np.linalg.norm(mid - p, axis=1) < 0.012
    if not near.any(): return None
    seg = seg[near]
    # outline centroid (length-weighted segment midpoints): close to the area centroid for the near-elliptic sections
    ln = np.linalg.norm(seg[:, 1] - seg[:, 0], axis=1)
    return (seg.mean(1) * ln[:, None]).sum(0) / max(ln.sum(), 1e-12)


def measure(sex, final, W, Ch, sh, h1, h2, Cz, sz, z1, z2, sb, tsdf, s_pend, s_shaft):
    r = lambda x, k=2: round(float(x), k)
    rep = dict(landmarks_mm=dict(
        hra=dict(infrapubic_bend=np.round(Ch[np.searchsorted(sh, h1)] * 1000, 1).tolist(), penile_angle=np.round(Ch[np.searchsorted(sh, h2)] * 1000, 1).tolist(),
                 meatus=np.round(Ch[-1] * 1000, 1).tolist(), length_mm=r(sh[-1] * 1000, 1)),
        za_warped=dict(infrapubic_bend=np.round(Cz[np.searchsorted(sz, z1)] * 1000, 1).tolist(), penile_angle=np.round(Cz[np.searchsorted(sz, z2)] * 1000, 1).tolist(),
                       meatus=np.round(Cz[-1] * 1000, 1).tolist(), length_mm=r(sz[-1] * 1000, 1))))
    sp = final['spongiosum']; gl = final['glans']; cc = final['cavernosum']
    # 1. the urethra on the spongiosum's centre line along the shaft (from 1 cm past the infrapubic bend to the glans)
    T = np.gradient(Ch, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    g0 = np.dot(gl[0] - Ch[-1], T[-1]).min()                   # glans base, measured back from the meatus along the axis
    off, bulb = [], []
    for i in range(0, len(Ch), 4):
        if sh[i] < h1 + 0.005 or sh[i] > sh[-1] + g0 - 0.003: continue
        c = section_centroid(*sp, Ch[i], T[i])
        if c is not None: (off if sh[i] >= s_shaft else bulb).append(np.linalg.norm(c - Ch[i]))
    off = np.array(off)
    rep['urethra_to_spongiosum_centre_mm'] = dict(median=r(np.median(off) * 1000), p90=r(np.percentile(off, 90) * 1000), max=r(off.max() * 1000), n=int(len(off)),
                                                 threshold=dict(median=1.0, p90=2.0), ok=bool(np.median(off) <= 0.001 and np.percentile(off, 90) <= 0.002),
                                                 note=f'penile shaft, HRA urethra arc length {s_shaft * 1000:.0f} mm (end of the bulb) to 3 mm before the glans, every 2 mm',
                                                 bulb_median=r(np.median(bulb) * 1000) if bulb else None,
                                                 bulb_note='in the bulb the urethra runs near its dorsal surface (as in Z-Anatomy and in life): informational')
    sg = LocalSDF(sp, h=0.0004); gg = LocalSDF(gl, h=0.0004)
    path = Ch[(sh >= h1) & (sh <= sh[-1] - 0.002)]
    inside = np.minimum(sg(path), gg(path))
    rep['urethra_inside_spongiosum_or_glans'] = dict(value=r((inside < 0).mean(), 4), deepest_outside_mm=r(max(inside.max(), 0) * 1000), threshold=1.0, ok=bool((inside < 0).all()),
                                                    note='HRA urethra centre line from the infrapubic bend to 2 mm before the meatus')
    # 2. inside the skin, GAP below it in the pendulous part
    P = {k: sample_surface(*m_, 8000, seed=21) for k, m_ in final.items()}
    tree = cKDTree(Ch)
    rows = {}
    for k, Pk in P.items():
        d = sb(Pk); _, ii = tree.query(Pk)
        pend = (sh[ii] >= h2) & (sh[ii] <= sh[-1] - 0.004)
        rows[k] = dict(inside_fraction=r((d < 0).mean(), 4), deepest_outside_mm=r(max(d.max(), 0) * 1000), pendulous_min_gap_mm=r(-d[pend].max() * 1000) if pend.any() else None)
    allP = np.concatenate(list(P.values())); d = sb(allP); _, ii = tree.query(allP)
    pend = (sh[ii] >= h2) & (sh[ii] <= sh[-1] - 0.004)
    # the outer envelope: per cross-section and 30-degree sector, the sample nearest the skin
    Fh = np.stack(frames(Ch, ref=(1, 0, 0)), 2)
    loc = np.einsum('pk,pkl->pl', allP - Ch[ii], Fh[ii])
    ang = np.floor((np.degrees(np.arctan2(loc[:, 2], loc[:, 1])) % 360) / 30).astype(int)
    env = {}
    for j in np.flatnonzero(pend):
        key = (ii[j] // 4, ang[j]); env[key] = max(env.get(key, -1), d[j])
    envg = -np.array(list(env.values()))
    lateral_dorsal = np.array([g for (sec, a), g in zip(env.keys(), envg) if a not in (7, 8, 9, 10)])  # sectors 210-330 deg face the scrotum
    rep['skin'] = dict(per_body=rows,
                       inside_skin=dict(value=r((d < 0).mean(), 4), threshold=1.0, ok=bool((d < 0).all())),
                       pendulous_min_gap_mm=dict(value=r(-d[pend].max() * 1000), threshold=1.0, ok=bool(-d[pend].max() >= 0.001)),
                       pendulous_envelope_gap_median_mm=dict(value=r(np.median(lateral_dorsal) * 1000), threshold=[1.0, 2.5], ok=bool(0.001 <= np.median(lateral_dorsal) <= 0.0025),
                                                             note='median over cross-sections (every 2 mm) and the 30-degree sectors facing the skin (not the scrotum) of the gap between the outermost body and the skin'))
    # 3. clear of the testes and the pelvic bones, and of each other
    Pall = np.concatenate([P['spongiosum'], P['cavernosum'], P['glans']])
    dt = np.min([t(Pall) for t in tsdf], axis=0)
    rep['testis_clearance_mm'] = dict(value=r(dt.min() * 1000), threshold=0.5, ok=bool(dt.min() >= 0.0005))
    bones = [hra_mesh(sex, rf'{b}_{t}_bone_{side}$') for b in ('pubis', 'ischium') for t in ('compact', 'spongy') for side in 'LR']
    bs = Solid(bones, h=0.001, cache=os.path.join(FIT, sex, 'repro', 'pelvis-bone-sdf.npz'))
    db = bs(np.concatenate([P['cavernosum'], P['spongiosum']]))
    Pcb = np.concatenate([P['cavernosum'], P['spongiosum']])
    rep['bone_penetration_mm'] = dict(value=r(max(-db.min(), 0) * 1000), threshold=1.0, ok=bool(-db.min() <= 0.001), at_mm=np.round(Pcb[np.argmin(db)] * 1000, 1).tolist(),
                                      fraction_inside=r((db < 0).mean(), 4),
                                      note='crura lie on the ischiopubic rami; the voxel solid is 1 mm')
    cs_in_cc = LocalSDF(cc, h=0.0005)(P['spongiosum'])
    rep['spongiosum_into_cavernosa_mm'] = dict(value=r(max(-cs_in_cc.min(), 0) * 1000), threshold=1.0, ok=bool(-cs_in_cc.min() <= 0.001),
                                               at_mm=np.round(P['spongiosum'][np.argmin(cs_in_cc)] * 1000, 1).tolist(), fraction_inside=r((cs_in_cc < 0).mean(), 4))
    w_in = sb(np.concatenate(list(P.values())))
    allq = np.concatenate(list(P.values()))
    rep['skin']['deepest_outside_at_mm'] = np.round(allq[np.argmax(w_in)] * 1000, 1).tolist()
    rep['volume_cm3'] = {k: dict(warped=r(abs(signed_volume(*W[n])) * 1e6, 1), fitted=r(abs(signed_volume(*final[k])) * 1e6, 1))
                         for k, n in (('cavernosum', 'Corpus_cavernosum_of_penis'), ('spongiosum', 'Corpus_spongiosum_of_penis'), ('glans', 'Glans_penis'))}
    rep['ok'] = bool(all(v['ok'] for v in rep.values() if isinstance(v, dict) and 'ok' in v) and all(v['ok'] for v in rep['skin'].values() if isinstance(v, dict) and 'ok' in v))
    return rep


if __name__ == '__main__':
    # standalone check against the testes already on disk
    import json
    from lib.mesh import load
    D = os.path.join(FIT, 'male', 'repro')
    outs, rep, aux = fit_penis('male', [load(os.path.join(D, f'testis_{s}.npz')) for s in 'lr'])
    out = sys.argv[1] if len(sys.argv) > 1 else '/tmp'
    for o in outs: np.savez(os.path.join(out, o['name'] + '.npz'), v=o['mesh'][0], f=o['mesh'][1])
    print(json.dumps(rep, indent=1))
