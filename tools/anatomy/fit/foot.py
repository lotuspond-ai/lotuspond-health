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
from fit.foot_refine import Seat, push_out  # noqa: E402

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


def toe_prior(x):
    """MTP: flexion / extension free within ~25 deg, abduction ~10 deg; IP joints flex freely but barely extend
    (PIP / DIP extend at most a few degrees, the hallux IP somewhat more)."""
    r = 0.0
    for k, n in TOE_SLOTS:
        i = toe_index(k)
        r += (x[i[0]] / (25 * DEG)) ** 2 + (x[i[1]] / (10 * DEG)) ** 2
        for j in i[2:]:
            lim = (10 if k == 1 else 3) * DEG
            r += (x[j] / (30 * DEG)) ** 2 + (relu(-lim - x[j]) / (2 * DEG)) ** 2
    return r


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
        # 4. joint space in the mortise: facet points at GAP0 from the talus, never closer than 1.2 mm
        e_m = 0.0
        for k, wk in (('plafond', 1.0), ('medial', 1.0), ('lateral', 1.0)):
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
        r += toe_prior(x)
        terms = dict(skin=1.0 * e_skin, inside=4.0 * e_in, leg=2.0 * e_leg + 5.0 * e_tl, mortise=1.5 * e_m, pads=0.5 * e_pad, toes=0.5 * e_toe, prior=0.3 * r)
        return terms if parts else sum(terms.values())

    def energy_toes(self, x):
        """The terms that depend on the toe joints only (stage B): toe skin, toe bones inside, toes apart, toe priors."""
        q = unpack(x)
        W = self.world_maps(q)
        tg = self.tg
        if not hasattr(self, '_toe_groups'):
            sel = np.flatnonzero(self.skin_toe & self.skin_use)
            pos = -np.ones(len(self.F.skin_pts), int); pos[sel] = np.arange(len(sel))
            self._toe_groups = [(b, pos[idx[np.isin(idx, sel)]], w[np.isin(idx, sel)]) for b, idx, w in self.skin_groups]
            self._toe_groups = [(b, i, w) for b, i, w in self._toe_groups if len(i)]
            self._toe_sel = sel
        P = self.F.skin_pts[self._toe_sel]
        S = np.zeros_like(P)
        for b, i, w in self._toe_groups:
            S[i] += w * (self.M if b == 'leg' else W[b])(P[i])
        e_skin = np.mean(phuber(tg.skin_sd(S), 0.003)) / 0.003 ** 2 * len(P) / max(1, self.skin_use.sum())
        Q = np.concatenate([W[b](self.bone_pts[b]) for b in self.toe_bone])
        e_in = np.sum(relu(tg.skin_sd(Q) + CLEAR) ** 2) / 0.001 ** 2 / sum(len(p) for p in self.bone_pts.values())
        r = toe_prior(x)
        return e_skin + 4.0 * e_in + 0.5 * self.toe_overlap(W) + 0.3 * r

    def _opt(self, x, idx, fun=None, maxiter=300, skip_toes=False):
        idx = np.asarray(idx)
        fun = fun or (lambda z: self.energy(z, skip_toes=skip_toes))
        def f(y):
            z = x.copy(); z[idx] = y
            return fun(z)
        r = optimize.minimize(f, x[idx], method='L-BFGS-B', options=dict(maxiter=maxiter, eps=2e-4))
        z = x.copy(); z[idx] = r.x
        return z, r.nfev

    def fit(self):
        t0 = time.time()
        x0 = np.zeros(NX)
        # A. coarse search over the large joint motions and the foot size (skin of the foot without the toes)
        best = (np.inf, x0)
        for a in np.arange(-10, 41, 10):
            for b in np.arange(-10, 36, 9):
                for ad in (-6, 0, 6):
                    for lsf in (-0.08, -0.04, 0.0, 0.04, 0.08):
                        x = x0.copy(); x[0] = a * DEG; x[1] = b * DEG; x[3] = ad * DEG; x[5] = lsf; x[6] = lsf
                        e = self.energy(x, skip_toes=True)
                        if e < best[0]: best = (e, x)
        x = best[1]
        self.log(f'    grid: alpha {np.degrees(x[0]):.0f} beta {np.degrees(x[1]):.0f} add {np.degrees(x[3]):.0f} sf {np.exp(x[5]):.3f} ({time.time() - t0:.1f}s)')
        x, n1 = self._opt(x, range(NG), skip_toes=True, maxiter=200)
        # B. toes on their own (cheap terms), then C. everything together
        x, n2 = self._opt(x, range(NG, NX), fun=self.energy_toes, maxiter=200)
        x, n3 = self._opt(x, range(NX), maxiter=60)
        P = self.energy(x, parts=True)
        self.log('    fit: ' + ' '.join(f'{k} {v:.3f}' for k, v in P.items()) + f'  ({time.time() - t0:.1f}s, {n1}+{n2}+{n3} evals)')
        self.x = x
        return x

    # ---------------------------------------------------------------------------------------- step 4: seating
    def refine(self):
        t0 = time.time()
        F, tg = self.F, self.tg
        W = self.world_maps(unpack(self.x))
        seat = Seat(F.bones)
        self.seat = seat
        facet_w = {'plafond': 1.0, 'medial': 1.0, 'lateral': 1.0}
        tib_n = lambda P: _unit(tg.leg_field.gradient(P))   # noqa: E731
        skin_n = lambda P: _unit(tg.skin_field.gradient(P))  # noqa: E731
        def constraints(b, X, W):
            src, dsp, wts = [], [], []
            # inside the skin with clearance
            sd = tg.skin_sd(X); m = sd > -CLEAR
            if m.any():
                src.append(X[m]); dsp.append(-(sd[m] + CLEAR)[:, None] * skin_n(X[m])); wts.append(np.full(m.sum(), 2.0))
            # clear of the HRA tibia / fibula by 1 mm
            sl = tg.leg_field(X); m = sl < 0.001
            if m.any():
                src.append(X[m]); dsp.append((0.001 - sl[m])[:, None] * tib_n(X[m])); wts.append(np.full(m.sum(), 3.0))
            if b == 'Talus':
                Wt = W['Talus']; s = Wt.scale(); tm = seat.tm['Talus']
                for k, A in self.articular.items():
                    Y = Wt.inverse()(A)
                    q, d, _, n = tm.closest(Y)
                    sgn = np.sign(np.einsum('ij,ij->i', Y - q, n)); sgn[sgn == 0] = 1
                    g = s * sgn * d
                    nw = _unit(Wt.vec(n)); qw = Wt(q)
                    src.append(qw); dsp.append((g - GAP0)[:, None] * nw); wts.append(np.full(len(A), facet_w[k] * 2000.0 / len(A)))
            if not src: return None
            return np.concatenate(src), np.concatenate(dsp), np.concatenate(wts)
        W = seat.relax(W, constraints, iters=40, log=self.log)
        self.W = W
        meshes = {b: (W[b](m[0]), m[1]) for b, m in F.bones.items()}
        self.relaxed = meshes
        # remaining overlaps (Z-Anatomy's own) and small residual contacts: local push-out
        def extra(b, V):
            e = np.zeros_like(V)
            sd = tg.skin_sd(V); m = sd > -CLEAR * 0.8
            if m.any(): e[m] += -(sd[m] + CLEAR * 0.8)[:, None] * skin_n(V[m])
            sl = tg.leg_field(V); m = sl < 0.0008
            if m.any(): e[m] += (0.0008 - sl[m])[:, None] * tib_n(V[m])
            return e if e.any() else None
        self.meshes = push_out(meshes, extra=extra, log=self.log)
        disp = {b: float(np.linalg.norm(self.meshes[b][0] - meshes[b][0], axis=1).max() * 1000) for b in meshes}
        self.pushed_mm = {b: round(d, 2) for b, d in sorted(disp.items(), key=lambda kv: -kv[1]) if d > 0.05}
        self.log(f'    seating done ({time.time() - t0:.1f}s); largest local push-outs (mm): ' + ', '.join(f'{b} {d}' for b, d in list(self.pushed_mm.items())[:5]))
        return self.meshes


