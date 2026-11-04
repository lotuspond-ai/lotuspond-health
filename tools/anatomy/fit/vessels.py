"""Vessels group: Z-Anatomy (za-cardio, CC BY-SA 4.0) arteries and veins that continue the HRA vascular tree into the
neck, head, upper limbs, thorax wall, pelvis and lower limbs of each HRA body, without duplicating any HRA vessel.

    python3 fit/vessels.py [male|female|all] [--no-render]
    parts: arteries -> 'arteries', veins -> 'veins'

What HRA has (compared by name and position, .cache/parts/<sex>/structures.json): the aorta from the valve to its
bifurcation (ending in two short common-iliac openings), the brachiocephalic trunk (male: to its bifurcation; female: on
4 cm up the right common carotid), the left common carotid (male: to its bifurcation at the upper border of the thyroid
cartilage; female: a 5 cm stub), the left subclavian's first 3 cm, the visceral branches, the superior and inferior venae
cavae, the common and internal iliac veins (male: also both brachiocephalic veins, the right one going on 2.5 cm up the
internal jugular, and the external iliac veins), the eye's ophthalmic and retinal vessels. No iliac arteries and no limb,
neck or head vessels beyond those. Z-Anatomy vessels that duplicate an HRA one are never output; they are mapped only to
locate junctions (fit/vessels_map.REFERENCE), and Z-Anatomy vessels the HRA stubs cover are cut where they leave them.

Method (per body):
 1. Deformation (fit/vessels_map.py): each Z-Anatomy mesh refined to edges <= 4 mm, then the trunk warp with a smooth
    thin-plate correction toward the bones the rib cage and arms groups placed, the skull group's head map above C3, the
    arms group's arm_deform (by position, with its weight) and the foot group's leg_deform below the hip, blended with
    the weights those groups export.
 2. Pelvic companion correction (pelvic_correction): Z-Anatomy's iliac confluences map 4-9 cm above the HRA ones, so the
    pelvic vessels follow the HRA aorta and iliac veins they accompany (centerline pairs, Gaussian field).
 3. Junctions (JUNCTIONS, setup_junctions): HRA end frames from plane sections (the outer wall of double-walled HRA
    vessels) or open boundary rings; Z-Anatomy frames from main-trunk centerlines (side branches excluded, kernel
    regression on geodesic distance: the meshes are coarse). 'chain': the Z-Anatomy vessel is cut by the plane through
    its centerline point nearest the stub's end and its axis there is turned onto the stub's; 'fork' / 'branch': the
    children of a Z-Anatomy parent that is not placed move as one rigid unit, the parent's distal ring onto the stub's
    end (or onto the stub's axis where a branch leaves its side), turned only as far as needed to bring the parent axis
    within FORK_TOL of the stub's; 'side': an end ring set half a radius into an HRA vessel's wall. Each motion acts
    rigidly over S_RIGID = 1.2 cm of geodesic distance along the vessel tree (mesh edges plus contacts between touching
    vessels) and decays to zero by L_SNAP = 6.5 cm (raised cosine), several junctions blended by inverse geodesic
    distance.
    Re-alignment (realign): each chain junction's end axis is then measured exactly as the report measures it; those
    more than REALIGN_ABOVE off the stub's axis are turned again about their end ring, down to CHAIN_TOL, while every
    other junction is held where the first pass put it.
    Femoral sheath (sheath_companion, male): the femoral arteries take their femoral vein's snap displacement (Gaussian
    average over the vein and the fixed HRA external iliac vein), so the vein stays about 1 cm medial to its artery as
    in Z-Anatomy instead of swinging behind it 3-5 cm below the inguinal ligament.
 4. Push-out (fit/vessels_fix.py): out of every bone (HRA and placed) by 0.8 mm, out of the solid organs by 0.3 mm and
    1.5 mm inside the skin, with a Gaussian-spread displacement that moves a tube as a whole, shared across Z-Anatomy
    junctions (connected vessels form one group), faded in over 1.5 cm from the junction rings (2.5 cm from a chain
    junction's ring: past the stretch its end axis is measured on); vertices first, then probes inside the faces near a
    bone. Inside tests are ray parity with a majority of three rays, five when the first three disagree
    (fit/vessels_geom.TriSet).
 5. Measurements (fit/vessels_measure.py) -> report.json, QA renders, write_group().
"""
import os, sys, json, time, re
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, orient_outward  # noqa: E402
from fit.common import FIT, write_group  # noqa: E402
from fit.vessels_map import Mapper, specs, work_dir, log, GROUP, A, V, za_mesh  # noqa: E402
from fit import vessels_geom as G  # noqa: E402
from catalog import HRA_EXCLUDE  # noqa: E402

L_SNAP = 0.065      # junction displacement decays to zero at this geodesic distance (m)
S_RIGID = 0.012     # ... after moving rigidly over this first stretch (m)
CONTACT = 0.003     # vertices of different vessels closer than this are linked in the tree graph (m)
EPS_SHEPARD = 0.0002

