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
from lib.mesh import source, merge, orient_outward, remesh_solid, save, load, components, CACHE, compact  # noqa: E402
from catalog import PARTS, HRA_EXCLUDE, LOBE_PATH  # noqa: E402

OUT = os.path.join(CACHE, 'parts')
FIT = os.path.join(CACHE, 'fit')

# HRA structures per part, as regexes on the node path. mode: 'merge' (use the meshes as they are, outward-oriented) or
# 'solid' (rebuild one closed surface per `split` group from overlapping surface patches).
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
    **{lobe: dict(sel=[LOBE_PATH[lobe]], mode='solid', project=False, smooth=10) for lobe in LOBE_PATH},
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
    'liver': dict(sel=[r'_liver/'], exclude=r'(ligament|artery|vein|duct|_portal)', mode='solid', opening=1),
    'liver_ligaments': dict(sel=[r'_liver/.*ligament'], double=True),
    'gallbladder': dict(sel=[r'_gallbladder_/']),
    'bile_ducts': dict(sel=[r'_biliary_tree/']),
    'hepatic_veins': dict(sel=[r'blood_vasculature/.*(right|middle|left)_hepatic_vein']),
    'portal_vein': dict(sel=[r'blood_vasculature/.*' + PORTAL]),
    'spleen': dict(sel=[r'_spleen/'], exclude=r'(artery|vein)', mode='solid', opening=1),
    'pancreas': dict(sel=[r'_pancreas/'], mode='solid', opening=1),
    'kidneys': dict(sel=[r'kidney_capsule_[LR]$', r'hilum_of_kidney_[LR]$'], mode='solid', split=r'_([LR])$'),
    'kidney_medulla': dict(sel=[r'renal_(pyramid|papilla)_[LR]']),
    'kidney_pelvis': dict(sel=[r'(minor|major)_calyx', r'renal_pelvis_[LR]$']),
    'ureters': dict(sel=[r'/VH_[MF]_(ureter_[LR]|left_ureter|right_ureter)$']),
    'bladder': dict(sel=[r'_urinary_bladder/', r'_urethra/']),
    'small_int': dict(sel=[r'_small_intestine/']),
    'colon': dict(sel=[r'_colon/']),
    'reproductive': dict(sel=[r'_male_genital_duct/', r'_prostate_gland/', r'/VH_F_vagina', r'_fallopian_tube/', r'_ovary/', r'/VH_F_(left|right)_ovary$',
                              r'_ligaments_of_uterus_and_ovaries/'], double=True),
    'uterus': dict(sel=[r'_uterus/'], exclude=r'(artery|vein)', mode='solid', into='reproductive'),
    'breasts': dict(sel=[r'mammary_gland_[LR]/.*(mammary_lobes|lactiferous)']),
    'skel_skull': dict(sel=[r'/VH_M_hyoid$']),
    'skel_spine': dict(sel=[r'_vertebrae/']),
    'skel_pelvis': dict(sel=[r'_pelvis/.*(compact_bone|sacrum|coccyx)']),
    'marrow': dict(sel=[r'_pelvis/.*spongy_bone']),
    'skel_legs': dict(sel=[r'_lower_limb/.*VH_[MF]_(femur|tibia|fibula|patella)_[LR]$']),
    'joints': dict(sel=[r'_lower_limb/.*(ligament|meniscus|articular_cartilage)']),
    'thymus': dict(sel=[r'_thymus/']),
}
SPEC = {p[0]: dict(organ=p[1], tissue=p[2], flags=list(p[3]), budget=p[4]) for p in PARTS}


def frame_offset(sex):
    s = source(f'hra-{sex}')
    v, _ = s.load(s.select(r'_skin$'))
    lo, hi = v.min(0), v.max(0)
    return np.array([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2]), float(hi[1] - lo[1])


def hra_entries(sex, spec):
    s = source(f'hra-{sex}')
    out = []
    for o in s.index:
        if re.search(HRA_EXCLUDE, o['path']): continue
        if not any(re.search(rx, o['path']) for rx in spec['sel']): continue
        if spec.get('exclude') and re.search(spec['exclude'], o['path']): continue
        out.append(o)
    return out


def build_part(sex, pid, spec):
    """Returns a list of (structure name, (v, f)) for this part, or [] if the body has none."""
    s = source(f'hra-{sex}')
    es = hra_entries(sex, spec)
    if not es: return []
    if spec.get('mode') == 'solid':
        groups = {}
        for o in es:
            k = re.search(spec['split'], o['name']).group(1) if spec.get('split') and re.search(spec['split'], o['name']) else '_'
            groups.setdefault(k, []).append(o)
        out = []
        for k, g in groups.items():
            m = remesh_solid([s.load_entry(o) for o in g], project=spec.get('project', True), smooth=spec.get('smooth', 4), opening=spec.get('opening', 0))
            out.append((pid if k == '_' else f'{pid}_{k}', m))
        return out
    out = []
    for o in es:
        v, f = compact(*s.load_entry(o))
        out.append((o['name'], (v, orient_outward(v, f))))
    return out


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


