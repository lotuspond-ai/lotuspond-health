"""Ribcage fit, part 2: the ribs.

Anatomy used:
  * every rib head articulates with the bodies of its vertebrae (ribs 2-9: the demifacets of T(n-1) and T(n), across
    the disc; ribs 1, 10, 11, 12: their own vertebra), and the tubercle of ribs 1-10 with the transverse process of T(n)
  * the head and tubercle together fix the rib's posterior end; the rib turns about the axis through them (its neck)
  * the costal pleura lines the inner surface of the ribs, so the lungs lie just inside the ribs and never cross them

Method, per rib:
  1. articular facets are read off Z-Anatomy itself, where the rib touches its vertebrae (head: the vertebral bodies;
     tubercle: the transverse process), together with the gap Z-Anatomy leaves at each facet point
  2. the posterior segment (head, neck, tubercle) gets the rigid motion that seats those facets on the HRA vertebrae at
     the same gaps, without entering any vertebra or lung; the motion fades out along the rib (smoothstep, 8 cm)
  3. the rest of the rib bends, as a whole cross-section at a time (a smooth B-spline displacement of the rib's
     centreline, zero at the joints), just enough to clear the lungs, heart and liver and to keep below the skin
"""
import numpy as np
from scipy import sparse, optimize
from scipy.sparse.csgraph import dijkstra, connected_components
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

from lib.mesh import dense_points

FACET_D = 0.003          # a rib point within this of its vertebra (in Z-Anatomy) belongs to an articular facet
BODY_X = 0.026           # facet points nearer the midline than this sit on the vertebral body (head), else on the
                         # transverse process (tubercle)
LUNG_CLEAR = 0.0012      # ribs keep this far outside the lung surface (parietal pleura + endothoracic fascia)
ORGAN_CLEAR = 0.0015     # ...and this far from heart, liver, spleen and kidneys
SKIN_CLEAR = 0.004       # ...and this far inside the skin (the acceptance limit is 3 mm)
FADE = 0.08              # length (m) over which the joint seating fades out along the rib
JOINT_GAP = 0.001        # bone-to-bone gap aimed for at the costovertebral and costotransverse joints (m)


def edges(f):
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    return np.unique(np.sort(e, axis=1), axis=0)


def graph(v, f):
    e = edges(f)
    w = np.linalg.norm(v[e[:, 0]] - v[e[:, 1]], axis=1)
    n = len(v)
    return sparse.coo_matrix((np.concatenate([w, w]), (np.concatenate([e[:, 0], e[:, 1]]), np.concatenate([e[:, 1], e[:, 0]]))), shape=(n, n)).tocsr()


def mask_components(f, mask):
    n = len(mask)
    e = edges(f); e = e[mask[e[:, 0]] & mask[e[:, 1]]]
    A = sparse.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n))
    _, lab = connected_components(A, directed=False)
    return [np.flatnonzero((lab == c) & mask) for c in np.unique(lab[mask])]


