"""Step 4 of the anatomy build: combine HRA structures and the fitted Z-Anatomy structures into the app's parts.

  python3 tools/anatomy/assemble.py [male|female|all]

For each body writes tools/anatomy/.cache/parts/<sex>/<part>.npz (app frame: metres, soles at y = 0, body centred on
x = z = 0) and rig.json: the frame offset, height and bounds, each part's organ/tissue/flags/bounds, organ pins and
named landmark positions. build.mjs turns these into public/models/anatomy-<sex>.glb and src/anatomy/bodies/<sex>.json.
"""
import json, os, re, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib.mesh import (source, merge, remesh_solid, remesh_solids, orient_exact, facing, RayParity, closest_on_mesh, dense_points,  # noqa: E402
                      laplacian_smooth_field, face_normals, signed_volume, save, load, components, CACHE, compact)
from catalog import PARTS, HRA_EXCLUDE, LOBE_PATH  # noqa: E402

OUT = os.path.join(CACHE, 'parts')
FIT = os.path.join(CACHE, 'fit')

# HRA structures per part, as regexes on the node path. mode: 'merge' (use the meshes as they are, outward-oriented) or
# 'solid' (rebuild one closed surface per `split` group from overlapping surface patches). carve: [(path regex, margin)]
# solids removed from a rebuilt surface, grown by the margin (room for a neighbour the HRA patches run into).
ARTERIES = (r'(aort|_artery|arteries|celiac_trunk|marginal_artery|pulmonary_vein_)')
CORONARY = r'(coronary_artery|anterior_descending|circumflex|diagonal_branch|left_marginal_branch|right_marginal_artery|posterior_descending|posterior_left_ventricular|right_posterior_descending)'
CARDIAC_VEINS = r'(cardiac_vein|coronary_sinus|oblique_vein_of_left_atrium|posterior_vein_of_left_ventricle|left_marginal_vein)'
HEPATIC_ARTERIES = r'(hepatic_artery|cystic_artery|segmental_right_hepatic)'
PORTAL = r'(portal_vein|splenic_vein|mesenteric_vein|colic_vein|ileocolic_vein|sigmoid_vein|superior_rectal_vein|pancreaticoduodenal_vein|cystic_vein)'
HRA_PARTS = {
    'skin': dict(sel=[r'/VH_[MF]_skin$']),
    'brain': dict(sel=[r'/Allen_brain/', r'/VH_F_optic_chiasm$'], exclude=r'(ventricle|cerebral_aqueduct|central_canal)'),
    'ventricles': dict(sel=[r'/Allen_brain/.*(ventricle|cerebral_aqueduct|central_canal)']),
    'spinal_cord': dict(sel=[r'_spinal_cord/']),
    'eyes': dict(sel=[r'_eyes/', r'_nerves_of_eye/']),
    'eye_muscles': dict(sel=[r'_muscles_of_eye/']),
    'airway': dict(sel=[r'_larynx/', r'tracheobronchial_tree/.*VH_[MF]_(trachea|tracheal_cartilage|carina|left_main_bronchus|right_main_bronchus|cartilage_of_the_main_bronchus_[LR])$'],
                   exclude=r'muscles_of_larynx'),
    'larynx_muscles': dict(sel=[r'_muscles_of_larynx/']),
    'bronchi': dict(sel=[r'tracheobronchial_tree/'], exclude=r'VH_[MF]_(trachea|tracheal_cartilage|carina|left_main_bronchus|right_main_bronchus|cartilage_of_the_main_bronchus_[LR])$'),
    # the five lobes are rebuilt together (remesh_solids): overlaps along the fissures split by depth, the heart, aorta,
    # superior vena cava and thymus that sink into the HRA lobes carved out with 1 mm to spare
    **{lobe: dict(sel=[LOBE_PATH[lobe]], mode='solid', project=False, smooth=10, lobes=True) for lobe in LOBE_PATH},
    'heart': dict(sel=[r'cardiac_chamber/']),
    'valves': dict(sel=[r'(heart_valve|_heart/VH_F_valve)/'], double=True),
    'papillary': dict(sel=[r'papillary_muscle_of_heart/']),
    'coronary': dict(sel=[r'blood_vasculature/.*' + CORONARY]),
    'cardiac_veins': dict(sel=[r'blood_vasculature/.*' + CARDIAC_VEINS]),
    # the pulmonary trunk and arteries carry venous blood: drawn blue with the veins (pulmonary veins stay red)
    'arteries': dict(sel=[r'blood_vasculature/.*' + ARTERIES], exclude=CORONARY + '|' + HEPATIC_ARTERIES + r'|pulmonary_trunk|pulmonary_artery'),
    'veins': dict(sel=[r'blood_vasculature/.*(vena_cava|brachiocephalic_vein|renal_vein|iliac_vein|pudendal_vein|rectal_vein|sacral_vein|uterine_vein|ophthalmic_vein|retinal_vein|pulmonary_trunk|pulmonary_artery)'],
                  exclude=PORTAL + r'|superior_rectal_vein'),
    'hepatic_artery': dict(sel=[r'blood_vasculature/.*' + HEPATIC_ARTERIES]),
    # the HRA heart's diaphragmatic surface sinks into the liver dome: carve the heart and the vessels on its surface
    # (the posterior interventricular vessels and the middle and small cardiac veins stand proud of the chambers) plus
    # 4 mm, the diaphragm's room
    'liver': dict(sel=[r'_liver/'], exclude=r'(ligament|artery|vein|duct|_portal|blood_vasculature)', mode='solid', opening=1,
                  carve=[(r'cardiac_chamber/', 0.004), (r'blood_vasculature_of_heart/.*' + CORONARY, 0.004), (r'blood_vasculature_of_heart/.*' + CARDIAC_VEINS, 0.004)]),
    'liver_ligaments': dict(sel=[r'_liver/.*ligament'], double=True),
    'gallbladder': dict(sel=[r'_gallbladder_/']),
    'bile_ducts': dict(sel=[r'_biliary_tree/']),
    'hepatic_veins': dict(sel=[r'blood_vasculature/.*(right|middle|left)_hepatic_vein']),
    'portal_vein': dict(sel=[r'blood_vasculature/.*' + PORTAL]),
    'spleen': dict(sel=[r'_spleen/'], exclude=r'(artery|vein)', mode='solid', opening=1),
    'pancreas': dict(sel=[r'_pancreas/'], exclude=r'ducts_of_pancreas/', mode='solid', opening=1),  # the ducts are drawn in bile_ducts
    # the HRA renal capsule is a membrane (outer and inner walls 0.3 mm apart, meeting round the hilum): its interior is
    # filled before the surface is rebuilt (lib.mesh._membrane_fill), else the kidney is a shell under 0.5 mm thick
    'kidneys': dict(sel=[r'kidney_capsule_[LR]$', r'hilum_of_kidney_[LR]$'], mode='solid', split=r'_([LR])$', membrane=True),
    'kidney_medulla': dict(sel=[r'renal_(pyramid|papilla)_[LR]']),
    'kidney_pelvis': dict(sel=[r'(minor|major)_calyx', r'renal_pelvis_[LR]$']),
    'ureters': dict(sel=[r'/VH_[MF]_(ureter_[LR]|left_ureter|right_ureter)$']),
    'bladder': dict(sel=[r'_urinary_bladder/', r'_urethra/']),
    'small_int': dict(sel=[r'_small_intestine/']),
    'colon': dict(sel=[r'_colon/']),
    'reproductive': dict(sel=[r'_male_genital_duct/', r'_prostate_gland/', r'/VH_F_vagina', r'_fallopian_tube/', r'_ovary/', r'/VH_F_(left|right)_ovary$',
                              r'_ligaments_of_uterus_and_ovaries/'], double=True),
    # the uterus group only (r'_uterus/' also caught the round and cardinal ligaments, drawn separately); HRA's
    # 'abdominal_ostium_of_uterine_tube' is a 52 mm bar across the fundus, not the tube's opening: left out
    'uterus': dict(sel=[r'/VH_F_uterus/'], exclude=r'(artery|vein|abdominal_ostium)', mode='solid', into='reproductive'),
    'breasts': dict(sel=[r'mammary_gland_[LR]/.*(mammary_lobes|lactiferous)']),
    'skel_skull': dict(sel=[r'/VH_M_hyoid$']),
    'skel_spine': dict(sel=[r'_vertebrae/']),
    'skel_pelvis': dict(sel=[r'_pelvis/.*(compact_bone|sacrum|coccyx)']),
    'marrow': dict(sel=[r'_pelvis/.*spongy_bone']),
    # each leg bone with the surface patches HRA nests under it (condyles, intercondylar fossa, entheses...); the
    # cartilage, menisci and ligaments nested there belong to 'joints'
    'skel_legs': dict(sel=[r'_lower_limb/.*VH_[MF]_(femur|tibia|fibula|patella)_[LR](/|$)'], exclude=r'(ligament|meniscus|articular_cartilage)'),
    'joints': dict(sel=[r'_lower_limb/.*(ligament|meniscus|articular_cartilage)']),
    'thymus': dict(sel=[r'_thymus/']),
}
SPEC = {p[0]: dict(organ=p[1], tissue=p[2], flags=list(p[3]), budget=p[4]) for p in PARTS}
# the HRA male's right lower lobe reaches 3.2 mm into the liver dome: carving it keeps a 3 mm space for the diaphragm
LOBE_CARVE = [(r'cardiac_chamber/', 0.001), (r'blood_vasculature/.*/VH_[MF]_[^/]*aort[^/]*$', 0.001), (r'superior_vena_cava$', 0.001), (r'_thymus/', 0.001),
              (r'_liver/', 0.003)]
