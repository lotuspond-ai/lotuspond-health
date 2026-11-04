"""Acceptance measurements for the arms group (per sex and side).

  inside_skin         share of each bone's surface inside the skin (target >= 99.5 % per arm)
  clearance           minimum distance from bone to skin, per bone, split into subcutaneous landmarks (olecranon,
                      epicondyles, styloid processes, acromion, clavicle, knuckles: 0.5-5 mm) and the rest (>= 1 mm)
  joint gaps          closest approach of the articular surfaces: glenohumeral 1-6 mm, elbow (humero-ulnar,
                      humero-radial) and wrist (radio-scaphoid, radio-lunate) 1-4 mm, MCP / PIP / DIP / IP 0.5-4 mm
  penetration         deepest bone-into-bone penetration among all bones of the arm (<= 1 mm)
  clavicle ends       sternal facet to the manubrium's clavicular notch (<= 8 mm), acromial facet to the acromion's
                      clavicular facet (<= 6 mm), facet centroid to facet centroid
  own finger          every phalanx inside the skin and inside its own skin finger (its samples' nearest skin points
                      belong to that finger or to the palm, never to another finger)
  lengths             humerus / height 0.17-0.21, radius / height 0.13-0.16 (bone length along its shaft axis)
All distances are exact closest-point distances to the meshes (fit/arms_geom.TriMesh, exact within 8 mm here).
criteria() flattens one side's measurements into {name: {value, threshold, ok}} entries for report.json.
"""
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import sample_surface, area
from fit.arms_geom import TriMesh, unit
from fit.arms_za import CHAINS, ALL_BONES, ARM_BONES, contact

GAP_RANGES = {'gh': (1.0, 6.0), 'elbow_hu': (1.0, 4.0), 'elbow_hr': (1.0, 4.0)}
FINGER_GAP = (0.5, 4.0)
LANDMARK = (0.5, 5.0)
CLEAR_MIN = 1.0


def landmark_zones(L):
    """Z-Anatomy sample masks of the subcutaneous landmarks, per bone: {bone: [(name, mask over L.P[bone])]}."""
    J = L.J; P = L.P
    z = {}
    # humerus: medial and lateral epicondyles (the extremes along the elbow axis near the elbow)
    ph = P['hum']; ax = J['elbow_axis']
    near = np.linalg.norm(ph - J['elbow'], axis=1) < 0.045
    u = (ph - J['elbow']) @ ax
    z['hum'] = [('medial epicondyle', near & (u < u[near].min() + 0.008)), ('lateral epicondyle', near & (u > u[near].max() - 0.008))]
    # ulna: olecranon (proximal end, behind the trochlear notch) and styloid (distal tip)
    pu = P['uln']; da = unit(J['wrist'] - J['elbow'])
    t = (pu - J['elbow']) @ da
    z['uln'] = [('olecranon', t < t.min() + 0.012), ('ulnar styloid', t > t.max() - 0.008)]
    pr = P['rad']; t = (pr - J['elbow']) @ da
    z['rad'] = [('radial styloid', t > t.max() - 0.008)]
    from fit.arms_girdle import acromion_points
    acr = acromion_points(L, P['scap'])
    tree = cKDTree(acr)
    d, _ = tree.query(P['scap'])
    z['scap'] = [('acromion', d < 1e-9)]
    z['clav'] = [('clavicle', np.ones(len(P['clav']), bool))]
    # knuckles: dorsal half of the heads of the metacarpals and phalanges (the bone's distal 30 %, dorsal side)
    o, R = L.hand_frame()
    dorsal = -R[:, 2]
    for dg, ch in CHAINS.items():
        for a, b in zip(ch[:-1], ch[1:]):
            c = J[f'{a}>{b}']
            pa = P[a]
            head = np.linalg.norm(pa - c, axis=1) < J[f'{a}>{b}_r'] + 0.004
            dors = (pa - c) @ dorsal > 0
            z.setdefault(a, []).append((f'knuckle {a}', head & dors))
    return z


def _samples(mesh, n=None, per_mm2=0.6, seed=11):
    v, f = mesh
    n = n or int(np.clip(area(v, f) * 1e6 * per_mm2, 800, 40000))
    return sample_surface(v, f, n, seed=seed)


