"""Shared fitting machinery: anchor pairs, the global similarity and the smooth warps from Z-Anatomy space into an HRA body.

Every warp maps Z-Anatomy coordinates (metres, as extracted) into the HRA body's own coordinates (metres, as extracted).
The app frame (floor at y = 0) is applied later, in assemble.py.
"""
import os, re, sys, json
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, area, sample_surface, dense_points, save, load, CACHE  # noqa: E402
from lib.register import Sim, umeyama, icp, Warp  # noqa: E402
from catalog import ANCHORS  # noqa: E402

FIT = os.path.join(CACHE, 'fit')


def hra_select(sex, sel):
    s = source(f'hra-{sex}')
    if isinstance(sel, tuple) and sel[0] == 'path':
        return s.select(sel[1], path=True)
    return s.select(sel)


def anchor_meshes(sex, region=None, keys=None):
    """{key: dict(za=(v,f), hra=(v,f), region, weight)} for anchors present in this body."""
    out = {}
    for key, reg, zsrc, zrx, hsel, w in ANCHORS:
        if region and reg != region and not (isinstance(region, (tuple, list)) and reg in region): continue
        if keys and key not in keys: continue
        z = source(zsrc).select(zrx); h = hra_select(sex, hsel)
        if not z or not h: continue
        out[key] = dict(za=source(zsrc).load(z), hra=source(f'hra-{sex}').load(h), region=reg, weight=w)
    return out


def global_similarity(anchors):
    """Weighted similarity between anchor centroids (ZA -> HRA)."""
    P, Q, W = [], [], []
    for a in anchors.values():
        P.append(a['za'][0].mean(0)); Q.append(a['hra'][0].mean(0)); W.append(a['weight'])
    return umeyama(np.array(P), np.array(Q), scale=True, w=np.array(W))


def anchor_controls(anchors, T0, per_area=6.0, nmin=25, nmax=300, seed=0, report=None):
    """Control-point pairs: Z-Anatomy surface samples -> their place on the matching HRA surface.
    Each anchor is first aligned on its own (similarity ICP), then each aligned sample is projected onto the HRA
    surface, which carries the shape difference into the warp."""
    src, dst, wts = [], [], []
    for key, a in anchors.items():
        zv, zf = a['za']; hv, hf = a['hra']
        n = int(np.clip(np.sqrt(area(zv, zf) * 1e4) * per_area * a['weight'] ** 0.5, nmin, nmax))
        P = sample_surface(zv, zf, n, seed=seed)
        Hd = dense_points(hv, hf, 0.0015); tree = cKDTree(Hd)
        Z = sample_surface(zv, zf, min(4000, 30 * n), seed=seed + 1)
        Ta, err = icp(Z, Hd, init=T0, iters=60, scale=True, trim=0.9, symmetric=True, dst_tree=tree)
        d, j = tree.query(Ta(P))
        src.append(P); dst.append(Hd[j]); wts.append(np.full(n, a['weight']))
        if report is not None: report[key] = dict(icp_rms_mm=round(err * 1000, 2), scale=round(Ta.s, 4), n=n, proj_mean_mm=round(float(d.mean() * 1000), 2))
    return np.concatenate(src), np.concatenate(dst), np.concatenate(wts)


def residuals(warp, anchors):
    """Distance (mm) from warped Z-Anatomy anchor samples to the matching HRA surface: mean and 90th percentile."""
    out = {}
    for key, a in anchors.items():
        zv, zf = a['za']; hv, hf = a['hra']
        P = warp(sample_surface(zv, zf, 2000, seed=7))
        d, _ = cKDTree(dense_points(hv, hf, 0.0015)).query(P)
        out[key] = (round(float(d.mean() * 1000), 1), round(float(np.quantile(d, 0.9) * 1000), 1))
    return out


def build_warp(sex, region, smoothing=2e-4, extra=None, keys=None, report_path=None):
    """Fit the warp for one region of one body. `extra` adds (src, dst) control pairs (e.g. skin)."""
    anchors = anchor_meshes(sex, region=region, keys=keys)
    T0 = global_similarity(anchors)
    rep = {}
    src, dst, w = anchor_controls(anchors, T0, report=rep)
    if extra is not None:
        es, ed = extra; src = np.concatenate([src, es]); dst = np.concatenate([dst, ed])
    warp = Warp(src, dst, pre=T0, smoothing=smoothing)
    res = residuals(warp, anchors)
    if report_path:
        os.makedirs(os.path.dirname(report_path), exist_ok=True)
        json.dump(dict(sex=sex, region=region, global_similarity=repr(T0), anchors={k: dict(rep[k], fit_mean_p90_mm=res[k]) for k in rep}),
                  open(report_path, 'w'), indent=1)
    return warp, anchors, T0, res