class RibGeom:
    """Arc-length parameter and articular facets of one Z-Anatomy rib (computed in Z-Anatomy space)."""

    def __init__(self, n, side, v_za, f, za_vert):
        self.n, self.side, self.f = n, side, f
        self.v_za = v_za
        trees = {k: cKDTree(dense_points(*m, 0.0004)) for k, m in za_vert.items()}
        own = f'T{n}'; above = f'T{n - 1}' if n > 1 else None
        d_own, _ = trees[own].query(v_za)
        mid_x = za_vert[own][0][:, 0].mean()
        lat = np.abs(v_za[:, 0] - mid_x)
        # facets: connected patches of near-contact points, split into vertebral body (head) and transverse process
        self.facets = {}
        hl = (d_own < FACET_D) & (lat < BODY_X)
        self.facets['head_lo'] = (np.flatnonzero(hl), d_own[hl])
        if above and above in trees:
            d_up, _ = trees[above].query(v_za)
            hu = (d_up < FACET_D) & (lat < BODY_X)
            if hu.sum() >= 10: self.facets['head_up'] = (np.flatnonzero(hu), d_up[hu])
        if n <= 10:
            tb = (d_own < FACET_D) & (lat >= BODY_X)
            comps = sorted(mask_components(f, tb), key=len, reverse=True)
            if comps: self.facets['tub'] = (comps[0], d_own[comps[0]])
        # arc length along the rib: geodesic distance from the head tip, binned into a centreline, then each vertex
        # projected onto the centreline (so every cross-section shares one parameter)
        head = np.concatenate([self.facets[k][0] for k in ('head_lo', 'head_up') if k in self.facets])
        hc = v_za[head].mean(0)
        tip = int(np.argmin(np.linalg.norm(v_za - hc, axis=1)))
        g = dijkstra(graph(v_za, f), indices=tip)
        g[~np.isfinite(g)] = np.nanmax(g[np.isfinite(g)])
        bins = np.arange(0, g.max() + 0.003, 0.003)
        cl = np.array([v_za[(g >= a) & (g < a + 0.006)].mean(0) for a in bins if ((g >= a) & (g < a + 0.006)).sum() > 3])
        k = np.ones(5) / 5
        cl = np.stack([np.convolve(np.pad(cl[:, a], 2, mode='edge'), k, mode='valid') for a in range(3)], 1)
        seg = np.linalg.norm(np.diff(cl, axis=0), axis=1)
        self.cl = cl; self.cl_s = np.concatenate([[0], np.cumsum(seg)])
        self.s = self.project(v_za)
        self.length = float(self.s.max())
        self.s_tub = float(np.median(self.s[self.facets['tub'][0]])) if 'tub' in self.facets else None
        self.s_head = float(np.median(self.s[head]))
        # end of the rigid posterior segment: just past the tubercle (ribs 1-10) or 3 cm along the neck (11, 12)
        self.s_rigid = rigid_end(self)
        # anterior end (costal cartilage side): the last 8 mm of arc length
        self.end = np.flatnonzero(self.s > self.length - 0.008)

    def project(self, p):
        """Arc length of the closest centreline point for each point."""
        a, b = self.cl[:-1], self.cl[1:]
        ab = b - a; L2 = np.maximum((ab ** 2).sum(1), 1e-12)
        best = np.full(len(p), np.inf); out = np.zeros(len(p))
        for i in range(len(a)):
            t = np.clip(((p - a[i]) @ ab[i]) / L2[i], 0, 1)
            q = a[i] + t[:, None] * ab[i]
            d = ((p - q) ** 2).sum(1)
            m = d < best; best[m] = d[m]; out[m] = self.cl_s[i] + t[m] * np.sqrt(L2[i])
        return out


def rigid_end(rg):
    """End of the rigid posterior segment: just past the tubercle (ribs 1-10) or 2.5 cm along the neck (11, 12)."""
    return (rg.s_tub + 0.006) if rg.s_tub is not None else rg.s_head + 0.025


def smoothstep(x):
    x = np.clip(x, 0, 1); return x * x * (3 - 2 * x)


