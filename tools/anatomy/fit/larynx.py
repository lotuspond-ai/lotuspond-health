"""Intrinsic muscles of the larynx for the female body. The HRA female has the laryngeal cartilages but none of the
muscles (the male body has its own eleven). Usage: python3 fit/larynx.py [female|male|all]; the male needs nothing.

The muscles run between the cartilages, so they follow the cartilages: the Z-Anatomy thyroid, cricoid, arytenoid and
corniculate cartilages and the epiglottis go through the trunk warp, each is then aligned to its HRA counterpart on its
own (similarity ICP, symmetric) and its samples are projected onto the HRA surface; a smooth thin-plate spline through
those pairs carries the warped muscles into the female larynx. The HRA arytenoids are about twice as tall as Z-Anatomy's
(18.5 mm against 8.5 mm; adult arytenoids are 15-18 mm), so the small cartilages may scale freely in that alignment.
Last, muscle surface that ends up inside a cartilage is pushed out along the cartilage's normal with a smoothed
displacement field (the HRA cricoid is an open surface, so inside/outside comes from the nearest face's normal). Then the
thyroid cartilage acts as a one-sided hard wall for every muscle that lies inside the thyroid shield (all but the
cricothyroid, which lies outside it): seen from the laryngeal axis (a vertical line through the cricoid's midline and
the thyroid's mid-depth), no muscle vertex may lie beyond the first thyroid surface the ray meets. Vertices beyond it
are pulled back to CLEAR inside that inner face with a smoothed field (their neighbours follow), and a last pass sets
any remaining one exactly there. This keeps the thyro-arytenoid muscles' anterior ends on the inner face of the thyroid
angle (their attachment) instead of poking through the cartilage's front.
"""
import os, sys, json, re
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, sample_surface, dense_points, face_normals, laplacian_smooth_field, orient_outward, is_closed  # noqa: E402
from lib.register import Sim, icp, Warp  # noqa: E402
from fit.common import get_warp, hra_mesh, hra_select, za_whole, write_group, skin_solid, Solid, FIT  # noqa: E402
from fit.skull_geom import ray_hits_accel  # noqa: E402

# (name, Z-Anatomy source, Z-Anatomy regex, HRA regex). Paired cartilages are matched to the HRA ones by side of x.
CARTILAGES = [
    ('thyroid', 'za-skeletal', r'^Thyroid_cartilage$', r'^VH_F_thyroid_cartilage$'),
    ('cricoid', 'za-skeletal', r'^Cricoid_cartilage$', r'^VH_F_cricoid_cartilage$'),
    ('arytenoid', 'za-skeletal', r'^Arytenoid_cartilage[lr]$', r'^VH_F_arytenoid_cartilage_[LR]$'),
    ('corniculate', 'za-skeletal', r'^Corniculate_cartilage[lr]$', r'^VH_F_corniculate_cartilage_[LR]$'),
    ('epiglottis', 'za-visceral', r'^Epiglottis$', r'^VH_F_epiglott?ic_cartilage$'),
]
MUSCLES = r'(crico-arytenoid|cricothyroid|thyro-arytenoid|arytenoid_muscle)'
SCALE = dict(arytenoid=(0.7, 2.4), corniculate=(0.7, 3.0))     # others: (0.8, 1.25)
CLEAR = 0.0002                                                  # muscle surface kept this far outside cartilage (m)
OPEN_DEPTH = 0.0015                                             # deepest trusted inside reading on an open surface (m)


class Sided:
    """Signed distance (negative inside) and outward direction for an open surface (the HRA cricoid), from dense samples
    with their face normals. Near the tips of thin parts the nearest sample's normal can face away, so readings deeper
    than OPEN_DEPTH count as outside."""

    def __init__(self, v, f, spacing=0.0003, seed=0):
        A = np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1) / 2
        n = int(min(400000, max(2000, A.sum() / spacing ** 2)))
        rng = np.random.default_rng(seed)
        tri = rng.choice(len(f), n, p=A / A.sum())
        r1, r2 = rng.random(n), rng.random(n); s1 = np.sqrt(r1)
        b = np.stack([1 - s1, s1 * (1 - r2), s1 * r2], 1)
        self.p = np.einsum('ij,ijk->ik', b, v[f[tri]])
        self.n = face_normals(v, f)[tri]
        self.tree = cKDTree(self.p)

    def __call__(self, q):
        d, j = self.tree.query(q)
        sgn = np.sign(np.einsum('ij,ij->i', q - self.p[j], self.n[j])); sgn[sgn == 0] = 1
        sgn[(sgn < 0) & (d > OPEN_DEPTH)] = 1
        return sgn * d, self.n[j]