def _unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)


def _seg_dist(p, a, c):
    d = c - a; t = np.clip((p - a) @ d / (d @ d), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * d), axis=1)


def _seg_seg(p1, q1, p2, q2):
    """Smallest distance between segments p1q1 and p2q2 (sampled; exact enough for the toe capsules)."""
    t = np.linspace(0, 1, 9)
    A = p1 + t[:, None] * (q1 - p1)
    return float(_seg_dist(A, p2, q2).min())


# ------------------------------------------------------------------------------------------------ leg warp
def _prox(m, h):
    v, f = m; y1 = v[:, 1].max()
    from fit.foot_geom import crop_box
    return crop_box(m, np.array([-9, y1 - h, -9.]), np.array([9, 9, 9.]))


def _local_sim(Z, H, init=None, n=6000, seed=0):
    from lib.register import icp
    Hd = dense_points(*H, 0.001); Zp = sample_surface(*Z, n, seed=seed)
    best = None
    inits = [init] if init is not None else [Sim(s0, np.eye(3), Hd.mean(0) - s0 * Zp.mean(0)) for s0 in (0.95, 1.05, 1.15, 1.25)]
    for Ti in inits:
        T, err = icp(Zp, Hd, init=Ti, iters=100, scale=True, trim=0.92, scale_range=(0.8, 1.35))
        if best is None or err < best[1]: best = (T, err)
    return best