def seat(rg, v, verts, lung, skip=None):
    """Seat the rib's articular facets on the HRA vertebrae. v: the warped rib (HRA space); verts: {'T5': Target}.
    Ribs 2-9: the head's two facets on T(n-1) and T(n); ribs 1, 10, 11, 12: the head on T(n) alone, its centre
    nearer T(n) than the vertebra above; ribs 1-10: the tubercle on the transverse process of T(n).
    The motion: a rigid rotation (about axes across the neck) and translation of the posterior segment, faded out
    along the shaft over FADE; plus a roll of the head about the neck axis that untwists to zero at the tubercle (a
    torsion of the neck), so seating the head's demifacets does not swing the shaft. Returns (vertices, info)."""
    n = rg.n
    own = verts[f'T{n}']; up = verts.get(f'T{n - 1}') or (verts.get('C7') if n == 1 else None)
    two = 2 <= n <= 9
    terms = []                                   # (indices, target, gap, weight)
    i, g = rg.facets['head_lo']; terms.append((i, own, g, 1.0 if two else 2.0))     # a single facet carries the head alone
    if two:
        i, g = rg.facets['head_up']; terms.append((i, up, g, 1.0))
    if 'tub' in rg.facets:
        i, g = rg.facets['tub']; terms.append((i, own, g, 1.0))
    head_idx = np.concatenate([rg.facets[k][0] for k in ('head_lo', 'head_up') if k in rg.facets])
    c = v[head_idx].mean(0)
    s_end = rg.s_tub if rg.s_tub is not None else rg.s_head + 0.025       # where the neck torsion has untwisted
    if 'tub' in rg.facets:
        na = v[rg.facets['tub'][0]].mean(0) - c
    else:
        na = v[(rg.s > rg.s_head + 0.015) & (rg.s < rg.s_head + 0.03)].mean(0) - c
    na /= np.linalg.norm(na)
    # the warp places the facets along the vertebra to ~1 mm; the seating mainly closes the gap, along the
    # vertebra's surface normal at the head, and may slide the head only a little across it
    nv = own.field.grad(c[None])[0]
    w_fade = 1 - smoothstep((rg.s - rg.s_rigid) / FADE)
    w_roll = 1 - smoothstep((rg.s - (rg.s_head + 0.006)) / max(s_end - rg.s_head - 0.006, 0.004))
    post = np.flatnonzero(rg.s <= rg.s_rigid + 0.01)
    post_s = post[::3]
    s_free = (rg.s_tub + 0.004) if rg.s_tub is not None else rg.s_head + 0.025
    neck_m = (rg.s >= s_free) & (rg.s <= rg.s_rigid + 0.03)
    if skip is not None: neck_m &= ~skip                # the lung/spine conflict zone is not chased
    neck = np.flatnonzero(neck_m)[::3]
    near = [verts[k] for k in (f'T{n - 1}', f'T{n}', f'T{n + 1}', 'C7' if n == 1 else 'L1' if n == 12 else None) if k in verts]

    def apply(x, idx):
        p = v[idx]
        wn = x[:3] @ na
        Rp = Rotation.from_rotvec(x[:3] - wn * na).as_matrix()
        moved = (p - c) @ Rp.T + c + x[3:]
        q = p + w_fade[idx, None] * (moved - p)
        # neck torsion: roll about the (moved) neck axis, full at the head, none from the tubercle on
        ax = Rp @ na; c2 = c + x[3:]
        ang = wn * w_roll[idx]
        if np.any(ang != 0):
            k = ax; r = q - c2
            cs, sn = np.cos(ang)[:, None], np.sin(ang)[:, None]
            q = c2 + r * cs + np.cross(k, r) * sn + np.outer(r @ k, k) * (1 - cs)
        return q

    def resid(x):
        r = []
        for idx, tgt, gap, w in terms:
            # every facet point to the joint gap JOINT_GAP: the head sits in the socket of its demifacets
            d = tgt.sdf(apply(x, idx))
            r.append(w * (d - JOINT_GAP) / 0.0005 / np.sqrt(len(idx)) * 4)
        if not two and up is not None:
            # level: the head centre sits on its own vertebra, at least 1 mm nearer it than the one above (rib 10's
            # facet lies at the upper border of T10, next to the T9/T10 disc)
            hc = apply(x, head_idx).mean(0)[None]
            r.append(np.maximum(own.exact(hc) - up.exact(hc) + 0.0010, 0) / 0.0005 * 2)     # exact, as measured
        P = apply(x, post_s)
        for tgt in near:
            r.append(np.maximum(0.0003 - tgt.sdf(P), 0) / 0.0002 / np.sqrt(len(P)) * 6)
        if len(neck):
            Pn = apply(x, neck)
            r.append(np.maximum(LUNG_CLEAR - lung.sdf(Pn), 0) / 0.0005 / np.sqrt(len(Pn)) * 4)
        wn = x[:3] @ na
        r.append(np.array([wn / np.radians(12.0)]))              # neck torsion: a few degrees are anatomical
        r.append((x[:3] - wn * na) / np.radians(4.0))
        tn = x[3:] @ nv
        r.append(np.array([tn / 0.004]))
        r.append((x[3:] - tn * nv) / 0.0015)
        return np.concatenate(r)

    sol = optimize.least_squares(resid, np.zeros(6), method='trf', x_scale=np.array([0.02] * 3 + [0.002] * 3), max_nfev=400)
    x = sol.x
    out = apply(x, np.arange(len(v)))
    wn = x[:3] @ na
    info = dict(rot_deg=float(np.degrees(np.linalg.norm(x[:3] - wn * na))), neck_torsion_deg=float(np.degrees(wn)), shift_mm=float(np.linalg.norm(x[3:]) * 1000), cost=float(sol.cost))
    return out, info


