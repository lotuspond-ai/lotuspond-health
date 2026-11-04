"""Reproductive structures the HRA bodies lack. Usage: python3 fit/repro.py [male|female|all].

Male (the HRA male has the prostate, seminal vesicles and vasa deferentia, but no testes):
1. The Z-Anatomy testis and epididymis of each side go through the trunk warp, as one unit per side. Each epididymis is
   lengthened along its testis's long axis so that its tail reaches the lower pole (in the warped Z-Anatomy pair it stops
   about 1 cm short); its offset from the testis surface is kept, so it stays on the posterior border.
2. The scrotum is found in the skin: below the root of the penis the genitals hang free, so each horizontal slice of the
   skin there has small closed outlines apart from the thighs. Their insides, stacked, make a voxel solid (plus the
   space just above where the scrotum joins the body, in front of the thighs). The penis hangs in front of the scrotum
   in the same outlines, so the space around the penile urethra (and in front of it) is removed.
3. Each unit is moved, turned and scaled so it lies inside that solid with room for the scrotal wall, the two testes
   keep a septum between them (signed: the other testis's own signed distance field), no HRA vas deferens runs into a
   testis, and the size moves toward the adult testis (4-5 cm long, 12-25 mL) as far as the space allows. The units
   keep the orientation the warp gives them, give or take a few degrees.
4. The HRA vas deferens of each side (matched by position, the HRA _L/_R names are swapped) stops above the tail of
   the epididymis; a duct of its own radius continues it from its end, along its direction, to the moved tail, kept
   outside the testis.
Female: the urethra (fit/repro_female.py), output with part 'bladder'.
"""
import os, sys, json
import numpy as np
from scipy import ndimage, optimize
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, sample_surface, signed_volume, pca  # noqa: E402
from fit.common import get_warp, skin, hra_mesh, za_whole, write_group, FIT  # noqa: E402
from fit.repro_geom import LocalSDF, slice_segments, fill_layer, tube, hermite, resample, centreline  # noqa: E402

H = 0.001                    # voxel size of the scrotum solid (m)
BOX = dict(x=(-0.06, 0.06), y=(-0.135, -0.045), z=(0.0, 0.15))
# The Visible Human male's scrotum is contracted: it hangs free for only 2.7 cm and is 6 cm wide, so the fit aims for
# 1.2 mm of wall (room to grow toward adult size) and 2 mm of septum, and accepts 0.5 mm of wall and 1 mm of septum.
WALL = 0.0012                # skin, dartos and tunica vaginalis between a testis and the outside (m)
SEPTUM = 0.002               # between the two testes (m), signed
VAS_CLEAR = 0.0008           # HRA vas deferens surface kept this far outside a testis (m)
PENIS_R = 0.009              # space kept around the penile urethra (corpus spongiosum, tunica, dartos) (m)
TURN = np.radians(25)        # typical turn away from the warped orientation
SCALE = (1.0, 1.45)          # allowed change of size against the trunk warp (never smaller than the warped testis)
ADULT_ML = 15.0              # adult testis volume the size is drawn toward (12-25 mL)


def orient(v, f):
    return (v, f[:, ::-1].copy()) if signed_volume(v, f) < 0 else (v, f)


def penile_urethra(sex):
    v, f = hra_mesh(sex, r'other_urethra$')
    C = centreline(v, f, v[np.argmax(v[:, 1])], step=0.001)
    return C


