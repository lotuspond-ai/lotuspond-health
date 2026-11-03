"""Seating of the posed foot skeleton (fit/foot.py, step 4).

relax()    rigid-body relaxation: every bone moves only rigidly, so that each articulation gets back the joint space it has
           in Z-Anatomy (its own facet distances, scaled with the bones; Z-Anatomy overlaps are not reproduced: their
           target is contact), while the talus keeps the aimed joint space to the HRA plafond and malleoli, no bone
           enters the HRA tibia / fibula, and every bone stays inside the skin with clearance. Each iteration fits one
           rigid motion per bone (weighted Kabsch) to the displacements its constraint points ask for.
push_out() what relaxation cannot remove (overlaps already present in Z-Anatomy, e.g. 1st metatarsal / medial cuneiform)
           is removed by a smooth local surface displacement: the overlapping surface patches of both bones are moved
           apart (half each) and the displacement is spread over neighbouring vertices with Laplacian smoothing, so the
           bones keep their shape away from the joint surfaces.
"""
import numpy as np
from scipy import sparse
from scipy.spatial import cKDTree

from lib.mesh import sample_surface, dense_points
from fit.foot_geom import TriMesh, Sim4


def kabsch(X, Y, w):
    """Rigid map (R, t) minimising sum w |R x + t - y|^2."""
    w = w / w.sum()
    mx, my = w @ X, w @ Y
    C = ((Y - my) * w[:, None]).T @ (X - mx)
    U, S, Vt = np.linalg.svd(C)
    D = np.eye(3); D[2, 2] = np.sign(np.linalg.det(U @ Vt))
    R = U @ D @ Vt
    return R, my - R @ mx


class Seat:
    def __init__(self, bones, pair_d=0.003, n=1500, seed=0):
        """bones: name -> rest mesh (Z-Anatomy space). Articulated pairs: bones whose rest surfaces come within pair_d."""
        self.bones = bones
        self.names = list(bones)
        self.tm = {b: TriMesh(*m) for b, m in bones.items()}
        rng = np.random.default_rng(seed)
        self.pts = {b: np.concatenate([m[0], sample_surface(*m, n, seed=int(rng.integers(1 << 30)))]) for b, m in bones.items()}
        lo = {b: m[0].min(0) for b, m in bones.items()}; hi = {b: m[0].max(0) for b, m in bones.items()}
        self.facets = []   # (a, b, rest points of a facing b, rest signed distance)
        for i, a in enumerate(self.names):
            for b in self.names[i + 1:]:
                if np.any(lo[a] > hi[b] + pair_d) or np.any(lo[b] > hi[a] + pair_d): continue
                for x, y in ((a, b), (b, a)):
                    P = self.pts[x]
                    sd = self.tm[y].signed(P)
                    m = sd < pair_d
                    if m.sum() >= 8: self.facets.append((x, y, P[m], sd[m]))

    def joint_spaces(self, W):
        """Per articulated pair: (current median, rest median scaled) facet distance in mm."""
        out = {}
        for a, b, P, sd0 in self.facets:
            X = W[a](P); s = W[b].scale()
            sd = s * self.tm[b].signed(W[b].inverse()(X))
            out[f'{a}|{b}'] = (float(np.median(sd) * 1000), float(np.median(s * np.maximum(sd0, 0)) * 1000))
        return out

    def relax(self, W, constraints, iters=40, damp=0.6, anchor=0.02, log=None):
        """W: name -> Sim4 (rest -> body). constraints(name, X) -> (sources, displacements, weights) or None, for the
        body-side constraints of bone `name` whose current surface samples are X. Returns the updated maps."""
        W = dict(W)
        for it in range(iters):
            moves = {b: [] for b in self.names}
            for a, b, P, sd0 in self.facets:
                X = W[a](P); s = W[b].scale()
                Y = W[b].inverse()(X)
                q, d, _, n = self.tm[b].closest(Y)
                sgn = np.sign(np.einsum('ij,ij->i', Y - q, n)); sgn[sgn == 0] = 1
                sd = s * sgn * d
                nw = W[b].vec(n); nw /= np.linalg.norm(nw, axis=1, keepdims=True)
                target = s * np.maximum(sd0, 0.0)
                delta = (target - sd)[:, None] * nw * 0.5
                moves[a].append((X, delta, np.ones(len(X))))
            maxmove = 0.0
            newW = {}
            for b in self.names:
                Xb = W[b](self.pts[b])
                ext = constraints(b, Xb, W)
                if ext is not None: moves[b].append(ext)
                if not moves[b]: newW[b] = W[b]; continue
                X = np.concatenate([m[0] for m in moves[b]] + [Xb]); D = np.concatenate([m[1] for m in moves[b]] + [np.zeros_like(Xb)])
                w = np.concatenate([m[2] for m in moves[b]] + [np.full(len(Xb), anchor)])
                R, t = kabsch(X, X + damp * D, w)
                M = Sim4(R, t)
                newW[b] = W[b].then(M)
                maxmove = max(maxmove, float(np.abs(M(Xb) - Xb).max()))
            W = newW
            if log and (it % 10 == 0 or it == iters - 1): log(f'      relax {it}: max move {maxmove * 1000:.3f} mm')
            if maxmove < 2e-5: break
        return W


