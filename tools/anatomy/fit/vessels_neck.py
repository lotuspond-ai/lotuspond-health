"""Neck tubes for the vessels group (fit/vessels.py, the last review step, after the push-out and the post-push settle):
the common carotid arteries, and any other two-ring neck or thoracic-outlet vessel whose sections the earlier steps
crushed or swelled, are swept again as round tubes along a smooth course routed through free space, so every move is a
move of whole cross-sections. numpy + scipy only.

Why: the push-out (fit/vessels_fix.py) moves wall vertices (Gaussian-spread). Where an organ envelops a vessel (the
male left common carotid, which the warp laid 7 mm into the thyroid lobe) it pushes one wall out and not the other, so
the tube swells and flattens (a 30 mm spindle 14-15 x 20-21 mm, 2-3 x adult calibre, still 6.8 mm inside the lobe);
narrow spaces squeeze tubes into ribbons (both male common carotids at the bifurcation, the female ones over their whole
length, the female right brachiocephalic vein after its round re-sweep). The uniform calibre scaling of
vessels_review.neck_calibres cannot remove a local bulge.

Method, per vessel, with its two end rings A (the junction ring: an HRA stub, a fork, or the lower ring) and B:
 1. Course: the main-trunk centreline from A's centre to B's centre, smoothed (Gaussian, COURSE_SIGMA) except over the
    stretch a junction's angle is measured on (a chain: one radius + 1.5 cm, held, faded in over HOLD_FADE; a fork or
    branch: 1.2 cm) and the last B_HOLD before B, so a bulge or kink the earlier steps left in the centreline goes while
    both rings keep their centres and axes.
 2. Route: dynamic programming over RT_STEP course bins (as vessels_sep.route_dp), each bin choosing an offset in its
    section plane that trades the squared offset against the squared missing clearance of a ball of the target radius
    (bones 0.8 mm, solid organs and lung lobes 0.3 mm, the HRA aorta and veins, the other placed vessels 0.5 mm; for an
    artery its companion veins, for a vein the placed arteries) and the squared change between neighbouring bins; held
    bins keep their place. The course moves, never single wall vertices.
 3. Sweep: every vertex goes to the circle of the target radius at its own normalised arc length and its own angle
    about the new course (rotation-minimising frames, the twist between the old and the new frames read off ring B),
    the angles evened out by neighbour averaging; toward each ring the section blends from the round one into the ring's
    own shape, and the rings themselves stay exactly where they are (joined to what they meet). Common carotid: the
    adult calibre vessels_review.NECK_D['CCA'] (outer diameter; Krejza et al. 2006, ultrasound: 6.5 +- 1.0 mm in men, 6.1 +- 0.8 mm in women),
    blended from the junction ring's radius over CCA_BLEND, and over the last BULB_LEN below the bifurcation ring the
    section widens into that ring (which spans the origins of the internal carotid's sinus and of the external carotid):
    the carotid bulb. Other vessels: their own calibre (median area-equivalent diameter of their round sections,
    smoothed along the vessel; crushed sections take their neighbours').
    A vein swept round before the push-out (vessels_sep.sweep_veins: the female right brachiocephalic, which the push-out
    then folded flat) reads its vertices' arc lengths and angles from that round layout (fit/vessels.py keeps it as
    'layout_v').
 4. Attempts and acceptance: first with the junction stretch held; a vein that is not kept then gets a second attempt
    with only its end rings held (the course may turn about the junction ring as far as the junction angle allows) and,
    where a round wall still lacks clearance after the route, an area-preserving oval section (minor axis toward the
    obstacle, aspect up to VEIN_OVAL; ellipse_plan). An attempt is kept when its sections are rounder, its vertices go
    no deeper into a bone or an organ than before (PEN_TOL), its clearance from the other vessels is not smaller (by
    ACCEPT_TOL) and its junction gaps and angles still pass; the common carotids need only the rounder sections and the
    junctions (their calibre and their way out of the thyroid are the point).
Vessels checked (CHECK): the common and external carotids, the internal and external jugular veins, the subclavian
arteries and veins and the brachiocephalic veins, re-swept where a section 1 cm in from the rings is flatter than
ART_ASPECT (arteries) or VEIN_ASPECT (veins: a vein passing a narrow space may stay oval), or the calibre jumps by more
than JUMP within 6 mm; only two-ring meshes (no side branches) are re-swept. The internal carotids (petrous canal and
siphon) and the vertebral arteries (their course through the transverse foramina is fitted to the bone and checked
there) are only measured.
"""
import numpy as np
from scipy.spatial import cKDTree
from scipy import sparse

