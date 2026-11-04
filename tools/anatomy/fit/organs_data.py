"""Organs fit, part 1: inputs and cached intermediates.

  warped(sex)        the Z-Anatomy stomach, oesophagus, diaphragm, suprarenal glands, thyroid and parathyroid glands (and,
                     as a fallback for the diaphragm's costal attachments, the lower ribs and costal cartilages) through
                     the cached trunk warp; cached per sex, keyed on the warp file, because building the warp is slow
  hra(sex, key)      merged HRA neighbour meshes by key, each component oriented outward
  field(sex, key)    signed distance field of a neighbour (voxel inside test + exact surface distance), cached
  vertebrae(sex)     per-vertebra body centre and body height range (C3-L5), for vertebral levels
  ribs(sex)          lower ribs and costal cartilages: the ribcage group's fitted meshes when present, else warped ZA ones
"""
import os, sys, json, re, time
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, save, load, orient_outward, merge, components  # noqa: E402
from fit.common import get_warp, hra_mesh, hra_select, za_whole, FIT  # noqa: E402
from catalog import LOBE_PATH  # noqa: E402

GROUP = 'organs'
T0 = time.time()


def out_dir(sex):
    return os.path.join(FIT, sex, GROUP)


def cache_dir(sex):
    d = os.path.join(out_dir(sex), 'cache'); os.makedirs(d, exist_ok=True); return d


def log(*a):
    print(f'[{time.time() - T0:7.1f}s]', *a, flush=True)


# ------------------------------------------------------------------------------------------------ Z-Anatomy inputs
ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']
ZA = {
    'stomach': ('za-visceral', r'^Stomach$'),
    'esophagus': ('za-visceral', r'^Oesophagus$'),
    'diaphragm': ('za-muscular', r'^Diaphragm$'),
    'adrenal_l': ('za-visceral', r'^Suprarenal_glandl$'),
    'adrenal_r': ('za-visceral', r'^Suprarenal_glandr$'),
    'thyroid': ('za-visceral', r'^Thyroid_gland$'),
    'pth_sup_l': ('za-visceral', r'^Superior_parathyroid_glandl$'),
    'pth_sup_r': ('za-visceral', r'^Superior_parathyroid_glandr$'),
    'pth_inf_l': ('za-visceral', r'^Inferior_parathyroid_glandl$'),
    'pth_inf_r': ('za-visceral', r'^Inferior_parathyroid_glandr$'),
    'xiphoid': ('za-skeletal', r'^Xiphoid_process$'),
    'sternum_body': ('za-skeletal', r'^Body_of_sternum$'),
    # references that are not placed: cartilages and kidneys for local re-registration, vessels for the openings
    'ref_thyroid_cart': ('za-skeletal', r'^Thyroid_cartilage$'),
    'ref_cricoid': ('za-skeletal', r'^Cricoid_cartilage$'),
    'ref_trachea': ('za-visceral', r'^Trachea$'),
    'ref_kidney_l': ('za-visceral', r'^Kidneyl$'),
    'ref_kidney_r': ('za-visceral', r'^Kidneyr$'),
    'ref_ivc': ('za-cardio', r'^Inferior_vena_cava_\((thoracic|abdominal)_part\)$'),
    'ref_aorta': ('za-cardio', r'^(Thoracic_aorta|Abdominal_aorta)$'),
    'ref_liver': ('za-visceral', r'^Liver$'),
}
for i in range(6, 12 + 1):
    for s in 'lr':
        ZA[f'rib_{i}_{s}'] = ('za-skeletal', rf'^{ORD[i - 1].capitalize()}_rib{s}$')
        if i <= 10: ZA[f'costal_cartilage_{i}_{s}'] = ('za-skeletal', rf'^Costal_cartilage_of_{ORD[i - 1]}_rib{s}$')

ZA_NAMES = {k: None for k in ZA}


def za_mesh(key):
    src, rx = ZA[key]
    es = za_whole(src, rx)
    if not es or (len(es) != 1 and not key.startswith('ref_')): raise SystemExit(f'{key}: expected one Z-Anatomy mesh for {rx}, found {len(es)}')
    ZA_NAMES[key] = es[0]['name'] if len(es) == 1 else [o['name'] for o in es]
    return source(src).load(es)


