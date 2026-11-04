"""Ribcage fit, part 3: intervertebral discs, built from the HRA vertebral end plates.

The extracted Z-Anatomy data has no disc meshes (neither za-skeletal nor za-muscular, nor the source FBX files, contain
an intervertebral disc), so each disc is made to fill the space it occupies in the body:

  1. a frame for the disc space: the axis from the lower to the upper vertebra, the front (+z) in the plane
  2. rays cast up and down from the mid-plane through the exact signed-distance fields of the two vertebrae (sphere
     tracing) find the spinal canal (rays that pass both vertebrae without touching bone) and, in front of it, the
     region where both vertebral bodies are hit at disc-like distances: the largest such region is the disc space
  3. its centre and the mean end-plate normal refine the frame; the outline is traced from the centre along radial
     lines and ends where an end plate stops (a ray misses, the hit height jumps at the rim, or the plates meet)
  4. the disc's top and bottom follow the end plates at GAP from the bone; the side wall (anulus fibrosus) joins the
     two rims and bulges out by BULGE at mid-height
Every level from C2/C3 to the lumbosacral disc is built the same way, so the female's sixth lumbar vertebra simply
adds the L5/L6 and L6/S1 levels.
"""
import numpy as np
from scipy.sparse.csgraph import connected_components
from scipy import sparse

from lib.mesh import face_normals, orient_outward, area

GAP = 0.00015            # disc surface to end plate (m)
BULGE = 0.0005           # outward bulge of the anulus at mid-height (m)
NTH = 96                 # angular samples
DR = 0.0004              # radial step when tracing the outline (m)
MIN_T = 0.0002           # thinnest disc where the end plates (nearly) touch (m)
STEEP = 4.0 / 3.0        # the outline ends where an end plate rises faster than this: tan 53 deg, the same facing limit
                         # (normal within 53 deg of the disc axis) the disc-space map uses; 0.75 (37 deg) left a 2 mm
                         # empty rim on the saddle-shaped cervical end plates (64-70 % of the disc space covered)


def vertex_normals(v, f):
    fn = face_normals(v, f, unit=False)
    vn = np.zeros_like(v)
    for k in range(3): np.add.at(vn, f[:, k], fn)
    return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)


def facing_patch(a, b_target, max_d=0.016, cos_min=0.7):
    """Vertices of mesh a (v, f) that face mesh b across a gap: within max_d of b, normal pointing at b.
    Returns face indices of the largest connected patch."""
    v, f = a
    vn = vertex_normals(v, f)
    p = v
    q, d = b_target.closest(p)
    to = (q - p) / np.maximum(d[:, None], 1e-9)
    ok = (d < max_d) & (np.einsum('ij,ij->i', vn, to) > cos_min)
    fok = ok[f].all(1)
    if fok.sum() < 3: return np.zeros(0, int)
    idx = np.flatnonzero(fok)
    sub = f[idx]
    # face adjacency through shared vertices
    rows = np.repeat(np.arange(len(sub)), 3)
    A = sparse.coo_matrix((np.ones(len(rows)), (rows, sub.ravel())), shape=(len(sub), len(v))).tocsr()
    k, lab = connected_components(A @ A.T, directed=False)
    areas = np.bincount(lab, weights=0.5 * np.linalg.norm(np.cross(v[sub[:, 1]] - v[sub[:, 0]], v[sub[:, 2]] - v[sub[:, 0]]), axis=1), minlength=k)
    return idx[lab == np.argmax(areas)]


def ray_heights(o, axis, v, f, sign):
    """For rays from points o along sign*axis: distance to the first hit on triangles (v, f) (inf if none)."""
    d = axis * sign
    A, B, C = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    e1, e2 = B - A, C - A
    out = np.full(len(o), np.inf)
    pvec = np.cross(d, e2)                       # (T, 3)
    det = np.einsum('ij,ij->i', e1, pvec)
    good = np.abs(det) > 1e-14
    A, e1, e2, pvec, det = A[good], e1[good], e2[good], pvec[good], det[good]
    inv = 1.0 / det
    for i0 in range(0, len(o), 256):
        oo = o[i0:i0 + 256]
        tvec = oo[:, None, :] - A[None]                                  # (R, T, 3)
        u = np.einsum('rtj,tj->rt', tvec, pvec) * inv
        qvec = np.cross(tvec, e1[None])
        w = np.einsum('j,rtj->rt', d, qvec) * inv
        t = np.einsum('tj,rtj->rt', e2, qvec) * inv
        hit = (u >= 0) & (w >= 0) & (u + w <= 1) & (t > 0)
        t = np.where(hit, t, np.inf)
        out[i0:i0 + 256] = t.min(1)
    return out


