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

from lib.mesh import sample_surface, dense_points, face_normals
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
        self.contact_pairs = []
        for i, a in enumerate(self.names):
            for b in self.names[i + 1:]:
                self.contact_pairs.append((a, b))
                if np.any(lo[a] > hi[b] + pair_d) or np.any(lo[b] > hi[a] + pair_d): continue
                for x, y in ((a, b), (b, a)):
                    P = self.pts[x]
                    sd = self.tm[y].signed(P)
                    m = sd < pair_d
                    if m.sum() >= 8: self.facets.append((x, y, P[m], sd[m]))
        self.articulated = {(a, b) for a, b, _, _ in self.facets}

    def joint_spaces(self, W):
        """Per articulated pair: (current median, rest median scaled) facet distance in mm."""
        out = {}
        for a, b, P, sd0 in self.facets:
            X = W[a](P); s = W[b].scale()
            sd = s * self.tm[b].signed(W[b].inverse()(X))
            out[f'{a}|{b}'] = (float(np.median(sd) * 1000), float(np.median(s * np.maximum(sd0, 0)) * 1000))
        return out

    def relax(self, W, constraints, iters=40, damp=0.6, anchor=0.02, gap=0.0006, log=None):
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
                target = s * np.maximum(sd0, 0.0002)
                delta = (target - sd)[:, None] * nw * 0.5
                # joint spaces outweigh skin pressure (weight 1 per point) so small joints are not squeezed
                moves[a].append((X, delta, np.where(sd0 < 0.0002, 10.0, 5.0)))
            # one-sided contacts between bones that do not articulate (e.g. neighbouring toes): keep `gap` apart
            Xs = {b: W[b](self.pts[b]) for b in self.names}
            lo = {b: Xs[b].min(0) for b in self.names}; hi = {b: Xs[b].max(0) for b in self.names}
            for a, b in self.contact_pairs:
                if (a, b) in self.articulated or (b, a) in self.articulated: continue
                if np.any(lo[a] > hi[b] + 0.002) or np.any(lo[b] > hi[a] + 0.002): continue
                for x, y in ((a, b), (b, a)):
                    X = Xs[x]; m = np.all((X > lo[y] - 0.002) & (X < hi[y] + 0.002), axis=1)
                    if not m.any(): continue
                    s = W[y].scale(); Y = W[y].inverse()(X[m])
                    q, d, _, n = self.tm[y].closest(Y)
                    sgn = np.sign(np.einsum('ij,ij->i', Y - q, n)); sgn[sgn == 0] = 1
                    sd = s * sgn * d
                    bad = sd < gap
                    if not bad.any(): continue
                    nw = W[y].vec(n[bad]); nw /= np.linalg.norm(nw, axis=1, keepdims=True)
                    moves[x].append((X[m][bad], (gap - sd[bad])[:, None] * nw * 0.5, np.full(bad.sum(), 10.0)))
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


def _face_samples(v, f, n, seed):
    """Vertices plus area-weighted face samples, as (face or -1, barycentrics, vertex index or -1)."""
    rng = np.random.default_rng(seed)
    a = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
    fi = rng.choice(len(f), size=n, p=a / a.sum())
    r1, r2 = rng.random(n), rng.random(n); s = np.sqrt(r1)
    bary = np.stack([1 - s, s * (1 - r2), s * r2], 1)
    return fi, bary