def _warp_stamp(sex):
    p = os.path.join(FIT, sex, 'warp-trunk.npz'); st = os.stat(p)
    return f'{st.st_size}-{int(st.st_mtime)}'


def warped(sex):
    """{key: (v, f)} Z-Anatomy meshes through the trunk warp (cached)."""
    path = os.path.join(cache_dir(sex), 'warped.npz')
    stamp = _warp_stamp(sex)
    if os.path.exists(path):
        d = np.load(path, allow_pickle=False)
        if str(d['stamp']) == stamp and all(f'{k}_v' in d for k in ZA):
            for k in ZA: za_mesh(k) if ZA_NAMES[k] is None else None
            return {k: (d[f'{k}_v'].astype(np.float64), d[f'{k}_f'].astype(np.int64)) for k in ZA}
    log(sex, 'building the trunk warp (slow)')
    W = get_warp(sex, 'trunk')
    out, arrs = {}, {}
    for k in ZA:
        v, f = za_mesh(k)
        w = W(v)
        out[k] = (w, f); arrs[f'{k}_v'] = w; arrs[f'{k}_f'] = f
    np.savez(path, stamp=stamp, **arrs)
    log(sex, 'warped meshes cached')
    return out


def za_original(key):
    return za_mesh(key)


# ------------------------------------------------------------------------------------------------ HRA neighbours
def _rx(*names):
    return r'^VH_[MF]_(?:' + '|'.join(names) + r')$'


HRA = {
    'liver': _rx('liver_capsule', 'capsule_of_the_liver', 'bare_area_of_liver', 'diaphragmatic_surface', 'diaphragmatic_surface_of_liver',
                 '(suprarenal|renal|gastric|colic|esophageal|duodenal)_impression_of_liver', 'porta_hepatis'),
    'liver_gastric': _rx('gastric_impression_of_liver'),
    'liver_esoph': _rx('esophageal_impression_of_liver'),
    'liver_suprarenal': _rx('suprarenal_impression_of_liver'),
    'liver_renal': _rx('renal_impression_of_liver'),
    'liver_diaph': _rx('diaphragmatic_surface', 'diaphragmatic_surface_of_liver'),
    'liver_bare': _rx('bare_area_of_liver'),
    'gallbladder': _rx('gallbladder'),
    'spleen': _rx('diaphragmatic_surface_of_spleen', 'gastric_surface_of_spleen', 'renal_surface_of_spleen', 'colic_surface_of_spleen',
                  'hilum_of_spleen'),
    'spleen_gastric': _rx('gastric_surface_of_spleen'),
    'spleen_diaph': _rx('diaphragmatic_surface_of_spleen'),
    'pancreas': _rx('head_of_pancreas', 'neck_of_pancreas', 'body_of_pancreas', 'tail_of_pancreas', 'uncinate_process_of_the_pancreas'),
    'duo_sup': _rx('duodenum_superior'),
    # the duodenal ampulla (bulb) is the first duodenal segment: the pylorus opens into its free lipped end (HRA files it
    # under duodenum_superior, as its own mesh)
    'duo_bulb': _rx('duodenal_ampulla'),
    'duodenum': _rx('duodenal_ampulla', 'duodenum_superior', 'duodenum_descending', 'duodenum_horizonal', 'duodenum_horizontal', 'duodenum_ascending'),
    # the splenic artery and vein run in the stomach bed, behind its posterior wall (along the pancreas's upper border)
    'splenic_a': _rx('splenic_artery'),
    'splenic_v': _rx('splenic_vein'),
    'jejunum': _rx('jejunum'),
    'colon': _rx('transverse_colon', 'splenic_flexure_of_colon', 'hepatic_flexure_of_colon', 'descending_colon', 'ascending_colon'),
    'kidney_l': _rx('kidney_capsule_L', 'hilum_of_kidney_L', 'outer_cortex_of_kidney_L'),
    'kidney_r': _rx('kidney_capsule_R', 'hilum_of_kidney_R', 'outer_cortex_of_kidney_R'),
    'kidney_l_capsule': _rx('kidney_capsule_L'),
    'kidney_r_capsule': _rx('kidney_capsule_R'),
    'ivc': _rx('inferior_vena_cava_a', 'inferior_vena_cava_b'),
    'aorta': _rx('descending_aorta_a', 'descending_aorta_b', 'aortic_arch'),
    'aorta_abd': _rx('descending_aorta_b'),
    'celiac': _rx('celiac_trunk'),
    'trachea': _rx('trachea'),
    'trach_cart': _rx('tracheal_cartilage'),
    'bronchi': _rx('left_main_bronchus', 'right_main_bronchus', 'cartilage_of_the_main_bronchus_[LR]', 'cartilage_of_main_bronchus_[LR]'),
    'cricoid': _rx('cricoid_cartilage'),
    'thyroid_cart': _rx('thyroid_cartilage'),
    'la': _rx('left_cardiac_atrium'),
    'heart': _rx('left_cardiac_atrium', 'right_cardiac_atrium', 'heart_left_ventricle', 'left_ventricle', 'heart_right_ventricle', 'right_ventricle'),
    # the coronary arteries and cardiac veins on the heart's surface (the posterior interventricular vessels, the middle
    # and small cardiac veins and the coronary sinus stand proud of the chambers on its diaphragmatic surface): the
    # same selection as assemble.py's liver carve list (its CORONARY / CARDIAC_VEINS patterns)
    'heart_vessels': ('path', r'blood_vasculature_of_heart/.*(coronary_artery|anterior_descending|circumflex|diagonal_branch|left_marginal_branch|'
                              r'right_marginal_artery|posterior_descending|posterior_left_ventricular|right_posterior_descending|'
                              r'cardiac_vein|coronary_sinus|oblique_vein_of_left_atrium|posterior_vein_of_left_ventricle|left_marginal_vein)'),
}
LOBES = list(LOBE_PATH)
for lobe in LOBES: HRA[lobe] = ('path', LOBE_PATH[lobe] + r'(?!.*hilum)[^/]*segme')
VERTS = [f'C{i}' for i in range(3, 8)] + [f'T{i}' for i in range(1, 13)] + [f'L{i}' for i in range(1, 6)]
VNAME = {**{f'C{i}': f'cervical_vertebra_{i}' for i in range(3, 8)}, **{f'T{i}': f'thoracic_vertebra_{i}' for i in range(1, 13)},
         **{f'L{i}': f'lumbar_vertebra_{i}' for i in range(1, 6)}}
