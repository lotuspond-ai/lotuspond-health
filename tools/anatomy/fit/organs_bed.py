"""Organs fit, part 9: the stomach as the smooth boundary of the free part of its bed.

A hollow soft organ takes the shape of the space its neighbours leave. The warped Z-Anatomy stomach (trunk warp, body
scale) marks the bed; the stomach is rebuilt as the smooth boundary of the part of that bed its HRA neighbours leave
free, so it carries their impressions (as a real stomach does), keeps its volume where the bed allows and has no folds:

  1. the warped stomach is voxelised (H = 1 mm; its orifices and the 3 cm hole in Z-Anatomy's anterior wall capped);
  2. the union of its neighbours (liver, gallbladder, spleen, pancreas, colon, jejunum, duodenum (its bulb included)
     away from the pyloric junction, kidneys, aorta, IVC, splenic artery and vein, lung bases, heart, our diaphragm and
     left suprarenal gland), dilated by CLR, is subtracted; so is the pylorus's shadow: behind the plane of the bulb's
     lip, within PYL_CONE of the bulb's axis (the duodenum continues there; gastric tissue in it would wrap the bulb);
  3. two bridges join the orifices to their partners along their axes: a cylinder from the cardiac ring (centre and
     axis of the warped cardia, radius of the oesophagus's distal end) into the stomach, and the pyloric canal from the
     pyloric ring (the outer wall of the HRA duodenal bulb just behind the crest of its free lipped end,
     organs_gi.bulb_opening): it leaves along the bulb's axis (LEAD), then follows the corridor of greatest clearance
     between the neighbours to the deep part of the bed (corridor_path: Dijkstra on a 2 mm lattice of the free space,
     edges weighted by (wanted radius / clearance) ** 2), widening from the ring's radius towards the antrum's as the
     corridor allows (the HRA female's bulb hangs with its lip facing down and forwards, below the bed: the canal
     comes round under the bulb into it); the bridges obey the same neighbour constraint;
  4. a morphological opening (OPEN_R ball) drops free space too thin to hold a stomach (the shells a neighbour leaves
     when it bulges into the bed: the HRA male's splenic flexure), the bridges are added, and the largest connected
     component is kept;
  5. its signed distance is smoothed (PASSES gaussian passes), each pass followed by the constraint that keeps the
     field outside wherever a dilated neighbour is, and in the pylorus's shadow from SH_HOLD behind the lip plane on:
     the smoothed surface never re-enters a neighbour, nor rounds the bed's concave edges into the shadow;
  6. the zero level is extracted (surface nets, about H edges, even; its winding made consistent across manifold edges
     only, organs_geom.orient_manifold: the few non-manifold edges surface nets leave must not carry a flip), Taubin-
     smoothed; each orifice is opened by
     cutting the bridge end at its ring plane, and its rim laid exactly onto its ring (the cardiac circle the
     oesophagus ends in, the ring on the bulb's lip) by a bi-Laplacian displacement with a smooth falloff;
  7. a final settle (organs_settle) clears what the voxel resolution leaves, both rims held.
"""
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

from lib.mesh import surface_nets, taubin, signed_volume, components, compact
from fit.organs_data import hra, field, log, has_hra
from fit.organs_geom import cap_loops, voxel_solid, boundary_loops, smoothstep, orient_manifold

H = 0.001            # voxel size (m)
CLR = 0.0012         # neighbours dilated by this (m): the surface stays >= CLR - H/2 off them
SIGMA = 1.5          # gaussian smoothing per pass (voxels)
PASSES = 4
OPEN_R = 5            # opening radius (voxels): free space thinner than 1 cm holds no stomach
BED_NB = ('liver', 'gallbladder', 'spleen', 'pancreas', 'colon', 'kidney_l', 'kidney_r', 'duodenum', 'jejunum', 'aorta', 'ivc',
          'splenic_a', 'splenic_v', 'lungs', 'heart')
PYL_CONE = (np.radians(45.0), 0.035)    # the pylorus's shadow: half-angle about the bulb's axis, depth behind the lip plane
LEAD = 0.006         # the pyloric canal leaves the bulb's lip along the bulb's axis for at least this long
SH_HOLD = 0.003      # the smoothing keeps out of the pylorus's shadow from this far behind the lip plane on