class Closed:
    """Signed distance and outward direction for a closed cartilage, from a fine voxel solid (ray parity)."""

    def __init__(self, v, f, cache):
        self.solid = Solid([(v, f)], h=0.0003, cache=cache)

    def __call__(self, q):
        g = self.solid.gradient(q)
        return self.solid(q), g / np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-9)


def cartilage_field(label, mesh, out_dir):
    v, f = mesh
    return Closed(v, f, os.path.join(out_dir, f'sdf-{label}.npz')) if is_closed(f) else Sided(v, f)


MAX_PUSH = 0.003     # total push per vertex (m): deeper readings on thin plates (thyroid lamina) are sign errors


def push_out(v, f, solids, iters=12):
    """Move muscle vertices out of the cartilages, spreading each push over the neighbouring surface. Only vertices within
    MAX_PUSH of a cartilage surface are pushed, by at most 0.5 mm per step and MAX_PUSH in all."""
    v0, v = v, v.copy()
    for _ in range(iters):
        D = np.zeros_like(v); hit = False
        for sd in solids:
            d, n = sd(v)
            m = (d < CLEAR) & (d > -MAX_PUSH)
            if m.any(): D[m] += np.minimum(CLEAR - d[m], 0.0005)[:, None] * n[m]; hit = True
        if not hit: break
        step = laplacian_smooth_field(f, D, iters=4, lam=0.5) + 0.5 * D
        v = v + step
        moved = v - v0; L = np.linalg.norm(moved, axis=1)
        over = L > MAX_PUSH
        if over.any(): v[over] = v0[over] + moved[over] * (MAX_PUSH / L[over])[:, None]
    return v


OUTSIDE_SHIELD = r'cricothyroid'   # muscles that lie outside the thyroid shield (not held inside it)


class Shield:
    """One-sided wall: the inner face of the thyroid cartilage as seen from the laryngeal axis. For points p, the ray
    from the axis point at p's height towards p; p is beyond the wall when the ray meets the thyroid before reaching p."""

    def __init__(self, thyroid, cricoid):
        self.v, self.f = thyroid
        self.x = float(cricoid[0][:, 0].mean()); self.z = float(thyroid[0][:, 2].mean())
        self.tree = cKDTree(dense_points(*thyroid, 0.0005))

    def __call__(self, p):
        beyond = np.zeros(len(p), bool); tgt = p.copy()
        near = np.flatnonzero(self.tree.query(p, distance_upper_bound=0.008)[0] < 0.008)
        if not len(near): return beyond, tgt
        q = p[near]
        o = np.stack([np.full(len(q), self.x), q[:, 1], np.full(len(q), self.z)], 1)
        dv = q - o; L = np.linalg.norm(dv, axis=1); dirs = dv / np.maximum(L, 1e-9)[:, None]
        t = ray_hits_accel(o, dirs, self.v, self.f, tmax=0.04)
        b = np.isfinite(t) & (t < L + CLEAR)
        beyond[near[b]] = True
        tgt[near[b]] = o[b] + dirs[b] * np.maximum(t[b] - CLEAR, 0.0)[:, None]
        return beyond, tgt


def shield_pull(v, f, shield, iters=8):
    """Pull muscle vertices that lie beyond the thyroid's inner face back inside it, spreading each pull over the
    neighbouring surface (smoothed field), then set any vertex still beyond exactly onto the wall."""
    v = v.copy(); n0 = int(shield(v)[0].sum())
    for _ in range(iters):
        beyond, tgt = shield(v)
        if not beyond.any(): break
        D = np.zeros_like(v); D[beyond] = tgt[beyond] - v[beyond]
        v = v + laplacian_smooth_field(f, D, iters=4, lam=0.5) + 0.6 * D
    beyond, tgt = shield(v)
    v[beyond] = tgt[beyond]
    return v, n0, int(shield(v)[0].sum())


