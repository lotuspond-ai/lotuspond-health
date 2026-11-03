"""What the anatomy build takes from each source.

ANCHORS pair a structure in Z-Anatomy with the same structure in the Visible Human (HRA) bodies. The fitting step aligns
each pair and uses the alignment to warp the Z-Anatomy structures that HRA lacks into each body.

Name conventions: HRA meshes are named VH_M_<name> (male) / VH_F_<name> (female), plus Allen_<region>_L/R for the brain.
Z-Anatomy whole structures end in 'l' / 'r' (left / right) or have no suffix (midline); names ending in 'j' or 'i' are
labelled surface patches and label lines and are never used.
"""
import re

SEXES = ('male', 'female')
VH = r'VH_[MF]_'


def hra(*names):
    """Regex for HRA meshes with exactly these names (sex prefix optional)."""
    return '^(?:' + VH + ')?(?:' + '|'.join(names) + ')$'


def za(*names):
    return '^(?:' + '|'.join(re.escape(n) for n in names) + ')$'


VERTEBRAE = [('C1', 'Atlas_(C1)', 'cervical_vertebra_1'), ('C2', 'Axis_(C2)', 'cervical_vertebra_2')]
VERTEBRAE += [(f'C{i}', f'Vertebra_C{i}', f'cervical_vertebra_{i}') for i in range(3, 8)]
VERTEBRAE += [(f'T{i}', f'Vertebra_T{i}', f'thoracic_vertebra_{i}') for i in range(1, 13)]
VERTEBRAE += [(f'L{i}', f'Vertebra_L{i}', f'lumbar_vertebra_{i}') for i in range(1, 6)]

RIGHT_LOBES = {
    'lung_r_upper': ['right_apical_bronchopulmonary_segment', 'right_posterior_bronchopulmonary_segment', 'right_anterior_bronchopulmonary_segment'],
    'lung_r_middle': ['right_lateral_bronchopulmonary_segment', 'right_medial_bronchopulmonary_segment'],
    'lung_r_lower': ['right_superior_bronchopulmonary_segment', 'right_medial_basal_bronchopulmonary_segment', 'right_anterior_basal_bronchopulmonary_segment',
                     'right_lateral_basal_bronchopulmonary_segment', 'right_posterior_basal_bronchopulmonary_segment'],
}
LEFT_LOBES = {
    'lung_l_upper': ['left_apical_bronchopulmonary_segment', 'left_posterior_bronchopulmonary_segment', 'left_anterior_bronchopulmonary_segment',
                     'left_lingula_superior_bronchopulmonary_segment', 'left_lingula_inferior_bronchopulmonary_segment'],
    'lung_l_lower': ['left_superior_bronchopulmonary_segment', 'left_medial_basal_bronchopulmonary_segment', 'left_anterior_basal_bronchopulmonary_segment',
                     'left_lateral_basal_bronchopulmonary_segment', 'left_posetrior_basal_bronchopulmonary_segment', 'left_posterior_basal_bronchopulmonary_segment'],
}
LOBES = {**RIGHT_LOBES, **LEFT_LOBES}

# (key, region, za source, za name regex, hra name regex, weight). Regions: 'trunk' (torso, neck and head), 'leg_l/r'.
ANCHORS = []
for key, zname, hname in VERTEBRAE:
    ANCHORS.append((key, 'trunk', 'za-skeletal', za(zname), hra(hname), 3.0))