def loop_axis(P):
    c = P.mean(0)
    n = np.linalg.svd(P - c)[2][2]
    return c, n / np.linalg.norm(n), float(np.linalg.norm(P - c, axis=1).mean())


def ring_frame(n):
    a = np.cross(n, [1.0, 0.0, 0.0])
    if np.linalg.norm(a) < 0.1: a = np.cross(n, [0.0, 1.0, 0.0])
    a /= np.linalg.norm(a)
    return a, np.cross(n, a)


def circle(c, n, r, m=720):
    a, b = ring_frame(n)
    t = np.linspace(0, 2 * np.pi, m, endpoint=False)
    return c + r * (np.outer(np.cos(t), a) + np.outer(np.sin(t), b))


def match_rings(P, Q, c, n):
    """For each point of ring P, the point of ring Q at the same angle about axis (c, n) (Q densified)."""
    a, b = ring_frame(n)
    Qd = np.concatenate([np.linspace(Q[i], Q[(i + 1) % len(Q)], 10, endpoint=False) for i in range(len(Q))])
    angP = np.arctan2((P - c) @ b, (P - c) @ a); angQ = np.arctan2((Qd - c) @ b, (Qd - c) @ a)
    order = np.argsort(angQ)
    j = np.searchsorted(angQ[order], angP) % len(order)
    return Qd[order][j]


def hermite(p0, m0, p1, m1, n=60):
    t = np.linspace(0, 1, n)[:, None]
    return ((2 * t ** 3 - 3 * t ** 2 + 1) * p0 + (t ** 3 - 2 * t ** 2 + t) * m0 + (-2 * t ** 3 + 3 * t ** 2) * p1
            + (t ** 3 - t ** 2) * m1)


def tube_voxels(lo, h, shape, P, R):
    """Voxels within R[i] of the polyline P (densified; round ends)."""
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    t = np.arange(0, s[-1] + 1e-12, h * 0.3)
    Pd = np.column_stack([np.interp(t, s, P[:, a]) for a in range(3)]); Rd = np.interp(t, s, R)
    shp = np.array(shape)
    i0 = np.clip(np.floor((Pd.min(0) - Rd.max() - lo) / h).astype(int), 0, shp - 1)
    i1 = np.clip(np.ceil((Pd.max(0) + Rd.max() - lo) / h).astype(int), 0, shp - 1)
    g = np.stack(np.meshgrid(*[np.arange(i0[a], i1[a] + 1) for a in range(3)], indexing='ij'), -1).reshape(-1, 3)
    d, j = cKDTree(Pd).query(lo + h * g)
    g = g[d < Rd[j]]
    out = np.zeros(shape, bool); out[g[:, 0], g[:, 1], g[:, 2]] = True
    return out


def beyond_ring(lo, h, shape, c, n_out, r, length):
    """Voxels of the partner's own space beyond a ring plane: within r of the axis, up to `length` beyond the plane."""
    shp = np.array(shape)
    i0 = np.clip(np.floor((np.minimum(c, c + length * n_out) - r - lo) / h).astype(int), 0, shp - 1)
    i1 = np.clip(np.ceil((np.maximum(c, c + length * n_out) + r - lo) / h).astype(int), 0, shp - 1)
    g = np.stack(np.meshgrid(*[np.arange(i0[a], i1[a] + 1) for a in range(3)], indexing='ij'), -1).reshape(-1, 3)
    x = lo + h * g - c; ax = x @ n_out
    rad = np.linalg.norm(x - np.outer(ax, n_out), axis=1)
    g = g[(ax > 0) & (ax < length) & (rad < r)]
    out = np.zeros(shape, bool); out[g[:, 0], g[:, 1], g[:, 2]] = True
    return out