# ------------------------------------------------------------------------------------------------ junctions
# hra: HRA mesh name pattern (without the VH_M_/VH_F_ prefix); side: pick the HRA mesh on that side by position;
# end: which end of the HRA mesh ('tip': the end facing `hint` from plane sections; 'loop': the open boundary ring facing
# `hint` nearest to the Z-Anatomy vessel; 'axis': the point of the stub's centerline nearest to the Z-Anatomy parent's
# distal ring, for a branch that leaves the side of a longer stub); hint: outward direction of that end (+x = the
# person's left, +y up, +z front).
# kinds: 'fork' (the stub ends at the bifurcation of a Z-Anatomy parent that is not placed: its children move as one
# rigid unit, the parent's distal axis turned onto the stub's end axis and its distal ring centre put on the stub's end
# centre), 'chain' (the Z-Anatomy vessel continues the stub: cut where it leaves the stub's end, its own axis turned
# onto the stub's end axis), 'branch' (a fork onto a point of the stub's axis), 'side' (a Z-Anatomy vessel ends on the
# wall of an HRA vessel: translated so its end ring sits half a radius inside that wall).
JUNCTIONS = [
    # ---- arteries
    # male: the HRA brachiocephalic artery ends at its bifurcation (Z-Anatomy's maps 2 mm below its end)
    dict(key='brachiocephalic_bifurcation', part=A, sexes=('male',), hra='brachiocephalic_artery_b', kind='fork', end='tip', hint=(-0.5, 1, 0),
         parent='Brachiocephalic_trunk', children=['Right_common_carotid_artery', 'Right_subclavian_artery']),
    # female: the HRA mesh goes on 4 cm up the right common carotid (its section drops from 55-60 to 36-40 mm2 at the
    # level where the Z-Anatomy bifurcation maps, y = 0.566): the carotid continues its top, the subclavian leaves its side
    dict(key='right_common_carotid', part=A, sexes=('female',), hra='brachiocephalic_artery_b', kind='chain', end='tip', hint=(-0.3, 1, 0.2),
         vessel='Right_common_carotid_artery'),
    dict(key='right_subclavian_origin', part=A, sexes=('female',), hra='brachiocephalic_artery_b', kind='branch', end='axis', hint=(-0.3, 1, 0.2),
         parent='Brachiocephalic_trunk', children=['Right_subclavian_artery']),
    # female: the HRA left common carotid is a 5 cm stub. male: its first 1.6 cm (_a) leaves the arch at a normal calibre,
    # but its continuation to the bifurcation (_b) is a 2.5-4.6 mm thread beside a 9-12 mm right common carotid, stepping
    # up 3-4x into the internal and external carotids: the Z-Anatomy left common carotid continues _a instead, and _b
    # is left out of the assembly (assemble.py: HRA name VH_M_left_common_carotid_artery_b)
    dict(key='left_common_carotid', part=A, sexes=('male',), hra='left_common_carotid_artery_a', kind='chain', end='tip', hint=(0, 1, 0),
         vessel='Left_common_carotid_artery'),
    dict(key='left_common_carotid', part=A, sexes=('female',), hra='left_common_carotid_artery_b', kind='chain', end='tip', hint=(0, 1, 0.2),
         vessel='Left_common_carotid_artery'),
    dict(key='left_subclavian', part=A, hra='left_subclavian_artery_b', kind='chain', end='tip', hint=(0.3, 1, 0), vessel='Left_subclavian_artery'),
    # the HRA aorta ends a few mm below the start of both common iliacs (two small openings); Z-Anatomy's common iliacs
    # both start on the whole aortic end ring
    dict(key='aortic_bifurcation', part=A, hra='descending_aorta_b', kind='fork', end='tip', hint=(0, -1, 0),
         parent='Abdominal_aorta', children=['Common_iliac_arteryl', 'Common_iliac_arteryr']),
    # ---- veins
    # male: HRA brachiocephalic veins end at the venous angles (internal jugular + subclavian)
    # male: the HRA right brachiocephalic vein narrows at y = 0.577 (section 200 -> 30 mm2) and goes on 2.5 cm up the
    # internal jugular; the left one divides at y = 0.592 into two 1.5-2 cm prongs
    dict(key='right_internal_jugular', part=V, sexes=('male',), hra='brachiocephalic_vein_[LR]', side='r', kind='chain', end='tip', hint=(0, 1, 0),
         vessel='Internal_jugular_veinr'),
    dict(key='right_subclavian_vein', part=V, sexes=('male',), hra='brachiocephalic_vein_[LR]', side='r', kind='branch', end='axis', at='widening',
         hint=(0, 1, 0), parent='Right_brachiocephalic_vein', children=['Right_subclavian_vein']),
    dict(key='left_venous_angle', part=V, sexes=('male',), hra='brachiocephalic_vein_[LR]', side='l', kind='branch', end='axis', hint=(0.6, 1, 0.2),
         parent='Left_brachiocephalic_vein', children=['Internal_jugular_veinl', 'Left_subclavian_vein']),
    dict(key='internal_thoracic_vein_l', part=V, sexes=('male',), hra='brachiocephalic_vein_[LR]', side='l', kind='side', vessel='Internal_thoracic_veinsl'),
    dict(key='internal_thoracic_vein_r', part=V, sexes=('male',), hra='brachiocephalic_vein_[LR]', side='r', kind='side', vessel='Internal_thoracic_veinsr'),
    # male: HRA external iliac veins (capped at the inguinal ligament) -> femoral veins
    # (their arteries follow the veins' snap in the femoral sheath: sheath_companion)
    dict(key='femoral_vein_l', part=V, sexes=('male',), hra='external_iliac_vein_[LR]', side='l', kind='chain', end='tip', hint=(0.2, -1, 0.4),
         vessel='Femoral_veinl', companion=True),
    dict(key='femoral_vein_r', part=V, sexes=('male',), hra='external_iliac_vein_[LR]', side='r', kind='chain', end='tip', hint=(-0.2, -1, 0.4),
         vessel='Femoral_veinr', companion=True),
    # female: no HRA brachiocephalic or external iliac veins: the Z-Anatomy ones continue the superior vena cava's two
    # open rings and the common iliac veins' distal rings
    dict(key='svc_right_brachiocephalic', part=V, sexes=('female',), hra='superior_vena_cava', kind='chain', end='loop', axis='march', hint=(-0.2, 1, 0),
         vessel='Right_brachiocephalic_vein'),
    # (pin: the push-out out of the thymus lobe in front of it fades in over 4 cm from this ring instead of PIN_CHAIN: at
    # 2.5 cm it bent the vein's first 2 cm from 10 to 24 degrees off the ring's axis without clearing the thymus)
    dict(key='svc_left_brachiocephalic', part=V, sexes=('female',), hra='superior_vena_cava', kind='chain', end='loop', hint=(1, 0.3, 0.6),
         vessel='Left_brachiocephalic_vein', pin=0.040),
    dict(key='external_iliac_vein_l', part=V, sexes=('female',), hra='(?:left_|right_)?common_iliac_vein(?:_[LR])?', side='l', kind='chain', end='loop',
         axis='march', hint=(0.7, -0.6, 0.3), vessel='External_iliac_veinl'),
    dict(key='external_iliac_vein_r', part=V, sexes=('female',), hra='(?:left_|right_)?common_iliac_vein(?:_[LR])?', side='r', kind='chain', end='loop',
         axis='march', hint=(-0.7, -0.6, 0.3), vessel='External_iliac_veinr'),
    dict(key='azygos_arch', part=V, hra='superior_vena_cava', kind='side', vessel='Azygos_vein'),
]
FORK_TOL = 10.0     # degrees of parent-axis misalignment a fork keeps (minimal rotation of its children)
CHAIN_TOL = 10.0    # degrees of axis misalignment a chain junction keeps (minimal rotation)
AXIS_SPAN = 0.015   # vessel axes are fitted to the centerline over this length, starting one radius from an end ring


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


def axis_from(cl, s0, s1):
    """Unit axis through the centerline points with arc length in [s0, s1], oriented toward increasing arc length."""
    P, s = cl['p'], cl['s']
    m = (s >= s0) & (s <= s1)
    if m.sum() < 3:
        m = np.zeros(len(P), bool); k = int(np.searchsorted(s, s0)); m[max(0, k - 2):k + 3] = True
    Q = P[m]
    if len(Q) < 2: return G.unit(P[min(len(P) - 1, 1)] - P[0])
    a = G.pca_axis(Q)
    return a if a @ (Q[-1] - Q[0]) >= 0 else -a


def trunk_from(v, f, ring):
    """Main-trunk centerline of a Z-Anatomy vessel from one end ring to its other end ring (the boundary loop farthest
    from it); side branches are left out (G.trunk_centerline)."""
    c0 = v[ring].mean(0)
    L = [l for l in loops_of(v, f) if len(l['idx']) >= 5 and np.linalg.norm(l['c'] - c0) > 0.002]
    if not L: return G.centerline(v, f, ring)
    other = max(L, key=lambda l: np.linalg.norm(l['c'] - c0))
    return G.trunk_centerline(v, f, ring, other['idx'])


