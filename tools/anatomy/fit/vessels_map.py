"""What the vessels group places, and the deformation that carries each Z-Anatomy vessel into an HRA body.

Each Z-Anatomy (za-cardio) vertex x goes through
    trunk warp   T(x) = fit.common.get_warp(sex, 'trunk')(x)                 (trunk, neck, head)
    head map     H(x) = fit.skull.head_map(sex)(x)                            (the skull as placed by the skull group)
    arm map      A_s(x), w_s(x) = fit.arms.arm_deform(sex, s)                 (shoulder girdle and free limb of side s)
    leg map      L_s(x), hip_s(x) = fit.foot.leg_deform(sex, s), .hip_weight  (thigh to toes of side s)
blended as
    x1 = (1 - h) T + h H            h = smoothstep of the Z-Anatomy height from the C3 to the C1 vertebral body
    x2 = (1 - a) x1 + a A_s         a = w_s(x) (1 - h), for every neck, thorax and arm vessel, by position (side s by
                                    the vessel's side; midline vessels by the sign of x): vessels that meet at the root
                                    of the neck (jugular / subclavian / brachiocephalic veins, carotid / subclavian /
                                    vertebral / internal thoracic arteries) get the same map where they meet
    x3 = (1 - g) x2 + g L_s         g = hip_s(x), for the femoral vessels and everything below them
The trunk warp is corrected toward the bones other groups placed from Z-Anatomy with a shape of their own (rib cage:
ribs, costal cartilages, sternum; arms: clavicle, scapula): the placed bones keep Z-Anatomy's vertex order, so each bone
vertex X has a displacement d = placed(X) - T(X). d is interpolated smoothly through space (SkelCorrection: thin-plate
spline through those bones, with d = 0 on the vertebrae, sacrum, hip bones and the great vessels the warp fits), so the
internal thoracic vessels follow the sternum and cartilages they lie against without zig-zagging between them. This
matters most in the female, whose trunk warp puts the right costal cartilages up to 12 cm from the placed ones (the
sternum is stretched to 15 cm wide); in the male the placed manubrium's notches lie 9 / 24 mm from the warped ones.
    x0 = T(x) + d(x)                (trunk, with the skeletal correction)
Every map's output is cached per Z-Anatomy name in .cache/fit/<sex>/vessels/work/map-*.npz together with the
modification times of the files it was computed from; a cache whose sources changed is recomputed.
"""
import os, sys, time
import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source  # noqa: E402
from fit.common import FIT  # noqa: E402
from fit.vessels_geom import smoothstep  # noqa: E402

GROUP = 'vessels'

