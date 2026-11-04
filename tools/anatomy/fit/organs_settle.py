"""Organs fit, part 7: the final collision settle shared by the diaphragm, stomach and oesophagus.

settle() is a smooth, shape-preserving push-out that is checked on the whole surface, not only at the vertices:
every vertex and four points inside each triangle near a neighbour (centroid and edge midpoints) are tested against
the neighbour fields. A point closer than its clearance gets a target on the neighbour's surface + clearance, along
the neighbour's outward normal; a triangle point's move is carried by its triangle's vertices (least-norm barycentric
split). One bi-Laplacian (bending-energy) displacement over the mesh then meets all targets, every vertex that was
ever pushed keeping its target (active set), so the move spreads over the surface with a smooth falloff instead of
denting it; fixed vertices (orifice rims, joins) stay exactly where they are.

Thin sheets (the diaphragm) pass `pairs`: facing vertices of the two faces, each pair kept at least `min_thick`
apart along its thickness axis, so a sheet squeezed between a thoracic and an abdominal organ thins (down to
min_thick) instead of folding through itself.
"""
import numpy as np
from scipy import sparse
from scipy.sparse.linalg import splu

from fit.organs_geom import laplacian

BARY = np.array([[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0.0], [0.0, 0.5, 0.5], [0.5, 0.0, 0.5]])


def _keep_largest(vid, mag, vec, n):
    """Per vertex, the candidate move with the largest magnitude."""
    if not len(vid): return np.zeros(0, np.int64), np.zeros((0, 3))
    o = np.lexsort((-mag, vid))
    vid, vec = vid[o], vec[o]
    first = np.ones(len(vid), bool); first[1:] = vid[1:] != vid[:-1]
    return vid[first], vec[first]


def _walk(fls, P, D, step=0.0004, max_walk=0.010):
    """Distance along unit directions D from points P until every field of fls [(Field, clearance)] reads >= its
    clearance (nan where not reached): a wall wedged into the crevice between two neighbours walks back out of both."""
    t = np.full(len(P), np.nan)
    todo = np.arange(len(P))
    for k in range(1, int(round(max_walk / step)) + 1):
        if not len(todo): break
        Q = P[todo] + (k * step) * D[todo]
        ok = np.ones(len(todo), bool)
        for fl, c in fls:
            near = fl.coarse(Q) < c + 0.003
            if near.any():
                sub = np.flatnonzero(near & ok)
                if len(sub): ok[sub] = fl(Q[sub]) >= c
        t[todo[ok]] = k * step
        todo = todo[~ok]
    return t


def needs(v, f, fields, clear=0.0004, band=0.004, faces=True, inward=True):
    """Moves that bring every vertex and triangle sample `clear` outside each field. fields: [(name, Field, clearance
    or None[, allowed-vertex mask])]. inward: the surface gives way along its own inward normal (the shortest walk
    that clears the neighbour; the neighbour's normal where that walk fails), so a soft organ wedged between two
    neighbours retreats instead of being shuttled from one into the other. Returns (vertex ids, moves (k, 3)),
    {name: deepest mm inside (vertices and samples)}."""
    n = len(v)
    VID, MAG, VEC, worst = [], [], [], {}
    if inward:
        from fit.organs_geom import vertex_normals
        vn = vertex_normals(v, f)
        allf = [(it[1], clear if it[2] is None else it[2]) for it in fields]
        fa = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
        fn_ = fa / np.maximum(np.linalg.norm(fa, axis=1, keepdims=True), 1e-20)

    def moves(fl, P, sd, c, N):
        on, _ = fl.outward(P)
        d = c - sd
        vec = d[:, None] * on
        if inward:
            # only where the inward walk leaves the neighbour (its outward normal along the walk), never through it
            go = np.einsum('ij,ij->i', on, -N) > 0.3
            t = np.full(len(P), np.nan)
            if go.any(): t[go] = _walk(allf, P[go], -N[go])
            ok = np.isfinite(t)
            vec[ok] = -t[ok, None] * N[ok]
            d = np.where(ok, t, d)
        return d, vec
    for item in fields:
        name, fl, c = item[:3]
        allow = item[3] if len(item) > 3 else None          # vertices this neighbour may push (None: all)
        c = clear if c is None else c
        s = fl.coarse(v)
        near = s < c + band
        if allow is not None: near &= allow
        if not near.any(): continue
        ii = np.flatnonzero(near)
        sd = fl(v[ii]); m = sd < c
        if m.any():
            jj = ii[m]
            d, vec = moves(fl, v[jj], sd[m], c, vn[jj] if inward else None)
            VID.append(jj); MAG.append(d); VEC.append(vec)
            worst[name] = max(worst.get(name, 0.0), round(float(max(0.0, -sd[m].min()) * 1000), 2))
        if faces:
            sel = near[f].any(1)
            if allow is not None: sel &= allow[f].all(1)
            fi = np.flatnonzero(sel); F = f[fi]
            for b in BARY:
                P = np.einsum('k,ikj->ij', b, v[F])
                sd = fl(P); m = sd < c
                if not m.any(): continue
                d, vec = moves(fl, P[m], sd[m], c, fn_[fi[m]] if inward else None)
                k = b / (b @ b)
                worst[name] = max(worst.get(name, 0.0), round(float(max(0.0, -sd[m].min()) * 1000), 2))
                for j in range(3):
                    if b[j] == 0: continue
                    VID.append(F[m, j]); MAG.append(d * k[j]); VEC.append(vec * k[j])
    if not VID: return np.zeros(0, np.int64), np.zeros((0, 3)), worst
    vid, vec = _keep_largest(np.concatenate(VID), np.concatenate(MAG), np.concatenate(VEC), n)
    return vid, vec, worst