def sided(meshes, mid):
    """{'l'|'r'|'m': mesh}: a pair split about the larynx's own midline x (the larynx is not centred on x = 0)."""
    if len(meshes) == 1: return {'m': meshes[0]}
    a, b = sorted(meshes, key=lambda m: m[0][:, 0].mean())
    if not (a[0][:, 0].mean() < mid < b[0][:, 0].mean()): raise SystemExit('a cartilage pair does not straddle the midline')
    return {'r': a, 'l': b}                                     # +x is the person's left


def outward(v, f):
    return v, orient_outward(v, f)


def pairs(sex, warp):
    """[(label, warped Z-Anatomy mesh, HRA mesh)], one per cartilage and side."""
    za_mid = warp(source('za-skeletal').load(za_whole('za-skeletal', r'^Cricoid_cartilage$'))[0])[:, 0].mean()
    hra_mid = hra_mesh(sex, r'^VH_F_cricoid_cartilage$')[0][:, 0].mean()
    out = []
    for name, src, zrx, hrx in CARTILAGES:
        za = source(src)
        zs = sided([(warp(v), f) for v, f in (za.load([o]) for o in za_whole(src, zrx))], za_mid)
        hs = sided([outward(*source(f'hra-{sex}').load([o])) for o in hra_select(sex, hrx)], hra_mid)
        for k in zs:
            if k not in hs: raise SystemExit(f'{name} {k}: no HRA match')
            out.append((f'{name}_{k}' if k != 'm' else name, zs[k], hs[k]))
    return out