INWARD_MAX = 0.01  # a part fails the build when more of its area than this is inside-out (lib.mesh.facing: exact parity test per patch)
THIN_SOLID = 0.002  # a rebuilt solid whose mean thickness (2 V / A) is below this is a shell, not an organ: reported in rig.json

# Thread-thin HRA vessels and ducts inflated radially about their centrelines (inflate_tube) when they are loaded, so the
# lung lobes are carved round the inflated aorta too. name: (('r', median radius) | ('k', scale factor), fade, fade length).
# fade: 'keep_top' / 'keep_bottom' leave the upper / lower end as it is (a junction with a vessel that keeps its size),
# 'only_top' inflates the upper end (an artery's origin) and fades out along the vessel. The male descending aorta is
# 12.5-13.9 mm across (adult 20-25 mm in the thorax, 18-20 mm in the abdomen): both its pieces are scaled by the same factor
# so their junction stays closed, the arch junction and the iliac bifurcation are kept as they are.
INFLATE = {
    'male': {'VH_M_descending_aorta_a': (('k', 1.5), 'keep_top', 0.025), 'VH_M_descending_aorta_b': (('k', 1.5), 'keep_bottom', 0.03),
             'VH_M_left_renal_artery': (('r', 0.0025), None, 0), 'VH_M_right_renal_artery': (('r', 0.0025), None, 0)},
    'female': {'VH_F_common_bile_duct': (('r', 0.0025), None, 0), 'VH_F_common_hepatic_duct': (('r', 0.0025), None, 0),
               'VH_F_superior_mesenteric_artery': (('r', 0.0035), 'only_top', 0.045)},
}
# Faces of a structure that coincide with a neighbour's surface (the HRA colon flexures repeat 85-89 % of the adjoining
# segments' walls, the female interventricular septum repeats the ventricles' walls): (part, structure, neighbours,
# distance) - faces whose vertices and centroid all lie within the distance of a neighbour are dropped.
TRIM = [('colon', r'_hepatic_flexure_of_colon$', r'_(ascending|transverse)_colon$', 0.0003),
        ('colon', r'_splenic_flexure_of_colon$', r'_(transverse|descending)_colon$', 0.0003),
        ('heart', r'^VH_F_interventricular_septum$', r'^VH_F_(left|right)_ventricle$', 0.00005)]
# renal vessels whose HRA mesh stops short of the hilum, in open lateral stumps: the female left renal vein 21-31 mm
# medial to the kidney, the male left renal vein 10-12 mm and right 2-6 mm, the male artery of the left kidney (HRA
# 'right', renamed by SIDE_SWAP) 0.8-3.3 mm. (part, structure, radius the tube ends at, None: the stump's own); the
# kidney is the nearer one.
RENAL_EXTEND = {'female': [('veins', 'VH_F_left_renal_vein', 0.00475)],
                'male': [('veins', 'VH_M_renal_vein_L', None), ('veins', 'VH_M_renal_vein_R', None), ('arteries', 'VH_M_right_renal_artery', None),
                         ('arteries', 'VH_M_left_renal_artery', None)]}


def frame_offset(sex):
    s = source(f'hra-{sex}')
    v, _ = s.load(s.select(r'_skin$'))
    lo, hi = v.min(0), v.max(0)
    return np.array([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2]), float(hi[1] - lo[1])


_EXCL = {}
def fit_excludes(sex):
    """HRA structures a fit group replaces (its report.json 'assembly_exclude_hra': fit/vessels.py rebuilds the male left
    common carotid artery), left out of the assembly."""
    if sex not in _EXCL:
        out, d = set(), os.path.join(FIT, sex)
        for g in (sorted(os.listdir(d)) if os.path.isdir(d) else ()):
            p = os.path.join(d, g, 'report.json')
            if not os.path.exists(p): continue
            try: out |= set(json.load(open(p)).get('assembly_exclude_hra') or [])
            except (ValueError, AttributeError, TypeError): print(f'  ! {p}: unreadable report')
        _EXCL[sex] = out
    return _EXCL[sex]


def hra_entries(sex, spec):
    s = source(f'hra-{sex}')
    out = []
    for o in s.index:
        if re.search(HRA_EXCLUDE, o['path']) or o['name'] in fit_excludes(sex): continue
        if not any(re.search(rx, o['path']) for rx in spec['sel']): continue
        if spec.get('exclude') and re.search(spec['exclude'], o['path']): continue
        out.append(o)
    return out


def carve_meshes(sex, carve):
    s = source(f'hra-{sex}')
    out = []
    for rx, margin in carve or ():
        es = [o for o in s.index if re.search(rx, o['path']) and not re.search(HRA_EXCLUDE, o['path']) and o['name'] not in fit_excludes(sex)]
        if es: out.append(([load_hra(sex, s, o) for o in es], margin))
    return out


def _smooth01(x):
    x = np.clip(x, 0.0, 1.0); return x * x * (3 - 2 * x)


def inflate_tube(v, f, size, fade=None, length=0.0, step=0.002):
    """Inflate a vessel radially about its centreline: the centreline is the smoothed centroid of 2 mm slices across the
    vessel's principal axis, each vertex moves along its radial direction (perpendicular to the local tangent) by the
    factor (('k', k)) or to the median radius (('r', r)), never shrinking; `fade` keeps one end as it is or inflates one
    end only (see INFLATE), with a smoothstep over `length`. Returns (v, median radius before, after)."""
    c0 = v.mean(0); _, V = np.linalg.eigh(np.cov((v - c0).T)); ax = V[:, -1]
    if ax[1] < 0: ax = -ax  # t grows upwards
    t = (v - c0) @ ax
    nb = max(int(np.ceil((t.max() - t.min()) / step)), 1)
    b = np.minimum(((t - t.min()) / step).astype(int), nb - 1)
    cnt = np.bincount(b, minlength=nb); ok = np.flatnonzero(cnt >= 6)
    if len(ok) < 3: return v, None, None
    C = np.stack([np.bincount(b, weights=v[:, k], minlength=nb) for k in range(3)], 1)[ok] / cnt[ok, None]
    tb = np.bincount(b, weights=t, minlength=nb)[ok] / cnt[ok]
    C = np.stack([np.convolve(np.pad(C[:, k], 2, mode='edge'), np.ones(5) / 5, 'valid') for k in range(3)], 1)
    T = np.gradient(C, tb, axis=0); T /= np.maximum(np.linalg.norm(T, axis=1, keepdims=True), 1e-12)
    cv = np.stack([np.interp(t, tb, C[:, k]) for k in range(3)], 1)
    tv = np.stack([np.interp(t, tb, T[:, k]) for k in range(3)], 1); tv /= np.maximum(np.linalg.norm(tv, axis=1, keepdims=True), 1e-12)
    d = v - cv; d -= np.einsum('ij,ij->i', d, tv)[:, None] * tv
    rad = np.linalg.norm(d, axis=1)
    r0 = float(np.median([np.median(rad[b == i]) for i in ok]))
    k = size[1] if size[0] == 'k' else size[1] / max(r0, 1e-6)
    k = max(k, 1.0)
    w = np.ones(len(v))
    if fade == 'keep_top': w = _smooth01((t.max() - t) / length)
    elif fade == 'keep_bottom': w = _smooth01((t - t.min()) / length)
    elif fade == 'only_top': w = 1 - _smooth01((t.max() - t) / length)
    v2 = v + ((k - 1) * w)[:, None] * d
    return v2, r0, r0 * k


