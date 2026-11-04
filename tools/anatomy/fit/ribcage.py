"""Ribs 1-12, costal cartilages 1-10, sternum (manubrium, body, xiphoid process) and intervertebral discs (C2/C3 to the
lumbosacral disc) for each HRA body.   Usage: python3 fit/ribcage.py [male|female|all] [--rebuild]

Group 'ribcage' (the contract's 'thorax'). Parts: ribs and sternum -> skel_thorax, costal cartilages ->
costal_cartilage, discs -> discs.

Pipeline (each stage cached under .cache/fit/<sex>/ribcage/cache/; --rebuild recomputes the fit stages):
  0. Z-Anatomy structures through the cached trunk warp (fit.common.get_warp(sex, 'trunk')), which already gives a
     coherent rib cage at ~1 mm on the vertebrae and 2-6 mm on the organs (ribcage_data.warped)
  1. ribs: articular facets from Z-Anatomy contacts; rigid seating of head and tubercle on the HRA vertebrae (rib 10's
     head on T10 alone); smooth centreline bending to clear lungs and organs and stay inside the skin (ribcage_ribs)
  2. sternum: the manubrium stays where the warp puts it (the arms fit seats the clavicles there) unless a criterion
     forces it; the body and xiphoid turn about their joints and move only as needed to clear heart, lungs and liver
  3. costal cartilages: the joints follow the bones they join (harmonic interpolation of the rib-end and sternum or
     upper-cartilage motions over each cartilage), then the same centreline bending clears lungs, heart and liver
  4. discs from the HRA end plates (ribcage_discs)
  5. acceptance measurements (ribcage_measure), report.json, manifest, QA renders
"""
import os, sys, json, time
import numpy as np
from scipy import sparse
from scipy.sparse.linalg import spsolve
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation
from scipy import optimize

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import merge, dense_points, sample_surface  # noqa: E402
from fit.common import write_group  # noqa: E402
from fit.ribcage_data import warped, targets, cache_dir, out_dir, log, ORD  # noqa: E402
from fit import ribcage_ribs as RB  # noqa: E402
from fit import ribcage_discs as DS  # noqa: E402
from fit import ribcage_measure as M  # noqa: E402
from fit.ribcage_data import Part  # noqa: E402
from lib.register import umeyama  # noqa: E402

GROUP = 'ribcage'
SIDE_SIGN = {'l': 1.0, 'r': -1.0}
RIB_OBSTACLES = [('lungs', RB.LUNG_CLEAR), ('heart', RB.ORGAN_CLEAR), ('liver', RB.ORGAN_CLEAR), ('spleen', RB.ORGAN_CLEAR),
                 ('kidneys', RB.ORGAN_CLEAR), ('aorta', 0.001), ('great_veins', 0.0015)]
CART_OBSTACLES = [('lungs', RB.LUNG_CLEAR), ('heart', 0.002), ('liver', RB.ORGAN_CLEAR), ('great_veins', 0.0015)]
CCJ_TOL = 0.003          # a rib's anterior end is bent toward its costochondral target only as far as it lies beyond this
CCJ_WEIGHT = 300.0       # weight (per mm^2) of that pull in the bending QP: below the clearances, above the smoothness
RIB_END_HALF = 0.005     # half the thickness of a rib's anterior end (m)
CCJ_MAX = 0.05           # the bend moves a rib's end at most this far toward its target; its cartilage takes up the rest
STERNUM_CLEAR = dict(heart=0.0035, lungs=0.0005, liver=0.0015, skin=0.004)


# ------------------------------------------------------------------------------------------------ body scale
def warp_scale(sex):
    """The trunk warp's global similarity scale (Z-Anatomy -> HRA body): the size every placed bone keeps (the arms
    group scales the clavicles and scapulae by the same number)."""
    from fit.common import FIT
    return float(np.load(os.path.join(FIT, sex, 'warp-trunk.npz'))['s'])


# ------------------------------------------------------------------------------------------------ stage 1: ribs
def rib_geoms(sex, ZA):
    """RibGeom per (n, side), from Z-Anatomy space (the same for both bodies; cached)."""
    path = os.path.join(cache_dir(sex), 'ribgeom.npz')
    za_vert = {k[3:]: ZA[k] for k in ZA if k.startswith('za_')}
    if os.path.exists(path):
        d = np.load(path, allow_pickle=True)
        out = {}
        for n in range(1, 13):
            for s in 'lr':
                rg = RB.RibGeom.__new__(RB.RibGeom)
                st = d[f'{n}{s}'].item()
                rg.__dict__.update(st); rg.f = ZA[f'rib_{n}_{s}'][1]; rg.v_za = ZA[f'rib_{n}_{s}'][0]
                rg.s_rigid = RB.rigid_end(rg)
                out[(n, s)] = rg
        return out
    out = {(n, s): RB.RibGeom(n, s, ZA[f'rib_{n}_{s}'][0], ZA[f'rib_{n}_{s}'][1], za_vert) for n in range(1, 13) for s in 'lr'}
    keep = ('n', 'side', 'facets', 'cl', 'cl_s', 's', 'length', 's_tub', 's_head', 's_rigid', 'end')
    np.savez(path, **{f'{k[0]}{k[1]}': np.array({a: getattr(rg, a) for a in keep}, dtype=object) for k, rg in out.items()})
    return out


STRETCH_RANGE = (0.85, 1.20)      # true ribs: length within this factor of the body-scale Z-Anatomy rib


SYM_WEIGHT = 1.0     # mm^2 of cartilage-chord error per (% of left/right rib length difference)^2


def chain_stretch_pair(cands, w_sym=SYM_WEIGHT):
    """Joint choice of the left and right stretch at one level: each side's chain cost plus a bilateral-symmetry
    penalty on the length difference (ribs of one level are nearly equal in length)."""
    (sl, cl), (sr, cr) = cands['l'], cands['r']
    tot = cl[:, None] + cr[None, :] + w_sym * ((sl[:, None] - sr[None, :]) * 100) ** 2
    i, j = np.unravel_index(np.argmin(tot), tot.shape)
    return dict(l=float(sl[i]), r=float(sr[j]))


MIRROR = np.array([-1.0, 1.0, 1.0])