class _Closest:
    def __init__(self, part):
        self.part = part

    def closest(self, p):
        from fit.ribcage_data import closest_faces
        q, d, _ = closest_faces(self.part.v, self.part.f, p, k=8, tree=self.part.tree)
        return q, d


def trace(field, o, d, tmax=0.04):
    """Distance along rays o + t d to the first zero of a signed distance field (sphere tracing); inf if none within
    tmax, nan if the ray starts inside."""
    t = np.zeros(len(o))
    s0 = field(o)
    live = s0 > 0
    for _ in range(300):
        if not live.any(): break
        s = field(o[live] + t[live, None] * d)
        step = np.maximum(s, 0.00008)
        hit = s < 0.00003
        tl = t[live] + np.where(hit, 0, step)
        t[live] = tl
        idx = np.flatnonzero(live)
        live[idx[hit | (tl > tmax)]] = False
    t[t > tmax] = np.inf
    # final secant refinement on the hits
    h = np.isfinite(t) & (s0 > 0)
    if h.any():
        p = o[h] + t[h, None] * d
        s1 = field(p); s2 = field(p + 0.0002 * d)
        slope = (s2 - s1) / 0.0002
        ok = slope < -0.2
        t[np.flatnonzero(h)[ok]] += -s1[ok] / slope[ok]
    t[~(s0 > 0)] = np.nan
    return t


def frame(axis):
    e1 = np.array([0, 0, 1.0]) - axis * axis[2]; e1 /= np.linalg.norm(e1)
    return e1, np.cross(axis, e1)


def column_gaps(Uf, Lf, base, axis, zr=0.016, dz=0.00025):
    """For columns base + z*axis (|z| <= zr): the free interval with the lower vertebra just below and the upper
    vertebra just above (the one nearest z = 0). Returns (top z, bottom z, empty) - top/bottom are nan where no such
    interval exists; empty marks columns that touch neither vertebra (canal, or outside)."""
    zs = np.arange(-zr, zr + dz / 2, dz)
    P = (base[:, None, :] + zs[None, :, None] * axis).reshape(-1, 3)
    su = Uf(P).reshape(len(base), len(zs)); sl = Lf(P).reshape(len(base), len(zs))
    iu, il = su < 0, sl < 0
    empty = ~iu.any(1) & ~il.any(1)
    top = np.full(len(base), np.nan); bot = np.full(len(base), np.nan)
    free = ~iu & ~il
    for i in np.flatnonzero(iu.any(1) & il.any(1)):
        d = np.diff(np.concatenate([[0], free[i].astype(np.int8), [0]]))
        starts = np.flatnonzero(d == 1); ends = np.flatnonzero(d == -1) - 1
        best = None
        for a, b in zip(starts, ends):
            if a == 0 or b == len(zs) - 1 or not (il[i, a - 1] and iu[i, b + 1]): continue
            dd = 0.0 if zs[a] <= 0 <= zs[b] else min(abs(zs[a]), abs(zs[b]))
            if best is None or dd < best[0]: best = (dd, a, b)
        if best is None: continue
        _, a, b = best
        bot[i] = zs[a - 1] + dz * (-sl[i, a - 1]) / (sl[i, a] - sl[i, a - 1])
        top[i] = zs[b] + dz * su[i, b] / (su[i, b] - su[i, b + 1])
    return top, bot, empty


def cord_position(cord, origin, axis, e1, e2):
    """In-plane position of the spinal cord at the disc level: (u of its anterior surface, w of its centre)."""
    if cord is None or not len(cord): return None
    rel = cord - origin
    h = rel @ axis; u = rel @ e1; w = rel @ e2
    m = (np.abs(h) < 0.004) & (np.hypot(u, w) < 0.04)
    if m.sum() < 20: return None
    return float(np.quantile(u[m], 0.98)), float(np.median(w[m]))


