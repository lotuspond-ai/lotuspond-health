"""Bones of both feet (tarsals, metatarsals, phalanges, sesamoids; Z-Anatomy za-skeletal) placed in each HRA body.
Part: skel_feet. Usage: python3 fit/foot.py [male|female|all]  (writes .cache/fit/<sex>/foot/).

Method (per sex and foot; everything is measured, nothing is placed by eye):
  1. Ankle mortise. The Z-Anatomy distal tibia and fibula are seated on the HRA ones by trimmed similarity ICP (the HRA
     leg bones are picked by position, never by name). The Z-Anatomy foot keeps its own articulations and is moved as
     an articulated skeleton (fit/foot_model.py): talocrural rotation about the axis of revolution of the trochlea,
     subtalar rotation about Inman's axis, a small ball-joint (Chopart) correction at the talar head, toe joints, a foot
     scale and a separately constrained talus scale.
  2. Skin. The Z-Anatomy foot skin (outer layer of the za-regions foot/ankle regions, skinned to the bones) is fitted to
     the HRA skin of the foot (signed distances), while every bone is kept inside the skin with clearance and the talus
     is kept in the HRA mortise with a uniform joint space (gap to the HRA plafond and malleolar facets ~2.5 mm).
  3. Toes. Each toe's MTP (flexion, abduction) and IP joints are fitted to the HRA skin of the forefoot.
  4. Refinement. Remaining bone-bone overlaps (several already present in Z-Anatomy, e.g. 1st metatarsal / medial
     cuneiform 2.6 mm) and contacts with the HRA tibia/fibula are pushed apart with a smooth, local surface displacement
     (Laplacian-smoothed, so the bones keep their shape away from the joint surfaces).
  5. Measurements (report.json) and QA renders (qa-*.png).

For the vessels group:
  leg_deform(sex, side) -> LegDeform, a callable mapping Z-Anatomy points of that leg (thigh to toes, side 'l' = the
  person's left = +x) into the body:  q = leg_deform('male', 'l')(p)  with p, q (n, 3) metres.
    * thigh, knee and leg: the leg warp (thin-plate spline fitted to femur, patella, tibia and fibula; fit.common.build_warp
      with the catalog's leg anchors), cached in .cache/fit/<sex>/foot/warp-leg_<side>.npz;
    * ankle and foot: the fitted per-bone similarity maps of the foot skeleton, blended by distance to the bones
      (the same linear-blend weights that carry the foot skin), so soft tissue follows the nearest bones and joins the
      leg warp smoothly across the ankle.
  LegDeform.hip_weight(p) -> (n,) in [0, 1]: blending weight across the hip, 1 = use this leg's map, 0 = use the trunk
  warp (fit.common.get_warp(sex, 'trunk')). It is a smoothstep of the distance below the hip joint centre along the
  Z-Anatomy femoral shaft axis: 0 at 2 cm above the femoral head centre, 1 at 10 cm below it. Blend as
      w = L.hip_weight(p)[:, None];  q = w * L(p) + (1 - w) * trunk_warp(p)
  LegDeform.foot_weight(p) gives the share of the foot maps (0 in the thigh and leg, 1 in the foot) for diagnostics.
  The fitted poses are read from .cache/fit/<sex>/foot/pose-<side>.json; if missing, the fit for that sex is run.
"""
import os, sys, json, time
import numpy as np
from scipy import optimize
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, merge, sample_surface, dense_points, orient_outward  # noqa: E402
from lib.register import Sim, Warp  # noqa: E402
from fit.common import build_warp, write_group, FIT, skin  # noqa: E402
from fit.foot_geom import TriMesh, VoxelField, Sim4, rotvec, smoothstep  # noqa: E402
from fit.foot_model import ZAFoot, toe_bones, METATARSALS, BASES  # noqa: E402
from fit.foot_target import Target, hra_bone  # noqa: E402

GROUP = 'foot'
DEG = np.pi / 180
GAP0 = 0.0025          # target joint space talus <-> HRA plafond / malleoli (m)
CLEAR = 0.0025         # minimum soft tissue over bone kept by the fit (m)


def phuber(r, d):
    return d * d * (np.sqrt(1 + (r / d) ** 2) - 1)


def relu(x):
    return np.maximum(x, 0)