# (Z-Anatomy name, part, side, region, sexes or None). side: 'l' = the person's left (+x), 'r', 'm' (midline).
# region: 'neck', 'head', 'thorax', 'arm', 'pelvis', 'leg' (which limb map applies; the head map applies by height).
A, V = 'arteries', 'veins'
VESSELS = [
    # ---- neck and head arteries
    ('Right_common_carotid_artery', A, 'r', 'neck', None),
    ('Left_common_carotid_artery', A, 'l', 'neck', None),
    ('Internal_carotid_arteryl', A, 'l', 'neck', None), ('Internal_carotid_arteryr', A, 'r', 'neck', None),
    ('External_carotid_arteryl', A, 'l', 'neck', None), ('External_carotid_arteryr', A, 'r', 'neck', None),
    ('Vertebral_arteryl', A, 'l', 'neck', None), ('Vertebral_arteryr', A, 'r', 'neck', None),
    ('Basilar_artery', A, 'm', 'head', None),
    ('Posterior_cerebral_arteryl', A, 'l', 'head', None), ('Posterior_cerebral_arteryr', A, 'r', 'head', None),
    ('Posterior_communicating_arteryl', A, 'l', 'head', None), ('Posterior_communicating_arteryr', A, 'r', 'head', None),
    ('Middle_cerebral_artery_(M1-segment)l', A, 'l', 'head', None), ('Middle_cerebral_artery_(M1-segment)r', A, 'r', 'head', None),
    ('Insular_branches_of_middle_cerebral_artery_(M2-segment)l', A, 'l', 'head', None),
    ('Insular_branches_of_middle_cerebral_artery_(M2)r', A, 'r', 'head', None),
    ('Anterior_cerebral_arteryl', A, 'l', 'head', None), ('Anterior_cerebral_arteryr', A, 'r', 'head', None),
    ('Anterior_communicating_artery', A, 'm', 'head', None),
    ('Pericallosal_arteryl', A, 'l', 'head', None), ('Pericallosal_arteryr', A, 'r', 'head', None),
    ('Superior_cerebellar_arteryl', A, 'l', 'head', None), ('Superior_cerebellar_arteryr', A, 'r', 'head', None),
    ('Anterior_inferior_cerebellar_arteryl', A, 'l', 'head', None), ('Anterior_inferior_cerebellar_arteryr', A, 'r', 'head', None),
    ('Posterior_inferior_cerebellar_arteryl', A, 'l', 'head', None), ('Posterior_inferior_cerebellar_arteryr', A, 'r', 'head', None),
    # ---- thorax
    ('Internal_thoracic_arteryl', A, 'l', 'thorax', None), ('Internal_thoracic_arteryr', A, 'r', 'thorax', None),
    # ---- upper limbs
    ('Right_subclavian_artery', A, 'r', 'arm', None), ('Left_subclavian_artery', A, 'l', 'arm', None),
    ('Axillary_arteryl', A, 'l', 'arm', None), ('Axillary_arteryr', A, 'r', 'arm', None),
    ('Brachial_arteryl', A, 'l', 'arm', None), ('Brachial_arteryr', A, 'r', 'arm', None),
    ('Deep_brachial_arteryl', A, 'l', 'arm', None), ('Deep_brachial_arteryr', A, 'r', 'arm', None),
    ('Radial_arteryl', A, 'l', 'arm', None), ('Radial_arteryr', A, 'r', 'arm', None),
    ('Ulnar_arteryl', A, 'l', 'arm', None), ('Ulnar_arteryr', A, 'r', 'arm', None),
    ('Deep_palmar_archl', A, 'l', 'arm', None), ('Deep_palmar_archr', A, 'r', 'arm', None),
    ('Superficial_palmar_archl', A, 'l', 'arm', None), ('Superficial_palmar_archr', A, 'r', 'arm', None),
    # ---- pelvis
    ('Common_iliac_arteryl', A, 'l', 'pelvis', None), ('Common_iliac_arteryr', A, 'r', 'pelvis', None),
    ('External_iliac_arteryl', A, 'l', 'pelvis', None), ('External_iliac_arteryr', A, 'r', 'pelvis', None),
    ('Internal_iliac_arteryl', A, 'l', 'pelvis', None), ('Internal_iliac_arteryr', A, 'r', 'pelvis', None),
    # ---- lower limbs
    ('Femoral_arteryl', A, 'l', 'leg', None), ('Femoral_arteryr', A, 'r', 'leg', None),
    ('Deep_femoral_arteryl', A, 'l', 'leg', None), ('Deep_femoral_arteryr', A, 'r', 'leg', None),
    ('Popliteal_arteryl', A, 'l', 'leg', None), ('Popliteal_arteryr', A, 'r', 'leg', None),
    ('Anterior_tibial_arteryl', A, 'l', 'leg', None), ('Anterior_tibial_arteryr', A, 'r', 'leg', None),
    ('Posterior_tibial_arteryl', A, 'l', 'leg', None), ('Posterior_tibial_arteryr', A, 'r', 'leg', None),
    ('Fibular_arteryl', A, 'l', 'leg', None), ('Fibular_arteryr', A, 'r', 'leg', None),
    ('Dorsalis_pedis_arteryl', A, 'l', 'leg', None), ('Dorsalis_pedis_arteryr', A, 'r', 'leg', None),
    # ---- neck veins
    ('Internal_jugular_veinl', V, 'l', 'neck', None), ('Internal_jugular_veinr', V, 'r', 'neck', None),
    ('External_jugular_veinl', V, 'l', 'neck', None), ('External_jugular_veinr', V, 'r', 'neck', None),
    ('Left_subclavian_vein', V, 'l', 'arm', None), ('Right_subclavian_vein', V, 'r', 'arm', None),
    ('Right_brachiocephalic_vein', V, 'r', 'thorax', ('female',)), ('Left_brachiocephalic_vein', V, 'l', 'thorax', ('female',)),
    # ---- thorax veins
    ('Internal_thoracic_veinsl', V, 'l', 'thorax', None), ('Internal_thoracic_veinsr', V, 'r', 'thorax', None),
    ('Azygos_vein', V, 'm', 'thorax', None), ('Hemi-azygos_vein', V, 'm', 'thorax', None), ('Accessory_hemi-azygos_vein', V, 'm', 'thorax', None),
    # ---- upper limb veins
    ('Axillary_veinl', V, 'l', 'arm', None), ('Axillary_veinr', V, 'r', 'arm', None),
    ('Brachial_veinsl', V, 'l', 'arm', None), ('Brachial_veinsr', V, 'r', 'arm', None),
    ('Cephalic_veinl', V, 'l', 'arm', None), ('Cephalic_veinr', V, 'r', 'arm', None),
    ('Basilic_veinl', V, 'l', 'arm', None), ('Basilic_veinr', V, 'r', 'arm', None),
    ('Median_cubital_veinl', V, 'l', 'arm', None), ('Median_cubital_veinr', V, 'r', 'arm', None),
    # ---- pelvis veins (the HRA male has external iliac veins, the female does not)
    ('External_iliac_veinl', V, 'l', 'pelvis', ('female',)), ('External_iliac_veinr', V, 'r', 'pelvis', ('female',)),
    # ---- lower limb veins
    ('Femoral_veinl', V, 'l', 'leg', None), ('Femoral_veinr', V, 'r', 'leg', None),
    ('Popliteal_veinl', V, 'l', 'leg', None), ('Popliteal_veinr', V, 'r', 'leg', None),
    ('Great_saphenous_veinl', V, 'l', 'leg', None), ('Great_saphenous_veinr', V, 'r', 'leg', None),
    ('Small_saphenous_veinl', V, 'l', 'leg', None), ('Small_saphenous_veinr', V, 'r', 'leg', None),
]
# Z-Anatomy vessels that HRA already has, mapped only to locate the junctions (never output)
REFERENCE = [
    ('Brachiocephalic_trunk', A, 'm', 'thorax'), ('Abdominal_aorta', A, 'm', 'pelvis'), ('Aortic_arch', A, 'm', 'thorax'),
    ('Superior_vena_cava', V, 'm', 'thorax'), ('Right_brachiocephalic_vein', V, 'r', 'thorax'), ('Left_brachiocephalic_vein', V, 'l', 'thorax'),
    ('Common_iliac_veinl', V, 'l', 'pelvis'), ('Common_iliac_veinr', V, 'r', 'pelvis'),
    ('External_iliac_veinl', V, 'l', 'pelvis'), ('External_iliac_veinr', V, 'r', 'pelvis'),
    ('Left_renal_artery', A, 'l', 'pelvis'), ('Right_renal_artery', A, 'r', 'pelvis'),
]