def za_whole(src, pattern, exclude=None):
    """Z-Anatomy whole structures (not label patches) whose name matches."""
    s = source(src)
    es = [o for o in s.select(pattern, exclude=exclude) if o['name'][-1:] not in 'ji']
    return es


def warp_mesh(warp, mesh):
    v, f = mesh
    return warp(v), f


def out_path(sex, name):
    return os.path.join(FIT, sex, name + '.npz')


# ------------------------------------------------------------------------------------------------ cached warps
def get_warp(sex, region='trunk', smoothing=1e-4, rebuild=False):
    """The region warp for a body, cached as its control points in .cache/fit/<sex>/warp-<region>.npz."""
    path = os.path.join(FIT, sex, f'warp-{region}.npz')
    if os.path.exists(path) and not rebuild:
        d = np.load(path)
        T0 = Sim(float(d['s']), d['R'], d['t'])
        return Warp(d['src'], d['dst'], pre=T0, smoothing=float(d['smoothing']), max_points=10 ** 9)
    anchors = anchor_meshes(sex, region=region)
    T0 = global_similarity(anchors)
    rep = {}
    src, dst, _ = anchor_controls(anchors, T0, report=rep)
    warp = Warp(src, dst, pre=T0, smoothing=smoothing)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # store exactly the (deduplicated, subsampled) centres the warp was fitted to, so reloading reproduces it
    np.savez(path, src=T0.inverse()(warp.centres), dst=warp.centres + warp.rbf(warp.centres), s=T0.s, R=T0.R, t=T0.t, smoothing=smoothing)
    res = residuals(warp, anchors)
    json.dump(dict(sex=sex, region=region, global_similarity=repr(T0), anchors={k: dict(rep[k], fit_mean_p90_mm=res[k]) for k in rep}),
              open(os.path.join(FIT, sex, f'warp-{region}-report.json'), 'w'), indent=1)
    return warp


# ------------------------------------------------------------------------------------------------ inside / collision tests
from lib.mesh import Grid, grid_for, sample_grid  # noqa: E402


def hra_mesh(sex, sel, exclude=None):
    """Merged HRA mesh for a selector: a name regex, or ('path', regex)."""
    from catalog import HRA_EXCLUDE
    es = [o for o in hra_select(sex, sel) if not re.search(HRA_EXCLUDE, o['path'])]
    if exclude: es = [o for o in es if not re.search(exclude, o['path'])]
    return source(f'hra-{sex}').load(es)


def skin(sex):
    return hra_mesh(sex, r'^VH_[MF]_skin$')


class Solid:
    """Signed distance (metres, negative inside) to a set of closed meshes, from a cached voxel grid."""

    def __init__(self, meshes, h=0.002, cache=None):
        if cache and os.path.exists(cache):
            d = np.load(cache); self.lo, self.h, self.sdf = d['lo'], float(d['h']), d['sdf']
        else:
            g = grid_for(meshes, h)
            self.lo, self.h, self.sdf = g.lo, h, g.sdf().astype(np.float32)
            if cache: os.makedirs(os.path.dirname(cache), exist_ok=True); np.savez(cache, lo=self.lo, h=self.h, sdf=self.sdf)
        self._g = type('G', (), dict(lo=self.lo, h=self.h))()

    def __call__(self, p):
        return sample_grid(self.sdf, self._g, p)

    def gradient(self, p, e=None):
        e = e or self.h
        out = np.zeros((len(p), 3))
        for a in range(3):
            d = np.zeros(3); d[a] = e
            out[:, a] = (self(p + d) - self(p - d)) / (2 * e)
        return out


def skin_solid(sex):
    return Solid([skin(sex)], h=0.003, cache=os.path.join(FIT, sex, 'skin-sdf.npz'))


def penetration(mesh, solid, n=5000):
    """(fraction of mesh surface samples inside `solid`, deepest penetration in mm)."""
    v, f = mesh
    p = sample_surface(v, f, n, seed=3)
    d = solid(p)
    inside = d < 0
    return float(inside.mean()), float(-d.min() * 1000) if inside.any() else 0.0


def write_group(sex, group, outputs, report=None):
    """Save fitted structures for assemble.py: .cache/fit/<sex>/<group>/<name>.npz plus manifest.json.
    outputs: list of dict(name, part, mesh=(v, f), source=[Z-Anatomy names], tissue=optional override)."""
    d = os.path.join(FIT, sex, group)
    os.makedirs(d, exist_ok=True)
    man = []
    for o in outputs:
        v, f = o['mesh']
        save(os.path.join(d, o['name'] + '.npz'), v, f)
        man.append(dict(name=o['name'], file=o['name'] + '.npz', part=o['part'], tissue=o.get('tissue'), source=o.get('source', []),
                        verts=int(len(v)), tris=int(len(f))))
    json.dump(man, open(os.path.join(d, 'manifest.json'), 'w'), indent=1)
    if report is not None: json.dump(report, open(os.path.join(d, 'report.json'), 'w'), indent=1)
    return d