def measure_side(L, maps, meshes, skinT, height, finger_label=None, skin_v=None, girdle=None, disp=None, log=print):
    """All criteria for one arm. maps: bone -> BoneMap (ZA -> HRA); meshes: bone -> (v, f) placed; disp: per-vertex
    push-out displacements already in `meshes` (carried over to the samples)."""
    J = L.J
    out = {}
    # sample points: Z-Anatomy samples mapped (so landmark masks carry over), plus any push-out of their bone
    Pz = {b: L.P[b] for b in ALL_BONES}
    Ph = {b: maps[b](Pz[b]) for b in ALL_BONES}
    if disp:
        from fit.arms_final import carry
        for b, D in disp.items(): Ph[b] = Ph[b] + carry(L, b, D)
    EXACT = 0.008   # exact closest-point distances up to 8 mm from the surface (all thresholds are within that)
    sd = {b: skinT.signed(Ph[b], exact_within=EXACT) for b in ALL_BONES}
    # area weights: each ZA sample set is area-uniform per bone; weight bones by area
    A = {b: area(*meshes[b]) for b in ALL_BONES}
    tot = sum(A.values())
    inside = sum(A[b] * (sd[b] < 0).mean() for b in ALL_BONES) / tot
    out['inside_skin'] = dict(value_pct=round(100 * inside, 3), threshold='>= 99.5 %', pass_=bool(inside >= 0.995),
                              per_bone_outside_pct={b: round(100 * float((sd[b] >= 0).mean()), 2) for b in ALL_BONES if (sd[b] >= 0).any()})
    # clearance
    zones = landmark_zones(L)
    clear = {}
    for b in ALL_BONES:
        c = -sd[b] * 1000
        lm = np.zeros(len(c), bool)
        e = {}
        for name, msk in zones.get(b, []):
            if msk.any():
                e[name] = round(float(c[msk].min()), 2); lm |= msk
        rest = c[~lm]
        e['rest_min_mm'] = round(float(rest.min()), 2) if len(rest) else None
        e['min_mm'] = round(float(c.min()), 2)
        ok_rest = rest.min() >= CLEAR_MIN if len(rest) else True
        ok_lm = all(LANDMARK[0] <= v <= LANDMARK[1] for k, v in e.items() if k not in ('rest_min_mm', 'min_mm'))
        e['pass'] = bool(ok_rest and ok_lm)
        clear[b] = e
    out['clearance'] = dict(threshold=f'>= {CLEAR_MIN} mm; landmarks {LANDMARK[0]}-{LANDMARK[1]} mm', per_bone=clear,
                            pass_=bool(all(e['pass'] for e in clear.values())))
    # meshes as TriMesh for gaps and penetration
    T = {b: TriMesh(*meshes[b], k=12) for b in ALL_BONES}

    def gap(a, b):
        da = T[b].signed(Ph[a], exact_within=EXACT); db = T[a].signed(Ph[b], exact_within=EXACT)
        return float(min(da.min(), db.min()) * 1000)

    gaps = {}
    gaps['gh'] = gap('hum', 'scap')
    gaps['elbow_hu'] = gap('hum', 'uln'); gaps['elbow_hr'] = gap('hum', 'rad')
    gaps['wrist_rs'] = gap('rad', 'sca'); gaps['wrist_rl'] = gap('rad', 'lun')
    g = {k: dict(value_mm=round(v, 2), threshold=f'{GAP_RANGES[k][0]}-{GAP_RANGES[k][1]} mm', pass_=bool(GAP_RANGES[k][0] <= v <= GAP_RANGES[k][1]))
         for k, v in gaps.items() if not k.startswith('wrist')}
    # the radiocarpal joint: closest approach of the radius to the proximal carpal row (scaphoid and lunate fossae)
    wj = min(gaps['wrist_rs'], gaps['wrist_rl'])
    g['wrist'] = dict(value_mm=round(wj, 2), threshold='1.0-4.0 mm', pass_=bool(1.0 <= wj <= 4.0),
                      radius_scaphoid_mm=round(gaps['wrist_rs'], 2), radius_lunate_mm=round(gaps['wrist_rl'], 2))
    names = {('mc', 'pp'): 'MCP', ('pp', 'mp'): 'PIP', ('mp', 'dp'): 'DIP', ('pp', 'dp'): 'IP'}
    for dg, ch in CHAINS.items():
        for a, b in zip(ch[:-1], ch[1:]):
            v = gap(a, b)
            nm = f'{names[(a[:2], b[:2])]}{dg}'
            g[nm] = dict(value_mm=round(v, 2), threshold=f'{FINGER_GAP[0]}-{FINGER_GAP[1]} mm', pass_=bool(FINGER_GAP[0] <= v <= FINGER_GAP[1]))
    out['joint_gaps'] = g
    # penetration between all bones (pairs with overlapping boxes)
    lo = {b: meshes[b][0].min(0) - 0.002 for b in ALL_BONES}; hi = {b: meshes[b][0].max(0) + 0.002 for b in ALL_BONES}
    worst = (0.0, None)
    pen = {}
    for i, a in enumerate(ALL_BONES):
        for b in ALL_BONES[i + 1:]:
            if np.any(lo[a] > hi[b]) or np.any(lo[b] > hi[a]): continue
            da = T[b].signed(Ph[a], exact_within=EXACT); db = T[a].signed(Ph[b], exact_within=EXACT)
            depth = float(max(-da.min(), -db.min(), 0) * 1000)
            if depth > 0.05: pen[f'{a}-{b}'] = round(depth, 2)
            if depth > worst[0]: worst = (depth, f'{a}-{b}')
    out['penetration'] = dict(max_mm=round(worst[0], 2), pair=worst[1], threshold='<= 1 mm', pass_=bool(worst[0] <= 1.0), pairs=pen)
    # clavicle ends
    if girdle is not None:
        se = maps['clav'](girdle['se']).mean(0); notch = girdle['notch_pts'].mean(0)
        ae = maps['clav'](girdle['ae']).mean(0); af = maps['scap'](girdle['af']).mean(0)
        d1 = float(np.linalg.norm(se - notch) * 1000); d2 = float(np.linalg.norm(ae - af) * 1000)
        d1w = float(np.linalg.norm(se - girdle['notch_pts_warp'].mean(0)) * 1000)
        out['clavicle_sternal_end'] = dict(value_mm=round(d1, 2), threshold='<= 8 mm', pass_=bool(d1 <= 8), to_trunk_warped_notch_mm=round(d1w, 2))
        out['clavicle_acromial_end'] = dict(value_mm=round(d2, 2), threshold='<= 6 mm', pass_=bool(d2 <= 6))
    # phalanges in their own fingers
    if finger_label is not None:
        tree = cKDTree(skin_v)
        own = {}
        okall = True
        for dg, ch in CHAINS.items():
            for b in ch[1:]:
                _, j = tree.query(Ph[b])
                lab = finger_label[j]
                ins = sd[b] < 0
                good = ins & ((lab == dg) | (lab == -1))
                other = np.unique(lab[(lab != dg) & (lab != -1)])
                frac = float(good.mean())
                own[b] = dict(in_own_finger_pct=round(100 * frac, 2), other_fingers=[int(x) for x in other], beyond_web_pct=round(100 * float((lab == dg).mean()), 1))
                okall &= frac >= 0.995 and len(other) == 0
        out['phalanges_in_own_finger'] = dict(threshold='100 % of each phalanx inside the skin and in its own finger (or the palm)', per_bone=own, pass_=bool(okall))
    # lengths
    def blen(b, p0, p1):
        a = unit(maps[b](p1[None])[0] - maps[b](p0[None])[0])
        x = meshes[b][0] @ a
        return float(x.max() - x.min())
    hl = blen('hum', J['gh'], J['elbow']); rl = blen('rad', J['capitulum'], J['wrist'])
    out['humerus_over_height'] = dict(value=round(hl / height, 4), length_m=round(hl, 4), threshold='0.17-0.21', pass_=bool(0.17 <= hl / height <= 0.21))
    out['radius_over_height'] = dict(value=round(rl / height, 4), length_m=round(rl, 4), threshold='0.13-0.16', pass_=bool(0.13 <= rl / height <= 0.16))
    return out