def leaving_axis(v, f, ring, r):
    """Axis of a tube leaving an end ring (main-trunk centerline from the ring, fitted from one radius to that +
    AXIS_SPAN)."""
    cl = trunk_from(v, f, ring)
    return axis_from(cl, r, r + AXIS_SPAN), cl


def nearest_loop(ves, pts):
    """The boundary loop of a vessel whose centre is nearest to a point set."""
    tree = cKDTree(np.atleast_2d(pts))
    L = loops_of(ves['v'], ves['f'])
    d = [tree.query(l['c'])[0] for l in L]
    return L[int(np.argmin(d))], float(min(d))


def hra_end(hv, hf, J, near):
    """End frame of an HRA stub for a junction (see JUNCTIONS). 'tip': the end facing J['hint'], from plane sections
    behind it (G.section_frame: the largest polygon of each section, i.e. the outer wall of a double-walled vessel; the
    tapering tip of a capped end is skipped; the axis is refitted through the section centres over 2-24 mm). 'loop': an
    open boundary ring (cut by the segmentation) facing the hint and near the Z-Anatomy vessel (`near` points): its
    centre and outward normal."""
    hint = G.unit(np.array(J.get('hint', (0, 1, 0)), float))
    if J['end'] == 'loop':
        ends = G.merge_loops([e for e in G.stub_ends(hv, hf, min_r=0.002) if e['kind'] == 'open'])
        tree = cKDTree(np.atleast_2d(near))
        sc = [(e['n'] @ hint) - tree.query(e['c'])[0] / 0.02 for e in ends]
        e = ends[int(np.argmax(sc))]
        if J.get('axis') == 'march':
            # the ring continues the stub's own course: its axis from the stub's marched centerline below the ring
            fr, _ = G.march_frame(hv, hf, e['c'], -e['n'], near=0.004)
            if fr is not None and fr['n'] @ e['n'] > 0.3: return dict(c=e['c'], n=fr['n'], r=e['r'], kind='open ring (stub axis)', ring_normal=e['n'])
        return dict(c=e['c'], n=e['n'], r=e['r'], kind='open ring')
    e = G.section_frame(hv, hf, hint)
    return dict(c=e['c'], n=e['n'], r=e['r'], kind='section tip', tip=e['tip'])


def hra_axis_point(hv, hf, J, x):
    """A point of an HRA stub's section-marched centerline (from its end facing J['hint']) with the distal tangent
    there: where a branch leaves the side of a stub that goes on beyond the branching. J['at'] = 'nearest' (default:
    the point nearest to x, the Z-Anatomy parent's distal ring) or 'widening' (the first point, going in from the end,
    whose section is more than twice the median section of the narrow part above it: the confluence)."""
    hint = G.unit(np.array(J.get('hint', (0, 1, 0)), float))
    e0 = G.section_frame(hv, hf, hint)
    m = G.march(hv, hf, e0['tip'], -e0['n'], length=0.10)
    P, A, s_ = m['p'], m['a'], m['s']
    if J.get('at') == 'widening':
        ref = np.median(A[(s_ > 0.004) & (s_ < 0.015)])
        k = np.flatnonzero((A > 2.0 * ref) & (s_ > 0.006))
        i = int(k[0]) if len(k) else int(np.argmax(A))
        d = float(np.linalg.norm(P[i] - x))
    else:
        i, d = G.nearest_on_polyline(P[1:], x); i += 1
    t = axis_from(dict(p=P, s=s_), s_[i] - 0.006, s_[i] + 0.006)
    r = float(np.sqrt(A[max(1, i - 2):i + 3].mean() / np.pi))
    return dict(c=P[i], n=-t, r=r, kind='stub axis', from_end_mm=round(float(s_[i]) * 1000, 1), offset_mm=round(d * 1000, 1))


def end_info(e):
    return dict(c_mm=np.round(e['c'] * 1000, 1).tolist(), dir=np.round(e['n'], 3).tolist(), r_mm=round(e['r'] * 1000, 2), kind=e['kind'])


def cut_chain(ves, e, hv):
    """Cut a Z-Anatomy vessel that continues an HRA stub (vertices hv) where it leaves the stub's end: at the centerline
    point nearest to the end centre (from the vessel's end ring nearest to the stub), by the plane perpendicular to the
    vessel there; keep the far part. Returns (ring vertex idx, ring centre, leaving axis, info, ring radius)."""
    v, f = ves['v'], ves['f']
    loop, _ = nearest_loop(ves, hv)
    cl = trunk_from(v, f, loop['idx'])
    P, s = cl['p'], cl['s']
    i, d = G.nearest_on_polyline(P, e['c'])
    # also never keep a part that still runs inside the stub: move the cut ahead of the stub's end plane
    ahead = (P - e['c']) @ e['n'] >= 0
    if not ahead[i] and ahead[i:].any(): i = i + int(np.argmax(ahead[i:]))
    if s[i] < max(0.5 * loop['r'], 0.002):
        t = axis_from(cl, 0.5 * loop['r'], 0.5 * loop['r'] + AXIS_SPAN)
        return loop['idx'], loop['c'], t, 'starts at the HRA end: not cut', loop['r']
    if s[-1] - s[i] < 0.006:
        return None, None, None, 'covered by HRA', loop['r']
    t0 = axis_from(cl, s[i] - 0.003, s[i] + AXIS_SPAN)
    v2, f2, ring = G.plane_cut(v, f, P[i], t0, keep_near=P[-1])
    d, k = cKDTree(v2).query(v)
    ves['orig_index'] = np.where(d < 1e-9, k, -1)
    ves['v'], ves['f'], ves['cut'] = v2, f2, True
    c = v2[ring].mean(0)
    rr = float(np.linalg.norm(v2[ring] - c, axis=1).mean())
    cl2 = trunk_from(v2, f2, ring)
    t = axis_from(cl2, 0.5 * rr, 0.5 * rr + AXIS_SPAN)
    return ring, c, t, f'cut {s[i] * 1000:.1f} mm from its proximal end ({(s[-1] - s[i]) * 1000:.1f} mm kept)', rr


def parent_frame(par, kids, VES):
    """Distal ring of a Z-Anatomy parent (the ring its children start on) and its axis there (from the parent's
    centerline over the 25 mm that end one radius before that ring)."""
    starts = {}
    for k in kids:
        l, _ = nearest_loop(VES[k], par['v']); starts[k] = l
    dl, _ = nearest_loop(par, np.array([l['c'] for l in starts.values()]))
    L = loops_of(par['v'], par['f'])
    prox = max(L, key=lambda l: np.linalg.norm(l['c'] - dl['c']))
    cl = trunk_from(par['v'], par['f'], prox['idx'])
    i, _ = G.nearest_on_polyline(cl['p'], dl['c'])
    se = cl['s'][i]
    t = axis_from(cl, se - dl['r'] - 0.025, se - dl['r'])
    return dl, t, starts