def disc_region(Uf, Lf, origin, axis, half=0.05, step=0.001, max_h=0.02, cord=None):
    """2D map of the disc space in the plane through origin perpendicular to axis. Returns (centre, axis, info).
    The disc space lies in front of the spinal canal: in front of the spinal cord where the body has one, else in
    front of the canal (an enclosed region of columns that touch neither vertebra)."""
    from scipy import ndimage
    e1, e2 = frame(axis)
    us = np.arange(-half * 0.7, half + 1e-9, step); ws = np.arange(-half * 0.8, half * 0.8 + 1e-9, step)
    U_, W_ = np.meshgrid(us, ws, indexing='ij')
    O = origin + U_.reshape(-1, 1) * e1 + W_.reshape(-1, 1) * e2
    top, bot, empty = column_gaps(Uf, Lf, O, axis)
    top = top.reshape(U_.shape); bot = bot.reshape(U_.shape); empty = empty.reshape(U_.shape)
    cp = cord_position(cord, origin, axis, e1, e2)
    u_front, w_c, how = None, 0.0, None
    if cp is not None:
        u_front, w_c = cp[0] + 0.001, cp[1]; how = 'cord'
    else:
        lab, k = ndimage.label(empty)
        if k:
            border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
            centre_band = np.abs(W_) < 0.006
            best, bests = None, 0
            for c in range(1, k + 1):
                if c in border: continue
                m = lab == c
                n_c = int((m & centre_band).sum())
                if m.sum() >= 8 and n_c > bests: best, bests = c, n_c
            if best is not None:
                u_front = float(U_[(lab == best) & centre_band].max()) + 0.001; how = 'canal'
                w_c = float(np.median(W_[lab == best]))
    disc = np.isfinite(top) & (top - bot < max_h)
    if u_front is not None: disc &= U_ > u_front
    if disc.any():
        Oc = O.reshape(U_.shape + (3,))[disc]
        gu = Uf.grad(Oc + top[disc][:, None] * axis); gl = Lf.grad(Oc + bot[disc][:, None] * axis)
        ok = (gu @ axis < -0.6) & (gl @ axis > 0.6)
        ii = np.argwhere(disc)[~ok]; disc[ii[:, 0], ii[:, 1]] = False
    lab, k = ndimage.label(disc)
    if not k: return None
    if u_front is not None:
        # the component just in front of the canal, on its midline
        seed = (U_ > u_front) & (U_ < u_front + 0.012) & (np.abs(W_ - w_c) < 0.004) & disc
        if seed.any():
            ids, cnt = np.unique(lab[seed], return_counts=True)
            m = lab == ids[np.argmax(cnt)]
        else:
            sizes = ndimage.sum(disc, lab, index=np.arange(1, k + 1)); m = lab == (1 + int(np.argmax(sizes)))
    else:
        sizes = ndimage.sum(disc, lab, index=np.arange(1, k + 1)); m = lab == (1 + int(np.argmax(sizes)))
    Oc = O.reshape(U_.shape + (3,))[m]
    pu = Oc + top[m][:, None] * axis; pl = Oc + bot[m][:, None] * axis
    # axis from the central strip of the disc (the end plates proper, away from uncinate processes and the rim)
    wm = W_[m]; core = np.abs(wm - np.median(wm)) < max(0.004, 0.35 * np.ptp(wm) / 2)
    new_axis = Lf.grad(pl[core]).mean(0) - Uf.grad(pu[core]).mean(0); new_axis /= np.linalg.norm(new_axis)
    c = 0.5 * (pu.mean(0) + pl.mean(0))
    return c, new_axis, dict(area_cm2=float(m.sum() * step * step * 1e4), canal=how, canal_front_mm=None if u_front is None else round(u_front * 1000, 1))