def shadow_voxels(lo, h, shape, c, n, r0, ang, depth):
    """Voxels behind the plane (c, n) (on the -n side), up to `depth`, within r0 + tan(ang) * (distance behind the
    plane) of the axis."""
    shp = np.array(shape)
    i0 = np.clip(np.floor((c - depth - lo) / h).astype(int), 0, shp - 1)
    i1 = np.clip(np.ceil((c + depth - lo) / h).astype(int), 0, shp - 1)
    g = np.stack(np.meshgrid(*[np.arange(i0[a], i1[a] + 1) for a in range(3)], indexing='ij'), -1).reshape(-1, 3)
    x = lo + h * g - c; ax = -(x @ n)
    rad = np.linalg.norm(x + np.outer(ax, n), axis=1)
    g = g[(ax > 0) & (np.linalg.norm(x, axis=1) < depth) & (rad < r0 + np.tan(ang) * ax)]
    out = np.zeros(shape, bool); out[g[:, 0], g[:, 1], g[:, 2]] = True
    return out


def corridor_path(D, FREE, lo, h, p0, targets, r_min, r_want, box=0.075, step=2):
    """The pyloric canal's course: the path of greatest clearance through free space from p0 (just in front of the
    bulb's lip) to the nearest of the `targets` voxels (the deep part of the stomach's bed). Dijkstra on a lattice of
    `step` voxels within `box` of p0, over FREE voxels whose clearance (D, the distance to the nearest neighbour,
    less CLR) is at least r_min; an edge costs its length times (r_want / clearance) ** 2 (clearance capped at r_want),
    so the canal keeps to the middle of the corridor between its neighbours. Returns the polyline (from p0) or None."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import dijkstra
    shp = np.array(D.shape)
    i0 = np.clip(np.floor((p0 - box - lo) / h).astype(int), 0, shp - 1)
    i1 = np.clip(np.ceil((p0 + box - lo) / h).astype(int), 0, shp - 1)
    sl = tuple(slice(i0[a], i1[a] + 1, step) for a in range(3))
    C = (D[sl] - CLR).astype(np.float64)
    ok = FREE[sl] & (C >= r_min)
    tg = targets[sl] & ok
    if not tg.any(): return None
    idx = -np.ones(ok.shape, np.int64); nodes = np.argwhere(ok); idx[ok] = np.arange(len(nodes))
    rows, cols, wts = [], [], []
    for d in [(a, b, c) for a in (-1, 0, 1) for b in (-1, 0, 1) for c in (-1, 0, 1) if (a, b, c) > (0, 0, 0)]:
        q = nodes + np.array(d)
        inb = ((q >= 0) & (q < np.array(ok.shape))).all(1)
        a_, q = np.flatnonzero(inb), q[inb]
        j = idx[q[:, 0], q[:, 1], q[:, 2]]; m = j >= 0
        a_, j = a_[m], j[m]
        cm = np.minimum(0.5 * (C[tuple(nodes[a_].T)] + C[tuple(nodes[j].T)]), r_want)
        rows.append(a_); cols.append(j); wts.append(step * h * np.linalg.norm(d) * (r_want / cm) ** 2)
    G = coo_matrix((np.concatenate(wts), (np.concatenate(rows), np.concatenate(cols))), shape=(len(nodes), len(nodes))).tocsr()
    pos = lo + h * (np.array([s_.start for s_ in sl]) + step * nodes)
    src = int(np.argmin(np.linalg.norm(pos - p0, axis=1)))
    dist, pred = dijkstra(G, directed=False, indices=src, return_predecessors=True)
    t = np.flatnonzero(tg[ok])
    t = t[np.isfinite(dist[t])]
    if not len(t): return None
    k = int(t[np.argmin(dist[t])])
    path = [k]
    while path[-1] != src and pred[path[-1]] >= 0: path.append(int(pred[path[-1]]))
    return np.vstack([p0, pos[path[::-1]][1:]])


def smooth_path(P, step=0.001, passes=30, hold=0):
    """Resample a polyline every `step` and smooth it (Laplacian passes; the first `hold` + 1 points and the last held)."""
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    t = np.arange(0, s[-1] + 1e-12, step)
    Q = np.column_stack([np.interp(t, s, P[:, a]) for a in range(3)])
    for _ in range(passes):
        Q[hold + 1:-1] = 0.5 * Q[hold + 1:-1] + 0.25 * (Q[hold:-2] + Q[hold + 2:])
    return Q


def open_orifice(v, f, c, n_out, r):
    """Open an orifice: remove the flat end face the bridge leaves at its ring plane (faces facing out along n_out,
    near the plane, inside the ring); keep the largest piece. Returns (v, f, loop nearest c)."""
    from lib.mesh import face_normals
    cen = v[f].mean(1); x = cen - c; ax = x @ n_out
    rad = np.linalg.norm(x - np.outer(ax, n_out), axis=1)
    cap = (ax > -0.0025) & (rad < r - 0.0003) & (face_normals(v, f) @ n_out > 0.5)
    if not cap.any(): raise RuntimeError(f'orifice at {np.round(c, 4).tolist()}: no end face at its ring plane')
    # the end face is one patch: its largest connected piece
    sub = np.flatnonzero(cap)
    comps = components(v, f[sub])
    drop = np.zeros(len(f), bool); drop[sub[max(comps, key=len)]] = True
    f = f[~drop]
    comps = components(v, f)
    v, f = compact(v, f[max(comps, key=len)])
    loops = [np.array(l) for l in boundary_loops(f) if len(l) >= 6]
    j = int(np.argmin([np.linalg.norm(v[l].mean(0) - c) for l in loops]))
    return v, f, loops[j], int(drop.sum())


def neighbour_distance(fields, lo, h, shape, relax=None):
    """min over the neighbour fields (coarse signed distance) on every voxel; relax(name, X) -> bool mask of points
    where that neighbour is ignored."""
    D = np.full(shape, np.inf, np.float32)
    jk = np.indices(shape[1:]).reshape(2, -1).T
    for i in range(shape[0]):
        X = lo + h * np.column_stack([np.full(len(jk), i), jk])
        d = np.full(len(X), np.inf)
        for name, fl in fields:
            dd = fl.coarse(X)
            if relax is not None:
                m = relax(name, X)
                if m is not None: dd = np.where(m, np.inf, dd)
            np.minimum(d, dd, out=d)
        D[i] = d.reshape(shape[1:])
    return D


def fit_stomach_bed(sex, W, r_cardia, own=(), log_=log):
    """own: [(name, Field)] our fitted neighbours (diaphragm, left adrenal). r_cardia: outer radius of the
    oesophagus's distal end (the cardiac ring). Returns (v, f), report, (pylorus loop, cardia loop, duodenal ring)."""
    from fit.organs_gi import orifices
    from fit.organs_settle import SmoothSolver, settle
    rep = {}
    v0, f0 = W['stomach']
    ev = W['esophagus'][0]
    eb = ev[ev[:, 1] < ev[:, 1].min() + 0.004].mean(0)
    pyl0, car0, holes = orifices(v0, f0, sex, eb)
    cc, cn, _ = loop_axis(v0[car0])
    if cn @ (cc - v0.mean(0)) < 0: cn = -cn                  # out of the stomach, up the oesophagus
    # the cardiac ring is perpendicular to the oesophagus where it ends (its distal 15 mm, as warped): the tube arrives
    # along its own axis (Z-Anatomy's cardiac rim is a slanted loop whose normal can point well off the tube)
    from fit.organs_geom import centreline
    top = ev[ev[:, 1] > ev[:, 1].max() - 0.004].mean(0)
    Ce = centreline(ev, top, eb, n=120, iters=4)
    se = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(Ce, axis=0), axis=1))])
    k15 = int(np.searchsorted(se, se[-1] - 0.015))
    te = Ce[k15] - Ce[-1]; te /= np.linalg.norm(te)
    rep['cardia_axis'] = dict(warped_rim_normal=np.round(cn, 3).tolist(), oesophagus_distal=np.round(te, 3).tolist(),
                              angle_deg=round(float(np.degrees(np.arccos(np.clip(cn @ te, -1, 1)))), 1))
    cn = te
    pc0 = v0[pyl0].mean(0)
    # the pylorus opens into the free lipped end of the duodenal bulb (the first duodenal segment), not into the ring
    # where the bulb meets the superior part: nr points out of the bulb, towards the stomach
    from fit.organs_gi import bulb_opening
    ring, cr, nr, rr, rep['bulb'] = bulb_opening(sex)
    rep['cardia'] = dict(centre=np.round(cc, 4).tolist(), axis=np.round(cn, 3).tolist(), radius_mm=round(r_cardia * 1000, 1))
    rep['duodenal_opening'] = dict(centre=np.round(cr, 4).tolist(), axis=np.round(nr, 3).tolist(), radius_mm=round(rr * 1000, 1),
                                   warped_pylorus_offset_mm=round(float(np.linalg.norm(pc0 - cr) * 1000), 1))
    # grid
    pts = np.vstack([v0, ring, cc + 0.01 * cn])
    lo = pts.min(0) - 0.02; hi = pts.max(0) + 0.02
    shape = tuple(int(x) for x in np.ceil((hi - lo) / H).astype(int) + 1)
    vv, ff = cap_loops(v0, f0)
    S0 = voxel_solid(vv, ff, lo, H, np.array(shape), close=2)
    vol_warped = float(S0.sum() * H ** 3)
    # neighbours
    fields = [(k, field(sex, k)) for k in BED_NB if has_hra(sex, k)] + list(own)

    def relax(name, X):
        # the duodenum's own opening is the pyloric junction, not an overlap
        if name != 'duodenum': return None
        return (np.linalg.norm(X - cr, axis=1) < rr + 0.008) & ((X - cr) @ nr > 0)
    D = neighbour_distance(fields, lo, H, shape, relax)
    FREE = D > CLR
    # the pylorus's shadow: behind the lip plane, within PYL_CONE of the bulb's axis (rr + 2 mm at the plane)
    ang, depth = PYL_CONE
    SH = shadow_voxels(lo, H, shape, cr, nr, rr + 0.002, ang, depth)
    rep['pylorus_shadow'] = dict(half_angle_deg=round(float(np.degrees(ang)), 1), depth_mm=round(depth * 1000, 1),
                                 warped_bed_removed_cm3=round(float((S0 & FREE & SH).sum() * H ** 3 * 1e6), 2))
    FREE &= ~SH
    free0 = S0 & FREE
    # the cardiac ring and the oesophagus's end must fit between their neighbours (the warped end lies partly in the
    # HRA liver's oesophageal impression): the ring centre moves to the nearest point where a disc of the ring's radius
    # clears them, not further up the oesophagus than 4 mm
    need = r_cardia + CLR + 0.0005
    rng = [np.arange(max(0, int((cc[a] - 0.016 - lo[a]) / H)), min(shape[a], int((cc[a] + 0.016 - lo[a]) / H) + 1)) for a in range(3)]
    g = np.stack(np.meshgrid(*rng, indexing='ij'), -1).reshape(-1, 3)
    Xg = lo + H * g
    ok = (D[g[:, 0], g[:, 1], g[:, 2]] > need) & ((Xg - cc) @ cn < 0.004) & (np.linalg.norm(Xg - cc, axis=1) < 0.016)
    cc_old = cc.copy()
    if ok.any():
        cc = Xg[ok][int(np.argmin(np.linalg.norm(Xg[ok] - cc, axis=1)))]
    else:
        dd = D[g[:, 0], g[:, 1], g[:, 2]]; cc = Xg[int(np.argmax(np.where(np.linalg.norm(Xg - cc, axis=1) < 0.016, dd, -1)))]
    rep['cardia']['moved_mm'] = round(float(np.linalg.norm(cc - cc_old) * 1000), 1)
    rep['cardia']['centre'] = np.round(cc, 4).tolist(); rep['cardia']['axis'] = np.round(cn, 3).tolist()
    rep['cardia']['clearance_mm'] = round(float(min(fl.coarse(cc[None])[0] for _, fl in fields) * 1000), 1)
    rep['bed'] = dict(warped_cm3=round(vol_warped * 1e6, 1), free_cm3=round(float(free0.sum() * H ** 3 * 1e6), 1),
                      free_share=round(float(free0.sum() / max(S0.sum(), 1)), 3))
    occupied = {}
    idx = np.argwhere(S0); X = lo + H * idx
    for name, fl in fields:
        m = fl.coarse(X) <= CLR
        if name == 'duodenum': m &= ~relax(name, X)
        if m.any(): occupied[name] = round(float(m.sum() * H ** 3 * 1e6), 1)
    rep['bed']['occupied_cm3'] = occupied
    log_(f'    stomach bed: warped {vol_warped * 1e6:.0f} cm3, free {free0.sum() * H ** 3 * 1e6:.0f} cm3, occupied by {occupied}')
    # bridges
    Bc = tube_voxels(lo, H, shape, np.array([cc + 0.004 * cn, cc - 0.022 * cn]), np.array([r_cardia, r_cardia]))
    core = ndimage.distance_transform_edt(free0) > OPEN_R                   # opening by a Euclidean ball (two EDTs)
    bed = ndimage.distance_transform_edt(~core) <= OPEN_R
    rep['bed']['after_opening_cm3'] = round(float(bed.sum() * H ** 3 * 1e6), 1)
    din = ndimage.distance_transform_edt(bed) * H
    deepm = din > max(0.006, 0.7 * rr)
    # the pyloric canal leaves the bulb's lip along the bulb's axis (LEAD), then keeps to the corridor of greatest
    # clearance between its neighbours to the deep part of the bed (organs_bed.corridor_path); the HRA female's bulb
    # hangs with its lip facing down and forwards, below the bed, so the canal comes round under the bulb into it
    lead = max(LEAD, rr)
    p0 = cr + lead * nr
    C = corridor_path(D, FREE, lo, H, p0, deepm, max(0.6 * rr, 0.003), rr + 0.002)
    if C is not None:
        P = smooth_path(np.vstack([cr - 0.004 * nr, cr + np.linspace(0, lead, 6)[1:, None] * nr, C[1:]]), hold=int(round((lead + 0.004) / 0.001)))
        ii = np.round((P[-1] - lo) / H).astype(int); ra = float(din[tuple(np.clip(ii, 0, np.array(shape) - 1))])
        how = 'corridor'
    else:
        deep = np.argwhere(deepm); Xd = lo + H * deep
        j = int(np.argmin(np.linalg.norm(Xd - cr, axis=1)))
        pa = Xd[j]; ra = float(din[tuple(deep[j])])
        P = hermite(cr - 0.004 * nr, nr * float(np.linalg.norm(pa - cr)), pa, (pa - cr), n=80)
        how = 'hermite (no corridor found)'
    sP = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]); L = float(sP[-1])
    t = np.clip((sP - 0.004 - lead) / max(L - 0.004 - lead, 1e-3), 0, 1)
    # outer radius: the lip ring's up to the end of the lead, then widening to the antrum's, never wider than the
    # corridor's clearance (the tube is also clipped to the free space)
    clr_P = np.array([float(D[tuple(np.clip(np.round((p - lo) / H).astype(int), 0, np.array(shape) - 1))]) for p in P]) - CLR
    R = rr + (max(ra, 1.6 * rr) - rr) * smoothstep(t)
    R = np.where(sP > 0.004 + lead, np.minimum(R, np.maximum(clr_P, 0.6 * rr)), R)
    Bp = tube_voxels(lo, H, shape, P, R)
    rep['pyloric_bridge'] = dict(method=how, length_mm=round(L * 1000, 1), lead_mm=round(lead * 1000, 1), antrum_point=np.round(P[-1], 4).tolist(),
                                 antrum_radius_mm=round(ra * 1000, 1), min_radius_mm=round(float(R.min() * 1000), 1),
                                 min_clearance_mm=round(float(clr_P[sP > 0.004 + lead].min() * 1000), 1) if (sP > 0.004 + lead).any() else None)
    # free space too thin to hold a stomach (wall and collapsed lumen: under 2 * OPEN_R) is not stomach: the shells a
    # neighbour leaves when it bulges into the bed (the HRA male's splenic flexure) are opened away; then the bridges,
    # and beyond each ring plane the partner's own space (the oesophagus going up, the duodenum going on) is removed
    S = (bed | ((Bc | Bp) & FREE)) & ~beyond_ring(lo, H, shape, cc, cn, r_cardia + CLR, 0.045) & ~beyond_ring(lo, H, shape, cr, -nr, rr + 0.002, 0.03)
    lab, k = ndimage.label(S)
    if k > 1:
        sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, k + 1))
        S = lab == (1 + int(np.argmax(sizes)))
    rep['components_dropped'] = int(max(k - 1, 0))
    for nm, p in (('cardia', cc - 0.002 * cn), ('pylorus', cr + 0.002 * nr)):
        ii = np.round((p - lo) / H).astype(int)
        rep[f'{nm}_connected'] = bool(S[tuple(ii)])
    # smooth signed distance, kept outside the dilated neighbours after every pass
    sdf = ((ndimage.distance_transform_edt(~S) - ndimage.distance_transform_edt(S)) * H).astype(np.float32)
    sdf -= np.sign(sdf) * 0.5 * H
    cons = np.where(np.isfinite(D), CLR - D, -np.inf).astype(np.float32)
    # the pylorus's shadow holds the field outside too (the gaussian passes would otherwise round the bed's concave
    # edges into it: the HRA female's antrum, which lies beside the hanging bulb, grazed the cone 3.3 mm deep 21 mm
    # behind the lip), from SH_HOLD behind the lip plane on: nearer the lip the canal's own end is cut and laid onto
    # the ring below
    idx = np.argwhere(SH)
    held = idx[-((lo + H * idx - cr) @ nr) > SH_HOLD]
    if len(held):
        SHd = np.zeros(shape, bool); SHd[held[:, 0], held[:, 1], held[:, 2]] = True
        cons = np.maximum(cons, (0.5 * H - ndimage.distance_transform_edt(~SHd) * H).astype(np.float32))
    rep['pylorus_shadow']['held_from_mm'] = round(SH_HOLD * 1000, 1)
    for _ in range(PASSES):
        sdf = ndimage.gaussian_filter(sdf, SIGMA)
        np.maximum(sdf, cons, out=sdf)
    sv, sf = surface_nets(sdf, lo, H, 0.0)
    comps = components(sv, sf)
    sv, sf = compact(sv, sf[max(comps, key=len)])
    sv = taubin(sv, sf, iters=6)
    sf = orient_manifold(sv, sf)
    rep['voxel_surface'] = dict(vertices=int(len(sv)), volume_cm3=round(abs(signed_volume(sv, sf)) * 1e6, 1))
    # orifices: cut the bridge ends at their ring planes, lay the rims onto their rings
    sv, sf, car, nc = open_orifice(sv, sf, cc, cn, r_cardia)
    sv, sf, pyl, npf = open_orifice(sv, sf, cr, -nr, rr)
    rep['end_faces_removed'] = dict(cardia=nc, pylorus=npf)
    loops = [np.array(l) for l in boundary_loops(sf) if len(l) >= 6]
    car = loops[int(np.argmin([np.linalg.norm(sv[l].mean(0) - cc) for l in loops]))]
    pyl = loops[int(np.argmin([np.linalg.norm(sv[l].mean(0) - cr) for l in loops]))]
    rep['boundary_loops'] = len(loops)
    tgt_c = match_rings(sv[car], circle(cc, cn, r_cardia), cc, cn)
    tgt_p = match_rings(sv[pyl], ring, cr, nr)
    rep['rim_snap_mm'] = dict(cardia=round(float(np.linalg.norm(tgt_c - sv[car], axis=1).max() * 1000), 2),
                              pylorus=round(float(np.linalg.norm(tgt_p - sv[pyl], axis=1).max() * 1000), 2))
    rims = np.concatenate([pyl, car])
    Ssol = SmoothSolver(len(sv), sf, fixed=rims)
    u = Ssol.solve(np.zeros(0, np.int64), np.zeros((0, 3)), np.zeros(0), fixed_u=np.vstack([tgt_p - sv[pyl], tgt_c - sv[car]]))
    sv = sv + u
    # final settle against the exact neighbour surfaces, both rims held
    allow = ~(np.linalg.norm(sv - cr, axis=1) < 0.012)
    sfields = [(name, fl, None, allow) if name == 'duodenum' else (name, fl, None) for name, fl in fields
               if name not in ('lungs', 'heart')]
    sv, rep['settle'] = settle(sv, sf, sfields, clear=0.0004, iters=4, fixed=rims, w=2.0, inward=False, log=log_, label='stomach settle')
    sf = orient_manifold(sv, sf)
    vol = abs(signed_volume(sv, sf))
    rep['volume_cm3'] = dict(fitted=round(vol * 1e6, 1), warped_z_anatomy=round(vol_warped * 1e6, 1), share_of_warped=round(vol / vol_warped, 3),
                             note='the free part of the warped Z-Anatomy stomach\'s bed, smoothed (an adult stomach in situ holds '
                                  'about 150-1500 cm3 depending on filling)')
    return (sv, sf), rep, (pyl, car, ring)