def setup_junctions(sex, VES, log=log):
    """Resolve every junction of this body: HRA end frames, Z-Anatomy end frames, cuts and drops. Returns a list of
    dicts (key, kind, part, pivot p, target c, rotation theta, seeds={vessel: vertex idx}, hra end e, info)."""
    out = []
    for J in JUNCTIONS:
        if 'sexes' in J and sex not in J['sexes']: continue
        hname, hm = hra_stub(sex, J['hra'], J.get('side'))
        if hm is None: log('  junction', J['key'], ': no HRA stub'); continue
        hv, hf = hm
        info = dict(hra=hname, kind=J['kind'])
        if J['kind'] == 'side':
            ves = VES[J['vessel']]
            loop, _ = nearest_loop(ves, hv)
            T = G.TriSet(hv, hf)
            sd, q = T.signed(loop['c'][None], band=0.08)
            m = G.unit(loop['c'] - q[0]) * (1 if sd[0] >= 0 else -1)
            c = loop['c'] - m * (sd[0] + 0.5 * loop['r'])
            t_in, _ = leaving_axis(ves['v'], ves['f'], loop['idx'], loop['r'])
            out.append(dict(key=J['key'], kind='side', part=J['part'], p=loop['c'], c=c, theta=np.zeros(3), seeds={J['vessel']: loop['idx']},
                            vessels=[J['vessel']], hra_mesh=hm, end=dict(c=c, n=-m, r=loop['r'], kind='wall'), za_dir=t_in, za_r=loop['r'],
                            info=dict(info, vessel=J['vessel'], signed_dist_before_mm=round(float(sd[0]) * 1000, 2), za_r_mm=round(loop['r'] * 1000, 2),
                                      shift_mm=round(float(np.linalg.norm(c - loop['c'])) * 1000, 2))))
            continue
        if J['kind'] == 'chain':
            ves = VES[J['vessel']]
            e = hra_end(hv, hf, J, ves['v'])
            ring, p0, t0, how, rr = cut_chain(ves, e, hv)
            info.update(hra_end=end_info(e), za_cut=how)
            if ring is None:
                ves['dropped'] = True; log('  junction', J['key'], ': Z-Anatomy vessel covered by the HRA stub, dropped'); continue
            # turned only as far as needed to bring its axis within CHAIN_TOL of the stub's: a full turn of a large
            # mismatch swings the vessel 1-2 cm off its course over the decay length (the femoral vein behind its artery)
            th = G.rotvec_between(t0, e['n']); ang = float(np.linalg.norm(th))
            theta = th * max(0.0, ang - np.radians(CHAIN_TOL)) / ang if ang > 1e-9 else th
            out.append(dict(key=J['key'], kind='chain', part=J['part'], p=p0, c=e['c'], theta=theta, seeds={J['vessel']: ring}, vessels=[J['vessel']],
                            hra_mesh=hm, end=e, za_dir=t0, za_r=rr, l_snap=J.get('l_snap', L_SNAP), companion=J.get('companion', False), pin=J.get('pin', PIN_CHAIN),
                            info=dict(info, vessel=J['vessel'], za_end=dict(c_mm=np.round(p0 * 1000, 1).tolist(), dir=np.round(t0, 3).tolist(), r_mm=round(rr * 1000, 2)),
                                      axis_mismatch_deg=round(float(np.degrees(ang)), 1), rotation_deg=round(float(np.degrees(np.linalg.norm(theta))), 1),
                                      shift_mm=round(float(np.linalg.norm(e['c'] - p0)) * 1000, 2))))
            continue
        # fork / branch: the parent is not placed; its children move as one rigid unit
        par = VES[J['parent']]
        kids = [k for k in J['children'] if k in VES and not VES[k].get('dropped')]
        dl, t_par, starts = parent_frame(par, kids, VES)
        par['dropped'] = True
        e = hra_axis_point(hv, hf, J, dl['c']) if J['end'] == 'axis' else hra_end(hv, hf, J, dl['c'][None])
        # the children turn only as far as needed for the parent axis they carry to come within FORK_TOL of the stub's
        # axis: their own courses (which the trunk warp fits) are kept as far as the junction allows
        th = G.rotvec_between(t_par, e['n']); ang = float(np.linalg.norm(th))
        theta = th * max(0.0, ang - np.radians(FORK_TOL)) / ang if ang > 1e-9 else th
        za_t = {}
        for k in kids:
            za_t[k], _ = leaving_axis(VES[k]['v'], VES[k]['f'], starts[k]['idx'], starts[k]['r'])
        info.update(hra_end=end_info(e), za_parent=J['parent'],
                    za_parent_end=dict(c_mm=np.round(dl['c'] * 1000, 1).tolist(), dir=np.round(t_par, 3).tolist(), r_mm=round(dl['r'] * 1000, 2)),
                    rotation_deg=round(float(np.degrees(np.linalg.norm(theta))), 1), shift_mm=round(float(np.linalg.norm(e['c'] - dl['c'])) * 1000, 2),
                    children={k: dict(start_offset_from_parent_ring_mm=round(float(np.linalg.norm(starts[k]['c'] - dl['c'])) * 1000, 2),
                                      za_branch_angle_deg=round(G.angle_deg(za_t[k], t_par), 1), r_mm=round(starts[k]['r'] * 1000, 2)) for k in kids})
        R = G.rotvec_matrix(theta); TS = G.TriSet(hv, hf)
        for k in kids:
            landed = R @ (starts[k]['c'] - dl['c']) + e['c']
            sd, q = TS.signed(landed[None], band=0.05)
            delta = np.zeros(3)
            if sd[0] > 0 and np.linalg.norm(starts[k]['c'] - dl['c']) > 0.002:
                # a child starting beside the parent's ring (the subclavian vein 11 mm from the jugular's) would miss the
                # stub: its ring is set half a radius into the stub's wall
                m = G.unit(landed - q[0]); delta = -m * (sd[0] + 0.5 * starts[k]['r'])
            info['children'][k]['wall_correction_mm'] = round(float(np.linalg.norm(delta)) * 1000, 2)
            out.append(dict(key=J['key'] if len(kids) == 1 else f"{J['key']}:{VES[k]['name']}", kind=J['kind'], part=J['part'], p=dl['c'], c=e['c'] + delta,
                            theta=theta, seeds={k: starts[k]['idx']}, vessels=[k], hra_mesh=hm, end=e, za_dir=t_par, za_child_dirs={k: za_t[k]},
                            za_r=dl['r'], info=info))
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
# the external iliac veins are not moved: in the female (where they are placed) the HRA common iliac veins reach 8-9 cm
# lower than Z-Anatomy's (down to y = 0.09, 2 cm below the internal iliac junction), and dragging the external iliac
# veins' upper ends down with them would fold them; they are cut where they pass the HRA veins' distal rings instead
VC_SKIP = ('External_iliac_veinl', 'External_iliac_veinr')
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
            zc = trunk_from(z['v'], z['f'], zl['idx'])
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
            zc = trunk_from(z['v'], z['f'], zl['idx'])
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


