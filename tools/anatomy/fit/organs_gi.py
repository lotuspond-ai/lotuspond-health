"""Organs fit, part 6: stomach and oesophagus helpers shared by the fits (organs_bed builds the stomach,
organs_tube the oesophagus, organs.py measures them).

  loop_axis                 centre, normal and radius of a closed ring of points
  orifices                  the cardiac and pyloric rims of the open Z-Anatomy stomach (and its other holes)
  bulb_opening              the pyloric junction: a ring on the outer wall of the HRA duodenal ampulla (bulb, the first
                            duodenal segment) just behind the crest of its free lipped end, and the bulb's axis
  plane_loops               the closed curves where a plane cuts a mesh
  esophagus_field           the oesophagus as a solid organ for contacts (outer wall, ends capped, lumen included)
  warped_esophagus_field    the same for the warped Z-Anatomy oesophagus (the stand-in the diaphragm is fitted around)

(The earlier as-rigid-as-possible stomach fit and the carried Z-Anatomy oesophagus mesh were replaced by organs_bed
and organs_tube: the first crumpled the stomach in the HRA male's small bed, the second folded the tube's wall.)
"""
from scipy.spatial import cKDTree
import numpy as np

from fit.organs_data import hra
from fit.organs_geom import boundary_loops, centreline, resample_polyline


def loop_axis(P):
    """Centre, unit normal (by PCA) and mean radius of a closed ring of points."""
    c = P.mean(0)
    n = np.linalg.svd(P - c)[2][2]
    return c, n / np.linalg.norm(n), float(np.linalg.norm(P - c, axis=1).mean())


def orifices(v, f, sex, eso_end):
    """(pylorus loop, cardia loop, other loops) of the open Z-Anatomy stomach: the cardia is the loop nearest the
    oesophagus's lower end, the pylorus the loop nearest the HRA duodenum; Z-Anatomy's stomach also has a 3 cm hole in
    its anterior wall, which is filled (see fill_holes)."""
    loops = [np.array(l) for l in boundary_loops(f) if len(l) >= 8]
    duo = hra(sex, 'duo_sup')[0].mean(0)
    ic = int(np.argmin([np.linalg.norm(v[l].mean(0) - eso_end) for l in loops]))
    rest = [l for i, l in enumerate(loops) if i != ic]
    ip = int(np.argmin([np.linalg.norm(v[l].mean(0) - duo) for l in rest]))
    return rest[ip], loops[ic], [l for i, l in enumerate(rest) if i != ip]


LIP = 0.001          # the pyloric ring lies this far behind the crest of the bulb's lip (on its outer wall)


