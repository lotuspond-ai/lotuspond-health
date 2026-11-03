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


def seat(rg, v, verts, lung):
    """Rigid motion of the posterior segment that seats the articular facets on the HRA vertebrae.
    v: the warped rib (HRA space); verts: {'T5': Target, ...}. Returns (new vertices, info).
    Ribs 2-9: the head's two facets on T(n-1) and T(n); ribs 1, 10, 11, 12: the head on T(n) alone, with its centre
    nearer T(n) than the vertebra above; ribs 1-10: the tubercle on the transverse process of T(n)."""
    n = rg.n
    own = verts[f'T{n}']; up = verts.get(f'T{n - 1}') or (verts.get('C7') if n == 1 else None)
    two = 2 <= n <= 9
    terms = []                                   # (indices, target, gap, weight)
    i, g = rg.facets['head_lo']; terms.append((i, own, g, 1.0))
    if two:
        i, g = rg.facets['head_up']; terms.append((i, up, g, 1.0))
    if 'tub' in rg.facets:
        i, g = rg.facets['tub']; terms.append((i, own, g, 1.0))
    head_idx = np.concatenate([rg.facets[k][0] for k in ('head_lo', 'head_up') if k in rg.facets])
    post = np.flatnonzero(rg.s <= rg.s_rigid + 0.01)
    post_s = post[::3]
    # lung clearance is asked of the neck and the part past the tubercle, not of the head: where the HRA lung
    # overlaps the vertebral body itself the head cannot leave it without leaving its joint
    s_free = (rg.s_tub + 0.004) if rg.s_tub is not None else rg.s_head + 0.025
    neck = np.flatnonzero((rg.s >= s_free) & (rg.s <= rg.s_rigid + 0.03))[::3]
    w_neck = 1 - smoothstep((rg.s[neck] - rg.s_rigid) / FADE)
    near = [verts[k] for k in (f'T{n - 1}', f'T{n}', f'T{n + 1}', 'C7' if n == 1 else 'L1' if n == 12 else None) if k in verts]
    c = v[head_idx].mean(0)
    # the rib's neck axis (head to tubercle; for 11 and 12 the first 2.5 cm of the rib): turning about it is the
    # rib's elevation, which the rest of the rib (already placed by the warp) decides, so it is held tightly
    if 'tub' in rg.facets:
        na = v[rg.facets['tub'][0]].mean(0) - c
    else:
        na = v[(rg.s > rg.s_head + 0.015) & (rg.s < rg.s_head + 0.03)].mean(0) - c
    na /= np.linalg.norm(na)

    def apply(x, p):
        R = Rotation.from_rotvec(x[:3]).as_matrix()
        return (p - c) @ R.T + c + x[3:]

    def resid(x):
        r = []
        for idx, tgt, gap, w in terms:
            d = tgt.sdf(apply(x, v[idx]))
            ww = w / (1 + gap / 0.0015)
            r.append(ww * (d - np.clip(gap, 0.0005, 0.002)) / 0.0005 / np.sqrt(len(idx)) * 4)
        if not two and up is not None:
            # level: the head centre sits on its own vertebra, at least 1.5 mm nearer it than the one above
            hc = apply(x, v[head_idx].mean(0)[None])
            r.append(np.maximum(own.sdf(hc) - up.sdf(hc) + 0.0015, 0) / 0.0005 * 2)
        P = apply(x, v[post_s])
        for tgt in near:
            r.append(np.maximum(0.0003 - tgt.sdf(P), 0) / 0.0002 / np.sqrt(len(P)) * 6)
        Pn = v[neck] + w_neck[:, None] * (apply(x, v[neck]) - v[neck])
        r.append(np.maximum(LUNG_CLEAR - lung.sdf(Pn), 0) / 0.0005 / np.sqrt(len(Pn)) * 2)
        wn = x[:3] @ na
        r.append(np.array([wn / np.radians(2.0)]))
        r.append((x[:3] - wn * na) / np.radians(5.0))
        r.append(x[3:] / 0.004)
        return np.concatenate(r)

    sol = optimize.least_squares(resid, np.zeros(6), method='trf', x_scale=np.array([0.02] * 3 + [0.002] * 3), max_nfev=400)
    x = sol.x
    w = 1 - smoothstep((rg.s - rg.s_rigid) / FADE)
    moved = apply(x, v)
    out = v + w[:, None] * (moved - v)
    info = dict(rot_deg=float(np.degrees(np.linalg.norm(x[:3]))), neck_rot_deg=float(np.degrees(x[:3] @ na)), shift_mm=float(np.linalg.norm(x[3:]) * 1000), cost=float(sol.cost))
    return out, info


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


def bar_basis(s, length, spacing=0.012, end=0.005):
    """B-spline basis over arc length, windowed to vanish at both ends of the bar (its two joints)."""
    knots = np.linspace(0, length, max(3, int(np.ceil(length / spacing)) + 1))
    w = smoothstep(s / end) * smoothstep((length - s) / end)
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
         mu=1000.0, min_capacity=0.25):
    """Smallest smooth displacement v + Bf @ C (one vector per arc length, so whole cross-sections move together)
    that clears `obstacles` [(Target, clearance)] and keeps `skin_clear` inside the skin.
    Minimises |C|^2 + w_smooth |D2 C|^2 + mu * sum(hinge^2) (mm): the clearances are soft, so conflicting ones
    give a compromise instead of a failure. Each clearance is linearised along its push direction: the field
    gradient near the surface, the chest wall's outward direction (`radial`) for points deep inside a lung.
    Points the field cannot move (near the fixed end, basis capacity < min_capacity) are left out."""
    nf = Bf.shape[1]
    D = np.diff(np.eye(nf), 2, axis=0) if nf > 2 else np.zeros((0, nf))
    H = np.eye(3 * nf) + w_smooth * np.kron(np.eye(3), D.T @ D)
    idx_all = np.arange(len(v))[::sub]
    cap = np.abs(Bf[idx_all]).sum(1)
    idx_all = idx_all[cap >= min_capacity]
    c = np.zeros(3 * nf)
    info = dict(violated_before_mm=0.0)
    if not len(idx_all): return v.copy(), dict(info, max_mm=0.0)
    for it in range(iters):
        cur = v + Bf @ (c.reshape(3, nf).T / 1000)
        P = cur[idx_all]
        A, b = [], []
        worst = 0.0
        for k_, (tgt, clear) in enumerate(obstacles):
            d = tgt.sdf(P)
            m = d < clear + band
            if not m.any(): continue
            g = tgt.field.grad(P[m]); need = clear - d[m]
            if radial is not None and tgt.name == 'lungs':
                deep = d[m] < -0.002
                if deep.any():
                    r = radial(P[m][deep])
                    g[deep] = r
                    need[deep] = exit_along(tgt, P[m][deep], r, clear)
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
        if not A or worst <= 0.00002: break
        A = np.concatenate(A); b = np.concatenate(b) + A @ c          # constraints on the total: A c >= b
        # squared-hinge QP by active sets
        act = (A @ c) < b
        for _ in range(30):
            Aa, ba = A[act], b[act]
            c_new = np.linalg.solve(H + mu * Aa.T @ Aa, mu * Aa.T @ ba)
            act_new = (A @ c_new) < b
            c = c_new
            if np.array_equal(act_new, act): break
            act = act_new
    disp = Bf @ (c.reshape(3, nf).T / 1000)
    info['max_mm'] = float(np.linalg.norm(disp, axis=1).max() * 1000)
    return v + disp, info
