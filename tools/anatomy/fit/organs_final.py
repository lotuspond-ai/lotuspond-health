"""Organs fit, part 11: final clearances of the suprarenal glands and the diaphragm, once the stomach and the
oesophagus are in place.

  1. each suprarenal gland: a rigid refinement (shape kept) on dense samples of its surface (its vertices alone let
     the kidney come closer between them): its nearest point GAP_TARGET off its kidney, the IVC, liver, spleen,
     pancreas, aorta, duodenum, colon, coeliac trunk, vertebrae and our stomach cleared; then a lift along the
     kidney's outward normal under the gland (a line search) to a LIFT_TARGET gap, as far as the other neighbours
     allow; the stage-3 diaphragm is an obstacle too (step 2's one-way test cannot see a gland its crus encloses: the
     male left gland ended 8 % inside the crus when it was not);
  2. the diaphragm: a local, shape-preserving settle (organs_settle: bi-Laplacian displacement checked over the whole
     surface, active set, pushes along the obstacle's normal) off the structures that pass through or lie in its
     openings and beside its crura: our oesophagus (hiatus), stomach and glands, and the HRA aorta; edges longer than
     SPLIT_EDGE are split first (triangles
     of up to 23 mm bridged the aorta between their test points). Not the IVC: the retrohepatic IVC is embedded in
     the liver and the HRA leaves no room for the caval rim between them (an unmasked IVC push drove the sheet 15 mm
     into the liver; a push of the rim only, the sheet within 6 mm of the IVC, with the liver resisting there, left
     both at 7 mm and folded the sheet through itself). Not the colon: where the male sheet's left costal part dips
     through the splenic flexure the HRA colon overlaps the costal cartilages, and lifting the sheet to the colon's
     thoracic side moved it up to 47 mm sideways into the ribs (tried, removed).
     The test is one-way (sheet points against the gland): a gland the crus encloses has no sheet point inside it (a
     two-way test from gland samples on the local sheet patch was tried: its pseudo-normal signs gave false insides
     and pushed the sheet up to 34 mm, so it was removed). Its domes stay
     as the diaphragm stage fitted them under the lungs and the heart: where the HRA thoracic and abdominal organs leave
     less room than the sheet needs (measured in settle_diaphragm's report) a global settle only shuttles the sheet
     between them (tried: lung overlap 4.9 % -> 17 % in the male). The sheet's two faces are paired, so it thins
     (down to MIN_THICK) rather than folding through itself.
"""
import numpy as np

from lib.mesh import sample_surface, orient_outward
from lib.register import umeyama
from fit.organs_data import hra, field, log, has_hra

HEART_CARVE = 0.004       # assemble.py carves the HRA heart plus 4 mm out of the liver (the diaphragm's room under the heart)
SPLIT_EDGE = 0.004        # diaphragm edges longer than this are split before the settle
GAP_TARGET = 0.002
MIN_THICK = 0.0006
ADR_NB = ('ivc', 'liver', 'spleen', 'pancreas', 'aorta', 'duodenum', 'colon', 'celiac', 'spine')
LIFT_TARGET = 0.0015
LIFT_TOL = 0.00025
DIA_NB = ('aorta',)


class CarvedField:
    """A neighbour with another solid plus `margin` carved out of it: signed distance max(base, margin - cut). Used for
    the liver as assembled (assemble.py carves the heart plus HEART_CARVE out of the HRA liver, whose dome the HRA
    heart's diaphragmatic surface sinks into): the central tendon then has the carved gap to lie in. Field-like:
    coarse, __call__, outward."""

    def __init__(self, base, cut, margin):
        self.base, self.cut, self.margin = base, cut, margin

    def coarse(self, p):
        return np.maximum(self.base.coarse(p), self.margin - self.cut.coarse(p))

    def __call__(self, p, band=None):
        return np.maximum(self.base(p), self.margin - self.cut(p))

    def outward(self, p):
        p = np.asarray(p, float)
        b = self.base(p); sdc = self.cut(p)
        nb, qb = self.base.outward(p)
        use = (self.margin - sdc) > b
        if use.any():
            nc, _ = self.cut.outward(p[use])
            nb = nb.copy(); qb = qb.copy()
            nb[use] = -nc                                   # the carved face looks towards the heart
            qb[use] = p[use] - (sdc[use] - self.margin)[:, None] * nc
        return nb, qb


class UnionField:
    """Signed distance to a union of solids: the minimum of their fields; outward from the part that is nearest (or
    deepest inside). Field-like: coarse, __call__, outward."""

    def __init__(self, parts):
        self.parts = list(parts)

    def coarse(self, p):
        return np.min([fl.coarse(p) for fl in self.parts], axis=0)

    def __call__(self, p, band=None):
        return np.min([fl(p) for fl in self.parts], axis=0)

    def outward(self, p):
        p = np.asarray(p, float)
        k = np.argmin([fl.coarse(p) for fl in self.parts], axis=0)
        n = np.zeros_like(p); q = np.zeros_like(p)
        for i, fl in enumerate(self.parts):
            m = k == i
            if m.any(): n[m], q[m] = fl.outward(p[m])
        return n, q


