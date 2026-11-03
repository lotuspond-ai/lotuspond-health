"""Skin side of the arms fit: what the HRA skin says about each arm (and the same measurements on Z-Anatomy's skin
regions, so the two can be compared feature by feature).

  arm_sections      cross-sections of the skin arm perpendicular to its centerline (centroid, area, extents)
  za_sections       the same on Z-Anatomy's (open) skin-region patches, sampled along its joint-centre polyline
  hand_analysis     palm plane, thumb direction and the five skin fingers (segmented, with centerlines)
"""
import numpy as np
from scipy.spatial import cKDTree
from scipy import sparse
from scipy.sparse.csgraph import dijkstra, connected_components

from fit.arms_geom import slice_loops, slice_segments, polygon_props, point_in_polygon, unit


def frame_perp(d, sg):
    """(anterior, lateral) unit vectors perpendicular to the axis d; lateral points away from the body (sign sg = +1 left)."""
    d = unit(d)
    ant = unit(np.array([0, 0, 1.0]) - d[2] * d)
    lat = unit(np.cross(d, ant))
    if lat[0] * sg < 0: lat = -lat
    return ant, lat


def _extents(P, c, d, sg):
    ant, lat = frame_perp(d, sg)
    a = (P - c) @ ant; l = (P - c) @ lat
    return dict(ant=float(a.max()), post=float(-a.min()), lat=float(l.max()), med=float(-l.min()))


def section_at(v, f, q, d, faces=None):
    """The closed skin loop around point q in the plane through q with normal d (None if q is not inside any loop)."""
    L = slice_loops(v, f, q, d, faces=faces)
    for Lp in L:
        if point_in_polygon(Lp, d, q): return Lp
    return None


def arm_sections(v, f, P0, tip, sg, t_start=0.25, step=0.005, max_area=0.016, t_end=None):
    """March along the skin arm from t_start (metres from P0 towards the fingertip) proximally and distally.
    Returns sections sorted proximal -> distal: dict(c, d, A, per, ext, loop, s) where s is the arc length of the
    centroid polyline measured from P0 (P0 is taken as the polyline's start)."""
    d0 = unit(tip - P0)
    t_end = t_end or np.linalg.norm(tip - P0)
    # faces near the arm only (faster slicing)
    cen = v[f].mean(1)
    rel = cen - P0
    along = rel @ d0
    near = (along > -0.05) & (along < t_end + 0.02) & (np.linalg.norm(rel - along[:, None] * d0, axis=1) < 0.25)
    faces = np.flatnonzero(near)
    # start: first t >= t_start where a small loop surrounds the axis point
    t = t_start; start = None
    while t < 0.5 * t_end:
        q = P0 + d0 * t
        Lp = section_at(v, f, q, d0, faces)
        if Lp is not None and polygon_props(Lp, d0)[0] < max_area: start = (q, Lp); break
        t += 0.01
    if start is None: return []
    out = []
    for direction in (+1, -1):
        d = d0.copy(); q = start[0]; cs = []
        k = 0
        while True:
            Lp = section_at(v, f, q, d, faces)
            if Lp is None: break
            A, c, per = polygon_props(Lp, d)
            if A > max_area: break
            if direction > 0 and k > 0 and np.dot(c - P0, d0) > t_end - 0.004: break
            out.append(dict(c=c, d=d.copy(), A=A, per=per, ext=_extents(Lp, c, d, sg), loop=Lp))
            cs.append(c); k += 1
            if len(cs) >= 4: d = unit(0.6 * d + 0.4 * direction * unit(cs[-1] - cs[-4]))
            q = c + d * step * direction
            if direction < 0 and np.dot(q - P0, d0) < 0.02: break
        if direction > 0: fwd = out[:]; out = []
    secs = out[::-1][:-1] + fwd if out else fwd
    # arc length from P0
    s = [np.linalg.norm(secs[0]['c'] - P0)]
    for a, b in zip(secs[:-1], secs[1:]): s.append(s[-1] + np.linalg.norm(b['c'] - a['c']))
    for x, si in zip(secs, s): x['s'] = si
    return secs


def za_sections(rv, rf, poly, sg, step=0.005, radius=0.09):
    """Sections of Z-Anatomy's arm skin patches along a joint-centre polyline (GH, elbow, wrist, MCP3)."""
    lens = [np.linalg.norm(b - a) for a, b in zip(poly[:-1], poly[1:])]
    cum = np.concatenate([[0], np.cumsum(lens)])
    out = []
    for t in np.arange(0.0, cum[-1], step):
        k = min(np.searchsorted(cum, t, side='right') - 1, len(poly) - 2)
        a, b = poly[k], poly[k + 1]; d = unit(b - a)
        # blend the direction across joints (2 cm) so sections turn smoothly
        o = a + d * (t - cum[k])
        S = slice_segments(rv, rf, o, d)
        if not len(S): continue
        mid = S.mean(1); ln = np.linalg.norm(S[:, 1] - S[:, 0], axis=1)
        near = np.linalg.norm(mid - o, axis=1) < radius
        S, mid, ln = S[near], mid[near], ln[near]
        if len(S) < 6: continue
        c = (mid * ln[:, None]).sum(0) / ln.sum()
        P = S.reshape(-1, 3)
        out.append(dict(s=float(t), c=c, d=d, o=o, ext=_extents(P, c, d, sg), pts=P))
    return out, cum


