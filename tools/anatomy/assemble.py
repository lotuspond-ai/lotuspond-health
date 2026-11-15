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
                      laplacian_smooth_field, face_normals, signed_volume, save, load, components, CACHE, compact, cap_holes)
from catalog import PARTS, HRA_EXCLUDE, LOBE_PATH  # noqa: E402
from lib.inflate import inflated_hra, inflation_report  # noqa: E402

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
                  carve=[(r'cardiac_chamber/', 0.004), (r'blood_vasculature_of_heart/.*' + CORONARY, 0.004), (r'blood_vasculature_of_heart/.*' + CARDIAC_VEINS, 0.004),
                         ('fit:costal_cartilage', 0.001)]),  # the rib cage fit's costal cartilages (8r reached 1.7 mm into the liver)
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

# Thread-thin HRA vessels and ducts are loaded at adult calibre from lib/inflate.py (inflated_hra: a cached shared step,
# also read by the vessels and organs fits): the male descending aorta x1.5 (its centreline moved off the vertebral
# bodies and discs), the renal arteries 2.5 mm; the female common bile and hepatic ducts 2.5 mm, the superior mesenteric
# artery 3.5 mm at its origin. Their junction neighbours move with them and the renal veins and vena cava are pushed
# out of the inflated arteries there, so the lung lobes and the liver are carved round the inflated vessels too.
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
    """[(meshes, margin)] of a carve list: HRA node-path regexes, or 'fit:<part>' for every fitted structure of a part."""
    s = source(f'hra-{sex}')
    out = []
    for rx, margin in carve or ():
        if rx.startswith('fit:'):
            ms = [m for _, m, _ in fitted(sex).get(rx[4:], [])]
            if ms: out.append((ms, margin))
            continue
        es = [o for o in s.index if re.search(rx, o['path']) and not re.search(HRA_EXCLUDE, o['path']) and o['name'] not in fit_excludes(sex)]
        if es: out.append(([load_hra(sex, s, o) for o in es], margin))
    return out


def _smooth01(x):
    x = np.clip(x, 0.0, 1.0); return x * x * (3 - 2 * x)


def load_hra(sex, s, o):
    """An HRA mesh as stored, or as lib/inflate.py leaves it (inflated, moved with an inflated vessel's junction, or a
    vein pushed out of an inflated artery)."""
    m = inflated_hra(sex).get(o['name'])
    if m is not None and len(s.by_name.get(o['name'], ())) == 1: return m
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


_FITTED = {}
def fitted(sex):
    """Fitted Z-Anatomy structures by part: {part: [(name, (v, f), sources)]} (the 'inflated' folder is lib/inflate.py's
    cache of HRA vessels, not a fit group)."""
    if sex in _FITTED: return _FITTED[sex]
    out = _FITTED[sex] = {}
    d = os.path.join(FIT, sex)
    if not os.path.isdir(d): return out
    for group in sorted(os.listdir(d)):
        if group == 'inflated': continue
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


def inset_union(mesh, containers, mask, depth=0.0003, iters=8):
    """Pull the masked vertices of a structure inside the union of closed containers (each vertex towards the container
    nearest to it) to `depth` inside, with the smooth falloff of `inset`. Returns (v, (before, after) deepest outside
    reach of the masked vertices, (before, after) share of them outside)."""
    v, f = mesh; v = v.copy()
    cs = [(cv, cf, RayParity(cv, cf)) for cv, cf in containers]
    def sdq(p):
        best = np.full(len(p), np.inf); q = p.copy()
        for cv, cf, rp in cs:
            qq, d = closest_on_mesh(cv, cf, p, k=16); sd = np.where(rp.inside(p), -d, d)
            m = sd < best; best[m] = sd[m]; q[m] = qq[m]
        return best, q
    sd0, _ = sdq(v)
    for _ in range(iters):
        sd, q = sdq(v)
        bad = (sd > -depth) & mask
        if not bad.any(): break
        n = q[bad] - v[bad]; n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        n = np.where((sd[bad] < 0)[:, None], -n, n)
        D = np.zeros_like(v); D[bad] = n * (sd[bad] + depth + 1e-5)[:, None]
        S = laplacian_smooth_field(f, D, iters=12, lam=0.6)
        keep = np.linalg.norm(D, axis=1) >= np.linalg.norm(S, axis=1)
        v += np.where(keep[:, None], D, S)
    sd1, _ = sdq(v)
    return v, (float(sd0[mask].max()), float(sd1[mask].max())), (round(float((sd0[mask] > 0).mean()), 4), round(float((sd1[mask] > 0).mean()), 4))


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


