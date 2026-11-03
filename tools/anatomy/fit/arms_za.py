"""Z-Anatomy side of the arms fit: the bones of one upper limb, their articular surfaces and joint centres.

Joint centres come from the bones themselves, as they articulate in Z-Anatomy's anatomical position: the articular
surface of bone A at joint (A, B) is the part of A within a few millimetres of B; spheres fitted to those surfaces give
the centres of rotation (humeral head, capitulum, metacarpal and phalangeal heads, proximal carpal row).
"""
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import source, sample_surface, area, orient_outward
from fit.arms_geom import TriMesh, fit_sphere, fit_plane, unit, pca_axes

ORD = ['first', 'second', 'third', 'fourth', 'fifth']
CARPALS = ['sca', 'lun', 'tri', 'pis', 'tpm', 'tpd', 'cap', 'ham']
NAMES = dict(clav='Clavicle', scap='Scapula', hum='Humerus', rad='Radius', uln='Ulna', sca='Scaphoid_bone', lun='Lunate_bone',
             tri='Triquetrum_bone', pis='Pisiform_bone', tpm='Trapezium_bone', tpd='Trapezoid_bone', cap='Capitate_bone', ham='Hamate_bone')
for _i, _o in enumerate(ORD): NAMES[f'mc{_i + 1}'] = f'{_o.capitalize()}_metacarpal_bone'
for _i, _o in enumerate(ORD): NAMES[f'pp{_i + 1}'] = f'Proximal_phalanx_of_{_o}_finger_of_hand'
for _i, _o in enumerate(ORD[1:]): NAMES[f'mp{_i + 2}'] = f'Middle_phalanx_of_{_o}_finger_of_hand'
for _i, _o in enumerate(ORD): NAMES[f'dp{_i + 1}'] = f'Distal_phalanx_of_{_o}_finger_of_hand'
ARM_BONES = ['clav', 'scap', 'hum', 'rad', 'uln']
HAND_BONES = CARPALS + [f'mc{i}' for i in range(1, 6)] + [f'pp{i}' for i in range(1, 6)] + [f'mp{i}' for i in range(2, 6)] + [f'dp{i}' for i in range(1, 6)]
ALL_BONES = ARM_BONES + HAND_BONES
# finger chains: (metacarpal, proximal, middle, distal); the thumb has no middle phalanx
CHAINS = {1: ['mc1', 'pp1', 'dp1'], 2: ['mc2', 'pp2', 'mp2', 'dp2'], 3: ['mc3', 'pp3', 'mp3', 'dp3'], 4: ['mc4', 'pp4', 'mp4', 'dp4'], 5: ['mc5', 'pp5', 'mp5', 'dp5']}
PHALANGES = [b for b in HAND_BONES if b[:2] in ('pp', 'mp', 'dp')]
# Z-Anatomy skin regions of the free limb (za-regions), by segment
REGIONS = {
    'upper': ['Deltoid_region', 'Anterior_region_of_arm', 'Posterior_region_of_arm'],
    'elbow': ['Anterior_region_of_elbow', 'Posterior_region_of_elbow'],
    'fore': ['Anterior_region_of_forearm', 'Posterior_region_of_forearm', 'Lateral_border_of_forearm', 'Medial_border_of_forearm'],
    'wrist': ['Anterior_region_of_wrist', 'Posterior_region_of_wrist', 'Radial_foveola'],
    'hand': ['Palm', 'Dorsum_of_hand'],
    'digits': ['Dorsal_surfaces_of_digits_of_hand', 'Palmar_surfaces_of_digits_of_hand'],
}


def bone_name(key, side):
    return NAMES[key] + side


def load_bones(side):
    s = source('za-skeletal')
    out = {}
    for k in ALL_BONES:
        v, f = s.get(bone_name(k, side))
        out[k] = (v, orient_outward(v, f))
    return out


def load_regions(side):
    r = source('za-regions')
    out = {}
    for seg, names in REGIONS.items():
        for n in names:
            v, f = r.get(n + side)
            out[n] = (v, f, seg)
    return out


def manubrium():
    v, f = source('za-skeletal').get('Manubrium_of_sternum')
    return v, orient_outward(v, f)


def _samples(m, per_mm2=1.0, nmin=1500, nmax=60000, seed=1):
    v, f = m
    n = int(np.clip(area(v, f) * 1e6 * per_mm2, nmin, nmax))
    return sample_surface(v, f, n, seed=seed)


def contact(PA, TB, d):
    """Samples of A (PA) within distance d of mesh B."""
    dist = np.abs(TB.signed(PA))
    return PA[dist < d], dist[dist < d]


def refine_sphere(P, c, r, band=0.003, iters=4, keep=None):
    """Sphere fit to the points of P lying within `band` of the current sphere (grows over the articular head)."""
    for _ in range(iters):
        dd = np.abs(np.linalg.norm(P - c, axis=1) - r)
        m = dd < band
        if keep is not None: m &= keep(P)
        if m.sum() < 30: break
        c, r = fit_sphere(P[m])
    return c, r