_CARVED, _HEART = {}, {}


def heart_union(sex):
    """The heart as assemble.py carves it out of the liver: its chambers and the coronary arteries and cardiac veins on
    its surface."""
    if sex not in _HEART:
        parts = [field(sex, 'heart')] + ([field(sex, 'heart_vessels')] if has_hra(sex, 'heart_vessels') else [])
        _HEART[sex] = UnionField(parts)
    return _HEART[sex]


def liver_carved(sex):
    """The liver as assembled: HRA liver minus (heart chambers + coronary arteries + cardiac veins + HEART_CARVE), the
    same carve list as assemble.py's liver part."""
    if sex not in _CARVED: _CARVED[sex] = CarvedField(field(sex, 'liver'), heart_union(sex), HEART_CARVE)
    return _CARVED[sex]


def reseat_gland(sex, s, mesh, own=(), log_=log):
    """Rigid refinement of one gland on vertices + dense surface samples. Returns (v, f), report."""
    from fit.organs_adrenal import rigid_refine
    v, f = mesh
    kfl = field(sex, f'kidney_{s}')
    others = [field(sex, k) for k in ADR_NB if has_hra(sex, k)] + [fl for _, fl in own]
    P = np.vstack([v, sample_surface(v, f, 2500, seed=11)])
    g0 = float(kfl(sample_surface(v, f, 6000, seed=1)).min())
    P2 = rigid_refine(P, kfl, others, iters=80, log_=log_)
    T = umeyama(P, P2, scale=False)
    v2 = T(v)
    # lift along the kidney's outward normal under the gland, as far as the other neighbours allow
    Q = sample_surface(v2, f, 4000, seed=12)
    dk = kfl(Q); near = dk < dk.min() + 0.002
    nk, _ = kfl.outward(Q[near]); dirn = nk.mean(0); dirn /= np.linalg.norm(dirn)
    def worst_other(X):
        return max([0.0] + [float(max(0.0, -fl(X).min())) for fl in others])
    w0 = worst_other(Q); best_t = 0.0; gaps = []
    g_prev = float(kfl(Q).min())
    for t in np.arange(0.00025, 0.0030001, 0.00025):
        g = float(kfl(Q + t * dirn).min()); w = worst_other(Q + t * dirn); gaps.append((round(t * 1000, 2), round(g * 1000, 2), round(w * 1000, 2)))
        # below the 1 mm minimum gap (the gland lies in the perirenal fat, not on the kidney) it may press up to
        # LIFT_TOL further into a soft neighbour to reach that minimum, and no further
        tol = LIFT_TOL if g_prev < 0.001 else 0.0
        if w > max(w0, 0.0003) + tol + 1e-5 or g > 0.005: break
        best_t = t; g_prev = g
        if g >= LIFT_TARGET or (g >= 0.001 and w > max(w0, 0.0003) + 1e-5): break
    v2 = v2 + best_t * dirn
    g1 = float(kfl(sample_surface(v2, f, 6000, seed=1)).min())
    return (v2, orient_outward(v2, f)), dict(kidney_gap_mm=dict(before=round(g0 * 1000, 2), after=round(g1 * 1000, 2)), lift_mm=round(best_t * 1000, 2),
                                             lift_search=gaps, moved_mm=round(float(np.linalg.norm(v2 - v, axis=1).max() * 1000), 2))


def settle_diaphragm(sex, mesh, own, iters=18, log_=log):
    """own: [(name, Field)] our stomach, oesophagus and glands. Returns (v, f), report (with the room the HRA bodies
    leave between the lung bases / the heart's inferior surface and the liver, spleen and colon)."""
    from fit.organs_diaphragm import sides
    from fit.organs_settle import settle
    from scipy.spatial import cKDTree
    from fit.organs_geom import refine_long_edges
    v, f = mesh
    # triangles longer than SPLIT_EDGE (at the openings and along the crura: up to 23 mm, bridging across the aorta at
    # T10 and the caval rim) are split first, so that the settle's per-triangle test points (centroid and edge
    # midpoints) see what passes through them
    n0 = len(v)
    v, f = refine_long_edges(v, f, SPLIT_EDGE)
    f = orient_outward(v, f)
    thor = sides(v, f)
    T = np.flatnonzero(thor); A = np.flatnonzero(~thor)
    d, j = cKDTree(v[A]).query(v[T])
    m = d < 0.010
    P, Q = T[m], A[j[m]]
    ax = v[P] - v[Q]; th = np.linalg.norm(ax, axis=1); ax /= np.maximum(th, 1e-12)[:, None]
    fields = [(k, field(sex, k), None) for k in DIA_NB if has_hra(sex, k)] + [(k, fl, None) for k, fl in own]
    # (not the heart and the liver as assembled, heart + HEART_CARVE carved out, under the heart: tried with the sheet
    # within 30 mm of the heart; in the female body, where the stage-3 dome passes 11.6 mm into the heart, the settle
    # did not converge in 18 rounds (heart 9 mm, carved liver 13 mm left), moved the sheet up to 56 mm and folded it
    # through itself; the dome has to be fitted against the carved liver in the diaphragm stage itself)
    v2, rep = settle(v, f, fields, clear=0.0004, iters=iters, pairs=(P, Q, ax), min_thick=np.minimum(th, MIN_THICK), pair_split=0.5,
                     w=30.0, inward=False, log=log_, label='diaphragm settle')
    th2 = np.einsum('ij,ij->i', v2[P] - v2[Q], ax)
    mv = np.linalg.norm(v2 - v, axis=1)
    rep['thickness_mm'] = dict(before_p5=round(float(np.percentile(th, 5) * 1000), 2), after_p5=round(float(np.percentile(th2, 5) * 1000), 2),
                               after_min=round(float(th2.min() * 1000), 2))
    rep['move_mm'] = dict(p95=round(float(np.percentile(mv, 95) * 1000), 2), max=round(float(mv.max() * 1000), 2))
    rep['split_long_edges'] = dict(max_edge_mm=SPLIT_EDGE * 1000, vertices_before=n0, vertices_after=len(v))
    rep['hra_room'] = hra_room(sex)
    return (v2, orient_outward(v2, f)), rep


