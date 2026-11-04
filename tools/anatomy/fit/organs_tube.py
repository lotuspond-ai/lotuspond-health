"""Organs fit, part 10: the oesophagus as a smooth swept tube.

Deforming the Z-Anatomy oesophagus mesh along a new route (carrying or re-framing its vertices) folds its wall where
the route bends (about 7x the sharp folds of the Z-Anatomy mesh); here the tube is swept instead:

  * route: the warped Z-Anatomy centreline, its top moved behind the cricoid lamina (TOP_ABOVE_CRICOID above the HRA
    cricoid's lower border), its distal 9 cm bent smoothly into the centre of the stomach's cardiac ring, the last
    3 cm blended into the ring's axis so that the tube arrives straight along it;
  * cross-sections: Z-Anatomy's own oesophagus (undistorted, brought to the body's scale by the similarity that best
    maps it onto the warped one) measured along its length, outer wall and lumen, semi-axes front-to-back and side to
    side (in a frame whose normal faces forward), smoothed along the length; the distal 12 mm blend into the cardiac
    ring (a circle of the end's mean radius), so the outer wall ends exactly on the stomach's rim;
  * collisions (trachea and its cartilages, main bronchi, left atrium and heart, aorta, vertebrae, cricoid and
    thyroid cartilages, liver, our thyroid gland and stomach; not the diaphragm: its hiatus gives way to the tube in
    the final settle, organs_final): per-station pushes of the route perpendicular
    to the tube, smoothed along it (a snake's internal energy keeps the route smooth); where a station is pressed
    from in front and from behind at once (trachea or left atrium against aorta or spine) the cross-section flattens
    front-to-back (down to FLAT_MIN of its depth, changing gradually along the tube) instead of being shoved;
  * mesh: rings of M vertices on the outer wall and on the lumen, joined by annular end faces into one closed,
    double-walled surface (a torus, like Z-Anatomy's); a final settle (organs_settle) clears what is left, the lumen
    wall giving way where the outer wall is pressed in (wall thickness kept), both ends held.
"""
import numpy as np
from scipy import ndimage

from lib.mesh import orient_outward
from lib.register import umeyama
from fit.organs_data import hra, field, log, za_original, has_hra
from fit.organs_geom import centreline, smoothstep, resample_polyline, Tube, vertex_normals

M = 48                 # vertices per ring
STEP = 0.0015          # station spacing (m)
FLAT_MIN = 0.6
CLEAR = 0.0006
TOP_ABOVE_CRICOID = 0.004
END_BLEND = 0.012
NBINS = 60
ESO_NB = ('trachea', 'trach_cart', 'bronchi', 'la', 'heart', 'aorta', 'spine', 'cricoid', 'thyroid_cart', 'liver')


def frames(C, t_end=None, k_end=6):
    """Unit tangent T, normal N facing forward (+z projected), binormal B along the polyline C. t_end: the exact
    tangent at the last station (blended in over the last k_end stations)."""
    T = ndimage.gaussian_filter1d(np.gradient(C, axis=0), 2.0, axis=0, mode='nearest')
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    if t_end is not None:
        w = smoothstep((np.arange(len(C)) - (len(C) - 1 - k_end)) / k_end)[:, None]
        T = T * (1 - w) + w * t_end; T /= np.linalg.norm(T, axis=1, keepdims=True)
    z = np.array([0.0, 0.0, 1.0])
    N = z - (T @ z)[:, None] * T; N /= np.linalg.norm(N, axis=1, keepdims=True)
    return T, N, np.cross(T, N)


