"""Vessels group: Z-Anatomy (za-cardio, CC BY-SA 4.0) arteries and veins that continue the HRA vascular tree into the
neck, head, upper limbs, thorax wall, pelvis and lower limbs of each HRA body, without duplicating any HRA vessel.

    python3 fit/vessels.py [male|female|all] [--render-only]
    parts: arteries -> 'arteries', veins -> 'veins'

What HRA has (compared by name and position, .cache/parts/<sex>/structures.json): the aorta from the valve to its
bifurcation, the brachiocephalic trunk to its bifurcation, the left common carotid (male: to its bifurcation at the
upper border of the thyroid cartilage; female: a 5 cm stub), short stubs of the left subclavian artery, the visceral
branches, the superior vena cava, the inferior vena cava and the common / internal iliac veins (male: also both
brachiocephalic veins and the external iliac veins), the eye's ophthalmic and retinal vessels. No iliac arteries, no
limb, neck or head vessels apart from those. Z-Anatomy vessels that duplicate an HRA one are never output; they are
mapped only to locate the junctions (fit/vessels_map.REFERENCE).

Method (per body):
 1. Deformation (fit/vessels_map.py): trunk warp corrected toward the bones placed by the rib cage and arms groups,
    the skull group's head map above C3, the arms group's arm_deform for the subclavian vessels and the free limb,
    the foot group's leg_deform below the hip, blended with the weights those groups export.
 2. Junctions (JUNCTIONS): each HRA stub's open end (boundary ring, or the ring one radius back from a capped end)
    is matched to the Z-Anatomy vessel that continues it. 'chain': the Z-Anatomy vessel runs along the stub; it is cut
    by the plane through its centerline where it leaves the stub's end and the part beyond is kept. 'fork': the stub
    ends at a bifurcation; the Z-Anatomy parent is dropped and its distal end frame is matched. 'side': a Z-Anatomy
    vessel ends on the wall of an HRA vessel (azygos arch on the superior vena cava...). The rigid motion that puts the
    Z-Anatomy end frame (centre, direction) onto the HRA one is applied with a weight decaying smoothly (raised cosine)
    over L_SNAP = 6.5 cm of geodesic distance along the vessel tree (mesh edges plus contacts between touching
    vessels), several junctions blended by inverse geodesic distance, so each end ring lands exactly on its stub.
 3. Collision push-out (fit/vessels_fix.py): vessels out of every bone (HRA and placed) by CLEAR, inside the skin by
    SKIN_DEPTH, with a smooth shape-preserving displacement (Gaussian spread of the needed pushes over the vessel, so
    a tube moves as a whole), faded in over PIN from the junction rings so the junctions stay snapped.
 4. Measurements (fit/vessels_measure.py) -> report.json, QA renders, write_group().
"""
import os, sys, json, time, re
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, orient_outward  # noqa: E402
from fit.common import FIT, write_group  # noqa: E402
from fit.vessels_map import Mapper, specs, work_dir, log, GROUP, A, V  # noqa: E402
from fit import vessels_geom as G  # noqa: E402
from catalog import HRA_EXCLUDE  # noqa: E402

L_SNAP = 0.065      # junction displacement decays to zero over this geodesic distance (m)
CONTACT = 0.003     # vertices of different vessels closer than this are linked in the tree graph (m)
EPS_SHEPARD = 0.0002