ZA_C3_Y, ZA_C1_Y = None, None
REFINE = 0.004      # Z-Anatomy vessel meshes are refined to edges of at most 4 mm before mapping (vessels_geom.refine)
_ZA = {}


def za_mesh(name):
    """Z-Anatomy vessel mesh, refined (conforming edge bisection, shape unchanged) so that every deformation is sampled
    at least every 4 mm: the source meshes are coarse (the popliteal artery has 425 vertices and 2 cm long faces, whose
    interiors cut through a bone when only their vertices are pushed out of it)."""
    if name not in _ZA:
        from fit.vessels_geom import refine
        v, f = source('za-cardio').get(name)
        _ZA[name] = refine(v, f, REFINE)
    return _ZA[name]


def specs(sex):
    """[(za_name, part, side, region)] placed in this body, and the reference-only ones."""
    out = [(n, p, s, r) for n, p, s, r, sx in VESSELS if sx is None or sex in sx]
    names = {o[0] for o in out}
    ref = [(n, p, s, r) for n, p, s, r in REFERENCE if n not in names]
    return out, ref


def work_dir(sex):
    d = os.path.join(FIT, sex, GROUP, 'work'); os.makedirs(d, exist_ok=True); return d


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def head_weight(x):
    global ZA_C3_Y, ZA_C1_Y
    if ZA_C3_Y is None:
        zs = source('za-skeletal')
        ZA_C3_Y = float(zs.get('Vertebra_C3')[0][:, 1].mean()); ZA_C1_Y = float(zs.get('Atlas_(C1)')[0][:, 1].mean())
    return smoothstep((x[:, 1] - ZA_C3_Y) / (ZA_C1_Y - ZA_C3_Y))


