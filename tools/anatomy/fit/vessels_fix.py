"""Collision push-out for the vessels group: every placed vessel out of every bone and the solid organs and inside the
skin, with a smooth displacement that moves each tube as a whole (no denting), kept away from the junction rings.

Bones: the HRA skeleton (vertebrae, sacrum, coccyx, hip bones, femora, patellae, tibiae, fibulae, the male hyoid) and
the bones the other groups placed (arms: shoulder girdle, arm and hand bones; skull: skull bones and the female hyoid;
foot: foot bones; ribcage: ribs, sternum, costal cartilages, intervertebral discs). Distances are exact (closest point
on the triangles), inside/outside by ray parity (fit/vessels_geom.TriSet).

Each iteration: every vessel vertex closer than CLEAR to a bone (or inside it) asks for a push along the outward
direction by the missing clearance; every vertex less than SKIN_DEPTH under the skin asks for a pull inward. The asks are
spread with a Gaussian (SIGMA) over the vertices of the same group (vessels joined in Z-Anatomy), averaged with weights
Gaussian x ask so the largest ask nearby dominates, and scaled by the nearest ask's kernel value, so a vertex that asks
gets its full push and its neighbours, across the tube and along it, nearly the same: the tube is translated locally,
with a smooth falloff. The field is multiplied by the pin weight (0 at the junction rings, 1 beyond PIN of geodesic
distance from them).
"""
import os, sys, json, re
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, load  # noqa: E402
from fit.common import FIT, skin, skin_solid  # noqa: E402
from fit import vessels_geom as G  # noqa: E402
from catalog import HRA_EXCLUDE  # noqa: E402

CLEAR = 0.0008        # vessel surface kept this far from bone (m)
SKIN_DEPTH = 0.0015   # vessel surface kept this far under the skin (m)
SIGMA = 0.006         # spread of a push over the vessel (m)
PIN = 0.015           # push-out fades in over this geodesic distance from a junction ring (m)
ITERS = 40
BONE_SKIP = r'(ligament|enthesis|cartilage|meniscus|point|perichond|condyle|fossa|surface|groove|spongy)'
GROUP_BONES = (('arms', ('skel_arms', 'skel_hands')), ('skull', ('skel_skull',)), ('foot', ('skel_feet',)),
               ('ribcage', ('skel_thorax', 'costal_cartilage', 'discs')))


def bone_meshes(sex):
    """[(name, (v, f))] of every bone in the body (HRA and placed)."""
    S = source(f'hra-{sex}')
    out = []
    for o in S.index:
        if '_skeletal_system' not in o['path']: continue
        if re.search(BONE_SKIP, o['name']) or re.search(HRA_EXCLUDE, o['path']): continue
        out.append((o['name'], S.load_entry(o)))
    for g, parts in GROUP_BONES:
        man = os.path.join(FIT, sex, g, 'manifest.json')
        if not os.path.exists(man): continue
        for o in json.load(open(man)):
            if o['part'] in parts: out.append((f'{g}/{o["name"]}', load(os.path.join(FIT, sex, g, o['file']))))
    return out


ORGAN_CLEAR = 0.0003  # vessel surface kept this far from the organs below (m)
ORGAN_PARTS = ('lung_r_upper', 'lung_r_middle', 'lung_r_lower', 'lung_l_upper', 'lung_l_lower', 'heart', 'airway', 'bronchi', 'liver', 'spleen',
               'kidneys', 'bladder', 'thymus')
ORGAN_GROUP = ('esophagus', 'stomach', 'thyroid')   # placed by the organs group (not the diaphragm: vessels cross it at its hiatuses)


def organ_meshes(sex):
    """[(name, (v, f))] of the solid organs vessels must stay out of: HRA parts ORGAN_PARTS (.cache/parts/<sex>/
    structures.json) and the organs group's ORGAN_GROUP outputs. Not the brain (the cerebral arteries lie on its parcels'
    surfaces, in the cisterns and sulci), the intestines or the diaphragm."""
    S = source(f'hra-{sex}')
    parts = json.load(open(os.path.join(FIT, '..', 'parts', sex, 'structures.json')))
    out = []
    for p in ORGAN_PARTS:
        for o in parts.get(p, []):
            if o.get('source', 'HRA') != 'HRA' or o['name'] not in S.by_name: continue
            out.append((f'{p}/{o["name"]}', S.get(o['name'])))
    man = os.path.join(FIT, sex, 'organs', 'manifest.json')
    if os.path.exists(man):
        for o in json.load(open(man)):
            if o['part'] in ORGAN_GROUP: out.append((f'organs/{o["name"]}', load(os.path.join(FIT, sex, 'organs', o['file']))))
    return out


def near_obstacles(meshes, pts, pad=0.02):
    """The meshes whose bounding box (padded) contains any of the points."""
    tree = cKDTree(pts)
    keep = []
    for n, (v, f) in meshes:
        lo, hi = v.min(0) - pad, v.max(0) + pad
        c = (lo + hi) / 2; r = np.linalg.norm(hi - lo) / 2
        idx = tree.query_ball_point(c, r)
        if idx and np.any(np.all((pts[idx] >= lo) & (pts[idx] <= hi), axis=1)): keep.append((n, (v, f)))
    return keep