# ------------------------------------------------------------------------------------------------ junctions
# hra: HRA mesh name pattern (without the VH_M_/VH_F_ prefix); side: pick the HRA mesh on that side by position;
# hint: expected outward direction of the HRA end (+x = the person's left, +y up, +z front).
JUNCTIONS = [
    dict(key='brachiocephalic_trunk', part=A, hra='brachiocephalic_artery_b', kind='fork', parent='Brachiocephalic_trunk',
         children=['Right_common_carotid_artery', 'Right_subclavian_artery'], hint=(-0.5, 1, 0)),
    dict(key='left_common_carotid', part=A, hra='left_common_carotid_artery_b', kind='chain', chain='Left_common_carotid_artery',
         children=['Internal_carotid_arteryl', 'External_carotid_arteryl'], hint=(0, 1, 0)),
    dict(key='left_subclavian', part=A, hra='left_subclavian_artery_b', kind='chain', chain='Left_subclavian_artery',
         children=['Vertebral_arteryl', 'Internal_thoracic_arteryl', 'Axillary_arteryl'], hint=(0.5, 1, 0)),
    dict(key='aortic_bifurcation', part=A, hra='descending_aorta_b', kind='fork', parent='Abdominal_aorta',
         children=['Common_iliac_arteryl', 'Common_iliac_arteryr'], hint=(0, -1, 0)),
    # male: HRA brachiocephalic and external iliac veins
    dict(key='right_venous_angle', part=V, sexes=('male',), hra='brachiocephalic_vein_[LR]', side='r', kind='fork', parent='Right_brachiocephalic_vein',
         children=['Internal_jugular_veinr', 'Right_subclavian_vein'], hint=(0, 1, 0)),
    dict(key='left_venous_angle', part=V, sexes=('male',), hra='brachiocephalic_vein_[LR]', side='l', kind='fork', parent='Left_brachiocephalic_vein',
         children=['Internal_jugular_veinl', 'Left_subclavian_vein'], hint=(0.6, 1, 0)),
    dict(key='femoral_vein_l', part=V, sexes=('male',), hra='external_iliac_vein_[LR]', side='l', kind='fork', parent='External_iliac_veinl',
         children=['Femoral_veinl'], hint=(0, -1, 0.3)),
    dict(key='femoral_vein_r', part=V, sexes=('male',), hra='external_iliac_vein_[LR]', side='r', kind='fork', parent='External_iliac_veinr',
         children=['Femoral_veinr'], hint=(0, -1, 0.3)),
    dict(key='internal_thoracic_vein_l', part=V, sexes=('male',), hra='brachiocephalic_vein_[LR]', side='l', kind='side', vessel='Internal_thoracic_veinsl'),
    dict(key='internal_thoracic_vein_r', part=V, sexes=('male',), hra='brachiocephalic_vein_[LR]', side='r', kind='side', vessel='Internal_thoracic_veinsr'),
    # female: no HRA brachiocephalic or external iliac veins
    dict(key='svc_right_brachiocephalic', part=V, sexes=('female',), hra='superior_vena_cava', kind='chain', chain='Right_brachiocephalic_vein',
         children=[], hint=(0, 1, 0)),
    dict(key='svc_left_brachiocephalic', part=V, sexes=('female',), hra='superior_vena_cava', kind='chain', chain='Left_brachiocephalic_vein',
         children=[], hint=(1, 0.3, 0)),
    dict(key='external_iliac_vein_l', part=V, sexes=('female',), hra='(?:left_|right_)?common_iliac_vein(?:_[LR])?', side='l', kind='chain',
         chain='External_iliac_veinl', children=[], hint=(0.3, -1, 0.3)),
    dict(key='external_iliac_vein_r', part=V, sexes=('female',), hra='(?:left_|right_)?common_iliac_vein(?:_[LR])?', side='r', kind='chain',
         chain='External_iliac_veinr', children=[], hint=(-0.3, -1, 0.3)),
    dict(key='azygos_arch', part=V, hra='superior_vena_cava', kind='side', vessel='Azygos_vein'),
]


def snake(za, side):
    n = za
    if side in 'lr' and n.endswith(side) and not n.startswith(('Left_', 'Right_')): n = n[:-1] + '_' + side
    n = n.replace('(M1-segment)', 'M1').replace('Insular_branches_of_middle_cerebral_artery_(M2-segment)', 'middle_cerebral_artery_M2')
    n = n.replace('Insular_branches_of_middle_cerebral_artery_(M2)', 'middle_cerebral_artery_M2')
    return re.sub(r'_+', '_', re.sub(r'[^0-9A-Za-z]+', '_', n)).strip('_').lower()


def hra_stub(sex, pat, side=None):
    S = source(f'hra-{sex}')
    es = [o for o in S.select(r'^VH_[MF]_(?:' + pat + r')$') if not re.search(HRA_EXCLUDE, o['path'])]
    if not es: return None, None
    ms = [(o['name'], S.load_entry(o)) for o in es]
    if side and len(ms) > 1:
        ms.sort(key=lambda m: m[1][0][:, 0].mean())               # +x is the person's left: match by position
        ms = [ms[-1]] if side == 'l' else [ms[0]]
    return ms[0]