def facet_gap(rg, v, verts):
    """Largest median distance of the rib's head and tubercle facets to their vertebrae (m)."""
    n = rg.n; out = 0.0
    for fk, vk in (('head_lo', f'T{n}'), ('head_up', f'T{n - 1}'), ('tub', f'T{n}')):
        if fk in rg.facets and vk in verts and not (fk == 'head_up' and not 2 <= n <= 9):
            out = max(out, float(np.median(np.abs(verts[vk].sdf(v[rg.facets[fk][0]])))))
    return out


def bspline_basis(s, knots_s, degree=3):
    """Uniform cubic B-spline basis matrix (len(s) x n_ctrl) over [knots_s[0], knots_s[-1]]."""
    from scipy.interpolate import BSpline
    h = knots_s[1] - knots_s[0]
    t = np.concatenate([knots_s[0] - h * np.arange(degree, 0, -1), knots_s, knots_s[-1] + h * np.arange(1, degree + 1)])
    nc = len(t) - degree - 1
    B = np.zeros((len(s), nc))
    for j in range(nc):
        c = np.zeros(nc); c[j] = 1
        B[:, j] = BSpline(t, c, degree, extrapolate=True)(np.clip(s, knots_s[0], knots_s[-1]))
    return B


def arc_length(v, f, seeds, step=0.003):
    """Arc length along a bar-shaped mesh from the seed vertices: geodesic distance binned into a centreline, then
    each vertex projected onto the centreline (one value per cross-section). Returns (s, centreline, centreline_s)."""
    g = dijkstra(graph(v, f), indices=np.asarray(seeds), min_only=True)
    g[~np.isfinite(g)] = np.nanmax(g[np.isfinite(g)])
    bins = np.arange(0, g.max() + step, step)
    cl = np.array([v[(g >= a) & (g < a + 2 * step)].mean(0) for a in bins if ((g >= a) & (g < a + 2 * step)).sum() > 3])
    if len(cl) >= 5:
        k = np.ones(5) / 5
        cl = np.stack([np.convolve(np.pad(cl[:, a], 2, mode='edge'), k, mode='valid') for a in range(3)], 1)
    cs = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(cl, axis=0), axis=1))])
    a, b = cl[:-1], cl[1:]
    ab = b - a; L2 = np.maximum((ab ** 2).sum(1), 1e-12)
    best = np.full(len(v), np.inf); out = np.zeros(len(v))
    for i in range(len(a)):
        t = np.clip(((v - a[i]) @ ab[i]) / L2[i], 0, 1)
        q = a[i] + t[:, None] * ab[i]
        d = ((v - q) ** 2).sum(1)
        m = d < best; best[m] = d[m]; out[m] = cs[i] + t[m] * np.sqrt(L2[i])
    return out, cl, cs


def rib_basis(s, length, s_fix, spacing=0.02):
    """Cubic B-spline basis over arc length that is exactly zero (value, slope, curvature) up to s_fix."""
    knots = np.linspace(s_fix, max(length, s_fix + 2 * spacing), max(3, int(np.ceil((length - s_fix) / spacing)) + 1))
    B = bspline_basis(s, knots)[:, 3:]
    B[s <= s_fix] = 0
    return B


def bar_basis(s, length, spacing=0.012, end=0.005, s0=0.0, s1=None):
    """B-spline basis over arc length, windowed to vanish over both joints of the bar: up to s0 (the end of the
    first joint patch) and from s1 (the start of the second) on."""
    s1 = length if s1 is None else s1
    knots = np.linspace(0, length, max(3, int(np.ceil(length / spacing)) + 1))
    w = smoothstep((s - s0) / end) * smoothstep((s1 - s) / end)
    return bspline_basis(s, knots) * w[:, None]


class Radial:
    """Outward direction of the chest wall at a point: horizontal, away from the thorax's centre line (the centre of
    the lungs' cross-section at that height). Used to push bone out of a lung where it lies deep inside, where the
    distance field's gradient no longer points the way out through the chest wall."""

    def __init__(self, lungs):
        v = lungs.mesh[0]
        self.ys = np.arange(v[:, 1].min(), v[:, 1].max() + 0.01, 0.01)
        c = []
        for y in self.ys:
            m = np.abs(v[:, 1] - y) < 0.01
            c.append(v[m].mean(0) if m.sum() > 50 else [np.nan] * 3)
        c = np.array(c)
        ok = np.isfinite(c[:, 0])
        self.cx = np.interp(self.ys, self.ys[ok], c[ok, 0]); self.cz = np.interp(self.ys, self.ys[ok], c[ok, 2])

    def __call__(self, p):
        cx = np.interp(p[:, 1], self.ys, self.cx); cz = np.interp(p[:, 1], self.ys, self.cz)
        d = np.stack([p[:, 0] - cx, np.zeros(len(p)), p[:, 2] - cz], 1)
        return d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)


