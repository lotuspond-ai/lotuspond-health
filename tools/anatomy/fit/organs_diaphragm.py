"""Organs fit, part 5: the diaphragm.

The Z-Anatomy diaphragm is a closed sheet (about 5 mm thick) with a thoracic face (towards the lungs and heart) and an
abdominal face. After the trunk warp it is refitted as one smooth, bending-resistant displacement of the whole sheet
(bi-Laplacian energy over the surface, with extra edges tying each vertex to the facing vertex across the sheet so both
faces move together), solved repeatedly with these soft targets:

  * openings follow their vessels: the sheet around the caval foramen and the aortic hiatus moves with the offset
    between the warped Z-Anatomy IVC / aorta (which pass through them) and the HRA IVC / aorta at that height;
  * domes under the lungs: thoracic-face vertices facing a lung base (within 25 mm along their normal) are drawn to
    GAP_LUNG below it; under the heart, to GAP_HEART below it;
  * collisions: any vertex inside (or within CLEAR of) the liver, spleen, kidneys, colon, pancreas, duodenum,
    gallbladder, IVC, aorta, vertebrae, ribs and costal cartilages, the oesophagus, lungs or heart is pushed out along
    that neighbour's normal.

Where the HRA lung base lies closer to the liver or spleen than the sheet is thick, a pass lets the two faces move
apart from each other (no cross-sheet edges), which thins the sheet there instead of driving it into an organ; a
minimum thickness MIN_THICK is kept.
"""
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import orient_outward
from fit.organs_data import hra, field, log, vessel_centreline, za_original
from lib.register import umeyama
from fit.organs_geom import laplacian, smooth_solve, vertex_normals, smoothstep, edges_of, ARAP, push_out, refine_long_edges

GAP_LUNG = 0.0015
GAP_HEART = 0.001
CLEAR = 0.0006
MIN_THICK = 0.0006
ABD = ('liver', 'spleen', 'kidney_l', 'kidney_r', 'colon', 'pancreas', 'duodenum', 'gallbladder')
VESSELS = ('ivc', 'aorta')
BONES = ('spine', 'ribs')


def sides(v, f):
    """True for thoracic-face vertices: their outward normal points away from a point deep in the abdomen below the
    dome; smoothed by a majority vote over neighbours."""
    n = vertex_normals(v, f)
    c = v.mean(0); q = np.array([c[0], v[:, 1].min() - 0.06, c[2]])
    s = (np.einsum('ij,ij->i', n, q - v) < 0).astype(float)
    e = edges_of(f)
    for _ in range(3):
        acc = np.zeros(len(v)); cnt = np.zeros(len(v))
        np.add.at(acc, e[:, 0], s[e[:, 1]]); np.add.at(acc, e[:, 1], s[e[:, 0]])
        np.add.at(cnt, e[:, 0], 1); np.add.at(cnt, e[:, 1], 1)
        s = np.where(cnt > 0, (acc + s) / (cnt + 1), s)
        s = (s > 0.5).astype(float)
    return s > 0.5


def coupling(v, thor, maxd=0.010):
    """Cross-sheet edges: each vertex to the nearest vertex of the other face within maxd."""
    T = np.flatnonzero(thor); A = np.flatnonzero(~thor)
    out = []
    for P, Q in ((T, A), (A, T)):
        d, j = cKDTree(v[Q]).query(v[P]); m = d < maxd
        out.append(np.column_stack([P[m], Q[j[m]]]))
    return np.concatenate(out), out


def crossing(Dv, C, r_max=0.035, slab=0.005, first=None):
    """Index of the station of centreline C where diaphragm vertices surround it best (angular coverage); with
    first=c, the first station from the top whose coverage reaches c (the caval foramen lies in the central tendon,
    above the right crus that also flanks the IVC lower down)."""
    best = (-1, None)
    for i in range(1, len(C) - 1):
        t = C[i + 1] - C[i - 1]; t /= np.linalg.norm(t)
        r = Dv - C[i]; dz = r @ t; rad = r - dz[:, None] * t; rr = np.linalg.norm(rad, axis=1)
        m = (np.abs(dz) < slab) & (rr < r_max)
        if m.sum() < 10: continue
        a = np.cross(t, [1, 0, 0]); a /= np.linalg.norm(a); b = np.cross(t, a)
        ang = np.arctan2(rad[m] @ b, rad[m] @ a)
        cov = len(np.unique(np.floor((ang + np.pi) / (2 * np.pi) * 36).astype(int))) / 36
        if first is not None and cov >= first: return (cov, i)
        if cov > best[0]: best = (cov, i)
    return best