from fit import vessels_geom as G
from fit import vessels_review as RV
from fit import vessels_sep as SP

CCA = ('Left_common_carotid_artery', 'Right_common_carotid_artery')
CCA_BLEND = 0.030       # the junction ring's radius blends into CCA_D over this length (m)
BULB_LEN = 0.016        # below the bifurcation ring the round section widens into the ring's shape over this length (m)
RING_LEN = 0.008        # other vessels: the round section blends into an end ring's shape over this length (m)
RING_KEEP = 0.003       # vertices this close (course arc length) to an end ring keep their place, faded in over it (m)
COURSE_SIGMA = 0.005    # course smoothing (m)
HOLD_FADE = 0.006       # the smoothing and the route fade in over this length beyond a held stretch (m)
B_HOLD = 0.003          # held stretch before ring B (m)
RT_STEP = 0.003         # course bins of the route (m)
GRID = np.arange(-0.012, 0.01201, 0.001)   # section offsets of the route (m)
PAD = 0.0004            # added to the section radius in the route's clearance test (m)
CHECK = ('common_carotid', 'Internal_carotid', 'External_carotid', 'Internal_jugular', 'External_jugular', 'subclavian', 'brachiocephalic_vein')
ART_ASPECT, VEIN_ASPECT, JUMP = 2.0, 2.5, 1.5
ACCEPT_TOL = 0.0002     # a re-sweep may lose at most this much clearance (m)
CLEAR = dict(bone=0.0008, organ=0.0003, vessel=0.0005)


def r2(x, k=2):
    return None if x is None else round(float(x), k)


def resample(P, step=0.0005):
    """Polyline resampled at `step` with both end points kept: (Q, s)."""
    P = np.asarray(P, float)
    s = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]
    n = max(2, int(np.ceil(s[-1] / step)) + 1)
    t = np.linspace(0.0, s[-1], n)
    return np.stack([np.interp(t, s, P[:, a]) for a in range(3)], 1), t


def frames(Q):
    T = G.unit(np.gradient(Q, axis=0))
    U, W = RV.rmf(Q, T)
    return T, U, W


def polar(o, T, U, W):
    o = o - np.einsum('ij,ij->i', o, T)[:, None] * T
    return np.arctan2(np.einsum('ij,ij->i', o, W), np.einsum('ij,ij->i', o, U)), np.linalg.norm(o, axis=1)


def periodic(th, th_k, r_k):
    o = np.argsort(th_k); a = th_k[o]; r = r_k[o]
    a = np.r_[a - 2 * np.pi, a, a + 2 * np.pi]; r = np.r_[r, r, r]
    return np.interp(np.angle(np.exp(1j * th)), a, r)


def rings_of(n, x, J):
    """(A, B, junction of A or None): A is the ring at a junction of this vessel (else the lower one)."""
    L = RV.end_loops(x['v'], x['f'])
    if len(L) != 2: return None
    for l in L: l['c'] = x['v'][l['idx']].mean(0)
    jj = [j for j in J if n in j.get('vessels', ())]
    best = None
    for j in jj:
        c = np.asarray(j['end']['c'] if j.get('end') else j['c'], float)
        k = int(np.argmin([np.linalg.norm(l['c'] - c) for l in L]))
        d = float(np.linalg.norm(L[k]['c'] - c))
        if d < 0.02 and (best is None or d < best[0]): best = (d, k, j)
    if best is None:
        k = int(np.argmin([l['c'][1] for l in L])); return L[k], L[1 - k], None
    return L[best[1]], L[1 - best[1]], best[2]


