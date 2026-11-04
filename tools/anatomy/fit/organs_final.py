"""Organs fit, part 11: final clearances of the suprarenal glands and the diaphragm, once the stomach and the
oesophagus are in place.

  1. each suprarenal gland: a rigid refinement (shape kept) on dense samples of its surface (its vertices alone let
     the kidney come closer between them): its nearest point GAP_TARGET off its kidney, the IVC, liver, spleen,
     pancreas, aorta, duodenum, colon, coeliac trunk, vertebrae and our stomach cleared; then a lift along the
     kidney's outward normal under the gland (a line search) to a LIFT_TARGET gap, as far as the other neighbours
     allow; the diaphragm is no obstacle here, its crura give way in step 2 (muscle yields to the gland);
  2. the diaphragm: a local, shape-preserving settle (organs_settle: bi-Laplacian displacement checked over the whole
     surface, active set, pushes along the obstacle's normal) off the structures that pass through or lie in its
     openings and beside its crura: our oesophagus (hiatus), stomach and glands, and the HRA aorta (not the IVC: the
     retrohepatic IVC is embedded in the liver, and pushing the caval rim off it drove the sheet 15 mm into the liver).
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

GAP_TARGET = 0.002
MIN_THICK = 0.0006
ADR_NB = ('ivc', 'liver', 'spleen', 'pancreas', 'aorta', 'duodenum', 'colon', 'celiac', 'spine')
LIFT_TARGET = 0.0015
DIA_NB = ('aorta',)


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
    for t in np.arange(0.00025, 0.0030001, 0.00025):
        g = float(kfl(Q + t * dirn).min()); w = worst_other(Q + t * dirn); gaps.append((round(t * 1000, 2), round(g * 1000, 2), round(w * 1000, 2)))
        if w > max(w0, 0.0003) + 1e-5 or g > 0.005: break
        best_t = t
        if g >= LIFT_TARGET: break
    v2 = v2 + best_t * dirn
    g1 = float(kfl(sample_surface(v2, f, 6000, seed=1)).min())
    return (v2, orient_outward(v2, f)), dict(kidney_gap_mm=dict(before=round(g0 * 1000, 2), after=round(g1 * 1000, 2)), lift_mm=round(best_t * 1000, 2),
                                             lift_search=gaps, moved_mm=round(float(np.linalg.norm(v2 - v, axis=1).max() * 1000), 2))


def settle_diaphragm(sex, mesh, own, iters=14, log_=log):
    """own: [(name, Field)] our stomach, oesophagus and glands. Returns (v, f), report (with the room the HRA bodies
    leave between the lung bases / the heart's inferior surface and the liver, spleen and colon)."""
    from fit.organs_diaphragm import sides
    from fit.organs_settle import settle
    from scipy.spatial import cKDTree
    v, f = mesh
    thor = sides(v, f)
    T = np.flatnonzero(thor); A = np.flatnonzero(~thor)
    d, j = cKDTree(v[A]).query(v[T])
    m = d < 0.010
    P, Q = T[m], A[j[m]]
    ax = v[P] - v[Q]; th = np.linalg.norm(ax, axis=1); ax /= np.maximum(th, 1e-12)[:, None]
    fields = [(k, field(sex, k), None) for k in DIA_NB if has_hra(sex, k)] + [(k, fl, None) for k, fl in own]
    v2, rep = settle(v, f, fields, clear=0.0004, iters=iters, pairs=(P, Q, ax), min_thick=np.minimum(th, MIN_THICK), pair_split=0.5,
                     w=30.0, inward=False, log=log_, label='diaphragm settle')
    th2 = np.einsum('ij,ij->i', v2[P] - v2[Q], ax)
    mv = np.linalg.norm(v2 - v, axis=1)
    rep['thickness_mm'] = dict(before_p5=round(float(np.percentile(th, 5) * 1000), 2), after_p5=round(float(np.percentile(th2, 5) * 1000), 2),
                               after_min=round(float(th2.min() * 1000), 2))
    rep['move_mm'] = dict(p95=round(float(np.percentile(mv, 95) * 1000), 2), max=round(float(mv.max() * 1000), 2))
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