def profile(secs, key):
    s = np.array([x['s'] for x in secs])
    if key == 'ml': y = np.array([x['ext']['med'] + x['ext']['lat'] for x in secs])
    elif key == 'ap': y = np.array([x['ext']['ant'] + x['ext']['post'] for x in secs])
    else: y = np.array([x['ext'][key] for x in secs])
    return s, y


# ------------------------------------------------------------------------------------------------ hand
def mesh_graph(v, f, verts=None):
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    if verts is not None:
        keep = np.zeros(len(v), bool); keep[verts] = True
        e = e[keep[e[:, 0]] & keep[e[:, 1]]]
    e = np.unique(np.sort(e, 1), axis=0)
    w = np.linalg.norm(v[e[:, 0]] - v[e[:, 1]], axis=1)
    G = sparse.coo_matrix((np.r_[w, w], (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(len(v), len(v))).tocsr()
    return G


def axis_line(secs, s_lo, s_hi):
    """Least-squares line through the section centroids with s in [s_lo, s_hi]: (point, unit direction distal)."""
    S = np.array([x['s'] for x in secs]); C = np.array([x['c'] for x in secs])
    m = (S >= s_lo) & (S <= s_hi)
    c = C[m].mean(0)
    _, _, Vt = np.linalg.svd(C[m] - c, full_matrices=False)
    d = Vt[0]
    if d @ (C[m][-1] - C[m][0]) < 0: d = -d
    return c, d


def offset_in_frame(p, line, sg):
    """(anterior, lateral, along) coordinates of point p relative to a line (point, direction)."""
    c, d = line
    ant, lat = frame_perp(d, sg)
    r = p - c
    return np.array([r @ ant, r @ lat, r @ d])


def point_from_frame(off, line, sg, along=None):
    c, d = line
    ant, lat = frame_perp(d, sg)
    a = off[2] if along is None else along
    return c + off[0] * ant + off[1] * lat + a * d


def match_joints(za_secs, ze, zw, hra_secs, e_range=(0.22, 0.38), w_range=(0.44, 0.62), tail=0.03, tau=0.0015, sigma=0.035,
                 step=0.0025):
    """Where are the elbow and wrist along the HRA arm? Z-Anatomy's arm profile (its skin regions' cross-section
    extents: width, depth, front, back, medial and lateral extents) is mapped onto the HRA profile piecewise linearly with
    knots at the shoulder (s = 0), elbow and wrist; the profile correlation is high and flat over about +-1 cm, so it
    is combined with a prior on the forearm / upper-arm length ratio (Z-Anatomy's; sigma 3.5 %, about the population spread of the
    brachial index).
    Returns dict(elbow, wrist, corr, ratio, table)."""
    def chans(secs):
        s = np.array([x['s'] for x in secs])
        E = {k: np.array([x['ext'][k] for x in secs]) for k in ('ant', 'post', 'med', 'lat')}
        return s, np.stack([E['med'] + E['lat'], E['ant'] + E['post'], E['ant'], E['post'], E['med'], E['lat']], 1)
    zs, zc = chans(za_secs); hs, hc = chans(hra_secs)
    r0 = (zw - ze) / ze
    rows = []
    for e in np.arange(*e_range, step):
        for w in np.arange(*w_range, step):
            if w - e < 0.12: continue
            def to_za(s):
                return np.where(s < e, s * ze / e, np.where(s < w, ze + (s - e) * (zw - ze) / (w - e), zw + (s - w) * (zw - ze) / (w - e)))
            m = (hs > hs[0] + 0.01) & (hs < w + tail)
            sz = to_za(hs[m]); ok = (sz > zs[0]) & (sz < zs[-1])
            if ok.sum() < 20: continue
            zi = np.stack([np.interp(sz[ok], zs, zc[:, j]) for j in range(zc.shape[1])], 1); hi = hc[m][ok]
            sc = 0.0
            for j in range(zc.shape[1]):
                a = zi[:, j] - zi[:, j].mean(); b = hi[:, j] - hi[:, j].mean()
                sc += (a @ b) / np.sqrt((a @ a) * (b @ b) + 1e-18)
            rows.append((sc / zc.shape[1], e, w))
    rows = np.array(rows)
    cmax = rows[:, 0].max()
    ratio = (rows[:, 2] - rows[:, 1]) / rows[:, 1]
    score = (rows[:, 0] - cmax) / tau - 0.5 * (np.log(ratio / r0) / sigma) ** 2
    k = int(np.argmax(score))
    kc = int(np.argmax(rows[:, 0]))
    return dict(elbow=float(rows[k, 1]), wrist=float(rows[k, 2]), corr=float(rows[k, 0]), ratio=float(ratio[k]), za_ratio=float(r0),
                best_corr=dict(elbow=float(rows[kc, 1]), wrist=float(rows[kc, 2]), corr=float(cmax)))


def section_at_s(secs, s):
    """Interpolated (centroid, direction, extents dict) at arc length s."""
    S = np.array([x['s'] for x in secs])
    k = int(np.clip(np.searchsorted(S, s), 1, len(S) - 1))
    a, b = secs[k - 1], secs[k]
    t = float(np.clip((s - a['s']) / max(b['s'] - a['s'], 1e-9), 0, 1))
    c = (1 - t) * a['c'] + t * b['c']; d = unit((1 - t) * a['d'] + t * b['d'])
    ext = {q: (1 - t) * a['ext'][q] + t * b['ext'][q] for q in a['ext']}
    return c, d, ext
