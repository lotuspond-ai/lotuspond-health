"""Testes and epididymides for the male body (the HRA male has the prostate, seminal vesicles and vasa deferentia, but no
testes). Usage: python3 fit/repro.py [male|female|all]; the female body needs nothing from here.

1. The Z-Anatomy testis and epididymis of each side go through the trunk warp, as one rigid unit per side.
2. The scrotum is found in the skin: below the root of the penis the genitals hang free, so each horizontal slice of the
   skin there has small closed outlines apart from the thighs. Their insides, stacked, make a voxel solid (plus the
   space just above where the scrotum joins the body, in front of the thighs).
3. Each unit is moved, turned and scaled (within limits) so it lies inside that solid with room for the scrotal wall,
   the two units keep a septum between them, and the tail of each epididymis meets the end of that side's HRA vas
   deferens lies against the epididymis (the HRA duct stops short of the tail, where it really begins). The units keep
   the orientation the warp gives them, give or take a few degrees.
"""
import os, sys, json
import numpy as np
from scipy import ndimage, optimize
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, sample_surface  # noqa: E402
from fit.common import get_warp, skin, hra_mesh, za_whole, write_group, FIT  # noqa: E402

H = 0.001                    # voxel size of the scrotum solid (m)
BOX = dict(x=(-0.06, 0.06), y=(-0.135, -0.045), z=(0.0, 0.15))
# The Visible Human male's scrotum is contracted: it hangs free for only 2.7 cm and is 6 cm wide, so the fit aims for
# 2 mm of wall and septum and accepts 0.5 mm.
WALL = 0.002                 # skin, dartos and tunica vaginalis between a testis and the outside (m)
SEPTUM = 0.002               # between the two sides (m)
VAS_GAP = 0.003              # the end of each vas deferens lies within this of its epididymis (m)
TURN = np.radians(25)        # typical turn away from the warped orientation
SCALE = (0.9, 1.15)          # allowed change of size against the trunk warp


def slice_segments(v, f, y):
    d = v[:, 1] - y
    s = np.sign(d[f]); keep = (s.min(1) < 0) & (s.max(1) > 0)
    tri = f[keep]
    segs = []
    for a, b in ((0, 1), (1, 2), (2, 0)):
        da, db = d[tri[:, a]], d[tri[:, b]]
        m = (da < 0) != (db < 0)
        t = np.where(m, da / np.where(m, da - db, 1), 0)
        segs.append((m, v[tri[:, a]] + t[:, None] * (v[tri[:, b]] - v[tri[:, a]])))
    pts = []
    for i in range(len(tri)):
        p = [segs[k][1][i] for k in range(3) if segs[k][0][i]]
        if len(p) == 2: pts.append(p)
    return np.array(pts).reshape(-1, 2, 3)


def fill_layer(segs, xs, zs):
    """Even-odd scanline fill of a slice's outlines on the (z, x) grid."""
    a, b = segs[:, 0][:, [0, 2]], segs[:, 1][:, [0, 2]]
    mask = np.zeros((len(zs), len(xs)), bool)
    for i, z in enumerate(zs):
        c = (a[:, 1] <= z) != (b[:, 1] <= z)
        if not c.any(): continue
        t = (z - a[c, 1]) / (b[c, 1] - a[c, 1])
        x = np.sort(a[c, 0] + t * (b[c, 0] - a[c, 0]))
        mask[i] = np.searchsorted(x, xs) % 2 == 1
    return mask


def scrotum_solid(sex):
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
    # just above the free part the scrotum joins the body: allow the space in front of the thighs, under the penis root
    for j, y in enumerate(ys):
        if top < y <= top + 0.02:
            m = fill_layer(slice_segments(v, f, y), xs, zs)
            box = (np.abs(xs)[None, :] < 0.035) & (zs[:, None] > 0.05) & (zs[:, None] < 0.11)
            vol[j] = m & box; joined.append(float(y))
    inside = ndimage.distance_transform_edt(vol) * H
    outside = ndimage.distance_transform_edt(~vol) * H
    sdf = np.where(vol, -inside + H / 2, outside - H / 2)
    lo = np.array([BOX['x'][0], BOX['y'][0], BOX['z'][0]])
    return sdf.astype(np.float32), lo, dict(free=(min(free), max(free)), joined=(min(joined), max(joined)) if joined else None)