def ccj_targets(sex, places, stretch, RG, C, ZA, st_v, s0, obstacles=()):
    """Where the anterior end of ribs 1-10 belongs (its costochondral junction): one natural cartilage chord (Z-Anatomy's
    distance between the cartilage's two joint patches, at body scale) from the cartilage's other joint - its facet on
    the fitted sternum (ribs 1-7), or its facet on the cartilage above (8-10, the interchondral joints: Z-Anatomy's
    cartilage above carried rigidly to its own target) - in the direction the two sides agree on: the mean of the left
    rib's direction and the mirrored right one (about the sternum's midline), each read off the warped course.
    The trunk warp alone compresses some courses (female right ribs 1-3 to 0.66-0.72 of their length, left 8-10 short):
    the ribs there ended 2-4 cm from their partners and the cartilages stretched to 1.3-2.3x their other side.
    Returns ({(n, side): dict(T=target, q=anchor, R=cartilage rotation)}, info)."""
    st_keys = ['manubrium', 'sternum_body', 'xiphoid']
    Rst = {k: umeyama(s0 * ZA[k][0], st_v[k], scale=False).R for k in st_keys}
    out, info = {}, {}
    for n in range(1, 11):
        q, chord, u, tip, Rloc, dza = {}, {}, {}, {}, {}, {}
        for s in 'lr':
            e = C[(n, s)]; cz = ZA[f'cart_{n}_{s}'][0]
            if n <= 7:
                q[s] = np.concatenate([st_v[k][e['sternum_nn'][e['sternum_piece'] == pi]] for pi, k in enumerate(st_keys)]).mean(0)
                other = cz[e['sternum']].mean(0)
                Rloc[s] = Rst[st_keys[int(np.bincount(e['sternum_piece']).argmax())]]
            else:
                up = out[(n - 1, s)]; cp = ZA[f'cart_{n - 1}_{s}'][0]; ep = C[(n - 1, s)]
                q[s] = up['T'] + s0 * up['R'] @ (cp[e['above_nn']].mean(0) - cp[ep['rib']].mean(0))
                other = cz[e['above']].mean(0)
                Rloc[s] = up['R']
            dza[s] = cz[e['rib']].mean(0) - other
            chord[s] = s0 * float(np.linalg.norm(dza[s]))
            v, _ = places[(n, s)](stretch[(n, s)])
            tip[s] = v[np.unique(e['rib_nn'])].mean(0)
            u[s] = (tip[s] - q[s]) / np.linalg.norm(tip[s] - q[s])
        # each side's direction counts by how well its warped rib already closes the chain at the natural cartilage
        # length (inverse variance, 5% floor): a side whose warped course is compressed or overshoots counts little
        wt = {s: 1.0 / (0.05 ** 2 + (np.linalg.norm(tip[s] - q[s]) / chord[s] - 1) ** 2) for s in 'lr'}
        us = wt['l'] * u['l'] + wt['r'] * MIRROR * u['r']; us /= np.linalg.norm(us)
        for s, uu in (('l', us), ('r', MIRROR * us)):
            Tt = q[s] + chord[s] * uu
            # a target must be a place a rib end can occupy: half a rib's thickness plus its clearance outside the
            # liver, heart and lungs (the liver displaces the right costal margin; mirroring alone ignores that)
            for _ in range(4):
                moved = False
                for tg, cl in obstacles:
                    d = float(tg.sdf(Tt[None])[0]); need = RIB_END_HALF + cl
                    if d < need:
                        g = tg.field.grad(Tt[None])[0]; Tt = Tt + (need - d) * g / max(np.linalg.norm(g), 1e-9); moved = True
                if not moved: break
            R = RB_rotation_between(Rloc[s] @ dza[s], Tt - q[s]) @ Rloc[s]      # the cartilage's own turn, for the level below
            out[(n, s)] = dict(T=Tt, q=q[s], R=R)
            info[f'{n}{s}'] = dict(anchor='sternum' if n <= 7 else f'cartilage {n - 1}', chord_mm=mm1(chord[s]),
                                   warped_tip_to_anchor_mm=mm1(np.linalg.norm(tip[s] - q[s])), warped_tip_to_target_mm=mm1(np.linalg.norm(tip[s] - Tt)),
                                   direction_weight=round(wt[s] / (wt['l'] + wt['r']), 3),
                                   direction_left_vs_mirrored_right_deg=round(float(np.degrees(np.arccos(np.clip(u['l'] @ (MIRROR * u['r']), -1, 1)))), 1))
    return out, info


def RB_rotation_between(a, b):
    from lib.register import rotation_between
    return rotation_between(a, b)


NECK_TURN_MAX = 15.0     # deg: the rib's turn about its neck axis (the costovertebral axis through head and tubercle)
NECK_TURN_COST = 1.0     # mm^2 of end-to-target error per deg^2 of that turn


def neck_axis(rg, v):
    """The rib's axis of motion: through the head (centre of its articular facets) and the tubercle."""
    head = np.concatenate([rg.facets[k][0] for k in ('head_lo', 'head_up') if k in rg.facets])
    c = v[head].mean(0)
    t = v[rg.facets['tub'][0]].mean(0) if 'tub' in rg.facets else v[(rg.s > rg.s_head + 0.015) & (rg.s < rg.s_head + 0.03)].mean(0)
    ax = t - c
    return c, ax / np.linalg.norm(ax)


def turn(p, c, ax, th):
    r = np.atleast_2d(p) - c
    return c + r * np.cos(th) + np.cross(ax, r) * np.sin(th) + np.outer(r @ ax, ax) * (1 - np.cos(th))


def target_stretch(place, rg, tip_idx, Tt, default, lo=STRETCH_RANGE[0], hi=STRETCH_RANGE[1]):
    """The two degrees of freedom a rib has between its joints and its costochondral target: its length (the stretch
    of the body-scale Z-Anatomy rib along the warped course) and its turn about the neck axis (pump/bucket handle).
    Returns (stretches, cost per stretch, best turn per stretch): the anterior end to the target (mm^2), plus weak
    pulls toward the warp's own course length and no turn."""
    sts = np.arange(lo, hi + 1e-9, 0.01); ths = np.radians(np.arange(-NECK_TURN_MAX, NECK_TURN_MAX + 1e-6, 0.5))
    costs, best = [], []
    for st in sts:
        v, _ = place(st)
        c, ax = neck_axis(rg, v)
        p0 = v[tip_idx].mean(0)
        Q = np.array([turn(p0, c, ax, th)[0] for th in ths])
        k =(np.linalg.norm(Q - Tt, axis=1) * 1000) ** 2 + NECK_TURN_COST * np.degrees(ths) ** 2
        j = int(np.argmin(k))
        costs.append(k[j] + 0.25 * ((st - default) * 100) ** 2); best.append(float(ths[j]))
    return sts, np.array(costs), np.array(best)