def plane_loops(v, f, c, n):
    """Closed curves where the plane (c, n) cuts the mesh (v, f): a list of point arrays, each ordered along its curve."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    s = (v - c) @ n
    s = np.where(np.abs(s) < 1e-9, 1e-9, s)                       # no vertex exactly on the plane
    E = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    key = np.sort(E, axis=1)
    uk, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    sa, sb = s[uk[:, 0]], s[uk[:, 1]]
    cut = sa * sb < 0
    t = np.where(cut, sa / np.where(cut, sa - sb, 1), 0)
    P = v[uk[:, 0]] + t[:, None] * (v[uk[:, 1]] - v[uk[:, 0]])
    fe = inv.reshape(3, -1).T                                      # the face's three edge ids
    cf = cut[fe]
    two = cf.sum(1) == 2
    segs = fe[two][cf[two]].reshape(-1, 2)
    ids = np.flatnonzero(cut); pos = -np.ones(len(uk), np.int64); pos[ids] = np.arange(len(ids))
    a, b = pos[segs[:, 0]], pos[segs[:, 1]]
    G = coo_matrix((np.ones(len(a)), (a, b)), shape=(len(ids), len(ids))).tocsr()
    G = G + G.T
    k, lab = connected_components(G, directed=False)
    out = []
    for j in range(k):
        m = np.flatnonzero(lab == j)
        if len(m) < 6: continue
        # walk the cycle
        nb = {int(i): [int(x) for x in G.indices[G.indptr[i]:G.indptr[i + 1]]] for i in m}
        order = [int(m[0])]; prev = -1
        while True:
            cur = order[-1]
            nxt = [x for x in nb[cur] if x != prev]
            if not nxt or nxt[0] == order[0]: break
            prev = cur; order.append(nxt[0])
            if len(order) > len(m): break
        if len(order) >= 0.9 * len(m): out.append(P[ids[np.array(order)]])
    return out


def bulb_opening(sex, lip=LIP):
    """The pyloric junction on the HRA duodenum: the duodenal ampulla (bulb) is the first duodenal segment, a short
    double-walled funnel whose outer and inner walls meet in a rounded lip at its free end (the pyloric opening); its
    other end joins the superior part. The bulb's axis runs from the centre of its junction ring to the centre of the lip;
    the lip's plane is fitted to its crest (the most distal point in each of 36 sectors about the axis), and the ring is
    the outer wall's cross-section `lip` behind that crest, parallel to it. Returns (ring points ordered along the
    loop, centre, unit axis pointing out of the bulb towards the stomach, mean radius, info)."""
    from lib.mesh import sample_surface
    v, f = hra(sex, 'duo_bulb')
    loops = [np.array(l) for l in boundary_loops(f) if len(l) >= 6]
    L = max(loops, key=lambda l: loop_axis(v[l])[2])              # outer wall at the junction with the superior part
    c0, n0, r0 = loop_axis(v[L])
    p = sample_surface(v, f, 40000, seed=0)
    ax = n0 if n0 @ (p.mean(0) - c0) > 0 else -n0
    for _ in range(3):
        t = (p - c0) @ ax
        ac = p[t > t.max() - 0.0015].mean(0)
        ax = (ac - c0) / np.linalg.norm(ac - c0)
    a = np.cross(ax, [1.0, 0.0, 0.0])
    if np.linalg.norm(a) < 0.1: a = np.cross(ax, [0.0, 1.0, 0.0])
    a /= np.linalg.norm(a); b = np.cross(ax, a)
    rel = p - c0; t = rel @ ax
    sec = (((np.arctan2(rel @ b, rel @ a) + np.pi) / (2 * np.pi)) * 36).astype(int) % 36
    crest = np.array([p[sec == k][np.argmax(t[sec == k])] for k in range(36) if (sec == k).any()])
    cc = crest.mean(0)
    nl = np.linalg.svd(crest - cc)[2][2]
    nl = nl if nl @ ax > 0 else -nl
    cuts = plane_loops(v, f, cc - lip * nl, nl)
    if not cuts: raise RuntimeError(f'{sex}: no cross-section of the duodenal bulb {lip * 1000:.1f} mm behind its lip')
    rad = [float(np.linalg.norm(q - q.mean(0), axis=1).mean()) for q in cuts]
    ring = cuts[int(np.argmax(rad))]
    cr, nr_, rr = loop_axis(ring)
    lip_r = float(np.linalg.norm((crest - cc) - np.outer((crest - cc) @ nl, nl), axis=1).mean())
    info = dict(junction_ring_centre=np.round(c0, 4).tolist(), junction_ring_radius_mm=round(r0 * 1000, 1),
                bulb_length_mm=round(float((cc - c0) @ nl) * 1000, 1), axis=np.round(nl, 3).tolist(),
                lip_plane_tilt_deg=round(float(np.degrees(np.arccos(np.clip(nl @ ax, -1, 1)))), 1),
                crest_centre=np.round(cc, 4).tolist(), crest_radius_mm=round(lip_r * 1000, 1), ring_behind_crest_mm=round(lip * 1000, 2),
                cross_sections=len(cuts), ring_radius_mm=round(rr * 1000, 1), ring_points=int(len(ring)))
    return ring, cr, nl, rr, info


def duodenal_opening(sex, near):
    """Rim of the HRA duodenum superior part at its proximal end (the one nearest `near`): the outer wall loop."""
    v, f = hra(sex, 'duo_sup')
    loops = [np.array(l) for l in boundary_loops(f) if len(l) >= 8]
    cs = [v[l].mean(0) for l in loops]
    d = np.array([np.linalg.norm(c - near) for c in cs])
    close = [l for l, dd in zip(loops, d) if dd < d.min() + 0.006]          # outer and inner walls at that end
    rad = [loop_axis(v[l])[2] for l in close]
    ring = close[int(np.argmax(rad))]
    return v[ring]


def warped_esophagus_field(W, h=0.0008):
    """esophagus_field of the warped Z-Anatomy oesophagus (the stand-in the diaphragm is fitted around)."""
    v0, f = W['esophagus']
    top = v0[v0[:, 1] > v0[:, 1].max() - 0.004].mean(0)
    bot = v0[v0[:, 1] < v0[:, 1].min() + 0.004].mean(0)
    return esophagus_field(v0, f, centreline(v0, top, bot, n=120, iters=4), h)


def esophagus_field(v, f, C, h=0.0006):
    """The oesophagus as a solid organ for contacts: its outer wall (faces whose normal points away from the
    centreline C), the open ends capped, lumen included; the lumen wall takes no part."""
    from fit.organs_geom import mesh_field
    Cd = resample_polyline(C, 400)[0]
    cen = v[f].mean(1)
    _, j = cKDTree(Cd).query(cen)
    fa = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    outer = np.einsum('ij,ij->i', fa, cen - Cd[j]) > 0
    return mesh_field(v, f[outer], h, cap=True)