class SmoothSolver:
    """Bi-Laplacian displacement u minimising |L u|^2 + eps |u|^2 + sum w_i |u_i - t_i|^2 with fixed vertices; the
    factorisation is reused while the weighted set does not change."""

    def __init__(self, n, f, fixed=None, eps=1e-4, damp=0.15):
        self.n = n
        L, deg = laplacian(n, f)
        self.scale = float(np.mean(deg) ** 2)
        # bending energy plus a little membrane energy: with only the weak pull to the start (an elastic foundation)
        # the bending response to a push rings (a raised rim around a pushed patch); the membrane term damps it
        self.K = (L.T @ L + damp * float(np.mean(deg)) * L).tocsr()
        self.eps = eps
        self.fixed = np.zeros(0, np.int64) if fixed is None else np.asarray(fixed, np.int64)
        free = np.ones(n, bool); free[self.fixed] = False
        self.fi = np.flatnonzero(free)
        self._key, self._lu = None, None

    def solve(self, idx, tgt, w, fixed_u=None):
        n = self.n
        wv = np.zeros(n); rhs = np.zeros((n, 3))
        wt = np.broadcast_to(np.asarray(w, float), (len(idx),)) * self.scale
        np.add.at(wv, idx, wt); np.add.at(rhs, idx, wt[:, None] * tgt)
        K = (self.K + sparse.diags(wv + self.eps * self.scale)).tocsr()
        u = np.zeros((n, 3))
        fu = np.zeros((len(self.fixed), 3)) if fixed_u is None else fixed_u
        Kff = K[self.fi][:, self.fi].tocsc()
        r = rhs[self.fi] - (K[self.fi][:, self.fixed] @ fu if len(self.fixed) else 0)
        lu = splu(Kff)
        u[self.fi] = np.column_stack([lu.solve(r[:, a]) for a in range(3)])
        if len(self.fixed): u[self.fixed] = fu
        return u


def settle(v, f, fields, clear=0.0004, iters=10, fixed=None, pairs=None, min_thick=0.0006, pair_split=0.5, w=10.0, w_rest=0.0,
           rest=None, faces=True, tol=0.00003, log=None, label='settle', inward=True):
    """Push mesh (v, f) out of `fields` ([(name, Field, clearance or None)]) with a smooth displacement, the `fixed`
    vertices held. pairs: (P, Q, axis) facing vertices of a thin sheet's two faces with unit thickness axes (P side
    positive), kept >= min_thick apart (scalar or per pair); pair_split: share of a thickness correction taken by the P
    side (0.5: both faces give way; 0: only Q moves, e.g. the lumen wall of a tube collapsing). w_rest > 0 adds a weak pull of every vertex back to `rest` (default: the
    input), which keeps the far field in place. Returns (v, report)."""
    v0 = np.asarray(v, float).copy(); v = v0.copy(); n = len(v)
    S = SmoothSolver(n, f, fixed=fixed)
    rest = v0 if rest is None else rest
    active = {}
    hist = []
    for it in range(iters):
        vid, mv, worst = needs(v, f, fields, clear=clear, faces=faces, inward=inward)
        thin = 0
        if pairs is not None:
            P, Q, ax = pairs
            th = np.einsum('ij,ij->i', v[P] - v[Q], ax)
            mt = np.broadcast_to(np.asarray(min_thick, float), th.shape)
            bad = th < mt
            thin = int(bad.sum())
            if bad.any():
                # the thickness correction is added to whatever obstacle push the vertex already has
                corr = (mt[bad] - th[bad])[:, None] * ax[bad]
                M = np.zeros((n, 3)); M[vid] = mv
                for side, sgn, share in ((P[bad], 1.0, pair_split), (Q[bad], -1.0, 1.0 - pair_split)):
                    if share <= 0: continue
                    c = sgn * share * corr
                    i2, c2 = _keep_largest(side, np.linalg.norm(c, axis=1), c, n)
                    M[i2] += c2
                vid = np.flatnonzero(np.abs(M).sum(1) > 0); mv = M[vid]
        deep = max(worst.values()) if worst else 0.0
        hist.append((it, len(vid), worst))
        if log: log(f'    {label} iter {it}: {len(vid)} pushed, thinned pairs {thin}, worst {worst}')
        # done when nothing is inside (with a pull towards `rest`, only once that pull has been applied)
        if (not len(vid) or (deep < tol * 1000 and not thin)) and (w_rest == 0 or it > 0): break
        # accumulate: a vertex pushed again moves on from its current position
        for i, m in zip(vid.tolist(), mv):
            active[i] = v[i] + m
        ai = np.fromiter(active.keys(), np.int64); at = np.array([active[i] for i in ai])
        idx = [ai]; tg = [at - v0[ai]]; ww = [np.full(len(ai), w)]
        if w_rest > 0:
            idx.append(np.arange(n)); tg.append(rest - v0); ww.append(np.full(n, w_rest))
        u = S.solve(np.concatenate(idx), np.concatenate(tg), np.concatenate(ww))
        v = v0 + u
    vid, mv, worst = needs(v, f, fields, clear=0.0, faces=faces, inward=False)
    return v, dict(iterations=len(hist), residual_mm=worst, max_move_mm=round(float(np.linalg.norm(v - v0, axis=1).max() * 1000), 2))