def fit_ribs(sex, W, ZA, RG, T, verts, overlap, C=None, st_v=None):
    out, info = {}, {}
    obstacles = [(T[k], c) for k, c in RIB_OBSTACLES if k in T]
    radial = RB.Radial(T['lungs'])
    s0 = warp_scale(sex)
    # the Z-Anatomy rib at body scale along the warped rib's course (the warp alone stretches ribs 0.7-1.5x); ribs 1-10
    # are sized to bring their anterior end to its costochondral target (both sides of a level together, nearly
    # symmetric) and then bent smoothly the rest of the way; ribs 11 and 12 follow the warp within 10%
    places, stretch, chain = {}, {}, {}
    for key, rg in RG.items():
        places[key], stretch[key] = RB.sweep(rg, ZA[f'rib_{key[0]}_{key[1]}'][0], W[f'rib_{key[0]}_{key[1]}'][0], s0, prepared=True)
    tgt, tinfo, neck = {}, {}, {}
    if C is not None and st_v is not None:
        tgt, tinfo = ccj_targets(sex, places, stretch, RG, C, ZA, st_v, s0, obstacles=[(T[k], c) for k, c in RIB_OBSTACLES if k in ('liver', 'heart', 'lungs')])
        for n in range(1, 11):
            full = {s: target_stretch(places[(n, s)], RG[(n, s)], np.unique(C[(n, s)]['rib_nn']), tgt[(n, s)]['T'], stretch[(n, s)]) for s in 'lr'}
            pick = chain_stretch_pair({s: full[s][:2] for s in 'lr'})
            for s in 'lr':
                stretch[(n, s)] = pick[s]
                neck[(n, s)] = float(full[s][2][np.argmin(np.abs(full[s][0] - pick[s]))])
                chain[(n, s)] = dict(ccj_target=tinfo[f'{n}{s}'], neck_turn_deg=round(float(np.degrees(neck[(n, s)])), 1))
    for key, rg in RG.items():
        n, s = key; place = places[key]; st = stretch[key]
        v, i0 = place(st); i0.update(chain.get(key, {}))
        if neck.get(key):
            # the turn is taken only as far as it drives the rib no deeper into an organ, a lung or the skin
            c, ax = neck_axis(rg, v)
            base = clearance_deficit(v, obstacles, T['skin'], RB.conflict_zone(v, s, n, overlap, verts, rg=rg))
            for frac in (1.0, 0.5, 0.25):
                vt = turn(v, c, ax, neck[key] * frac)
                if clearance_deficit(vt, obstacles, T['skin'], RB.conflict_zone(vt, s, n, overlap, verts, rg=rg)) <= base + 0.001:
                    v = vt; i0['neck_turn_deg'] = round(float(np.degrees(neck[key] * frac)), 1); break
            else:
                i0['neck_turn_deg'] = 0.0
        # ribs 11, 12 (no costochondral target): shorten (down to 0.85) while the anterior quarter comes within
        # SKIN_CLEAR + 1.5 mm of the skin; ribs 1-10 are kept inside by the bending below
        tip = rg.s > rg.length * 0.75
        while key not in tgt and -T['skin'].sdf(v[tip]).max() < RB.SKIN_CLEAR + 0.0015 and st > STRETCH_RANGE[0] + 1e-9:
            st = max(STRETCH_RANGE[0], st - 0.01); v, i0b = place(st); i0 = dict(i0, **i0b, shortened_for_skin=True)
        i0['stretch'] = round(st, 3)
        zone = RB.conflict_zone(v, s, n, overlap, verts, rg=rg)
        v1, i1 = RB.seat(rg, v, verts, T['lungs'], skip=zone)
        for _ in range(2):          # far-off facets (warp error at the joint): seat again from where the first pass ended
            if RB.facet_gap(rg, v1, verts) <= 0.0022: break
            v1, i1b = RB.seat(rg, v1, verts, T['lungs'], skip=zone)
            i1 = dict(i1, second_pass=i1b)
        zone = RB.conflict_zone(v1, s, n, overlap, verts, rg=rg)
        basis = RB.rib_basis(rg.s, rg.length, rg.s_rigid + 0.004)
        v2, i2 = RB.bend(v1, basis, obstacles, T['skin'], radial=radial, skip=zone)          # clearances alone
        target = None
        if key in tgt:
            ti = np.unique(C[key]['rib_nn']); tp = v1[ti].mean(0); Tt = tgt[key]['T']
            dT = float(np.linalg.norm(Tt - tp))
            if dT > CCJ_MAX: Tt = tp + (Tt - tp) * (CCJ_MAX / dT)            # the cartilage takes up the rest
            # the end is pulled toward its target only as far as that costs no clearance: a pull that would drive the
            # rib into an organ, a lung (outside the paravertebral segment) or the skin, or bend the shaft far more
            # than the end moves, is halved, then dropped (the cartilage then bridges the difference)
            base = clearance_deficit(v2, obstacles, T['skin'], zone)
            i2 = dict(i2, ccj_pull='none: it would cost clearance')
            for frac in (1.0, 0.5):
                Tf = tp + (Tt - tp) * frac
                vb, ib = RB.bend(v1, basis, obstacles, T['skin'], radial=radial, skip=zone, target=(ti, Tf, CCJ_TOL, CCJ_WEIGHT))
                if clearance_deficit(vb, obstacles, T['skin'], zone) <= base + 0.0005 and ib['max_mm'] <= min(dT, CCJ_MAX) * frac * 1000 + 20:
                    v2, i2 = vb, dict(ib, ccj_pull=frac); target = (ti, Tf); break
        out[key] = v2
        info[f'{n}{s}'] = dict(sweep=i0, seat=i1, bend=i2)
        log(sex, f'rib {n}{s}: stretch {st:.2f}, seat {i1["rot_deg"]:.1f} deg / {i1["shift_mm"]:.1f} mm, bend max {i2["max_mm"]:.1f} mm'
                 + (f', end to target {i2["target_before_mm"]:.1f} -> {i2["target_after_mm"]:.1f} mm (pull {i2["ccj_pull"]})' if target is not None else
                    (f', {i2["ccj_pull"]}' if 'ccj_pull' in i2 else '')))
    return out, info


def clearance_deficit(v, obstacles, skin, zone):
    """Largest shortfall (m) of a rib's clearance from any obstacle (lungs outside the paravertebral zone) or the skin."""
    P = v[::3]; z = zone[::3]; w = 0.0
    for tg, cl in obstacles:
        Q = P[~z] if tg.name == 'lungs' else P
        if len(Q): w = max(w, float(cl - tg.sdf(Q).min()))
    return max(w, float(RB.SKIN_CLEAR + skin.sdf(P).max()))


