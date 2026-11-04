"""Organs fit, part 6: stomach and oesophagus.

Stomach: deformed as-rigidly-as-possible from the undistorted Z-Anatomy stomach (scaled and placed by the similarity
that best matches the warped one), guided weakly by the warped positions, with
  * the pyloric orifice snapped onto the opening of the HRA duodenum's superior part (ring to ring, matched by angle
    about the common axis; the antrum follows smoothly),
  * collision push-out from the liver, gallbladder, spleen, pancreas, colon, left kidney, duodenum (away from the
    pyloric junction), jejunum, aorta and our diaphragm and left adrenal.
The cardiac orifice stays where the fit puts it (guided by the warp, which seats it under the oesophageal hiatus).

Oesophagus: a tube re-routed along a new centreline with its cross-sections unchanged (rotation-minimising frames):
the warped centreline, bent smoothly over its last 9 cm so that it ends at the centre of the stomach's cardiac orifice
along the orifice's axis, then moved out of its neighbours (trachea and its cartilages, main bronchi, left atrium and
heart, aorta, vertebrae, cricoid and thyroid cartilages, thyroid gland, liver, diaphragm, stomach) by smoothed
per-station pushes perpendicular to the tube. The last centimetre is then flared or narrowed with a smooth falloff
so that its wall meets the rim of the cardiac orifice (the gastro-oesophageal junction).
"""
import numpy as np
from scipy.spatial import cKDTree
from scipy import ndimage

from lib.mesh import orient_outward
from lib.register import umeyama
from fit.organs_data import hra, field, log, za_original
from fit.organs_geom import ARAP, boundary_loops, vertex_normals, Tube, centreline, smoothstep, push_out, laplacian, resample_polyline, refine_long_edges

CLEAR = 0.0006
TOP_ABOVE_CRICOID = 0.004
STOMACH_NB = ('liver', 'gallbladder', 'spleen', 'pancreas', 'colon', 'kidney_l', 'duodenum', 'jejunum', 'aorta')


def loop_axis(P):
    """Centre, unit normal (by PCA) and mean radius of a closed ring of points."""
    c = P.mean(0)
    n = np.linalg.svd(P - c)[2][2]
    return c, n / np.linalg.norm(n), float(np.linalg.norm(P - c, axis=1).mean())


def orifices(v, f, sex, eso_end):
    """(pylorus loop, cardia loop, other loops) of the open Z-Anatomy stomach: the cardia is the loop nearest the
    oesophagus's lower end, the pylorus the loop nearest the HRA duodenum; Z-Anatomy's stomach also has a 3 cm hole in
    its anterior wall, which is filled (see fill_holes)."""
    loops = [np.array(l) for l in boundary_loops(f) if len(l) >= 8]
    duo = hra(sex, 'duo_sup')[0].mean(0)
    ic = int(np.argmin([np.linalg.norm(v[l].mean(0) - eso_end) for l in loops]))
    rest = [l for i, l in enumerate(loops) if i != ic]
    ip = int(np.argmin([np.linalg.norm(v[l].mean(0) - duo) for l in rest]))
    return rest[ip], loops[ic], [l for i, l in enumerate(rest) if i != ip]


def fill_holes(v, rest, f, holes):
    """Fill the non-orifice holes in both the fitted-space and rest-shape copies (same topology)."""
    from fit.organs_geom import fill_hole
    for h in holes:
        n0 = len(v)
        v2, f2, new = fill_hole(v, f, h)
        r2, f3, _ = fill_hole(rest, f, h)
        v, rest, f = v2, r2, f2
    return v, rest, f


def duodenal_opening(sex, near):
    """Rim of the HRA duodenum superior part at its proximal end (the one nearest `near`): the outer wall loop."""
    v, f = hra(sex, 'duo_sup')
    loops = [np.array(l) for l in boundary_loops(f) if len(l) >= 8]
    cs = [v[l].mean(0) for l in loops]
    d = np.array([np.linalg.norm(c - near) for c in cs])
    close = [l for l, dd in zip(loops, d) if dd < d.min() + 0.006]          # outer and inner walls at that end
    rad = [loop_axis(v[l])[2] for l in close]
    ring = close[int(np.argmax(rad))]
    return v[ring]


def match_rings(P, Q, c, n):
    """For each point of ring P, the point of ring Q at the same angle about axis (c, n) (Q densified)."""
    a = np.cross(n, [1, 0, 0]); a = a if np.linalg.norm(a) > 0.1 else np.cross(n, [0, 1, 0]); a /= np.linalg.norm(a); b = np.cross(n, a)
    Qd = np.concatenate([np.linspace(Q[i], Q[(i + 1) % len(Q)], 10, endpoint=False) for i in range(len(Q))])
    angP = np.arctan2((P - c) @ b, (P - c) @ a); angQ = np.arctan2((Qd - c) @ b, (Qd - c) @ a)
    order = np.argsort(angQ)
    j = np.searchsorted(angQ[order], angP) % len(order)
    return Qd[order][j]