def old_course(x, A, B):
    """Main-trunk centreline from ring A's centre to ring B's centre (exact ring centres), resampled: (Q, s)."""
    cl = RV.trunk(x['v'], x['f'], start=A['c'])
    if cl is None: return None, None
    P = list(cl['p'][1:])
    while len(P) > 1 and np.linalg.norm(P[-1] - B['c']) < 0.002: P.pop()
    P = np.vstack([A['c'], P, B['c']]) if P else np.vstack([A['c'], B['c']])
    return resample(P)


def hold_profile(s, L, hA, hB=B_HOLD, fade=HOLD_FADE):
    return G.smoothstep((s - hA) / fade) * G.smoothstep((L - s - hB) / fade)


def smooth_course(Q, s, w, sigma=COURSE_SIGMA):
    K = np.exp(-0.5 * ((s[:, None] - s[None]) / sigma) ** 2)
    Ps = (K @ Q) / K.sum(1)[:, None]
    return resample(Q + w[:, None] * (Ps - Q))


def route(Q, s, wfun, rfun, deficit, grid=GRID, step=RT_STEP, iters=2):
    """Whole-course route (vessels_sep.route_dp's cost on a course instead of a mesh): returns (Q', s', deficit before (m),
    deficit after (m), largest shift (m))."""
    g1, g2 = np.meshgrid(grid, grid); g1 = g1.ravel(); g2 = g2.ravel(); M = len(g1)
    Q0 = Q.copy(); d_before = None; d_after = None
    for it in range(iters + 1):
        w = wfun(s)
        L = s[-1]; nb = max(3, int(round(L / step)) + 1); sk = np.linspace(0.0, L, nb)
        C = np.stack([np.interp(sk, s, Q[:, a]) for a in range(3)], 1)
        rk = rfun(sk); pk = np.interp(sk, s, w)
        free = pk > 0.02
        d0 = np.where(free, deficit(C, rk), 0.0)
        if d_before is None: d_before = float(d0.max())
        d_after = float(d0.max())
        if it == iters or d0.max() < 1e-4: break
        T, U, W = frames(C)
        OFF = g1[None, :, None] * U[:, None, :] + g2[None, :, None] * W[:, None, :]
        ks = np.flatnonzero(free)
        dfc = np.zeros((nb, M))
        dfc[ks] = deficit((C[ks][:, None, :] + OFF[ks]).reshape(-1, 3), np.repeat(rk[ks] + PAD, M)).reshape(len(ks), M)
        o2 = (np.linalg.norm(OFF, axis=2) * 1000) ** 2
        un = o2 * (1.0 + 1.0e4 * (1.0 - pk))[:, None] + SP.RT_HARD * (dfc * 1000) ** 2
        cost = un[0].copy(); back = np.zeros((nb, M), int)
        for k in range(1, nb):
            D2 = (((OFF[k][:, None, :] - OFF[k - 1][None, :, :]) * 1000) ** 2).sum(-1)
            tot = cost[None, :] + SP.RT_SMOOTH * D2
            j = np.argmin(tot, axis=1); back[k] = j
            cost = un[k] + tot[np.arange(M), j]
        sel = np.zeros(nb, int); sel[-1] = int(np.argmin(cost))
        for k in range(nb - 1, 0, -1): sel[k - 1] = back[k, sel[k]]
        vec = OFF[np.arange(nb), sel]
        Kb = np.exp(-0.5 * ((sk[:, None] - sk[None]) / step) ** 2); vec = (Kb @ vec) / Kb.sum(1)[:, None]
        off = np.stack([np.interp(s, sk, vec[:, a]) for a in range(3)], 1) * w[:, None]
        Q, s = resample(Q + off)
    shift = float(np.max(np.linalg.norm(resample_to(Q, s, len(Q0)) - Q0, axis=1))) if len(Q0) else 0.0
    return Q, s, d_before, d_after, shift