# ------------------------------------------------------------------------------------------------ Z-Anatomy joint patches
def za_contacts(ZA):
    """Joint patches read off Z-Anatomy (where two structures touch there), as vertex indices, with the matching
    nearest vertex of the partner structure: the same for both bodies."""
    from lib.mesh import source, compact
    st_keys = ['manubrium', 'sternum_body', 'xiphoid']
    trees = {k: cKDTree(ZA[k][0]) for k in ZA}
    dense = {k: cKDTree(dense_points(*ZA[k], 0.0004)) for k in st_keys + [f'rib_{n}_{s}' for n in range(1, 11) for s in 'lr'] + [f'cart_{n}_{s}' for n in range(1, 10) for s in 'lr']}
    out = {}
    for n in range(1, 11):
        for s in 'lr':
            v = ZA[f'cart_{n}_{s}'][0]
            e = {}
            d, _ = dense[f'rib_{n}_{s}'].query(v); e['rib'] = np.flatnonzero(d < 0.001); e['rib_nn'] = trees[f'rib_{n}_{s}'].query(v[e['rib']])[1]
            if n <= 7:
                ds = np.array([dense[k].query(v)[0] for k in st_keys])
                which = ds.argmin(0); dmin = ds.min(0)
                idx = np.flatnonzero(dmin < 0.001)
                e['sternum'] = idx; e['sternum_piece'] = which[idx]
                e['sternum_nn'] = np.array([trees[st_keys[w]].query(v[i])[1] for i, w in zip(idx, which[idx])], dtype=np.int64)
            else:
                d, _ = dense[f'cart_{n - 1}_{s}'].query(v); e['above'] = np.flatnonzero(d < 0.001); e['above_nn'] = trees[f'cart_{n - 1}_{s}'].query(v[e['above']])[1]
            out[(n, s)] = e
    # sternal joints
    st = {}
    d, _ = dense['manubrium'].query(ZA['sternum_body'][0]); st['body_to_manubrium'] = (np.flatnonzero(d < 0.001), d[d < 0.001])
    d, _ = dense['sternum_body'].query(ZA['xiphoid'][0]); st['xiphoid_to_body'] = (np.flatnonzero(d < 0.001), d[d < 0.001])
    # clavicular notches: the manubrium where the Z-Anatomy clavicles articulate
    src = source('za-skeletal')
    notch = []
    for nm in ('Claviclel', 'Clavicler'):
        cv, cf = compact(*src.get(nm))
        d, _ = cKDTree(dense_points(cv, cf, 0.0004)).query(ZA['manubrium'][0])
        notch.append(np.flatnonzero(d < d.min() + 0.003))
    st['notch_l'], st['notch_r'] = notch
    return out, st


# ------------------------------------------------------------------------------------------------ stage 2: sternum
def rigid(x, c):
    R = Rotation.from_rotvec(x[:3]).as_matrix()
    return lambda p: (np.asarray(p) - c) @ R.T + c + x[3:]


def clear_violations(P, T, clear, skin_clear):
    out = {}
    for k, c in clear.items():
        d = T[k].sdf(P)
        out[k] = float(d.min()) if k != 'skin' else float(-d.max())
    return out


def fit_piece(v, T, obstacles, skin_clear, joint=None, centre=None, reg=(3.0, 0.003), fixed_ok=None):
    """Rigid motion of one sternal piece: joint = (patch idx, partner Part, gap targets) keeps it on its partner;
    obstacles [(Target, clearance, weight)]; skin clearance. Returns (transform, x)."""
    sub = np.arange(len(v))[::2]
    c = centre if centre is not None else v.mean(0)

    def resid(x):
        tf = rigid(x, c)
        P = tf(v[sub]); r = []
        for tgt, clear, w in obstacles:
            r.append(w * np.maximum(clear - tgt.sdf(P), 0) / 0.0003 / np.sqrt(len(P)) * 3)
        r.append(np.maximum(T['skin'].sdf(P) + skin_clear, 0) / 0.0003 / np.sqrt(len(P)) * 3)
        if joint is not None:
            idx, part, gap = joint
            d = part.unsigned(tf(v[idx]))
            r.append((d - np.clip(gap, 0, 0.0008)) / 0.0003 / np.sqrt(len(idx)) * 2)
        r.append(x[:3] / np.radians(reg[0])); r.append(x[3:] / reg[1])
        return np.concatenate(r)

    sol = optimize.least_squares(resid, np.zeros(6), x_scale=np.array([0.02] * 3 + [0.002] * 3), max_nfev=300)
    return rigid(sol.x, c), sol.x


MANUBRIUM_MAX_RMS = 0.002       # the arms group's rule (fit/arms_girdle.manubrium_placement), repeated here


def rigid_inv(x, c):
    R = Rotation.from_rotvec(x[:3]).as_matrix()
    return lambda q: (np.asarray(q) - c - x[3:]) @ R + c


def sternum_start(sex, W, ZA):
    """Where the sternum starts, by the rule the arms group uses to seat the clavicles (fit/arms_girdle.py,
    manubrium_placement): the trunk-warped manubrium when a shape-preserving placement at body scale comes within
    2 mm (RMS) of it, otherwise Z-Anatomy's manubrium carried by the rigid motion (at body scale) of the upper
    thoracic spine C7-T7, which the warp fits to ~1 mm. The body and xiphoid are Z-Anatomy's at body scale (the warp
    has no anchor in front of the heart and distorts them: up to 1.5x in length and width): with the warped manubrium
    they take the rigid placement nearest the warped body; otherwise they move with the upper spine like the
    manubrium. Returns ({piece: vertices}, info)."""
    s0 = warp_scale(sex)
    mv = ZA['manubrium'][0]
    S = umeyama(s0 * mv, W['manubrium'][0], scale=False)
    rms = float(np.sqrt(((S(s0 * mv) - W['manubrium'][0]) ** 2).sum(1).mean()))
    if rms <= MANUBRIUM_MAX_RMS:
        Sb = umeyama(s0 * ZA['sternum_body'][0], W['sternum_body'][0], scale=False)
        V = dict(manubrium=W['manubrium'][0].copy(), sternum_body=Sb(s0 * ZA['sternum_body'][0]), xiphoid=Sb(s0 * ZA['xiphoid'][0]))
        how = 'trunk warp (manubrium); body and xiphoid at body scale, rigidly nearest the warped body'
    else:
        ks = ['za_C7'] + [f'za_T{i}' for i in range(1, 8)]
        Gu = umeyama(s0 * np.concatenate([ZA[k][0] for k in ks]), np.concatenate([W[k][0] for k in ks]), scale=False)
        V = {k: Gu(s0 * ZA[k][0]) for k in ('manubrium', 'sternum_body', 'xiphoid')}
        how = 'upper thoracic spine C7-T7 at body scale (the warped manubrium is distorted)'
    return V, dict(rule=how, body_scale=round(s0, 4), manubrium_warp_rigid_rms_mm=mm1(rms))