def loops_of(v, f):
    out = []
    for l in G.boundary_loops(f):
        if len(l) < 3: continue
        c, n, r = G.ring_frame(v[l]); out.append(dict(idx=l, c=c, r=r))
    return out


def inward(v, f, loop_idx, depth=0.006):
    """Unit direction from an end ring into the tube (along its centerline), and the centerline."""
    cl = G.centerline(v, f, loop_idx)
    P, s = cl['p'], cl['s']
    k = min(int(np.searchsorted(s, depth)), len(P) - 1)
    t = G.unit(P[k] - P[0]) if k > 0 else cl['t'][0]
    return t, cl


def nearest_loop(ves, pts):
    """The boundary loop of a vessel whose centre is nearest to a point set."""
    tree = cKDTree(pts)
    L = loops_of(ves['v'], ves['f'])
    d = [tree.query(l['c'])[0] for l in L]
    return L[int(np.argmin(d))], float(min(d))


def hra_ends(hv, hf, hint, near):
    """Candidate open ends of an HRA vessel for a junction: its boundary rings of radius >= 2 mm (the larger of the
    inner and outer wall rings of a double-walled vessel) and the end facing `hint` near `near` (G.tip_frame), unless
    that tip lies on one of the rings."""
    ends = G.merge_loops([e for e in G.stub_ends(hv, hf, min_r=0.002) if e['kind'] == 'open'])
    tip = G.section_frame(hv, hf, hint, near=near)
    if not any(np.linalg.norm(tip['tip'] - e['c']) < e['r'] + 0.003 for e in ends): ends.append(tip)
    return ends, tip


def choose_end(ends, near_pts, hint, maxd=0.025):
    """HRA end for a junction: among ends within maxd of the Z-Anatomy vessel, the one facing the hint direction best."""
    tree = cKDTree(np.atleast_2d(near_pts))
    cand = []
    for e in ends:
        d = tree.query(e['c'])[0]
        score = (e['n'] @ G.unit(hint) if hint is not None else 0.0) - d / maxd
        cand.append((d, score, e))
    ok = [c for c in cand if c[0] <= maxd] or sorted(cand, key=lambda c: c[0])[:1]
    return max(ok, key=lambda c: c[1])[2], [dict(c_mm=np.round(e['c'] * 1000, 1).tolist(), r_mm=round(e['r'] * 1000, 2), kind=e['kind'],
                                                  dist_to_za_mm=round(d * 1000, 1)) for d, _, e in cand]


def end_info(e):
    return dict(c_mm=np.round(e['c'] * 1000, 1).tolist(), dir=np.round(e['n'], 3).tolist(), r_mm=round(e['r'] * 1000, 2), kind=e['kind'])