def resample_to(Q, s, n):
    t = np.linspace(0.0, s[-1], n)
    return np.stack([np.interp(t, s, Q[:, a]) for a in range(3)], 1)


def sweep(x, Qo, so, Qn, sn, rfun, A, B, lenA, lenB, smooth_iters=10, layout=None, ell=None):
    """Vertices onto round sections about the new course (see the module docstring, step 3). Returns new vertices."""
    v, f = x['v'], x['f']
    vl = v if layout is None else layout     # the layout each vertex's arc length and angle are read from
    To, Uo, Wo = frames(Qo); Tn, Un, Wn = frames(Qn)
    _, io = cKDTree(Qo).query(vl)
    u = so[io] / so[-1]
    th_o, _ = polar(vl - Qo[io], To[io], Uo[io], Wo[io])
    phi = float(np.arctan2(np.cross(Uo[-1], Un[-1]) @ Tn[-1], Uo[-1] @ Un[-1]))
    sp = u * sn[-1]
    kn = np.clip(np.searchsorted(sn, sp), 0, len(sn) - 1)
    th = th_o - phi * u
    e = np.cos(th)[:, None] * Un[kn] + np.sin(th)[:, None] * Wn[kn]
    E = G.edge_list(f); nv = len(v)
    Ad = sparse.coo_matrix((np.ones(2 * len(E)), (np.r_[E[:, 0], E[:, 1]], np.r_[E[:, 1], E[:, 0]])), shape=(nv, nv)).tocsr()
    deg = np.maximum(np.asarray(Ad.sum(1)).ravel(), 1)
    for _ in range(smooth_iters):
        e = e + 0.5 * ((Ad @ e) / deg[:, None] - e)
        e = G.unit(e - np.einsum('ij,ij->i', e, Tn[kn])[:, None] * Tn[kn])
    th = np.arctan2(np.einsum('ij,ij->i', e, Wn[kn]), np.einsum('ij,ij->i', e, Un[kn]))
    thA, rA = polar(v[A['idx']] - Qn[0], np.tile(Tn[0], (len(A['idx']), 1)), np.tile(Un[0], (len(A['idx']), 1)), np.tile(Wn[0], (len(A['idx']), 1)))
    thB, rB = polar(v[B['idx']] - Qn[-1], np.tile(Tn[-1], (len(B['idx']), 1)), np.tile(Un[-1], (len(B['idx']), 1)), np.tile(Wn[-1], (len(B['idx']), 1)))
    # blends by geodesic distance from each ring's vertices (an oblique ring spans several mm of course arc length)
    Gr = G.graph(vl, f)
    gA = G.geodesic(Gr, A['idx'].tolist(), limit=max(lenA, RING_KEEP) + 0.01); gA = np.where(np.isfinite(gA), gA, 1.0)
    gB = G.geodesic(Gr, B['idx'].tolist(), limit=max(lenB, RING_KEEP) + 0.01); gB = np.where(np.isfinite(gB), gB, 1.0)
    a = RV.raised(gA / lenA); b = RV.raised(gB / lenB)
    tot = np.maximum(1.0, a + b); a = a / tot; b = b / tot
    rr = rfun(sp)
    if ell is not None:
        # an oval section (vein in a narrow space): area-preserving ellipse, minor axis along psi
        asp, psi = ell
        k = np.sqrt(asp[kn]); ph = th - psi[kn]
        rr = rr / np.sqrt((np.cos(ph) * k) ** 2 + (np.sin(ph) / k) ** 2)
    R = (1 - a - b) * rr + a * periodic(th, thA, rA) + b * periodic(th, thB, rB)
    vn = Qn[kn] + R[:, None] * e
    g = np.maximum(RV.raised(gA / RING_KEEP), RV.raised(gB / RING_KEEP))
    return vn + g[:, None] * (v - vn)