def scrotum_solid(sex, urethra):
    """Signed distance grid (m, negative inside) of the scrotum, and a description of the layers used."""
    v, f = skin(sex)
    xs = np.arange(*BOX['x'], H) + H / 2; ys = np.arange(*BOX['y'], H) + H / 2; zs = np.arange(*BOX['z'], H) + H / 2
    vol = np.zeros((len(ys), len(zs), len(xs)), bool)
    free, joined = [], []
    for j, y in enumerate(ys):
        segs = slice_segments(v, f, y)
        if not len(segs): continue
        m = fill_layer(segs, xs, zs)
        lab, n = ndimage.label(m)
        layer = np.zeros_like(m)
        for k in range(1, n + 1):
            cz, cx = [c.mean() for c in np.nonzero(lab == k)]
            area = (lab == k).sum() * H * H
            if area < 40e-4 and abs(xs[int(cx)]) < 0.04 and zs[int(cz)] > 0.04: layer |= lab == k
        if layer.any(): free.append(float(y))
        vol[j] = layer
    if not free: raise SystemExit(f'{sex}: no free-hanging genital outline found in the skin')
    top = max(free)
    for j, y in enumerate(ys):
        if top < y <= top + 0.02:
            m = fill_layer(slice_segments(v, f, y), xs, zs)
            box = (np.abs(xs)[None, :] < 0.035) & (zs[:, None] > 0.05) & (zs[:, None] < 0.11)
            vol[j] = m & box; joined.append(float(y))
    # the penis: everything within PENIS_R of the pendulous urethra, and in front of it
    pend = urethra[(urethra[:, 2] > 0.06)]
    Y, Z, X = np.meshgrid(ys, zs, xs, indexing='ij')
    P = np.stack([X.ravel(), Y.ravel(), Z.ravel()], 1)
    sel = vol.ravel()
    d, i = cKDTree(pend).query(P[sel])
    zu = np.interp(P[sel, 1], pend[::-1, 1] if pend[0, 1] > pend[-1, 1] else pend[:, 1], pend[::-1, 2] if pend[0, 1] > pend[-1, 1] else pend[:, 2])
    xu = np.interp(P[sel, 1], pend[::-1, 1] if pend[0, 1] > pend[-1, 1] else pend[:, 1], pend[::-1, 0] if pend[0, 1] > pend[-1, 1] else pend[:, 0])
    infront = (P[sel, 2] > zu) & (np.abs(P[sel, 0] - xu) < 0.016) & (P[sel, 1] > pend[:, 1].min() - 0.003)
    cut = (d < PENIS_R) | infront
    flat = vol.ravel().copy(); idx = np.flatnonzero(sel); flat[idx[cut]] = False
    penis_voxels = int(cut.sum())
    vol = flat.reshape(vol.shape)
    lab, n = ndimage.label(vol)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1)); vol = lab == 1 + int(np.argmax(sizes))
    inside = ndimage.distance_transform_edt(vol) * H
    outside = ndimage.distance_transform_edt(~vol) * H
    sdf = np.where(vol, -inside + H / 2, outside - H / 2)
    lo = np.array([BOX['x'][0], BOX['y'][0], BOX['z'][0]])
    return sdf.astype(np.float32), lo, dict(free=(min(free), max(free)), joined=(min(joined), max(joined)) if joined else None,
                                           penis_removed_cm3=round(penis_voxels * H ** 3 * 1e6, 1))


class Grid:
    def __init__(self, sdf, lo):
        self.sdf, self.lo = sdf, lo

    def __call__(self, p):
        q = (p - self.lo) / H - 0.5          # sdf is indexed [y, z, x]
        return ndimage.map_coordinates(self.sdf, [q[:, 1], q[:, 2], q[:, 0]], order=1, mode='nearest')


def ray_radius(sdf, q, u, rmax=0.025, step=0.0002):
    """Distance from axis points q along unit directions u to the surface of a solid (first outside sample)."""
    r = np.arange(0, rmax, step)
    P = q[:, None, :] + r[None, :, None] * u[:, None, :]
    d = sdf(P.reshape(-1, 3)).reshape(len(q), len(r))
    out = d > 0
    first = np.where(out.any(1), out.argmax(1), len(r) - 1)
    i0 = np.maximum(first - 1, 0)
    d0, d1 = d[np.arange(len(q)), i0], d[np.arange(len(q)), first]
    t = np.where(d1 != d0, -d0 / np.where(d1 != d0, d1 - d0, 1), 0)
    return r[i0] + np.clip(t, 0, 1) * step