def exit_along(tgt, p, d, clear, tmax=0.03, step=0.0003):
    """Distance along directions d to get from p to where tgt's distance reaches clear."""
    t = np.zeros(len(p)); live = np.ones(len(p), bool)
    for _ in range(int(tmax / step)):
        s = tgt.sdf(p[live] + t[live, None] * d[live])
        done = s >= clear
        idx = np.flatnonzero(live)
        live[idx[done]] = False
        t[idx[~done]] += np.maximum(step, (clear - s[~done]) * 0.5)
        if not live.any(): break
    return np.minimum(t, tmax)


def bend(v, Bf, obstacles, skin=None, skin_clear=SKIN_CLEAR, iters=5, sub=2, w_smooth=20.0, band=0.003, radial=None,
         mu=1000.0, min_capacity=0.25, skip=None, target=None):
    """Smallest smooth displacement v + Bf @ C (one vector per arc length, so whole cross-sections move together)
    that clears `obstacles` [(Target, clearance)] and keeps `skin_clear` inside the skin.
    Minimises |C|^2 + w_smooth |D2 C|^2 + mu * sum(hinge^2) (mm): the clearances are soft, so conflicting ones
    give a compromise instead of a failure. Each clearance is linearised along its push direction: the field
    gradient near the surface, the chest wall's outward direction (`radial`) for points deep inside a lung.
    Points the field cannot move (near the fixed end, basis capacity < min_capacity) are left out.
    target = (vertex idx, point, tol, weight) also pulls the centroid of those vertices (the rib's costochondral end)
    to within tol of the point (a soft term, weight per mm^2, below the clearances' mu): the end moves smoothly with
    the rest of the bendable shaft."""
    nf = Bf.shape[1]
    D = np.diff(np.eye(nf), 2, axis=0) if nf > 2 else np.zeros((0, nf))
    H = np.eye(3 * nf) + w_smooth * np.kron(np.eye(3), D.T @ D)
    idx_all = np.arange(len(v))[::sub]
    cap = np.abs(Bf[idx_all]).sum(1)
    idx_all = idx_all[cap >= min_capacity]
    c = np.zeros(3 * nf)
    info = dict(violated_before_mm=0.0)
    if not len(idx_all): return v.copy(), dict(info, max_mm=0.0)
    At = bt = None
    if target is not None:
        t_idx, t_pt, tol, w_t = target
        At = np.kron(np.eye(3), Bf[t_idx].mean(0)[None])          # end-centroid displacement (mm) per coefficient
        d0 = np.asarray(t_pt) - v[t_idx].mean(0); L0 = float(np.linalg.norm(d0))
        bt = d0 * max(0.0, 1 - tol / max(L0, 1e-9)) * 1000
        info['target_before_mm'] = round(L0 * 1000, 2)
        if not bt.any(): At = None
    for it in range(iters):
        cur = v + Bf @ (c.reshape(3, nf).T / 1000)
        P = cur[idx_all]
        A, b = [], []
        worst = 0.0
        for k_, (tgt, clear) in enumerate(obstacles):
            d = tgt.sdf(P)
            m = d < clear + band
            if skip is not None and tgt.name == 'lungs': m &= ~skip[idx_all]
            if not m.any(): continue
            g = tgt.field.grad(P[m]); need = clear - d[m]
            if radial is not None and tgt.name == 'lungs':
                deep = d[m] < -0.002
                if deep.any():
                    # deep inside, the field gradient is unreliable: leave toward the nearest lung surface point,
                    # unless that is through the lung's inner side, then straight out through the chest wall
                    Pd = P[m][deep]
                    best_d = np.full(len(Pd), np.inf); best_q = np.zeros_like(Pd)
                    for part in tgt.parts:
                        q, dd = part.closest(Pd)
                        mm_ = dd < best_d; best_d[mm_] = dd[mm_]; best_q[mm_] = q[mm_]
                    e = (best_q - Pd) / np.maximum(best_d[:, None], 1e-9)
                    r = radial(Pd)
                    inward = np.einsum('ij,ij->i', e, r) < -0.3
                    gd = np.where(inward[:, None], r, e)
                    nd = np.where(inward, exit_along(tgt, Pd, r, clear), best_d + clear)
                    g[deep] = gd; need[deep] = nd
            Bi = Bf[idx_all[m]]
            A.append(np.hstack([Bi * g[:, k:k + 1] for k in range(3)])); b.append(need * 1000)
            worst = max(worst, float(need.max()))
        if skin is not None:
            d = skin.sdf(P)
            m = d > -skin_clear - band
            if m.any():
                g = -skin.field.grad(P[m]); Bi = Bf[idx_all[m]]
                A.append(np.hstack([Bi * g[:, k:k + 1] for k in range(3)])); b.append((d[m] + skin_clear) * 1000)
                worst = max(worst, float((d[m] + skin_clear).max()))
        if it == 0: info['violated_before_mm'] = round(worst * 1000, 2)
        if (not A or worst <= 0.00002) and (At is None or it > 0): break
        A = np.concatenate(A) if A else np.zeros((0, 3 * nf))
        b = (np.concatenate(b) + A @ c) if len(A) else np.zeros(0)          # constraints on the total: A c >= b
        H0, r0 = (H, np.zeros(3 * nf)) if At is None else (H + w_t * At.T @ At, w_t * At.T @ bt)
        # squared-hinge QP by active sets
        act = (A @ c) < b
        for _ in range(30):
            Aa, ba = A[act], b[act]
            c_new = np.linalg.solve(H0 + mu * Aa.T @ Aa, r0 + mu * Aa.T @ ba)
            act_new = (A @ c_new) < b
            c = c_new
            if np.array_equal(act_new, act): break
            act = act_new
    disp = Bf @ (c.reshape(3, nf).T / 1000)
    info['max_mm'] = float(np.linalg.norm(disp, axis=1).max() * 1000)
    if target is not None:
        info['target_after_mm'] = round(float(np.linalg.norm(np.asarray(target[1]) - (v + disp)[target[0]].mean(0))) * 1000, 2)
    return v + disp, info


