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
distance from them). Between candidate refreshes a vertex is queried again once it has moved as far as its last
clearance allowed (a neighbour the spread carries into a bone is seen at once). After the vertex iterations, PROBE_ITERS
iterations also probe the inside of the faces near a bone (centroid and edge midpoints): a bone edge can poke through a
4 mm face whose vertices are all clear, and the report measures surface samples.
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
PROBE_ITERS = 30      # iterations with face probes after the vertex iterations
PROBE_CAP = 0.0015    # largest move per probe iteration (m)
FREE_R = 0.004        # while probing, an asking vertex is pushed toward the free part of its tube within this radius
PROBE_NEAR = 0.0012   # faces with a vertex this close to a bone are probed (the vertex iterations leave contacts at CLEAR)
# barycentric weights of the probes inside each face: centroid and edge midpoints (the measured penetration is on surface
# samples, and a bone edge can poke through a 4 mm face whose vertices are all clear)
PROBES = np.array([[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0.0], [0.0, 0.5, 0.5], [0.5, 0.0, 0.5]])
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
    # pelvic organs the iliac vessels pass: the ureters and ovaries where HRA gives them as closed surfaces (the uterine
    # tubes and the bowel are open double-walled patches, whose lumen ray parity cannot tell from the outside)
    from lib.mesh import is_closed
    for p in ('ureters', 'reproductive'):
        for o in parts.get(p, []):
            if o.get('source', 'HRA') != 'HRA' or o['name'] not in S.by_name or not re.search(r'(ureter|ovary)$', o['name']): continue
            m = S.get(o['name'])
            if is_closed(m[1]): out.append((f'{p}/{o["name"]}', m))
    # the lung lobes are solids rebuilt by assemble.py (their HRA entries are surface patches): taken as assembled
    from fit.vessels_review import lung_meshes
    out = [m for m in out if not m[0].startswith('lung_')] + lung_meshes(sex)
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
    OCAND = 0.012         # organ candidates (deeper penetrations of the lungs / aorta are cleared before: vessels_review.clear_obstacle)

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
            d, _ = self.otree.query(X, distance_upper_bound=self.OCAND); co = np.flatnonzero(np.isfinite(d))
        else: co = np.zeros(0, int)
        return cb, cs, co

    def run(self, X, groups, pin, log=print, iters=ITERS, skin_mask=None, faces=None, probe_iters=PROBE_ITERS, extra=()):
        """X (n, 3) vessel vertices, groups (n,) system id, pin (n,) in [0, 1]. Returns the moved X and a log.
        With `faces` (m, 3) (vertex indices into X), `probe_iters` more iterations follow in which points inside the
        faces near a bone are probed too (see PROBES)."""
        X = X.copy(); hist = []
        skin_mask = np.ones(len(X), bool) if skin_mask is None else skin_mask
        last = np.full(len(X), np.inf); lasto = np.full(len(X), np.inf)
        # movement since each vertex's last exact query (bones, organs) and since the last candidate refresh: a vertex is
        # queried again as soon as it may have come within reach, so a neighbour that the spread carries into a bone is
        # seen in the next iteration (not only at the next refresh)
        moved = np.zeros(len(X)); movedo = np.zeros(len(X)); moved_ref = np.zeros(len(X))
        Fs = None; probe_from = iters; it = -1
        while True:
            it += 1
            if it >= probe_from + (probe_iters if faces is not None else 0): break
            probing = it >= probe_from
            if it == probe_from:
                # face probes: refresh every candidate's distance, then probe the faces with a vertex within PROBE_NEAR
                cb, cs, co = self.candidates(X); moved_ref[:] = 0
                sd, _, _ = self.bones.query(X[cb]); last[cb] = sd; moved[cb] = 0
                nearv = np.zeros(len(X), bool); nearv[cb[sd < PROBE_NEAR]] = True
                Fs = faces[nearv[faces].any(1)]
                lastp = np.full(len(Fs) * len(PROBES), -np.inf); movedp = np.zeros(len(lastp))
                log(f'  push-out face probes: {len(Fs)} faces near a bone, {len(Fs) * len(PROBES)} probes')
                q = cb[last[cb] < CLEAR + 0.004]; qo = co[lasto[co] - movedo[co] < ORGAN_CLEAR + 0.004]
            elif (it % self.REFRESH == 0 and not probing) or moved_ref.max() > 0.008:
                cb, cs, co = self.candidates(X); q = cb; qo = co; moved_ref[:] = 0
            else:
                q = cb[last[cb] - moved[cb] < CLEAR + 0.004]            # between refreshes, only the vertices that may be near a bone
                qo = co[lasto[co] - movedo[co] < ORGAN_CLEAR + 0.004]
            need_b = np.full(len(X), -1.0); dirn = np.zeros_like(X)
            if len(q):
                sd, dn, who = self.bones.query(X[q])
                last[q] = sd; moved[q] = 0
                need_b[q] = CLEAR - sd; dirn[q] = dn
            worst_probe = 0.0
            if probing and len(Fs):
                # a probe inside a face asks for the push of the whole face: each of its three vertices takes the largest
                # ask among its own and its faces' probes
                P = np.einsum('pk,fkd->fpd', PROBES, X[Fs]).reshape(-1, 3)
                qp = np.flatnonzero(lastp - movedp < CLEAR + 0.0015)
                if len(qp):
                    sdp, dnp, _ = self.bones.query(P[qp]); lastp[qp] = sdp; movedp[qp] = 0
                    needp = CLEAR - sdp; a = needp > 1e-5
                    worst_probe = float(max(0.0, needp.max() - CLEAR)) if len(needp) else 0.0
                    if a.any():
                        pa, nd, dd = qp[a], needp[a], dnp[a]
                        fi = pa // len(PROBES)
                        for k in range(3):
                            vid = Fs[fi, k]
                            best = need_b.copy(); np.maximum.at(best, vid, nd)
                            win = nd >= best[vid] - 1e-12
                            upd = vid[win]
                            need_b[upd] = nd[win]; dirn[upd] = dd[win]
            act_b = need_b > 1e-5
            if probing and act_b.any():
                # a tube whose axis runs inside a thin bony wall (a sinus wall, the groove of a rib) asks to move both
                # ways (each vertex toward its own nearest surface) and stalls: each asking vertex is pushed instead
                # toward the free (clear) part of its own tube cross-section, so the section moves out to one side
                A = np.flatnonzero(act_b)
                clear = (last - moved) > CLEAR
                tX = cKDTree(X)
                for a, nb in zip(A, tX.query_ball_point(X[A], FREE_R)):
                    nb = np.asarray(nb); nb = nb[(groups[nb] == groups[a]) & clear[nb]]
                    if len(nb) < 3: continue
                    u = X[nb].mean(0) - X[a]; L_ = np.linalg.norm(u)
                    if L_ < 0.0008: continue
                    u /= L_
                    if u @ dirn[a] < -0.2: dirn[a] = u          # only where its own nearest surface points across the tube
            need_o = np.full(len(X), -1.0); dirno = np.zeros_like(X)
            if len(qo):
                sd, dn, who = self.organs.query(X[qo])
                lasto[qo] = sd; movedo[qo] = 0
                need_o[qo] = ORGAN_CLEAR - sd; dirno[qo] = dn
            for ob, mask, clr in extra:
                # extra obstacles for a subset of the vertices (the HRA aorta for the veins): asked like an organ
                qe = np.flatnonzero(mask & (np.all((X >= ob.lo) & (X <= ob.hi), axis=1)))
                if not len(qe): continue
                sd, dn, _ = ob.query(X[qe]); ne = clr - sd
                better = ne > need_o[qe]
                need_o[qe[better]] = ne[better]; dirno[qe[better]] = dn[better]
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
                             candidates=[int(len(cb)), int(len(cs)), int(len(co))],
                             **(dict(phase='face probes', worst_probe_mm=round(worst_probe * 1000, 2)) if probing else {})))
            if not len(src):
                if probing or faces is None: break
                probe_from = it + 1                         # converged on the vertices: go on to the face probes
                continue
            fld = spread(X, src, vec[src], groups) * pin[:, None]
            # never move more than 2 mm per iteration (1 mm while probing faces)
            cap = PROBE_CAP if probing else 0.002
            L = np.linalg.norm(fld, axis=1); big = L > cap
            fld[big] *= (cap / L[big])[:, None]
            X += fld
            step = np.minimum(L, cap); moved += step; movedo += step; moved_ref += step
            if Fs is not None and len(Fs): movedp += np.repeat(step[Fs].max(1), len(PROBES))
        log(f'  push-out: {len(hist)} iterations, first {hist[0]}, last {hist[-1]}')
        return X, hist