def build_disc(up, lo, cord=None):
    """up, lo: ribcage_data.Target of the vertebrae above and below. Returns (mesh, top_idx, bottom_idx, info)."""
    Uf, Lf = up.field, lo.field
    U, L = up.parts[0], lo.parts[0]
    # first guess: the facing end-plate patches (may include facet joints; the maps below drop them)
    fu = facing_patch((U.v, U.f), _Closest(L)); fl = facing_patch((L.v, L.f), _Closest(U))
    if len(fu) >= 4 and len(fl) >= 4:
        nu = face_normals(U.v, U.f[fu]).mean(0); nl = face_normals(L.v, L.f[fl]).mean(0)
        axis = nl - nu; axis /= np.linalg.norm(axis)
        origin = 0.5 * (U.v[U.f[fu]].mean((0, 1)) + L.v[L.f[fl]].mean((0, 1)))
    else:
        cu_, cl_ = U.v.mean(0), L.v.mean(0)
        axis = cu_ - cl_; axis /= np.linalg.norm(axis); origin = 0.5 * (cu_ + cl_)
    centre = origin
    for it, (half, step) in enumerate(((0.05, 0.001), (0.035, 0.0007), (0.03, 0.0006))):
        r = disc_region(Uf, Lf, centre, axis, half=half, step=step, cord=cord)
        if r is None:
            build_disc.why = f'no disc space in map {it + 1}'; return None
        centre, axis, info1 = r
    e1, e2 = frame(axis)
    th = np.linspace(0, 2 * np.pi, NTH, endpoint=False)
    rs = np.arange(0, 0.04, DR)
    dirs = np.cos(th)[:, None] * e1 + np.sin(th)[:, None] * e2
    O = (centre + rs[None, :, None] * dirs[:, None, :]).reshape(-1, 3)
    tp, bt, _ = column_gaps(Uf, Lf, O, axis, zr=0.012)
    tp = tp.reshape(len(th), len(rs)); bt = bt.reshape(len(th), len(rs))
    if not (np.isfinite(tp[:, 0]).all()):
        build_disc.why = 'centre column has no gap'; return None
    R = np.zeros(len(th))
    for j in range(len(th)):
        k = 0
        while k + 1 < len(rs):
            a, b = tp[j, k + 1], bt[j, k + 1]
            if not np.isfinite(a): break
            if abs(a - tp[j, k]) > STEEP * DR or abs(b - bt[j, k]) > STEEP * DR: break
            k += 1
        R[j] = rs[k]
    if R.min() < 0.002:
        build_disc.why = f'outline too small (min radius {R.min() * 1000:.1f} mm)'; return None
    Rm = np.minimum.reduce([np.roll(R, s) for s in (-1, 0, 1)])
    Rs = np.convolve(np.concatenate([Rm[-2:], Rm, Rm[:2]]), np.ones(5) / 5, mode='valid')
    R = np.minimum(Rs, R)
    K = 14
    t_ = np.linspace(0, 1, K + 1)[1:]
    rings = 1 - (1 - t_) ** 1.6             # denser toward the rim, where the end plates curve

    def at(h, j, r):
        row = h[j].copy(); fin = np.isfinite(row)
        last = np.flatnonzero(fin).max(); row[~fin] = row[last]
        return np.interp(r, rs, row)

    def caps(t, b):
        # top and bottom GAP off the bone, never thinner than MIN_T (where the plates nearly touch the disc thins)
        t2, b2 = t - GAP, b + GAP
        short = t2 - b2 < MIN_T
        mid = (t + b) / 2
        return np.where(short, mid + MIN_T / 2, t2), np.where(short, mid - MIN_T / 2, b2)
    top = np.zeros((len(th), K, 3)); bot = np.zeros((len(th), K, 3))
    for j in range(len(th)):
        r = R[j] * rings
        t, b = caps(at(tp, j, r), at(bt, j, r))
        top[j] = centre + r[:, None] * dirs[j] + axis * t[:, None]
        bot[j] = centre + r[:, None] * dirs[j] + axis * b[:, None]
    t0, b0 = caps(np.array([tp[0, 0]]), np.array([bt[0, 0]]))
    ct = centre + axis * t0[0]; cb = centre + axis * b0[0]
    M_ = 5
    side = np.array([(1 - m / M_) * top[:, -1] + (m / M_) * bot[:, -1] + (np.sin(np.pi * m / M_) * BULGE) * dirs for m in range(1, M_)])
    n = len(th)
    i_top = 1; i_cb = 1 + n * K; i_bot = i_cb + 1; i_side = i_bot + n * K
    V = np.concatenate([ct[None], top.reshape(-1, 3), cb[None], bot.reshape(-1, 3), side.reshape(-1, 3)])
    T_ = lambda j, k: i_top + (j % n) * K + k
    B_ = lambda j, k: i_bot + (j % n) * K + k
    S_ = lambda m, j: i_side + m * n + (j % n)
    F = []
    for j in range(n):
        F.append((0, T_(j, 0), T_(j + 1, 0)))
        F.append((i_cb, B_(j + 1, 0), B_(j, 0)))
        for k in range(K - 1):
            F += [(T_(j, k), T_(j, k + 1), T_(j + 1, k + 1)), (T_(j, k), T_(j + 1, k + 1), T_(j + 1, k))]
            F += [(B_(j, k), B_(j + 1, k + 1), B_(j, k + 1)), (B_(j, k), B_(j + 1, k), B_(j + 1, k + 1))]
        chain = [T_(j, K - 1)] + [S_(m, j) for m in range(M_ - 1)] + [B_(j, K - 1)]
        chain1 = [T_(j + 1, K - 1)] + [S_(m, j + 1) for m in range(M_ - 1)] + [B_(j + 1, K - 1)]
        for a in range(len(chain) - 1):
            F += [(chain[a], chain[a + 1], chain1[a + 1]), (chain[a], chain1[a + 1], chain1[a])]
    F = orient_outward(V, np.array(F, np.int64))
    V = push_out(V, F, up, lo, axis)
    inner = (np.arange(n * K) % K) < K - 1          # cap vertices off the rim (the rim joins the wall)
    top_idx = np.concatenate([[0], (i_top + np.arange(n * K))[inner]])
    bot_idx = np.concatenate([[i_cb], (i_bot + np.arange(n * K))[inner]])
    info = dict(centre_height_mm=round(float(tp[0, 0] - bt[0, 0]) * 1000, 2), outline_radius_mm=[round(float(R.min()) * 1000, 1), round(float(R.max()) * 1000, 1)],
                area_cm2=round(float(0.5 * np.sum(R ** 2) * (2 * np.pi / n)) * 1e4, 2), disc_space_cm2=round(info1['area_cm2'], 2),
                axis=[round(float(a), 3) for a in axis])
    return (V, F), top_idx, bot_idx, info