def leg_warp(sex, side, out_dir=None, rebuild=False, log=print):
    """Thin-plate-spline warp of one leg, cached as its control points in .cache/fit/<sex>/foot/warp-leg_<side>.npz
    (same storage as fit.common.get_warp). The catalog's leg anchors (femur, patella, tibia, fibula) slide along the
    bones by about a centimetre near the joints when each bone is aligned as a whole, so the control pairs here come from
    joint-local alignments: the hip (proximal femur), the knee (distal femur, patella, proximal tibia and fibula) and the
    ankle (the mortise similarity used for the foot) are each aligned by trimmed similarity ICP; shaft points are carried
    by the similarity interpolated between their two joints. Every pair is then projected onto the HRA bone surface."""
    out_dir = out_dir or os.path.join(FIT, sex, GROUP)
    path = os.path.join(out_dir, f'warp-leg_{side}.npz')
    if os.path.exists(path) and not rebuild:
        d = np.load(path)
        return Warp(d['src'], d['dst'], pre=Sim(float(d['s']), d['R'], d['t']), smoothing=float(d['smoothing']), max_points=10 ** 9)
    t0 = time.time()
    zs = source('za-skeletal')
    Z = {k: (lambda v, f: (v, orient_outward(v, f)))(*zs.get(k.capitalize() + side)) for k in ('femur', 'patella', 'tibia', 'fibula')}
    H = {k: hra_bone(sex, k, side)[:2] for k in ('femur', 'patella', 'tibia', 'fibula')}
    from fit.foot_target import distal, mortise_map
    regions = {
        'hip': ([_prox(Z['femur'], 0.12)], [_prox(H['femur'], 0.13)]),
        'knee': ([distal(Z['femur'], 0.08), Z['patella'], _prox(Z['tibia'], 0.08), _prox(Z['fibula'], 0.06)],
                 [distal(H['femur'], 0.085), H['patella'], _prox(H['tibia'], 0.085), _prox(H['fibula'], 0.065)]),
    }
    sims = {}
    for r, (zl, hl) in regions.items():
        sims[r], err = _local_sim(merge(zl), merge(hl), seed=3)
        log(f'    leg warp {sex}/{side}: {r} {sims[r]} (ICP rms {err * 1000:.1f} mm)')
    F_ = ZAFoot.__new__(ZAFoot); F_.tibia, F_.fibula = Z['tibia'], Z['fibula']
    sims['ankle'], _ = mortise_map(F_, H['tibia'], H['fibula'], cache=os.path.join(out_dir, f'mortise-{side}.json'))
    # joint levels along each bone (Z-Anatomy heights): hip -> knee on the femur, knee -> ankle on the tibia / fibula
    yz = {k: (Z[k][0][:, 1].min(), Z[k][0][:, 1].max()) for k in Z}
    spans = {'femur': ('hip', 'knee', yz['femur'][1] - 0.12, yz['femur'][0] + 0.08),
             'tibia': ('knee', 'ankle', yz['tibia'][1] - 0.08, yz['tibia'][0] + 0.07),
             'fibula': ('knee', 'ankle', yz['fibula'][1] - 0.06, yz['fibula'][0] + 0.08),
             'patella': ('knee', 'knee', 9.0, -9.0)}
    src, dst = [], []
    for k, (a, b, ya, yb) in spans.items():
        P = sample_surface(*Z[k], 700 if k != 'patella' else 150, seed=5)
        y = P[:, 1]
        t = np.clip((ya - y) / max(ya - yb, 1e-6), 0, 1)[:, None] if k != 'patella' else np.zeros((len(P), 1))
        Ma, Mb = Sim4.from_sim(sims[a]), Sim4.from_sim(sims[b])
        X = (1 - t) * Ma(P) + t * Mb(P)
        q, d, _, _ = TriMesh(*H[k]).closest(X)
        src.append(P); dst.append(q)
    src, dst = np.concatenate(src), np.concatenate(dst)
    from fit.common import anchor_meshes, global_similarity
    T0 = global_similarity(anchor_meshes(sex, region=f'leg_{side}'))
    sm = 1e-4
    warp = Warp(src, dst, pre=T0, smoothing=sm)
    os.makedirs(out_dir, exist_ok=True)
    np.savez(path, src=T0.inverse()(warp.centres), dst=warp.centres + warp.rbf(warp.centres), s=T0.s, R=T0.R, t=T0.t, smoothing=sm)
    # residuals: warped Z-Anatomy bone surfaces to the HRA bones
    rep = {}
    for k in Z:
        P = sample_surface(*Z[k], 2000, seed=7)
        d = np.abs(TriMesh(*H[k]).signed(warp(P)))
        rep[k] = dict(mean_mm=round(float(d.mean() * 1000), 2), p90_mm=round(float(np.quantile(d, 0.9) * 1000), 2))
    json.dump(dict(sex=sex, side=side, joints={r: repr(S) for r, S in sims.items()}, residuals=rep, seconds=round(time.time() - t0, 1)),
              open(os.path.join(out_dir, f'warp-leg_{side}-report.json'), 'w'), indent=1)
    log(f'    leg warp {sex}/{side}: residuals ' + ', '.join(f'{k} {v["mean_mm"]}/{v["p90_mm"]} mm' for k, v in rep.items()) + f' ({time.time() - t0:.0f}s)')
    return leg_warp(sex, side, out_dir)


