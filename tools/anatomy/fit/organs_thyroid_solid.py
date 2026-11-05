"""Organs fit, part 3c: the thyroid gland built as a solid, the smooth boundary of the free part of its grown shape.

A surface push-out cannot clear the airway on a lobe's medial face and the carotid sheath on its lateral face at once
without pressing one sheet through the other (5-7 % of the surface folded), and its embedded variant left lumpy,
crenellated lobes. So the gland is built the way the stomach is (organs_bed): from the grown, similarity-placed gland
(organs_neck.fit_neck, organs_thyroid.grow_gland), before any push-out,
  1. its solid is voxelised (H = 0.4 mm; flood fill of the rasterised surface united with a 3-axis ray-parity vote,
     so a fold could only ever become a union);
  2. the neighbours dilated by their clearances are removed (neighbour_constraint): the airway (larynx and trachea,
     every slice filled to its convex hull, so the gland never enters between the thyroid laminae) and its
     cartilages, the cricothyroid muscles, the carotid arteries and jugular veins of the vessels group (the common
     carotids also as one-sided carotid-sheath walls, organs_thyroid.SheathField: the lobes lie anteromedial to the
     sheath and get a groove from it, never wrap round it), the external carotids and the oesophagus;
  3. the bed: the gland lies on the larynx and trachea (pretracheal fascia, the suspensory ligament): gaps narrower
     than 2 * BED_R between gland and airway are filled (a morphological closing of gland and dilated airway, kept
     within BED_R of the gland and near the airway); the midline band (isthmus, pyramidal lobe) rests on the airway:
     the space straight behind it, up to MID_FILL in front of the airway, is gland;
  4. a morphological opening by a ball of OPEN_R drops slivers thinner than 2 * OPEN_R; pieces under a fifth of the
     largest are dropped;
  5. the signed distance is smoothed (PASSES gaussian passes of SIGMA voxels), the neighbour clearance re-imposed
     after every pass (the smoothed surface never re-enters a neighbour);
  6. the volume the carving cost is given back by a smooth outward offset where the surface faces away from the
     airway axis (front and sides, the infrahyoid muscles' side), weighted by how much it faces that way, never along
     the airway (the poles keep their levels): bisection on the offset, smoothed and constrained again;
  7. the midline band is laid on its bed again: the smoothing erodes a thin pyramidal lobe 1-2 mm off the cartilage
     (male body), so the band of the smoothed gland slides back by the rule of step 0 (lay_midline, measured on its
     smoothed surface), applied to the signed distance as a smooth warp (no re-voxelising, so no staircase), then the
     clearance is re-imposed and one light pass (RESETTLE_SIGMA) blends it;
  8. surface nets at the zero level (the inside set made well-composed first), Taubin smoothing, outward winding;
     manifoldness is checked.
Step 0, before voxelising: the grown gland's midline band (isthmus, pyramidal lobe) slides back onto the larynx and
trachea as a whole (lay_midline), so that the solid starts on its bed.
"""
import numpy as np
from scipy import ndimage

from lib.mesh import surface_nets, taubin, signed_volume, components, compact
from fit.organs_data import log
from fit.organs_geom import voxel_solid, orient_manifold

H = 0.0004            # voxel size (m)
PAD = 0.008           # grid margin round the grown gland (room for the volume give-back)
MARGIN = 0.00015      # added to the clearance of a coarse voxel field (the airway hull: its 0.5 mm voxels' error)
MARGIN_EXACT = 0.00005   # added to the clearance of a field read exactly near its surface (and the analytic sheath walls)
BED_R = 0.003         # gland-to-airway gaps narrower than 2 * BED_R are filled (closing radius)
MID_BAND = 0.005      # half-width of the midline band (isthmus and pyramidal lobe) about the airway's midline
MID_FILL = 0.004      # the midline band's back is filled down to the airway across gaps up to this
BAND_IN = 0.007       # lay_midline: the band that slides as a whole (isthmus, pyramidal lobe)
LAT_FADE_P = 0.0025   # lay_midline: lateral fade of the slide above the isthmus (pyramidal lobe free of the poles)
LAT_FADE_I = 0.008    # lay_midline: lateral fade of the slide across the isthmus (band and lobes are one)
SLIDE_SIGMA = 0.002   # lay_midline: smoothing of the slide along the airway (m)
RESETTLE_SIGMA = 1.0  # the light smoothing pass (voxels) after the band is laid on its bed again (step 7)
CLEAR_AIR = 0.00035   # clearance from the airway hull and cartilages: the gland lies on them (pretracheal fascia)
CLEAR_MUS = 0.0005    # from the cricothyroid muscles (read exactly near their surface)
OPEN_R = 0.001        # opening radius: slivers thinner than 2 mm go
SIGMA = 1.5           # gaussian smoothing per pass (voxels)
PASSES = 4
GIVE_MAX = 0.004      # largest outward offset of the volume give-back (m)
TAUBIN = 8