def _adjacency(f, n):
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    A = sparse.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    A.data[:] = 1.0
    deg = np.asarray(A.sum(1)).ravel(); deg[deg == 0] = 1
    return A, deg


def push_out(meshes, fixed=(), gap=0.0003, iters=25, smooth=3, extra=None, log=None):
    """Separate overlapping bones by moving their vertices apart (half each; a bone listed in `fixed` does not move)
    with Laplacian-smoothed displacements. extra(name, V) -> per-vertex displacement for body-side constraints."""
    V = {b: m[0].copy() for b, m in meshes.items()}
    F = {b: m[1] for b, m in meshes.items()}
    adj = {b: _adjacency(F[b], len(V[b])) for b in V}
    names = list(V)
    for it in range(iters):
        tms = {b: TriMesh(V[b], F[b]) for b in names}
        lo = {b: V[b].min(0) for b in names}; hi = {b: V[b].max(0) for b in names}
        disp = {b: np.zeros_like(V[b]) for b in names}
        worst = 0.0
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                if np.any(lo[a] > hi[b] + gap) or np.any(lo[b] > hi[a] + gap): continue
                for x, y in ((a, b), (b, a)):
                    if x in fixed: continue
                    share = 1.0 if y in fixed else 0.5
                    p = V[x]; m = np.all((p > lo[y] - gap) & (p < hi[y] + gap), axis=1)
                    if not m.any(): continue
                    q, d, _, n = tms[y].closest(p[m])
                    sgn = np.sign(np.einsum('ij,ij->i', p[m] - q, n)); sgn[sgn == 0] = 1
                    sd = sgn * d
                    bad = sd < gap
                    if not bad.any(): continue
                    worst = max(worst, float(gap - sd[bad].min()))
                    idx = np.flatnonzero(m)[bad]
                    disp[x][idx] += ((gap - sd[bad]) * share)[:, None] * n[bad]
        if extra is not None:
            for b in names:
                if b in fixed: continue
                e = extra(b, V[b])
                if e is not None:
                    disp[b] += e; worst = max(worst, float(np.linalg.norm(e, axis=1).max()))
        if worst < 2e-5: break
        for b in names:
            D = disp[b]
            if not D.any(): continue
            A, deg = adj[b]
            # spread the displacement to the neighbouring ring(s), never below what each vertex asked for
            need = np.linalg.norm(D, axis=1)
            S = D.copy()
            for _ in range(smooth): S = 0.5 * S + 0.5 * (A @ S) / deg[:, None]
            ns = np.linalg.norm(S, axis=1)
            scale = np.where((need > 0) & (ns > 1e-12), np.maximum(need / np.maximum(ns, 1e-12), 1.0), 1.0)
            V[b] = V[b] + S * scale[:, None] * 1.1
        if log and (it % 5 == 0): log(f'      push-out {it}: worst overlap {worst * 1000:.3f} mm')
    return {b: (V[b], F[b]) for b in names}