def hra_room(sex):
    """Room the HRA body leaves for the diaphragm: share of the lung bases' and of the heart's inferior surface (its
    lowest 25 mm) that lies inside, or closer than 1.4 mm (a 0.6 mm sheet with 0.4 mm clearance either side) to, the
    liver, spleen or colon."""
    import os
    from fit.organs_data import cache_dir
    out = {}
    hv, hf = hra(sex, 'heart'); H = sample_surface(hv, hf, 20000, seed=2); H = H[H[:, 1] < hv[:, 1].min() + 0.025]
    for nm, X in (('lung_bases', np.load(os.path.join(cache_dir(sex), 'lung-base.npz'))['p']), ('heart_inferior', H)):
        d = np.full(len(X), np.inf); who = np.full(len(X), '', object)
        for k in ('liver', 'spleen', 'colon'):
            dk = field(sex, k).coarse(X); m = dk < d; d[m] = dk[m]; who[m] = k
        out[nm] = dict(inside_pct=round(float((d < 0).mean() * 100), 1), under_1_4mm_pct=round(float((d < 0.0014).mean() * 100), 1),
                       deepest_overlap_mm=round(float(max(0.0, -d.min()) * 1000), 1),
                       by_organ_under_1_4mm_pct={k: round(float(((d < 0.0014) & (who == k)).mean() * 100), 1) for k in ('liver', 'spleen', 'colon')})
    return out



CRUS_CLEAR = 0.0012       # clearance the crus keeps from a gland in its two-way yield (more than half the gland's
                          # thin medial edge, so that the sheet points beside the edge see it)


def crus_yield(sex, mesh, glands, iters=12, log_=log):
    """The crura give way to the suprarenal glands: a thin edge of a gland poking into the crus between the sheet's
    test points (the male left gland's medial edge, 3.5 mm into the left crus) is invisible to the settle above,
    which pushes sheet points along the gland's normal: beside a thin edge that normal points sideways, so the near
    face only slides along the edge. Here the sheet points within CRUS_CLEAR of a gland walk along the sheet's own
    inward normal until they are clear of it (organs_settle.settle, inward=True): the crus's near face retreats past
    the edge's tip, with the smooth bi-Laplacian falloff of the settle; the two faces are paired, so the crus thins
    (down to MIN_THICK) before its other face moves (behind the male left crus lies the L1 vertebral body).
    glands: {name: (v, f)}. Returns (v, f), report."""
    from scipy.spatial import cKDTree
    from fit.organs_settle import settle
    from fit.organs_diaphragm import sides
    from fit.organs_geom import mesh_field
    v, f = mesh; v = np.asarray(v, float); f = orient_outward(v, f)
    thor = sides(v, f)
    T, A = np.flatnonzero(thor), np.flatnonzero(~thor)
    d, j = cKDTree(v[A]).query(v[T]); m = d < 0.010
    P, Q = T[m], A[j[m]]
    ax = v[P] - v[Q]; th = np.linalg.norm(ax, axis=1); ax /= np.maximum(th, 1e-12)[:, None]
    fields = [(k, mesh_field(gv, gf, 0.0005), CRUS_CLEAR) for k, (gv, gf) in glands.items()]
    v2, rep = settle(v, f, fields, clear=CRUS_CLEAR, iters=iters, pairs=(P, Q, ax), min_thick=np.minimum(th, MIN_THICK), pair_split=0.5,
                     w=30.0, inward=True, log=log_, label='crus yield')
    th2 = np.einsum('ij,ij->i', v2[P] - v2[Q], ax)
    mv = np.linalg.norm(v2 - v, axis=1)
    rep['moved_vertices'] = int((mv > 0.0001).sum())
    rep['thickness_mm'] = dict(min_before=round(float(th.min() * 1000), 2), min_after=round(float(th2.min() * 1000), 2))
    return (v2, orient_outward(v2, f)), rep