def sources_signature(sex, key):
    """Modification times of the files a cached map depends on."""
    f = []
    if key == 'trunk': f = [os.path.join(FIT, sex, 'warp-trunk.npz')]
    elif key == 'head': f = [os.path.join(FIT, sex, 'skull', 'work', n) for n in ('head_warp.npz', 'field.npz')]
    elif key.startswith('arm-'): f = [os.path.join(FIT, sex, 'arms', 'cache', f'maps-{key[-1]}.json')]
    elif key.startswith('leg-'): f = [os.path.join(FIT, sex, 'foot', n) for n in (f'pose-{key[-1]}.json', f'warp-leg_{key[-1]}.npz')]
    elif key == 'skel': f = [os.path.join(FIT, sex, g, 'manifest.json') for g in ('ribcage', 'arms')] + [os.path.join(FIT, sex, 'warp-trunk.npz')]
    return ';'.join(f'{os.path.basename(x)}:{os.path.getmtime(x):.0f}' if os.path.exists(x) else f'{os.path.basename(x)}:none' for x in f)


class Cache:
    """Per-name cached outputs of one map: .cache/fit/<sex>/vessels/work/map-<key>.npz (discarded when the files the
    map is computed from have changed)."""

    def __init__(self, sex, key):
        self.path = os.path.join(work_dir(sex), f'map-{key}-r{int(round(REFINE * 1e4))}.npz')
        self.sig = sources_signature(sex, key)
        self.d = dict(np.load(self.path)) if os.path.exists(self.path) else {}
        if str(self.d.pop('__sig__', '')) != self.sig: self.d = {}
        self.dirty = False

    def get(self, name, compute):
        if name not in self.d:
            self.d[name] = compute(); self.dirty = True
        return self.d[name]

    def save(self):
        if self.dirty: np.savez(self.path, __sig__=np.array(self.sig), **self.d); self.dirty = False


SKEL_STEP, ZERO_STEP = 0.010, 0.016     # control-point spacing on displaced / fixed bones (m)
SKEL_NEAR, SKEL_FAR = 0.020, 0.050      # the correction fades out between these distances from the nearest control point
SKEL_SMOOTH = 2e-4                      # thin-plate smoothing
ZERO_BONES = r'^(Atlas_\(C1\)|Axis_\(C2\)|Vertebra_[CTL]\d+|Sacrum|Coccyx|Hip_bone[lr])$'
ZERO_VESSELS = ('Ascending_aorta', 'Aortic_arch', 'Brachiocephalic_trunk', 'Thoracic_aorta', 'Superior_vena_cava', 'Pulmonary_trunk')