def fit_sternum(sex, W, ZA, T, ST):
    """The sternum as an articulated chain: manubrium, body (hinged at the manubriosternal joint) and xiphoid
    (hinged at the xiphisternal joint), each a rigid piece of Z-Anatomy's shape at body scale (sternum_start), fitted
    together so that all three clear the heart by 3.5 mm and the lungs and liver by STERNUM_CLEAR, stay 4 mm inside
    the skin, and keep their joints closed at Z-Anatomy's joint gaps. The manubrium stays where the arms group's rule
    puts it (the clavicles are seated there) and moves only as far as a clearance forces it; the clavicular notches'
    displacement is reported."""
    keys = ('manubrium', 'sternum_body', 'xiphoid')
    s0 = warp_scale(sex)
    V, start = sternum_start(sex, W, ZA)
    F = {k: W[k][1] for k in keys}
    cen = {k: V[k].mean(0) for k in keys}
    sub = {k: np.arange(len(V[k]))[::2] for k in keys}
    obst = [(T['heart'], STERNUM_CLEAR['heart']), (T['lungs'], STERNUM_CLEAR['lungs']), (T['liver'], STERNUM_CLEAR['liver'])]
    obst_bx = [(T['heart'], STERNUM_CLEAR['heart']), (T['lungs'], 0.0012), (T['liver'], STERNUM_CLEAR['liver'])]   # body, xiphoid
    soft = [(T['great_veins'], 0.001), (T['aorta'], 0.001)]          # not acceptance criteria: body and xiphoid only
    # joints: the Z-Anatomy contact patch of the lower piece, its gap there, and the partner's facing patch
    pairs = {}
    for a, b, jk in (('sternum_body', 'manubrium', 'body_to_manubrium'), ('xiphoid', 'sternum_body', 'xiphoid_to_body')):
        idx, gap = ST[jk]
        d, _ = cKDTree(ZA[a][0][idx]).query(ZA[b][0]); pidx = np.flatnonzero(d < 0.0015)
        off = s0 * (ZA[a][0][idx].mean(0) - ZA[b][0][pidx].mean(0))
        pairs[a] = (b, idx, np.clip(gap * s0, 0, 0.0008), pidx, off, Part(V[b], F[b]))
    # rotation limits (deg) about the body's transverse (x), vertical (y) and front-back (z) axes, and shift (m): the
    # manubriosternal and xiphisternal joints flex and extend (a hinge about x); the sternum stays in the midline
    # the manubrium is held near its start (the clavicles' notches) but may move the few mm a lung or skin clearance needs
    held = start['rule'].startswith('trunk warp')        # the arms group's clavicles already sit on these notches
    reg = dict(manubrium=((0.5, 0.5, 0.5), 0.0003) if held else ((3.0, 3.0, 3.0), 0.002),
               sternum_body=((12.0, 2.0, 2.0), 0.002), xiphoid=((20.0, 4.0, 4.0), 0.003))

    def tfs(x):
        return {k: rigid(x[6 * i:6 * i + 6], cen[k]) for i, k in enumerate(keys)}

    def resid(x):
        tf = tfs(x); r = []
        for i, k in enumerate(keys):
            P = tf[k](V[k][sub[k]])
            hard = obst if k == 'manubrium' else obst_bx
            for tgt, clear in hard + (soft if k != 'manubrium' else []):
                w = 1.0 if (tgt, clear) in hard else 0.3
                r.append(w * np.maximum(clear - tgt.sdf(P), 0) / 0.0001)
            r.append(np.maximum(T['skin'].sdf(P) + STERNUM_CLEAR['skin'], 0) / 0.0001)
            r.append(x[6 * i:6 * i + 3] / np.radians(np.array(reg[k][0]))); r.append(x[6 * i + 3:6 * i + 6] / reg[k][1])
        for a, (b, idx, gap, pidx, off, part) in pairs.items():
            ib = keys.index(b)
            q = rigid_inv(x[6 * ib:6 * ib + 6], cen[b])(tf[a](V[a][idx]))         # the lower piece's facet, in its partner's frame
            r.append((part.unsigned(q) - gap) / 0.0003 / np.sqrt(len(idx)) * 4)
            # facets centred on each other (no sliding off the joint)
            ca = tf[a](V[a][idx]).mean(0); cb = tf[b](V[b][pidx]).mean(0)
            r.append((ca - cb - off) / 0.002)
        return np.concatenate(r)

    sol = optimize.least_squares(resid, np.zeros(18), x_scale=np.array(([0.02] * 3 + [0.002] * 3) * 3), max_nfev=800)
    tf = tfs(sol.x)
    out = {k: tf[k](V[k]) for k in keys}
    nl, nr = ST['notch_l'], ST['notch_r']
    wm = W['manubrium'][0]
    P = V['manubrium'][::2]
    start_clear = {'heart': float(M.signed(T['heart'], P).min()), 'lungs': float(M.signed(T['lungs'], P).min()),
                   'liver': float(M.signed(T['liver'], P).min()), 'skin': float(-M.signed(T['skin'], P).max())}
    notch = lambda m, i: m[i].mean(0)
    info = dict(start=start, manubrium=dict(
        start_clearances_mm={k: mm1(v) for k, v in start_clear.items()},
        notch_moved_by_fit_mm=dict(left=mm1(np.linalg.norm(out['manubrium'][nl] - V['manubrium'][nl], axis=1).max()),
                                   right=mm1(np.linalg.norm(out['manubrium'][nr] - V['manubrium'][nr], axis=1).max())),
        notch_vs_trunk_warp_mm=dict(left=mm1(np.linalg.norm(notch(out['manubrium'], nl) - notch(wm, nl))),
                                    right=mm1(np.linalg.norm(notch(out['manubrium'], nr) - notch(wm, nr)))),
        notch_centres_mm=dict(left=[mm1(c) for c in notch(out['manubrium'], nl)], right=[mm1(c) for c in notch(out['manubrium'], nr)]),
        rot_deg=round(float(np.degrees(np.linalg.norm(sol.x[:3]))), 2), shift_mm=mm1(np.linalg.norm(sol.x[3:6]))))
    for i, k in enumerate(keys[1:], start=1):
        info[k] = dict(rot_deg=round(float(np.degrees(np.linalg.norm(sol.x[6 * i:6 * i + 3]))), 2), shift_mm=mm1(np.linalg.norm(sol.x[6 * i + 3:6 * i + 6])))
    for a, (b, idx, gap, pidx, off, part) in pairs.items():
        ib = keys.index(b)
        q = rigid_inv(sol.x[6 * ib:6 * ib + 6], cen[b])(tf[a](V[a][idx]))
        info[f'{a}_to_{b}_joint_gap_median_mm'] = mm1(np.median(part.unsigned(q)))
    return out, info


