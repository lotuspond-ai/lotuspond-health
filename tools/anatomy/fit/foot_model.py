"""The Z-Anatomy foot as an articulated model (everything here is in Z-Anatomy space; fit/foot.py maps it into a body).

Bones of one foot (27): talus, calcaneus, navicular, cuboid, three cuneiforms, five metatarsals, the sesamoids of the
hallux, and 14 phalanges. Joints, all derived from the bone surfaces themselves:

  ankle (talocrural)  axis of revolution of the talar trochlea (cone fit to the trochlea facing the tibial plafond),
                      started from the line through the malleolar tips (Inman)
  subtalar            Inman's mean axis (42 deg up from the sole plane, 23 deg medial to the foot axis) through the centre
                      of the talar head; positive angle = supination (inversion with adduction)
  talocalcaneonavicular / Chopart   ball joint at the centre of the talar head (sphere fit to the talonavicular facet)
  MTP, PIP, DIP (hallux IP)          centres = sphere fits to the head facing the next phalanx; flexion about the toe's
                      transverse axis, MTP abduction about its dorsal axis

The foot's skin envelope is the outward layer of the Z-Anatomy foot and ankle skin regions (za-regions), bound to the
bones by distance-based weights (linear blend skinning), so a posed and scaled skeleton carries its own soft tissue.
"""
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import source, merge, orient_outward, sample_surface, dense_points
from fit.foot_geom import TriMesh, outer_layer, fit_sphere, fit_axis, rot_axis, rotvec, Sim4, crop_box

ORD = ('first', 'second', 'third', 'fourth', 'fifth')
TARSALS = ('Talus', 'Calcaneus', 'Navicular_bone', 'Cuboid_bone', 'Medial_cuneiform_bone', 'Intermediate_cuneiform_bone', 'Lateral_cuneiform_bone')
METATARSALS = tuple(f'{o.capitalize()}_metatarsal_bone' for o in ORD)


def phalanx(kind, k):
    return f'{kind}_phalanx_of_{ORD[k - 1]}_finger_of_foot'


def toe_bones(k):
    """Phalanges of toe k (1 = hallux) from proximal to distal."""
    return [phalanx('Proximal', k)] + ([] if k == 1 else [phalanx('Middle', k)]) + [phalanx('Distal', k)]


BASES = list(TARSALS) + list(METATARSALS) + ['Sesamoid_bones_of_foot'] + [b for k in range(1, 6) for b in toe_bones(k)]
MIDFOOT = ['Navicular_bone', 'Cuboid_bone', 'Medial_cuneiform_bone', 'Intermediate_cuneiform_bone', 'Lateral_cuneiform_bone'] + list(METATARSALS) + ['Sesamoid_bones_of_foot']

SKIN_REGIONS = ['Heel_region', 'Sole', 'Lateral_part_of_longitudinal_arch_of_foot', 'Medial_part_of_longitudinal_arch_of_foot',
                'Distal_transverse_arch_of_foot', 'Proximal_transverse_arch_of_foot', 'Dorsum_of_foot', 'Medial_border_of_foot',
                'Lateral_border_of_foot', 'Metatarsal_region', 'Hallucial_eminence', 'Dorsal_surfaces_of_digits_of_foot',
                'Plantar_surfaces_of_digits_of_foot', 'Nail_plate_(foot)', 'Lateral_malleolus', 'Medial_malleolus',
                'Anterior_region_of_ankle', 'Medial_retromalleolar_region', 'Lateral_retromalleolar_region']

INMAN_UP, INMAN_MED = np.radians(42.0), np.radians(23.0)


class Joint:
    """Rotation about a centre: either about a fixed axis (1 DOF) or a free rotation vector (3 DOF), in Z-Anatomy space."""

    def __init__(self, name, centre, axes):
        self.name, self.c, self.axes = name, np.asarray(centre, float), [np.asarray(a, float) / np.linalg.norm(a) for a in axes]

    def matrix(self, angles):
        R = np.eye(3)
        for a, th in zip(self.axes, angles): R = R @ rot_axis(a, th)
        return Sim4.about(R, self.c)