def ellipse_plan(Q, s, rfun, deficit, cap, sub=6, sigma=0.004):
    """Per course point (aspect, psi): where the round section's wall still lacks clearance after the route, the section
    becomes an area-preserving ellipse whose minor axis points at the deepest missing clearance, flattened just enough
    (minor semi-axis r - missing clearance) up to an aspect of `cap`, smoothed along the course (orientation as a
    doubled-angle vector)."""
    T, U, W = frames(Q)
    ks = np.arange(0, len(Q), sub); ks = np.unique(np.r_[ks, len(Q) - 1])
    rk = rfun(s[ks]); ph = np.linspace(0, 2 * np.pi, 24, endpoint=False)
    P = Q[ks][:, None, :] + rk[:, None, None] * (np.cos(ph)[None, :, None] * U[ks][:, None, :] + np.sin(ph)[None, :, None] * W[ks][:, None, :])
    m = deficit(P.reshape(-1, 3), np.zeros(P.shape[0] * P.shape[1])).reshape(len(ks), len(ph))
    j = np.argmax(m, axis=1); mm = m[np.arange(len(ks)), j]
    b = np.clip(rk - mm, rk / np.sqrt(cap), rk)
    asp = (rk / b) ** 2
    q = (asp - 1)[:, None] * np.stack([np.cos(2 * ph[j]), np.sin(2 * ph[j])], 1)
    K = np.exp(-0.5 * ((s[ks][:, None] - s[ks][None]) / sigma) ** 2); q = (K @ q) / K.sum(1)[:, None]
    qa = np.stack([np.interp(s, s[ks], q[:, 0]), np.interp(s, s[ks], q[:, 1])], 1)
    return 1.0 + np.linalg.norm(qa, axis=1), 0.5 * np.arctan2(qa[:, 1], qa[:, 0]), float(mm.max())


def penetration(v, F):
    """Deepest vertex inside a bone / an organ (mm)."""
    out = {}
    for lab, ob in (('bone', F.bones), ('organ', F.organs)):
        sd = ob.query(v)[0]
        out[lab] = r2(max(0.0, -float(np.min(np.where(np.isfinite(sd), sd, 1.0)))) * 1000, 1)
    return out


def section_rows(x, A=None):
    cl = RV.trunk(x['v'], x['f'], start=None if A is None else A['c'])
    if cl is None: return None, None
    return RV.calibre_profile(x['v'], x['f'], cl), cl


def shape_metrics(x, skip_top=0.0):
    """(p90 aspect, max aspect, largest calibre jump within 6 mm) over the sections 1 cm in from the rings (and below
    `skip_top` from the highest ring), along the trunk from the highest ring."""
    rows, cl = section_rows(x)
    if not rows: return None, None, None
    L = cl['s'][-1]
    rr = [r for r in rows if max(0.01, skip_top) < r['s'] < L - 0.01]
    if not rr: return None, None, None
    a = np.array([r['aspect'] for r in rr]); d = np.array([r['d_eq'] for r in rr])
    jump = max([max(d[i], d[i + 2]) / max(min(d[i], d[i + 2]), 1e-5) for i in range(len(d) - 2)] or [1.0])
    return float(np.quantile(a, 0.9)), float(a.max()), float(jump)


def own_calibre(x, A, Q, s):
    """Target radius along the course for a vessel other than a common carotid: the area-equivalent radius of its round
    sections (aspect <= 1.6), Gaussian-smoothed along the vessel, interpolated over crushed ones."""
    cl = dict(p=Q, s=s, t=G.unit(np.gradient(Q, axis=0)))
    rows = RV.calibre_profile(x['v'], x['f'], cl, step=0.002)
    ok = [(r['s'], r['d_eq'] / 2) for r in rows if r['aspect'] <= 1.6 and 0.004 < r['s'] < s[-1] - 0.004]
    if len(ok) < 3:
        ok = [(r['s'], r['d_eq'] / 2) for r in rows if 0.004 < r['s'] < s[-1] - 0.004]
        if not ok: return None
        med = float(np.median([b for _, b in ok]))
        return lambda t: np.full(len(np.atleast_1d(t)), med)
    sk, rk = np.array(ok).T
    K = np.exp(-0.5 * ((sk[:, None] - sk[None]) / 0.006) ** 2); rk = (K @ rk) / K.sum(1)
    return lambda t: np.interp(t, sk, rk)