def voxel_pick(p, h):
    """Indices of one point per occupied voxel of size h."""
    k = np.floor(p / h).astype(np.int64)
    _, idx = np.unique(k, axis=0, return_index=True)
    return np.sort(idx)


class SkelCorrection:
    """d(x): smooth correction of the trunk warp toward the bones the rib cage and arms groups placed.

    Control points: Z-Anatomy vertices (one per 10 mm voxel) of the placed ribs, costal cartilages, sternum, clavicles
    and scapulae, each with d = placed(X) - T(X) (the placed bones keep Z-Anatomy's vertex order), and fixed points
    (d = 0, one per 16 mm voxel) on the vertebrae, sacrum, coccyx and hip bones (the warp's own anchors) and on the
    Z-Anatomy great vessels the trunk warp fits to the HRA ones (ascending aorta, arch, brachiocephalic trunk, thoracic
    aorta, superior vena cava, pulmonary trunk). d is interpolated by a thin-plate spline (scipy RBFInterpolator,
    biharmonic kernel, light smoothing), so it varies smoothly along a vessel that passes cartilages and intercostal
    spaces (a nearest-bone average makes such a vessel zig-zag where neighbouring bones moved differently: the female
    trunk warp puts the right third costal cartilage 8 cm from where the rib cage group placed it), and it is faded out
    between 20 and 50 mm from the nearest control point. The humerus is left out: the free limb is the arm map's."""

    def __init__(self, sex, trunk):
        import json
        from scipy.spatial import cKDTree
        from scipy.interpolate import RBFInterpolator
        from lib.mesh import load
        path = os.path.join(work_dir(sex), 'skel-tps.npz'); sig = sources_signature(sex, 'skel') + f';v2;{SKEL_STEP};{ZERO_STEP}'
        d = dict(np.load(path)) if os.path.exists(path) else {}
        if str(d.get('sig', '')) != sig:
            zs = source('za-skeletal'); X, D = [], []
            for g in ('ribcage', 'arms'):
                for o in json.load(open(os.path.join(FIT, sex, g, 'manifest.json'))):
                    if g == 'arms' and not o['name'].startswith(('Clavicle', 'Scapula', 'clavicle', 'scapula')): continue
                    if o['part'] == 'discs' or not o['source']: continue
                    zv = zs.get(o['source'][0])[0]; pv = load(os.path.join(FIT, sex, g, o['file']))[0]
                    if len(zv) != len(pv): continue
                    i = voxel_pick(zv, SKEL_STEP); X.append(zv[i]); D.append(pv[i] - trunk()(zv[i]))
            import re as _re
            for n in zs.names():
                if _re.match(ZERO_BONES, n):
                    zv = zs.get(n)[0]; i = voxel_pick(zv, ZERO_STEP); X.append(zv[i]); D.append(np.zeros((len(i), 3)))
            zc = source('za-cardio')
            for n in ZERO_VESSELS:
                if n in zc.by_name:
                    zv = zc.get(n)[0]; i = voxel_pick(zv, ZERO_STEP); X.append(zv[i]); D.append(np.zeros((len(i), 3)))
            X = np.concatenate(X); D = np.concatenate(D)
            i = voxel_pick(X, 0.008); X, D = X[i], D[i]
            d = dict(X=X, D=D, sig=np.array(sig)); np.savez(path, **d)
        self.X, self.D = d['X'], d['D']; self.tree = cKDTree(self.X)
        import pickle
        pk = path[:-4] + '.pkl'
        try:
            sg, self.rbf = pickle.load(open(pk, 'rb'))
            if sg != sig: raise ValueError
        except Exception:
            self.rbf = RBFInterpolator(self.X, self.D, kernel='linear', degree=1, smoothing=SKEL_SMOOTH)
            pickle.dump((sig, self.rbf), open(pk, 'wb'))

    def __call__(self, x, chunk=4000):
        x = np.atleast_2d(np.asarray(x, float))
        out = np.zeros_like(x)
        dist, _ = self.tree.query(x)
        fade = smoothstep((SKEL_FAR - dist) / (SKEL_FAR - SKEL_NEAR))
        m = np.flatnonzero(fade > 0)
        for k in range(0, len(m), chunk):
            j = m[k:k + chunk]; out[j] = fade[j, None] * self.rbf(x[j])
        return out