def joint_segment_end(rg):
    """Arc length where the rib's joint segment ends: 10 mm past the tubercle (ribs 1-10), 30 mm past the head
    (11, 12). Up to there the rib is held by its costovertebral and costotransverse joints."""
    return (rg.s_tub + 0.010) if rg.s_tub is not None else rg.s_head + 0.030


PARAVERTEBRAL = 0.020    # rib surface this close to its own or the neighbouring vertebrae is the paravertebral segment


def conflict_zone(v, side, n, overlap, verts, rg=None, reach=PARAVERTEBRAL):
    """The paravertebral segment of a rib: its surface within 20 mm of T(n-1), T(n) or T(n+1) - the head, neck,
    tubercle and the start of the shaft, which run along the spine held by the costovertebral and costotransverse
    joints. The HRA lungs fill this space (they reach the transverse processes, on the right even overlap the
    vertebral bodies by up to 6-8 mm), so a rib on its joints cannot be outside them there; pushing the segment out
    takes 2-6 cm bends of the shaft. It is excused from the lung push-out and reported separately; the rest of every
    rib must clear the lungs. `overlap` and `rg` are kept for the callers' signature."""
    z = np.zeros(len(v), bool)
    for k in (f'T{n - 1}', f'T{n}', f'T{n + 1}'):
        if k in verts:
            z |= verts[k].sdf(v) < reach
    return z


# ------------------------------------------------------------------------------------------------ body-scale ribs
def _kabsch(a, b, w=None):
    """Rotation taking centred point set a onto centred point set b (rows)."""
    w = np.ones(len(a)) if w is None else w
    H = (a * w[:, None]).T @ b
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    return Vt.T @ np.diag([1, 1, d]) @ U.T