def fit(sex='female'):
    if sex != 'female':
        print(f'{sex}: nothing to fit (the HRA body has its own laryngeal muscles)'); return None
    out_dir = os.path.join(FIT, sex, 'larynx'); os.makedirs(out_dir, exist_ok=True)
    warp = get_warp(sex, 'trunk')
    P = pairs(sex, warp)
    src, dst, rep = [], [], {}
    for label, (zv, zf), (hv, hf) in P:
        H = dense_points(hv, hf, 0.0005); tree = cKDTree(H)
        Z = sample_surface(zv, zf, 3000, seed=1)
        before = tree.query(Z)[0]
        T, err = icp(Z, H, init=Sim(), iters=80, scale=True, trim=0.9, symmetric=True, dst_tree=tree,
                     scale_range=SCALE.get(label.split('_')[0], (0.8, 1.25)))
        S = sample_surface(zv, zf, 400, seed=2)
        d, j = tree.query(T(S))
        src.append(S); dst.append(H[j])
        rep[label] = dict(after_trunk_warp_mean_mm=round(float(before.mean() * 1000), 2), icp_rms_mm=round(err * 1000, 2), icp_scale=round(T.s, 3))
    src, dst = np.concatenate(src), np.concatenate(dst)
    local = Warp(src, dst, smoothing=1e-5)
    # how well the cartilages now match
    for label, (zv, zf), (hv, hf) in P:
        H = dense_points(hv, hf, 0.0005); d = cKDTree(H).query(local(sample_surface(zv, zf, 3000, seed=5)))[0]
        rep[label].update(fit_mean_mm=round(float(d.mean() * 1000), 2), fit_p90_mm=round(float(np.quantile(d, 0.9) * 1000), 2))

    za = source('za-muscular')
    for old in os.listdir(out_dir):
        if old.startswith('sdf-') or old == 'cartilage-sdf.npz': os.remove(os.path.join(out_dir, old))
    solids = [cartilage_field(label, h, out_dir) for label, _, h in P]
    thy = next(h for label, _, h in P if label == 'thyroid'); cri = next(h for label, _, h in P if label == 'cricoid')
    shield = Shield(thy, cri)
    outputs, moved, walled = [], {}, {}
    for o in za_whole('za-muscular', MUSCLES):
        v, f = za.load([o])
        w = local(warp(v)); w2 = push_out(w, f, solids)
        name = o['name'].lower().replace('-', '_')
        if not re.search(OUTSIDE_SHIELD, name):
            w2, nb0, nb1 = shield_pull(w2, f, shield)
            walled[name] = dict(vertices_beyond_thyroid_inner_face_before=nb0, after=nb1)
        moved[name] = round(float(np.linalg.norm(w2 - w, axis=1).max() * 1000), 2)
        outputs.append(dict(name=name, part='larynx_muscles', mesh=(w2, f), source=[o['name']]))

    # acceptance: cartilage registration, muscles inside the skin and not buried in cartilage
    sk = skin_solid(sex)
    musc = {}
    for o in outputs:
        p = sample_surface(*o['mesh'], 2000, seed=3)
        dc = np.min([sd(p)[0] for sd in solids], axis=0)
        musc[o['name']] = dict(inside_skin=round(float((sk(p) < 0).mean()), 4), in_cartilage_frac=round(float((dc < -0.0005).mean()), 4),
                               deepest_in_cartilage_mm=round(float(max(0.0, -dc.min()) * 1000), 2), pushed_out_max_mm=moved[o['name']])
        if o['name'] in walled:
            # surface samples (not only vertices) beyond the thyroid's inner face, as seen from the laryngeal axis
            b, tg = shield(p)
            musc[o['name']].update(walled[o['name']], surface_samples_beyond_thyroid_inner_face=int(b.sum()),
                                   deepest_beyond_mm=round(float(np.linalg.norm(p[b] - tg[b], axis=1).max() * 1000), 2) if b.any() else 0.0)
    worst_fit = max(r['fit_p90_mm'] for r in rep.values())
    worst_in = max(m['in_cartilage_frac'] for m in musc.values())
    deepest = max(m['deepest_in_cartilage_mm'] for m in musc.values())
    report = dict(sex=sex, cartilages=rep, muscles=musc,
                  criteria=dict(cartilage_fit_p90_mm=dict(value=worst_fit, threshold=1.5, ok=worst_fit <= 1.5),
                                # muscles insert into the cartilages they move; where the HRA cartilages are larger than
                                # Z-Anatomy's (the arytenoids) the muscles between them overlap their attachments slightly
                                muscle_in_cartilage_deepest_mm=dict(value=deepest, threshold=2.5, ok=deepest <= 2.5),
                                muscle_in_cartilage_frac=dict(value=worst_in, threshold=0.25, ok=worst_in <= 0.25),
                                                muscles_inside_skin=dict(value=min(m['inside_skin'] for m in musc.values()), threshold=1.0,
                                                         ok=all(m['inside_skin'] == 1.0 for m in musc.values())),
                                # the muscles inside the thyroid shield stay behind its inner face (one-sided wall)
                                internal_muscle_samples_beyond_thyroid_inner_face_deepest_mm=dict(
                                    value=max(m.get('deepest_beyond_mm', 0.0) for m in musc.values()), threshold=0.5,
                                    ok=max(m.get('deepest_beyond_mm', 0.0) for m in musc.values()) <= 0.5)))
    report['ok'] = all(c['ok'] for c in report['criteria'].values())
    write_group(sex, 'larynx', outputs, report)
    qa(sex, P, outputs, local, out_dir)
    print(json.dumps(report['criteria'], indent=1)); print('muscles', len(outputs))
    return report


def qa(sex, P, outputs, local, out_dir):
    from lib.qa import render_views, FRONT, BACK, LEFT
    items = [dict(mesh=h, color='#d8d2c0', opacity=0.55) for _, _, h in P]
    items += [dict(mesh=o['mesh'], color='#b5473b') for o in outputs]
    c = np.concatenate([h[0] for _, _, h in P]).mean(0)
    render_views(items, {'front': dict(FRONT, target=c, radius=0.035), 'back': dict(BACK, target=c, radius=0.035),
                         'left': dict(LEFT, target=c, radius=0.035)}, os.path.join(out_dir, 'qa'))


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    for sex in (['male', 'female'] if which == 'all' else [which]):
        fit(sex)