# the branches of the common iliac arteries take their start ring's displacement along them: the field moves the
# common iliac's end ring (beside the HRA veins) 4-7 cm, but fades out within 3.5 cm of the veins, so without this the
# external and internal iliac arteries first ran 4-5 cm back up along the common iliac before turning down (a hairpin)
VC_PROPAGATE = ('External_iliac_artery', 'Internal_iliac_artery')


def pelvic_correction(sex, VES, log=log):
    """Move every vessel by the companion field (see above); the common iliac arteries' branches carry their start
    ring's displacement with a geodesic raised-cosine falloff over their own length (their far ends keep the field's
    displacement, so the external iliac still meets the femoral artery). Returns the info for the report."""
    pairs, info = pelvic_pairs(sex, VES, log)
    if pairs is None: return info
    X, D = pairs
    tree = cKDTree(X)
    disp = {}
    for n, x in VES.items():
        if n in VC_SKIP: continue
        d, i = tree.query(x['v'], k=min(24, len(X)))
        K = np.exp(-0.5 * (d / VC_SIGMA) ** 2) + 1e-30
        avg = np.einsum('ij,ijk->ik', K, D[i]) / K.sum(1, keepdims=True)
        fade = G.smoothstep((VC_FAR - d[:, 0]) / (VC_FAR - VC_NEAR))
        disp[n] = fade[:, None] * avg
    prop = {}
    for n in list(disp):
        par = VES.get('Common_iliac_artery' + n[-1])
        if not n.startswith(VC_PROPAGATE) or par is None: continue
        x = VES[n]
        ring = min(loops_of(x['v'], x['f']), key=lambda l: np.linalg.norm(par['v'] - l['c'], axis=1).min())
        g = G.geodesic(G.graph(x['v'], x['f']), ring['idx'])
        g = np.where(np.isfinite(g), g, np.nanmax(np.where(np.isfinite(g), g, np.nan)))
        d_ring = disp[n][ring['idx']].mean(0)
        w = 0.5 * (1 + np.cos(np.pi * np.clip(g / g.max(), 0, 1)))
        before = float(np.linalg.norm(disp[n] - d_ring, axis=1).max())
        disp[n] = disp[n] + w[:, None] * (d_ring - disp[n])
        prop[n] = dict(ring_shift_mm=round(float(np.linalg.norm(d_ring)) * 1000, 1), length_cm=round(float(g.max()) * 100, 1),
                       max_lag_behind_ring_before_mm=round(before * 1000, 1))
    for n, dv in disp.items():
        x = VES[n]; x['v'] = x['v'] + dv
        x['pelvic_mm'] = float(np.linalg.norm(dv, axis=1).max() * 1000)
    for k, v in info.items(): log('  pelvic pair', k, json.dumps(v))
    for k, v in prop.items(): log('  pelvic branch propagation', k, json.dumps(v))
    info['branch_propagation'] = prop
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
            Lj = j.get('l_snap', L_SNAP)
            s = G.geodesic(S.G, seeds, limit=max(Lj, L_SNAP))
            dmin = np.minimum(dmin, s)
            m = s < Lj
            # rigid over the first S_RIGID (the end ring and the stretch its axis is measured on move as one piece),
            # then a raised-cosine decay to zero at Lj (L_SNAP unless the junction sets its own)
            tt = np.clip((s[m] - S_RIGID) / (Lj - S_RIGID), 0.0, 1.0)
            w = np.zeros(n); w[m] = 0.5 * (1 + np.cos(np.pi * tt))
            # rigid motion scaled by w: rotation about the pivot by w*theta, translation w*(c - p)
            th = np.linalg.norm(j['theta']); ax = j['theta'] / th if th > 1e-12 else np.zeros(3)
            x = S.v[m] - j['p']
            ang = w[m] * th
            cs, sn = np.cos(ang)[:, None], np.sin(ang)[:, None]
            xr = x * cs + np.cross(ax, x) * sn + ax * (x @ ax)[:, None] * (1 - cs)
            Dk[k, m] = xr + j['p'] + w[m, None] * (j['c'] - j['p']) - S.v[m]
            W[k, m] = (s[m] + EPS_SHEPARD) ** -2
            j['geo'] = s
            if j.get('realign'):
                continue                    # a re-alignment pass (realign()) keeps the first pass's rigid stretch
            # the stretch that moves rigidly, before the motion (the report recovers the applied rotation from it)
            j['rigid'] = {}
            for nm in j['vessels']:
                if nm not in S.off: continue
                loc = np.flatnonzero(s[S.off[nm]:S.off[nm] + len(VES[nm]['v'])] < 0.8 * S_RIGID)
                j['rigid'][nm] = (loc, S.v[S.off[nm] + loc].copy())
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
        zv, zf = za_mesh(n)
        VES[n] = dict(za=n, name=snake(n, side), part=part, side=side, region=region, v=v, f=zf, w=w, placed=placed, za_v=zv, za_f=zf, orig_index=None)
    M.save()
    return VES


def orient(v, f):
    """Wind an open tube's faces so its normals point away from the tube (the local centroid of the vertices within
    4 mm lies inside the tube); the whole mesh is flipped if most faces disagree."""
    c = v[f].mean(1); n = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    tree = cKDTree(v)
    idx = tree.query_ball_point(c, 0.004)
    lc = np.array([v[i].mean(0) for i in idx])
    agree = np.einsum('ij,ij->i', n, c - lc) > 0
    return f if agree.mean() >= 0.5 else f[:, ::-1].copy()


LIMB = ('arm', 'leg')
# veins re-swept as round tubes (crushed into flat sheets / crumpled by the deformation at the root of the neck)
REROUND = {'male': ('Left_subclavian_vein', 'Right_subclavian_vein'), 'female': ('Right_subclavian_vein', 'Left_subclavian_vein', 'Right_brachiocephalic_vein')}
AORTA_CLEAR = 0.0005      # veins kept this far outside the HRA aorta's outer wall (m)
REVIEW_MAX_MM, REVIEW_ASPECT, REVIEW_SUP_MM, REVIEW_PULSE_MM = 1.0, 2.0, 6.0, 5.0   # review criteria thresholds
REALIGN_ABOVE = CHAIN_TOL + 5.0   # chain junctions whose measured end angle (vessels_measure) exceeds this are turned again
PIN_CHAIN = 0.025                 # push-out fade-in from a chain junction ring: covers the stretch its axis is measured on