def setup_junctions(sex, VES, log=log):
    """Resolve every junction of this body: HRA end frames, Z-Anatomy end frames, cuts and drops. Returns a list of
    dicts (key, kind, part, pivot p, target c, rotation theta, seeds={vessel: vertex idx}, info)."""
    out = []
    for J in JUNCTIONS:
        if 'sexes' in J and sex not in J['sexes']: continue
        hname, hm = hra_stub(sex, J['hra'], J.get('side'))
        if hm is None: log('  junction', J['key'], ': no HRA stub'); continue
        hv, hf = hm
        info = dict(hra=hname, kind=J['kind'])
        hint = np.array(J['hint'], float) if 'hint' in J else None
        if J['kind'] == 'side':
            ves = VES[J['vessel']]
            loop, _ = nearest_loop(ves, hv)
            T = G.TriSet(hv, hf)
            sd, q = T.signed(loop['c'][None], band=0.05)
            m = G.unit(loop['c'] - q[0]) * (1 if sd[0] >= 0 else -1)
            c = loop['c'] - m * (sd[0] + 0.5 * loop['r'])
            t_in, _ = inward(ves['v'], ves['f'], loop['idx'])
            out.append(dict(key=J['key'], kind='side', part=J['part'], p=loop['c'], c=c, theta=np.zeros(3), seeds={J['vessel']: loop['idx']},
                            hra_mesh=hm, end=None, za_dir=t_in, za_r=loop['r'],
                            info=dict(info, signed_dist_before_mm=round(float(sd[0]) * 1000, 2), za_r_mm=round(loop['r'] * 1000, 2),
                                      shift_mm=round(float(np.linalg.norm(c - loop['c'])) * 1000, 2))))
            continue
        if J['kind'] == 'chain':
            ves = VES[J['chain']]
            loop, _ = nearest_loop(ves, hv)
            t_in, cl = inward(ves['v'], ves['f'], loop['idx'])
            ends, tip = hra_ends(hv, hf, hint, near=None)
            e, cands = choose_end(ends, cl['p'], hint)
            P, s, T_ = cl['p'], cl['s'], cl['t']
            ahead = (P - e['c']) @ e['n'] >= 0
            i = int(np.argmax(ahead)) if ahead.any() else None
            info.update(hra_end=end_info(e), candidates=cands)
            if i is None or s[-1] - s[i] < 0.006:
                # the HRA stub covers the whole Z-Anatomy vessel: the junction is at its distal end (a fork)
                info['za_chain'] = 'covered by HRA: dropped'
                ves['dropped'] = True
                J2 = dict(J, kind='fork', parent=J['chain'])
                out.extend(fork(J2, VES, hm, info, hint))
                continue
            if s[i] < 0.001:
                t0 = t_in; p0 = loop['c']; seeds = loop['idx']; info['za_chain'] = 'starts beyond the HRA end: not cut'
            else:
                t0 = G.unit(T_[i]); keep = P[-1]
                v2, f2, ring = G.plane_cut(ves['v'], ves['f'], P[i], t0, keep_near=keep)
                info['za_chain'] = f'cut {s[i] * 1000:.1f} mm from its proximal end, {(s[-1] - s[i]) * 1000:.1f} mm kept'
                ves['v'], ves['f'], ves['cut'] = v2, f2, True
                p0 = v2[ring].mean(0); seeds = ring
            theta = G.rotvec_between(t0, e['n'])
            out.append(dict(key=J['key'], kind='chain', part=J['part'], p=p0, c=e['c'], theta=theta, seeds={J['chain']: seeds}, hra_mesh=hm, end=e,
                            za_dir=t0, info=dict(info, rotation_deg=round(float(np.degrees(np.linalg.norm(theta))), 1),
                                                 shift_mm=round(float(np.linalg.norm(e['c'] - p0)) * 1000, 2))))
            continue
        out.extend(fork(J, VES, hm, info, hint))
    return out


def fork(J, VES, hm, info, hint):
    """The HRA stub ends where the Z-Anatomy parent bifurcates. The parent is not placed; its distal end direction is
    turned onto the stub's end axis (G.section_frame: the terminal cross-section of the stub) and each child starts at
    the stub's end centre: one junction per child, all with the same rotation, so the branching angles stay Z-Anatomy's."""
    par = VES[J['parent']]
    kids = [k for k in J['children'] if k in VES and not VES[k].get('dropped')]
    starts = {}
    for k in kids:
        l, _ = nearest_loop(VES[k], par['v']); starts[k] = l
    dl, _ = nearest_loop(par, np.array([l['c'] for l in starts.values()]))
    t_in, _ = inward(par['v'], par['f'], dl['idx'])
    t_out = -t_in
    e = G.section_frame(hm[0], hm[1], hint if hint is not None else t_out, near=None)
    theta = G.rotvec_between(t_out, e['n'])
    info.update(hra_end=end_info(e), za_parent=J['parent'], za_parent_end=dict(c_mm=np.round(dl['c'] * 1000, 1).tolist(), dir=np.round(t_out, 3).tolist(),
                                                                                 r_mm=round(dl['r'] * 1000, 2)),
                rotation_deg=round(float(np.degrees(np.linalg.norm(theta))), 1), shift_mm=round(float(np.linalg.norm(e['c'] - dl['c'])) * 1000, 2))
    out = []
    for k, l in starts.items():
        t_k, _ = inward(VES[k]['v'], VES[k]['f'], l['idx'])
        out.append(dict(key=f"{J['key']}:{VES[k]['name']}", fork=J['key'], kind='fork', part=J['part'], p=l['c'], c=e['c'], theta=theta,
                        seeds={k: l['idx']}, hra_mesh=hm, end=e, za_dir=t_k, parent_dir=t_out, child=k,
                        info=dict(info, child=k, child_start_offset_from_parent_end_mm=round(float(np.linalg.norm(l['c'] - dl['c'])) * 1000, 2),
                                  za_branch_angle_deg=round(G.angle_deg(t_k, t_out), 1), child_r_mm=round(l['r'] * 1000, 2))))
    return out