def push_out(V, F, up, lo, axis, clear=0.00005, iters=6):
    """Move vertices along the disc axis (down from the upper vertebra, up from the lower one) wherever points on the
    triangles (centroids and edge midpoints) enter bone, so the flat triangles never cut into a curved end plate."""
    V = V.copy()
    bary = np.array([[1, 1, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1], [4, 1, 1], [1, 4, 1], [1, 1, 4]], float)
    bary /= bary.sum(1, keepdims=True)
    for _ in range(iters):
        moved = False
        for tgt, sgn in ((up, -1.0), (lo, 1.0)):
            P = np.einsum('kj,fjd->fkd', bary, V[F]).reshape(-1, 3)
            d = tgt.field(P)
            near = d < 0.0015
            if near.any(): d[near] = tgt.exact(P[near])
            need = np.maximum(clear - d, 0).reshape(len(F), len(bary)).max(1)
            if not (need > 0).any(): continue
            push = np.zeros(len(V))
            for k in range(3): np.maximum.at(push, F[:, k], need)
            V += sgn * push[:, None] * axis
            moved = True
        if not moved: break
    return V


def levels(vkeys):
    """Disc levels present in a body, from C2/C3 down to the lumbosacral disc: [(name, upper, lower)]."""
    order = [k for k in [f'C{i}' for i in range(2, 8)] + [f'T{i}' for i in range(1, 13)] + [f'L{i}' for i in range(1, 7)] + ['S'] if k in vkeys]
    out = []
    for a, b in zip(order[:-1], order[1:]):
        out.append((f"disc_{a}_{'S1' if b == 'S' else b}", a, b))
    return out