def spread(x, src, vec, groups, sigma=SIGMA):
    """field(i) = max_j K_ij * sum_j K_ij vec_j / sum_j K_ij over the asking vertices j of the same group."""
    out = np.zeros_like(x)
    if not len(src): return out
    ts = cKDTree(x[src]); tx = cKDTree(x)
    M = ts.sparse_distance_matrix(tx, 3 * sigma, output_type='coo_matrix')
    j, i, d = M.row, M.col, M.data
    # sparse_distance_matrix drops exact zeros: add the self pairs
    j = np.concatenate([j, np.arange(len(src))]); i = np.concatenate([i, src]); d = np.concatenate([d, np.zeros(len(src))])
    ok = groups[src[j]] == groups[i]
    j, i, d = j[ok], i[ok], d[ok]
    K = np.exp(-0.5 * (d / sigma) ** 2)
    # the asks are averaged with weights K * |ask|: the largest push nearby dominates, so a tube moves out as a whole
    # in one step instead of creeping out at the mean of its neighbours' smaller asks
    Wt = K * (np.linalg.norm(vec, axis=1)[j] + 1e-9)
    num = np.zeros_like(x); den = np.zeros(len(x)); kmax = np.zeros(len(x))
    np.add.at(num, i, Wt[:, None] * vec[j]); np.add.at(den, i, Wt); np.maximum.at(kmax, i, K)
    m = den > 0
    out[m] = kmax[m, None] * num[m] / den[m, None]
    return out


class Fixer:
    """Bones near the vessels (exact TriSets) and the skin field; run() pushes vessel vertices out (see the docstring).
    Only candidate vertices are queried exactly: those within CAND of a bone's dense surface samples or of the skin
    (coarse skin solid), refreshed every REFRESH iterations."""
    CAND, REFRESH = 0.016, 8

    def __init__(self, sex, pts, log=print):
        from lib.mesh import dense_points
        self.sex = sex
        allb = bone_meshes(sex)
        nb = near_obstacles(allb, pts)
        log(f'  bones: {len(allb)} in the body, {len(nb)} near the vessels')
        self.bones = G.Obstacles(nb)
        self.btree = cKDTree(np.concatenate([dense_points(v, f, 0.0025) for _, (v, f) in nb]))
        no = near_obstacles(organ_meshes(sex), pts)
        log(f'  organs near the vessels: {len(no)}')
        self.organs = G.Obstacles(no)
        self.otree = cKDTree(np.concatenate([dense_points(v, f, 0.003) for _, (v, f) in no])) if no else None
        sv, sf = skin(sex)
        self.skin_solid = skin_solid(sex)
        self.skin = G.SkinField(sv, sf, self.skin_solid)

    def candidates(self, X):
        d, _ = self.btree.query(X, distance_upper_bound=self.CAND)
        cb = np.flatnonzero(np.isfinite(d))
        cs = np.flatnonzero(self.skin_solid(X) > -self.CAND)
        if self.otree is not None:
            d, _ = self.otree.query(X, distance_upper_bound=0.012); co = np.flatnonzero(np.isfinite(d))
        else: co = np.zeros(0, int)
        return cb, cs, co

    def run(self, X, groups, pin, log=print, iters=ITERS, skin_mask=None):
        """X (n, 3) vessel vertices, groups (n,) system id, pin (n,) in [0, 1]. Returns the moved X and a log."""
        X = X.copy(); hist = []
        skin_mask = np.ones(len(X), bool) if skin_mask is None else skin_mask
        last = np.full(len(X), np.inf); lasto = np.full(len(X), np.inf)
        for it in range(iters):
            if it % self.REFRESH == 0:
                cb, cs, co = self.candidates(X); q = cb; qo = co
            else:
                q = cb[last[cb] < CLEAR + 0.004]            # between refreshes, only the vertices near a bone
                qo = co[lasto[co] < ORGAN_CLEAR + 0.004]
            need_b = np.full(len(X), -1.0); dirn = np.zeros_like(X)
            if len(q):
                sd, dn, who = self.bones.query(X[q])
                last[q] = sd
                need_b[q] = CLEAR - sd; dirn[q] = dn
            act_b = need_b > 1e-5
            need_o = np.full(len(X), -1.0); dirno = np.zeros_like(X)
            if len(qo):
                sd, dn, who = self.organs.query(X[qo])
                lasto[qo] = sd
                need_o[qo] = ORGAN_CLEAR - sd; dirno[qo] = dn
            act_o = (need_o > 1e-5) & ~act_b
            need_s = np.full(len(X), -1.0); gsk = np.zeros_like(X)
            if len(cs):
                sk, g = self.skin(X[cs])
                need_s[cs] = sk + SKIN_DEPTH; gsk[cs] = g
            act_s = (need_s > 1e-5) & skin_mask
            vec = np.zeros_like(X)
            vec[act_b] += dirn[act_b] * need_b[act_b, None]
            vec[act_o] += dirno[act_o] * need_o[act_o, None]
            vec[act_s] -= gsk[act_s] * need_s[act_s, None]
            src = np.flatnonzero(act_b | act_s | act_o)
            hist.append(dict(it=it, bone=int(act_b.sum()), organ=int(act_o.sum()), skin=int(act_s.sum()),
                             worst_bone_mm=round(float(max(0, need_b.max() - CLEAR) * 1000), 2),
                             worst_organ_mm=round(float(max(0, need_o.max() - ORGAN_CLEAR) * 1000), 2),
                             worst_skin_mm=round(float(max(0, (need_s[skin_mask].max() if skin_mask.any() else 0) - SKIN_DEPTH) * 1000), 2),
                             candidates=[int(len(cb)), int(len(cs)), int(len(co))]))
            if not len(src): break
            fld = spread(X, src, vec[src], groups) * pin[:, None]
            # never move more than 2 mm per iteration
            L = np.linalg.norm(fld, axis=1); big = L > 0.002
            fld[big] *= (0.002 / L[big])[:, None]
            X += fld
        log(f'  push-out: {len(hist)} iterations, first {hist[0]}, last {hist[-1]}')
        return X, hist
