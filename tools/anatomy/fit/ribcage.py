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

GROUP = 'ribcage'
SIDE_SIGN = {'l': 1.0, 'r': -1.0}
RIB_OBSTACLES = [('lungs', RB.LUNG_CLEAR), ('heart', RB.ORGAN_CLEAR), ('liver', RB.ORGAN_CLEAR), ('spleen', RB.ORGAN_CLEAR),
                 ('kidneys', RB.ORGAN_CLEAR), ('aorta', 0.001)]
CART_OBSTACLES = [('lungs', RB.LUNG_CLEAR), ('heart', 0.002), ('liver', RB.ORGAN_CLEAR)]
STERNUM_CLEAR = dict(heart=0.0035, lungs=0.0012, liver=0.0015, skin=0.004)


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


def fit_ribs(sex, W, RG, T, verts):
    out, info = {}, {}
    obstacles = [(T[k], c) for k, c in RIB_OBSTACLES if k in T]
    radial = RB.Radial(T['lungs'])
    for key, rg in RG.items():
        n, s = key
        v = W[f'rib_{n}_{s}'][0]
        v1, i1 = RB.seat(rg, v, verts, T['lungs'])
        v2, i2 = RB.bend(v1, RB.rib_basis(rg.s, rg.length, rg.s_rigid + 0.004), obstacles, T['skin'], radial=radial)
        out[key] = v2
        info[f'{n}{s}'] = dict(seat=i1, bend=i2)
        log(sex, f'rib {n}{s}: seat {i1["rot_deg"]:.1f} deg / {i1["shift_mm"]:.1f} mm, bend max {i2["max_mm"]:.1f} mm')
    return out, info


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


def fit_sternum(sex, W, T, ST):
    from fit.ribcage_data import Part
    pieces = {k: W[k][0] for k in ('manubrium', 'sternum_body', 'xiphoid')}
    obst = lambda extra=(): [(T['heart'], STERNUM_CLEAR['heart'], 1.0), (T['lungs'], STERNUM_CLEAR['lungs'], 1.0), (T['liver'], STERNUM_CLEAR['liver'], 1.0)] + list(extra)
    vessels = [(T['great_veins'], 0.001, 0.3), (T['aorta'], 0.001, 0.3)]
    info, out = {}, {}
    # manubrium: only a criterion (heart / lung / liver contact, heart < 3 mm, skin < 3 mm) may move it
    Mv = pieces['manubrium']
    P = Mv[::2]
    viol = {'heart': float(M.signed(T['heart'], P).min()), 'lungs': float(M.signed(T['lungs'], P).min()),
            'liver': float(M.signed(T['liver'], P).min()), 'skin': float(-M.signed(T['skin'], P).max())}
    forced = viol['heart'] < 0.003 or viol['lungs'] < 0 or viol['liver'] < 0 or viol['skin'] < 0.003
    if forced:
        tf, x = fit_piece(Mv, T, obst(), STERNUM_CLEAR['skin'], reg=(1.0, 0.002))
        out['manubrium'] = tf(Mv)
    else:
        out['manubrium'] = Mv.copy(); x = np.zeros(6)
    nl, nr = ST['notch_l'], ST['notch_r']
    info['manubrium'] = dict(forced=bool(forced), warp_clearances_mm={k: mm1(v) for k, v in viol.items()},
                             notch_moved_mm=dict(left=mm1(np.linalg.norm(out['manubrium'][nl] - Mv[nl], axis=1).max()),
                                                 right=mm1(np.linalg.norm(out['manubrium'][nr] - Mv[nr], axis=1).max())))
    # body about the manubriosternal joint, xiphoid about the xiphisternal joint
    for key, partner, jk in (('sternum_body', 'manubrium', 'body_to_manubrium'), ('xiphoid', 'sternum_body', 'xiphoid_to_body')):
        v = pieces[key]
        idx, gap = ST[jk]
        part = Part(out[partner], W[partner][1])
        # the partner's own motion carried over first (rigidly, so the joint stays closed), then the piece's own fit
        d0 = out[partner][::7] - pieces[partner][::7]
        from lib.register import umeyama
        Tp = umeyama(pieces[partner], out[partner], scale=False)
        v0 = Tp(v)
        tf, x = fit_piece(v0, T, obst(vessels), STERNUM_CLEAR['skin'], joint=(idx, part, gap), centre=v0[idx].mean(0))
        out[key] = tf(v0)
        info[key] = dict(rot_deg=round(float(np.degrees(np.linalg.norm(x[:3]))), 2), shift_mm=mm1(np.linalg.norm(x[3:])))
    return out, info


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