def push_out(meshes, fixed=(), gap=0.00005, iters=40, smooth=4, extra=None, cap=0.0014, n=3000, step=0.6, log=None):
    """Separate overlapping bones by moving their surfaces apart (half each; a bone in `fixed` does not move). Overlap is
    tested on vertices and dense face samples; a sample that is too deep asks its face's vertices to move (shared by
    barycentric weight, averaged per vertex); the displacements are spread to the neighbouring ring(s) by Laplacian smoothing (never below what a vertex asked for)
    and no vertex moves more than `cap` in total. extra(name, V) -> per-vertex displacement for body-side constraints."""
    V = {b: m[0].copy() for b, m in meshes.items()}
    V0 = {b: m[0].copy() for b, m in meshes.items()}
    F = {b: m[1] for b, m in meshes.items()}
    N0 = {b: face_normals(V[b], F[b]) for b in V}
    adj = {b: _adjacency(F[b], len(V[b])) for b in V}
    smp = {b: _face_samples(V[b], F[b], n, seed=i) for i, b in enumerate(V)}
    names = list(V)
    for it in range(iters):
        tms = {b: TriMesh(V[b], F[b]) for b in names}
        P = {}
        for b in names:
            fi, bary = smp[b]
            P[b] = np.concatenate([V[b], np.einsum('ij,ijk->ik', bary, V[b][F[b][fi]])])
        lo = {b: V[b].min(0) for b in names}; hi = {b: V[b].max(0) for b in names}
        num = {b: np.zeros_like(V[b]) for b in names}
        den = {b: np.zeros(len(V[b])) for b in names}
        worst = 0.0
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                if np.any(lo[a] > hi[b] + gap) or np.any(lo[b] > hi[a] + gap): continue
                for x, y in ((a, b), (b, a)):
                    if x in fixed: continue
                    share = 1.0 if y in fixed else 0.5
                    p = P[x]; m = np.all((p > lo[y] - gap) & (p < hi[y] + gap), axis=1)
                    if not m.any(): continue
                    q, d, _, nn = tms[y].closest(p[m])
                    sgn = np.sign(np.einsum('ij,ij->i', p[m] - q, nn)); sgn[sgn == 0] = 1
                    sd = sgn * d
                    bad = sd < gap
                    if not bad.any(): continue
                    worst = max(worst, float(gap - sd[bad].min()))
                    idx = np.flatnonzero(m)[bad]
                    need = ((gap - sd[bad]) * share)[:, None] * nn[bad]
                    nv = len(V[x])
                    isv = idx < nv
                    # vertex demands count fully for their vertex; face-sample demands are shared by the face's
                    # vertices in proportion to the barycentric weights (averaged per vertex below)
                    np.add.at(num[x], idx[isv], need[isv]); np.add.at(den[x], idx[isv], 1.0)
                    fs = idx[~isv] - nv
                    tri = F[x][smp[x][0][fs]]; bw = smp[x][1][fs]
                    for c in range(3):
                        np.add.at(num[x], tri[:, c], need[~isv] * bw[:, c:c + 1]); np.add.at(den[x], tri[:, c], bw[:, c])
        disp = {b: np.where(den[b][:, None] > 0, num[b] / np.maximum(den[b], 1e-12)[:, None], 0.0) for b in names}
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
            need = np.linalg.norm(D, axis=1)
            S = D.copy()
            for _ in range(smooth): S = 0.5 * S + 0.5 * (A @ S) / deg[:, None]
            # every vertex that asked to move gets at least its own demand along its own direction
            dh = np.where(need[:, None] > 0, D / np.maximum(need, 1e-12)[:, None], 0.0)
            along = np.einsum('ij,ij->i', S, dh)
            S = step * (S + np.maximum(need - along, 0)[:, None] * dh)
            tot = V[b] + S - V0[b]; L = np.linalg.norm(tot, axis=1)
            over = L > cap
            if over.any(): tot[over] *= (cap / L[over])[:, None]
            Vn = V0[b] + tot
            # refuse moves that would fold the surface (a face turning by more than ~70 degrees)
            n1 = face_normals(Vn, F[b])
            bad = np.einsum('ij,ij->i', n1, N0[b]) < 0.35
            if bad.any():
                vb = np.unique(F[b][bad]); Vn[vb] = V[b][vb]
            V[b] = Vn
        if log and (it % 5 == 0): log(f'      push-out {it}: worst overlap {worst * 1000:.3f} mm')
    return {b: (V[b], F[b]) for b in names}