JOIN_FALLOFF = 0.012  # m: length over which a junction's snap fades into each vessel


def inflation(sex, s):
    """The INFLATE vessels inflated, with their junctions kept closed: the HRA vessels and ducts share rings of vertices
    where they join (the aorta's pieces, a branch's origin on its trunk's wall), and every vertex of a shared ring takes
    one displacement, the mean of the inflated structures' displacements there weighted by their cross-sections (the two
    pieces of the aorta meet half-way, an inflated trunk carries the root of a branch, inflated or not, outwards with its
    wall), blended into each structure that shares the ring with a smoothstep over
    JOIN_FALLOFF of its distance to the ring. Returns {name: ((v, f), r0, r1)} for the inflated vessels and the neighbours
    moved, and {name: max junction mismatch (mm) before the snap}."""
    from scipy.spatial import cKDTree
    key = ('_all', sex)
    if key in _INFL: return _INFL[key]
    spec = INFLATE.get(sex, {})
    idx = {o['name']: o for o in s.index}
    raw = {n: s.load_entry(idx[n]) for n in spec if n in idx}
    new = {}
    for n, m in raw.items():
        v2, r0, r1 = inflate_tube(m[0], m[1], *spec[n]); new[n] = (v2, r0, r1)
    # neighbours sharing raw vertices with an inflated vessel (vessels and ducts only)
    cand = [o for o in s.index if o['name'] not in raw and re.search(r'(blood_vasculature|duct|biliary|bile|ampulla)', o['path'])]
    trees = {n: cKDTree(m[0]) for n, m in raw.items()}
    base = list(raw)
    for o in cand:
        v = None
        for n in base:
            m = raw[n]; lo, hi = m[0].min(0) - 0.002, m[0].max(0) + 0.002
            if v is None: v = s.load_entry(o)[0]
            if not np.any(np.all((v > lo) & (v < hi), axis=1)): continue
            if np.any(trees[n].query(v, distance_upper_bound=1e-6)[0] < 1e-6):
                raw[o['name']] = s.load_entry(o); new[o['name']] = (raw[o['name']][0].copy(), None, None); break
    # consensus displacement of every shared position
    names = list(raw); disp = {n: new[n][0] - raw[n][0] for n in names}
    allv = np.concatenate([raw[n][0] for n in names]); own = np.concatenate([np.full(len(raw[n][0]), i) for i, n in enumerate(names)])
    D = np.concatenate([disp[n] for n in names]); infl = np.array([(new[n][2] or 0.0) ** 2 if n in spec else 0.0 for n in names])[own]
    from scipy import sparse
    from scipy.sparse.csgraph import connected_components
    pr = cKDTree(allv).query_pairs(1e-6, output_type='ndarray')  # positions within 1 um are one vertex of a shared ring
    _, grp = connected_components(sparse.coo_matrix((np.ones(len(pr)), (pr[:, 0], pr[:, 1])), shape=(len(allv), len(allv))), directed=False)
    nstr = np.zeros(grp.max() + 1, int); np.add.at(nstr, grp, 1)
    shared = nstr[grp] > 1
    wsum = np.zeros(grp.max() + 1); np.add.at(wsum, grp, infl)
    dsum = np.zeros((grp.max() + 1, 3)); np.add.at(dsum, grp, D * infl[:, None])
    cons = dsum / np.maximum(wsum, 1e-30)[:, None]
    mism = {}
    o0 = 0
    for i, n in enumerate(names):
        k = len(raw[n][0]); sl = slice(o0, o0 + k); o0 += k
        sh = np.flatnonzero(shared[sl])
        if not len(sh): continue
        corr = cons[grp[sl][sh]] - disp[n][sh]
        mism[n] = round(float(np.linalg.norm(corr, axis=1).max()) * 1000, 2)
        d, j = cKDTree(raw[n][0][sh]).query(raw[n][0])
        w = 1 - _smooth01(d / JOIN_FALLOFF)
        new[n] = (new[n][0] + w[:, None] * corr[j], new[n][1], new[n][2])
    out = {n: ((new[n][0], raw[n][1]), new[n][1], new[n][2]) for n in names}
    _INFL[key] = (out, mism)
    return _INFL[key]


_INFL = {}
def load_hra(sex, s, o):
    """An HRA mesh as stored, or inflated (INFLATE) or moved with an inflated vessel's junction (inflation)."""
    if not INFLATE.get(sex): return s.load_entry(o)
    out, _ = inflation(sex, s)
    if o['name'] in out: return out[o['name']][0]
    return s.load_entry(o)


SOLIDS = {}  # (sex, structure) -> mean thickness 2 V / A (m) and the membrane closing of each rebuilt solid


_LOBES = {}
def lobes(sex):
    """The five lung lobes rebuilt together: {lobe: ((v, f), source paths)}."""
    if sex not in _LOBES:
        s = source(f'hra-{sex}')
        ents = {k: hra_entries(sex, HRA_PARTS[k]) for k in LOBE_PATH}
        ents = {k: e for k, e in ents.items() if e}
        spec = HRA_PARTS[next(iter(LOBE_PATH))]
        built = remesh_solids({k: [load_hra(sex, s, o) for o in e] for k, e in ents.items()}, project=spec.get('project', True),
                              smooth=spec.get('smooth', 4), carve=carve_meshes(sex, LOBE_CARVE))
        _LOBES[sex] = {k: (m, [o['path'] for o in ents[k]]) for k, m in built.items()}
    return _LOBES[sex]


def build_part(sex, pid, spec):
    """Returns a list of (structure name, (v, f), HRA source paths) for this part, or [] if the body has none."""
    s = source(f'hra-{sex}')
    es = hra_entries(sex, spec)
    if not es: return []
    if spec.get('lobes'):
        m, paths = lobes(sex).get(pid, (None, None))
        return [(pid, m, paths)] if m is not None else []
    if spec.get('mode') == 'solid':
        groups = {}
        for o in es:
            k = re.search(spec['split'], o['name']).group(1) if spec.get('split') and re.search(spec['split'], o['name']) else '_'
            groups.setdefault(k, []).append(o)
        out = []
        carve = carve_meshes(sex, spec.get('carve'))
        for k, g in groups.items():
            info = {}
            m = remesh_solid([load_hra(sex, s, o) for o in g], project=spec.get('project', True), smooth=spec.get('smooth', 4), opening=spec.get('opening', 0),
                             carve=carve, membrane=spec.get('membrane', False), info=info)
            name = pid if k == '_' else f'{pid}_{k}'
            A = 0.5 * np.linalg.norm(np.cross(m[0][m[1][:, 1]] - m[0][m[1][:, 0]], m[0][m[1][:, 2]] - m[0][m[1][:, 0]]), axis=1).sum()
            SOLIDS[(sex, name)] = dict(thickness_mm=round(2 * abs(signed_volume(*m)) / max(A, 1e-12) * 1000, 2), **info)
            out.append((name, m, [o['path'] for o in g]))
        return out
    out = []
    for o in es:
        v, f = compact(*load_hra(sex, s, o))
        out.append((o['name'], (v, orient_exact(v, f)), [o['path']]))
    return out


def keep_or_orient(v, f):
    """A fitted structure's winding: kept when an exact test finds it outward (the fits orient their outputs; the
    centroid rule mis-turns long curved open tubes such as the fibular arteries), else made outward by orient_exact."""
    _, inward, _ = facing(v, f)
    if inward <= 0.002: return f
    fo = orient_exact(v, f)
    return fo if facing(v, fo)[1] < inward else f