def fit_cartilages(sex, W, T, C, ribs_v, st_v):
    out, info = {}, {}
    st_keys = ['manubrium', 'sternum_body', 'xiphoid']
    obstacles = [(T[k], c) for k, c in CART_OBSTACLES]
    for n in range(1, 11):
        for s in 'lr':
            key = (n, s); v, f = W[f'cart_{n}_{s}']; e = C[key]
            idx = [e['rib']]; val = [ribs_v[key][e['rib_nn']] - W[f'rib_{n}_{s}'][0][e['rib_nn']]]
            if n <= 7:
                for pi, k in enumerate(st_keys):
                    m = e['sternum_piece'] == pi
                    if m.any():
                        nn = e['sternum_nn'][m]
                        idx.append(e['sternum'][m]); val.append(st_v[k][nn] - W[k][0][nn])
            else:
                nn = e['above_nn']
                idx.append(e['above']); val.append(out[(n - 1, s)][nn] - W[f'cart_{n - 1}_{s}'][0][nn])
            idx = np.concatenate(idx); val = np.concatenate(val)
            idx, first = np.unique(idx, return_index=True); val = val[first]
            u = harmonic(f, len(v), idx, val)
            vh = v + u
            # bend between the two joints to clear lungs, heart and liver
            sarc, _, _ = RB.arc_length(vh, f, e['rib'])
            Bf = RB.bar_basis(sarc, sarc.max(), spacing=0.012, end=0.006)
            vb, ib = RB.bend(vh, Bf, obstacles, T['skin'], spacing=0.012, sub=1)
            out[key] = vb
            info[f'{n}{s}'] = dict(joint_motion_max_mm=mm1(np.linalg.norm(val, axis=1).max()), bend_max_mm=round(ib['max_mm'], 2))
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
    c = 0.5 * (allv.min(0) + allv.max(0)); r = float(np.linalg.norm(allv.max(0) - allv.min(0)) / 2) * 0.62
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
    # 1. ribs
    cp = os.path.join(cd, 'ribs-fit.npz')
    if os.path.exists(cp) and not rebuild:
        d = np.load(cp); ribs_v = {k: d[f'{k[0]}{k[1]}'] for k in RG}; rib_info = json.loads(str(d['info']))
    else:
        ribs_v, rib_info = fit_ribs(sex, W, RG, T, verts)
        np.savez(cp, info=json.dumps(rib_info), **{f'{k[0]}{k[1]}': v for k, v in ribs_v.items()})
    # 2. sternum
    st_v, st_info = fit_sternum(sex, W, T, ST)
    log(sex, 'sternum', json.dumps(st_info))
    # 3. cartilages
    cart_v, cart_info = fit_cartilages(sex, W, T, C, ribs_v, st_v)
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
    rep['ribs_in_lungs'] = M.ribs_in_lungs(ribs, T['lungs'])
    rep['lung_rib_gap_lateral'] = M.lateral_gap(ribs, T['lungs'], SIDE_SIGN)
    rep['rib_joints'] = M.joints(RG, ribs, verts)
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
    rep['discs'] = M.discs(disc_m, lv, verts)
    for name, inf in disc_info.items(): rep['discs']['per_level'][name].update(inf)
    rep['fit_info'] = dict(ribs=rib_info, cartilages=cart_info)
    crits = [rep['ribs_in_lungs']['inside_fraction'], rep['ribs_in_lungs']['deepest'], rep['rib_joints']['head'], rep['rib_joints']['tubercle'],
             rep['costal_cartilage_joints'], rep['sternum']['heart_gap'], rep['sternum']['heart_intersection'], rep['sternum']['lungs_intersection'],
             rep['sternum']['liver_intersection'], rep['skin_clearance']['bones'], rep['discs']]
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
    print(f"[{s}] ALL OK: {rep['ok']}")


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    which = args[0] if args else 'all'
    for sex in (['male', 'female'] if which == 'all' else [which]):
        fit(sex, rebuild='--rebuild' in sys.argv, render='--no-render' not in sys.argv)