def extend_epididymis(tm, em, tsdf, reach=0.002):
    """Lengthen the epididymis along the testis's long axis so its tail reaches `reach` above the lower pole. Each vertex
    keeps its direction around the axis and its offset from the testis surface; the axial shift fades smoothly from
    the tail to the top of the head, which stays where it is."""
    tv, ev = tm[0], em[0]
    c, ax, _ = pca(tv); a = ax[:, 0]
    if ((ev - c) @ a).mean() < 0: a = -a
    t_low = ((tv - c) @ a).min()
    te = (ev - c) @ a; t_tail, t_head = te.min(), te.max()
    shift = (t_low + reach) - t_tail
    if shift >= 0: return em, dict(shift_mm=0.0)
    w = np.clip((te - t_tail) / (t_head - t_tail), 0, 1); w = 1 - w * w * (3 - 2 * w)
    t2 = te + shift * w
    rho = (ev - c) - np.outer(te, a); rn = np.linalg.norm(rho, axis=1); u = rho / np.maximum(rn[:, None], 1e-9)
    R0 = ray_radius(tsdf, c + np.outer(te, a), u); R1 = ray_radius(tsdf, c + np.outer(t2, a), u)
    ev2 = c + np.outer(t2, a) + u * np.maximum(rn - R0 + R1, 0.0005)[:, None]
    return (ev2, em[1]), dict(shift_mm=round(float(-shift) * 1000, 1), tail_above_pole_before_mm=round(float(t_tail - t_low) * 1000, 1))