ANCHORS += [
    ('sacrum', 'trunk', 'za-skeletal', za('Sacrum'), hra('sacrum'), 3.0),
    ('coccyx', 'trunk', 'za-skeletal', za('Coccyx'), hra('coccyx'), 1.0),
    ('hip_l', 'trunk', 'za-skeletal', za('Hip_bonel'), hra('ilium_compact_bone_L', 'ischium_compact_bone_L', 'pubis_compact_bone_L'), 3.0),
    ('hip_r', 'trunk', 'za-skeletal', za('Hip_boner'), hra('ilium_compact_bone_R', 'ischium_compact_bone_R', 'pubis_compact_bone_R'), 3.0),
    ('hyoid', 'trunk', 'za-skeletal', za('Hyoid_bone'), hra('hyoid'), 2.0),
    ('thyroid_cartilage', 'trunk', 'za-skeletal', za('Thyroid_cartilage'), hra('thyroid_cartilage'), 3.0),
    ('cricoid', 'trunk', 'za-skeletal', za('Cricoid_cartilage'), hra('cricoid_cartilage'), 3.0),
    ('trachea', 'trunk', 'za-visceral', za('Trachea'), hra('trachea'), 2.0),
    ('liver', 'trunk', 'za-visceral', za('Liver'), hra('liver_capsule', 'capsule_of_the_liver'), 1.5),
    ('gallbladder', 'trunk', 'za-visceral', za('Gallbladder'), hra('gallbladder'), 0.5),
    ('pancreas', 'trunk', 'za-visceral', za('Pancreas'), hra('head_of_pancreas', 'neck_of_pancreas', 'body_of_pancreas', 'tail_of_pancreas', 'uncinate_process_of_the_pancreas'), 1.0),
    ('spleen', 'trunk', 'za-lymphoid', za('Spleen'), hra('diaphragmatic_surface_of_spleen', 'gastric_surface_of_spleen', 'renal_surface_of_spleen', 'colic_surface_of_spleen', 'hilum_of_spleen'), 1.0),
    ('kidney_l', 'trunk', 'za-visceral', za('Kidneyl'), hra('kidney_capsule_L'), 2.0),
    ('kidney_r', 'trunk', 'za-visceral', za('Kidneyr'), hra('kidney_capsule_R'), 2.0),
    ('bladder', 'trunk', 'za-visceral', za('Urinary_bladder'), hra('fundus_of_urinary_bladder_dome', 'fundus_of_urinary_bladder_base1?'), 0.5),
    ('duodenum', 'trunk', 'za-visceral', za('Duodenum'), hra('duodenum_superior', 'duodenum_descending', 'duodenum_horizonal', 'duodenum_ascending'), 1.0),
    ('thymus', 'trunk', 'za-lymphoid', za('Right_lobe_of_thymus', 'Left_lobe_of_thymus'), hra('thymus_lobe_L', 'thymus_lobe_R'), 0.3),
    ('heart_lv', 'trunk', 'za-cardio', za('Left_ventricle'), hra('heart_left_ventricle', 'left_ventricle'), 1.5),
    ('heart_rv', 'trunk', 'za-cardio', za('Right_ventricle'), hra('heart_right_ventricle', 'right_ventricle'), 1.5),
    ('heart_la', 'trunk', 'za-cardio', za('Left_atrium'), hra('left_cardiac_atrium'), 1.5),
    ('heart_ra', 'trunk', 'za-cardio', za('Right_atrium'), hra('right_cardiac_atrium'), 1.5),
]
LOBE_PATH = {'lung_r_upper': r'(lungs_R_upper_lobe|R_lung_upper_lobe)/', 'lung_r_middle': r'(lungs_R_middle_lobe|R_lung_middle_lobe)/',
             'lung_r_lower': r'(lungs_R_lower_lobe|R_lung_lower_lobe)/', 'lung_l_upper': r'(lungs_L_upper_lobe|L_lung_upper_lobe)/',
             'lung_l_lower': r'(lungs_L_lower_lobe|L_lung_lower_lobe)/'}
for lobe in LOBES:
    zname = {'lung_r_upper': 'Superior_lobe_of_right_lung', 'lung_r_middle': 'Middle_lobe_of_right_lung', 'lung_r_lower': 'Inferior_lobe_of_right_lung',
             'lung_l_upper': 'Superior_lobe_of_left_lung', 'lung_l_lower': 'Inferior_lobe_of_left_lung'}[lobe]
    ANCHORS.append((lobe, 'trunk', 'za-visceral', za(zname), ('path', LOBE_PATH[lobe] + r'(?!.*hilum)[^/]*segme'), 1.5))
for side, S in (('l', 'L'), ('r', 'R')):
    ANCHORS += [
        (f'femur_{side}', f'leg_{side}', 'za-skeletal', za(f'Femur{side}'), hra(f'femur_{S}'), 3.0),
        (f'patella_{side}', f'leg_{side}', 'za-skeletal', za(f'Patella{side}'), hra(f'patella_{S}'), 2.0),
        (f'tibia_{side}', f'leg_{side}', 'za-skeletal', za(f'Tibia{side}'), hra(f'tibia_{S}'), 3.0),
        (f'fibula_{side}', f'leg_{side}', 'za-skeletal', za(f'Fibula{side}'), hra(f'fibula_{S}'), 2.0),
    ]