for k, n in VNAME.items(): HRA[k] = _rx(n)

_HRA_CACHE = {}


class MissingHRA(KeyError):
    pass


def has_hra(sex, key):
    try: hra(sex, key); return True
    except MissingHRA: return False


def hra(sex, key):
    """Merged HRA mesh for a neighbour key, each connected component oriented outward."""
    ck = (sex, key)
    if ck in _HRA_CACHE: return _HRA_CACHE[ck]
    if key == 'lungs':
        m = merge([hra(sex, k) for k in LOBES])
    elif key == 'spine':
        m = merge([hra(sex, k) for k in VERTS if k[0] in 'TL'])
    elif key == 'ribs':
        m = merge(list(ribs(sex)[0].values()))
    else:
        sel = HRA[key]
        v, f = hra_mesh(sex, sel)
        if not len(f): raise MissingHRA(f'{sex}: no HRA mesh for {key}')
        m = (v, orient_outward(v, f))
    _HRA_CACHE[ck] = m
    return m


# ------------------------------------------------------------------------------------------------ fields
from fit.organs_geom import Field  # noqa: E402

_FIELDS = {}
FIELD_H = {'lungs': 0.001, 'ribs': 0.0008, 'trach_cart': 0.0005, 'cricoid': 0.0005, 'thyroid_cart': 0.0005, 'bronchi': 0.0006, 'celiac': 0.0006, 'trachea': 0.0006,
           'heart_vessels': 0.0005, 'splenic_a': 0.0005, 'splenic_v': 0.0006, 'duo_bulb': 0.0005}
# open-ended tubes (and chambers with vessel openings): boundary loops are capped before filling
FIELD_CAP = {'ivc', 'aorta', 'aorta_abd', 'duo_sup', 'duo_bulb', 'duodenum', 'colon', 'jejunum', 'trachea', 'bronchi', 'celiac', 'la', 'heart', 'heart_vessels',
             'splenic_a', 'splenic_v'}
# hollow tubes whose wall is a closed double shell (the lumen stays open at the ends, so a flood fill leaves it out):
# each horizontal cross-section is filled (its convex hull), so that the lumen counts as inside the organ
SLICE_FILL = {'ivc', 'trachea', 'bronchi'}