def fit(sex='male'):
    out_dir = os.path.join(FIT, sex, 'repro'); os.makedirs(out_dir, exist_ok=True)
    if sex == 'female':
        from fit.repro_female import fit_urethra
        ure, rep, aux = fit_urethra(sex)
        report = dict(sex=sex, urethra=rep, ok=rep['ok'])
        outputs = [ure]
        write_group(sex, 'repro', outputs, report)
        qa_female(sex, outputs, aux, out_dir)
        print(json.dumps(report, indent=1))
        return report
    warp = get_warp(sex, 'trunk')
    za = source('za-visceral')
    raw = {o['name']: za.load([o]) for o in za_whole('za-visceral', r'^(Testis|Epididymis)[lr]$')}
    meshes = {k: orient(warp(v), f) for k, (v, f) in raw.items()}
    urethra = penile_urethra(sex)
    sdf, lo, layers = scrotum_solid(sex, urethra)
    grid = Grid(sdf, lo)
    np.savez(os.path.join(out_dir, 'scrotum-sdf.npz'), sdf=sdf, lo=lo, h=H)

    # the vasa deferentia, matched to sides by position (+x is the person's left)
    vas = {}
    for side in 'LR':
        v, f = hra_mesh(sex, rf'vas_deferens_{side}$')
        C = centreline(v, f, v[np.argmin(v[:, 1])], step=0.001)       # from the scrotal end up the cord
        s = 'l' if C[0, 0] > 0 else 'r'
        near_end = v[np.linalg.norm(v - C[0], axis=1) < 0.006]
        dC = np.linalg.norm(near_end[:, None] - C[None, :12], axis=2).min(1)
        P = sample_surface(v, f, 6000, seed=9)
        vas[s] = dict(name=f'VH_M_vas_deferens_{side}', mesh=(v, f), C=C, end=C[0], dir=(C[0] - C[6]) / np.linalg.norm(C[0] - C[6]),
                      r=float(np.clip(np.median(dC), 0.0008, 0.0018)), P=P[P[:, 1] < -0.06])
    vas_pts = np.concatenate([vas[s]['P'] for s in 'lr'])

    units, epi_info = {}, {}
    for s in 'lr':
        tm = meshes[f'Testis{s}']
        tsdf = LocalSDF(tm, h=0.0004)
        em, epi_info[s] = extend_epididymis(tm, meshes[f'Epididymis{s}'], tsdf)
        tv, tf = tm; ev, ef = em
        P = np.concatenate([sample_surface(tv, tf, 700, seed=1), sample_surface(ev, ef, 300, seed=2)])
        c, ax, _ = pca(tv); a = ax[:, 0] * (1 if ((ev - c) @ ax[:, 0]).mean() > 0 else -1)
        tail = ev[((ev - c) @ a) < ((ev - c) @ a).min() + 0.002].mean(0)
        units[s] = dict(P=P, c=np.concatenate([tv, ev]).mean(0), sdf=tsdf, tm=tm, em=em, tail=tail, vol=signed_volume(tv, tf))
    k_target = np.log((ADULT_ML * 1e-6 / np.mean([units[s]['vol'] for s in 'lr'])) ** (1 / 3))

    def T_of(x, s):
        return (units[s]['c'], Rotation.from_rotvec(x[:3]).as_matrix(), float(np.exp(x[6])), x[3:6])

    def apply(T, p):
        c, R, k, t = T
        return (p - c) @ R.T * k + c + t

    inside = np.argwhere(sdf < -0.004)
    pts = lo + (inside[:, [2, 0, 1]] + 0.5) * H
    mid = np.median(pts[:, 0])
    x0 = np.zeros(14)
    for i, s in enumerate('lr'):
        half = pts[(pts[:, 0] > mid) == (s == 'l')]
        x0[i * 7 + 3:i * 7 + 6] = half.mean(0) - units[s]['c']

    lim = np.log(SCALE)

    def pen(v):
        # mean squared violation plus the mean of the worst 15 samples: a few deep violations cannot hide in the mean
        v = np.maximum(v, 0) ** 2
        return v.mean() + np.partition(v, len(v) - 15)[-15:].mean()

    def energy(x, parts=False):
        T = {s: T_of(x[i * 7:(i + 1) * 7], s) for i, s in enumerate('lr')}
        P = {s: apply(T[s], units[s]['P']) for s in 'lr'}
        e_in = sum(pen(grid(P[s]) + WALL) for s in 'lr') / WALL ** 2
        e_sep = sum(pen(SEPTUM - units[o]['sdf'].at(P[s], T[o])) for s, o in (('l', 'r'), ('r', 'l'))) / SEPTUM ** 2
        e_vas = sum(pen(VAS_CLEAR - units[s]['sdf'].at(vas_pts, T[s])) for s in 'lr') / VAS_CLEAR ** 2
        e_tail = sum(np.sum((apply(T[s], units[s]['tail'][None])[0] - vas[s]['end']) ** 2) for s in 'lr') / 0.015 ** 2
        e_rot = sum(np.sum(x[i * 7:i * 7 + 3] ** 2) for i in range(2)) / TURN ** 2
        e_scl = sum((x[i * 7 + 6] - k_target) ** 2 for i in range(2)) / 0.1 ** 2
        e_lim = sum(max(0, lim[0] - x[i * 7 + 6], x[i * 7 + 6] - lim[1]) ** 2 for i in range(2)) * 1e4
        terms = dict(inside=40 * e_in, septum=20 * e_sep, vas=20 * e_vas, tail=0.2 * e_tail, rotation=1.0 * e_rot, scale=0.2 * e_scl, limit=e_lim)
        return terms if parts else sum(terms.values())

    # coarse search of each unit's position first (Powell alone stays on whichever side of a vas it starts)
    off = np.array([(dx, dy, dz) for dx in np.arange(-0.015, 0.0151, 0.003) for dy in np.arange(-0.006, 0.0061, 0.003) for dz in np.arange(-0.015, 0.0151, 0.003)])
    for _ in range(2):
        for i in (1, 0):
            cand = []
            for o_ in off:
                xx = x0.copy(); xx[i * 7 + 3:i * 7 + 6] += o_; cand.append(energy(xx))
            x0[i * 7 + 3:i * 7 + 6] += off[int(np.argmin(cand))]
    best = None
    for attempt in range(3):
        start = x0 if best is None else best.x + np.random.default_rng(attempt).normal(0, 0.002, 14) * np.tile([0, 0, 0, 1, 1, 1, 0], 2)
        r = optimize.minimize(energy, start, method='Powell', options=dict(maxiter=40000, xtol=1e-5, ftol=1e-9))
        if best is None or r.fun < best.fun: best = r
    x = best.x
    T = {s: T_of(x[i * 7:(i + 1) * 7], s) for i, s in enumerate('lr')}

    outputs, report = [], dict(sex=sex, scrotum_layers=layers, energy={k: round(float(v), 4) for k, v in energy(x, True).items()}, sides={})
    fitted = {}
    for i, s in enumerate('lr'):
        tv, tf = units[s]['tm']; ev, ef = units[s]['em']
        tv2, ev2 = apply(T[s], tv), apply(T[s], ev)
        fitted[s] = dict(t=(tv2, tf), e=(ev2, ef), tail=apply(T[s], units[s]['tail'][None])[0])
    # the vas continued from its HRA end to the tail of the epididymis, outside the testis
    for s in 'lr':
        o = 'r' if s == 'l' else 'l'
        p0, d0, rv = vas[s]['end'], vas[s]['dir'], vas[s]['r']
        tv2 = fitted[s]['t'][0]; c = tv2.mean(0)
        ax = pca(tv2)[1][:, 0]; ax = ax if ax[1] > 0 else -ax
        p1 = fitted[s]['tail'] + 0.001 * (-ax)
        C = hermite(p0, d0, p1, -ax, 60)
        sd = lambda p: units[s]['sdf'].at(p, T[s])
        for _ in range(40):
            d = sd(C); bad = d < rv + 0.0004
            bad[:3] = False; bad[-4:] = False
            if not bad.any(): break
            g = np.stack([(sd(C + e) - sd(C - e)) / 2e-4 for e in np.eye(3) * 1e-4], 1)
            g /= np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-9)
            C[bad] += (rv + 0.0005 - d[bad])[:, None] * g[bad]
            C[1:-1] = 0.25 * C[:-2] + 0.5 * C[1:-1] + 0.25 * C[2:]
        C, sC = resample(C, 0.0005)
        fitted[s]['vas_ext'] = tube(C, rv, n=14)
        fitted[s]['vas_ext_C'] = C; fitted[s]['vas_ext_r'] = rv
    for i, s in enumerate('lr'):
        side = 'left' if s == 'l' else 'right'; o = 'r' if s == 'l' else 'l'
        tv2, tf = fitted[s]['t']; ev2, ef = fitted[s]['e']
        outputs += [dict(name=f'testis_{s}', part='reproductive', mesh=(tv2, tf), source=[f'Testis{s}']),
                    dict(name=f'epididymis_{s}', part='reproductive', mesh=(ev2, ef), source=[f'Epididymis{s}']),
                    dict(name=f'vas_deferens_end_{s}', part='reproductive', mesh=fitted[s]['vas_ext'], source=[])]
        Pt = sample_surface(tv2, tf, 4000, seed=11); Pe = sample_surface(ev2, ef, 2000, seed=12)
        d = grid(np.concatenate([Pt, Pe]))
        size = pca(tv2)
        pr = (tv2 - size[0]) @ size[1]; ext = pr.max(0) - pr.min(0)
        vol = signed_volume(tv2, tf)
        sep = units[o]['sdf'].at(np.concatenate([Pt, Pe]), T[o])
        vin = min(float(units[s]['sdf'].at(vas[q]['P'], T[s]).min()) for q in 'lr')
        Ce = fitted[s]['vas_ext_C']; ext_clear = float(units[s]['sdf'].at(Ce[3:-4], T[s]).min() - fitted[s]['vas_ext_r'])
        ext_other = float(units[o]['sdf'].at(Ce, T[o]).min() - fitted[s]['vas_ext_r'])
        ax = size[1][:, 0] * (1 if size[1][1, 0] > 0 else -1)
        tail_gap = float(((ev2 - size[0]) @ ax).min() - ((tv2 - size[0]) @ ax).min())
        report['sides'][side] = dict(
            moved_mm=round(float(np.linalg.norm(x[i * 7 + 3:i * 7 + 6]) * 1000), 1),
            turned_deg=round(float(np.degrees(np.linalg.norm(x[i * 7:i * 7 + 3]))), 1),
            scale=round(float(np.exp(x[i * 7 + 6])), 3),
            testis_centre_mm=np.round(tv2.mean(0) * 1000, 1).tolist(),
            testis_size_mm=[round(float(a) * 1000, 1) for a in ext],
            testis_volume_ml=dict(value=round(vol * 1e6, 2), adult=[12, 25], ok=bool(vol * 1e6 >= 12)),
            testis_length_mm=dict(value=round(float(ext[0]) * 1000, 1), adult=[40, 50], ok=bool(ext[0] >= 0.040)),
            wall_min_mm=dict(value=round(float(-d.max() * 1000), 2), threshold=0.5, ok=bool(-d.max() >= 0.0005)),
            inside_fraction=dict(value=round(float((d < 0).mean()), 4), threshold=1.0, ok=bool((d < 0).all())),
            septum_signed_min_mm=dict(value=round(float(sep.min()) * 1000, 2), threshold=1.0, ok=bool(sep.min() >= 0.001),
                                      note='signed distance of this unit (testis + epididymis) to the other testis; negative = overlap'),
            hra_vas_in_testis_mm=dict(value=round(max(-vin, 0) * 1000, 2), clearance_mm=round(vin * 1000, 2), threshold=0.0, ok=bool(vin >= 0)),
            epididymis=dict(epi_info[s], tail_above_lower_pole_mm=dict(value=round(tail_gap * 1000, 1), threshold=3.0, ok=bool(tail_gap <= 0.003))),
            vas_extension=dict(length_mm=round(float(np.linalg.norm(np.diff(Ce, axis=0), axis=1).sum()) * 1000, 1), radius_mm=round(fitted[s]['vas_ext_r'] * 1000, 2),
                               testis_clearance_mm=dict(value=round(ext_clear * 1000, 2), threshold=0.2, ok=bool(ext_clear >= 0.0002)),
                               other_testis_clearance_mm=round(ext_other * 1000, 2),
                               start_gap_to_hra_end_mm=round(float(np.linalg.norm(Ce[0] - vas[s]['end'])) * 1000, 2),
                               hra_duct=vas[s]['name']))
    report['ok'] = bool(all(v['ok'] for side in report['sides'].values() for k, v in side.items()
                            if isinstance(v, dict) and 'ok' in v and k not in ('testis_volume_ml', 'testis_length_mm')))
    report['note'] = 'testis_volume_ml and testis_length_mm compare with adult values and do not gate ok: the contracted VH scrotum limits the size'
    write_group(sex, 'repro', outputs, report)
    qa(sex, outputs, out_dir)
    print(json.dumps(report, indent=1))
    return report