class LegDeform:
    """Z-Anatomy points of one leg (thigh to toes) -> body. See the module docstring."""

    def __init__(self, sex, side, sigma=0.006):
        d = os.path.join(FIT, sex, GROUP)
        pf = os.path.join(d, f'pose-{side}.json')
        if not os.path.exists(pf): fit(sex)
        pose = json.load(open(pf))
        self.sex, self.side, self.sigma = sex, side, sigma
        self.maps = {b: Sim4.from_list(L) for b, L in pose['maps'].items()}
        self.leg = leg_warp(sex, side)
        zs = source('za-skeletal')
        self.trees = {}
        for b in self.maps:
            v, f = zs.get(b + side); self.trees[b] = cKDTree(dense_points(v, f, 0.0015))
        legm = [zs.get(n + side) for n in ('Femur', 'Patella', 'Tibia', 'Fibula')]
        self.trees['leg'] = cKDTree(np.concatenate([dense_points(v, f, 0.002) for v, f in legm]))
        # hip: centre of the femoral head (sphere through the most proximal-medial part of the femur) and shaft axis
        fv = legm[0][0]
        sg = 1.0 if side == 'l' else -1.0
        top = fv[np.argmax(fv[:, 1] - 0.5 * sg * fv[:, 0])]
        from fit.foot_geom import fit_sphere
        c, r = fit_sphere(fv[np.linalg.norm(fv - top, axis=1) < 0.03])
        for _ in range(2): c, r = fit_sphere(fv[np.abs(np.linalg.norm(fv - c, axis=1) - r) < 0.004])
        self.hip_centre, self.hip_radius = c, r
        cc = fv.mean(0); w_, V_ = np.linalg.eigh(np.cov((fv - cc).T)); a = V_[:, -1]
        self.shaft = a if a[1] < 0 else -a          # pointing distally

    def foot_weights(self, p):
        names = list(self.trees)
        D = np.stack([self.trees[b].query(p)[0] for b in names], 1)
        W = np.exp(-((D - D.min(1, keepdims=True)) / self.sigma) ** 2)
        return names, W / W.sum(1, keepdims=True)

    def foot_weight(self, p):
        names, W = self.foot_weights(np.atleast_2d(p))
        return 1.0 - W[:, names.index('leg')]

    def __call__(self, p):
        p = np.atleast_2d(np.asarray(p, float))
        names, W = self.foot_weights(p)
        out = np.zeros_like(p)
        for i, b in enumerate(names):
            m = W[:, i] > 1e-6
            if not m.any(): continue
            out[m] += W[m, i:i + 1] * (self.leg(p[m]) if b == 'leg' else self.maps[b](p[m]))
        return out

    def hip_weight(self, p):
        t = (np.atleast_2d(p) - self.hip_centre) @ self.shaft
        return smoothstep((t + 0.02) / 0.12)