def fit_stomach(sex, W, own=(), outer=24):
    """own: [(name, Field)] of our fitted neighbours (diaphragm, left adrenal). Returns (v, f), report, loops."""
    rep = {}
    v0, f = W['stomach']
    zv = za_original('stomach')[0]
    S = umeyama(zv, v0, scale=True)
    rest = S(zv)
    ev = W['esophagus'][0]
    pyl, car, holes = orifices(v0, f, sex, ev[ev[:, 1] < ev[:, 1].min() + 0.004].mean(0))
    rep['holes_filled'] = [dict(rim_vertices=int(len(h)), radius_mm=round(loop_axis(v0[h])[2] * 1000, 1)) for h in holes]
    v0, rest, f = fill_holes(v0, rest, f, holes)
    # Z-Anatomy's stomach has coarse patches (edges up to 28 mm) that neighbours poke through between vertices:
    # split edges longer than 4 mm (midpoints, so the shape is unchanged; the orifice rims are not touched because
    # boundary edges are short)
    nb = len(v0)
    VV, f = refine_long_edges(np.hstack([rest, v0]), f, 0.004)
    rest, v0 = VV[:, :3], VV[:, 3:]
    rep['refined_vertices'] = dict(before=int(nb), after=int(len(v0)))
    ring = duodenal_opening(sex, v0[pyl].mean(0))
    cp, npy, rp = loop_axis(v0[pyl])
    cr, nr, rr = loop_axis(ring)
    tgt_p = match_rings(v0[pyl] - cp + cr, ring, cr, nr)          # the pyloric rim laid onto the duodenal rim
    rep['pylorus_shift_mm'] = round(float(np.linalg.norm(cr - cp) * 1000), 1)
    rep['pylorus_radius_mm'] = dict(stomach=round(rp * 1000, 1), duodenum=round(rr * 1000, 1))
    fields = [(k, field(sex, k)) for k in STOMACH_NB] + list(own)
    near_pyl = np.linalg.norm(v0 - cp, axis=1) < 0.012
    # filling: the stomach is a hollow organ whose size follows its contents. The HRA neighbours (segmented around the
    # Visible Human's own stomach) leave a bed smaller than Z-Anatomy's distended stomach: the rest shape is scaled
    # uniformly to the share of the warped stomach's volume that is free of neighbours (shape kept, size adapted).
    from fit.organs_geom import mesh_field as _mf
    sfl0 = _mf(v0, f, 0.002, cap=True)
    g = sfl0.lo + sfl0.h * np.argwhere(sfl0.sdf < 0)
    free = np.ones(len(g), bool)
    for name, fl in fields:
        if name == 'duodenum': continue
        free &= fl.coarse(g) > 0
    fill = float(free.mean())
    sc = float(np.clip(fill ** (1 / 3), 0.8, 1.0))
    c_rest = rest.mean(0); rest = c_rest + sc * (rest - c_rest)
    rep['bed_free_fraction'] = round(fill, 3); rep['rest_scale'] = round(sc, 3)
    arap = ARAP(rest, f)
    n = len(v0)
    # guidance: the warped positions, moved near the pylorus by the pyloric shift (smooth falloff over 6 cm)
    w_p = smoothstep((0.06 - np.linalg.norm(v0 - cp, axis=1)) / 0.05)
    cc0 = v0[car].mean(0)
    guide = cc0 + sc * (v0 - cc0)                  # the guidance deflates about the cardia too
    guide = guide + w_p[:, None] * (cr - guide[pyl].mean(0))
    v = guide.copy()
    active = {}                                    # vertex -> (field index): pushed once, kept on the surface
    for it in range(outer):
        idx, tgt, wts, worst = [np.arange(n), pyl, car], [guide, tgt_p, v[car]], [np.full(n, 0.01), np.full(len(pyl), 40.0), np.full(len(car), 2.0)], {}
        for j, (name, fl) in enumerate(fields):
            sc = fl.coarse(v); cand = np.flatnonzero(sc < CLEAR + 0.004)
            if name == 'duodenum': cand = cand[~near_pyl[cand]]
            if not len(cand): continue
            sd = fl(v[cand]); m = sd < CLEAR
            for i in cand[m]: active[int(i)] = j
            if m.any(): worst[name] = round(float(-sd[m].min() * 1000), 2)
        if active:
            ai = np.fromiter(active.keys(), np.int64); aj = np.fromiter(active.values(), np.int64)
            nrm = vertex_normals(v, f)
            for j in np.unique(aj):
                ii = ai[aj == j]; fl = fields[j][1]
                # the wall is indented: each vertex walks inwards along the stomach's own normal until it is clear of
                # the neighbour (a deep intruder's nearest exit can lie on its far side, which would drag the wall
                # through it); if no exit within 30 mm, the neighbour's normal is used
                t = np.zeros(len(ii)); done = fl(v[ii]) >= CLEAR
                for step in np.arange(0.0005, 0.0305, 0.0005):
                    if done.all(): break
                    ok = (~done) & (fl.coarse(v[ii] - step * nrm[ii]) >= CLEAR + 0.0002)
                    t[ok] = step; done |= ok
                tg = v[ii] - t[:, None] * nrm[ii]
                if (~done).any():
                    sd = fl(v[ii[~done]]); on, q = fl.outward(v[ii[~done]])
                    tg[~done] = v[ii[~done]] + np.maximum(CLEAR - sd, 0)[:, None] * on
                idx.append(ii); tgt.append(tg); wts.append(np.full(len(ii), 8.0))
        v = arap.solve(v, np.concatenate(idx), np.concatenate(tgt), np.concatenate(wts), iters=3)
        if it % 5 == 0 or it == outer - 1: log(f'    stomach iter {it}: active {len(active)}, worst {worst}')
    v[pyl] = tgt_p
    rep['arap_worst_mm'] = worst
    return (v, orient_outward(v, f)), rep, (pyl, car, ring)