def qa(sex, outputs, out_dir):
    from lib.qa import render_views, FRONT, LEFT, BOTTOM
    sk = skin(sex)
    col = dict(testis='#c0392b', epididymis='#2e86c1', vas='#27ae60')
    items = [dict(mesh=sk, color='#e8c4a8', opacity=0.3)]
    for o in outputs: items.append(dict(mesh=o['mesh'], color=col[o['name'].split('_')[0]]))
    for side in 'LR':
        items.append(dict(mesh=hra_mesh(sex, rf'vas_deferens_{side}$'), color='#8e44ad'))
    items.append(dict(mesh=hra_mesh(sex, r'other_urethra$'), color='#f1c40f'))
    c = np.concatenate([o['mesh'][0] for o in outputs if o['name'].startswith('testis')]).mean(0)
    cams = {'front': dict(FRONT, target=c, radius=0.07), 'left': dict(LEFT, target=c, radius=0.07), 'bottom': dict(BOTTOM, target=c, radius=0.07),
            'back': dict(dir=(0, 0.02, -1), target=c, radius=0.06)}
    render_views(items, cams, os.path.join(out_dir, 'qa'))


def qa_female(sex, outputs, aux, out_dir):
    from lib.qa import render_views, LEFT
    sk = skin(sex)
    items = [dict(mesh=sk, color='#e8c4a8', opacity=0.25), dict(mesh=aux['pubis'], color='#bbbbbb'), dict(mesh=aux['vagina'], color='#c06090'),
             dict(mesh=aux['bladder'], color='#e0b030', opacity=0.6), dict(mesh=aux['neck'], color='#e04020'), dict(mesh=outputs[0]['mesh'], color='#2e6fd0')]
    c = aux['centre'].mean(0)
    cams = {'left': dict(LEFT, target=c, radius=0.09), 'oblique': dict(dir=(0.7, -0.2, 0.7), target=c, radius=0.09),
            'section': dict(LEFT, target=c, radius=0.08, clip=[dict(normal=(-1, 0, 0), constant=float(c[0]) + 0.0005)])}
    render_views(items, cams, os.path.join(out_dir, 'qa'))


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    for sex in (['male', 'female'] if which == 'all' else [which]):
        fit(sex)