# ------------------------------------------------------------------------------------------------ articulated fit
# parameter vector: 13 foot parameters, then the toe joints (hallux: MTP flexion, MTP abduction, IP; toes 2-5: MTP
# flexion, MTP abduction, PIP, DIP). Angles in radians, scales as logarithms, the talus offset in cm.
GLOBAL = ['alpha', 'beta', 'c_inv', 'c_add', 'c_pf', 'ln_sf', 'ln_st', 'r_inv', 'r_add', 'r_pf', 'tx', 'ty', 'tz']
TOE_SLOTS = [(1, 3)] + [(k, 4) for k in range(2, 6)]
NG = len(GLOBAL)
NX = NG + sum(n for _, n in TOE_SLOTS)
HEEL_PAD = (0.011, 0.020)     # aimed heel pad (criterion 8-25 mm)
FORE_PAD = (0.0085, 0.0125)   # aimed forefoot pad under each metatarsal head (criterion 6-15 mm)


def unpack(x):
    x = np.asarray(x, float)
    q = dict(alpha=x[0], beta=x[1], chopart=x[2:5], sf=float(np.exp(x[5])), st=float(np.exp(x[6])), talus_r=x[7:10], talus_t=x[10:13] * 0.01)
    toes, i = {}, NG
    for k, n in TOE_SLOTS:
        a = list(x[i:i + n]); i += n
        toes[k] = a if n == 4 else a + [0.0]
    q['toes'] = toes
    return q


def toe_index(k):
    i = NG
    for kk, n in TOE_SLOTS:
        if kk == k: return list(range(i, i + n))
        i += n