LANDMARK_LIST = ('acromion', 'clavicle', 'olecranon', 'medial epicondyle', 'lateral epicondyle', 'radial styloid', 'ulnar styloid')


def criteria(meas):
    """The acceptance criteria of one side as flat {name: {value, threshold, ok, ...}} entries (lengths in mm unless the
    name says otherwise)."""
    c = {}
    ins = meas['inside_skin']
    c['inside_skin_pct'] = dict(value=ins['value_pct'], threshold='>= 99.5 %', ok=bool(ins['pass_']), outside_pct_per_bone=ins['per_bone_outside_pct'])
    cl = meas['clearance']['per_bone']
    rest = {b: e['rest_min_mm'] for b, e in cl.items() if e['rest_min_mm'] is not None}
    worst = min(rest, key=rest.get)
    c['clearance_min_mm'] = dict(value=rest[worst], bone=worst, threshold=f'>= {CLEAR_MIN} mm (bone surface other than the subcutaneous landmarks)',
                                 ok=bool(rest[worst] >= CLEAR_MIN), per_bone_min_mm={b: e['min_mm'] for b, e in cl.items()},
                                 per_bone_min_non_landmark_mm=rest)
    lms = {}
    for b, e in cl.items():
        for k, v in e.items():
            if k not in ('rest_min_mm', 'min_mm', 'pass'): lms[k] = v
    th = f'{LANDMARK[0]}-{LANDMARK[1]} mm'
    for name in LANDMARK_LIST:
        if name in lms:
            v = lms[name]
            c[f'landmark_{name.replace(" ", "_")}_mm'] = dict(value=v, threshold=th, ok=bool(LANDMARK[0] <= v <= LANDMARK[1]))
    kn = {k.replace('knuckle ', ''): v for k, v in lms.items() if k.startswith('knuckle')}
    if kn:
        bad = {k: v for k, v in kn.items() if not LANDMARK[0] <= v <= LANDMARK[1]}
        c['landmark_knuckles_mm'] = dict(value=min(kn.values()), max=max(kn.values()), threshold=th + ' (every knuckle)', ok=not bad,
                                         per_knuckle=kn, out_of_range=bad)
    g = meas['joint_gaps']
    names = {'gh': 'gap_glenohumeral_mm', 'elbow_hu': 'gap_elbow_humeroulnar_mm', 'elbow_hr': 'gap_elbow_humeroradial_mm', 'wrist': 'gap_wrist_radiocarpal_mm'}
    for k, e in g.items():
        nm = names.get(k, f'gap_{k}_mm')
        d = dict(value=e['value_mm'], threshold=e['threshold'], ok=bool(e['pass_']))
        if k == 'wrist': d.update(radius_scaphoid=e['radius_scaphoid_mm'], radius_lunate=e['radius_lunate_mm'])
        c[nm] = d
    p = meas['penetration']
    c['bone_penetration_max_mm'] = dict(value=p['max_mm'], pair=p['pair'], threshold=p['threshold'], ok=bool(p['pass_']), pairs_over_0p05_mm=p['pairs'])
    for k, nm in (('clavicle_sternal_end', 'clavicle_sternal_end_to_notch_mm'), ('clavicle_acromial_end', 'clavicle_acromial_end_to_acromion_mm')):
        if k in meas:
            e = meas[k]; c[nm] = dict(value=e['value_mm'], threshold=e['threshold'], ok=bool(e['pass_']))
    if 'phalanges_in_own_finger' in meas:
        e = meas['phalanges_in_own_finger']
        worst = min(e['per_bone'], key=lambda b: e['per_bone'][b]['in_own_finger_pct'])
        strays = {b: d['other_fingers'] for b, d in e['per_bone'].items() if d['other_fingers']}
        c['phalanges_in_own_finger_pct'] = dict(value=e['per_bone'][worst]['in_own_finger_pct'], worst=worst, threshold='>= 99.5 % of every phalanx inside its own skin finger (or the palm), none in another finger',
                                                ok=bool(e['pass_']), in_other_fingers=strays)
    for k in ('humerus_over_height', 'radius_over_height'):
        e = meas[k]; c[k] = dict(value=e['value'], length_m=e['length_m'], threshold=e['threshold'], ok=bool(e['pass_']))
    return c