def renal_stumps(vessel, kidney, lo=0.0015, hi=0.04):
    """Open lateral stumps of a renal vessel that stops short of the hilum: border loops whose centre lies lo-hi outside
    the kidney and within 15 mm of the vessel's nearest approach to it (its lateral end, not a tributary's opening); of
    a double-walled stump (loops within 3 mm) the outer loop. Returns [(loop, centre, radius, distance to the kidney)]."""
    v, f = vessel; kv, kf = kidney
    loops = [(v[L].mean(0), float(np.linalg.norm(v[L] - v[L].mean(0), axis=1).mean()), L) for L in border_loops(f)]
    if not loops: return []
    _, dk = closest_on_mesh(kv, kf, np.array([c for c, _, _ in loops]), k=16)
    _, dv = closest_on_mesh(kv, kf, v[::max(1, len(v) // 4000)], k=16)
    inside = RayParity(kv, kf).inside(np.array([c for c, _, _ in loops]))
    out = []
    for (c, r, L), d, ins in zip(loops, dk, inside):
        if ins or not (lo < d < hi) or r < 0.0008 or d > dv.min() + 0.015: continue
        for st in out:
            if np.linalg.norm(st[1] - c) < 0.003:
                if r > st[2]: st[:] = [L, c, r, float(d)]
                break
        else: out.append([L, c, r, float(d)])
    return out


def _hermite(c0, m0, c1, m1, t):
    t = np.asarray(t, float)[:, None]
    h00, h10, h01, h11 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t, -2 * t**3 + 3 * t**2, t**3 - t**2
    p = h00 * c0 + h10 * m0 + h01 * c1 + h11 * m1
    d = (6 * t**2 - 6 * t) * c0 + (3 * t**2 - 4 * t + 1) * m0 + (-6 * t**2 + 6 * t) * c1 + (3 * t**2 - 2 * t) * m1
    return p, d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-12)


def stump_axis(v, L):
    """Centre and outward axis of an open border loop: the normal of the loop's plane, pointing away from the vessel."""
    P = v[L]; c = P.mean(0)
    _, V = np.linalg.eigh(np.cov((P - c).T)); a = V[:, 0]
    dv = np.linalg.norm(v - c, axis=1); back = v[(dv > 0.003) & (dv < 0.012)]
    if len(back) and a @ (c - back.mean(0)) < 0: a = -a
    return c, a


def bridge_path(c0, a0, q, depth=0.004):
    """Hermite path from a stump (centre c0, axis a0) into the kidney at surface point q, ending `depth` inside."""
    a1 = (q - c0) / max(np.linalg.norm(q - c0), 1e-9); a1 = a1 + 0.5 * a0; a1 /= np.linalg.norm(a1)
    c1 = q + depth * a1; L = np.linalg.norm(c1 - c0)
    return c1, a1, 0.7 * L * a0, 0.7 * L * a1


def stump_bridge(v, L, c1, m0, m1, r1, J=20, blend=0.005):
    """A tube swept from the open border loop L of the vessel (v): its first ring is the loop's own vertices, its section
    blends from the loop's shape and radius to a circle over `blend` of arc length while the radius eases to r1, along
    the Hermite curve to c1 (end tangents m0, m1), the far end capped. Returns (v, f) wound outwards; the first ring
    coincides with the stump, so the vessel and its bridge share that ring (no stand-off, no seam)."""
    P = v[L]; c0, a0 = stump_axis(v, L)
    rel = P - c0; h = rel @ a0
    e1 = rel[0] - h[0] * a0; e1 /= np.linalg.norm(e1); e2 = np.cross(a0, e1)
    th = np.arctan2(rel @ e2, rel @ e1); rho = np.hypot(rel @ e1, rel @ e2); r0 = float(rho.mean())
    ts = np.linspace(0, 1, 401); pc, _ = _hermite(c0, m0, c1, m1, ts)
    arc = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pc, axis=0), axis=1))]
    tj = np.linspace(0, 1, J + 1); C, T = _hermite(c0, m0, c1, m1, tj); T[0] = a0
    sj = np.interp(tj, ts, arc)
    K = len(L); V = [P.copy()]; ep = e1
    for j in range(1, J + 1):
        e = ep - T[j] * (ep @ T[j]); e /= np.linalg.norm(e); ep = e; f2 = np.cross(T[j], e)  # parallel transport
        b = _smooth01(sj[j] / blend); r = r0 + (r1 - r0) * _smooth01(tj[j])
        rad = (1 - b) * rho + b * r
        V.append(C[j] + rad[:, None] * (np.cos(th)[:, None] * e + np.sin(th)[:, None] * f2) + ((1 - b) * h)[:, None] * T[j])
    V = np.concatenate(V + [C[-1][None]])
    F = []
    for j in range(J):
        for k in range(K):
            p0, p1, q0, q1 = j * K + k, j * K + (k + 1) % K, (j + 1) * K + k, (j + 1) * K + (k + 1) % K
            F += [[p0, p1, q0], [p1, q1, q0]]
    tip = len(V) - 1
    F += [[J * K + k, J * K + (k + 1) % K, tip] for k in range(K)]
    F = np.array(F)
    # outward: closed by a temporary cap over the stump ring, the tube must enclose a positive volume
    Fc = np.vstack([F, [[(k + 1) % K, k, len(V)] for k in range(K)]])
    if signed_volume(np.vstack([V, c0]), Fc) < 0: F = F[:, ::-1]
    return V, F


