"""What the vessels group places, and the deformation that carries each Z-Anatomy vessel into an HRA body.

Each Z-Anatomy (za-cardio) vertex x goes through
    trunk warp   T(x) = fit.common.get_warp(sex, 'trunk')(x)                 (trunk, neck, head)
    head map     H(x) = fit.skull.head_map(sex)(x)                            (the skull as placed by the skull group)
    arm map      A_s(x), w_s(x) = fit.arms.arm_deform(sex, s)                 (shoulder girdle and free limb of side s)
    leg map      L_s(x), hip_s(x) = fit.foot.leg_deform(sex, s), .hip_weight  (thigh to toes of side s)
blended as
    x1 = (1 - h) T + h H            h = smoothstep of the Z-Anatomy height from the C3 to the C1 vertebral body
    x2 = (1 - a) x1 + a A_s         a = w_s(x) (1 - h), for vessels of side s above the pelvis
    x3 = (1 - g) x2 + g L_s         g = hip_s(x), for the femoral vessels and everything below them
The trunk warp is corrected near the bones other groups placed from Z-Anatomy with a shape of their own (rib cage:
ribs, costal cartilages, sternum; arms: clavicle, scapula, humerus): the placed bones keep Z-Anatomy's vertex order, so
each bone vertex X has a displacement d = placed(X) - T(X); vessel points within 15 mm of those bones get the Gaussian
average of d (sigma 6 mm) of their nearest bone vertices, faded out from 4 to 15 mm (vessels lying against a bone follow
it; the roots of the great vessels, 1.5-3 cm behind the manubrium, keep the warp that fits them to the HRA vessels). Vertebrae, sacrum and hip bones
(the warp's own anchors) take part with d = 0. In the male the placed manubrium's notches lie 9 / 24 mm from where the
trunk warp puts them (female 12 / 38 mm), so without this the internal thoracic vessels and the roots of the neck
vessels would not follow the sternum and clavicles they lie against.
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
        self.path = os.path.join(work_dir(sex), f'map-{key}.npz')
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


SKEL_SIGMA, SKEL_NEAR, SKEL_FAR, SKEL_STEP = 0.006, 0.004, 0.015, 0.0025
ZERO_BONES = r'^(Atlas_\(C1\)|Axis_\(C2\)|Vertebra_[CTL]\d+|Sacrum|Coccyx|Hip_bone[lr])$'


def voxel_pick(p, h):
    """Indices of one point per occupied voxel of size h."""
    k = np.floor(p / h).astype(np.int64)
    _, idx = np.unique(k, axis=0, return_index=True)
    return np.sort(idx)


class SkelCorrection:
    """d(x): displacement of the trunk warp toward the bones placed by the rib cage and arms groups (see the docstring)."""

    def __init__(self, sex, trunk):
        import json
        from scipy.spatial import cKDTree
        from lib.mesh import load
        path = os.path.join(work_dir(sex), 'skel-corr.npz'); sig = sources_signature(sex, 'skel')
        d = dict(np.load(path)) if os.path.exists(path) else {}
        if str(d.get('sig', '')) != sig:
            zs = source('za-skeletal'); X, D = [], []
            for g in ('ribcage', 'arms'):
                for o in json.load(open(os.path.join(FIT, sex, g, 'manifest.json'))):
                    if g == 'arms' and not o['name'].startswith(('Clavicle', 'Scapula', 'Humerus')): continue
                    if o['part'] == 'discs' or not o['source']: continue
                    zv = zs.get(o['source'][0])[0]; pv = load(os.path.join(FIT, sex, g, o['file']))[0]
                    if len(zv) != len(pv): continue
                    i = voxel_pick(zv, SKEL_STEP); X.append(zv[i]); D.append(pv[i] - trunk()(zv[i]))
            import re as _re
            for n in zs.names():
                if _re.match(ZERO_BONES, n):
                    zv = zs.get(n)[0]; i = voxel_pick(zv, SKEL_STEP); X.append(zv[i]); D.append(np.zeros((len(i), 3)))
            d = dict(X=np.concatenate(X), D=np.concatenate(D), sig=np.array(sig)); np.savez(path, **d)
        self.X, self.D = d['X'], d['D']; self.tree = cKDTree(self.X)

    def __call__(self, x, k=48):
        dist, idx = self.tree.query(x, k=k)
        K = np.exp(-0.5 * (dist / SKEL_SIGMA) ** 2) + 1e-30
        avg = np.einsum('ij,ijk->ik', K, self.D[idx]) / K.sum(1, keepdims=True)
        fade = smoothstep((SKEL_FAR - dist[:, 0]) / (SKEL_FAR - SKEL_NEAR))
        return fade[:, None] * avg


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
        x = source('za-cardio').get(name)[0]
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
        if side in 'lr' and region == 'arm':
            def am():
                f, w = self.arm(side); return np.concatenate([f(x), w(x)[:, None]], 1)
            AW = self.cache(f'arm-{side}').get(name, am)
            a = AW[:, 3] * (1 - h)
            out = (1 - a)[:, None] * out + a[:, None] * AW[:, :3]
        if side in 'lr' and region == 'leg':
            def lm():
                L = self.leg(side); return np.concatenate([L(x), L.hip_weight(x)[:, None]], 1)
            LW = self.cache(f'leg-{side}').get(name, lm)
            g = LW[:, 3]
            out = (1 - g)[:, None] * out + g[:, None] * LW[:, :3]
        return out, dict(h=h, a=a, g=g, skel=np.linalg.norm(dsk, axis=1))

    def save(self):
        for c in self.caches.values(): c.save()