def obstacles_for(n, VES, F, aorta, hra_veins):
    """[(obstacle, clearance)] for vessel n: bones, organs (incl. the lung lobes), the HRA aorta, and the placed vessels
    it must keep apart from (an artery: the placed veins beside it and the HRA veins; a vein: the placed arteries), as
    tubes; never the vessels it joins at its rings."""
    x = VES[n]
    me = [l['c'] for l in RV.end_loops(x['v'], x['f'])]
    lo, hi = x['v'].min(0) - 0.03, x['v'].max(0) + 0.03
    tubes = []
    for m, y in VES.items():
        if m == n or not y['placed'] or y.get('dropped') or m.startswith(SP.SUPERFICIAL): continue
        same = y['part'] == x['part']
        if same and not (x['part'] == 'arteries' and m.startswith(('Vertebral', 'Left_subclavian_artery', 'Right_subclavian_artery'))): continue
        if not np.any(np.all((y['v'] >= lo) & (y['v'] <= hi), axis=1)): continue
        # an artery of the same tree that meets this one at a ring (within 6 mm of a ring centre) is left out
        if same and me and cKDTree(y['v']).query(np.array(me))[0].min() < 0.006: continue
        P, R, cl = SP.vessel_tube(y)
        if P is not None: tubes.append((m, P, R))
    obs = [(F.bones, CLEAR['bone']), (F.organs, CLEAR['organ'])]; labels = ['bone', 'organ']
    if aorta is not None: obs.append((aorta, CLEAR['vessel'])); labels.append('HRA aorta')
    if tubes: obs.append((SP.MultiTube(tubes), CLEAR['vessel'])); labels.append('placed vessels')
    if x['part'] == 'arteries' and hra_veins is not None: obs.append((hra_veins, CLEAR['vessel'])); labels.append('HRA veins')
    return obs, labels, [t[0] for t in tubes]


def deficit_report(x, obs, labels):
    """Largest missing clearance of the vessel's sections per obstacle kind (mm), its level and the nearest mesh."""
    P, R, cl = SP.vessel_tube(x, RT_STEP)
    if P is None: return {}
    sk = np.arange(0.5 * RT_STEP, cl['s'][-1], RT_STEP)
    if not len(sk): return {}
    C = np.stack([np.interp(sk, cl['s'], cl['p'][:, a]) for a in range(3)], 1); Rk = np.interp(sk, cl['s'], R)
    out = {}
    for (ob, clr), lab in zip(obs, labels):
        d = SP.deficit_fn([(ob, clr)])(C, Rk)
        if d.max() <= 1e-4: continue
        i = int(np.argmax(d)); row = dict(mm=r2(d[i] * 1000, 1), y=r2(C[i, 1], 3))
        if isinstance(ob, G.Obstacles):
            _, _, who = ob.query(C[i:i + 1], band=0.03)
            row['nearest'] = ob.names[who[0]] if who[0] >= 0 else None
        elif isinstance(ob, SP.MultiTube):
            row['nearest'] = ob.names[int(ob.query(C[i:i + 1])[2][0])]
        out[lab] = row
    return out


def candidates(sex, VES):
    out = []
    for n, x in VES.items():
        if not x['placed'] or x.get('dropped') or not any(k in n for k in CHECK): continue
        if n in CCA: out.append((n, 'calibre')); continue
        L = RV.end_loops(x['v'], x['f'])
        if len(L) != 2: continue
        thr = ART_ASPECT if x['part'] == 'arteries' else VEIN_ASPECT
        if n.startswith('Internal_carotid'):
            continue   # measured only: its petrous and cavernous parts (the siphon) are not a straight tube
        p90, mx, jump = shape_metrics(x)
        if mx is None: continue
        if mx > thr or jump > JUMP: out.append((n, f'max section aspect {mx:.2f}, p90 {p90:.2f}, calibre jump {jump:.2f}'))
    return out