def profile(W):
    """Z-Anatomy's own cross-section sizes along the oesophagus at body scale: dict(u (0 top .. 1 bottom), outer (n, 2)
    and lumen (n, 2) semi-axes along N (front-to-back) and B (side to side), scale)."""
    zv, zf = za_original('esophagus')
    S = umeyama(zv, W['esophagus'][0], scale=True)
    v = S(zv)
    top = v[v[:, 1] > v[:, 1].max() - 0.004].mean(0); bot = v[v[:, 1] < v[:, 1].min() + 0.004].mean(0)
    C = centreline(v, top, bot, n=150, iters=4)
    tube = Tube(v, C)
    T, N, B = frames(C)
    i0 = np.clip(np.round(np.interp(tube.vs, tube.s, np.arange(len(C)))).astype(int), 0, len(C) - 1)
    r = v - tube.point_at(tube.vs)
    a = np.abs(np.einsum('ij,ij->i', r, N[i0])); b = np.abs(np.einsum('ij,ij->i', r, B[i0]))
    outer = np.einsum('ij,ij->i', vertex_normals(v, zf), r) > 0
    u = tube.vs / tube.s[-1]
    edges = np.linspace(0, 1, NBINS + 1)
    P = np.full((NBINS, 4), np.nan)
    for k in range(NBINS):
        m = (u >= edges[k]) & (u <= edges[k + 1])
        for j, sel in enumerate((outer, ~outer)):
            mm = m & sel
            if mm.sum() >= 8: P[k, 2 * j] = np.percentile(a[mm], 90); P[k, 2 * j + 1] = np.percentile(b[mm], 90)
    uc = 0.5 * (edges[1:] + edges[:-1])
    for j in range(4):
        ok = np.isfinite(P[:, j]); P[:, j] = np.interp(uc, uc[ok], P[ok, j])
    P = ndimage.gaussian_filter1d(P, 1.5, axis=0, mode='nearest')
    outer_ax, lumen_ax = P[:, :2], np.minimum(P[:, 2:], P[:, :2] - 0.0008)
    return dict(u=uc, outer=outer_ax, lumen=np.maximum(lumen_ax, 0.0008), scale=round(float(S.s), 4), length=float(tube.s[-1]))


def end_radius(prof):
    """Radius of the cardiac ring: the mean outer semi-axis of the distal 7 % of the tube."""
    m = prof['u'] > 0.93
    return float(np.clip(prof['outer'][m].mean(), 0.0055, 0.011))


def ring_axes(prof, s, Ls, r_end, scl):
    """Per-station semi-axes (outer N, outer B, lumen N, lumen B) at arc lengths s of a route of length Ls."""
    u = s / Ls
    o = np.column_stack([np.interp(u, prof['u'], prof['outer'][:, j]) for j in range(2)])
    lu = np.column_stack([np.interp(u, prof['u'], prof['lumen'][:, j]) for j in range(2)])
    wall = o - lu
    k = smoothstep((s - (Ls - END_BLEND)) / END_BLEND)[:, None]
    o = o * (1 - k) + k * r_end
    sc = scl * (1 - k[:, 0]) + k[:, 0]
    o[:, 0] *= sc
    lu = np.maximum(o - wall, 0.0006)
    return o, lu


def rings(C, T, N, B, ax):
    th = 2 * np.pi * np.arange(M) / M
    return (C[:, None, :] + ax[:, 0, None, None] * np.cos(th)[None, :, None] * N[:, None, :]
            + ax[:, 1, None, None] * np.sin(th)[None, :, None] * B[:, None, :])


def tube_mesh(Ro, Ri):
    """Closed double-walled tube from outer and lumen rings (n, M, 3): (v, f), outer ids, lumen ids (paired)."""
    n = Ro.shape[0]
    v = np.concatenate([Ro.reshape(-1, 3), Ri.reshape(-1, 3)])
    i = np.arange(n - 1)[:, None]; k = np.arange(M)[None, :]
    def quads(off, flip):
        a = off + i * M + k; b = off + i * M + (k + 1) % M; c = off + (i + 1) * M + (k + 1) % M; d = off + (i + 1) * M + k
        t1 = np.stack([a, b, c], -1).reshape(-1, 3); t2 = np.stack([a, c, d], -1).reshape(-1, 3)
        F = np.concatenate([t1, t2]); return F[:, ::-1] if flip else F
    ko = np.arange(M); k1 = (ko + 1) % M; L = n * M
    caps = []
    for st, flip in ((0, True), (n - 1, False)):
        o0, o1 = st * M + ko, st * M + k1; l0, l1 = L + st * M + ko, L + st * M + k1
        F = np.concatenate([np.stack([o0, o1, l1], -1), np.stack([o0, l1, l0], -1)])
        caps.append(F[:, ::-1] if flip else F)
    f = np.concatenate([quads(0, False), quads(L, True)] + caps)
    f = orient_outward(v, f)
    return (v, f), np.arange(L), L + np.arange(L)