class ZAFoot:
    def __init__(self, side, n_skin=7000, seed=0):
        self.side = side
        self.sg = 1.0 if side == 'l' else -1.0          # +x is the person's left: lateral = +x on the left foot
        zs = source('za-skeletal')
        self.bones = {}
        for b in BASES:
            v, f = zs.get(b + side)
            self.bones[b] = (v, orient_outward(v, f))
        tv, tf = zs.get('Tibia' + side); fv, ff = zs.get('Fibula' + side)
        self.tibia = (tv, orient_outward(tv, tf)); self.fibula = (fv, orient_outward(fv, ff))
        self._frame()
        self._joints()
        self._skin(n_skin, seed)

    # -------------------------------------------------------------------------------------------- frame and joints
    def _frame(self):
        cal = self.bones['Calcaneus'][0]; mt2 = self.bones['Second_metatarsal_bone'][0]
        heel = cal[np.argmin(cal[:, 2])]; head = mt2[np.argmax(mt2[:, 2])]
        a = head - heel; a[1] = 0; a /= np.linalg.norm(a)
        up = np.array([0, 1.0, 0])
        lat = np.cross(up, a)                      # for a = +z: lat = +x... (y x z = x)
        if lat[0] * self.sg < 0: lat = -lat
        self.axis, self.up, self.lat = a, up, lat
        self.med = -lat
        # side-independent rotation axes (right-hand rule): positive = inversion, adduction, plantarflexion
        self.inv_axis = -self.sg * a
        self.add_axis = -self.sg * up
        self.pf_axis = self.sg * lat
        self.frame_axes = np.stack([self.inv_axis, self.add_axis, self.pf_axis])

    def _joints(self):
        B = self.bones
        T_tib, T_fib = TriMesh(*self.tibia), TriMesh(*self.fibula)
        tal = B['Talus']
        P = np.concatenate([tal[0], sample_surface(*tal, 6000, seed=4)])
        _, dt, _, _ = T_tib.closest(P); _, dfb, _, _ = T_fib.closest(P)
        nT = TriMesh(*tal).closest(P)[3]
        self.talus_pts = P
        # articular facets of the talus facing the leg: trochlea (up), medial malleolar facet, lateral malleolar facet
        near_t = dt < 0.0055; near_f = dfb < 0.0055
        sup = near_t & (nT[:, 1] > 0.6)
        medf = near_t & (nT @ self.med > 0.6)
        latf = near_f & (nT @ self.lat > 0.4)
        self.facets = dict(trochlea=P[sup], medial=P[medf], lateral=P[latf])
        # malleolar tips and the Inman ankle axis as a start, then the axis of revolution of the trochlea
        tib = self.tibia[0]; fib = self.fibula[0]
        mm = tib[np.argmin(tib[:, 1])]; lm = fib[np.argmin(fib[:, 1])]
        self.malleoli = dict(medial=mm, lateral=lm)
        d0 = lm - mm; d0 /= np.linalg.norm(d0)
        c0 = P[sup].mean(0) - 0.015 * self.up
        c, d, r0, slope, rms = fit_axis(P[sup], c0, d0, cone=True)
        # sign: positive angle = plantarflexion (a point in front of the axis goes down)
        probe = c + 0.05 * self.axis
        if (rot_axis(d, 0.1) @ (probe - c))[1] > (probe - c)[1]: d = -d
        self.ankle = Joint('ankle', c, [d])
        self.ankle_fit = dict(radius_mm=r0 * 1000, slope=slope, rms_mm=rms * 1000, inman_angle_deg=float(np.degrees(np.arccos(np.clip(abs(d @ d0), -1, 1)))))
        self.trochlea_centre = c
        # talar head: sphere through the talus surface facing the navicular
        nav = TriMesh(*B['Navicular_bone'])
        _, dn, _, _ = nav.closest(P)
        th_c, th_r = fit_sphere(P[dn < 0.003])
        self.talar_head = th_c; self.talar_head_r = th_r
        # subtalar axis: through the talar head centre (the talocalcaneonavicular joint is a ball there), oriented so that
        # turning the calcaneus about it best keeps its facet distances to the talus (started from Inman's mean axis)
        d = np.cos(INMAN_UP) * (np.cos(INMAN_MED) * self.axis + np.sin(INMAN_MED) * self.med) + np.sin(INMAN_UP) * self.up
        self.subtalar_inman = d.copy()
        d, self.subtalar_rms = self._congruence_axis(B['Calcaneus'], tal, th_c, d)
        # sign: a point on the lateral border must go down (inversion) for a positive angle
        probe = th_c + 0.04 * self.lat
        if (rot_axis(d, 0.1) @ (probe - th_c))[1] > (probe - th_c)[1]: d = -d
        self.subtalar = Joint('subtalar', th_c, [d])
        # transverse tarsal (Chopart) flexion: about the line through the talonavicular and calcaneocuboid centres, which
        # keeps both joints congruent; small inversion / adduction about the talar head
        cal = B['Calcaneus']
        Q = np.concatenate([cal[0], sample_surface(*cal, 6000, seed=6)])
        _, dc, _, _ = TriMesh(*B['Cuboid_bone']).closest(Q)
        cc = Q[dc < 0.003]
        self.cc_centre = cc.mean(0) if len(cc) < 30 else fit_sphere(cc)[0]
        t = self.cc_centre - th_c; t /= np.linalg.norm(t)
        probe = th_c + 0.05 * self.axis
        if (rot_axis(t, 0.1) @ (probe - th_c))[1] > (probe - th_c)[1]: t = -t
        self.chopart_axis = t
        # toe joints
        self.toes = {}
        for k in range(1, 6):
            names = toe_bones(k)
            mt = B[METATARSALS[k - 1]]
            prox = names[0]
            c_mtp = self._head_centre(mt, B[prox])
            heads = [c_mtp]
            for a, b in zip(names[:-1], names[1:]):
                heads.append(self._head_centre(B[a], B[b]))
            tip = B[names[-1]][0][np.argmax(B[names[-1]][0] @ self.axis)]
            dirs = []
            pts = heads + [tip]
            for i in range(len(heads)):
                dv = pts[i + 1] - pts[i]; dirs.append(dv / np.linalg.norm(dv))
            joints = []
            for i, (c, dv) in enumerate(zip(heads, dirs)):
                tr = np.cross(dv, self.up); tr /= np.linalg.norm(tr)
                if tr @ self.lat < 0: tr = -tr
                # flexion positive = toe tip goes plantar
                probe = c + 0.02 * dv
                if (rot_axis(tr, 0.1) @ (probe - c))[1] > (probe - c)[1]: tr = -tr
                dors = np.cross(tr, dv); dors /= np.linalg.norm(dors)
                if dors[1] < 0: dors = -dors
                # abduction positive = toward the lateral side
                if (rot_axis(dors, 0.1) @ (probe - c)) @ self.lat < (probe - c) @ self.lat: dors = -dors
                axes = [tr, dors] if i == 0 else [tr]
                joints.append(Joint(('mtp' if i == 0 else 'ip%d' % i) + str(k), c, axes))
            self.toes[k] = dict(bones=names, joints=joints, tip=tip, dir=dirs[0])
        # border rays: the 1st and 5th metatarsals (with their toes, and the sesamoids for the 1st) can converge toward
        # the 2nd / 4th about the centre of their tarsometatarsal joint (dorsal axis; + = toward the middle of the foot):
        # the intermetatarsal angles differ between people by several degrees (narrow vs splayed forefoot)
        self.rays = {}
        for k, base in ((1, 'Medial_cuneiform_bone'), (5, 'Cuboid_bone')):
            mt = B[METATARSALS[k - 1]]
            Q = np.concatenate([mt[0], sample_surface(*mt, 4000, seed=8)])
            _, dq, _, _ = TriMesh(*B[base]).closest(Q)
            c = Q[dq < 0.003].mean(0) if (dq < 0.003).sum() >= 10 else Q[np.argsort(dq)[:30]].mean(0)
            ax_ = self.up if k == 1 else -self.up
            probe = c + 0.05 * self.axis
            # positive angle moves the ray toward the foot's middle: lateral for the 1st ray, medial for the 5th
            toward = self.lat if k == 1 else self.med
            if (rot_axis(ax_, 0.1) @ (probe - c) + c - probe) @ toward < 0: ax_ = -ax_
            self.rays[k] = Joint(f'tmt{k}', c, [ax_])

    @staticmethod
    def _congruence_axis(moving, fixed, c, d0, angles=np.radians([-20, -10, 10, 20])):
        from scipy import optimize
        from fit.foot_geom import VoxelField
        fv = fixed[0]
        field = VoxelField([fixed], fv.min(0) - 0.01, fv.max(0) + 0.01, 0.0004)
        P = dense_points(*moving, 0.0006)
        sd = field(P); P = P[(sd < 0.0025) & (sd > -0.002)]; sd0 = field(P)
        e1 = np.cross(d0, [1, 0, 0]); e1 /= np.linalg.norm(e1); e2 = np.cross(d0, e1)
        def dirn(y):
            d = d0 + y[0] * e1 + y[1] * e2; return d / np.linalg.norm(d)
        def cost(y):
            d = dirn(y)
            return np.mean([np.mean((field((P - c) @ rot_axis(d, a).T + c) - sd0) ** 2) for a in angles])
        r = optimize.minimize(cost, np.zeros(2), method='Nelder-Mead', options=dict(xatol=1e-4, fatol=1e-12))
        return dirn(r.x), float(np.sqrt(cost(r.x)))

    @staticmethod
    def _head_centre(a, b, d=0.003):
        """Centre of the head of bone a where it meets bone b (sphere fit to a's surface within d of b)."""
        va, fa = a
        P = np.concatenate([va, sample_surface(va, fa, 3000, seed=5)])
        _, dd, _, _ = TriMesh(*b).closest(P)
        sel = P[dd < d]
        if len(sel) < 20: sel = P[np.argsort(dd)[:60]]
        c, r = fit_sphere(sel)
        if not (0.002 < r < 0.03):  # degenerate fit: use the centre of the contact patch pulled back into the head
            c = sel.mean(0) - 0.006 * (b[0].mean(0) - va.mean(0)) / np.linalg.norm(b[0].mean(0) - va.mean(0))
        return c

    # -------------------------------------------------------------------------------------------- skin envelope
    def _skin(self, n, seed):
        zr = source('za-regions')
        core = np.concatenate([dense_points(*m, 0.002) for m in list(self.bones.values()) + [self.tibia, self.fibula]])
        layers = [outer_layer(zr.get(r + self.side), core) for r in SKIN_REGIONS]
        self.skin_mesh = merge(layers)
        self.skin_pts = sample_surface(*self.skin_mesh, n, seed=seed)
        self.skin_n = TriMesh(*self.skin_mesh).closest(self.skin_pts)[3]
        self.skin_w = self.weights(self.skin_pts)

    def weights(self, p, sigma=0.004, k=3, with_leg=True):
        """Linear-blend-skinning weights of points over the bones (+ 'leg' for the tibia/fibula): (names, W (n, nb))."""
        names = list(self.bones) + (['leg'] if with_leg else [])
        D = np.zeros((len(p), len(names)))
        if not hasattr(self, '_bone_trees'):
            self._bone_trees = {b: cKDTree(dense_points(*m, 0.0012)) for b, m in self.bones.items()}
            self._bone_trees['leg'] = cKDTree(np.concatenate([dense_points(*self.tibia, 0.0015), dense_points(*self.fibula, 0.0015)]))
        for i, b in enumerate(names): D[:, i] = self._bone_trees[b].query(p)[0]
        dmin = D.min(1, keepdims=True)
        W = np.exp(-((D - dmin) / sigma) ** 2)
        # keep the k strongest
        if k < W.shape[1]:
            thr = -np.sort(-W, axis=1)[:, k - 1:k]
            W[W < thr] = 0
        W /= W.sum(1, keepdims=True)
        return names, W

    # -------------------------------------------------------------------------------------------- kinematics
    def pose(self, q):
        """Per-bone maps (Z-Anatomy space -> posed Z-Anatomy space, before the mortise map) for parameters q:
        alpha (ankle, + = plantarflexion), beta (subtalar, + = supination), chopart (3: inversion and adduction about
        the talar head, plantarflexion about the talonavicular-calcaneocuboid line), sf / st (foot / talus scale about the
        trochlea centre), sw / sh (width / height of the skeleton relative to its length), stw (extra width of the talus),
        talus_r (3, same components,
        about the trochlea centre), talus_t (3, m), toes {k: [mtp_flex, mtp_abd, ip1, ip2]} (+ = flexion, abduction
        toward the lateral side), toe_scale {k: s} (phalanges of toe k about its MTP centre), rays {1: a, 5: a} (1st / 5th
        ray toward the middle of the foot about its tarsometatarsal joint)."""
        c = self.trochlea_centre
        D = Sim4.about(rotvec(np.asarray(q.get('talus_r', np.zeros(3))) @ self.frame_axes), c).then(Sim4(np.eye(3), q.get('talus_t', np.zeros(3))))
        A = self.ankle.matrix([q.get('alpha', 0.0)])
        # foot proportions: a scale along the foot (sf), with the width and height of the whole skeleton scaled by
        # sw / sh relative to it (Z-Anatomy foot frame), about the trochlea centre; the talus has its own overall scale st
        sw, sh = q.get('sw', 1.0), q.get('sh', 1.0)
        P = np.eye(3) + (sw - 1.0) * np.outer(self.lat, self.lat) + (sh - 1.0) * np.outer(self.up, self.up)
        # the talus may in addition be wider or narrower (stw): the subject's trochlea is as wide as its own mortise
        Pt = np.eye(3) + (sw * q.get('stw', 1.0) - 1.0) * np.outer(self.lat, self.lat) + (sh - 1.0) * np.outer(self.up, self.up)
        Sf = Sim4.about(q.get('sf', 1.0) * P, c); St = Sim4.about(q.get('st', 1.0) * Pt, c)
        S = self.subtalar.matrix([q.get('beta', 0.0)])
        ch = np.asarray(q.get('chopart', np.zeros(3)), float)
        C = Sim4.about(rot_axis(self.chopart_axis, ch[2]), self.talar_head).then(Sim4.about(rotvec(ch[0] * self.frame_axes[0] + ch[1] * self.frame_axes[1]), self.talar_head))
        top = lambda M: M.then(A).then(Sf).then(D)            # noqa: E731 (posed space)
        out = {'Talus': A.then(St).then(D), 'Calcaneus': top(S)}
        mid = C.then(S)
        for b in MIDFOOT: out[b] = top(mid)
        rays = {k: self.rays[k].matrix([float(q.get('rays', {}).get(k, 0.0))]) for k in self.rays}
        out[METATARSALS[0]] = top(rays[1].then(mid)); out['Sesamoid_bones_of_foot'] = top(rays[1].then(mid))
        out[METATARSALS[4]] = top(rays[5].then(mid))
        toes = q.get('toes', {})
        tscale = q.get('toe_scale', {})
        for k, t in self.toes.items():
            ang = list(toes.get(k, [])) + [0.0] * 4
            M = Sim4()
            chain = []
            for i, j in enumerate(t['joints']):
                if i == 0: J = j.matrix([ang[0], ang[1]])
                else: J = j.matrix([ang[1 + i]])
                chain.append(J)
            # the phalanges of each toe may be scaled together about the MTP centre (toe size relative to the foot
            # varies between people); a uniform scale about c commutes with the MTP rotation about c
            T = Sim4.about(np.eye(3) * float(tscale.get(k, 1.0)), t['joints'][0].c)
            # bone i of the toe is moved by joints 0..i (distal joints first)
            for i, b in enumerate(t['bones']):
                M = Sim4()
                for J in reversed(chain[:i + 1]): M = M.then(J)
                out[b] = top((M.then(T).then(rays[k]) if k in rays else M.then(T)).then(mid))
        return out

    def skin_points(self, maps, leg_map=None, pts=None, w=None):
        """Posed skin points by linear blend skinning (leg_map: map for 'leg', default identity)."""
        pts = self.skin_pts if pts is None else pts
        names, W = self.skin_w if w is None else w
        out = np.zeros_like(pts)
        for i, b in enumerate(names):
            m = W[:, i] > 0
            if not m.any(): continue
            M = (leg_map or Sim4()) if b == 'leg' else maps[b]
            out[m] += W[m, i:i + 1] * M(pts[m])
        return out