def assemble(sex):
    t0 = time.time()
    off, height = frame_offset(sex)
    fit = fitted(sex)
    od = os.path.join(OUT, sex); os.makedirs(od, exist_ok=True)
    parts = {}
    acc = {}
    for pid, spec in HRA_PARTS.items():
        target = spec.get('into', pid)
        for name, mesh in build_part(sex, pid, spec):
            acc.setdefault(target, []).append(('HRA', name, mesh, spec.get('double', False)))
    for pid, items in fit.items():
        for name, mesh, srcs in items:
            v, f = mesh
            acc.setdefault(pid, []).append(('Z-Anatomy', name, (v, orient_outward(v, f)), False))
    # a structure in two parts is drawn twice (z-fighting, wrong colour, double triangles)
    owner = {}
    for pid, items in acc.items():
        for _, n, _, _ in items: owner.setdefault(n, []).append(pid)
    twice = {n: p for n, p in owner.items() if len(p) > 1}
    if twice: raise SystemExit(f'{sex}: structures in more than one part: {twice}')
    structures = {}
    struct_v = {}; parts_v = {}
    for pid, items in acc.items():
        for src, n, m, _ in items:
            struct_v[re.sub(r'^VH_[MF]_', '', n.split('/')[-1])] = m[0] + off
    s = source(f'hra-{sex}')
    for pid, spec in HRA_PARTS.items():  # sub-structures of rebuilt parts (lobes' segments, pancreas head, uterus cervix...)
        if spec.get('mode') != 'solid': continue
        for o in hra_entries(sex, spec):
            struct_v.setdefault(re.sub(r'^VH_[MF]_', '', o['name']), s.load_entry(o)[0] + off)
    for pid, items in acc.items():
        if pid not in SPEC: print(f'  ! {pid}: not in catalog.PARTS, skipped'); continue
        v, f = merge([m for _, _, m, _ in items])
        v = v + off
        seg = np.cumsum([0] + [len(m[1]) for _, _, m, _ in items]).astype(np.uint32)
        save(os.path.join(od, pid + '.npz'), v, f)
        v.astype(np.float32).tofile(os.path.join(od, pid + '.pos')); f.astype(np.uint32).tofile(os.path.join(od, pid + '.idx')); seg.tofile(os.path.join(od, pid + '.seg'))
        lo, hi = v.min(0), v.max(0)
        parts[pid] = dict(SPEC[pid], double=any(d for *_, d in items), bounds=[lo.round(4).tolist(), hi.round(4).tolist()], tris=int(len(f)),
                          sources=sorted({src for src, *_ in items}))
        structures[pid] = [dict(name=n, source=src, tris=int(len(m[1]))) for src, n, m, _ in items]
        parts_v[pid] = v
        print(f'  {pid:<18} {len(f):8d} tris  {len(items):4d} structures  from {", ".join(parts[pid]["sources"])}', flush=True)
    json.dump(structures, open(os.path.join(od, 'structures.json'), 'w'), indent=0)
    missing = [p for p in SPEC if p not in parts]
    marks, pins, lm_missing = landmarks(struct_v, parts_v, sex)
    skin_v = parts_v['skin']
    rig = dict(sex=sex, height=round(height, 4), offset=off.round(5).tolist(), bounds=[skin_v.min(0).round(4).tolist(), skin_v.max(0).round(4).tolist()],
               parts=parts, missing=missing, landmarks=marks, pins=pins, landmarks_missing=lm_missing)
    json.dump(rig, open(os.path.join(od, 'rig.json'), 'w'), indent=1)
    print(f'{sex}: {len(parts)} parts, missing {missing} ({time.time() - t0:.0f} s)')
    return rig