def realign(VES, J, log=log):
    """Second turn of the chain junctions, with the end axis exactly as the report measures it (vessels_measure.
    start_frame: the main-trunk centerline from one radius to one radius + 15 mm, after the snap): the first turn is
    computed from the cut mesh's axis from half a radius, and the decay beyond S_RIGID gives back a few degrees, so a
    curved vessel (the female external iliac vein over the pelvic brim) keeps up to 24 degrees. Those above REALIGN_ABOVE
    are turned about their (snapped) end ring centre down to CHAIN_TOL, with the same rigid stretch and decay; every other
    junction of the same part takes part with a null motion, so the blend holds its ring where the first pass put it."""
    from fit import vessels_measure as VM
    J2 = []
    for j in J:
        if j['kind'] != 'chain': continue
        x = VES[j['vessels'][0]]
        c, r, t = VM.start_frame(x['v'], x['f'], j['end']['c'])
        th = G.rotvec_between(t, j['end']['n']); ang = float(np.degrees(np.linalg.norm(th)))
        if ang <= REALIGN_ABOVE: continue
        theta = th * (ang - CHAIN_TOL) / ang
        J2.append(dict(key=j['key'], part=j['part'], p=c, c=c, theta=theta, seeds=j['seeds'], vessels=j['vessels'], l_snap=j.get('l_snap', L_SNAP),
                       realign=True))
        j['info']['realign_deg'] = round(ang - CHAIN_TOL, 1)
        j['info']['rotation_deg'] = round(j['info'].get('rotation_deg', 0.0) + ang - CHAIN_TOL, 1)
        log(f'  realign {j["key"]}: measured end angle {ang:.1f} deg, turned {ang - CHAIN_TOL:.1f} more')
    if J2:
        keys = {j['key'] for j in J2}; parts = {j['part'] for j in J2}
        for j in J:
            if j['key'] in keys or j['part'] not in parts: continue
            c0 = np.asarray(j['c'], float)
            J2.append(dict(key=j['key'] + ':hold', part=j['part'], p=c0, c=c0, theta=np.zeros(3), seeds=j['seeds'], vessels=j['vessels'], realign=True))
        snap(VES, J2, log=log)
    return sorted(keys) if J2 else []


SHEATH_SIGMA, SHEATH_NEAR, SHEATH_FAR = 0.012, 0.015, 0.040


def sheath_companion(sex, VES, J, v_pre, log=log):
    """The femoral artery shares the femoral sheath with the femoral vein: where a femoral vein was snapped onto an HRA
    external iliac vein (J 'companion'), the placed arteries beside it take the vein's snap displacement (Gaussian
    average over the vein's vertices and the fixed HRA stub's, sigma SHEATH_SIGMA, faded out between SHEATH_NEAR and
    SHEATH_FAR from them), so they keep Z-Anatomy's arrangement in the sheath (vein about 1 cm medial to the artery)
    instead of the vein swinging behind its artery. The HRA stub's own vertices (displacement 0) hold the arteries
    above the inguinal ligament where the pelvic correction put them."""
    out = {}
    for j in J:
        if not j.get('companion'): continue
        vn = j['vessels'][0]
        if vn not in v_pre: continue
        hv = j['hra_mesh'][0]
        src = np.concatenate([v_pre[vn], hv]); D = np.concatenate([VES[vn]['v'] - v_pre[vn], np.zeros_like(hv)])
        tree = cKDTree(src)
        side = np.sign(v_pre[vn][:, 0].mean())
        moved = {}
        for n, x in VES.items():
            if x['part'] != A or not x['placed'] or x.get('dropped'): continue
            if np.sign(x['v'][:, 0].mean()) != side: continue
            d, _ = tree.query(x['v'], distance_upper_bound=SHEATH_FAR)
            m = np.isfinite(d)
            if not m.any(): continue
            P = x['v'][m]
            nb = tree.query_ball_point(P, 3 * SHEATH_SIGMA)
            disp = np.zeros_like(P)
            for i, ii in enumerate(nb):
                if not ii: continue
                ii = np.asarray(ii); k = np.exp(-0.5 * (np.linalg.norm(src[ii] - P[i], axis=1) / SHEATH_SIGMA) ** 2)
                disp[i] = (k[:, None] * D[ii]).sum(0) / k.sum()
            fade = 1.0 - G.smoothstep((d[m] - SHEATH_NEAR) / (SHEATH_FAR - SHEATH_NEAR))
            x['v'] = x['v'].copy(); x['v'][m] += disp * fade[:, None]
            mm = float(np.linalg.norm(disp * fade[:, None], axis=1).max() * 1000)
            if mm > 0.05: moved[n] = round(mm, 1)
        out[j['key']] = moved
        log(f'  sheath companion {j["key"]}: arteries moved (max mm) {moved}')
    return out


def pin_weights(VES, trees, J=()):
    """0 at the junction rings, 1 beyond PIN of geodesic distance (the push-out leaves the snapped junctions alone);
    from a chain junction's ring the fade-in runs over PIN_CHAIN, past the stretch its end axis is measured on."""
    from fit.vessels_fix import PIN
    out = {}
    for part, (S, dmin) in trees.items():
        w = G.smoothstep(np.where(np.isfinite(dmin), dmin, 1.0) / PIN)
        for j in J:
            if j['kind'] == 'chain' and j['part'] == part and len(j.get('geo', ())) == len(w):
                g = j['geo']; w = np.minimum(w, G.smoothstep(np.where(np.isfinite(g), g, 1.0) / j.get('pin', PIN_CHAIN)))
        for nm, x in S.split(w).items(): out[nm] = x
    return out


def push_out(sex, VES, trees, contacts, J=(), log=log, aorta_obstacles=None):
    """Bones and skin push-out (fit/vessels_fix.py). Vessels that meet at an end ring in Z-Anatomy (`contacts`) form one
    group, so a push spreads across their junction and the tree stays connected; arteries and veins never share a
    group. `aorta_obstacles` [(obstacle, clearance)] apply to the veins only (the HRA thoracic aorta as a capped tube)."""
    from fit.vessels_fix import Fixer
    from scipy.sparse.csgraph import connected_components
    from scipy import sparse
    names = [n for n, x in VES.items() if x['placed'] and not x.get('dropped')]
    ix = {n: i for i, n in enumerate(names)}
    e = [(ix[a], ix[b]) for a, _, b, _ in contacts if a in ix and b in ix and VES[a]['part'] == VES[b]['part']]
    Adj = sparse.coo_matrix((np.ones(len(e)), ([i for i, _ in e], [j for _, j in e])), shape=(len(names), len(names)))
    _, comp = connected_components(Adj, directed=False)
    pins = pin_weights(VES, trees, J)
    X = np.concatenate([VES[n]['v'] for n in names])
    offs = np.cumsum([0] + [len(VES[n]['v']) for n in names])[:-1]
    Fc = np.concatenate([VES[n]['f'] + o for n, o in zip(names, offs)])
    groups = np.concatenate([np.full(len(VES[n]['v']), comp[i]) for i, n in enumerate(names)])
    pin = np.concatenate([pins.get(n, np.ones(len(VES[n]['v']))) for n in names])
    F = Fixer(sex, X, log=log)
    veins = np.concatenate([np.full(len(VES[n]['v']), VES[n]['part'] == V) for n in names])
    extra = [(ob, veins, clr) for ob, clr in (aorta_obstacles or [])]
    X2, hist = F.run(X, groups, pin, log=log, faces=Fc, extra=extra)
    o = 0
    for n in names:
        k = len(VES[n]['v']); d = np.linalg.norm(X2[o:o + k] - VES[n]['v'], axis=1)
        VES[n]['push_mm'] = float(d.max() * 1000); VES[n]['v'] = X2[o:o + k]; o += k
    return F, hist


