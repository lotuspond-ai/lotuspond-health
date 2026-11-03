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
BULGE = 0.0006           # outward bulge of the anulus at mid-height (m)
NTH = 96                 # angular samples
DR = 0.0004              # radial step when tracing the outline (m)


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


def disc_region(Uf, Lf, origin, axis, half=0.05, step=0.001, tmax=0.03, max_one=0.014, max_sum=0.02):
    """2D map of the disc space in the plane through origin perpendicular to axis. Returns (centre, axis, info)."""
    e1, e2 = frame(axis)
    us = np.arange(-half * 0.7, half + 1e-9, step); ws = np.arange(-half * 0.8, half * 0.8 + 1e-9, step)
    U_, W_ = np.meshgrid(us, ws, indexing='ij')
    O = origin + U_.reshape(-1, 1) * e1 + W_.reshape(-1, 1) * e2
    du = trace(Uf, O, axis, tmax).reshape(U_.shape); dl = trace(Lf, O, -axis, tmax).reshape(U_.shape)
    from scipy import ndimage
    canal = (~np.isfinite(du)) & (~np.isfinite(dl)) & ~np.isnan(du) & ~np.isnan(dl)
    lab, k = ndimage.label(canal)
    u_front = None
    if k:
        # the canal: the miss region nearest the origin's column, near the midline
        centre_band = np.abs(W_) < 0.006
        best, bestd = None, np.inf
        for c in range(1, k + 1):
            m = lab == c
            if m.sum() < 8: continue
            dd = np.abs(U_[m]).min() + np.abs(W_[m]).min()
            if (m & centre_band).any() and dd < bestd: best, bestd = c, dd
        if best is not None:
            m = (lab == best) & centre_band
            u_front = float(U_[m].max())
    disc = np.isfinite(du) & np.isfinite(dl) & (du < max_one) & (dl < max_one) & (du + dl < max_sum)
    if u_front is not None: disc &= U_ > u_front + 0.001
    lab, k = ndimage.label(disc)
    if not k: return None
    sizes = ndimage.sum(disc, lab, index=np.arange(1, k + 1))
    m = lab == (1 + int(np.argmax(sizes)))
    uc, wc = U_[m].mean(), W_[m].mean()
    pts_u = O.reshape(U_.shape + (3,))[m] + du[m][:, None] * axis
    pts_l = O.reshape(U_.shape + (3,))[m] - dl[m][:, None] * axis
    nu = Uf.grad(pts_u); nl = Lf.grad(pts_l)
    new_axis = nl.mean(0) - nu.mean(0); new_axis /= np.linalg.norm(new_axis)
    c = origin + uc * e1 + wc * e2
    # centre at mid-height of the gap at the region's centre
    cu = trace(Uf, c[None], new_axis, tmax)[0]; cl = trace(Lf, c[None], -new_axis, tmax)[0]
    if np.isfinite(cu) and np.isfinite(cl): c = c + new_axis * (cu - cl) / 2
    return c, new_axis, dict(area_cm2=float(m.sum() * step * step * 1e4), canal_front_mm=None if u_front is None else round(u_front * 1000, 1))


def build_disc(up, lo):
    """up, lo: ribcage_data.Target of the vertebrae above and below. Returns (mesh, top_idx, bottom_idx, info)."""
    Uf, Lf = up.field, lo.field
    cu_, cl_ = up.parts[0].v.mean(0), lo.parts[0].v.mean(0)
    axis = cu_ - cl_; axis /= np.linalg.norm(axis)
    origin = 0.5 * (cu_ + cl_)
    r = disc_region(Uf, Lf, origin, axis)
    if r is None: return None
    centre, axis, info0 = r
    r = disc_region(Uf, Lf, centre, axis, half=0.035, step=0.0007)
    if r is None: return None
    centre, axis, info1 = r
    e1, e2 = frame(axis)
    th = np.linspace(0, 2 * np.pi, NTH, endpoint=False)
    rs = np.arange(0, 0.04, DR)
    dirs = np.cos(th)[:, None] * e1 + np.sin(th)[:, None] * e2
    O = (centre + rs[None, :, None] * dirs[:, None, :]).reshape(-1, 3)
    h0u = trace(Uf, centre[None], axis)[0]; h0l = trace(Lf, centre[None], -axis)[0]
    if not (np.isfinite(h0u) and np.isfinite(h0l)): return None
    tmax = (h0u + h0l) + 0.006
    hu = trace(Uf, O, axis, tmax).reshape(len(th), len(rs)); hl = trace(Lf, O, -axis, tmax).reshape(len(th), len(rs))
    # plate normals along the rays: the rim is where the plate turns away from the axis
    R = np.zeros(len(th))
    for j in range(len(th)):
        k = 0
        while k + 1 < len(rs):
            a, b = hu[j, k + 1], hl[j, k + 1]
            if not (np.isfinite(a) and np.isfinite(b)): break
            if abs(a - hu[j, k]) > 0.001 or abs(b - hl[j, k]) > 0.001: break
            if a + b < 2 * GAP + 0.0004: break
            k += 1
        R[j] = rs[k]
    if R.min() < 0.002: return None
    # outline: drop single-ray notches, then smooth, never beyond the traced rim
    Rm = np.minimum.reduce([np.roll(R, s) for s in (-1, 0, 1)])
    Rs = np.convolve(np.concatenate([Rm[-2:], Rm, Rm[:2]]), np.ones(5) / 5, mode='valid')
    R = np.minimum(Rs, R)
    # rim normals: back off where the plate is steep (normal > 50 degrees from the axis) near the edge
    K = 10
    rings = np.linspace(0, 1, K + 1)[1:]

    def h_at(h, j, r):
        row = h[j].copy(); fin = np.isfinite(row)
        last = np.flatnonzero(fin).max(); row[~fin] = row[last]
        return np.interp(r, rs, row)
    top = np.zeros((len(th), K, 3)); bot = np.zeros((len(th), K, 3))
    for j in range(len(th)):
        r = R[j] * rings
        top[j] = centre + r[:, None] * dirs[j] + axis * (h_at(hu, j, r) - GAP)[:, None]
        bot[j] = centre + r[:, None] * dirs[j] - axis * (h_at(hl, j, r) - GAP)[:, None]
    ct = centre + axis * (h0u - GAP); cb = centre - axis * (h0l - GAP)
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
    inner = (np.arange(n * K) % K) < K - 1          # cap vertices off the rim (the rim joins the wall)
    top_idx = np.concatenate([[0], (i_top + np.arange(n * K))[inner]])
    bot_idx = np.concatenate([[i_cb], (i_bot + np.arange(n * K))[inner]])
    info = dict(centre_height_mm=round(float(h0u + h0l) * 1000, 2), outline_radius_mm=[round(float(R.min()) * 1000, 1), round(float(R.max()) * 1000, 1)],
                area_cm2=round(float(0.5 * np.sum(R ** 2) * (2 * np.pi / n)) * 1e4, 2), disc_space_cm2=round(info1['area_cm2'], 2),
                axis=[round(float(a), 3) for a in axis])
    return (V, F), top_idx, bot_idx, info


def levels(vkeys):
    """Disc levels present in a body, from C2/C3 down to the lumbosacral disc: [(name, upper, lower)]."""
    order = [k for k in [f'C{i}' for i in range(2, 8)] + [f'T{i}' for i in range(1, 13)] + [f'L{i}' for i in range(1, 7)] + ['S'] if k in vkeys]
    out = []
    for a, b in zip(order[:-1], order[1:]):
        out.append((f"disc_{a}_{'S1' if b == 'S' else b}", a, b))
    return out