# ------------------------------------------------------------------------------------------------ app parts
# One glTF node per part: the app's mesh id. organ = OrganId; tissue = key in src/anatomy/organs.ts TISSUE;
# flags: 'shell' (see-through in x-ray), 'hollow' (inside drawn as cut tissue in cross-sections), 'noinner' (see-through
# tissue without an inner layer). budget = target triangles after simplification. Sources are filled in by assemble.py
# from HRA (by group path / name) and from the fitted Z-Anatomy structures (.cache/fit/<sex>/<group>/manifest.json).
PARTS = [
    # id                 organ           tissue          flags                budget
    ('brain',            'brain',        'brain',        ('hollow',),         100000),
    ('ventricles',       'brain',        'csf',          (),                  6000),
    ('pituitary',        'brain',        'pituitary',    (),                  2500),
    ('spinal_cord',      'brain',        'spinal',       (),                  8000),
    ('eyes',             'brain',        'eye',          (),                  12000),
    ('eye_muscles',      'brain',        'muscle',       (),                  6000),
    ('thyroid',          'thyroid',      'thyroid',      (),                  6000),
    ('parathyroids',     'thyroid',      'parathyroid',  (),                  1200),
    ('airway',           'airway',       'cartilage',    (),                  30000),
    ('larynx_muscles',   'airway',       'muscle',       (),                  5000),
    ('lung_r_upper',     'lungs',        'lung',         ('shell',),          9000),
    ('lung_r_middle',    'lungs',        'lung',         ('shell',),          6000),
    ('lung_r_lower',     'lungs',        'lung',         ('shell',),          10000),
    ('lung_l_upper',     'lungs',        'lung',         ('shell',),          10000),
    ('lung_l_lower',     'lungs',        'lung',         ('shell',),          10000),
    ('bronchi',          'lungs',        'cartilage',    (),                  30000),
    ('diaphragm',        'lungs',        'diaphragm',    ('noinner',),        10000),
    ('heart',            'heart',        'myocardium',   ('hollow', 'shell'), 45000),
    ('valves',           'heart',        'valve',        (),                  12000),
    ('papillary',        'heart',        'myocardium',   (),                  6000),
    ('coronary',         'heart',        'artery',       (),                  12000),
    ('cardiac_veins',    'heart',        'vein',         (),                  9000),
    ('arteries',         'heart',        'artery',       (),                  59000),
    ('veins',            'heart',        'vein',         (),                  47000),
    ('esophagus',        'esophagus',    'esophagus',    (),                  7000),
    ('liver',            'liver',        'liver',        ('shell', 'hollow'), 30000),
    ('liver_ligaments',  'liver',        'ligament',     (),                  4000),
    ('gallbladder',      'liver',        'gallbladder',  (),                  3000),
    ('bile_ducts',       'liver',        'bile',         (),                  6000),
    ('hepatic_veins',    'liver',        'vein',         (),                  8000),
    ('portal_vein',      'liver',        'portal',       (),                  12000),
    ('hepatic_artery',   'liver',        'artery',       (),                  5000),
    ('stomach',          'stomach',      'stomach',      ('hollow',),         12000),
    ('spleen',           'spleen',       'spleen',       (),                  6000),
    ('pancreas',         'pancreas',     'pancreas',     (),                  10000),
    ('kidneys',          'kidneys',      'cortex',       ('hollow', 'shell'), 22000),
    ('kidney_medulla',   'kidneys',      'medulla',      (),                  14000),
    ('kidney_pelvis',    'kidneys',      'urothelium',   (),                  12000),
    ('ureters',          'kidneys',      'urothelium',   (),                  4000),
    ('bladder',          'kidneys',      'bladder',      (),                  6000),
    ('adrenals',         'kidneys',      'adrenal',      (),                  4000),
    ('small_int',        'intestine',    'smallgut',     (),                  45000),
    ('colon',            'colon',        'colon',        (),                  30000),
    ('reproductive',     'reproductive', 'reproductive', (),                  20000),
    ('breasts',          'breast',       'breast',       (),                  12000),
    ('skel_skull',       'marrow',       'bone',         (),                  60000),
    ('teeth',            'marrow',       'tooth',        (),                  8000),
    ('skel_spine',       'marrow',       'bone',         (),                  60000),
    ('discs',            'marrow',       'cartilage',    (),                  8000),
    ('skel_thorax',      'marrow',       'bone',         (),                  40000),
    ('costal_cartilage', 'marrow',       'cartilage',    (),                  10000),
    ('skel_pelvis',      'marrow',       'bone',         ('hollow',),         30000),
    ('marrow',           'marrow',       'marrow',       (),                  15000),
    ('skel_arms',        'marrow',       'bone',         (),                  30000),
    ('skel_hands',       'marrow',       'bone',         (),                  30000),
    ('skel_legs',        'marrow',       'bone',         (),                  30000),
    ('skel_feet',        'marrow',       'bone',         (),                  24000),
    ('joints',           'marrow',       'ligament',     (),                  8000),
    ('thymus',           'marrow',       'thymus',       (),                  3000),
    ('skin',             'skin',         'skin',         (),                  70000),
]
PART_IDS = [p[0] for p in PARTS]

# HRA structures that must never be used (pregnancy structures in the female body, placement markers, single
# reference specimens that are not part of the body plan).
HRA_EXCLUDE = r'(placenta|amnion|chorion|chorionic|basal_plate|umbilical|decidua|distal_most_point|_point_of_|enthesis|perichondular|Yao_|lymph_node|tonsil)'