class FootFit:
    def __init__(self, sex, side, out_dir, log=print):
        self.sex, self.side, self.out_dir, self.log = sex, side, out_dir, log
        self.F = ZAFoot(side, n_skin=4000)
        self.tg = Target(sex, side, self.F, out_dir, log)
        self.M = self.tg.M
        F = self.F
        rng = np.random.default_rng(3)
        self.bone_pts = {}
        for b, m in F.bones.items():
            n = int(np.clip(len(m[0]) * 0.6, 80, 400))
            self.bone_pts[b] = sample_surface(*m, n, seed=int(rng.integers(1 << 30)))
        self.toe_bone = {b for k in range(1, 6) for b in toe_bones(k)}
        tv = F.bones['Talus'][0]
        self.talus_field = VoxelField([F.bones['Talus']], tv.min(0) - 0.008, tv.max(0) + 0.008, 0.0004)
        # skin points grouped by bone for fast blending; which skin points belong to the toes
        names, W = F.skin_w
        self.skin_groups = []
        toe_w = np.zeros(len(F.skin_pts))
        for i, b in enumerate(names):
            idx = np.flatnonzero(W[:, i] > 0)
            if len(idx): self.skin_groups.append((b, idx, W[idx, i:i + 1]))
            if b in self.toe_bone: toe_w += W[:, i]
        self.skin_toe = toe_w > 0.5
        # the HRA toes are fused (one 'mitten' with at most a shallow groove after the hallux), so the Z-Anatomy skin
        # between the toes has no counterpart there: keep only toe skin facing out of the toe row (dorsal, plantar,
        # distal, the medial side of the hallux and the lateral side of the fifth toe)
        n = F.skin_n; toe_of = np.zeros(len(F.skin_pts), int)
        for i, b in enumerate(names):
            for k in range(1, 6):
                if b in toe_bones(k): toe_of[W[:, i] > 0.5] = k
        out_ok = (np.abs(n @ F.up) > 0.5) | (n @ F.axis > 0.5) | ((toe_of == 1) & (n @ F.med > 0.5)) | ((toe_of == 5) & (n @ F.lat > 0.5))
        self.skin_use = ~self.skin_toe | out_ok
        self.articular = self.tg.facets_from_za(self.F)
        self.articular_all = np.concatenate(list(self.articular.values()))
        log(f'    mortise facets (HRA points): ' + ', '.join(f'{k} {len(v)}' for k, v in self.articular.items()))
        # pad probes: the most plantar points (rest pose) of the calcaneus and of each metatarsal head (+ sesamoids)
        down = -F.up
        cal = dense_points(*F.bones['Calcaneus'], 0.001)
        self.heel_probe = cal[np.argsort(-(cal @ down))[:60]]
        self.fore_probe = []
        for k, mt in enumerate(METATARSALS, 1):
            v = dense_points(*F.bones[mt], 0.001)
            u = v @ F.axis; head = v[u > u.max() - 0.012]
            pts = head[np.argsort(-(head @ down))[:40]]
            bones = [mt]
            if k == 1:
                ses = dense_points(*F.bones['Sesamoid_bones_of_foot'], 0.0008)
                pts = np.concatenate([pts, ses[np.argsort(-(ses @ down))[:40]]]); bones.append('Sesamoid_bones_of_foot')
            self.fore_probe.append((bones, pts))
        # phalanx capsules (rest pose) for toe-toe separation
        self.capsules = {}
        for k, t in F.toes.items():
            ends = [j.c for j in t['joints']] + [t['tip']]
            for i, b in enumerate(t['bones']):
                a, c = ends[i], ends[i + 1]
                v = F.bones[b][0]
                r = np.median(_seg_dist(v, a, c))
                self.capsules[b] = (a, c, r, k, i)

    # ---------------------------------------------------------------------------------------- helpers
    def world_maps(self, q):
        maps = self.F.pose(q)
        return {b: m.then(self.M) for b, m in maps.items()}

    def skin_world(self, W):
        out = np.zeros_like(self.F.skin_pts)
        P = self.F.skin_pts
        for b, idx, w in self.skin_groups:
            M = self.M if b == 'leg' else W[b]
            out[idx] += w * M(P[idx])
        return out

    def talus_gap(self, W, A):
        Wt = W['Talus']; s = Wt.scale()
        return s * self.talus_field(Wt.inverse()(A))

    def pads(self, W):
        """(heel pad, [forefoot pads]) in m by ray casts along the posed plantar directions."""
        tg = self.tg
        dh = W['Calcaneus'].vec(-self.F.up); dh /= np.linalg.norm(dh)
        ph = W['Calcaneus'](self.heel_probe); o = ph[np.argmax(ph @ dh)]
        df = W['Second_metatarsal_bone'].vec(-self.F.up); df /= np.linalg.norm(df)
        origins = [o]
        for bones, pts in self.fore_probe:
            P = np.concatenate([W[b](pts) for b in bones[:1]] + ([W[bones[1]](pts[40:])] if len(bones) > 1 else []))
            if len(bones) > 1: P = np.concatenate([W[bones[0]](pts[:40]), W[bones[1]](pts[40:])])
            origins.append(P[np.argmax(P @ df)])
        O = np.array(origins); D = np.array([dh] + [df] * 5)
        d = tg.skin_tm.ray(O, D, tmax=0.06)
        return d[0], d[1:]

    def toe_overlap(self, W):
        """Penalty for phalanges of neighbouring toes closer than their radii + 0.6 mm (capsule model)."""
        caps = {b: (W[b](a[None])[0], W[b](c[None])[0], r * W[b].scale(), k, i) for b, (a, c, r, k, i) in self.capsules.items()}
        e = 0.0
        for b1, (a1, c1, r1, k1, i1) in caps.items():
            for b2, (a2, c2, r2, k2, i2) in caps.items():
                if k2 != k1 + 1 or abs(i1 - i2) > 1: continue
                d = _seg_seg(a1, c1, a2, c2)
                e += relu(r1 + r2 + 0.0006 - d) ** 2
        return e / 0.001 ** 2

    # ---------------------------------------------------------------------------------------- energy
    def energy(self, x, parts=False, skip_toes=False):
        q = unpack(x)
        W = self.world_maps(q)
        tg = self.tg
        # 1. the Z-Anatomy foot skin on the HRA skin
        S = self.skin_world(W)
        sd = tg.skin_sd(S)
        sd = sd[~self.skin_toe] if skip_toes else sd[self.skin_use]
        e_skin = np.mean(phuber(sd, 0.003)) / 0.003 ** 2
        # 2. bones inside the skin with clearance; 3. bones clear of the HRA tibia / fibula
        Q = np.concatenate([W[b](p) for b, p in self.bone_pts.items() if not (skip_toes and b in self.toe_bone)])
        e_in = np.mean(relu(tg.skin_sd(Q) + CLEAR) ** 2) / 0.001 ** 2
        notal = np.concatenate([W[b](p) for b, p in self.bone_pts.items() if b != 'Talus' and b not in self.toe_bone])
        e_leg = np.mean(relu(0.001 - tg.leg_field(notal)) ** 2) / 0.001 ** 2
        e_tl = np.mean(relu(0.001 - tg.leg_field(W['Talus'](self.bone_pts['Talus']))) ** 2) / 0.001 ** 2
        # 4. joint space in the mortise: facet points at GAP0 from the talus, never closer than 1.2 mm. The talus is
        #    seated on the tibia (plafond, medial malleolus); the fibular facet counts half (see the module notes)
        e_m = 0.0
        for k, wk in (('plafond', 1.0), ('medial', 1.0), ('lateral', 0.5)):
            g = self.talus_gap(W, self.articular[k])
            e_m += wk * (np.mean(phuber(g - GAP0, 0.001)) / 0.001 ** 2 + 30 * np.mean(relu(0.0012 - g) ** 2) / 0.001 ** 2)
        # 5. pads under the heel and the metatarsal heads
        hp, fp = self.pads(W)
        hp = 0.03 if not np.isfinite(hp) else hp
        fp = np.where(np.isfinite(fp), fp, 0.03)
        e_pad = (relu(HEEL_PAD[0] - hp) ** 2 + relu(hp - HEEL_PAD[1]) ** 2 + np.sum(relu(FORE_PAD[0] - fp) ** 2 + relu(fp - FORE_PAD[1]) ** 2)) / 0.001 ** 2
        # 6. neighbouring toes apart
        e_toe = 0.0 if skip_toes else self.toe_overlap(W)
        # 7. priors (degrees of freedom stay anatomical)
        r = (x[0] / (45 * DEG)) ** 2 + (x[1] / (20 * DEG)) ** 2
        r += (x[2] / (4 * DEG)) ** 2 + (x[3] / (4 * DEG)) ** 2 + (x[4] / (10 * DEG)) ** 2
        r += (x[5] / 0.06) ** 2 + ((x[6] - x[5]) / 0.025) ** 2
        r += np.sum((x[7:10] / (4 * DEG)) ** 2) + np.sum((x[10:13] / 0.4) ** 2)
        for k, n in TOE_SLOTS:
            i = toe_index(k)
            r += (x[i[0]] / (25 * DEG)) ** 2 + (x[i[1]] / (10 * DEG)) ** 2 + np.sum((x[i[2:]] / (25 * DEG)) ** 2)
        terms = dict(skin=1.0 * e_skin, inside=4.0 * e_in, leg=2.0 * e_leg + 5.0 * e_tl, mortise=1.5 * e_m, pads=0.5 * e_pad, toes=0.5 * e_toe, prior=0.3 * r)
        return terms if parts else sum(terms.values())

    def _opt(self, x, idx, method='L-BFGS-B', skip_toes=False, maxiter=300):
        idx = np.asarray(idx)
        def f(y):
            z = x.copy(); z[idx] = y
            return self.energy(z, skip_toes=skip_toes)
        opts = dict(maxiter=maxiter, eps=2e-4) if method == 'L-BFGS-B' else dict(maxiter=maxiter, xtol=1e-3, ftol=1e-6)
        r = optimize.minimize(f, x[idx], method=method, options=opts)
        z = x.copy(); z[idx] = r.x
        return z, r.nfev

    def fit(self):
        t0 = time.time()
        x0 = np.zeros(NX)
        # A. coarse search over the large joint motions and the foot size (skin of the foot without the toes)
        best = (np.inf, x0)
        for a in np.arange(-10, 41, 10):
            for b in np.arange(-10, 36, 9):
                for ad in (-8, 0, 8, 16):
                    for lsf in (-0.08, -0.04, 0.0, 0.04, 0.08):
                        x = x0.copy(); x[0] = a * DEG; x[1] = b * DEG; x[3] = ad * DEG; x[5] = lsf; x[6] = lsf
                        e = self.energy(x, skip_toes=True)
                        if e < best[0]: best = (e, x)
        x = best[1]
        self.log(f'    grid: alpha {np.degrees(x[0]):.0f} beta {np.degrees(x[1]):.0f} add {np.degrees(x[3]):.0f} sf {np.exp(x[5]):.3f} ({time.time() - t0:.1f}s)')
        x, n1 = self._opt(x, range(NG), skip_toes=True)
        # B. toes on their own, then C. everything together
        x, n2 = self._opt(x, range(NG, NX))
        x, n3 = self._opt(x, range(NX), maxiter=400)
        P = self.energy(x, parts=True)
        self.log('    fit: ' + ' '.join(f'{k} {v:.3f}' for k, v in P.items()) + f'  ({time.time() - t0:.1f}s, {n1}+{n2}+{n3} evals)')
        self.x = x
        return x


