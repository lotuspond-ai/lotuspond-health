"""The skin hand: segment the five fingers and measure them (HRA hands are open, fingers spread).

The hand surface beyond the wrist plane is a branched tube. Geodesic distance from the wrist rises along each finger to
its tip; processing vertices from the farthest down (a merge tree of the distance function), every fingertip starts a
region that grows until it meets another finger's region at the web between them. Regions that persist for more than
a couple of centimetres are the fingers. Each finger's centerline is the chain of ring centroids (equal geodesic
distance bands) from the web to the tip.
"""
import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import dijkstra, connected_components
from scipy.spatial import cKDTree

from fit.arms_geom import unit, pca_axes, slice_loops, point_in_polygon


def hand_region(v, f, wrist_c, wrist_d, wrist_loop=None, reach=0.30):
    """Skin vertices of the hand: the mesh component beyond the wrist plane that contains the wrist section."""
    rel = v - wrist_c
    beyond = (rel @ wrist_d > 0) & (np.linalg.norm(rel, axis=1) < reach)
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    m = beyond[e[:, 0]] & beyond[e[:, 1]]
    n = len(v)
    A = sparse.coo_matrix((np.ones(m.sum()), (e[m, 0], e[m, 1])), shape=(n, n))
    _, lab = connected_components(A, directed=False)
    # the component holding the vertices closest to the wrist centre just beyond the plane
    cand = np.flatnonzero(beyond & (rel @ wrist_d < 0.01))
    cand = cand[np.argsort(np.linalg.norm(rel[cand] - (rel[cand] @ wrist_d)[:, None] * wrist_d, axis=1))][:20]
    keep_lab = np.bincount(lab[cand]).argmax()
    return np.flatnonzero(beyond & (lab == keep_lab))


def segment_fingers(v, f, verts, wrist_c, wrist_d, min_persist=0.015):
    """Returns dict(dist (per vertex of `verts`), tips [vertex ids into verts], label (per vertex: finger index or -1),
    web [geodesic level where each finger meets the rest])."""
    n = len(verts)
    remap = -np.ones(len(v), np.int64); remap[verts] = np.arange(n)
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    e = remap[e]; e = e[(e[:, 0] >= 0) & (e[:, 1] >= 0)]
    e = np.unique(np.sort(e, 1), axis=0)  # each edge once (duplicates would be summed by the sparse matrix)
    V = v[verts]
    w = np.linalg.norm(V[e[:, 0]] - V[e[:, 1]], axis=1)
    G = sparse.coo_matrix((np.r_[w, w], (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    src = np.flatnonzero((V - wrist_c) @ wrist_d < 0.006)
    dist = dijkstra(G, directed=False, indices=src, min_only=True)
    dist[~np.isfinite(dist)] = 0
    nbrs = [[] for _ in range(n)]
    for x, y in e: nbrs[x].append(y); nbrs[y].append(x)
    order = np.argsort(-dist)
    parent = np.arange(n); added = np.zeros(n, bool)
    birth, tipv, members, own = {}, {}, {}, {}
    fingers = []

    def find(x):
        r = x
        while parent[r] != r: r = parent[r]
        while parent[x] != r: parent[x], x = r, parent[x]
        return r

    for i in order:
        added[i] = True
        roots = sorted(set(find(j) for j in nbrs[i] if added[j]), key=lambda r: -birth[r])
        if not roots:
            birth[i] = dist[i]; tipv[i] = i; members[i] = [i]; continue
        keep = roots[0]
        for r in roots[1:]:
            if birth[r] - dist[i] >= min_persist:
                # a finger meets the rest of the hand here: both regions end at this level (if not ended before)
                fingers.append((tipv[r], own.get(r, (dist[i], list(members[r])))))
                if keep not in own: own[keep] = (dist[i], list(members[keep]))
            parent[r] = keep
            members[keep].extend(members.pop(r))
        parent[i] = keep; members[keep].append(i)
    root = find(order[0])
    if root in own: fingers.append((tipv[root], own[root]))
    label = -np.ones(n, np.int64)
    tips, webs = [], []
    for k, (t, (lev, mem)) in enumerate(fingers):
        label[np.asarray(mem, np.int64)] = k
        tips.append(int(t)); webs.append(float(lev))
    return dict(dist=dist, tips=np.array(tips), label=label, web=np.array(webs), V=V)


def finger_centerline(V, dist, mask, web, step=0.004):
    """Ring centroids of one finger region from its web to the tip: (points (m, 3), geodesic levels)."""
    P = V[mask]; d = dist[mask]
    lv = np.arange(web + 0.5 * step, d.max(), step)
    pts, lev = [], []
    for a in lv:
        m = (d >= a - 0.5 * step) & (d < a + 0.5 * step)
        if m.sum() >= 6: pts.append(P[m].mean(0)); lev.append(a)
    return np.array(pts), np.array(lev)