def qa(sex, VES, J, out_dir, log=log):
    from lib.qa import render_views
    from fit.common import skin
    S = source(f'hra-{sex}'); P = 'VH_M_' if sex == 'male' else 'VH_F_'
    import json as _json
    parts = _json.load(open(os.path.join(FIT, '..', 'parts', sex, 'structures.json')))
    hra_items = []
    for part, col in (('arteries', '#7a1010'), ('veins', '#14246e'), ('coronary', '#7a1010'), ('cardiac_veins', '#14246e'), ('hepatic_artery', '#7a1010'),
                      ('hepatic_veins', '#14246e'), ('portal_vein', '#14246e')):
        for o in parts.get(part, []):
            if o.get('source', 'HRA') != 'HRA': continue
            try: hra_items.append(dict(mesh=S.get(o['name']), color=col))
            except KeyError: pass
    placed = [dict(mesh=(x['v'], x['f']), color='#ff6a3d' if x['part'] == A else '#3ccfff') for n, x in VES.items() if x['placed'] and not x.get('dropped')]
    sk = dict(mesh=skin(sex), color='#e9c3a6', opacity=0.12)
    files = render_views([sk] + hra_items + placed, {'body_front': dict(dir=(0, 0.02, 1)), 'body_back': dict(dir=(0, 0.02, -1))},
                         os.path.join(out_dir, 'qa'), size=(700, 1100))
    # close-ups: bones ghosted
    from fit.vessels_fix import bone_meshes
    bm = bone_meshes(sex)
    def near_bones(c, r):
        return [dict(mesh=m, color='#ddd6c4', opacity=0.28) for n, m in bm if np.linalg.norm(m[0] - c, axis=1).min() < r]
    def ring_c(n, which):
        x = VES[n]; L = loops_of(x['v'], x['f'])
        l = (max if which == 'top' else min)(L, key=lambda l: l['c'][1]); return l['c']
    cams = {}
    neck = np.mean([j['c'] for j in J if j['key'] in ('left_subclavian', 'right_common_carotid', 'brachiocephalic_bifurcation', 'left_venous_angle',
                                                        'svc_right_brachiocephalic', 'right_internal_jugular')], 0)
    cams['neck'] = (neck + [0, 0.02, 0], 0.09, (0, 0.05, 1))
    cams['shoulder'] = (ring_c('Axillary_arteryl', 'top'), 0.09, (0.2, 0.1, 1))
    groin = ring_c('Femoral_arteryl', 'top')
    cams['groin'] = (groin + [-0.01, -0.02, 0], 0.08, (0.15, 0.05, 1))
    cams['elbow'] = (ring_c('Brachial_arteryl', 'bottom'), 0.07, (0.1, 0.05, 1))
    knee = VES['Popliteal_arteryl']['v'].mean(0)
    cams['knee'] = (knee, 0.09, (0.1, 0.05, -1))
    for k, (c, r, d) in cams.items():
        files += render_views(near_bones(c, 1.6 * r) + [sk] + hra_items + placed, {k: dict(dir=d, target=c, radius=r)}, os.path.join(out_dir, 'qa'), size=(800, 800))
    log(sex, 'QA renders:', len(files))
    return files