def rib_lengths(RG, ribs_v, s0):
    """Centreline length of each fitted rib against the body-scale Z-Anatomy rib, and left/right ratio per level."""
    out, lens = {}, {}
    for key, rg in RG.items():
        C = RB._slab_centres(ribs_v[key], rg.s, rg.cl_s)
        L = float(np.linalg.norm(np.diff(C, axis=0), axis=1).sum()); lens[key] = L
        out[f'{key[0]}{key[1]}'] = dict(length_mm=mm1(L), ratio_to_body_scale=round(L / (s0 * rg.length), 3))
    lr = {str(n): round(lens[(n, 'l')] / lens[(n, 'r')], 3) for n in range(1, 13)}
    r = np.array([v['ratio_to_body_scale'] for v in out.values()])
    return dict(note='length of the fitted rib along its centreline / Z-Anatomy rib at body scale (the trunk warp alone gives '
                     '0.72-1.54); ribs 1-10 are sized within 0.85-1.20 and turned about their neck axis to bring their anterior end to '
                     'its costochondral target (ccj_targets), then bent smoothly the rest of the way; ribs 11, 12 follow the warp within 0.9-1.1', range=[round(float(r.min()), 3), round(float(r.max()), 3)], left_over_right=lr, per_rib=out)


def mm1(x):
    return round(float(x) * 1000, 2)


# ------------------------------------------------------------------------------------------------ stage 3: cartilages
def laplacian(f, n):
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]); e = np.unique(np.sort(e, axis=1), axis=0)
    W = sparse.coo_matrix((np.ones(2 * len(e)), (np.concatenate([e[:, 0], e[:, 1]]), np.concatenate([e[:, 1], e[:, 0]]))), shape=(n, n)).tocsr()
    deg = np.asarray(W.sum(1)).ravel()
    return (sparse.diags(deg) - W).tocsr()


def harmonic(f, n, fixed_idx, fixed_val):
    """Displacement field over a mesh: prescribed at fixed vertices, harmonic (smooth) elsewhere."""
    L = laplacian(f, n)
    fixed = np.zeros(n, bool); fixed[fixed_idx] = True
    free = np.flatnonzero(~fixed)
    u = np.zeros((n, 3)); u[fixed_idx] = fixed_val
    if len(free):
        A = L[free][:, free].tocsc(); Bm = L[free][:, np.flatnonzero(fixed)]
        rhs = -(Bm @ u[fixed])
        for k in range(3): u[free, k] = spsolve(A, rhs[:, k])
    return u


def fit_cartilages(sex, W, ZA, T, C, ribs_v, st_v):
    """Costal cartilages: Z-Anatomy's shape at body scale, placed by its two joints and bent between them.
    1. the rigid placement (body scale) that best puts both joint patches - the rib end and the sternum (1-7) or the
       cartilage above (8-10) - on their partners as they are now fitted (each patch weighted equally)
    2. a harmonic (smooth) displacement over the cartilage, prescribed at both patches, closes the two joints exactly
       at Z-Anatomy's joint gaps (the cartilage lengthens or shortens smoothly between them)
    3. the centreline bending of the ribs, windowed to vanish over both joint patches, clears lungs, heart and liver
    The trunk warp alone distorts the cartilages 0.6-1.4x in length and to half their thickness, and on the female's
    right side carries their sternal ends up to 11 cm from the midline."""
    out, info = {}, {}
    s0 = warp_scale(sex)
    st_keys = ['manubrium', 'sternum_body', 'xiphoid']
    obstacles = [(T[k], c) for k, c in CART_OBSTACLES]
    for n in range(1, 11):
        for s in 'lr':
            key = (n, s); vz = ZA[f'cart_{n}_{s}'][0]; f = W[f'cart_{n}_{s}'][1]; e = C[key]
            # joint patches: (cartilage vertex idx, partner's current vertices at the Z-Anatomy nearest vertex, Z-Anatomy offset)
            pats = [(e['rib'], ribs_v[key][e['rib_nn']], vz[e['rib']] - ZA[f'rib_{n}_{s}'][0][e['rib_nn']])]
            if n <= 7:
                for pi, k in enumerate(st_keys):
                    m = e['sternum_piece'] == pi
                    if m.any():
                        nn = e['sternum_nn'][m]
                        pats.append((e['sternum'][m], st_v[k][nn], vz[e['sternum'][m]] - ZA[k][0][nn]))
            else:
                nn = e['above_nn']
                pats.append((e['above'], out[(n - 1, s)][nn], vz[e['above']] - ZA[f'cart_{n - 1}_{s}'][0][nn]))
            src = np.concatenate([s0 * vz[i] for i, _, _ in pats]); dst = np.concatenate([q for _, q, _ in pats])
            w = np.concatenate([np.full(len(i), 1.0 / len(i)) for i, _, _ in pats])
            S = umeyama(src, dst, scale=False, w=w)
            v0 = S(s0 * vz)
            R = S.R
            idx = np.concatenate([i for i, _, _ in pats])
            tgt = np.concatenate([q + s0 * o @ R.T for _, q, o in pats])
            idx, first = np.unique(idx, return_index=True); tgt = tgt[first]
            u = harmonic(f, len(vz), idx, tgt - v0[idx])
            vh = v0 + u
            # bend between the two joints to clear lungs, heart and liver
            sarc, _, _ = RB.arc_length(vh, f, e['rib'])
            far = e['sternum'] if n <= 7 else e['above']
            Bf = RB.bar_basis(sarc, sarc.max(), spacing=0.012, end=0.006, s0=float(sarc[e['rib']].max()), s1=float(sarc[far].min()))
            vb, ib = RB.bend(vh, Bf, obstacles, T['skin'], sub=1)
            out[key] = vb
            # length change against Z-Anatomy at body scale (along the arc from the rib joint)
            sz, _, _ = RB.arc_length(s0 * vz, f, e['rib'])
            info[f'{n}{s}'] = dict(joint_closing_max_mm=mm1(np.linalg.norm(tgt - v0[idx], axis=1).max()), bend_max_mm=round(ib['max_mm'], 2),
                                   length_ratio=round(float(sarc.max() / max(sz.max(), 1e-9)), 3))
    return out, info