# ------------------------------------------------------------------------------------------------ pelvic companion correction
# The Z-Anatomy aorta bifurcates at L3 and its common iliac vessels divide in front of L5; the HRA aorta ends at L4/L5
# and the HRA common iliac veins divide in front of the sacrum, 5-6 cm lower. Z-Anatomy vessels that HRA has (the
# infrarenal aorta, the common iliac veins and, in the male, the external iliac veins) are paired with their HRA
# counterparts point by point along their centerlines (normalised arc length; the aorta between its end and the
# renal arteries), and the pelvic vessels move with the Gaussian average of those displacements (sigma VC_SIGMA),
# faded out between VC_NEAR and VC_FAR from the paired centerlines: the iliac arteries follow the HRA veins they
# accompany, keeping Z-Anatomy's arrangement around them.
VC_SIGMA, VC_NEAR, VC_FAR = 0.012, 0.015, 0.050
VC_PAIRS = [
    dict(za='Abdominal_aorta', hra='descending_aorta_b', kind='aorta'),
    dict(za='Common_iliac_veinl', hra='(?:left_|right_)?common_iliac_vein(?:_[LR])?', side='l', kind='full'),
    dict(za='Common_iliac_veinr', hra='(?:left_|right_)?common_iliac_vein(?:_[LR])?', side='r', kind='full'),
    dict(za='External_iliac_veinl', hra='external_iliac_vein_[LR]', side='l', kind='full', sexes=('male',)),
    dict(za='External_iliac_veinr', hra='external_iliac_vein_[LR]', side='r', kind='full', sexes=('male',)),
]


def hra_centerline(hv, hf, start_pts, h=0.002):
    """Centerline of an HRA vessel from the vertices nearest to start_pts."""
    tree = cKDTree(hv); _, i = tree.query(np.atleast_2d(start_pts))
    return G.centerline(hv, hf, np.unique(i), h=h)


def resample(P, s, t):
    """Points at arc lengths t along a polyline with arc lengths s."""
    return np.stack([np.interp(t, s, P[:, k]) for k in range(3)], 1)