def leg_deform(sex, side):
    """-> LegDeform for that body and leg ('l' = the person's left, +x). See the module docstring."""
    return LegDeform(sex, side)


# ------------------------------------------------------------------------------------------------ outputs
def out_name(b, side):
    n = b.replace('_bone', '').replace('_of_foot', '').replace('_finger', '_toe').replace('Sesamoid_bones', 'sesamoids').lower()
    return f'{n}_{side}'


def qa(sex, side, ff, meshes, out_dir):
    from lib.qa import render_views
    F, tg = ff.F, ff.tg
    pal = {0: '#efe4c8', 1: '#e7c98f', 2: '#cfe0f0', 3: '#cde8c8', 4: '#f0cccc', 5: '#dccdf0'}
    items = [dict(mesh=tg.tibia, color='#d9d4c7'), dict(mesh=tg.fibula, color='#c9c3e8')]
    for b, m in meshes.items():
        k = next((k for k in range(1, 6) if b in toe_bones(k)), 0)
        items.append(dict(mesh=m, color=pal[k] if b not in ('Talus', 'Calcaneus') else '#f3dcb5'))
    items.append(dict(mesh=tg.skin, color='#e8b89a', opacity=0.22))
    allv = np.concatenate([m[0] for m in meshes.values()])
    c = allv.mean(0); sg = F.sg
    fr = ff.frame
    ax, up, lat = fr['axis'], fr['up'], fr['lat']
    tal = meshes['Talus'][0].mean(0)
    cams = {f'{side}-medial': dict(dir=-lat + 0.05 * up, target=c, radius=0.14), f'{side}-lateral': dict(dir=lat + 0.05 * up, target=c, radius=0.14),
            f'{side}-dorsal': dict(dir=up + 0.001 * ax, up=ax, target=c, radius=0.14), f'{side}-plantar': dict(dir=-up + 0.001 * ax, up=ax, target=c, radius=0.14),
            f'{side}-ankle-back': dict(dir=-ax + 0.15 * up, target=tal + 0.01 * up, radius=0.06)}
    files = render_views(items, cams, os.path.join(out_dir, 'qa'))
    # coronal section through the trochlea, seen from the front (mortise joint space)
    ct = ff.W['Talus'](F.trochlea_centre[None])[0]
    clip = [dict(normal=-ax, constant=float(ax @ ct))]
    sec = [it for it in items if it.get('opacity', 1) == 1]
    files += render_views(sec, {f'{side}-ankle-section': dict(dir=ax + 0.05 * up, target=ct, radius=0.045)}, os.path.join(out_dir, 'qa'), clip=clip)
    return files