def edge_counts(f):
    e = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
    _, cnt = np.unique(e, axis=0, return_counts=True)
    return cnt


def grid(lo, shape):
    idx = np.indices(shape).reshape(3, -1).T
    return lo + H * idx


def neighbour_constraint(X, shape, fields, inside=None):
    """cons = max over the neighbours of (clearance + MARGIN - signed distance) on the grid: > 0 where the gland may
    not be. fields: [(name, field, clearance, exact)]; exact: refine the coarse voxel distance with the field's exact
    one near its surface (not for the airway hull, whose solid bridges concavities its mesh does not have, nor for
    the analytic sheath walls). Also returns, per neighbour, how many voxels of `inside` (the grown gland) it closes."""
    cons = np.full(len(X), -np.inf, np.float32)
    closed = {}
    for nm, fl, c, exact in fields:
        d = fl.coarse(X)
        if exact:
            near = np.flatnonzero(d < c + 0.0015)
            for s in range(0, len(near), 200000):
                j = near[s:s + 200000]; d[j] = fl(X[j])
        cc = (c + (MARGIN_EXACT if exact or not hasattr(fl, 'sdf') else MARGIN) - d).astype(np.float32)
        closed[nm] = int(((cc > 0) & inside).sum()) if inside is not None else int((cc > 0).sum())
        np.maximum(cons, cc, out=cons)
    return cons.reshape(shape), closed


def _ball_close(U, r):
    dil = ndimage.distance_transform_edt(~U) <= r
    return ndimage.distance_transform_edt(dil) > r


def _ball_open(S, r):
    core = ndimage.distance_transform_edt(S) > r
    return (ndimage.distance_transform_edt(~core) <= r) & S


def _sdf(S):
    sdf = ((ndimage.distance_transform_edt(~S) - ndimage.distance_transform_edt(S)) * H).astype(np.float32)
    sdf -= np.sign(sdf) * np.float32(0.5 * H)
    return sdf


def _smooth(sdf, cons, passes, sigma=SIGMA):
    for _ in range(passes):
        sdf = ndimage.gaussian_filter(sdf, sigma)
        np.maximum(sdf, cons, out=sdf)
    return sdf


def midline_fill(G, A, X, shape, c0, a, ap, lat):
    """Voxels straight behind the gland's midline band (|x| < MID_BAND about the airway's midline), between its back
    and the dilated airway, where the whole gap (along ap, through the voxel) is at most MID_FILL: the gland in front
    and the airway behind, both found by rays sampled every half voxel."""
    r = X - c0
    x = r @ lat; z = r @ ap
    cand = np.flatnonzero((np.abs(x) < MID_BAND) & (z > 0) & ~G.ravel() & ~A.ravel())
    if not len(cand): return np.zeros(shape, bool)
    P = X[cand]
    t_g = np.full(len(P), np.inf); t_a = np.full(len(P), np.inf)
    lo = X[0]; n = np.array(shape)
    for t in np.arange(0.5 * H, MID_FILL + 1e-9, 0.5 * H):
        for sgn, M, tt in ((1.0, G, t_g), (-1.0, A, t_a)):
            q = np.round((P + sgn * t * ap - lo) / H).astype(int)
            ok = np.all((q >= 0) & (q < n), axis=1)
            hh = np.zeros(len(P), bool); hh[ok] = M[q[ok, 0], q[ok, 1], q[ok, 2]]
            new = hh & ~np.isfinite(tt); tt[new] = t
    out = np.zeros(len(X), bool); out[cand[t_g + t_a <= MID_FILL]] = True
    return out.reshape(shape)