def _transport(C, n0):
    """Rotation-minimising frames along a polyline C: rows t, n, b per sample (shape (N, 3, 3))."""
    t = np.gradient(C, axis=0); t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-12)
    F = np.zeros((len(C), 3, 3)); n = n0 - (n0 @ t[0]) * t[0]; n /= np.linalg.norm(n)
    for i in range(len(C)):
        if i:
            ax = np.cross(t[i - 1], t[i]); sa = np.linalg.norm(ax); ca = float(t[i - 1] @ t[i])
            if sa > 1e-12:
                k = ax / sa; ang = np.arctan2(sa, ca)
                n = n * np.cos(ang) + np.cross(k, n) * np.sin(ang) + k * (k @ n) * (1 - np.cos(ang))
            n = n - (n @ t[i]) * t[i]; n /= np.linalg.norm(n)
        F[i] = [t[i], n, np.cross(t[i], n)]
    return F


def _slab_centres(v, s, cs, half=0.003, win=5):
    C = np.full((len(cs), 3), np.nan)
    for i, a in enumerate(cs):
        m = np.abs(s - a) < half
        if m.sum() >= 4: C[i] = v[m].mean(0)
    ok = np.isfinite(C[:, 0])
    for k in range(3): C[:, k] = np.interp(cs, cs[ok], C[ok, k])
    return np.stack([_smooth(C[:, k], win) for k in range(3)], 1)


def _smooth(x, w):
    kern = np.ones(w) / w; p = w // 2
    return np.convolve(np.pad(x, p, mode='edge'), kern, mode='valid')


def sweep(rg, v_za, v_w, scale, win=11, twist="fit", max_stretch=0.10, stretch=None, prepared=False):
    """The Z-Anatomy rib at body scale along the trunk-warped rib's course.

    The trunk warp follows the HRA lungs, so it gives each rib a plausible course around the chest, but it stretches
    or compresses ribs along their length (0.7-1.5x, differently on the two sides) and flattens their cross-sections.
    Here every cross-section of the Z-Anatomy rib, scaled by the body scale, is placed at its own arc length
    (s * scale) along the warped rib's centreline, turned like the warped cross-section there (rotation-minimising
    frames plus a smoothed twist read off the warped slabs). The rib keeps Z-Anatomy's length, cross-sections and
    head/neck/tubercle shape at body scale; where it is longer than the warped course, its remaining part continues
    rigidly with its own curvature. The length itself may follow the warped course by up to max_stretch (10%): the
    warp's courses are asymmetric (e.g. 0.72x on one side, 1.0x on the other at the same level), and a rib at exactly
    body length would carry its anterior end 2-3 cm away from where the warp puts the costochondral junction.
    With stretch given, the rib's length is body length * stretch instead (see ribcage.fit_ribs: the true ribs close
    the spine-rib-cartilage-sternum chain). prepared=True returns (place(stretch) -> (vertices, info), default stretch) instead.
    Returns (vertices, info)."""
    s = rg.s; cs = rg.cl_s
    Cz = _slab_centres(v_za, s, cs, win=win); Cw = _slab_centres(v_w, s, cs, win=win)
    post = s < ((rg.s_tub + 0.01) if rg.s_tub is not None else rg.s_head + 0.03)
    R0 = _kabsch(v_za[post] - v_za[post].mean(0), v_w[post] - v_w[post].mean(0))
    tz = np.gradient(Cz, axis=0)[0]; n0 = np.cross(tz, [0.0, 1.0, 0.0]) if abs(tz[1]) < 0.9 else np.cross(tz, [1.0, 0, 0])
    Fz = _transport(Cz, n0 / np.linalg.norm(n0))
    Fw = _transport(Cw, R0 @ Fz[0][1])
    # twist: the angle about the tangent that best turns each Z-Anatomy slab onto the warped slab
    th = np.zeros(len(cs)); wt = np.zeros(len(cs))
    for i, a in enumerate(cs):
        m = np.abs(s - a) < 0.003
        if m.sum() < 6: continue
        oz = (v_za[m] - Cz[i]) @ Fz[i][1:].T; ow = (v_w[m] - Cw[i]) @ Fw[i][1:].T
        sxy = np.sum(oz[:, 0] * ow[:, 1] - oz[:, 1] * ow[:, 0]); sxx = np.sum(oz[:, 0] * ow[:, 0] + oz[:, 1] * ow[:, 1])
        th[i] = np.arctan2(sxy, sxx)
        ev = np.linalg.eigvalsh(np.cov(oz.T)); wt[i] = 1 - ev[0] / max(ev[1], 1e-12)     # flat slabs give a reliable angle
    if twist == 'none' or wt.sum() == 0:
        th = np.zeros(len(cs))
    else:
        # a smooth twist: robust quadratic fit over arc length to the slab angles (wrapped near the fit)
        x = cs / max(cs[-1], 1e-9); coef = np.zeros(3)
        for _ in range(6):
            pred = np.polyval(coef, x)
            r = np.angle(np.exp(1j * (th - pred)))
            w = wt * (np.abs(r) < np.radians(40))
            if w.sum() < 3: break
            coef = np.polyfit(x, pred + r, 2, w=np.sqrt(w))
        th = np.polyval(coef, x)
    for i in range(len(cs)):
        c, sn = np.cos(th[i]), np.sin(th[i]); t, n, b = Fw[i]
        Fw[i] = [t, c * n + sn * b, -sn * n + c * b]
    uw = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(Cw, axis=0), axis=1))])

    def at(F, C, u, x):
        """Position and frame at arc length x along a sampled curve (linear, extrapolated past the ends)."""
        j = np.clip(np.searchsorted(u, x) - 1, 0, len(u) - 2)
        f = ((x - u[j]) / np.maximum(u[j + 1] - u[j], 1e-9))[:, None]
        P = C[j] + f * (C[j + 1] - C[j])
        T = F[j, 0] + f * (F[j + 1, 0] - F[j, 0]); T /= np.linalg.norm(T, axis=1, keepdims=True)
        N = F[j, 1] + f * (F[j + 1, 1] - F[j, 1]); N -= np.einsum('ij,ij->i', N, T)[:, None] * T; N /= np.linalg.norm(N, axis=1, keepdims=True)
        return P, np.stack([T, N, np.cross(T, N)], 1)

    Pz, Gz = at(Fz, Cz, cs, s)                          # Z-Anatomy slab centre and frame of every vertex
    loc = np.einsum('ikj,ij->ik', Gz, v_za - Pz) * scale      # vertex offsets in its slab frame, at body scale
    default = float(np.clip(uw[-1] / (rg.length * scale), 1 - max_stretch, 1 + max_stretch))
    if prepared:
        return (lambda st: _place(st, s, scale, rg, uw, Fw, Cw, Fz, Cz, cs, v_za, loc, at, th)), default
    return _place(default if stretch is None else stretch, s, scale, rg, uw, Fw, Cw, Fz, Cz, cs, v_za, loc, at, th)