def fit(sex):
    t_all = time.time()
    out_dir = os.path.join(FIT, sex, GROUP); os.makedirs(out_dir, exist_ok=True)
    outputs, report = [], dict(sex=sex, group=GROUP, sides={}, notes=[])
    for side in 'lr':
        t0 = time.time()
        sname = 'left' if side == 'l' else 'right'
        print(f'{sex} {sname} foot')
        lw = leg_warp(sex, side, out_dir)
        ff = FootFit(sex, side, out_dir)
        ff.fit()
        meshes = ff.refine()
        from fit.foot_measure import measure, skin_toes, toes_in_skin
        m, fr = measure(meshes, ff.W, ff.F, ff.tg, ff.articular)
        ff.frame = fr
        clefts, info = skin_toes(ff.tg, meshes, ff.W, ff.F, fr)
        toes = toes_in_skin(ff.tg, meshes, clefts, info, fr)
        ok_t = all(t['inside_skin_toe'] >= 0.995 for t in toes.values())
        m['toes_in_skin_toes'] = dict(value=toes, threshold='>= 99.5% of each toe\'s phalanx surface inside the skin and on its side of every cleft found on the skin',
                                      ok=bool(ok_t), clefts={f'{a}/{b}': c for (a, b), c in clefts.items()})
        q = unpack(ff.x)
        # how well the posed Z-Anatomy foot skin matches the HRA skin, and how far the leg warp and the foot agree at the ankle
        S = ff.skin_world(ff.W); sd = ff.tg.skin_sd(S)
        za_t = dense_points(*ff.F.tibia, 0.002); za_t = za_t[za_t[:, 1] < za_t[:, 1].min() + 0.03]
        ank = float(np.median(np.linalg.norm(lw(za_t) - ff.M(za_t), axis=1)) * 1000)
        m['pose'] = dict(ankle_plantarflexion_deg=round(float(np.degrees(q['alpha'])), 1), subtalar_supination_deg=round(float(np.degrees(q['beta'])), 1),
                         chopart_deg=[round(float(v), 1) for v in np.degrees(q['chopart'])], foot_scale=round(q['sf'] * ff.M.scale(), 4), talus_scale=round(q['st'] * ff.M.scale(), 4),
                         talus_offset_mm=[round(float(v), 1) for v in q['talus_t'] * 1000], toes_deg={k: [round(float(a), 1) for a in np.degrees(v)] for k, v in q['toes'].items()},
                         mortise_similarity=repr(ff.tg.T_m), mortise_icp_rms_mm=round(ff.tg.T_m_rms * 1000, 2), za_skin_to_hra_skin_mm=dict(median=round(float(np.median(sd) * 1000), 1), p10=round(float(np.quantile(sd, 0.1) * 1000), 1), p90=round(float(np.quantile(sd, 0.9) * 1000), 1)),
                         leg_warp_vs_mortise_map_at_ankle_mm=round(ank, 2), local_push_out_mm=ff.pushed_mm, hra_bones=ff.tg.names)
        report['sides'][sname] = m
        json.dump(dict(maps={b: M.to_list() for b, M in ff.W.items()}, x=list(map(float, ff.x)), T_m=dict(s=ff.tg.T_m.s, R=ff.tg.T_m.R.tolist(), t=ff.tg.T_m.t.tolist())),
                  open(os.path.join(out_dir, f'pose-{side}.json'), 'w'))
        for b, (v, f) in meshes.items():
            outputs.append(dict(name=out_name(b, side), part='skel_feet', mesh=(v.astype(np.float64), f), source=[b + side]))
        report['sides'][sname]['qa'] = [os.path.basename(x) for x in qa(sex, side, ff, meshes, out_dir)]
        crit = {k: v['ok'] for k, v in m.items() if isinstance(v, dict) and 'ok' in v}
        print(f'  {sname}: ' + ', '.join(f'{k} {"ok" if v else "FAIL"}' for k, v in crit.items()) + f'  ({time.time() - t0:.0f}s)')
    report['ok'] = bool(all(v['ok'] for sd_ in report['sides'].values() for v in sd_.values() if isinstance(v, dict) and 'ok' in v))
    report['seconds'] = round(time.time() - t_all, 1)
    write_group(sex, GROUP, outputs, report)
    print(f'{sex}: wrote {len(outputs)} meshes to {out_dir} ({report["seconds"]}s), all criteria ok: {report["ok"]}')
    return report


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    for sex in (['male', 'female'] if which == 'all' else [which]):
        fit(sex)