def lay_midline(tv, c0, a, ap, lat, hull, rep, target=None, key='midline_slide'):
    """The isthmus and the pyramidal lobe rest on the larynx and trachea (the pretracheal fascia binds them there):
    level by level along the airway, the gland's midline band (|x| < BAND_IN) slides back along -ap, as a whole (its
    thickness kept), by the gap between it and the airway hull measured along ap (rays from its vertices, less the
    clearance `target`); the slide fades out over the lobes' medial edges: within LAT_FADE_P of the band above the
    isthmus (where the pyramidal lobe stands free of the upper poles), LAT_FADE_I across the isthmus (where the band
    and the lobes are one). The slide is smoothed along the airway (SLIDE_SIGMA); what it presses into the airway is
    carved by the solid afterwards. Returns (the moved vertices, the displacement as a function of position, so the
    same slide can move a signed-distance grid)."""
    target = CLEAR_AIR + MARGIN + 0.0002 if target is None else target
    r = tv - c0
    s = r @ a; x = r @ lat; z = r @ ap
    band = (np.abs(x) < BAND_IN) & (z > 0)
    # ray distance along -ap to the airway hull (clearance target) from each band vertex
    idx = np.flatnonzero(band)
    dist = np.full(len(idx), np.inf)
    for t in np.arange(0.0, 0.02 + 1e-9, 0.00025):
        open_ = ~np.isfinite(dist)
        if not open_.any(): break
        d = hull.coarse(tv[idx[open_]] - t * ap)
        hit = d <= target
        j = np.flatnonzero(open_)[hit]; dist[j] = t
    levels = np.arange(np.floor(s.min() * 1000) / 1000, s.max() + 0.001, 0.001)
    g = np.full(len(levels), np.nan); conn = np.zeros(len(levels))
    ant = z > 0
    for i, L in enumerate(levels):
        m = np.abs(s[idx] - L) < 0.001
        if m.any() and np.isfinite(dist[m]).any(): g[i] = float(np.min(dist[m][np.isfinite(dist[m])]))
        conn[i] = float(((np.abs(s - L) < 0.001) & ant & (np.abs(x) >= BAND_IN) & (np.abs(x) <= BAND_IN + 0.003)).any())
    ok = np.isfinite(g)
    if not ok.any():
        rep[key] = dict(levels=0); return tv, (lambda P: np.zeros_like(P))
    g = np.interp(levels, levels[ok], g[ok])
    g = ndimage.gaussian_filter1d(g, SLIDE_SIGMA / 0.001, mode='nearest')
    conn = ndimage.gaussian_filter1d(conn, 2.0, mode='nearest')
    from fit.organs_geom import smoothstep

    def disp_fn(P):
        r_ = P - c0
        s_, x_, z_ = r_ @ a, r_ @ lat, r_ @ ap
        gs = np.interp(s_, levels, g); cs = np.interp(s_, levels, conn)
        fade = LAT_FADE_P + (LAT_FADE_I - LAT_FADE_P) * cs
        wx = 1 - smoothstep(np.clip((np.abs(x_) - BAND_IN) / fade, 0, 1))
        wx = wx * smoothstep(np.clip((z_ - 0.004) / 0.004, 0, 1))    # beside the airway (z < 4 mm) the lobes stay
        return (gs * wx)[:, None] * -ap
    disp = disp_fn(tv)
    rep[key] = dict(max_mm=round(float(g.max() * 1000), 2), at_level_mm=round(float(levels[int(np.argmax(g))] * 1000), 1),
                                profile_mm=[(round(float(L * 1000), 0), round(float(v_ * 1000), 1)) for L, v_ in zip(levels[::2], g[::2])],
                                moved_vertices=int((np.linalg.norm(disp, axis=1) > 1e-4).sum()))
    return tv + disp, disp_fn