def fitted(sex):
    """Fitted Z-Anatomy structures by part: {part: [(name, (v, f), sources)]}."""
    out = {}
    d = os.path.join(FIT, sex)
    if not os.path.isdir(d): return out
    for group in sorted(os.listdir(d)):
        man = os.path.join(d, group, 'manifest.json')
        if not os.path.exists(man): continue
        for e in json.load(open(man)):
            out.setdefault(e['part'], []).append((f"{group}/{e['name']}", load(os.path.join(d, group, e['file'])), e.get('source', [])))
    return out


# ------------------------------------------------------------------------------------------------ repairs between parts
# HRA left/right names swapped by position (+x is the person's left): every Allen brain _L parcel lies at -x, and the
# male thymus lobes and vas deferens are swapped. A pair is renamed only when its _L member lies to the right (-x) of its
# _R partner (names that say which side of an organ a structure belongs to, such as the heart's chambers or the liver's
# ducts and vessels, are not about the body's sides and are never renamed).
# The male renal arteries are swapped too (VH_M_left_renal_artery runs to the right kidney).
SIDE_SWAP = {'male': r'^(Allen_.*|VH_M_thymus_lobe|VH_M_vas_deferens)_[LR]$|^VH_M_(left|right)_renal_artery$', 'female': r'^(Allen_.*)_[LR]$'}


def _partner(n):
    """The other side's name of a left structure (_L suffix or left_ in the name), or None."""
    if n.endswith('_L'): return n[:-2] + '_R'
    if re.search(r'(^|_)left_', n): return re.sub(r'(^|_)left_', r'\1right_', n, count=1)
    return None


def swap_sides(sex, acc, off):
    """Rename the swapped pairs of SIDE_SWAP in place; returns the list of renamed left names and the pairs left alone."""
    rx = re.compile(SIDE_SWAP.get(sex, r'^$'))
    where = {}
    for pid, items in acc.items():
        for i, (src, n, m, d, paths) in enumerate(items):
            if src == 'HRA' and rx.search(n): where[n] = (pid, i, float(m[0][:, 0].mean()))
    done, kept = [], []
    for n, (pid, i, x) in list(where.items()):
        r = _partner(n)
        if r is None: continue
        if r not in where: kept.append(n); continue
        if x < where[r][2]:
            for a, b in ((n, r), (r, n)):
                p, j, _ = where[a]; src, _, m, d, paths = acc[p][j]; acc[p][j] = (src, b, m, d, paths)
            done.append(n)
        else: kept.append(n)
    return done, kept


def _ring(points, c, a, e1, e2, K):
    """Outline radius per angle (K bins) of points around centre c in the plane perpendicular to a."""
    d = points - c; d = d - np.outer(d @ a, a)
    th = np.arctan2(d @ e2, d @ e1); r = np.linalg.norm(d, axis=1)
    k = np.floor((th + np.pi) / (2 * np.pi) * K).astype(int) % K
    out = np.full(K, np.nan)
    for i in range(K):
        if (k == i).any(): out[i] = r[k == i].max()
    ok = np.flatnonzero(~np.isnan(out))
    out = np.interp(np.arange(K), ok, out[ok], period=K)
    return np.convolve(np.r_[out[-2:], out, out[:2]], np.ones(5) / 5, 'valid')


def cord_junction(cord, medulla, K=48, J=16):
    """The HRA spinal cord stops below the medulla (its C1 segment has a flat top 2-9 mm under the Allen medulla). A
    short tube lofted from that top ring along the canal axis to the medulla's lowest cross-section joins them: it starts
    1 mm below the top, just inside the cord's wall, follows a cubic from the cord's axis to the medulla's axis and ends
    1.5 mm up inside the medulla, its section blending smoothly between the two outlines.
    cord: {name: (v, f)} of the cord segments; medulla: [(v, f)] of the medulla parcels. Returns (v, f) or None."""
    seg = {int(re.search(r'C(\d)_segment', n).group(1)): m for n, m in cord.items() if re.search(r'C\d_segment', n)}
    if 1 not in seg or not medulla: return None
    cv = seg[1][0]; top = cv[:, 1].max()
    below = seg.get(3, seg.get(2))
    rim = cv[cv[:, 1] > top - 0.0015]
    c0 = rim.mean(0); c0[1] = top - 0.001
    a0 = c0 - below[0].mean(0) if below is not None else np.array([0, 1.0, 0]); a0 /= np.linalg.norm(a0)
    mp = np.concatenate([dense_points(v, f, 0.0003) for v, f in medulla])
    y0 = mp[:, 1].min(); ym = y0 + 0.0015
    sl = mp[np.abs(mp[:, 1] - ym) < 0.0003]; hi = mp[np.abs(mp[:, 1] - (y0 + 0.007)) < 0.0003]
    if len(sl) < 12: return None
    c1 = sl.mean(0); c1[1] = ym
    a1 = (hi.mean(0) - c1) if len(hi) > 12 else a0.copy(); a1 /= np.linalg.norm(a1)
    L = np.linalg.norm(c1 - c0)
    th = np.linspace(-np.pi, np.pi, K, endpoint=False) + np.pi / K
    def frame(a):
        e1 = np.array([1.0, 0, 0]) - a[0] * a; e1 /= np.linalg.norm(e1); return e1, np.cross(a, e1)
    r0 = _ring(rim, c0, a0, *frame(a0), K) - 0.00015
    r1 = _ring(sl, c1, a1, *frame(a1), K) - 0.0002
    V = []
    for j in range(J + 1):
        t = j / J; h00, h10, h01, h11 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t, -2 * t**3 + 3 * t**2, t**3 - t**2
        c = h00 * c0 + h10 * L * a0 + h01 * c1 + h11 * L * a1
        tan = (6 * t**2 - 6 * t) * c0 + (3 * t**2 - 4 * t + 1) * L * a0 + (-6 * t**2 + 6 * t) * c1 + (3 * t**2 - 2 * t) * L * a1
        tan /= np.linalg.norm(tan); e1, e2 = frame(tan)
        sm = 3 * t**2 - 2 * t**3; r = (1 - sm) * r0 + sm * r1
        V += [c + ri * (np.cos(a) * e1 + np.sin(a) * e2) for ri, a in zip(r, th)]
    V = np.array(V + [c0, c1]); F = []
    for j in range(J):
        for k in range(K):
            p, q = j * K + k, j * K + (k + 1) % K
            F += [[p, q, p + K], [q, q + K, p + K]]
    nb, nt = len(V) - 2, len(V) - 1
    F += [[nb, (k + 1) % K, k] for k in range(K)] + [[nt, J * K + k, J * K + (k + 1) % K] for k in range(K)]
    F = np.array(F)
    return V, orient_exact(V, F)


def exact_sdf(rays, v, f, p):
    """Signed distance (negative inside) from points p to a closed mesh: exact closest point plus the parity test."""
    _, d = closest_on_mesh(v, f, p, k=16)
    return np.where(rays.inside(p), -d, d)


def inset(mesh, skin_v, skin_f, rays, depth=0.0012, iters=4):
    # skin_f may be the skin's faces around the structure only (closest points); rays tests against the whole skin
    """Pull the vertices of a structure that reach the skin (or come within `depth` of it) to `depth` inside it, along
    the direction to their closest skin point, with a smooth falloff over the mesh (the displacement is diffused to the
    neighbours, the violating vertices keep their full push). Returns (v, (before, after) deepest outside reach, m)."""
    v, f = mesh; v = v.copy()
    sd0 = exact_sdf(rays, skin_v, skin_f, v)
    for _ in range(iters):
        sd = exact_sdf(rays, skin_v, skin_f, v)
        bad = sd > -depth
        if not bad.any(): break
        q, _ = closest_on_mesh(skin_v, skin_f, v[bad], k=16)
        n = q - v[bad]; n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        n = np.where((sd[bad] < 0)[:, None], -n, n)  # inside: the skin is behind; push away from it
        D = np.zeros_like(v); D[bad] = n * (sd[bad] + depth + 1e-5)[:, None]
        S = laplacian_smooth_field(f, D, iters=12, lam=0.6)
        keep = np.linalg.norm(D, axis=1) >= np.linalg.norm(S, axis=1)
        v += np.where(keep[:, None], D, S)
    return v, (float(sd0.max()), float(exact_sdf(rays, skin_v, skin_f, v).max()))