class Mapper:
    """Lazily loaded maps for one body; map_vessel(name, side, region) -> mapped vertices, with the blend weights."""

    def __init__(self, sex):
        self.sex = sex; self._trunk = self._head = self._skel = None; self._arm = {}; self._leg = {}
        self.caches = {}

    def skel(self):
        if self._skel is None: self._skel = SkelCorrection(self.sex, self.trunk)
        return self._skel

    def cache(self, key):
        if key not in self.caches: self.caches[key] = Cache(self.sex, key)
        return self.caches[key]

    def trunk(self):
        if self._trunk is None:
            from fit.common import get_warp
            log(self.sex, 'loading trunk warp'); self._trunk = get_warp(self.sex, 'trunk')
        return self._trunk

    def head(self):
        if self._head is None:
            from fit.skull import head_map
            log(self.sex, 'loading head map'); self._head = head_map(self.sex)
        return self._head

    def arm(self, s):
        if s not in self._arm:
            from fit.arms import arm_deform
            self._arm[s] = arm_deform(self.sex, s)
        return self._arm[s]

    def leg(self, s):
        if s not in self._leg:
            from fit.foot import leg_deform
            log(self.sex, 'loading leg map', s); self._leg[s] = leg_deform(self.sex, s)
        return self._leg[s]

    def map_vessel(self, name, side, region):
        """-> (mapped vertices (n, 3), dict of blend weights h, a, g per vertex)."""
        x = za_mesh(name)[0]
        T = self.cache('trunk').get(name, lambda: self.trunk()(x))
        h = head_weight(x) if region in ('neck', 'head', 'thorax', 'arm') else np.zeros(len(x))
        dsk = self.skel()(x)
        out = T + dsk
        if (h > 0).any():
            def hm():
                r = np.zeros_like(x); m = h > 0; r[m] = self.head()(x[m]); return r
            H = self.cache('head').get(name, hm)
            out = (1 - h)[:, None] * out + h[:, None] * H
        a = np.zeros(len(x)); g = np.zeros(len(x))
        if region in ('neck', 'thorax', 'arm'):
            # the arm blend by position (arm_deform's weight is 0 on the chest wall and spine, 1 on the girdle and limb),
            # so vessels that meet at the root of the neck or in the axilla get the same map
            for s_ in (('l', 'r') if side == 'm' else (side,)):
                def am(s_=s_):
                    f, w = self.arm(s_); return np.concatenate([f(x), w(x)[:, None]], 1)
                AW = self.cache(f'arm-{s_}').get(name, am)
                sel = np.ones(len(x), bool) if side != 'm' else ((x[:, 0] > 0) == (s_ == 'l'))
                a_s = np.where(sel, AW[:, 3] * (1 - h), 0.0)
                out = (1 - a_s)[:, None] * out + a_s[:, None] * AW[:, :3]
                a = a + a_s
        if side in 'lr' and region == 'leg':
            def lm():
                L = self.leg(side); return np.concatenate([L(x), L.hip_weight(x)[:, None]], 1)
            LW = self.cache(f'leg-{side}').get(name, lm)
            g = LW[:, 3]
            out = (1 - g)[:, None] * out + g[:, None] * LW[:, :3]
        return out, dict(h=h, a=a, g=g, skel=np.linalg.norm(dsk, axis=1))

    def save(self):
        for c in self.caches.values(): c.save()