def rim_loops(v, f, thor):
    """Connected loops of rim vertices (where the thoracic and abdominal faces meet): the sheet's outer edge and the
    rims of its openings. Returns [(vertex ids, centre, extent)], largest first."""
    from scipy import sparse
    from scipy.sparse.csgraph import connected_components
    e = edges_of(f)
    mixed = thor[e[:, 0]] != thor[e[:, 1]]
    rim = np.zeros(len(v), bool); rim[e[mixed].ravel()] = True
    ee = e[rim[e[:, 0]] & rim[e[:, 1]]]
    G = sparse.coo_matrix((np.ones(len(ee)), (ee[:, 0], ee[:, 1])), shape=(len(v), len(v)))
    _, lab = connected_components(G, directed=False)
    out = []
    for i in np.unique(lab[rim]):
        ids = np.flatnonzero((lab == i) & rim)
        if len(ids) < 8: continue
        out.append((ids, v[ids].mean(0), np.ptp(v[ids], 0)))
    return sorted(out, key=lambda x: -len(x[0]))


def vessel_targets(sex, W, v0, f, thor, rep):
    """Soft displacement targets moving each opening onto its HRA vessel (horizontal offset at the opening's height).
    The caval foramen is the rim loop of the sheet that the warped Z-Anatomy IVC ends in; the aortic opening is where
    the sheet best surrounds the warped Z-Anatomy aorta."""
    idx, disp, wt = [], [], []
    loops = rim_loops(v0, f, thor)
    for key, hkey in (('ref_ivc', 'ivc'), ('ref_aorta', 'aorta_abd')):
        Cz = vessel_centreline(W[key][0])
        Ch = vessel_centreline(hra(sex, hkey)[0])
        order = np.argsort(Ch[:, 1])
        at = lambda y: np.array([np.interp(y, Ch[order, 1], Ch[order, a]) for a in range(3)])
        if hkey == 'ivc':
            top = Cz[0]
            cand = [(np.linalg.norm(c - top), ids, c) for ids, c, ext in loops if ext.max() < 0.05]
            cand.sort(key=lambda x: x[0])
            if not cand or cand[0][0] > 0.03: rep['ivc_opening'] = 'caval foramen not found'; continue
            _, ids, c = cand[0]
            d = at(c[1]) - c; d[1] = 0.0
            r = np.linalg.norm(v0 - c, axis=1)
            w = smoothstep((0.03 - r) / 0.015)
            rep['ivc_opening'] = dict(foramen_centre=np.round(c, 4).tolist(), rim_vertices=int(len(ids)), offset_mm=np.round(d * 1000, 1).tolist())
        else:
            cov, i = crossing(v0, Cz)
            if i is None: continue
            yc = Cz[i, 1]
            d = at(yc) - Cz[i]; d[1] = 0.0
            oz = np.argsort(Cz[:, 1])
            axis = np.column_stack([np.interp(v0[:, 1], Cz[oz, 1], Cz[oz, a]) for a in range(3)])
            r = np.linalg.norm((v0 - axis)[:, [0, 2]], axis=1)
            w = smoothstep((0.024 - r) / 0.010) * smoothstep((0.03 - np.abs(v0[:, 1] - yc)) / 0.01)
            rep[f'{hkey}_opening'] = dict(za_crossing_y=round(float(yc), 4), za_coverage=round(cov, 2), offset_mm=np.round(d * 1000, 1).tolist())
        m = w > 0.02
        idx.append(np.flatnonzero(m)); disp.append(np.repeat(d[None], m.sum(), 0)); wt.append(w[m] * 2.0)
    return np.concatenate(idx), np.concatenate(disp), np.concatenate(wt)


def face_targets(v, nrm, verts, fl, gap, reach, cosmin=0.6):
    """Targets keeping the vertices `verts` (thoracic face) `gap` below the surface of field `fl` when it faces them."""
    s = fl.coarse(v[verts])
    m = s < reach + 0.003
    if not m.any(): return np.zeros(0, np.int64), np.zeros((0, 3))
    ii = verts[m]
    sd = fl(v[ii])
    on, q = fl.outward(v[ii])
    dvec = q - v[ii]; dl = np.linalg.norm(dvec, axis=1)
    facing = (np.einsum('ij,ij->i', dvec, nrm[ii]) > cosmin * dl) | (sd < 0)
    ok = facing & (sd < reach)
    ii, sd, on = ii[ok], sd[ok], on[ok]
    # move along the neighbour's normal so the surface is `gap` away (on its outer side)
    tgt = v[ii] + (gap - sd)[:, None] * on
    return ii, tgt


def push_targets(v, fields, clear=CLEAR, band=0.004):
    idx, tgt, worst = [], [], {}
    for name, fl in fields:
        s = fl.coarse(v); cand = np.flatnonzero(s < clear + band)
        if not len(cand): continue
        sd = fl(v[cand]); m = sd < clear
        if not m.any(): continue
        ii = cand[m]
        on, q = fl.outward(v[ii])
        idx.append(ii); tgt.append(v[ii] + (clear - sd[m])[:, None] * on)
        worst[name] = round(float(-sd[m].min() * 1000), 2)
    if not idx: return np.zeros(0, np.int64), np.zeros((0, 3)), worst
    return np.concatenate(idx), np.concatenate(tgt), worst