def _seg_dist(p, a, c):
    d = c - a; t = np.clip((p - a) @ d / (d @ d), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * d), axis=1)


def _seg_seg(p1, q1, p2, q2):
    """Smallest distance between segments p1q1 and p2q2 (sampled; exact enough for the toe capsules)."""
    t = np.linspace(0, 1, 9)
    A = p1 + t[:, None] * (q1 - p1)
    return float(_seg_dist(A, p2, q2).min())


# ------------------------------------------------------------------------------------------------ driver
def fit(sex):
    out_dir = os.path.join(FIT, sex, GROUP); os.makedirs(out_dir, exist_ok=True)
    res = {}
    for side in 'lr':
        ff = FootFit(sex, side, out_dir)
        x = ff.fit()
        q = unpack(x)
        print(sex, side, 'alpha %.1f beta %.1f chopart %s sf %.3f st %.3f talus_r %s talus_t(mm) %s' % (
            np.degrees(q['alpha']), np.degrees(q['beta']), np.round(np.degrees(q['chopart']), 1), q['sf'], q['st'], np.round(np.degrees(q['talus_r']), 1), np.round(q['talus_t'] * 1000, 1)))
        res[side] = ff
    return res


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    for sex in (['male', 'female'] if which == 'all' else [which]):
        fit(sex)