def pelvic_pairs(sex, VES, log=log):
    X, D, info = [], [], {}
    for pr in VC_PAIRS:
        if 'sexes' in pr and sex not in pr['sexes']: continue
        if pr['za'] not in VES: continue
        hname, hm = hra_stub(sex, pr['hra'], pr.get('side'))
        if hm is None: continue
        hv, hf = hm; z = VES[pr['za']]
        if pr['kind'] == 'aorta':
            # from the lower end up to the renal arteries, in both
            zl = min(loops_of(z['v'], z['f']), key=lambda l: l['c'][1])
            zc = G.centerline(z['v'], z['f'], zl['idx'])
            e = G.section_frame(hv, hf, np.array([0, -1.0, 0]))
            hc = hra_centerline(hv, hf, hv[np.linalg.norm(hv - e['tip'], axis=1) < 0.006])
            zr = [VES[n] for n in ('Left_renal_artery', 'Right_renal_artery') if n in VES]
            zr_o = np.mean([min(loops_of(r['v'], r['f']), key=lambda l: np.linalg.norm(z['v'] - l['c'], axis=1).min())['c'] for r in zr], 0)
            S = source(f'hra-{sex}')
            hr = [S.load_entry(o) for o in S.select(r'^VH_[MF]_(?:left|right)_renal_artery$')]
            hr_o = np.mean([min(loops_of(v, f), key=lambda l: np.linalg.norm(hv - l['c'], axis=1).min())['c'] for v, f in hr], 0)
            sz = zc['s'][G.nearest_on_polyline(zc['p'], zr_o)[0]]; sh = hc['s'][G.nearest_on_polyline(hc['p'], hr_o)[0]]
            t = np.linspace(0, sz, 40)
            Pz = resample(zc['p'], zc['s'], t); Ph = resample(hc['p'], hc['s'], t * sh / sz)
            info[pr['za']] = dict(hra=hname, za_length_mm=round(sz * 1000, 1), hra_length_mm=round(sh * 1000, 1))
        else:
            # the whole vessel, from its upper end
            zl = max(loops_of(z['v'], z['f']), key=lambda l: l['c'][1])
            zc = G.centerline(z['v'], z['f'], zl['idx'])
            top = hv[hv[:, 1] > hv[:, 1].max() - 0.004]
            # start the HRA centerline at the open ring nearest to the Z-Anatomy upper end
            ends = G.merge_loops([e for e in G.stub_ends(hv, hf, min_r=0.002) if e['kind'] == 'open'])
            st = min(ends, key=lambda e: np.linalg.norm(e['c'] - zl['c'])) if ends else None
            hc = hra_centerline(hv, hf, hv[st['loop']] if st is not None else top)
            t = np.linspace(0, 1, 40)
            Pz = resample(zc['p'], zc['s'], t * zc['s'][-1]); Ph = resample(hc['p'], hc['s'], t * hc['s'][-1])
            info[pr['za']] = dict(hra=hname, za_length_mm=round(zc['s'][-1] * 1000, 1), hra_length_mm=round(hc['s'][-1] * 1000, 1))
        X.append(Pz); D.append(Ph - Pz)
        info[pr['za']].update(shift_mean_mm=round(float(np.linalg.norm(Ph - Pz, axis=1).mean()) * 1000, 1),
                              shift_max_mm=round(float(np.linalg.norm(Ph - Pz, axis=1).max()) * 1000, 1))
    if not X: return None, info
    return (np.concatenate(X), np.concatenate(D)), info


def pelvic_correction(sex, VES, log=log):
    """Move every vessel by the companion field (see above). Returns the info for the report."""
    pairs, info = pelvic_pairs(sex, VES, log)
    if pairs is None: return info
    X, D = pairs
    tree = cKDTree(X)
    for n, x in VES.items():
        d, i = tree.query(x['v'], k=min(24, len(X)))
        K = np.exp(-0.5 * (d / VC_SIGMA) ** 2) + 1e-30
        avg = np.einsum('ij,ijk->ik', K, D[i]) / K.sum(1, keepdims=True)
        fade = G.smoothstep((VC_FAR - d[:, 0]) / (VC_FAR - VC_NEAR))
        x['v'] = x['v'] + fade[:, None] * avg
        x['pelvic_mm'] = float(np.linalg.norm(fade[:, None] * avg, axis=1).max() * 1000)
    for k, v in info.items(): log('  pelvic pair', k, json.dumps(v))
    return info


# ------------------------------------------------------------------------------------------------ vessel trees
class System:
    """All placed vessels of one part (arteries or veins) as one vertex set with a graph: mesh edges plus contacts."""

    def __init__(self, VES, part):
        self.names = [n for n, x in VES.items() if x['part'] == part and x['placed'] and not x.get('dropped')]
        self.off = {}; vs, fs = [], []; o = 0
        for n in self.names:
            self.off[n] = o; vs.append(VES[n]['v']); fs.append(VES[n]['f'] + o); o += len(VES[n]['v'])
        self.v = np.concatenate(vs); self.f = np.concatenate(fs)
        self.owner = np.concatenate([np.full(len(VES[n]['v']), i) for i, n in enumerate(self.names)])
        # contacts: each vertex to its nearest vertex of another vessel, if close
        tree = cKDTree(self.v)
        pairs = []
        for i, n in enumerate(self.names):
            m = self.owner == i
            other = cKDTree(self.v[~m]); oi = np.flatnonzero(~m)
            d, j = other.query(self.v[m], distance_upper_bound=CONTACT)
            ok = np.isfinite(d)
            pairs.append(np.stack([np.flatnonzero(m)[ok], oi[j[ok]]], 1))
        self.contacts = np.concatenate(pairs) if pairs else np.zeros((0, 2), int)
        self.G = G.graph(self.v, self.f, self.contacts)

    def idx(self, name, local):
        return self.off[name] + np.asarray(local)

    def split(self, x):
        return {n: x[self.off[n]:self.off[n] + int((self.owner == i).sum())] for i, n in enumerate(self.names)}