def _place(stretch, s, scale, rg, uw, Fw, Cw, Fz, Cz, cs, v_za, loc, at, th):
    u = s * scale * stretch
    out = np.zeros_like(v_za)
    inside = u <= uw[-1]
    P, G = at(Fw, Cw, uw, u[inside])
    out[inside] = P + np.einsum('ikj,ik->ij', G, loc[inside])
    sig = uw[-1] / (scale * stretch)
    if (~inside).any():
        # beyond the warped course: the rest of the rib continues rigidly, turned like the last 8 cm of the rib that
        # lies on the course (a curved stretch fixes the rotation far better than one frame at the tip), blended in
        # over the last 3 cm so the rib stays smooth
        seg = inside & (s > sig - 0.08)
        a = scale * v_za[seg]; b = out[seg]
        R_att = _kabsch(a - a.mean(0), b - b.mean(0)); t_att = b.mean(0) - a.mean(0) @ R_att.T
        rigid_p = (scale * v_za) @ R_att.T + t_att
        # the continuation keeps the stretch along the rib: shift each vertex along the rib's end direction
        if stretch != 1.0:
            d_end = R_att @ (Fz[-1][0]); extra = (s - sig) * scale * (stretch - 1)
            rigid_p = rigid_p + np.maximum(extra, 0)[:, None] * d_end[None]
        wgt = smoothstep((s - (sig - 0.03)) / 0.03)
        out = np.where(inside[:, None], out * (1 - wgt[:, None]) + rigid_p * wgt[:, None], rigid_p)
    info = dict(warped_course_mm=round(float(uw[-1]) * 1000, 1), body_length_mm=round(float(rg.length * scale) * 1000, 1), stretch=round(stretch, 3),
                warp_length_ratio=round(float(uw[-1] / (rg.length * scale)), 3), twist_range_deg=round(float(np.degrees(np.ptp(th))), 1))
    return out, info