# ------------------------------------------------------------------------------------------------ landmarks and pins
# Camera direction each organ is viewed from (same vectors as src/anatomy/organs.ts `view`), used to put each label on
# the surface that faces the viewer.
VIEW = dict(brain=(0.55, 0.25, 0.8), thyroid=(0.25, 0.1, 1), airway=(0.3, 0.1, 1), lungs=(0.2, 0.15, 1), heart=(0.35, 0.12, 1), esophagus=(0.8, 0.1, 0.6),
            liver=(-0.45, 0.1, 1), stomach=(0.5, 0.1, 1), spleen=(1, 0.15, -0.3), pancreas=(0.1, 0.4, 1), kidneys=(-0.15, 0.1, -1), intestine=(0.1, 0.2, 1),
            colon=(0, 0.15, 1), marrow=(0.3, 0.1, 1), reproductive=(0.2, 0.1, 1), skin=(0, 0, 1))
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
    'spleen': [('Hilum', r'^hilum_of_spleen$', 'face'), ('Splenic artery', r'^splenic_artery$', 'face'), ('Splenic vein', r'^splenic_vein$', 'face')],
    'pancreas': [('Head', r'^head_of_pancreas$', 'face'), ('Neck', r'^neck_of_pancreas$', 'face'), ('Body', r'^body_of_pancreas$', 'face'), ('Tail', r'^tail_of_pancreas$', 'left'),
                 ('Uncinate process', r'^(uncinate_process_of_the_pancreas|ucinate_process1)$', 'bottom'), ('Pancreatic duct', r'^ventral_pancreatic_duct$', 'face')],
    'kidneys': [('Renal cortex', 'part:kidneys', 'face'), ('Medullary pyramids', r'^renal_pyramid_L_a$', 'face'), ('Renal pelvis', r'^renal_pelvis_L$', 'face'),
                ('Ureter', r'^(ureter_L|left_ureter)$', 'face'), ('Adrenal gland', 'part:adrenals', 'top'), ('Renal artery', r'^left_renal_artery$', 'face'), ('Renal vein', r'^(renal_vein_L|left_renal_vein)$', 'face'),
                ('Bladder', 'part:bladder', 'face')],
    'intestine': [('Duodenum', r'^duodenum_descending$', 'face'), ('Duodenal papilla', r'^(duodenal_ampulla|hepatopancreatic_ampulla)$', 'face'), ('Jejunum', r'^je[jn][eu]num$', 'face'),
                  ('Ileum', r'^ileum$', 'face'), ('Terminal ileum', r'^ileum_terminal$', 'face')],
    'colon': [('Caecum', r'^caecum$', 'face'), ('Appendix', r'^vermiform_appendix$', 'face'), ('Ascending colon', r'^ascending_colon$', 'face'), ('Hepatic flexure', r'^hepatic_flexure_of_colon$', 'face'),
              ('Transverse colon', r'^transverse_colon$', 'face'), ('Splenic flexure', r'^splenic_flexure_of_colon$', 'face'), ('Descending colon', r'^descending_colon$', 'face'),
              ('Sigmoid colon', r'^sigmoid_colon$', 'face'), ('Rectum', r'^rectum$', 'face')],
    'marrow': [('Skull', 'part:skel_skull', 'face'), ('Sternum', 'part:skel_thorax', 'front'), ('Vertebral column', r'^thoracic_vertebra_8$', 'back'), ('Ribs', 'part:skel_thorax', 'dir:1,0,0.3'),
               ('Iliac crest', r'^ilium_compact_bone_L$', 'top'), ('Red marrow', r'^ilium_spongy_bone_L$', 'face'), ('Femur', r'^femur_L$', 'face'), ('Thymus', 'part:thymus', 'front')],
    'reproductive': [('Prostate', r'^(peripheral_zone_of_prostate_[LR]|base_of_prostate)$', 'front'), ('Seminal vesicles', r'^seminal_vesicle$', 'back'), ('Vas deferens', r'^vas_deferens_L$', 'face'),
                     ('Testes', r'^testis_[lr]$', 'front'), ('Uterus', r'^fundus_of_uterus$|^uterus$|^body_of_uterus$', 'top'), ('Cervix', r'^cervix$', 'face'),
                     ('Ovaries', r'^left_ovary$', 'face'), ('Fallopian tubes', r'^ampulla_of_uterine_tube_L$', 'face'), ('Vagina', r'^vagina$', 'face'), ('Breast tissue', 'part:breasts', 'front')],
}
PIN = dict(brain=('part:brain', 'dir:0.2,0.6,0.8'), thyroid=('part:thyroid', 'front'), airway=('part:airway', 'face'), lungs=('part:lung_r_upper', 'face'), heart=(r'^(heart_)?left_ventricle$', 'face'),
           esophagus=('part:esophagus', 'face'), liver=('part:liver', 'dir:-0.6,0.1,0.8'), stomach=('part:stomach', 'face'), spleen=('part:spleen', 'face'), pancreas=('part:pancreas', 'face'),
           kidneys=(r'^kidneys_R$', 'face'), intestine=(r'^je[jn][eu]num$', 'face'), colon=(r'^ascending_colon$', 'face'), marrow=(r'^ilium_compact_bone_L$', 'top'),
           reproductive=('part:reproductive', 'face'), skin=('part:skin', 'front'))
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
    for sex in (('male', 'female') if which == 'all' else (which,)):
        assemble(sex)