class Grid:
    def __init__(self, sdf, lo):
        self.sdf, self.lo = sdf, lo

    def __call__(self, p):
        # sdf is indexed [y, z, x]
        q = (p - self.lo) / H - 0.5
        return ndimage.map_coordinates(self.sdf, [q[:, 1], q[:, 2], q[:, 0]], order=1, mode='nearest')


def fit(sex='male'):
    if sex != 'male':
        print(f'{sex}: nothing to fit'); return None
    out_dir = os.path.join(FIT, sex, 'repro'); os.makedirs(out_dir, exist_ok=True)
    warp = get_warp(sex, 'trunk')
    za = source('za-visceral')
    raw = {o['name']: za.load([o]) for o in za_whole('za-visceral', r'^(Testis|Epididymis)[lr]$')}
    meshes = {k: (warp(v), f) for k, (v, f) in raw.items()}
    sdf, lo, layers = scrotum_solid(sex)
    grid = Grid(sdf, lo)
    np.savez(os.path.join(out_dir, 'scrotum-sdf.npz'), sdf=sdf, lo=lo, h=H)

    # the ends of the vasa deferentia, matched to sides by position (+x is the person's left)
    vas = {}
    for side in 'LR':
        v, f = hra_mesh(sex, rf'vas_deferens_{side}$')
        end = v[np.argmin(v[:, 1])]
        vas['l' if end[0] > 0 else 'r'] = (end, (v, f))

    units = {}
    for s in 'lr':
        tv, tf = meshes[f'Testis{s}']; ev, ef = meshes[f'Epididymis{s}']
        P = np.concatenate([sample_surface(tv, tf, 700, seed=1), sample_surface(ev, ef, 300, seed=2)])
        units[s] = dict(P=P, c=np.concatenate([tv, ev]).mean(0), E=P[700:])

    def transform(x, s):
        r, t, ls = x[:3], x[3:6], x[6]
        R = Rotation.from_rotvec(r).as_matrix(); k = np.exp(ls); c = units[s]['c']
        return lambda p: (p - c) @ R.T * k + c + t

    # start: move each unit so its centre sits at the centre of its own half of the scrotum
    inside = np.argwhere(sdf < -0.004)
    pts = lo + (inside[:, [2, 0, 1]] + 0.5) * H
    x0 = np.zeros(14)
    for i, s in enumerate('lr'):
        half = pts[(pts[:, 0] > 0) == (s == 'l')]
        x0[i * 7 + 3:i * 7 + 6] = half.mean(0) - units[s]['c']

    lim = np.log(SCALE)

    def vas_gap(T, s):
        return float(np.min(np.linalg.norm(T(units[s]['E']) - vas[s][0], axis=1)))

    def energy(x, parts=False):
        Tl, Tr = transform(x[:7], 'l'), transform(x[7:], 'r')
        Pl, Pr = Tl(units['l']['P']), Tr(units['r']['P'])
        e_in = sum(np.mean(np.maximum(grid(P) + WALL, 0) ** 2) for P in (Pl, Pr)) / WALL ** 2
        dl, _ = cKDTree(Pr).query(Pl)
        e_sep = np.mean(np.maximum(SEPTUM - dl, 0) ** 2) / SEPTUM ** 2
        e_vas = sum(max(vas_gap(T, s) - VAS_GAP, 0) ** 2 for s, T in (('l', Tl), ('r', Tr))) / 0.004 ** 2
        e_rot = sum(np.sum(x[i * 7:i * 7 + 3] ** 2) for i in range(2)) / TURN ** 2
        e_scl = sum(max(abs(x[i * 7 + 6]) - 0, 0) ** 2 for i in range(2)) / 0.05 ** 2
        e_lim = sum(max(0, abs(x[i * 7 + 6]) - (lim[1] if x[i * 7 + 6] > 0 else -lim[0])) ** 2 for i in range(2)) * 1e4
        terms = dict(inside=40 * e_in, septum=20 * e_sep, vas=0.5 * e_vas, rotation=1.0 * e_rot, scale=0.2 * e_scl, limit=e_lim)
        return terms if parts else sum(terms.values())

    best = None
    for attempt in range(3):
        start = x0 if best is None else best.x + np.random.default_rng(attempt).normal(0, 0.002, 14)
        r = optimize.minimize(energy, start, method='Powell', options=dict(maxiter=40000, xtol=1e-5, ftol=1e-9))
        if best is None or r.fun < best.fun: best = r
    x = best.x

    outputs, report = [], dict(sex=sex, scrotum_layers=layers, energy={k: round(float(v), 4) for k, v in energy(x, True).items()}, sides={})
    for i, s in enumerate('lr'):
        T = transform(x[i * 7:(i + 1) * 7], s)
        tv, tf = meshes[f'Testis{s}']; ev, ef = meshes[f'Epididymis{s}']
        tv2, ev2 = T(tv), T(ev)
        side = 'left' if s == 'l' else 'right'
        outputs += [dict(name=f'testis_{s}', part='reproductive', mesh=(tv2, tf), source=[f'Testis{s}']),
                    dict(name=f'epididymis_{s}', part='reproductive', mesh=(ev2, ef), source=[f'Epididymis{s}'])]
        P = T(units[s]['P']); d = grid(P)
        size = tv2.max(0) - tv2.min(0)
        report['sides'][side] = dict(
            moved_mm=round(float(np.linalg.norm(x[i * 7 + 3:i * 7 + 6]) * 1000), 1),
            turned_deg=round(float(np.degrees(np.linalg.norm(x[i * 7:i * 7 + 3]))), 1),
            scale=round(float(np.exp(x[i * 7 + 6])), 3),
            testis_size_mm=[round(float(a) * 1000, 1) for a in size],
            wall_min_mm=dict(value=round(float(-d.max() * 1000), 2), threshold=0.5, ok=bool(-d.max() >= 0.0005)),
            inside_fraction=dict(value=round(float((d < 0).mean()), 4), threshold=1.0, ok=bool((d < 0).all())),
            vas_gap_mm=dict(value=round(vas_gap(T, s) * 1000, 1), threshold=8.0, ok=bool(vas_gap(T, s) < 0.008)))
    Pl = transform(x[:7], 'l')(units['l']['P']); Pr = transform(x[7:], 'r')(units['r']['P'])
    gap = float(cKDTree(Pr).query(Pl)[0].min())
    report['septum_mm'] = dict(value=round(gap * 1000, 2), threshold=0.5, ok=bool(gap >= 0.0005))
    report['ok'] = bool(report['septum_mm']['ok'] and all(v['ok'] for side in report['sides'].values() for v in side.values() if isinstance(v, dict)))
    write_group(sex, 'repro', outputs, report)
    qa(sex, outputs, out_dir)
    print(json.dumps(report, indent=1))
    return report


def qa(sex, outputs, out_dir):
    from lib.qa import render_views, FRONT, LEFT, BOTTOM
    sk = skin(sex)
    items = [dict(mesh=sk, color='#e8c4a8', opacity=0.3)]
    for o in outputs: items.append(dict(mesh=o['mesh'], color='#c0392b' if o['name'].startswith('testis') else '#2e86c1'))
    for side in 'LR':
        items.append(dict(mesh=hra_mesh(sex, rf'vas_deferens_{side}$'), color='#8e44ad'))
    c = np.concatenate([o['mesh'][0] for o in outputs]).mean(0)
    cams = {'front': dict(FRONT, target=c, radius=0.07), 'left': dict(LEFT, target=c, radius=0.07), 'bottom': dict(BOTTOM, target=c, radius=0.07)}
    render_views(items, cams, os.path.join(out_dir, 'qa'))


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    for sex in (['male', 'female'] if which == 'all' else [which]):
        fit(sex)