def run(sex, stage='all', render=True):
    from fit import vessels_measure as VM
    t0 = time.time()
    M = Mapper(sex)
    VES = load_vessels(sex, M)
    log(sex, 'mapped', len(VES), 'vessels', f'{time.time() - t0:.0f}s')
    placed0 = [n for n, x in VES.items() if x['placed']]
    contacts = VM.zaza_contacts(VES, placed0)
    pel = pelvic_correction(sex, VES)
    J = setup_junctions(sex, VES)
    for j in J: log('  junction', j['key'], json.dumps({k: j['info'][k] for k in j['info'] if k not in ('candidates',)}))
    v_pre = {n: x['v'].copy() for n, x in VES.items() if x['placed'] and not x.get('dropped')}
    trees = snap(VES, J)
    realigned = realign(VES, J)
    sheath = sheath_companion(sex, VES, J, v_pre)
    for n, v0 in v_pre.items(): VES[n]['snap_mm'] = float(np.linalg.norm(VES[n]['v'] - v0, axis=1).max() * 1000)
    log(sex, 'snapped', f'{time.time() - t0:.0f}s')
    # ---- review fixes: calibres, crushed veins, superficial layer (fit/vessels_review.py)
    from fit import vessels_review as RV
    from fit.common import skin as _skin, skin_solid
    aorta, aorta_info = RV.hra_aorta_tube(sex)
    sv_, sf_ = _skin(sex); SK = G.SkinField(sv_, sf_, skin_solid(sex))
    review = dict(aorta_tube=aorta_info)
    review['neck_calibres'] = RV.neck_calibres(sex, VES, log=log)
    review['radius_blend'] = RV.junction_radius_blend(VES, J, log=log)
    review['pelvic_calibres'] = RV.pelvic_calibres(sex, VES, J, aorta, log=log)
    review['reround'] = RV.reround(VES, REROUND.get(sex, ()), J, log=log)
    review['superficial'] = RV.superficial_layer(sex, VES, SK, log=log)
    review['radial_pulse'] = RV.radial_pulse(sex, VES, SK, log=log)
    F, hist = push_out(sex, VES, trees, contacts, J, aorta_obstacles=[(aorta, AORTA_CLEAR)])
    log(sex, 'pushed out', f'{time.time() - t0:.0f}s')
    # the push-out squeezes a vein that has no room between the clavicle, the first rib and the lung apex into a flat
    # sheet: those veins are re-rounded about the pushed centreline (their residual contacts are reported)
    review['reround_after_push'] = RV.reround(VES, REROUND.get(sex, ()), J, log=log)
    review['bridges'] = RV.bridges(sex, VES, log=log)
    review['bridges_push_out'] = RV.settle_bridges(F, VES, list(review['bridges']), log=log)
    # ---- measurements
    names = [n for n, x in VES.items() if x['placed'] and not x.get('dropped')]
    jr = VM.junctions(J, VES)
    bone = VM.bones(VES, names, F.bones)
    limb = [n for n in names if VES[n]['region'] in LIMB]
    skin_rows = VM.skin_check(VES, names, F.skin)
    rep = dict(sex=sex, group=GROUP, method=__doc__.split('Method (per body):')[1].strip() if 'Method (per body):' in __doc__ else '',
               thresholds=dict(junction_gap_mm=VM.GAP_MAX * 1000, junction_angle_deg=VM.ANGLE_MAX, bone_penetration_mm=VM.BONE_MAX * 1000,
                               limb_vessels_outside_skin_mm=0.0, snap_falloff_cm=L_SNAP * 100),
               junctions=jr, realigned=realigned, pelvic_companion_correction=pel, sheath_companion=sheath)
    rep['bone_penetration'] = dict(per_vessel=bone, worst_mm=max(b['max_depth_mm'] for b in bone.values()),
                                   failing=[n for n, b in bone.items() if not b['pass_']],
                                   hra_stub_conflicts=VM.stub_conflicts(VES, J, bone, F.bones))
    rep['skin'] = dict(limb=dict(per_vessel={n: skin_rows[n] for n in limb}, failing=[n for n in limb if not skin_rows[n]['pass_']]),
                       all_outside=[n for n in names if not skin_rows[n]['pass_']])
    org = VM.organs(VES, names, F.organs)
    rep['organ_penetration'] = dict(note='informative; push-out clearance 0.3 mm from lungs, heart, airway, bronchi, liver, spleen, kidneys, bladder, '
                                         'thymus, esophagus, stomach, thyroid (not the brain parcels, diaphragm or intestines)',
                                    over_0_5mm={n: r for n, r in org.items() if r['max_depth_mm'] > 0.5})
    rep['femoral_vein_medial'] = {s: VM.femoral(VES, sex, s) for s in 'lr'}
    rep['brachial_medial_to_humerus'] = {s: VM.brachial(VES, sex, s) for s in 'lr'}
    rep['vertebral_foramina'] = {s: VM.foramina(VES, sex, s, F.bones) for s in 'lr'}
    rep['za_continuity'] = VM.zaza(VES, contacts)
    rep['placed'] = [dict(name=VES[n]['name'], za=n, part=VES[n]['part'], cut=bool(VES[n].get('cut')), snap_mm=round(VES[n].get('snap_mm', 0.0), 1),
                          push_mm=round(VES[n].get('push_mm', 0.0), 1)) for n in names]
    rep['not_placed'] = dict(reference_only=[n for n, x in VES.items() if not x['placed']],
                             covered_by_hra=[n for n, x in VES.items() if x['placed'] and x.get('dropped')])
    rep['push_out'] = hist[-1] if hist else None
    crit = []
    for r in jr:
        crit.append(dict(criterion=f"junction {r['key']} gap", value_mm=r['gap_mm'], threshold_mm=VM.GAP_MAX * 1000, pass_=r['pass_gap']))
        if r['pass_angle'] is not None:
            crit.append(dict(criterion=f"junction {r['key']} angle", value_deg=r['angle_deg'], threshold_deg=VM.ANGLE_MAX, pass_=r['pass_angle']))
    crit.append(dict(criterion='vessel-bone penetration (worst)', value_mm=rep['bone_penetration']['worst_mm'], threshold_mm=VM.BONE_MAX * 1000,
                     pass_=not rep['bone_penetration']['failing']))
    crit.append(dict(criterion='limb vessels inside the skin', value=f"{len(limb) - len(rep['skin']['limb']['failing'])}/{len(limb)}",
                     pass_=not rep['skin']['limb']['failing']))
    for s_ in 'lr':
        fm = rep['femoral_vein_medial'][s_]; bm = rep['brachial_medial_to_humerus'][s_]; vf = rep['vertebral_foramina'][s_]
        if fm: crit.append(dict(criterion=f'femoral vein medial to femoral artery ({s_})', value_mm=fm['min_offset_mm'], pass_=fm['pass_']))
        if bm and 'min_offset_mm' in bm: crit.append(dict(criterion=f'brachial artery medial to humerus shaft ({s_})', value_mm=bm['min_offset_mm'], pass_=bm['pass_']))
        if vf: crit.append(dict(criterion=f'vertebral artery through C6-C1 foramina ({s_})', pass_=vf['pass_']))
    # ---- review measurements (fit/vessels_review.measure)
    lungs = G.Obstacles(RV.lung_meshes(sex))
    rm = RV.measure(sex, VES, names, lungs, aorta, SK)
    review['measured'] = rm
    rep['review'] = review
    crit.append(dict(criterion='vessels inside the lung lobes (deepest)', value_mm=rm['lungs']['worst_mm'], threshold_mm=REVIEW_MAX_MM,
                     pass_=rm['lungs']['worst_mm'] <= REVIEW_MAX_MM))
    crit.append(dict(criterion='veins inside the HRA thoracic aorta (deepest)', value_mm=rm['aorta_veins']['worst_mm'], threshold_mm=REVIEW_MAX_MM,
                     pass_=rm['aorta_veins']['worst_mm'] <= REVIEW_MAX_MM))
    for n in REROUND.get(sex, ()):
        r = rm['vein_sections'].get(n)
        if r: crit.append(dict(criterion=f'{n} round (p90 section aspect)', value=r['p90_aspect'], threshold=REVIEW_ASPECT, pass_=r['p90_aspect'] <= REVIEW_ASPECT))
    for n, r in rm['superficial_depth'].items():
        if n.startswith(('Cephalic', 'Basilic', 'Median_cubital', 'Great_saphenous')):
            crit.append(dict(criterion=f'{n} wall depth under the skin (median)', value_mm=r['median_mm'], threshold_mm=REVIEW_SUP_MM, pass_=r['median_mm'] <= REVIEW_SUP_MM))
        if 'pulse_zone_median_mm' in r:
            crit.append(dict(criterion=f'{n} wall depth at the pulse (median over 5 cm)', value_mm=r['pulse_zone_median_mm'], threshold_mm=REVIEW_PULSE_MM,
                             pass_=r['pulse_zone_median_mm'] <= REVIEW_PULSE_MM))
    rep['criteria'] = crit
    rep['all_pass'] = all(c['pass_'] for c in crit)
    # ---- outputs
    outs = []
    for n in names:
        x = VES[n]
        outs.append(dict(name=x['name'], part=x['part'], mesh=(x['v'], orient(x['v'], x['f'])), source=x.get('source', [n])))
    d = os.path.join(FIT, sex, GROUP)
    for fn in os.listdir(d) if os.path.isdir(d) else []:
        if fn.endswith('.npz'): os.remove(os.path.join(d, fn))
    write_group(sex, GROUP, outs, rep)
    log(sex, 'written', len(outs), 'vessels;', sum(c['pass_'] for c in crit), '/', len(crit), 'criteria pass', f'{time.time() - t0:.0f}s')
    if render:
        rep['qa'] = [os.path.basename(f) for f in qa(sex, VES, J, d)]
        json.dump(rep, open(os.path.join(d, 'report.json'), 'w'), indent=1)
    return VES, J, rep


if __name__ == '__main__':
    args = sys.argv[1:]
    which = [a for a in args if not a.startswith('--')]
    for sex in (['male', 'female'] if not which or which[0] == 'all' else which):
        run(sex, render='--no-render' not in args)