def well_composed(sdf, max_iter=12):
    """Make the inside set {sdf < 0} well-composed: wherever two inside voxels meet only along an edge (a 2 x 2 block
    with one diagonal in and the other out) or only at a corner (a 2 x 2 x 2 block with just one body diagonal in, or
    just one out), one voxel is added to the inside (its value set just below 0). Surface nets turns those critical
    configurations into non-manifold edges and vertices; the surface moves by at most a voxel there. Returns the
    number of voxels added."""
    added = 0
    n = sdf.shape
    for _ in range(max_iter):
        B = sdf < 0
        fix = np.zeros_like(B)
        for ax1, ax2 in ((0, 1), (0, 2), (1, 2)):
            def sl(i, j):
                return tuple(slice(i, n[k] - 1 + i) if k == ax1 else (slice(j, n[k] - 1 + j) if k == ax2 else slice(None)) for k in range(3))
            a00, a11, a01, a10 = B[sl(0, 0)], B[sl(1, 1)], B[sl(0, 1)], B[sl(1, 0)]
            fv = fix[sl(0, 1)]; fv |= a00 & a11 & ~a01 & ~a10
            fv = fix[sl(0, 0)]; fv |= a01 & a10 & ~a00 & ~a11
        C = {(i, j, k): B[i:n[0] - 1 + i, j:n[1] - 1 + j, k:n[2] - 1 + k] for i in (0, 1) for j in (0, 1) for k in (0, 1)}
        cnt = sum(c.astype(np.int8) for c in C.values())
        for p in ((0, 0, 0), (0, 0, 1), (0, 1, 0), (0, 1, 1)):
            q = tuple(1 - t for t in p)
            # just this diagonal in (2 inside): add p's neighbour along x; just this diagonal out (6 inside): fill p
            m_in = (cnt == 2) & C[p] & C[q]
            m_out = (cnt == 6) & ~C[p] & ~C[q]
            nb = (1 - p[0], p[1], p[2])
            fix[nb[0]:n[0] - 1 + nb[0], nb[1]:n[1] - 1 + nb[1], nb[2]:n[2] - 1 + nb[2]] |= m_in
            fix[p[0]:n[0] - 1 + p[0], p[1]:n[1] - 1 + p[1], p[2]:n[2] - 1 + p[2]] |= m_out
        fix &= ~B
        k = int(fix.sum())
        if not k: break
        sdf[fix] = np.float32(-1e-6); added += k
    return added