class Limb:
    """Joint centres, axes and articular surfaces of one Z-Anatomy upper limb (in Z-Anatomy space)."""

    def __init__(self, side):
        self.side = side
        self.sg = 1.0 if side == 'l' else -1.0
        self.M = load_bones(side)
        self.man = manubrium()
        self.T = {k: TriMesh(*m) for k, m in self.M.items()}
        self.Tman = TriMesh(*self.man)
        self.P = {k: _samples(m) for k, m in self.M.items()}
        self.J = {}
        self._joints()

    # ---------------------------------------------------------------- joints
    def _joints(self):
        M, T, P, J = self.M, self.T, self.P, self.J
        # glenohumeral: humeral head sphere grown from the part facing the glenoid
        hc, _ = contact(P['hum'], T['scap'], 0.008)
        c, r = fit_sphere(hc)
        top = P['hum'][:, 1] > M['hum'][0][:, 1].max() - 0.07
        c, r = refine_sphere(P['hum'], c, r, band=0.0025, keep=lambda X: X[:, 1] > M['hum'][0][:, 1].max() - 0.07)
        J['gh'] = c; J['gh_r'] = r
        gl, _ = contact(P['scap'], T['hum'], 0.008)
        gc, gn = fit_plane(gl)
        if gn @ (c - gc) < 0: gn = -gn
        J['glenoid'] = gc; J['glenoid_n'] = gn
        # elbow: capitulum sphere (faces the radial head) and the trochlea (faces the ulna's trochlear notch)
        cap, _ = contact(P['hum'], T['rad'], 0.008)
        ccap, rcap = fit_sphere(cap)
        tro, _ = contact(P['uln'], T['hum'], 0.004)
        ctro, rtro = fit_sphere(tro)
        J['capitulum'] = ccap; J['capitulum_r'] = rcap; J['trochlea'] = ctro; J['trochlea_r'] = rtro
        J['elbow'] = 0.5 * (ccap + ctro)
        ax = unit(ccap - ctro)  # medial -> lateral
        J['elbow_axis'] = ax
        # distal radio-ulnar joint: ulnar head (faces the radius's ulnar notch)
        uh, _ = contact(P['uln'], T['rad'], 0.004)
        uh = uh[uh[:, 1] < M['uln'][0][:, 1].min() + 0.06]
        cuh, ruh = fit_sphere(uh)
        J['ulnar_head'] = cuh
        J['prono_axis'] = unit(cuh - ccap)
        # radiocarpal: the proximal surfaces of scaphoid and lunate that face the radius
        pr = np.concatenate([contact(P[k], T['rad'], 0.006)[0] for k in ('sca', 'lun')])
        crc, rrc = fit_sphere(pr)
        J['radiocarpal'] = crc; J['radiocarpal_r'] = rrc
        J['wrist'] = crc
        # midcarpal: capitate head (faces lunate and scaphoid)
        ch = np.concatenate([contact(P['cap'], T[k], 0.004)[0] for k in ('lun', 'sca')])
        J['capitate_head'], _ = fit_sphere(ch)
        # finger joints: heads of metacarpals and phalanges, facing the next bone of the chain
        for d, ch in CHAINS.items():
            for a, b in zip(ch[:-1], ch[1:]):
                hd, _ = contact(P[a], T[b], 0.004)
                c0, r0 = fit_sphere(hd)
                # grow over the head (distal part of the bone only)
                axis = unit(c0 - P[a].mean(0))
                c1, r1 = refine_sphere(P[a], c0, r0, band=0.0012, iters=3, keep=lambda X, c0=c0, axis=axis: (X - c0) @ axis > -0.004)
                if not (0.6 * r0 < r1 < 1.6 * r0): c1, r1 = c0, r0
                J[f'{a}>{b}'] = c1; J[f'{a}>{b}_r'] = r1
            # tip of the distal phalanx: farthest point from its proximal joint
            dp = ch[-1]; base = J[f'{ch[-2]}>{dp}']
            pts = M[dp][0]
            J[f'{dp}_tip'] = pts[np.argmax(np.linalg.norm(pts - base, axis=1))]
        # thumb carpometacarpal (saddle): centre of the trapezium-mc1 contact
        cm = np.concatenate([contact(P['mc1'], T['tpm'], 0.003)[0], contact(P['tpm'], T['mc1'], 0.003)[0]])
        J['cmc1'] = cm.mean(0)
        # sternoclavicular and acromioclavicular contacts
        sc = np.concatenate([contact(P['clav'], self.Tman, 0.006)[0], contact(_samples(self.man), T['clav'], 0.006)[0]])
        J['sc'] = sc.mean(0)
        ac = np.concatenate([contact(P['clav'], T['scap'], 0.004)[0], contact(P['scap'], T['clav'], 0.004)[0]])
        J['ac'] = ac.mean(0)

    # ---------------------------------------------------------------- frames
    def joint_chain(self, digit):
        """Joint centres along a digit: [proximal joint of the metacarpal or None, MCP, PIP, (DIP), tip]."""
        ch = CHAINS[digit]
        pts = [self.J[f'{a}>{b}'] for a, b in zip(ch[:-1], ch[1:])]
        return pts + [self.J[f'{ch[-1]}_tip']]

    def hand_frame(self):
        """Origin at the radiocarpal centre; e1 along the hand (towards MCP3), e3 palmar normal, e2 = e3 x e1."""
        J = self.J
        o = J['radiocarpal']
        e1 = unit(J['mc3>pp3'] - o)
        mcp = np.array([J[f'mc{i}>pp{i}'] for i in range(2, 6)])
        across = unit(mcp[0] - mcp[-1])  # little -> index (radial)
        n = unit(np.cross(e1, across))
        # palmar side: the hand's palmar surface faces forward (+z) in anatomical position
        if n[2] < 0: n = -n
        e3 = unit(n - (n @ e1) * e1); e2 = np.cross(e3, e1)
        return o, np.stack([e1, e2, e3], 1)