def tube_radius(v, f):
    """Mean radius of a closed tube: 2 V / A."""
    A = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1).sum()
    return 2 * abs(signed_volume(v, f)) / max(A, 1e-12)


def vertex_normals(v, f):
    n = np.zeros_like(v); fn = face_normals(v, f, unit=False)
    for k in range(3): np.add.at(n, f[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-20)


def border_loops(f):
    """Closed border loops of a mesh, as vertex index lists."""
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    _, inv, cnt = np.unique(np.sort(e, axis=1), axis=0, return_inverse=True, return_counts=True)
    nxt = {}
    for a, b in e[cnt[inv.ravel()] == 1]: nxt.setdefault(int(a), []).append(int(b))
    out = []
    for st in list(nxt):
        while nxt.get(st):
            loop, cur = [st], nxt[st].pop()
            while cur != st and nxt.get(cur): loop.append(cur); cur = nxt[cur].pop()
            if cur == st and len(loop) >= 3: out.append(loop)
    return out


def sweep_tube(c0, a0, r0, c1, a1, r1, K=32, J=16):
    """A closed tube along the cubic Hermite curve from c0 (tangent a0) to c1 (tangent a1), its radius blending from r0 to
    r1 by a smoothstep, both ends capped. Returns (v, f) wound outwards."""
    L = np.linalg.norm(c1 - c0)
    ref = np.eye(3)[np.argmin(np.abs(a0))]
    th = np.linspace(0, 2 * np.pi, K, endpoint=False)
    V = []
    e1p = None
    for j in range(J + 1):
        t = j / J; h00, h10, h01, h11 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t, -2 * t**3 + 3 * t**2, t**3 - t**2
        c = h00 * c0 + h10 * L * a0 + h01 * c1 + h11 * L * a1
        tan = (6 * t**2 - 6 * t) * c0 + (3 * t**2 - 4 * t + 1) * L * a0 + (-6 * t**2 + 6 * t) * c1 + (3 * t**2 - 2 * t) * L * a1
        tan /= np.linalg.norm(tan)
        e1 = (ref if e1p is None else e1p) - tan * ((ref if e1p is None else e1p) @ tan); e1 /= np.linalg.norm(e1); e1p = e1  # parallel transport
        e2 = np.cross(tan, e1)
        r = r0 + (r1 - r0) * (3 * t**2 - 2 * t**3)
        V += [c + r * (np.cos(a) * e1 + np.sin(a) * e2) for a in th]
    V = np.array(V + [c0, c1]); F = []
    for j in range(J):
        for k in range(K):
            p, q = j * K + k, j * K + (k + 1) % K
            F += [[p, q, p + K], [q, q + K, p + K]]
    nb, nt = len(V) - 2, len(V) - 1
    F += [[nb, (k + 1) % K, k] for k in range(K)] + [[nt, J * K + k, J * K + (k + 1) % K] for k in range(K)]
    F = np.array(F)
    return V, orient_exact(V, F)


def renal_vein_extension(vein, kidney, end_r=0.00475, lo=0.0015, hi=0.04):
    """Swept tubes continuing a renal vessel's open lateral stumps into the kidney's hilum. A stump is a border loop (or
    the inner and outer wall loops of a double-walled one) whose centre lies lo-hi from the kidney and within 15 mm of
    the vessel's nearest approach to it (its lateral end, not a tributary's opening), outside the kidney; each tube starts 3 mm back inside
    the vessel along its axis, just inside the stump's outer wall, follows the vessel's axis and turns into the kidney at
    the nearest point of the hilum's surface, tapering to end_r (None: the stump's own radius), and ends 4 mm inside the
    kidney. Returns [(v, f)] and per stump the gap closed (mm)."""
    v, f = vein; kv, kf = kidney
    loops = [(v[L].mean(0), float(np.linalg.norm(v[L] - v[L].mean(0), axis=1).mean()), L) for L in border_loops(f)]
    _, dk = closest_on_mesh(kv, kf, np.array([c for c, _, _ in loops]), k=16) if loops else (None, [])
    _, dv = closest_on_mesh(kv, kf, v[::max(1, len(v) // 4000)], k=16)
    inside = RayParity(kv, kf).inside(np.array([c for c, _, _ in loops])) if loops else []
    stumps = []
    for (c, r, L), d, ins in zip(loops, dk, inside):
        if ins or not (lo < d < hi) or r < 0.0008 or d > dv.min() + 0.015: continue
        for st in stumps:
            if np.linalg.norm(st['c'] - c) < 0.003:
                if r > st['r']: st.update(c=c, r=r)
                break
        else: stumps.append(dict(c=c, r=r))
    out, gaps = [], []
    for st in stumps:
        c, r = st['c'], st['r']
        dv = np.linalg.norm(v - c, axis=1); back = v[(dv > 0.004) & (dv < 0.012)]
        if len(back) < 6: continue
        a0 = c - back.mean(0); a0 /= np.linalg.norm(a0)
        q, dq = closest_on_mesh(kv, kf, c[None], k=16); q = q[0]
        a1 = (q - c) / np.linalg.norm(q - c)
        a1 = a1 + 0.5 * a0; a1 /= np.linalg.norm(a1)
        c0 = c - 0.003 * a0; c1 = q + 0.004 * a1
        out.append(sweep_tube(c0, a0, r - 0.00025, c1, a1, end_r if end_r else r - 0.00025))
        gaps.append(round(float(dq[0]) * 1000, 1))
    return out, gaps


def trim_coincident(m, others, dist):
    """Faces of m = (v, f) kept: those not lying on the meshes `others` (centroid within `dist`, every vertex within twice
    it). Returns the kept mesh and the dropped share of the area."""
    v, f = m
    ov, of = merge(others)
    _, dv = closest_on_mesh(ov, of, v, k=16)
    _, dc = closest_on_mesh(ov, of, v[f].mean(1), k=16)
    near = (dv[f].max(1) <= 2 * dist) & (dc <= dist)
    ar = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
    return compact(v, f[~near]), float(ar[near].sum() / max(ar.sum(), 1e-12))


LANDMARK_V = {}  # (sex, structure) -> vertices of a trimmed structure before trimming (its landmarks stay where they were)


def repairs(sex, acc, off, log):
    """Fixes between structures of different parts, in the HRA frame (before the floor shift)."""
    # vessels and ducts inflated when loaded (load_hra)
    if ('_all', sex) in _INFL:
        out, mism = _INFL[('_all', sex)]
        for n, (_, r0, r1) in out.items():
            if r0 is not None: log.setdefault('inflated_radius_mm', {})[n] = dict(before=round(r0 * 1000, 2), after=round(r1 * 1000, 2))
        log['inflation_junctions_snapped_mm'] = mism  # largest mismatch an independent inflation left at each shared ring
    # faces that repeat a neighbour's wall
    for part, rx, nrx, dist in TRIM:
        items = acc.get(part, [])
        for i, (src, n, m, dbl, paths) in enumerate(items):
            if not re.search(rx, n): continue
            others = [mm for _, nn, mm, _, _ in items if re.search(nrx, nn)]
            if not others: continue
            m2, frac = trim_coincident(m, others, dist)
            LANDMARK_V[(sex, n)] = m[0]
            items[i] = (src, n, m2, dbl, paths)  # a structure trimmed away entirely is dropped below (its landmark stays)
            log.setdefault('trimmed_coincident', {})[n] = dict(area_dropped=round(frac, 3), within_mm=dist * 1000, faces_left=int(len(m2[1])), faces_before=int(len(m[1])))
        acc[part] = [it for it in items if len(it[2][1]) >= 10] if part in acc else items
    # renal vessels that stop short of the hilum
    kid = {n: m for _, n, m, _, _ in acc.get('kidneys', [])}
    for part, vname, end_r in RENAL_EXTEND.get(sex, []):
        vi = [m for _, n, m, _, _ in acc.get(part, []) if n == vname]
        if not vi or not kid: continue
        kname = min(kid, key=lambda k: float(closest_on_mesh(*kid[k], vi[0][0][::max(1, len(vi[0][0]) // 2000)], k=16)[1].min()))
        tubes, gaps = renal_vein_extension(vi[0], kid[kname], end_r=end_r)
        base = vname if part == 'veins' else f'VH_{sex[0].upper()}_renal_artery_{kname[-1]}'  # the artery's L/R name is swapped later
        for j, t in enumerate(tubes):
            acc[part].append(('HRA', f'{base}_hilar_{"abcd"[j] if j < 4 else j}', t, False, [f'derived:{vname} stump {j} swept to the hilum of {kname}']))
        log.setdefault('renal_vessel_extended', {})[vname] = dict(kidney=kname, stumps=len(tubes), gap_closed_mm=gaps)
    # spinal cord to medulla
    cord = {n: m for _, n, m, _, _ in acc.get('spinal_cord', [])}
    med = [m for _, n, m, _, _ in acc.get('brain', []) if re.search(r'^Allen_(tegmentum|pyramidal_part)_of_medulla_oblongata_[LR]$', n)]
    tube = cord_junction(cord, med)
    if tube is not None:
        acc['spinal_cord'].append(('HRA', 'cervicomedullary_junction', tube, False, ['derived:cord C1 top to medulla loft']))
        mp = np.concatenate([dense_points(v, f, 0.0003) for v, f in med])
        log['cord_medulla_gap_mm'] = dict(before=round(float(mp[:, 1].min() - max(m[0][:, 1].max() for n, m in cord.items() if 'C1_segment' in n)) * 1000, 2))
        from scipy.spatial import cKDTree
        tp = dense_points(*tube, 0.0003); d, _ = cKDTree(mp).query(tp[tp[:, 1] > np.percentile(tp[:, 1], 80)])
        log['cord_medulla_gap_mm']['after'] = round(float(d.min()) * 1000, 2)
    # breast ducts and lactiferous sinuses that reach through the skin at the nipples
    skin = [m for _, n, m, _, _ in acc.get('skin', [])]
    if skin and acc.get('breasts'):
        sv, sf = skin[0]; rays = RayParity(sv, sf)
        for i, (src, n, m, dbl, paths) in enumerate(acc['breasts']):
            if not re.search(r'lactiferous', n): continue
            # closest points from the skin around the structure, inside/outside from the whole skin
            lo, hi = m[0].min(0) - 0.01, m[0].max(0) + 0.01
            cen = sv[sf].mean(1); near = np.all(cen > lo, axis=1) & np.all(cen < hi, axis=1)
            v2, (b, a) = inset(m, sv, sf[near], rays)
            acc['breasts'][i] = (src, n, (v2, m[1]), dbl, paths)
            log.setdefault('breast_skin_reach_mm', {})[n] = dict(before=round(b * 1000, 2), after=round(a * 1000, 2))
    # the male HRA urethra reaches 1.4 mm out of the glans: pulled inside the skin like the breast ducts
    if sex == 'male' and skin:
        sv, sf = skin[0]; rays = RayParity(sv, sf)
        for i, (src, n, m, dbl, paths) in enumerate(acc.get('bladder', [])):
            if not re.search(r'urethra', n): continue
            lo, hi = m[0].min(0) - 0.01, m[0].max(0) + 0.01
            cen = sv[sf].mean(1); near = np.all(cen > lo, axis=1) & np.all(cen < hi, axis=1)
            if not near.any(): continue
            v2, (b, a) = inset(m, sv, sf[near], rays, depth=0.0005)
            if b > -0.0005:
                acc['bladder'][i] = (src, n, (v2, m[1]), dbl, paths)
                log.setdefault('urethra_skin_reach_mm', {})[n] = dict(before=round(b * 1000, 2), after=round(a * 1000, 2))
    # thread-thin HRA ureters (female): offset outward to a 1.6 mm radius (adult ureter 3-4 mm across), at most 1.2 mm
    for i, (src, n, m, dbl, paths) in enumerate(acc.get('ureters', [])):
        r = tube_radius(*m)
        if r < 0.0012:
            dv = min(0.0016 - r, 0.0012)
            acc['ureters'][i] = (src, n, (m[0] + vertex_normals(*m) * dv, m[1]), dbl, paths)
            log.setdefault('ureter_radius_mm', {})[n] = dict(before=round(r * 1000, 2), after=round(tube_radius(m[0] + vertex_normals(*m) * dv, m[1]) * 1000, 2))


def assemble(sex):
    t0 = time.time()
    off, height = frame_offset(sex)
    fit = fitted(sex)
    od = os.path.join(OUT, sex); os.makedirs(od, exist_ok=True)
    parts = {}
    acc = {}
    for pid, spec in HRA_PARTS.items():
        target = spec.get('into', pid)
        for name, mesh, paths in build_part(sex, pid, spec):
            acc.setdefault(target, []).append(('HRA', name, mesh, spec.get('double', False), paths))
    print(f'  HRA parts built ({time.time() - t0:.0f} s)', flush=True)
    for pid, items in fit.items():
        for name, mesh, srcs in items:
            v, f = mesh
            acc.setdefault(pid, []).append(('Z-Anatomy', name, (v, keep_or_orient(v, f)), False, [f'fit:{name}']))
    log = {}
    repairs(sex, acc, off, log)
    done, kept = swap_sides(sex, acc, off)
    print(f'  sides swapped by position: {len(done)} pairs (' + ', '.join(n for n in done if not n.startswith('Allen_')) + f', {sum(n.startswith("Allen_") for n in done)} Allen parcels)'
          + (f'; not swapped: {kept}' if kept else ''))
    log['sides_swapped'] = dict(pairs=len(done), named=[n for n in done if not n.startswith('Allen_')], allen=sum(n.startswith('Allen_') for n in done), not_swapped=kept)
    # a structure in two parts (or a source mesh in two structures) is drawn twice (z-fighting, wrong colour, double triangles)
    owner, used = {}, {}
    for pid, items in acc.items():
        for _, n, _, _, paths in items:
            owner.setdefault(n, []).append(pid)
            for pth in paths: used.setdefault(pth, []).append(f'{pid}/{n}')
    twice = {n: p for n, p in owner.items() if len(p) > 1}
    if twice: raise SystemExit(f'{sex}: structures in more than one part: {twice}')
    twice = {pth: u for pth, u in used.items() if len(u) > 1}
    if twice: raise SystemExit(f'{sex}: HRA meshes used by more than one structure: {twice}')
    structures = {}
    struct_v = {}; parts_v = {}
    for pid, items in acc.items():
        for src, n, m, _, _ in items:
            struct_v[re.sub(r'^VH_[MF]_', '', n.split('/')[-1])] = m[0] + off
    for (sx, n), v0 in LANDMARK_V.items():  # trimmed structures keep their landmarks (a flexure repeated by its neighbours)
        if sx == sex: struct_v[re.sub(r'^VH_[MF]_', '', n)] = v0 + off
    s = source(f'hra-{sex}')
    for pid, spec in HRA_PARTS.items():  # sub-structures of rebuilt parts (lobes' segments, pancreas head, uterus cervix...)
        if spec.get('mode') != 'solid': continue
        for o in hra_entries(sex, spec):
            v = s.load_entry(o)[0] + off
            struct_v.setdefault(re.sub(r'^VH_[MF]_', '', o['name']), v)
    inward = {}
    for pid, items in acc.items():
        if pid not in SPEC: print(f'  ! {pid}: not in catalog.PARTS, skipped'); continue
        v, f = merge([m for _, _, m, _, _ in items])
        v = v + off
        seg = np.cumsum([0] + [len(m[1]) for _, _, m, _, _ in items]).astype(np.uint32)
        save(os.path.join(od, pid + '.npz'), v, f)
        v.astype(np.float32).tofile(os.path.join(od, pid + '.pos')); f.astype(np.uint32).tofile(os.path.join(od, pid + '.idx')); seg.tofile(os.path.join(od, pid + '.seg'))
        lo, hi = v.min(0), v.max(0)
        # exact orientation check, structure by structure (area-weighted)
        ar_in = ar_un = ar_all = 0.0; worst = []
        for _, n, m, _, _ in items:
            a = 0.5 * np.linalg.norm(np.cross(m[0][m[1][:, 1]] - m[0][m[1][:, 0]], m[0][m[1][:, 2]] - m[0][m[1][:, 0]]), axis=1).sum()
            _, fi, fu = facing(*m); ar_in += fi * a; ar_un += fu * a; ar_all += a
            if fi > 0.005: worst.append((n, round(fi, 4)))
        inward[pid] = round(ar_in / max(ar_all, 1e-12), 5); undecided = round(ar_un / max(ar_all, 1e-12), 4)
        parts[pid] = dict(SPEC[pid], double=any(d for _, _, _, d, _ in items) or 'double' in SPEC[pid]['flags'], bounds=[lo.round(4).tolist(), hi.round(4).tolist()], tris=int(len(f)),
                          sources=sorted({src for src, *_ in items}), inward=inward[pid], open_area=undecided)
        structures[pid] = [dict(name=n, source=src, tris=int(len(m[1])), paths=paths) for src, n, m, _, paths in items]
        parts_v[pid] = v
        print(f'  {pid:<18} {len(f):8d} tris  {len(items):4d} structures  inward {inward[pid] * 100:5.2f} % (open {undecided * 100:4.1f} %)  from {", ".join(parts[pid]["sources"])}'
              + (f'   worst {sorted(worst, key=lambda w: -w[1])[:4]}' if worst else ''), flush=True)
    json.dump(structures, open(os.path.join(od, 'structures.json'), 'w'), indent=0)
    missing = [p for p in SPEC if p not in parts]
    marks, pins, lm_missing = landmarks(struct_v, parts_v, sex)
    skin_v = parts_v['skin']
    failing = {p: x for p, x in inward.items() if x > INWARD_MAX}
    log['solid_thickness_mm'] = {n: x for (sx, n), x in SOLIDS.items() if sx == sex}
    thin = {n: x['thickness_mm'] for n, x in log['solid_thickness_mm'].items() if x['thickness_mm'] < THIN_SOLID * 1000}
    rig = dict(sex=sex, height=round(height, 4), offset=off.round(5).tolist(), bounds=[skin_v.min(0).round(4).tolist(), skin_v.max(0).round(4).tolist()],
               parts=parts, missing=missing, landmarks=marks, pins=pins, landmarks_missing=lm_missing, repairs=log,
               inward_max=INWARD_MAX, inward_failing=failing, thin_solids=thin)
    json.dump(rig, open(os.path.join(od, 'rig.json'), 'w'), indent=1)
    print(f'{sex}: {len(parts)} parts, missing {missing}, repairs {log} ({time.time() - t0:.0f} s)')
    if failing: print(f'{sex}: FAIL: parts with more than {INWARD_MAX * 100:.0f} % of their area facing inward: {failing}')
    if thin: print(f'{sex}: WARNING: rebuilt solids thinner than {THIN_SOLID * 1000:.0f} mm (shells, not organs): {thin}')
    return rig


# ------------------------------------------------------------------------------------------------ landmarks and pins
# Camera direction each organ is viewed from (same vectors as src/anatomy/organs.ts `view`), used to put each label on
# the surface that faces the viewer.
VIEW = dict(brain=(0.55, 0.25, 0.8), thyroid=(0.25, 0.1, 1), airway=(0.3, 0.1, 1), lungs=(0.2, 0.15, 1), heart=(0.35, 0.12, 1), esophagus=(0.8, 0.1, 0.6),
            liver=(-0.45, 0.1, 1), stomach=(0.5, 0.1, 1), spleen=(1, 0.15, -0.3), pancreas=(0.1, 0.4, 1), kidneys=(-0.15, 0.1, -1), intestine=(0.1, 0.2, 1),
            colon=(0, 0.15, 1), marrow=(0.3, 0.1, 1), reproductive=(0.2, 0.1, 1), breast=(0.25, 0.1, 1), skin=(0, 0, 1))
L, R = r'_L$', r'_R$'
# organ -> [(landmark name, structure regex (on names without the VH_M_/VH_F_ prefix, or 'part:<id>'), rule)].
# Rules: 'face' (surface point facing the organ's view near the structure's centre), or an extreme point along a
# direction: 'top', 'bottom', 'left' (+x), 'right' (-x), 'front' (+z), 'back' (-z), or 'dir:x,y,z'.
LANDMARKS = {
    'brain': [('Frontal lobe', r'^Allen_(superior|middle)_frontal_gyrus_L$', 'face'), ('Motor cortex', r'^Allen_precentral_gyrus_L$', 'face'),
              ('Sensory cortex', r'^Allen_postcentral_gyrus_L$', 'face'), ('Temporal lobe', r'^Allen_(middle|inferior)_temporal_gyrus_L$', 'face'),
              ('Occipital lobe', r'^Allen_(superior_occipital_gyrus|inferior_occipital_gyrus|occipital_pole)_L$', 'back'),
              ('Cerebellum', r'^Allen_lateral_hemisphere_of_cerebellum_L$', 'dir:0.4,-0.3,-0.8'), ('Brainstem', r'^Allen_(basilar_part_of_pons|pyramidal_part_of_medulla_oblongata)_[LR]$', 'front'),
              ('Hypothalamus', r'^Allen_(hypothalamus|tuberal_region_of_HTH)_L$', 'bottom'), ('Pituitary gland', 'part:pituitary', 'front'),
              ('Lateral ventricles', r'^Allen_body_of_lateral_ventricle_L$', 'top'), ('Corpus callosum', r'^Allen_corpus_callosum', 'top')],
    'thyroid': [('Right lobe', 'part:thyroid', 'dir:-1,0,0.6'), ('Left lobe', 'part:thyroid', 'dir:1,0,0.6'), ('Isthmus', 'part:thyroid', 'front'),
                ('Parathyroid glands', 'part:parathyroids', 'back'), ('Thyroid cartilage', r'^thyroid_cartilage$', 'front')],
    'airway': [('Epiglottis', r'^epiglott?ic_cartilage$', 'top'), ('Thyroid cartilage', r'^thyroid_cartilage$', 'front'), ('Cricoid cartilage', r'^cricoid_cartilage$', 'front'),
               ('Trachea', r'^trachea$', 'face'), ('Carina', r'^carina$', 'bottom'), ('Right main bronchus', r'^right_main_bronchus$', 'right'),
               ('Left main bronchus', r'^left_main_bronchus$', 'left')],
    'lungs': [('Right upper lobe', 'part:lung_r_upper', 'face'), ('Right middle lobe', 'part:lung_r_middle', 'front'), ('Right lower lobe', 'part:lung_r_lower', 'dir:-0.6,-0.4,0.4'),
              ('Left upper lobe', 'part:lung_l_upper', 'face'), ('Lingula', r'^(left_)?lingula_(superior|inferior)_bronchopulmonary_segment$', 'front'),
              ('Left lower lobe', 'part:lung_l_lower', 'dir:0.6,-0.4,0.4'), ('Bronchial tree', 'part:bronchi', 'face'), ('Diaphragm', 'part:diaphragm', 'top')],
    'heart': [('Left ventricle', r'^(heart_)?left_ventricle$', 'face'), ('Right ventricle', r'^(heart_)?right_ventricle$', 'face'), ('Right atrium', r'^right_cardiac_atrium$', 'right'),
              ('Left atrium', r'^left_cardiac_atrium$', 'back'), ('Interventricular septum', r'^interventricular_septum$', 'face'), ('Mitral valve', r'^mitral_valve$', 'face'),
              ('Tricuspid valve', r'^tricuspid_valve$', 'face'), ('Aortic valve', r'^aortic_valve$', 'face'), ('Pulmonary valve', r'^pulmonary_valve$', 'face'),
              ('Aortic arch', r'^aortic_arch$', 'top'), ('Pulmonary trunk', r'^pulmonary_trunk$', 'front'), ('Superior vena cava', r'^superior_vena_cava$', 'right'),
              ('Coronary arteries', r'^left_anterior_descending_artery$', 'face'), ('Apex', r'^(heart_)?left_ventricle$', 'dir:0.55,-0.6,0.55')],
    'esophagus': [('Esophagus', 'part:esophagus', 'face'), ('Gastro-esophageal junction', 'part:esophagus', 'bottom')],
    'liver': [('Right lobe', 'part:liver', 'dir:-0.8,0,0.6'), ('Left lobe', 'part:liver', 'dir:0.9,0.1,0.4'), ('Caudate lobe', r'^caudate_lobe(_of_liver)?$', 'back'),
              ('Quadrate lobe', r'^quadrate_lobe(_of_liver)?$', 'bottom'), ('Falciform ligament', r'^falciform_ligament$', 'front'), ('Gallbladder', 'part:gallbladder', 'bottom'),
              ('Porta hepatis', r'^porta_hepatis$', 'bottom'), ('Hepatic artery', r'^proper_hepatic_artery$', 'front'), ('Hepatic veins', 'part:hepatic_veins', 'top'), ('Portal vein', r'^(hepatic_)?portal_vein$', 'front'),
              ('Common bile duct', r'^common_bile_duct$', 'front')],
    'stomach': [('Fundus', 'part:stomach', 'top'), ('Body', 'part:stomach', 'face'), ('Greater curvature', 'part:stomach', 'dir:0.7,-0.6,0.3'),
                ('Pylorus', 'part:stomach', 'right')],
    # the splenic artery runs along the upper border of the pancreas, the vein behind it: the artery is labelled at its
    # highest point, the vein where it faces the view (the female's two 'face' points were 1.5 mm apart, 'top' and 'back'
    # 5.7 mm; these are 65 mm (female) and 79 mm (male) apart)
    'spleen': [('Hilum', r'^hilum_of_spleen$', 'face'), ('Splenic artery', r'^splenic_artery$', 'top'), ('Splenic vein', r'^splenic_vein$', 'face')],
    'pancreas': [('Head', r'^head_of_pancreas$', 'face'), ('Neck', r'^neck_of_pancreas$', 'face'), ('Body', r'^body_of_pancreas$', 'face'), ('Tail', r'^tail_of_pancreas$', 'left'),
                 ('Uncinate process', r'^(uncinate_process_of_the_pancreas|ucinate_process1)$', 'bottom'), ('Pancreatic duct', r'^ventral_pancreatic_duct$', 'face')],
    'kidneys': [('Renal cortex', 'part:kidneys', 'face'), ('Medullary pyramids', r'^renal_pyramid_L_a$', 'face'), ('Renal pelvis', r'^renal_pelvis_L$', 'face'),
                ('Ureter', r'^(ureter_L|left_ureter)$', 'face'), ('Adrenal gland', 'part:adrenals', 'top'), ('Renal artery', r'^left_renal_artery$', 'face'), ('Renal vein', r'^(renal_vein_L|left_renal_vein)$', 'face'),
                ('Bladder', 'part:bladder', 'face')],
    'intestine': [('Duodenum', r'^duodenum_descending$', 'face'), ('Duodenal papilla', r'^(hepatopancreatic_ampulla|sphincter_of_hep(at)?opancreatic_ampulla)$', 'face'), ('Jejunum', r'^je[jn][eu]num$', 'face'),
                  ('Ileum', r'^ileum$', 'face'), ('Terminal ileum', r'^ileum_terminal$', 'face')],
    'colon': [('Caecum', r'^caecum$', 'face'), ('Appendix', r'^vermiform_appendix$', 'face'), ('Ascending colon', r'^ascending_colon$', 'face'), ('Hepatic flexure', r'^hepatic_flexure_of_colon$', 'face'),
              ('Transverse colon', r'^transverse_colon$', 'face'), ('Splenic flexure', r'^splenic_flexure_of_colon$', 'face'), ('Descending colon', r'^descending_colon$', 'face'),
              ('Sigmoid colon', r'^sigmoid_colon$', 'face'), ('Rectum', r'^rectum$', 'face')],
    'marrow': [('Skull', 'part:skel_skull', 'dir:0.3,1,0.2'), ('Sternum', 'part:skel_thorax', 'front'), ('Vertebral column', r'^thoracic_vertebra_8$', 'back'), ('Ribs', 'part:skel_thorax', 'dir:1,0,0.3'),
               ('Iliac crest', r'^ilium_compact_bone_L$', 'top'), ('Red marrow', r'^ilium_spongy_bone_L$', 'face'), ('Femur', r'^femur_L$', 'face'), ('Thymus', 'part:thymus', 'front')],
    'reproductive': [('Prostate', r'^(peripheral_zone_of_prostate_[LR]|base_of_prostate)$', 'front'), ('Seminal vesicles', r'^seminal_vesicle$', 'back'), ('Vas deferens', r'^vas_deferens_L$', 'face'),
                     ('Testes', r'^testis_[lr]$', 'front'), ('Uterus', r'^fundus_of_uterus$|^uterus$|^body_of_uterus$', 'top'), ('Cervix', r'^cervix$', 'face'),
                     ('Ovaries', r'^left_ovary$', 'face'), ('Fallopian tubes', r'^ampulla_of_uterine_tube_L$', 'face'), ('Vagina', r'^vagina$', 'face')],
    'breast': [('Mammary lobes', r'^mammary_lobes_L$', 'face'), ('Lactiferous ducts', r'^main_lactiferous_ducts_R$', 'front')],
}
PIN = dict(brain=('part:brain', 'dir:0.2,0.6,0.8'), thyroid=('part:thyroid', 'front'), airway=('part:airway', 'face'), lungs=('part:lung_r_upper', 'face'), heart=(r'^(heart_)?left_ventricle$', 'face'),
           esophagus=('part:esophagus', 'face'), liver=('part:liver', 'dir:-0.6,0.1,0.8'), stomach=('part:stomach', 'face'), spleen=('part:spleen', 'face'), pancreas=('part:pancreas', 'face'),
           kidneys=(r'^kidneys_R$', 'face'), intestine=(r'^je[jn][eu]num$', 'face'), colon=(r'^ascending_colon$', 'face'), marrow=(r'^ilium_compact_bone_L$', 'top'),
           reproductive=(r'^(uterus|body_of_uterus|fundus_of_uterus|(peripheral|central|transition)_zone_+of_prostate_[LR])$', 'face'), breast=(r'^mammary_lobes_R$', 'face'), skin=('part:skin', 'front'))
DIRS = dict(top=(0, 1, 0), bottom=(0, -1, 0), left=(1, 0, 0), right=(-1, 0, 0), front=(0, 0, 1), back=(0, 0, -1))


def place(v, rule, view):
    """A surface point of vertices v for a placement rule."""
    c = v.mean(0)
    if rule == 'face':
        d = np.asarray(view, float); d /= np.linalg.norm(d)
        rel = v - c; along = rel @ d; perp = np.linalg.norm(rel - np.outer(along, d), axis=1)
        r = np.quantile(np.linalg.norm(rel, axis=1), 0.9)
        m = perp <= 0.35 * r
        if not m.any(): m = perp <= np.quantile(perp, 0.1)
        return v[m][np.argmax(along[m])]
    d = np.asarray([float(x) for x in rule[4:].split(',')] if rule.startswith('dir:') else DIRS[rule], float); d /= np.linalg.norm(d)
    return v[np.argmax((v - c) @ d)]


def landmarks(structs, parts_v, sex):
    """structs: {structure name without sex prefix: vertices (app frame)}; parts_v: {part: vertices}."""
    def verts(src):
        if src.startswith('part:'): return parts_v.get(src[5:])
        rx = re.compile(src)
        vs = [v for n, v in structs.items() if rx.search(n)]
        return np.concatenate(vs) if vs else None
    out, pins, missing = {}, {}, []
    for organ, items in LANDMARKS.items():
        for name, src, rule in items:
            v = verts(src)
            if v is None or not len(v): missing.append(f'{organ}/{name}'); continue
            out.setdefault(organ, []).append(dict(name=name, at=[round(float(x), 4) for x in place(v, rule, VIEW[organ])]))
    for organ, (src, rule) in PIN.items():
        v = verts(src)
        if v is not None and len(v): pins[organ] = [round(float(x), 4) for x in place(v, rule, VIEW[organ])]
    return out, pins, missing


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    rigs = [assemble(sex) for sex in (('male', 'female') if which == 'all' else (which,))]
    if any(r['inward_failing'] for r in rigs): sys.exit(1)