def solid_gland(tv, tf, c0, a, ap, lat, fields, hull, target=None, rep=None, log_=log):
    """The gland as the smooth boundary of the free part of its grown solid (see the module docstring).
    tv, tf: the grown gland; fields: [(name, field, clearance, exact)] every neighbour, the airway hull among them;
    hull: the airway hull field (the bed); target: volume to give back to (default: the grown gland's).
    Returns (v, f) and fills rep."""
    rep = {} if rep is None else rep
    target = abs(signed_volume(tv, tf)) if target is None else target
    tv, _ = lay_midline(tv, c0, a, ap, lat, hull, rep)
    lo = tv.min(0) - PAD; hi = tv.max(0) + PAD
    shape = tuple(int(s) for s in np.ceil((hi - lo) / H).astype(int) + 1)
    X = grid(lo, shape)
    G0 = voxel_solid(tv, tf, lo, H, np.array(shape), close=1, parity=True)      # a fold of the slid mesh: a union
    vox = H ** 3
    rep['grid'] = dict(voxel_mm=H * 1000, shape=list(shape), grown_voxel_cm3=round(float(G0.sum() * vox * 1e6), 2),
                       grown_mesh_cm3=round(target * 1e6, 2))
    cons, closed = neighbour_constraint(X, shape, fields, G0.ravel())
    FREE = cons < 0
    G = G0 & FREE
    rep['carved_cm3'] = round(float((G0 & ~FREE).sum() * vox * 1e6), 2)
    rep['carved_by_cm3'] = {nm: round(n_ * vox * 1e6, 3) for nm, n_ in closed.items() if n_}
    # the bed: the gland lies on the larynx and trachea
    hd = hull.coarse(X).reshape(shape)
    A = hd <= CLEAR_AIR + MARGIN
    U = G | A
    clo = _ball_close(U, BED_R / H)
    near_g = ndimage.distance_transform_edt(~G) * H <= BED_R
    fill = clo & ~U & near_g & (hd <= CLEAR_AIR + MARGIN + 2 * BED_R) & FREE
    mid = midline_fill(G, A, X, shape, c0, a, ap, lat) & FREE
    rep['bed_fill_cm3'] = dict(closing=round(float(fill.sum() * vox * 1e6), 3), midline=round(float((mid & ~fill).sum() * vox * 1e6), 3))
    G1 = G | fill | mid
    G2 = _ball_open(G1, OPEN_R / H)
    rep['opening_removed_cm3'] = round(float((G1 & ~G2).sum() * vox * 1e6), 3)
    lab, k = ndimage.label(G2)
    if k > 1:
        sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, k + 1))
        keep = 1 + np.flatnonzero(sizes >= 0.2 * sizes.max())
        G2 = np.isin(lab, keep)
        rep['pieces'] = dict(found=int(k), kept=int(len(keep)), dropped_cm3=round(float((sizes.sum() - sizes[keep - 1].sum()) * vox * 1e6), 3))
    else:
        rep['pieces'] = dict(found=int(k), kept=int(k), dropped_cm3=0.0)
    sdf = _smooth(_sdf(G2), cons, PASSES)
    vol0 = float((sdf < 0).sum() * vox)
    rep['carved_smoothed_cm3'] = round(vol0 * 1e6, 2)
    # volume give-back: outward where the surface faces away from the airway axis
    g = np.stack(np.gradient(sdf), -1).reshape(-1, 3)
    g /= np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-12)
    r = X - c0; r = r - np.outer(r @ a, a)
    r /= np.maximum(np.linalg.norm(r, axis=1, keepdims=True), 1e-12)
    w = np.clip(np.einsum('ij,ij->i', g, r), 0, 1).astype(np.float32).reshape(shape)
    del g, r
    w = ndimage.gaussian_filter(w, 2.0)

    def offset(delta):
        s = np.maximum(sdf - np.float32(delta) * w, cons)
        return _smooth(s, cons, 2, 1.0)
    delta, out = 0.0, sdf
    if vol0 < target:
        lo_d, hi_d = 0.0, GIVE_MAX
        s_hi = offset(hi_d)
        if float((s_hi < 0).sum() * vox) <= target:
            delta, out = hi_d, s_hi
        else:
            for _ in range(12):
                mid_d = 0.5 * (lo_d + hi_d)
                s = offset(mid_d); v_ = float((s < 0).sum() * vox)
                if v_ < target: lo_d = mid_d
                else: hi_d = mid_d; out = s
            delta = hi_d
    sdf = out
    rep['give_back'] = dict(offset_mm=round(delta * 1000, 3), volume_cm3=round(float((sdf < 0).sum() * vox * 1e6), 2),
                            weight='facing away from the airway axis (front and sides), 0 along it')
    # the band laid on its bed again: the smoothing erodes a thin pyramidal lobe 1-2 mm off the cartilage, so the
    # smoothed gland's midline band slides back onto its bed by the same rule (lay_midline on its surface), applied
    # to the signed distance as a smooth warp (no re-voxelising: no staircase), then the clearance and a light pass
    sv0, _ = surface_nets(sdf, lo, H, 0.0)
    _, disp_fn = lay_midline(sv0, c0, a, ap, lat, hull, rep, key='midline_resettle')
    del sv0
    warped = np.empty(len(X), np.float32)
    for k0 in range(0, len(X), 1 << 20):
        Pk = X[k0:k0 + (1 << 20)]
        q = ((Pk - disp_fn(Pk) - lo) / H).T
        warped[k0:k0 + (1 << 20)] = ndimage.map_coordinates(sdf, q, order=1, mode='nearest')
    sdf = np.maximum(warped.reshape(shape), cons)
    del warped
    sdf = _smooth(sdf, cons, 1, RESETTLE_SIGMA)
    rep['midline_resettle']['volume_cm3'] = round(float((sdf < 0).sum() * vox * 1e6), 2)
    rep['well_composed_voxels_added'] = well_composed(sdf)
    sv, sf = surface_nets(sdf, lo, H, 0.0)
    comps = components(sv, sf)
    comps = sorted(comps, key=len, reverse=True)
    big = [c for c in comps if len(c) >= 0.2 * len(comps[0])]
    sv, sf = compact(sv, sf[np.concatenate(big)])
    sv = taubin(sv, sf, iters=TAUBIN)
    sf = orient_manifold(sv, sf)
    cnt = edge_counts(sf)
    rep['surface'] = dict(vertices=int(len(sv)), faces=int(len(sf)), components=len(big), non_manifold_edges=int((cnt != 2).sum()),
                          volume_cm3=round(abs(signed_volume(sv, sf)) * 1e6, 2))
    log_(f'    thyroid solid: grown {target * 1e6:.2f} cm3, carved {rep["carved_cm3"]} cm3, bed fill {rep["bed_fill_cm3"]}, '
         f'opened {rep["opening_removed_cm3"]}, smoothed {rep["carved_smoothed_cm3"]}, give-back {rep["give_back"]}, surface {rep["surface"]}')
    return (sv, sf), dict(sdf=sdf, cons=cons, lo=lo, shape=shape)