# ------------------------------------------------------------------------------------------------ oesophagus
ESO_NB = ('trachea', 'trach_cart', 'bronchi', 'la', 'heart', 'aorta', 'spine', 'cricoid', 'thyroid_cart', 'liver')


def fit_esophagus(sex, W, stomach, car, own=(), iters=45):
    """stomach: fitted (v, f); car: cardia loop ids. own: [(name, Field)] (thyroid, diaphragm, stomach)."""
    rep = {}
    v0, f = W['esophagus']
    top = v0[v0[:, 1] > v0[:, 1].max() - 0.004].mean(0)
    bot = v0[v0[:, 1] < v0[:, 1].min() + 0.004].mean(0)
    C0 = centreline(v0, top, bot, n=120, iters=4)
    tube = Tube(v0, C0, n0=(0, 0, 1))
    sv, sf = stomach
    cc, cn, crad = loop_axis(sv[car])
    # the cardia axis points out of the stomach, up towards the hiatus
    if cn @ (C0[-10] - cc) < 0: cn = -cn
    # the upper end: Z-Anatomy's oesophagus starts 2 cm above its cricoid's lower border (pharynx level); it belongs
    # behind the cricoid lamina (C6). Its top centre goes TOP_ABOVE_CRICOID above the HRA cricoid's lower border,
    # behind the lamina, and the centreline follows with a smooth falloff over 6 cm.
    cv = hra(sex, 'cricoid')[0]
    y_t = cv[:, 1].min() + TOP_ABOVE_CRICOID
    lam = cv[np.abs(cv[:, 1] - y_t) < 0.003]
    rz = float(np.percentile(np.abs((v0 - C0[0])[np.abs(v0[:, 1] - C0[0, 1]) < 0.01][:, 2]), 95))
    p_top = np.array([lam[:, 0].mean(), y_t, lam[:, 2].min() - rz - 0.001])
    rep['top_target'] = np.round(p_top, 4).tolist()
    s = tube.s; Ls = s[-1]
    wt = smoothstep((0.06 - s) / 0.06)[:, None]
    C0 = C0 + wt * (p_top - C0[0])
    # bend the last 9 cm so the tube ends at the cardia centre, arriving along the cardia axis
    w = smoothstep((s - (Ls - 0.09)) / 0.09)[:, None]
    end_dir = -cn
    C = C0 + w * (cc - C0[-1])
    # end tangent: blend the last 2 cm towards the cardia axis
    t_end = smoothstep((s - (Ls - 0.02)) / 0.02)[:, None]
    C = C * (1 - t_end) + t_end * (cc - (Ls - s)[:, None] * end_dir)
    rep['end_shift_mm'] = round(float(np.linalg.norm(cc - C0[-1]) * 1000), 1)
    fields = [(k, field(sex, k)) for k in ESO_NB] + list(own)
    free = np.ones(len(C), bool)
    free[s < 0.006] = False                    # the top stays behind the cricoid
    free[s > Ls - 0.004] = False               # the end stays at the cardia
    for it in range(iters):
        vv = tube.rebuild(C)
        push = np.zeros((len(vv), 3)); worst = {}
        for name, fl in fields:
            sc = fl.coarse(vv); cand = np.flatnonzero(sc < CLEAR + 0.004)
            if name == 'stomach': cand = cand[tube.vs[cand] < Ls - 0.02]
            if name == 'diaphragm': pass
            if not len(cand): continue
            sd = fl(vv[cand]); m = sd < CLEAR
            if not m.any(): continue
            ii = cand[m]; on, q = fl.outward(vv[ii])
            push[ii] += (CLEAR - sd[m])[:, None] * on
            worst[name] = round(float(-sd[m].min() * 1000), 2)
        if not worst: break
        # per-station push: the largest push among the station's vertices, perpendicular to the tangent
        st = np.clip(np.searchsorted(s, tube.vs), 0, len(s) - 1)
        L = np.linalg.norm(push, axis=1); hitv = L > 0
        P = np.zeros((len(C), 3)); cnt = np.zeros(len(C))
        np.add.at(P, st[hitv], push[hitv]); np.add.at(cnt, st[hitv], 1)
        # mean push of the station's pushed vertices, scaled up towards the largest one
        mx = np.zeros(len(C)); np.maximum.at(mx, st[hitv], L[hitv])
        P = P / np.maximum(cnt, 1)[:, None]
        Pl = np.linalg.norm(P, axis=1)
        P = P * (np.where(Pl > 0, np.minimum(mx / np.maximum(Pl, 1e-9), 3.0), 0))[:, None]
        T = np.gradient(C, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
        P = P - np.einsum('ij,ij->i', P, T)[:, None] * T
        P = ndimage.gaussian_filter1d(P, 2.0, axis=0, mode='nearest') * 0.8
        P[~free] = 0
        C = C + P
        if it % 5 == 0: log(f'    oesophagus iter {it}: worst {worst}')
    rep['route_worst_mm'] = worst
    vv = tube.rebuild(C)
    # gastro-oesophageal junction: radial snap of the distal 12 mm onto the cardia rim, smooth falloff
    vv = snap_end(vv, tube, C, sv[car], cc, cn)
    # residual overlaps: smooth push-out, the junction fixed
    fix = np.flatnonzero(tube.vs > Ls - 0.003)
    vv = push_out(vv, f, [(fl, None) for name, fl in fields if name != 'stomach'], clearance=0.0004, iters=8, fixed=fix, fixed_val=vv[fix], log=None)
    rep['centreline'] = C
    return (vv, orient_outward(vv, f)), rep, tube


def snap_end(vv, tube, C, rim, cc, cn, length=0.012):
    """Scale each distal cross-section radially (per angle) so that the wall meets the cardia rim at the end."""
    s = tube.vs; Ls = tube.s[-1] * 1.0
    s2 = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(C, axis=0), axis=1))])
    u = s / tube.s[-1] * s2[-1]
    end = u > s2[-1] - length
    if not end.any(): return vv
    a = np.cross(cn, [1, 0, 0]); a /= np.linalg.norm(a); b = np.cross(cn, a)
    ang_r = np.arctan2((rim - cc) @ b, (rim - cc) @ a); rad_r = np.linalg.norm((rim - cc) - np.outer((rim - cc) @ cn, cn), axis=1)
    o = np.argsort(ang_r)
    ang_r, rad_r = ang_r[o], rad_r[o]
    out = vv.copy()
    ce = np.column_stack([np.interp(u[end], s2, C[:, k]) for k in range(3)])
    r = vv[end] - ce
    r_perp = r - np.outer(r @ cn, cn)
    rl = np.linalg.norm(r_perp, axis=1)
    ang = np.arctan2(r_perp @ b, r_perp @ a)
    want = np.interp(ang, ang_r, rad_r, period=2 * np.pi)
    # the tube is double-walled (lumen): both walls scale by the factor that brings the OUTER wall (the largest radius
    # in each 10-degree sector of the distal segment) onto the rim
    sec = np.floor((ang + np.pi) / (2 * np.pi) * 36).astype(int) % 36
    rout = np.zeros(36); np.maximum.at(rout, sec, rl)
    rout = np.where(rout > 0, rout, rl.max())
    k = smoothstep((u[end] - (s2[-1] - length)) / length)
    scale = 1 + k * (want / np.maximum(rout[sec], 1e-6) - 1)
    out[end] = ce + np.outer(r @ cn, cn) + r_perp * scale[:, None]
    return out