# ------------------------------------------------------------------------------------------------ stage 4: discs
def fit_discs(sex, verts):
    from fit.ribcage_data import _hra_entries, _load_entries
    lv = DS.levels(verts.keys())
    cord = merge(_load_entries(sex, _hra_entries(sex, r'spinal_cord')))[0]      # locates the canal behind each disc
    out, info = {}, {}
    for name, a, b in lv:
        r = DS.build_disc(verts[a], verts[b], cord=cord)
        if r is None:
            log(sex, f'{name}: no disc space found'); continue
        mesh, top, bot, inf = r
        out[name] = (mesh, top, bot); info[name] = inf
    return out, info, lv


# ------------------------------------------------------------------------------------------------ QA
def qa(sex, outputs, T, verts, out):
    from lib.qa import render_views
    from fit.ribcage_data import _hra_entries, _load_entries
    lung_patches = merge(_load_entries(sex, _hra_entries(sex, r'_lungs?_?[LR]?/.*(segme|hilum)')))
    items = [dict(mesh=merge([verts[k].mesh for k in verts]), color='#cdbfa6')]
    col = dict(skel_thorax='#f3ead2', costal_cartilage='#8fc3dd', discs='#3f8fd0')
    for o in outputs: items.append(dict(mesh=o['mesh'], color=col[o['part']]))
    items += [dict(mesh=lung_patches, color='#e8a0a0', opacity=0.22), dict(mesh=T['heart'].mesh, color='#c0392b', opacity=0.35),
              dict(mesh=T['liver'].mesh, color='#8e5b3a', opacity=0.25)]
    allv = np.concatenate([o['mesh'][0] for o in outputs if o['part'] != 'discs'])
    c = 0.5 * (allv.min(0) + allv.max(0)); r = float(np.linalg.norm(allv.max(0) - allv.min(0)) / 2) * 0.78
    cams = dict(front=dict(dir=(0, 0.02, 1), target=c, radius=r), back=dict(dir=(0, 0.02, -1), target=c, radius=r),
                left=dict(dir=(1, 0.02, 0), target=c, radius=r), oblique=dict(dir=(0.62, 0.3, 0.72), target=c, radius=r))
    files = render_views(items, cams, os.path.join(out, 'qa'))
    # close-ups: costovertebral joints from behind-left, and the whole spine's discs from the left
    bones = [it for it in items[:1 + len(outputs)]]
    tv = verts['T6'].mesh[0].mean(0)
    files += render_views(bones, dict(joints=dict(dir=(0.55, 0.1, -0.83), target=tv, radius=0.11)), os.path.join(out, 'qa'))
    sp = merge([verts[k].mesh for k in verts])
    spc = 0.5 * (sp[0].min(0) + sp[0].max(0))
    disc_items = [dict(mesh=sp, color='#cdbfa6', opacity=0.55)] + [dict(mesh=o['mesh'], color='#3f8fd0') for o in outputs if o['part'] == 'discs']
    files += render_views(disc_items, dict(spine=dict(dir=(1, 0.02, 0.15), target=spc, radius=float(np.ptp(sp[0][:, 1])) * 0.55)), os.path.join(out, 'qa'), size=(700, 1000))
    return files