def snap(VES, junctions, log=log):
    """Apply the junction motions (see the module docstring). Returns {part: (System, geodesic distance to the nearest
    junction seed per vertex)}."""
    res = {}
    for part in (A, V):
        Js = [j for j in junctions if j['part'] == part]
        S = System(VES, part)
        n = len(S.v)
        W = np.zeros((len(Js), n)); Dk = np.zeros((len(Js), n, 3)); dmin = np.full(n, np.inf)
        for k, j in enumerate(Js):
            seeds = np.concatenate([S.idx(nm, ix) for nm, ix in j['seeds'].items() if nm in S.off])
            s = G.geodesic(S.G, seeds, limit=L_SNAP)
            dmin = np.minimum(dmin, s)
            m = s < L_SNAP
            w = np.zeros(n); w[m] = 0.5 * (1 + np.cos(np.pi * s[m] / L_SNAP))
            # rigid motion scaled by w: rotation about the pivot by w*theta, translation w*(c - p)
            th = np.linalg.norm(j['theta']); ax = j['theta'] / th if th > 1e-12 else np.zeros(3)
            x = S.v[m] - j['p']
            ang = w[m] * th
            cs, sn = np.cos(ang)[:, None], np.sin(ang)[:, None]
            xr = x * cs + np.cross(ax, x) * sn + ax * (x @ ax)[:, None] * (1 - cs)
            Dk[k, m] = xr + j['p'] + w[m, None] * (j['c'] - j['p']) - S.v[m]
            W[k, m] = (s[m] + EPS_SHEPARD) ** -2
            j['geo'] = s
        tot = W.sum(0)
        disp = np.zeros((n, 3))
        nz = tot > 0
        if len(Js): disp[nz] = np.einsum('kn,knd->nd', W[:, nz], Dk[:, nz]) / tot[nz, None]
        S.v = S.v + disp
        for nm, x in S.split(S.v).items(): VES[nm]['v'] = x
        for nm, x in S.split(np.linalg.norm(disp, axis=1)).items(): VES[nm]['snap_mm'] = float(x.max() * 1000)
        res[part] = (S, dmin)
        log(f'  snap {part}: {len(Js)} junctions, max displacement {np.linalg.norm(disp, axis=1).max() * 1000:.1f} mm')
    return res


# ------------------------------------------------------------------------------------------------ pipeline
def load_vessels(sex, M):
    sp, ref = specs(sex)
    z = source('za-cardio')
    VES = {}
    for (n, part, side, region), placed in [(s, True) for s in sp] + [(r, False) for r in ref]:
        v, w = M.map_vessel(n, side, region)
        VES[n] = dict(za=n, name=snake(n, side), part=part, side=side, region=region, v=v, f=z.get(n)[1], w=w, placed=placed)
    M.save()
    return VES


def run(sex, stage='all'):
    t0 = time.time()
    M = Mapper(sex)
    VES = load_vessels(sex, M)
    log(sex, 'mapped', len(VES), 'vessels', f'{time.time() - t0:.0f}s')
    for k, x in VES.items(): x['v_mapped'] = x['v'].copy()
    pel = pelvic_correction(sex, VES)
    J = setup_junctions(sex, VES)
    for j in J: log('  junction', j['key'], json.dumps({k: j['info'][k] for k in j['info'] if k != 'candidates'}))
    trees = snap(VES, J)
    return VES, J, trees


if __name__ == '__main__':
    args = sys.argv[1:]
    which = [a for a in args if not a.startswith('--')]
    for sex in (['male', 'female'] if not which or which[0] == 'all' else which):
        run(sex)