def fit_diaphragm(sex, W, extra=(), outer=10):
    """extra: (name, Field) of our own structures the sheet must clear (the oesophagus proxy). Returns (v, f), report.
    The sheet is deformed as-rigidly-as-possible from its undistorted Z-Anatomy shape (scaled and placed by the
    similarity that best matches the warped sheet): the trunk warp stretches parts of the thin sheet (edges up to 9x
    their length), so the warped positions only guide it weakly."""
    rep = {}
    v0, f = W['diaphragm']
    f = orient_outward(v0, f)
    n = len(v0)
    zv = za_original('diaphragm')[0]
    S = umeyama(zv, v0, scale=True)
    rest = S(zv)
    # split the sheet's longer edges (midpoints: shape unchanged) so neighbours cannot slip between vertices
    VV, f = refine_long_edges(np.hstack([rest, v0]), f, 0.0045)
    rest, v0 = VV[:, :3], VV[:, 3:]
    n = len(v0)
    rep['vertices'] = int(n)
    thor = sides(v0, f)
    E, _ = coupling(v0, thor)
    arap = ARAP(rest, f, extra=E, extra_w=1.0)
    vi, vd, vw = vessel_targets(sex, W, v0, f, thor, rep)
    guide = v0.copy(); guide[vi] = v0[vi] + vd
    gw = np.full(n, 0.02); gw[vi] = np.maximum(gw[vi], vw)
    lungs, heart = field(sex, 'lungs'), field(sex, 'heart')
    pushers = [(k, field(sex, k)) for k in ABD + VESSELS + BONES] + list(extra) + [('lungs', lungs), ('heart', heart)]
    T = np.flatnonzero(thor)
    v = v0.copy()
    for it in range(outer):
        nrm = vertex_normals(v, f)
        li, lt = face_targets(v, nrm, T, lungs, GAP_LUNG, 0.025)
        hi, ht = face_targets(v, nrm, T, heart, GAP_HEART, 0.020)
        pi, pt, worst = push_targets(v, pushers)
        idx = np.concatenate([np.arange(n), li, hi, pi])
        tgt = np.concatenate([guide, lt, ht, pt])
        wts = np.concatenate([gw, np.full(len(li), 1.0), np.full(len(hi), 1.0), np.full(len(pi), 20.0)])
        v = arap.solve(v, idx, tgt, wts, iters=4)
        log(f'    diaphragm iter {it}: lung targets {len(li)}, heart {len(hi)}, pushed {len(pi)}, worst {worst}')
    rep['coupled_fit_worst_mm'] = worst
    # thinning pass: the faces may move apart from each other (no cross-sheet edges) where the space between thorax
    # and abdomen is thinner than the sheet
    arap2 = ARAP(rest, f)
    vfit = v.copy()
    for it in range(6):
        pi, pt, worst = push_targets(v, pushers)
        if not len(pi): break
        nrm = vertex_normals(v, f)
        li, lt = face_targets(v, nrm, T, lungs, GAP_LUNG, 0.006)
        idx = np.concatenate([np.arange(n), pi, li]); tgt = np.concatenate([vfit, pt, lt])
        wts = np.concatenate([np.full(n, 0.02), np.full(len(pi), 20.0), np.full(len(li), 0.5)])
        v = arap2.solve(v, idx, tgt, wts, iters=4)
        log(f'    thinning iter {it}: pushed {len(pi)}, worst {worst}')
    v = keep_thickness(v, vfit, thor)
    rep['thinning_worst_mm'] = worst
    rep['thinning_max_move_mm'] = round(float(np.linalg.norm(v - vfit, axis=1).max() * 1000), 2)
    rep['fit_max_move_mm'] = round(float(np.linalg.norm(vfit - v0, axis=1).max() * 1000), 2)
    el = lambda x: np.linalg.norm(x[E0[:, 0]] - x[E0[:, 1]], axis=1)
    E0 = edges_of(f)
    rep['edge_stretch_p99'] = dict(warped=round(float(np.percentile(el(v0) / el(rest), 99)), 2), fitted=round(float(np.percentile(el(v) / el(rest), 99)), 2))
    return (v, orient_outward(v, f)), rep, thor


def keep_thickness(v, vref, thor):
    """Where the faces came closer than MIN_THICK (or crossed), restore MIN_THICK about their midpoint, along the
    reference (coupled-fit) thickness direction."""
    T = np.flatnonzero(thor); A = np.flatnonzero(~thor)
    d, j = cKDTree(vref[A]).query(vref[T])
    m = d < 0.010
    t, a = T[m], A[j[m]]
    axis = vref[t] - vref[a]; axis /= np.maximum(np.linalg.norm(axis, axis=1, keepdims=True), 1e-12)
    th = np.einsum('ij,ij->i', v[t] - v[a], axis)
    bad = th < MIN_THICK
    if bad.any():
        mid = 0.5 * (v[t[bad]] + v[a[bad]])
        v = v.copy()
        v[t[bad]] = mid + 0.5 * MIN_THICK * axis[bad]
        v[a[bad]] = mid - 0.5 * MIN_THICK * axis[bad]
    return v