# ------------------------------------------------------------------------------------------------ main
def fit(sex, rebuild=False, render=True):
    t0 = time.time()
    W, ZA = warped(sex)
    T = targets(sex)
    verts = {k[2:]: t for k, t in T.items() if k.startswith('V:')}
    RG = rib_geoms(sex, ZA)
    C, ST = za_contacts(ZA)
    cd = cache_dir(sex)
    from fit.ribcage_data import spine_lung_overlap, cord_points
    overlap = spine_lung_overlap(sex, T)
    log(sex, 'HRA lung overlaps HRA vertebrae:', {f'{k[0]}{k[1]}': round(v * 1000, 1) for k, v in sorted(overlap.items())})
    # 1. sternum (placed by the arms group's rule and its own clearances; the true ribs are then sized to reach it)
    st_v, st_info = fit_sternum(sex, W, ZA, T, ST)
    log(sex, 'sternum', json.dumps(st_info))
    # 2. ribs
    cp = os.path.join(cd, 'ribs-fit.npz')
    if os.path.exists(cp) and not rebuild:
        d = np.load(cp); ribs_v = {k: d[f'{k[0]}{k[1]}'] for k in RG}; rib_info = json.loads(str(d['info']))
    else:
        ribs_v, rib_info = fit_ribs(sex, W, ZA, RG, T, verts, overlap, C=C, st_v=st_v)
        np.savez(cp, info=json.dumps(rib_info), **{f'{k[0]}{k[1]}': v for k, v in ribs_v.items()})
    # 3. cartilages
    cart_v, cart_info = fit_cartilages(sex, W, ZA, T, C, ribs_v, st_v)
    # 4. discs
    disc_m, disc_info, lv = fit_discs(sex, verts)
    log(sex, f'discs: {len(disc_m)} of {len(lv)} levels')
    # outputs
    outputs = []
    for (n, s), v in ribs_v.items():
        outputs.append(dict(name=f'rib_{n}_{s}', part='skel_thorax', mesh=(v, RG[(n, s)].f), source=[f'{ORD[n - 1]}_rib{s}']))
    for k, nm in (('manubrium', 'Manubrium_of_sternum'), ('sternum_body', 'Body_of_sternum'), ('xiphoid', 'Xiphoid_process')):
        outputs.append(dict(name=k, part='skel_thorax', mesh=(st_v[k], W[k][1]), source=[nm]))
    for (n, s), v in cart_v.items():
        outputs.append(dict(name=f'costal_cartilage_{n}_{s}', part='costal_cartilage', mesh=(v, W[f'cart_{n}_{s}'][1]), source=[f'Costal_cartilage_of_{ORD[n - 1].lower()}_rib{s}']))
    for name, (mesh, _, _) in disc_m.items():
        outputs.append(dict(name=name, part='discs', mesh=mesh, source=[]))
    # 5. measurements
    ribs = {k: (ribs_v[k], RG[k].f) for k in RG}
    carts = {k: (cart_v[k], W[f'cart_{k[0]}_{k[1]}'][1]) for k in cart_v}
    sternum = merge([(st_v[k], W[k][1]) for k in ('manubrium', 'sternum_body', 'xiphoid')])
    rep = dict(sex=sex, group=GROUP)
    zones = {k: RB.conflict_zone(ribs_v[k], k[1], k[0], overlap, verts, rg=RG[k]) for k in RG}
    rep['ribs_in_lungs'] = M.ribs_in_lungs(ribs, T['lungs'], zones=zones, overlap=overlap)
    rep['lung_rib_gap_lateral'] = M.lateral_gap(ribs, T['lungs'], SIDE_SIGN)
    rep['ribs_in_lungs']['lung_at_rib_joint_surfaces_mm'] = M.lung_at_joints(RG, ribs, verts, T['lungs'])
    rep['rib_lengths'] = rib_lengths(RG, ribs_v, warp_scale(sex))
    rep['rib_joints'] = M.joints(RG, ribs, verts, cord=cord_points(sex))
    rep['costal_cartilage_joints'] = M.cartilage_joints(C, carts, ribs, sternum)
    sh = M.clearance([sternum], T['heart'], inside=False)
    rep['sternum'] = dict(heart_gap=M.crit(M.mm(sh[0]), 3.0, sh[0] >= 0.003), pieces=st_info)
    for k in ('lungs', 'liver'):
        c = M.clearance([sternum], T[k], inside=False)
        rep['sternum'][f'{k}_intersection'] = M.crit(M.mm(max(0, -c[0])), 0.0, c[0] >= 0, min_gap_mm=M.mm(c[0]))
    rep['sternum']['heart_intersection'] = M.crit(M.mm(max(0, -sh[0])), 0.0, sh[0] >= 0)
    for k in ('great_veins', 'aorta'):
        c = M.clearance([sternum], T[k], inside=False); rep['sternum'][f'{k}_min_gap_mm_info'] = M.mm(c[0])
    bones = list(ribs.values()) + [(st_v[k], W[k][1]) for k in ('manubrium', 'sternum_body', 'xiphoid')]
    sk = M.clearance(bones, T['skin'], inside=True)
    skc = M.clearance(list(carts.values()), T['skin'], inside=True)
    rep['skin_clearance'] = dict(bones=M.crit(M.mm(sk[0]), 3.0, sk[0] >= 0.003), cartilages_info_mm=M.mm(skc[0]))
    extra = {}
    for k in ('heart', 'liver', 'spleen', 'kidneys', 'aorta'):
        c = M.clearance(list(ribs.values()), T[k], inside=False); extra[f'ribs_vs_{k}_min_gap_mm'] = M.mm(c[0])
    for k in ('lungs', 'heart', 'liver'):
        c = M.clearance(list(carts.values()), T[k], inside=False); extra[f'cartilages_vs_{k}_min_gap_mm'] = M.mm(c[0])
    rep['other_clearances_info'] = extra
    rep['costal_cartilage_symmetry'] = M.cartilage_symmetry(C, carts, sternum)
    rep['discs'] = M.discs(disc_m, lv, verts)
    for name, inf in disc_info.items(): rep['discs']['per_level'][name].update(inf)
    rep['fit_info'] = dict(ribs=rib_info, cartilages=cart_info)
    crits = [rep['ribs_in_lungs']['inside_fraction'], rep['ribs_in_lungs']['deepest'], rep['rib_joints']['head'], rep['rib_joints']['tubercle'],
             rep['costal_cartilage_joints'], rep['sternum']['heart_gap'], rep['sternum']['heart_intersection'], rep['sternum']['lungs_intersection'],
             rep['sternum']['liver_intersection'], rep['skin_clearance']['bones'], rep['discs'], rep['costal_cartilage_symmetry']['length_ratio']]
    rep['ok'] = bool(all(c['ok'] for c in crits))
    d = write_group(sex, GROUP, outputs, rep)
    if render:
        try: rep['qa'] = [os.path.basename(f) for f in qa(sex, outputs, T, verts, d)]
        except Exception as ex: log(sex, 'QA render failed:', ex)
        json.dump(rep, open(os.path.join(d, 'report.json'), 'w'), indent=1)
    summary(rep)
    log(sex, f'done in {time.time() - t0:.0f} s')
    return rep


def summary(rep):
    s = rep['sex']
    L = rep['ribs_in_lungs']
    print(f"[{s}] ribs in lungs {L['inside_fraction']['value']}% (<0.5) deepest {L['deepest']['value']} mm (<=1)")
    print(f"[{s}] lateral lung-rib gap {rep['lung_rib_gap_lateral']['overall']}")
    for k in ('head', 'tubercle'):
        j = rep['rib_joints'][k]; bad = {r: e['value'] for r, e in j['per_rib'].items() if not e['ok']}
        print(f"[{s}] rib {k}: ok={j['ok']} worst {j['worst_mm']} mm {('failing ' + json.dumps(bad)) if bad else ''}")
    c = rep['costal_cartilage_joints']; bad = {r: e['value'] for r, e in c['per_cartilage'].items() if not e['ok']}
    print(f"[{s}] cartilage joints ok={c['ok']} worst {c['worst_mm']} mm {('failing ' + json.dumps(bad)) if bad else ''}")
    st = rep['sternum']
    print(f"[{s}] sternum heart gap {st['heart_gap']['value']} mm; lungs {st['lungs_intersection']['min_gap_mm']} liver {st['liver_intersection']['min_gap_mm']}; pieces {json.dumps(st['pieces'])}")
    print(f"[{s}] skin clearance bones {rep['skin_clearance']['bones']['value']} mm; cartilages {rep['skin_clearance']['cartilages_info_mm']}")
    print(f"[{s}] other {json.dumps(rep['other_clearances_info'])}")
    dd = rep['discs']; bad = {r: (e.get('penetration_mm'), e.get('endplate_gap_p95_mm')) for r, e in dd['per_level'].items() if not e['ok']}
    print(f"[{s}] discs {dd['present']}/{dd['levels']} pen {dd['penetration']['value']} gap {dd['endplate_gap']['value']} {('failing ' + json.dumps(bad)) if bad else ''}")
    cs = rep['costal_cartilage_symmetry']
    print(f"[{s}] cartilage L/R length ratio worst {cs['length_ratio']['value']} (<= {cs['length_ratio']['threshold']}) " + json.dumps(cs['per_level']))
    print(f"[{s}] ALL OK: {rep['ok']}")


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    which = args[0] if args else 'all'
    for sex in (['male', 'female'] if which == 'all' else [which]):
        fit(sex, rebuild='--rebuild' in sys.argv, render='--no-render' not in sys.argv)