def aim_bridge(c0, a0, r, kidney, avoid, side, reach=0.025):
    """The hilum point a renal vessel's bridge aims at: on the kidney's surface within `reach` of the stump's nearest
    kidney point, on the given side of the vessels to avoid ('behind' for an artery: the vein lies in front of the
    artery at the hilum; 'front' for a vein), at least r + 1 mm from their surfaces (r_other + r + 1 mm from their
    axes), the swept path keeping r + 0.5 mm off them and never running inside one; the shortest such path, else the one
    with the most clearance. Returns (q, clearance of the path from the avoided vessels, m)."""
    from scipy.spatial import cKDTree
    kv, kf = kidney
    q0 = closest_on_mesh(kv, kf, c0[None], k=16)[0][0]
    if not avoid: return q0, None
    cand = dense_points(kv, kf, 0.0008); cand = cand[np.linalg.norm(cand - q0, axis=1) < reach]
    vp = np.concatenate([dense_points(v, f, 0.0005) for v, f in avoid]); tv = cKDTree(vp)
    vin = [RayParity(*cap_holes(v, f)) for v, f in avoid]
    nearv = np.linalg.norm(vp - q0, axis=1) < 0.02
    zref = np.median(vp[nearv][:, 2]) if nearv.any() else None
    fall, fclear = q0, -np.inf
    for q in cand[np.argsort(np.linalg.norm(cand - c0, axis=1))][:2500]:
        c1, a1, m0, m1 = bridge_path(c0, a0, q)
        pts, _ = _hermite(c0, m0, c1, m1, np.linspace(0, 1, 40))
        far = np.linalg.norm(pts - c0, axis=1) > 0.002
        if not far.any(): continue
        dd = tv.query(pts[far])[0]
        clear = float(dd.min()) - r
        if any(rp.inside(pts[far]).any() for rp in vin): clear = -float(dd.max()) - r  # runs inside an avoided vessel
        if clear > fclear: fall, fclear = q, clear
        ok_side = zref is None or (q[2] <= zref if side == 'behind' else q[2] >= zref)
        if float(tv.query(q)[0]) >= r + 0.001 and clear >= 0.0005 and ok_side:
            return q, clear
    return fall, fclear


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
    # vessels and ducts loaded at adult calibre (lib/inflate.py, load_hra)
    ir = inflation_report(sex)
    if ir:
        log['inflated_radius_mm'] = ir.get('radius_mm', {})
        log['inflation_junctions_snapped_mm'] = ir.get('junctions_snapped_mm', {})  # largest mismatch an independent inflation left at each shared ring
        for k in ('rigid', 'near_loops', 'capped_stubs_r_mm', 'pushed', 'stopped', 'kept_ends'):
            if ir.get(k): log[f'inflation_{k}'] = ir[k]
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
    # renal vessels that stop short of the hilum: each open stump is swept on from its own boundary ring into the kidney,
    # the veins first; each artery then aims at a hilum point behind the veins and clear of them, at its own radius
    kid = {n: m for _, n, m, _, _ in acc.get('kidneys', [])}
    for part, vname, end_r in RENAL_EXTEND.get(sex, []):
        vi = [m for _, n, m, _, _ in acc.get(part, []) if n == vname]
        if not vi or not kid: continue
        kname = min(kid, key=lambda k: float(closest_on_mesh(*kid[k], vi[0][0][::max(1, len(vi[0][0]) // 2000)], k=16)[1].min()))
        base = vname if part == 'veins' else f'VH_{sex[0].upper()}_renal_artery_{kname[-1]}'  # the artery's L/R name is swapped later
        # veins keep off the renal arteries and pass in front of them; arteries keep off every renal vein (bridges included)
        # and pass behind them
        other = [m for _, n, m, _, _ in acc.get('arteries' if part == 'veins' else 'veins', []) if re.search(r'renal_(artery|vein)', n)]
        other = [m for m in other if float(closest_on_mesh(*kid[kname], m[0][::max(1, len(m[0]) // 500)], k=8)[1].min()) < 0.03]
        info = []
        for j, (L, c, r, d) in enumerate(renal_stumps(vi[0], kid[kname])):
            c0, a0 = stump_axis(vi[0][0], L)
            q, clear = aim_bridge(c0, a0, r if part == 'arteries' else (end_r or r), kid[kname], other, 'front' if part == 'veins' else 'behind')
            c1, a1, m0, m1 = bridge_path(c0, a0, q)
            t = stump_bridge(vi[0][0], L, c1, m0, m1, end_r if end_r else r)
            acc[part].append(('HRA', f'{base}_hilar_{"abcd"[j] if j < 4 else j}', t, False, [f'derived:{vname} stump {j} swept to the hilum of {kname}']))
            info.append(dict(gap_mm=round(d * 1000, 1), stump_r_mm=round(r * 1000, 2), end_r_mm=round((end_r or r) * 1000, 2),
                             **({} if clear is None else dict(clearance_mm=round(clear * 1000, 2)))))
        # an artery's other open ends on the hilum (a branch stopping at the kidney's surface, not bridged) are capped:
        # an open rim shows in the kidney close-up
        capped = []
        if part == 'arteries':
            v0, f0 = vi[0]; done_ = {frozenset(L) for L, *_ in renal_stumps(vi[0], kid[kname])}
            rest = [L for L in border_loops(f0) if frozenset(L) not in done_]
            if rest:
                _, dk = closest_on_mesh(*kid[kname], np.array([v0[L].mean(0) for L in rest]), k=16)
                caps = [L for L, d_ in zip(rest, dk) if d_ < 0.006]
                if caps:
                    nv = [v0[L].mean(0) for L in caps]; nf = []
                    for i_, L in enumerate(caps): nf += [(L[(k + 1) % len(L)], L[k], len(v0) + i_) for k in range(len(L))]
                    m2 = (np.vstack([v0, np.array(nv)]), np.vstack([f0, np.array(nf, np.int64)]))
                    for i_, it in enumerate(acc[part]):
                        if it[1] == vname: acc[part][i_] = (it[0], it[1], m2, it[3], it[4])
                    capped = [round(float(np.linalg.norm(v0[L] - v0[L].mean(0), axis=1).mean()) * 1000, 2) for L in caps]
        log.setdefault('renal_vessel_extended', {})[vname] = dict(kidney=kname, stumps=len(info), bridges=info, gap_closed_mm=[x['gap_mm'] for x in info],
                                                                  **(dict(capped_ends_r_mm=capped) if capped else {}))
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
    # the penile urethra lies in the corpus spongiosum and the glans (fitted): the part below the spongiosum's top is
    # pulled 0.3 mm inside their union, with a smooth falloff (the skin inset above may have pulled it out)
    if sex == 'male':
        cont = [m for _, n, m, _, _ in acc.get('reproductive', []) if re.search(r'(corpus_spongiosum|glans_penis)$', n)]
        for i, (src, n, m, dbl, paths) in enumerate(acc.get('bladder', [])):
            if not cont or not re.search(r'other_urethra', n): continue
            ytop = max(c[0][:, 1].max() for c in cont)
            v2, (b, a), share = inset_union(m, cont, m[0][:, 1] < ytop, depth=0.0005)
            acc['bladder'][i] = (src, n, (v2, m[1]), dbl, paths)
            log.setdefault('urethra_spongiosum_reach_mm', {})[n] = dict(before=round(b * 1000, 2), after=round(a * 1000, 2), outside_share_before=share[0], outside_share_after=share[1])
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
# the surface that faces the viewer. The brain is seen from its left side (every lobe, the cerebellum and the medulla
# show); the spleen from in front and medially, onto its hilum and the vessels that enter it.
VIEW = dict(brain=(1, 0.25, 0.2), thyroid=(0.25, 0.1, 1), airway=(0.3, 0.1, 1), lungs=(0.2, 0.15, 1), heart=(0.35, 0.12, 1), esophagus=(0.8, 0.1, 0.6),
            liver=(-0.45, 0.1, 1), stomach=(0.5, 0.1, 1), spleen=(-0.5, 0.15, 0.85), pancreas=(0.1, 0.4, 1), kidneys=(-0.15, 0.1, -1), intestine=(0.1, 0.2, 1),
            colon=(0, 0.15, 1), marrow=(0.3, 0.1, 1), reproductive=(0.2, 0.1, 1), breast=(0.25, 0.1, 1), skin=(0, 0, 1))
# Parts each close-up frames (organs.ts `focus`) and the parts of other organs it draws solid (organs.ts `context`: the
# vessels, cartilages and ducts its labels name). Every other organ is a faint ghost in a close-up, and see-through
# tissue (the lungs and the diaphragm, organs.ts TISSUE opacity) hides no label.
FOCUS = dict(brain=('brain',), thyroid=('thyroid', 'parathyroids'), airway=('airway',), lungs=('lung_r_upper', 'lung_r_middle', 'lung_r_lower', 'lung_l_upper', 'lung_l_lower'),
             heart=('heart', 'valves', 'coronary'), esophagus=('esophagus',), liver=('liver', 'gallbladder'), stomach=('stomach',), spleen=('spleen',), pancreas=('pancreas',),
             kidneys=('kidneys',), intestine=('small_int',), colon=('colon',), reproductive=('reproductive',), breast=('breasts',),
             marrow=('skel_spine', 'skel_pelvis', 'skel_thorax'), skin=('skin',))
CONTEXT = dict(thyroid=('airway',), spleen=('arteries', 'portal_vein'), pancreas=('bile_ducts',), kidneys=('arteries', 'veins'), intestine=('bile_ducts',))
SEE_THROUGH = ('lung', 'diaphragm')
L, R = r'_L$', r'_R$'
# organ -> [(landmark name, structure regex (on names without the VH_M_/VH_F_ prefix, or 'part:<id>'), rule)].
# Rules: 'face' (surface point facing the organ's view near the structure's centre), or an extreme point along a
# direction: 'top', 'bottom', 'left' (+x), 'right' (-x), 'front' (+z), 'back' (-z), or 'dir:x,y,z'; 'near:<src>' (the
# point nearest another structure: where a vessel enters an organ); 'nearc:<src>' (the point nearest the centre of
# another structure: a vessel at the middle of its organ's hilum); 'nearmark:<landmark>,...' (the point nearest
# landmarks placed before it in the same organ); 'quant:x,y,z:q' (the front-most point at quantile q along a direction:
# part way along a duct); 'isthmus:<src>' and 'midtop:<src>' (thyroid: the isthmus and the tip of the pyramidal lobe, in
# the midline band below <src>, the cricoid). A rule ending in ' apart:<landmark>,...' keeps 1 cm from those landmarks
# (two vessels entering an organ side by side). Then each label of a close-up moves onto the nearest part of its
# structure the close-up camera sees (CloseUpScene.snap), a few pixels inside its outline and clear of the other dots;
# structures with nothing in view (the valves, the hypothalamus, the cervix behind the uterine body) keep their point and
# are marked hidden. A sub-structure that is not a mesh of its own (the caudate lobe, the pancreas's head) is seen only
# where the surface in view lies on it. Close-up options: ' at:<src>' (move only onto the part within 1 cm of <src>: a
# vessel where it reaches its organ) and ' cover:<mm>' (a structure wrapped in a covering of its own part: the uterus in
# its peritoneum, the broad ligament).
CRICOID = r'^cricoid_cartilage$'
LANDMARKS = {
    'brain': [('Frontal lobe', r'^Allen_(superior|middle)_frontal_gyrus_L$', 'face'), ('Motor cortex', r'^Allen_precentral_gyrus_L$', 'face'),
              ('Sensory cortex', r'^Allen_postcentral_gyrus_L$', 'face'), ('Temporal lobe', r'^Allen_(middle|inferior)_temporal_gyrus_L$', 'face'),
              ('Occipital lobe', r'^Allen_(superior_occipital_gyrus|inferior_occipital_gyrus|occipital_pole)_L$', 'face'),
              ('Cerebellum', r'^Allen_lateral_hemisphere_of_cerebellum_L$', 'face'), ('Brainstem', r'^Allen_pyramidal_part_of_medulla_oblongata_[LR]$', 'bottom'),
              ('Hypothalamus', r'^Allen_(hypothalamus|tuberal_region_of_HTH)_L$', 'bottom'), ('Pituitary gland', 'part:pituitary', 'front'),
              ('Lateral ventricles', r'^Allen_body_of_lateral_ventricle_L$', 'back'), ('Corpus callosum', r'^Allen_corpus_callosum', 'top')],
    'thyroid': [('Right lobe', 'part:thyroid', 'dir:-1,0,0.6'), ('Left lobe', 'part:thyroid', 'dir:1,0,0.6'), ('Isthmus', 'part:thyroid', 'isthmus:' + CRICOID),
                ('Pyramidal lobe', 'part:thyroid', 'midtop:' + CRICOID), ('Parathyroid glands', 'part:parathyroids', 'dir:-1,1,0'),
                ('Thyroid cartilage', r'^thyroid_cartilage$', 'front')],
    'airway': [('Epiglottis', r'^epiglott?ic_cartilage$', 'top'), ('Thyroid cartilage', r'^thyroid_cartilage$', 'front'), ('Cricoid cartilage', r'^cricoid_cartilage$', 'front'),
               ('Trachea', r'^trachea(l_cartilage)?$', 'face'), ('Carina', r'^carina$', 'front'), ('Right main bronchus', r'^right_main_bronchus$', 'right'),
               ('Left main bronchus', r'^left_main_bronchus$', 'left')],
    'lungs': [('Right upper lobe', 'part:lung_r_upper', 'face'), ('Right middle lobe', 'part:lung_r_middle', 'front'), ('Right lower lobe', 'part:lung_r_lower', 'dir:-0.6,-0.4,0.4'),
              ('Left upper lobe', 'part:lung_l_upper', 'face'), ('Lingula', r'^(left_)?lingula_(superior|inferior)_bronchopulmonary_segment$', 'front'),
              ('Left lower lobe', 'part:lung_l_lower', 'dir:0.6,-0.4,0.4'), ('Bronchial tree', 'part:bronchi', 'face'), ('Diaphragm', 'part:diaphragm', 'top')],
    'heart': [('Left ventricle', r'^(heart_)?left_ventricle$', 'face'), ('Right ventricle', r'^(heart_)?right_ventricle$', 'face'), ('Right atrium', r'^right_cardiac_atrium$', 'right'),
              ('Left atrium', r'^left_cardiac_atrium$', 'back'), ('Interventricular septum', r'^interventricular_septum$', 'bottom'), ('Mitral valve', r'^mitral_valve$', 'face'),
              ('Tricuspid valve', r'^tricuspid_valve$', 'face'), ('Aortic valve', r'^aortic_valve$', 'face'), ('Pulmonary valve', r'^pulmonary_valve$', 'face'),
              ('Aortic arch', r'^aortic_arch$', 'top'), ('Pulmonary trunk', r'^pulmonary_trunk$', 'front'), ('Superior vena cava', r'^superior_vena_cava$', 'right'),
              ('Coronary arteries', r'^left_anterior_descending_artery$', 'face'), ('Apex', r'^(heart_)?left_ventricle$', 'dir:0.55,-0.6,0.55')],
    'esophagus': [('Esophagus', 'part:esophagus', 'face'), ('Gastro-esophageal junction', 'part:esophagus', 'bottom')],
    'liver': [('Right lobe', 'part:liver', 'dir:-0.8,0,0.6'), ('Left lobe', 'part:liver', 'dir:0.9,0.1,0.4'), ('Caudate lobe', r'^caudate_lobe(_of_liver)?$', 'back'),
              ('Quadrate lobe', r'^quadrate_lobe(_of_liver)?$', 'bottom'), ('Falciform ligament', r'^falciform_ligament$', 'front'), ('Gallbladder', 'part:gallbladder', 'bottom'),
              ('Porta hepatis', r'^porta_hepatis$', 'bottom'), ('Hepatic artery', r'^proper_hepatic_artery$', 'front'), ('Hepatic veins', 'part:hepatic_veins', 'top'), ('Portal vein', r'^(hepatic_)?portal_vein$', 'front'),
              ('Common bile duct', r'^common_bile_duct$', 'front')],
    # the pylorus where the stomach meets the duodenal bulb (its right-most point can be a fold of the antrum)
    'stomach': [('Fundus', 'part:stomach', 'top'), ('Body', 'part:stomach', 'face'), ('Greater curvature', 'part:stomach', 'dir:0.7,-0.6,0.3'),
                ('Pylorus', 'part:stomach', 'near:^duodenum_superior$')],
    # the splenic artery and vein are labelled where they reach the spleen, the hilum on the spleen next to them
    'spleen': [('Splenic artery', r'^splenic_artery$', 'nearc:^hilum_of_spleen$ at:part:spleen'),
               ('Splenic vein', r'^splenic_vein$', 'nearc:^hilum_of_spleen$ apart:Splenic artery at:part:spleen'),
               ('Hilum', r'^hilum_of_spleen$', 'nearmark:Splenic artery,Splenic vein apart:Splenic artery,Splenic vein')],
    'pancreas': [('Head', r'^head_of_pancreas$', 'face'), ('Neck', r'^neck_of_pancreas$', 'face'), ('Body', r'^body_of_pancreas$', 'face'), ('Tail', r'^tail_of_pancreas$', 'left'),
                 ('Uncinate process', r'^(uncinate_process_of_the_pancreas|ucinate_process1)$', 'bottom'), ('Pancreatic duct', r'^ventral_pancreatic_duct$', 'quant:1,0,0:0.7')],
    # the left kidney's hilum carries the vessels, the pelvis is labelled where it leaves the sinus for the ureter (behind
    # the vessels, so the posterior view sees it), and the cortex on the right kidney
    'kidneys': [('Renal cortex', r'^kidneys_R$', 'face'), ('Medullary pyramids', r'^renal_pyramid_L_a$', 'face'), ('Renal pelvis', r'^renal_pelvis_L$', 'bottom'),
                ('Ureter', r'^(ureter_L|left_ureter)$', 'face'), ('Adrenal gland', 'part:adrenals', 'top'), ('Renal artery', r'^left_renal_artery$', 'near:part:kidneys at:part:kidneys'),
                ('Renal vein', r'^(renal_vein_L|left_renal_vein)(_hilar_[a-z])?$', 'near:part:kidneys apart:Renal artery,Renal pelvis'), ('Bladder', 'part:bladder', 'face')],
    'intestine': [('Duodenum', r'^duodenum_descending$', 'face'), ('Duodenal papilla', r'^(hepatopancreatic_ampulla|sphincter_of_hep(at)?opancreatic_ampulla)$', 'face'), ('Jejunum', r'^je[jn][eu]num$', 'face'),
                  ('Ileum', r'^ileum$', 'face'), ('Terminal ileum', r'^ileum_terminal$', 'face')],
    'colon': [('Caecum', r'^caecum$', 'face'), ('Appendix', r'^vermiform_appendix$', 'face'), ('Ascending colon', r'^ascending_colon$', 'face'), ('Hepatic flexure', r'^hepatic_flexure_of_colon$', 'face'),
              ('Transverse colon', r'^transverse_colon$', 'face'), ('Splenic flexure', r'^splenic_flexure_of_colon$', 'face'), ('Descending colon', r'^descending_colon$', 'face'),
              ('Sigmoid colon', r'^sigmoid_colon$', 'face'), ('Rectum', r'^rectum$', 'face')],
    # red marrow in adults: the vertebral bodies (L3's, between the iliac crests), the flat bones and the upper femur
    'marrow': [('Skull', 'part:skel_skull', 'dir:0.3,1,0.2'), ('Sternum', 'part:skel_thorax', 'front'), ('Vertebral column', r'^lumbar_vertebra_3$', 'front'), ('Ribs', 'part:skel_thorax', 'dir:1,0,0.3'),
               ('Iliac crest', r'^ilium_compact_bone_L$', 'top'), ('Red marrow', r'^ilium_spongy_bone_L$', 'face'), ('Femur', r'^femur_L$', 'dir:0.3,1,0.4'), ('Thymus', 'part:thymus', 'front')],
    # the ovary and the uterine tube on opposite sides, so their labels do not sit on each other
    'reproductive': [('Prostate', r'^(peripheral_zone_of_prostate_[LR]|base_of_prostate)$', 'front'), ('Seminal vesicles', r'^seminal_vesicle$', 'back'), ('Vas deferens', r'^vas_deferens_L$', 'face'),
                     ('Testes', r'^testis_[lr]$', 'front'), ('Uterus', r'^fundus_of_uterus$|^uterus$|^body_of_uterus$', 'top cover:8'), ('Cervix', r'^cervix$', 'face'),
                     ('Ovaries', r'^left_ovary$', 'face'), ('Fallopian tubes', r'^(ampulla_of_uterine_tube|uterine_tube_infundibulum|fibria_of_uterine_tube)_R$', 'face'), ('Vagina', r'^vagina$', 'face')],
    'breast': [('Mammary lobes', r'^mammary_lobes_L$', 'face'), ('Lactiferous ducts', r'^main_lactiferous_ducts_R$', 'front')],
}
# Whole-body pins: on the organ where the front view sees it (the lungs on the side of the right upper lobe, clear of
# the heart; the thyroid on its isthmus). The pancreas pin is on the lower front of its head, in the duodenal loop: of the
# rules tried it keeps farthest from the other pins over the 16 turntable angles (at least 36 mm F / 19 mm M from any
# pin, 52 / 74 mm from the stomach's), where its tail came within 13 mm of the stomach pin (F) and 14 mm of the spleen's (M).
PIN = dict(brain=('part:brain', 'dir:0.2,0.6,0.8'), thyroid=('part:thyroid', 'isthmus:' + CRICOID), airway=('part:airway', 'face'), lungs=('part:lung_r_upper', 'dir:-1,0.2,0.6'),
           heart=(r'^(heart_)?left_ventricle$', 'face'), esophagus=('part:esophagus', 'face'), liver=('part:liver', 'dir:-0.6,0.1,0.8'), stomach=('part:stomach', 'face'),
           spleen=('part:spleen', 'face'), pancreas=('part:pancreas', 'dir:0,-1,0.4'), kidneys=(r'^kidneys_R$', 'face'), intestine=(r'^je[jn][eu]num$', 'face'), colon=(r'^ascending_colon$', 'face'),
           marrow=(r'^ilium_compact_bone_L$', 'top'), reproductive=(r'^(uterus|body_of_uterus|fundus_of_uterus|(peripheral|central|transition)_zone_+of_prostate_[LR])$', 'face'),
           breast=(r'^mammary_lobes_R$', 'face'), skin=('part:skin', 'front'))
DIRS = dict(top=(0, 1, 0), bottom=(0, -1, 0), left=(1, 0, 0), right=(-1, 0, 0), front=(0, 0, 1), back=(0, 0, -1))


def split_rule(rule):
    """A rule without its close-up options, and the options: ' at:<src>' (the label moves only onto the part of its
    structure within 1 cm of <src>: a vessel where it reaches its organ) and ' cover:<mm>' (a structure wrapped in a
    covering of its own part, as the uterus is in its peritoneum: the covering within that distance of it shows it)."""
    return re.sub(r' (at|cover):\S+', '', rule), dict(re.findall(r' (at|cover):(\S+)', rule))


def place(v, rule, view, verts=None, marks=None):
    """A surface point of vertices v for a placement rule (verts: structure lookup, marks: points placed so far)."""
    if ' apart:' in rule:
        rule, _, names = rule.partition(' apart:')
        near = np.array([marks[n] for n in names.split(',') if n in marks])
        if len(near):
            far = v[np.min(np.linalg.norm(v[:, None] - near[None], axis=2), axis=1) >= 0.01]
            if len(far): v = far
    c = v.mean(0)
    if rule == 'face':
        d = np.asarray(view, float); d /= np.linalg.norm(d)
        rel = v - c; along = rel @ d; perp = np.linalg.norm(rel - np.outer(along, d), axis=1)
        r = np.quantile(np.linalg.norm(rel, axis=1), 0.9)
        m = perp <= 0.35 * r
        if not m.any(): m = perp <= np.quantile(perp, 0.1)
        return v[m][np.argmax(along[m])]
    kind, _, arg = rule.partition(':')
    if kind in ('near', 'nearc', 'nearmark'):
        from scipy.spatial import cKDTree
        other = verts(arg) if kind != 'nearmark' else np.array([marks[n] for n in arg.split(',') if n in marks])
        if other is None or not len(other): return place(v, 'face', view)
        if kind != 'near': other = other.mean(0, keepdims=True)  # nearest the centre of <src> (nearc) or of the marks
        return v[np.argmin(cKDTree(other).query(v)[0])]
    if kind == 'quant':
        dv, q = arg.rsplit(':', 1)
        d = np.asarray([float(x) for x in dv.split(',')], float); d /= np.linalg.norm(d)
        t = v @ d; sl = v[np.abs(t - np.quantile(t, float(q))) <= 0.002]
        return sl[np.argmax(sl @ (np.asarray(view, float) / np.linalg.norm(view)))]
    if kind in ('isthmus', 'midtop'):
        # the thyroid's midline band (|x - midline| < 6 mm) below the cricoid: the isthmus is its full-width part, at the
        # band's median height (its front surface there); a pyramidal lobe rises from it in front of the cricoid
        cr = verts(arg)
        x0 = np.median(cr[:, 0]) if cr is not None and len(cr) else np.median(v[:, 0])
        band = v[np.abs(v[:, 0] - x0) < 0.006]
        if kind == 'midtop': return band[np.argmax(band[:, 1])] if len(band) else v[np.argmax(v[:, 2])]
        low = band[band[:, 1] < cr[:, 1].min()] if cr is not None and len(cr) else band
        if len(low) < 10: low = band if len(band) else v
        yc = np.median(low[:, 1])
        sl = low[np.abs(low[:, 1] - yc) <= 0.0025]
        return sl[np.argmax(sl[:, 2])]
    d = np.asarray([float(x) for x in arg.split(',')] if kind == 'dir' else DIRS[rule], float); d /= np.linalg.norm(d)
    return v[np.argmax((v - c) @ d)]


class CloseUpScene:
    """An organ's close-up as the render page draws it: framed on its focus parts and labels (RenderPage.tsx place()),
    its parts and its context parts solid, rasterised (depth and structure id per pixel) to find what the camera sees."""
    FOV, ASPECT, W, H = 30.0, 2 / 3, 320, 480

    def __init__(self, sex, organ, marks):
        d = os.path.join(OUT, sex)
        names = json.load(open(os.path.join(d, 'structures.json')))
        own = [p for p in FOCUS.get(organ, ()) if p in names and SPEC[p]['organ'] == organ] or [p for p in names if SPEC.get(p, {}).get('organ') == organ]
        solid = [p for p in names if p in SPEC and (SPEC[p]['organ'] == organ or p in CONTEXT.get(organ, ())) and SPEC[p]['tissue'] not in SEE_THROUGH]
        self.parts, lo, hi = {}, np.full(3, np.inf), np.full(3, -np.inf)
        for p in set(own) | set(solid):
            v, f = load(os.path.join(d, p + '.npz'))
            seg = list(np.fromfile(os.path.join(d, p + '.seg'), np.uint32).astype(np.int64)) + [len(f)]
            self.parts[p] = (v, f, seg, [re.sub(r'^VH_[MF]_', '', s['name'].split('/')[-1]) for s in names[p]])
            if p in own: lo, hi = np.minimum(lo, v.min(0)), np.maximum(hi, v.max(0))
        for m in marks: lo, hi = np.minimum(lo, m), np.maximum(hi, m)
        tgt = (lo + hi) / 2; radius = (hi - lo).max() * 0.62
        vf = np.radians(self.FOV / 2); self.tv = np.tan(vf); self.th = self.tv * self.ASPECT
        self.dist = max(0.2, radius / np.sin(min(vf, np.arctan(self.th))) * 1.3)
        z = np.asarray(VIEW[organ], float); z /= np.linalg.norm(z)
        self.pos = tgt + z * self.dist
        x = np.cross((0, 1.0, 0), z); x /= np.linalg.norm(x)
        self.x, self.y, self.z = x, np.cross(z, x), z
        self.names, self.depth, self.ident = [], np.full(self.W * self.H, np.inf), np.full(self.W * self.H, -1, np.int64)
        for p in solid:
            v, f, seg, sn = self.parts[p]
            fid = np.empty(len(f), np.int64)
            for i, n in enumerate(sn): fid[seg[i]:seg[i + 1]] = len(self.names) + i
            self.names += [(p, n) for n in sn]
            self._raster(v, f, fid)
        self.depth = self.depth.reshape(self.H, self.W); self.ident = self.ident.reshape(self.H, self.W)
        self.px = 2 * self.dist * self.tv / self.H  # pixel size (m) at the view centre

    def project(self, p):
        r = np.atleast_2d(p) - self.pos; d = -(r @ self.z)
        return (r @ self.x / (d * self.th) + 1) / 2 * self.W, (1 - r @ self.y / (d * self.tv)) / 2 * self.H, d

    def unproject(self, px, py, d):
        ray = -self.z + (2 * px / self.W - 1) * self.th * self.x + (1 - 2 * py / self.H) * self.tv * self.y
        return self.pos + ray * d

    def _raster(self, v, f, fid):
        W, H = self.W, self.H
        u, w, d = self.project(v)
        X, Y, D = u[f], w[f], d[f]
        x0, x1 = np.floor(X.min(1)).astype(int), np.ceil(X.max(1)).astype(int)
        y0, y1 = np.floor(Y.min(1)).astype(int), np.ceil(Y.max(1)).astype(int)
        size = np.maximum(x1 - x0, y1 - y0)
        ok = (x1 >= 0) & (x0 < W) & (y1 >= 0) & (y0 < H) & (D.min(1) > 0)
        lo = -1
        for s in (1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64, 128, 256, 1024):
            sel = np.where(ok & (size > lo) & (size <= s))[0]; lo = s
            gi, gj = np.meshgrid(np.arange(s + 1), np.arange(s + 1), indexing='ij'); gi, gj = gi.ravel(), gj.ravel()
            for c0 in range(0, len(sel), max(1, int(1e6 // (s + 1) ** 2))):
                t = sel[c0:c0 + max(1, int(1e6 // (s + 1) ** 2))]
                cx, cy = x0[t][:, None] + gi[None] + 0.5, y0[t][:, None] + gj[None] + 0.5
                ax, ay, bx, by, qx, qy = X[t, 0, None], Y[t, 0, None], X[t, 1, None], Y[t, 1, None], X[t, 2, None], Y[t, 2, None]
                den = (by - qy) * (ax - qx) + (qx - bx) * (ay - qy); den = np.where(np.abs(den) < 1e-12, 1e-12, den)
                l0 = ((by - qy) * (cx - qx) + (qx - bx) * (cy - qy)) / den
                l1 = ((qy - ay) * (cx - qx) + (ax - qx) * (cy - qy)) / den
                l2 = 1 - l0 - l1
                ii, jj = np.nonzero((l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6) & (cx >= 0) & (cx < W) & (cy >= 0) & (cy < H))
                if not len(ii): continue
                pix = cy[ii, jj].astype(int) * W + cx[ii, jj].astype(int)
                dv = (l0 * D[t, 0, None] + l1 * D[t, 1, None] + l2 * D[t, 2, None])[ii, jj]
                o = np.lexsort((dv, pix)); pix, dv, iv = pix[o], dv[o], fid[t][ii][o]
                first = np.r_[True, pix[1:] != pix[:-1]]; pix, dv, iv = pix[first], dv[first], iv[first]
                better = dv < self.depth[pix]
                self.depth[pix[better]] = dv[better]; self.ident[pix[better]] = iv[better]

    def ids(self, src, p):
        """(structure ids, exact) of a label's structure in the rasterised scene: by name or by part (exact), or for a
        sub-structure that is not a mesh of its own (the pancreas's head, the liver's caudate lobe, the cervix) the part
        whose surface it lies on (not exact: region() keeps to the pixels on the structure itself). None when that is a
        part the close-up does not draw solid (see-through lung lobes): nothing to move onto, only occluders to test."""
        drawn = {q for q, _ in self.names}
        if src.startswith('part:'): return ([i for i, (q, _) in enumerate(self.names) if q == src[5:]] if src[5:] in drawn else None), True
        rx = re.compile(src)
        out = [i for i, (_, n) in enumerate(self.names) if rx.search(n)]
        if out: return out, True
        dist, q = min(((np.linalg.norm(v - p, axis=1).min(), q) for q, (v, *_) in self.parts.items()), default=(np.inf, None))
        if dist > 0.012: return [], True
        return ([i for i, (r, _) in enumerate(self.names) if r == q] if q in drawn else None), False

    def near(self, mask, pts, reach):
        """The pixels of mask whose front-most surface point lies within reach (m) of the points pts."""
        from scipy.spatial import cKDTree
        yy, xx = np.nonzero(mask)
        out = np.zeros_like(mask)
        if len(xx) and pts is not None and len(pts):
            P = self.unproject(xx[:, None] + 0.5, yy[:, None] + 0.5, self.depth[yy, xx][:, None])
            out[yy, xx] = cKDTree(pts).query(P, distance_upper_bound=reach)[0] <= reach
        return out

    def region(self, src, p, own=None, at=None, cover=0.0):
        """(ids, mask): the pixels where the camera sees a label's structure. Its own mesh; for a sub-structure without one,
        the pixels of its part whose surface lies on it (within 5 mm of its vertices, or 1.5 vertex spacings on a coarse
        mesh); for a structure wrapped in a covering of its own part (cover > 0, metres), the covering within cover of it;
        with `at` (vertices), only the pixels within 1 cm of them, where that leaves any."""
        from scipy.spatial import cKDTree
        ids, exact = self.ids(src, p)
        if ids is None: return None, None
        mask = np.isin(self.ident, ids)
        if own is not None and len(own) > 1 and (not exact or (cover and mask.sum() < 12)):
            if exact: part = {self.names[i][0] for i in ids}; mask = self.near(np.isin(self.ident, [i for i, (q, _) in enumerate(self.names) if q in part]), own, cover)
            else: mask = self.near(mask, own, max(0.005, 1.5 * float(np.median(cKDTree(own).query(own, k=2)[0][:, 1]))))
        if at is not None and len(at):
            m = self.near(mask, at, 0.01)
            if m.sum() >= 12: mask = m
        return ids, mask

    @staticmethod
    def erode(mask, n=3):
        """mask and up to n successive one-pixel erosions of it, while some pixels remain (the outermost first)."""
        out = [mask]
        for _ in range(n):
            c = out[-1].copy(); c[1:] &= out[-1][:-1]; c[:-1] &= out[-1][1:]; c[:, 1:] &= out[-1][:, :-1]; c[:, :-1] &= out[-1][:, 1:]
            if c.sum() < 3: break
            out.append(c)
        return out

    def room(self, region):
        """Pixels a label has to move within (its structure's visible core): labels with the least room go first."""
        return -1 if region[0] is None else int(self.erode(region[1])[-1].sum())

    def snap(self, p, region, tol=0.0025, taken=()):
        """(point, seen, moved px): p when its structure is the front-most surface there, a few pixels inside its outline
        and clear of the dots placed before it; else the nearest such point where the camera sees its structure; else p,
        not seen (an inner structure, or one turned away)."""
        u, w, d = (a[0] for a in self.project(p))
        ix, iy = int(np.floor(u)), int(np.floor(w))
        inside = 0 <= ix < self.W and 0 <= iy < self.H
        front = inside and d <= self.depth[iy, ix] + max(tol, 3 * self.px)
        ids, mask = region
        if ids is None: return p, bool(front or not inside), 0.0
        if mask.sum() < 12: return p, False, 0.0
        # Where its dot goes: the nearest pixel of its structure, preferring (by a cost in pixels of a 480 px tall frame)
        # pixels up to three in from its outline (so the dot stays on it from a slightly different camera and on the
        # simplified model), with no nearer surface within two pixels (that would hide it from the render page's ray
        # test), and 14 px clear of the dots placed before it. The raw point stays when it already is such a pixel.
        levels = self.erode(mask)
        lvl = np.sum(levels[1:], axis=0) if len(levels) > 1 else np.zeros(mask.shape, int)
        top = len(levels) - 1
        dp = np.pad(np.where(np.isfinite(self.depth), self.depth, np.inf), 2, constant_values=np.inf)
        nearest = np.min([dp[2 + dy:2 + dy + self.H, 2 + dx:2 + dx + self.W] for dy in range(-2, 3) for dx in range(-2, 3)], axis=0)
        safe = nearest >= self.depth - max(tol, 3 * self.px)
        clear = np.ones_like(mask)
        if len(taken):
            gy, gx = np.mgrid[0:self.H, 0:self.W]
            for tx, ty in taken: clear &= (gx + 0.5 - tx) ** 2 + (gy + 0.5 - ty) ** 2 >= (14 * self.H / 480) ** 2
        if front and mask[iy, ix] and lvl[iy, ix] >= min(1, top) and safe[iy, ix] and clear[iy, ix]: return p, True, 0.0
        yy, xx = np.nonzero(mask)
        unit = self.H / 480
        cost = np.hypot(xx + 0.5 - u, yy + 0.5 - w) + unit * (6.0 * (top - lvl[yy, xx]) + 20.0 * ~safe[yy, xx] + 40.0 * ~clear[yy, xx])
        k = np.argmin(cost)
        return self.unproject(xx[k] + 0.5, yy[k] + 0.5, self.depth[yy[k], xx[k]]), True, float(np.hypot(xx[k] + 0.5 - u, yy[k] + 0.5 - w))


def landmarks(structs, parts_v, sex, scenes=True):
    """structs: {structure name without sex prefix: vertices (app frame)}; parts_v: {part: vertices}. With `scenes`,
    each close-up's labels are moved onto what its camera sees (reads the parts assemble() has just written); a label
    whose structure the close-up camera cannot see gets hidden=True (the render page draws it faded)."""
    def verts(src):
        if src.startswith('part:'): return parts_v.get(src[5:])
        rx = re.compile(src)
        vs = [v for n, v in structs.items() if rx.search(n)]
        return np.concatenate(vs) if vs else None
    out, pins, missing, report = {}, {}, [], {}
    for organ, items in LANDMARKS.items():
        placed, srcs, seen, opts = {}, {}, {}, {}
        for name, src, rule in items:
            v = verts(src)
            if v is None or not len(v): missing.append(f'{organ}/{name}'); continue
            rule, opts[name] = split_rule(rule)
            placed[name] = place(v, rule, VIEW[organ], verts, placed); srcs[name] = src
        if not placed: continue
        if scenes:
            # twice: the render page frames the close-up on the labels where they end up. The labels with the least room
            # (the smallest visible part of their structure) are placed first, so that those with more move aside.
            raw, marks = dict(placed), list(placed.values())
            for _ in range(2):
                sc, taken = CloseUpScene(sex, organ, marks), []
                regions = {n: sc.region(srcs[n], raw[n], verts(srcs[n]), verts(opts[n]['at']) if 'at' in opts[n] else None,
                                        float(opts[n].get('cover', 0)) / 1000) for n in placed}
                for name in sorted(placed, key=lambda n: sc.room(regions[n])):
                    placed[name], seen[name], moved = sc.snap(raw[name], regions[name], taken=taken)
                    u, w, _ = sc.project(placed[name]); taken.append((u[0], w[0]))
                    report[f'{organ}/{name}'] = dict(seen=seen[name], moved_px=round(moved * 480 / sc.H, 1))
                marks = list(placed.values())
        out[organ] = [dict(name=n, at=[round(float(x), 4) for x in p], **({} if seen.get(n, True) else dict(hidden=True))) for n, p in placed.items()]
    for organ, (src, rule) in PIN.items():
        v = verts(src)
        if v is not None and len(v): pins[organ] = [round(float(x), 4) for x in place(v, split_rule(rule)[0], VIEW[organ], verts, {})]
    if scenes:
        hidden = [k for k, x in report.items() if not x['seen']]
        moved = {k: x['moved_px'] for k, x in report.items() if x['moved_px']}
        print(f'  landmarks: {len(report)} placed, {len(hidden)} with nothing in view (hidden: {", ".join(hidden)}); moved into view (px of 480): {moved}')
    return out, pins, missing

if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    rigs = [assemble(sex) for sex in (('male', 'female') if which == 'all' else (which,))]
    if any(r['inward_failing'] for r in rigs): sys.exit(1)