def field(sex, key, h=None):
    ck = (sex, key)
    if ck in _FIELDS: return _FIELDS[ck]
    h = h or FIELD_H.get(key, 0.0008)
    tag = key
    if key == 'ribs':                        # the ribcage group may rewrite its meshes: key the cache on its manifest
        man = os.path.join(FIT, sex, 'ribcage', 'manifest.json')
        tag = 'ribs-' + (f'fit{int(os.stat(man).st_mtime)}' if ribs(sex)[1] == 'ribcage group' else 'za')
        for old in os.listdir(cache_dir(sex)):
            if old.startswith('field-ribs-') and old != f'field-{tag}.npz': os.remove(os.path.join(cache_dir(sex), old))
    if key in SLICE_FILL: tag = key + '-filled'
    path = os.path.join(cache_dir(sex), f'field-{tag}.npz')
    v, f = hra(sex, key)
    crop = None
    if key == 'lungs':                       # only the bases matter here
        crop = (v.min(0) - 0.02, np.array([9, v[:, 1].min() + 0.17, 9]))
    fl = Field.cached(v, f, h, path, cap=key in FIELD_CAP, slice_axis=1 if key in SLICE_FILL else None, crop=crop)
    _FIELDS[ck] = fl
    return fl


# ------------------------------------------------------------------------------------------------ vertebral levels
def vertebrae(sex):
    """{name: dict(centre, lo, hi)} vertebral bodies: the anterior third of each vertebra (by depth) is its body."""
    path = os.path.join(cache_dir(sex), 'vertebrae.json')
    if os.path.exists(path): return json.load(open(path))
    out = {}
    for k in VERTS:
        v, f = hra(sex, k)
        z0, z1 = v[:, 2].min(), v[:, 2].max()
        body = v[v[:, 2] > z1 - 0.33 * (z1 - z0)]
        # the body is the large anterior block: trim the few anterior vertices of processes by a y-percentile window
        lo, hi = np.percentile(body[:, 1], [1, 99])
        out[k] = dict(centre=body.mean(0).tolist(), lo=float(lo), hi=float(hi), front_z=float(z1))
    json.dump(out, open(path, 'w'), indent=1)
    return out


def level(sex, y):
    """Continuous vertebral level of height y: the index in VERTS interpolated between body centres (C3 = 0)."""
    V = vertebrae(sex)
    c = np.array([V[k]['centre'][1] for k in VERTS])
    i = np.arange(len(VERTS), dtype=float)
    return float(np.interp(-y, -c, i))


def level_name(x):
    i = int(np.clip(np.round(x), 0, len(VERTS) - 1))
    frac = x - np.round(x)
    return VERTS[i] + ('' if abs(frac) < 0.25 else (' lower' if frac > 0 else ' upper'))


def level_index(name):
    return VERTS.index(name)


# ------------------------------------------------------------------------------------------------ ribs
def ribs(sex):
    """{name: (v, f)} lower ribs (6-12), costal cartilages (6-10) and the xiphoid, from the ribcage group when it has
    written them, else the warped Z-Anatomy ones. Returns (meshes, source label)."""
    d = os.path.join(FIT, sex, 'ribcage')
    man = os.path.join(d, 'manifest.json')
    want = [f'rib_{i}_{s}' for i in range(6, 13) for s in 'lr'] + [f'costal_cartilage_{i}_{s}' for i in range(6, 11) for s in 'lr'] + ['xiphoid', 'sternum_body']
    if os.path.exists(man):
        names = {o['name']: o['file'] for o in json.load(open(man))}
        if all(w in names for w in want):
            out = {}
            for w in want:
                v, f = load(os.path.join(d, names[w])); out[w] = (v, orient_outward(v, f))
            return out, 'ribcage group'
    W = warped(sex)
    return {w: (W[w][0], orient_outward(*W[w])) for w in want}, 'Z-Anatomy through the trunk warp'


def vessel_centreline(v, step=0.002, axis=1):
    """Centroids of slices of a (roughly vertical) vessel mesh, top to bottom: (n, 3)."""
    y = v[:, axis]
    out = []
    for t in np.arange(y.max() - step / 2, y.min(), -step):
        m = np.abs(y - t) < step / 2
        if m.sum() >= 6: out.append(v[m].mean(0))
    return np.array(out)