VEIN_OVAL = 2.0          # a vein whose round re-sweep lacks clearance may stay oval up to this section aspect
PEN_TOL = 0.0003         # a re-sweep may go at most this much deeper into a bone or an organ than before (m)


def retube(sex, n, VES, J, F, aorta, hra_veins, log=print):
    from fit import vessels_measure as VM
    x = VES[n]
    rg = rings_of(n, x, J)
    if rg is None: return dict(skipped='not two end rings')
    A, B, jA = rg
    Qo, so = old_course(x, A, B)
    if Qo is None: return dict(skipped='no trunk')
    # a vein swept round before the push-out (vessels_sep.sweep_veins) keeps that round layout for its vertices' arc
    # lengths and angles (the push-out may have folded it)
    lay = x.get('layout_v')
    lay = lay if lay is not None and len(lay) == len(x['v']) else None
    if lay is not None:
        Ql, sl = old_course(dict(v=lay, f=x['f']), dict(idx=A['idx'], c=lay[A['idx']].mean(0)), dict(idx=B['idx'], c=lay[B['idx']].mean(0)))
        if Ql is None: lay = None
    L = so[-1]
    rA = float(np.linalg.norm(x['v'][A['idx']] - A['c'], axis=1).mean())
    if jA is None: hA = 0.004
    elif jA['kind'] == 'chain': hA = rA + 0.015 + 0.002
    else: hA = 0.012
    hA = min(hA, 0.45 * L)
    vein = x['part'] == 'veins'
    if n in CCA:
        r0 = RV.NECK_D[sex]['CCA'] / 2
        rfun = lambda t, r0=r0, rA=rA: r0 + (rA - r0) * RV.raised(np.asarray(t) / CCA_BLEND)
        lenB = BULB_LEN
    else:
        rfun = own_calibre(x if lay is None else dict(v=lay, f=x['f']), A, Qo if lay is None else Ql, so if lay is None else sl)
        if rfun is None: return dict(skipped='no calibre')
        lenB = RING_LEN
    obs, labels, tube_names = obstacles_for(n, VES, F, aorta, hra_veins)
    deficit = SP.deficit_fn(obs)
    tubes_only = SP.deficit_fn([o for o, lab in zip(obs, labels) if lab not in ('bone', 'organ')])
    p90b, mxb, jb = shape_metrics(x)
    Jn = [j for j in J if n in j.get('vessels', ())]
    jr0 = VM.junctions(Jn, VES) if Jn else []
    dfn_now = SP.tube_deficit(x, tubes_only)
    pen0 = penetration(x['v'], F)
    v_old = x['v'].copy()
    thr = VEIN_ASPECT if vein else ART_ASPECT
    # attempts: the junction stretch held (the course moves beyond it); a vein whose round tube lacks room then also
    # with only its end rings held and its sections oval where the wall still lacks clearance
    tries = [dict(kind='round, junction stretch held', hold=hA, oval=False)]
    if vein: tries.append(dict(kind=f'rings held, oval up to {VEIN_OVAL}', hold=0.004, oval=True))
    cands = []
    for t in tries:
        x['v'] = v_old.copy()
        w = hold_profile(so, L, t['hold'])
        Qs, ss = smooth_course(Qo, so, w)
        Qr, sr, d0, d1, shift = route(Qs, ss, lambda q, h=t['hold']: hold_profile(q, q[-1], h), rfun, deficit)
        ell = None; oval_need = 0.0
        if t['oval']:
            asp, psi, oval_need = ellipse_plan(Qr, sr, rfun, deficit, VEIN_OVAL)
            ell = (asp, psi)
        x['v'] = sweep(x, Qo if lay is None else Ql, so if lay is None else sl, Qr, sr, rfun, A, B, RING_LEN, lenB, layout=lay, ell=ell)
        p90a, mxa, ja = shape_metrics(x)
        jr1 = VM.junctions(Jn, VES) if Jn else []
        pen1 = penetration(x['v'], F)
        dfn_new = SP.tube_deficit(x, tubes_only)
        jfail = [r['key'] for r0_, r in zip(jr0, jr1) if (r0_['pass_gap'] and not r['pass_gap']) or (r0_.get('pass_angle') and r.get('pass_angle') is False)]
        rounder = mxa is not None and (mxb is None or mxa < mxb or mxa <= thr)
        deeper = [k for k in pen1 if pen1[k] > pen0[k] + PEN_TOL * 1000]
        ok = not jfail and rounder and (n in CCA or (not deeper and dfn_new <= dfn_now + ACCEPT_TOL))
        info = dict(attempt=t['kind'], kept=bool(ok), course_mm=r2(sr[-1] * 1000, 1), held_from_junction_mm=r2(t['hold'] * 1000, 1),
                    target_d_mm=[r2(2 * float(np.min(rfun(sr))) * 1000, 1), r2(2 * float(np.median(rfun(sr))) * 1000, 1), r2(2 * float(np.max(rfun(sr))) * 1000, 1)],
                    aspect_p90_max_before=[r2(p90b), r2(mxb)], aspect_p90_max_after=[r2(p90a), r2(mxa)], calibre_jump_before_after=[r2(jb), r2(ja)],
                    penetration_mm_before=pen0, penetration_mm_after=pen1, vessel_clearance_deficit_mm_before_after=[r2(dfn_now * 1000, 1), r2(dfn_new * 1000, 1)],
                    route_deficit_mm=[r2(d0 * 1000, 1), r2(d1 * 1000, 1)], course_shift_mm=r2(shift * 1000, 1),
                    max_vertex_shift_mm=r2(np.linalg.norm(x['v'] - v_old, axis=1).max() * 1000, 1),
                    junctions=[dict(key=r['key'], gap_mm=[r0_['gap_mm'], r['gap_mm']], angle_deg=[r0_.get('angle_deg'), r.get('angle_deg')]) for r0_, r in zip(jr0, jr1)])
        if t['oval']: info['oval_max_aspect'] = r2(float(ell[0].max())); info['wall_missing_clearance_mm'] = r2(oval_need * 1000, 1)
        if jfail: info['junction_would_fail'] = jfail
        if deeper: info['deeper_into'] = deeper
        info['missing_clearance_after'] = deficit_report(x, obs, labels)
        cands.append((info, x['v'].copy(), p90a if p90a is not None else 99.0))
        log(f'  neck tube {n} ({t["kind"]}): {info}')
        if ok and (p90a is not None and p90a <= thr): break
    good = [c for c in cands if c[0]['kept']]
    if good:
        best = min(good, key=lambda c: c[2]); x['v'] = best[1]; info = dict(best[0])
    else:
        x['v'] = v_old; info = dict(cands[-1][0]); info['kept'] = False
    info['attempts'] = [c[0]['attempt'] + (' (kept)' if c[0] is info or (good and c is min(good, key=lambda c: c[2])) else '') for c in cands]
    info['kept_apart_from'] = tube_names
    return info


def neck_tubes(sex, VES, J, F, aorta=None, hra_veins=None, log=print):
    """Re-sweep the common carotids and the crushed neck / thoracic-outlet vessels (module docstring)."""
    out = {}
    cand = candidates(sex, VES)
    log(f'  neck tubes: {cand}')
    # the common carotids first (the jugular veins and the others then keep apart from their new course)
    cand.sort(key=lambda c: (c[0] not in CCA, c[0]))
    for n, why in cand:
        try:
            out[n] = dict(reason=why, **retube(sex, n, VES, J, F, aorta, hra_veins, log=log))
        except Exception as ex:  # noqa: BLE001
            import traceback; traceback.print_exc()
            out[n] = dict(reason=why, error=repr(ex))
    return out
