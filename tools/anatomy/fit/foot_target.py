"""What the foot fit aims at in one HRA body (fit/foot.py): the HRA tibia and fibula of one leg (picked by position, never
by name alone), the similarity that seats the Z-Anatomy distal tibia and fibula on them (the ankle mortise), the skin of
the foot with exact and voxel signed distances, and the articular surfaces of the HRA mortise (plafond, medial and
lateral malleolar facets)."""
import os, json
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import source, merge, orient_outward, sample_surface, dense_points, compact
from lib.register import Sim, icp, umeyama
from fit.common import hra_select, skin, FIT
from fit.foot_geom import TriMesh, VoxelField, crop_box, submesh, Sim4
from catalog import HRA_EXCLUDE
import re


def hra_bone(sex, kind, side):
    """The HRA tibia / fibula / femur / patella of the person's `side` ('l' = +x), chosen by centroid position."""
    s = source(f'hra-{sex}')
    cands = [o for o in s.select(rf'^VH_[MF]_{kind}_[LR]$') if not re.search(HRA_EXCLUDE, o['path'])]
    best = None
    for o in cands:
        v, f = s.load([o])
        x = v[:, 0].mean()
        if (x > 0) == (side == 'l'):
            best = (v, orient_outward(v, f), o['name'])
    if best is None: raise RuntimeError(f'{sex}: no HRA {kind} on side {side}')
    return best


def distal(mesh, h):
    v, f = mesh
    y0 = v[:, 1].min()
    return crop_box(mesh, np.array([-9, -9, -9.0]), np.array([9, y0 + h, 9]))


def mortise_map(za_foot, tib, fib, cache=None):
    """Similarity seating the Z-Anatomy distal tibia + fibula (last 7-8 cm) on the HRA ones (trimmed ICP)."""
    if cache and os.path.exists(cache):
        d = json.load(open(cache)); return Sim(d['s'], np.array(d['R']), np.array(d['t'])), d['rms']
    H = merge([distal(tib, 0.07), distal(fib, 0.08)])
    Z = merge([distal(za_foot.tibia, 0.07), distal(za_foot.fibula, 0.08)])
    Hd = dense_points(*H, 0.0008); Zp = sample_surface(*Z, 8000, seed=11)
    best = None
    for s0 in (0.95, 1.05, 1.15, 1.25):
        Ti = Sim(s0, np.eye(3), Hd.mean(0) - s0 * Zp.mean(0))
        T, err = icp(Zp, Hd, init=Ti, iters=120, scale=True, trim=0.92, scale_range=(0.8, 1.35))
        if best is None or err < best[1]: best = (T, err)
    T, err = best
    if cache:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        json.dump(dict(s=T.s, R=T.R.tolist(), t=T.t.tolist(), rms=err), open(cache, 'w'))
    return T, err


class Target:
    """HRA side of the fit for one foot."""

    def __init__(self, sex, side, za_foot, out_dir, log=print):
        self.sex, self.side = sex, side
        self.sg = 1.0 if side == 'l' else -1.0
        tv, tf, tname = hra_bone(sex, 'tibia', side); fv, ff, fname = hra_bone(sex, 'fibula', side)
        self.tibia, self.fibula, self.names = (tv, tf), (fv, ff), dict(tibia=tname, fibula=fname)
        self.T_m, self.T_m_rms = mortise_map(za_foot, self.tibia, self.fibula, cache=os.path.join(out_dir, f'mortise-{side}.json'))
        self.M = Sim4.from_sim(self.T_m)
        log(f'  {sex}/{side}: HRA {tname} + {fname}; mortise similarity {self.T_m} (ICP rms {self.T_m_rms * 1000:.2f} mm)')
        # skin of the foot: faces on this side below mid-shank
        v, f = skin(sex)
        y_ank = tv[:, 1].min()
        self.y_ankle = y_ank
        keep = (np.sign(v[f].mean(1)[:, 0]) == self.sg) & (v[f].max(1)[:, 1] < y_ank + 0.16)
        self.skin = compact(v, f[keep])
        self.skin_tm = TriMesh(*self.skin)
        sv = self.skin[0]
        lo = sv.min(0) - 0.01; hi = sv.max(0) + 0.01; hi[1] = y_ank + 0.14
        self.skin_field = VoxelField([self.skin], lo, hi, 0.001)
        # mortise: exact meshes and a fine field of the distal tibia and fibula
        self.tib_tm, self.fib_tm = TriMesh(*self.tibia), TriMesh(*self.fibula)
        lv = np.concatenate([distal(self.tibia, 0.09)[0], distal(self.fibula, 0.1)[0]])
        lo = lv.min(0) - 0.012; hi = lv.max(0) + 0.012; hi[1] = min(hi[1], y_ank + 0.07)
        self.leg_field = VoxelField([self.tibia, self.fibula], lo, hi, 0.0005)

    def skin_sd(self, p):
        return self.skin_field(p)

    def facets_from_za(self, za_foot, d=0.0055):
        """HRA mortise facets: the Z-Anatomy tibia / fibula surface within d of its own talus and facing it (plafond,
        medial malleolar facet, lateral malleolar facet), carried by the mortise similarity and projected onto the HRA
        tibia / fibula (points that land more than 4 mm away are dropped)."""
        F = za_foot
        tal = TriMesh(*F.bones['Talus'])
        out = {}
        for name, mesh, hm in (('tibia', F.tibia, self.tib_tm), ('fibula', F.fibula, self.fib_tm)):
            P = dense_points(*distal(mesh, 0.06), 0.0005)
            q, dd, _, _ = tal.closest(P)
            n = TriMesh(*mesh).closest(P)[3]
            sel = (dd < d) & (np.einsum('ij,ij->i', n, q - P) > 0)
            P, n = P[sel], n[sel]
            if name == 'tibia':
                groups = dict(plafond=n @ (-F.up) > 0.5, medial=(n @ F.lat > 0.5) & ~(n @ (-F.up) > 0.5))
            else:
                groups = dict(lateral=n @ F.med > 0.3)
            for g, m in groups.items():
                X = self.M(P[m])
                qq, dh, _, _ = hm.closest(X)
                out[g] = qq[dh < 0.004]
        return out

    def articular(self, talus_pts, talus_normals_fn, d=0.0065):
        """HRA articular surfaces facing a placed talus: points of the tibia / fibula within d of it, split into the
        plafond, the medial malleolar facet and the lateral malleolar facet by the direction they face."""
        out = {}
        tree = cKDTree(talus_pts)
        for name, mesh, tm in (('tibia', self.tibia, self.tib_tm), ('fibula', self.fibula, self.fib_tm)):
            P = dense_points(*distal(mesh, 0.06), 0.0006)
            dd, j = tree.query(P)
            n = tm.closest(P)[3]
            toward = np.einsum('ij,ij->i', n, talus_pts[j] - P) > 0
            sel = (dd < d) & toward
            out[name] = (P[sel], n[sel])
        return out