def ring_circle(P):
    """Centre, unit normal and radius of the circle through a ring of points (least-squares circle in the ring's
    plane): the vertex centroid of an unevenly sampled rim lies off its centre."""
    c0 = P.mean(0)
    U = np.linalg.svd(P - c0)[2]
    a, b, n = U[0], U[1], U[2]
    x, y = (P - c0) @ a, (P - c0) @ b
    A = np.column_stack([x, y, np.ones(len(P))])
    sol = np.linalg.lstsq(A, x ** 2 + y ** 2, rcond=None)[0]
    cx, cy = sol[0] / 2, sol[1] / 2
    r = float(np.sqrt(max(sol[2] + cx ** 2 + cy ** 2, 1e-12)))
    return c0 + cx * a + cy * b, n / np.linalg.norm(n), r


def fit_esophagus_sweep(sex, W, stomach, car, own=(), iters=45, prof=None):
    """stomach: fitted (v, f); car: its cardia loop ids. own: [(name, Field)] (thyroid, diaphragm, stomach).
    Returns (v, f), report (with 'centreline')."""
    rep = {}
    prof = prof or profile(W)
    v0 = W['esophagus'][0]
    top = v0[v0[:, 1] > v0[:, 1].max() - 0.004].mean(0)
    bot = v0[v0[:, 1] < v0[:, 1].min() + 0.004].mean(0)
    C0 = centreline(v0, top, bot, n=150, iters=4)
    sv, sf = stomach
    cc, cn, r_end = ring_circle(sv[car])
    if cn @ (C0[-20] - cc) < 0: cn = -cn                        # up the oesophagus
    rep['cardiac_ring'] = dict(centre=np.round(cc, 4).tolist(), axis=np.round(cn, 3).tolist(), radius_mm=round(r_end * 1000, 2))
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(C0, axis=0), axis=1))]); Ls = s[-1]
    # top behind the cricoid lamina
    cv = hra(sex, 'cricoid')[0]
    y_t = cv[:, 1].min() + TOP_ABOVE_CRICOID
    lam = cv[np.abs(cv[:, 1] - y_t) < 0.003]
    rz = float(prof['outer'][0, 0])
    p_top = np.array([lam[:, 0].mean(), y_t, lam[:, 2].min() - rz - 0.001])
    rep['top_target'] = np.round(p_top, 4).tolist()
    C0 = C0 + smoothstep((0.06 - s) / 0.06)[:, None] * (p_top - C0[0])
    # distal 9 cm bent into the cardiac ring's centre, the last 3 cm blended into its axis
    C = C0 + smoothstep((s - (Ls - 0.09)) / 0.09)[:, None] * (cc - C0[-1])
    tb = smoothstep((s - (Ls - 0.03)) / 0.03)[:, None]
    C = C * (1 - tb) + tb * (cc + (Ls - s)[:, None] * cn)
    rep['end_shift_mm'] = round(float(np.linalg.norm(cc - C0[-1]) * 1000), 1)
    n = int(round(Ls / STEP)) + 1
    C, s = resample_polyline(C, n); Ls = s[-1]
    rep['length_mm'] = round(float(Ls * 1000), 1)
    fields = [(k, field(sex, k)) for k in ESO_NB if has_hra(sex, k)] + list(own)
    free = (s > 0.006) & (s < Ls - 0.006)
    scl = np.ones(n)
    worst = {}
    for it in range(iters):
        T, N, B = frames(C, -cn)
        o, lu = ring_axes(prof, s, Ls, r_end, scl)
        R = rings(C, T, N, B, o)                               # (n, M, 3)
        V = R.reshape(-1, 3); st = np.repeat(np.arange(n), M)
        push = np.zeros((len(V), 3)); worst = {}
        for name, fl in fields:
            sc = fl.coarse(V); cand = np.flatnonzero(sc < CLEAR + 0.004)
            if name == 'stomach': cand = cand[s[st[cand]] < Ls - 0.02]
            if not len(cand): continue
            sd = fl(V[cand]); m = sd < CLEAR
            if not m.any(): continue
            ii = cand[m]; on, _ = fl.outward(V[ii])
            push[ii] += (CLEAR - sd[m])[:, None] * on
            worst[name] = round(float(-sd[m].min() * 1000), 2)
        if not worst: break
        L_ = np.linalg.norm(push, axis=1); hit = L_ > 0
        P = np.zeros((n, 3)); cnt = np.zeros(n); mx = np.zeros(n)
        np.add.at(P, st[hit], push[hit]); np.add.at(cnt, st[hit], 1); np.maximum.at(mx, st[hit], L_[hit])
        P = P / np.maximum(cnt, 1)[:, None]
        Pl = np.linalg.norm(P, axis=1)
        P = P * np.where(Pl > 0, np.minimum(mx / np.maximum(Pl, 1e-9), 3.0), 0)[:, None]
        P = P - np.einsum('ij,ij->i', P, T)[:, None] * T
        P = ndimage.gaussian_filter1d(P, 2.0, axis=0, mode='nearest') * 0.8
        P[~free] = 0
        # pressed from in front and behind at once: flatten front-to-back, gradually along the tube
        a = np.einsum('ij,ij->i', push[hit], N[st[hit]])
        fwd = np.zeros(n); bwd = np.zeros(n)
        np.maximum.at(fwd, st[hit], np.maximum(a, 0)); np.maximum.at(bwd, st[hit], np.maximum(-a, 0))
        red = ndimage.gaussian_filter1d(np.where(np.minimum(fwd, bwd) > 0, (fwd + bwd) / (2 * np.maximum(o[:, 0], 1e-3)), 0), 1.5, mode='nearest')
        scl = np.maximum(FLAT_MIN, ndimage.gaussian_filter1d(np.maximum(FLAT_MIN, scl - 0.5 * red), 3.0, mode='nearest'))
        C = C + P
        Cs = ndimage.gaussian_filter1d(C, 1.5, axis=0, mode='nearest')
        C = np.where(free[:, None], Cs, C)
        if it % 5 == 0: log(f'    oesophagus sweep iter {it}: worst {worst}')
    rep['route_worst_mm'] = worst
    rep['flattening_min'] = round(float(scl.min()), 2)
    T, N, B = frames(C, -cn)
    o, lu = ring_axes(prof, s, Ls, r_end, scl)
    Ro, Ri = rings(C, T, N, B, o), rings(C, T, N, B, lu)
    (vv, f), Po, Qi = tube_mesh(Ro, Ri)
    rep['cross_section_mm'] = dict(outer_front_back=[round(float(o[:, 0].min() * 1000), 1), round(float(o[:, 0].max() * 1000), 1)],
                                   outer_side=[round(float(o[:, 1].min() * 1000), 1), round(float(o[:, 1].max() * 1000), 1)],
                                   wall_min=round(float((o - lu).min() * 1000), 2), scale=prof['scale'])
    # final settle: the lumen wall gives way where the outer wall is pressed in; both ends held
    from fit.organs_settle import settle
    stv = np.concatenate([np.repeat(s, M), np.repeat(s, M)])
    hold = np.flatnonzero((stv < 0.004) | (stv > Ls - 0.006))
    sfl = [(name, fl, None, stv < Ls - 0.02) if name == 'stomach' else (name, fl, None) for name, fl in fields]
    axq = vv[Po] - vv[Qi]; thq = np.linalg.norm(axq, axis=1); axq /= np.maximum(thq, 1e-12)[:, None]
    vv, rep['settle'] = settle(vv, f, sfl, clear=0.0004, iters=5, fixed=hold, pairs=(Po, Qi, axq), min_thick=0.8 * thq,
                               pair_split=0.0, inward=False, log=log, label='oesophagus settle')
    rep['centreline'] = C
    return (vv, orient_outward(vv, f)), rep
