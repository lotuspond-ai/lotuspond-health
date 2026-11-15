"""Organs fit, part 12: the lungs as closed solids (the diaphragm's thoracic neighbours).

The HRA lungs are the bronchopulmonary segments of each lobe: separate, overlapping patches whose union is the lobe. A
voxel flood fill of them leaks (and the field is cropped to the lung bases, so every lobe is open where the crop cuts
it), and ray parity counts a point inside two overlapping segments as outside: the old field read 'outside' over most
of the lung bases, so neither the diaphragm fit nor its report saw the lungs there (the final check measured 14-15 %
of the diaphragm inside the lung bases, up to 18.6 mm deep, where the report said 3.9-5.1 % / 2.3 mm).

  lung_lobes(sex)    {lobe: (v, f)} one closed, outward-wound surface per lobe in the HRA body's frame: the lobes as
                     assemble.py ships them (.cache/parts/<sex>/lung_*.npz: the segments rebuilt as one solid per lobe,
                     0.6 mm clefts between lobes, carved round the heart, aorta, SVC, thymus and liver + 3 mm), minus
                     the rig offset; without an assembled build, the HRA segments of each lobe with their boundary loops
                     capped (the volume check below then tells whether that is good enough)
  lung_field(sex)    signed distance to the union of the lobes, filled by ray parity (majority of x, y and z, which
                     stays right where the crop cuts the lobes open); asserted: the field's inside volume equals the
                     lobes' exact volume in the same box within VOL_TOL
  LungBed            the lungs as the diaphragm meets them: a point inside a lung leaves it downwards (the sheet lies
                     under the lung bases), through the nearest surface only where that surface faces down
  lung_base(sex)     samples of the lungs' diaphragmatic surfaces (for the fit's report)
  exact_inside(...)  ray parity on the closed lobes (three directions, majority), for the report's exact measurement
"""
import os, json
import numpy as np
from scipy.spatial import cKDTree

from lib.mesh import load, merge, orient_outward, sample_surface, signed_volume
from fit.common import FIT
from fit.organs_data import hra, LOBES, cache_dir, log
from fit.organs_geom import Field, cap_loops

PARTS = os.path.join(os.path.dirname(FIT), 'parts')
FIELD_H = 0.001
CROP_UP = 0.17            # the field covers the lowest 17 cm of the lungs (the bases)
VOL_TOL = 0.03            # field inside volume vs exact lobe volume in the field's box

_LOBES = {}


def lung_lobes(sex):
    """({lobe: (v, f)}, source label, stamp) closed lobes in the HRA frame (see the module docstring)."""
    if sex in _LOBES: return _LOBES[sex]
    rig = os.path.join(PARTS, sex, 'rig.json')
    files = [os.path.join(PARTS, sex, f'{k}.npz') for k in LOBES]
    if os.path.exists(rig) and all(os.path.exists(p) for p in files):
        off = np.array(json.load(open(rig))['offset'], float)
        lob = {}
        for k, p in zip(LOBES, files):
            # the assembled lobes are wound consistently outwards already (orient_outward, which propagates winding
            # across manifold edges only, mis-orients the left lobes at their few non-manifold edges)
            v, f = load(p); v = v - off
            if signed_volume(v, f) < 0: f = f[:, ::-1].copy()
            lob[k] = (v, f)
        stamp = 'parts' + str(int(max(os.stat(p).st_mtime for p in files + [rig])))
        out = (lob, 'assembled lobes (.cache/parts, minus the rig offset)', stamp)
    else:
        lob = {}
        for k in LOBES:
            v, f = hra(sex, k); v, f = cap_loops(v, f); lob[k] = (v, orient_outward(v, f))
        out = (lob, 'HRA lobe segments, boundary loops capped', 'hra')
    _LOBES[sex] = out
    return out


def volume_below(v, f, y0):
    """Exact volume of the closed mesh (v, f) below the plane y = y0: the signed tetrahedra from a point on the plane
    to every triangle clipped to y < y0 (the cap the plane cuts lies in the plane and adds nothing)."""
    o = np.array([v[:, 0].mean(), y0, v[:, 2].mean()])
    T = v[f] - o
    below = T[:, :, 1] < 0
    vol = 0.0
    nb = below.sum(1)
    full = nb == 3
    vol += np.einsum('ij,ij->i', T[full, 0], np.cross(T[full, 1], T[full, 2])).sum() / 6
    for k in (1, 2):
        sel = np.flatnonzero(nb == k)
        for t in sel:
            P = T[t]; poly = []
            for i in range(3):
                a, b = P[i], P[(i + 1) % 3]
                if a[1] < 0: poly.append(a)
                if (a[1] < 0) != (b[1] < 0):
                    s = a[1] / (a[1] - b[1]); poly.append(a + s * (b - a))
            for i in range(1, len(poly) - 1):
                vol += np.dot(poly[0], np.cross(poly[i], poly[i + 1])) / 6
    return float(vol)


def lung_field(sex):
    """Signed distance to the closed lobes' union (cropped to the bases), cached and checked against the exact volume."""
    lob, label, stamp = lung_lobes(sex)
    v, f = merge(list(lob.values()))
    tag = f'lungs-closed-{stamp}'
    cd = cache_dir(sex)
    for old in os.listdir(cd):              # the stale (leaking) lung fields and lung-base samples
        if (old.startswith('field-lungs') and old != f'field-{tag}.npz') or (old.startswith('lung-base') and old != f'lung-base-{stamp}.npz'):
            os.remove(os.path.join(cd, old)); log(sex, f'removed stale {old}')
    crop = (v.min(0) - 0.02, np.array([9, v[:, 1].min() + CROP_UP, 9]))
    path = os.path.join(cd, f'field-{tag}.npz')
    fl = None
    if os.path.exists(path):
        d = np.load(path)
        if int(d['nv']) == len(v) and int(d['nf']) == len(f): fl = Field(v, f, d['lo'], float(d['h']), d['sdf'].astype(np.float32))
    if fl is None:
        fl = parity_field(v, f, FIELD_H, crop)
        np.savez(path, lo=fl.lo, h=fl.h, sdf=fl.sdf.astype(np.float16), nv=len(v), nf=len(f))
    # the field's inside volume against the exact volume of the lobes in the field's box (it starts below the lungs
    # and spans them sideways, so only its top plane cuts them)
    y_top = fl.lo[1] + FIELD_H * (fl.sdf.shape[1] - 1) + 0.5 * FIELD_H
    exact = sum(volume_below(*m, y_top) for m in lob.values())
    vox = float((fl.sdf < 0).sum()) * FIELD_H ** 3
    fl.volume_check = dict(source=label, field_inside_cm3=round(vox * 1e6, 1), lobes_exact_cm3=round(exact * 1e6, 1),
                           ratio=round(vox / exact, 4), box_top_y=round(float(y_top), 4), h_mm=FIELD_H * 1000, tolerance=VOL_TOL)
    log(sex, 'lung field', fl.volume_check)
    assert abs(vox / exact - 1) <= VOL_TOL, f'{sex}: lung field inside volume {vox * 1e6:.1f} cm3 vs lobes {exact * 1e6:.1f} cm3'
    return fl


def parity_field(v, f, h, crop, pad=0.012):
    """Field.build for a closed surface, inside by ray parity alone (majority of x, y and z): unlike the flood fill it
    stays right where the crop cuts the lobes open, and it does not count the voxels the surface passes through as
    inside (an outward bias of half a voxel)."""
    from scipy import ndimage
    from fit.organs_geom import _parity_fill
    lo = np.maximum(v.min(0) - pad, crop[0]); hi = np.minimum(v.max(0) + pad, crop[1])
    n = np.ceil((hi - lo) / h).astype(int) + 1
    occ = (_parity_fill(v, f, lo, h, n, 0).astype(np.int8) + _parity_fill(v, f, lo, h, n, 1) + _parity_fill(v, f, lo, h, n, 2)) >= 2
    sdf = (ndimage.distance_transform_edt(~occ) - ndimage.distance_transform_edt(occ)).astype(np.float32) * h
    sdf = sdf - np.sign(sdf) * 0.5 * h
    return Field(v, f, lo, h, sdf)


class LungBed:
    """The lungs as the diaphragm meets them. A point inside a lung leaves it through the nearest surface where that
    surface faces down (the lung base), else straight down (a dome pushed up into a lower lobe, with lung tissue below
    it, goes back under the base, not out through the lobe's posterior or lateral wall), with the outward normal at the
    exit; points outside use the closest surface as usual. Field-like: coarse, __call__, outward."""

    DOWN = np.array([0.0, -1.0, 0.0])

    def __init__(self, fl, step=0.0005, reach=0.06):
        self.fl, self.step, self.reach = fl, step, reach

    def coarse(self, p):
        return self.fl.coarse(p)

    def __call__(self, p, band=None):
        return self.fl(p)

    def outward(self, p):
        p = np.asarray(p, float)
        n, q = self.fl.outward(p)
        ins = (self.fl(p) < 0) & (n[:, 1] > -0.5)
        if not ins.any(): return n, q
        P = p[ins]; t = np.zeros(len(P)); act = np.ones(len(P), bool)
        while act.any() and t.max() < self.reach:
            t[act] += self.step
            act[act] = self.fl.coarse(P[act] + t[act, None] * self.DOWN) < 0
        lo, hi = np.maximum(t - self.step, 0.0), t.copy()
        for _ in range(5):
            mid = 0.5 * (lo + hi); inside = self.fl(P + mid[:, None] * self.DOWN) < 0
            lo = np.where(inside, mid, lo); hi = np.where(inside, hi, mid)
        Q = P + hi[:, None] * self.DOWN
        nq, _ = self.fl.outward(Q)
        nq = nq.copy(); nq[nq[:, 1] > -0.2] = self.DOWN
        ok = ~act                                          # found an exit below within reach
        idx = np.flatnonzero(ins)[ok]
        n = n.copy(); q = q.copy(); n[idx] = nq[ok]; q[idx] = Q[ok]
        return n, q


def lung_base(sex):
    """Samples of the lungs' diaphragmatic surfaces on the closed lobes: downward-facing surface (normal y < -0.5), not
    on a fissure (>= 4 mm from another lobe), the lowest lung surface in its 4 mm column, below the heart's top."""
    lob, label, stamp = lung_lobes(sex)
    path = os.path.join(cache_dir(sex), f'lung-base-{stamp}.npz')
    if os.path.exists(path): return np.load(path)['p']
    from fit.organs_data import field
    P = []
    for k, (v, f) in lob.items():
        a = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
        ar = 0.5 * np.linalg.norm(a, axis=1); nrm = a / np.maximum(2 * ar, 1e-20)[:, None]
        rng = np.random.default_rng(1)
        t = rng.choice(len(f), size=30000, p=ar / ar.sum())
        r1, r2 = rng.random(len(t)), rng.random(len(t)); s = np.sqrt(r1)
        p = (1 - s)[:, None] * v[f[t, 0]] + (s * (1 - r2))[:, None] * v[f[t, 1]] + (s * r2)[:, None] * v[f[t, 2]]
        others = np.concatenate([lob[o][0] for o in lob if o != k])
        dz, _ = cKDTree(others).query(p)
        P.append(p[(nrm[t, 1] < -0.5) & (dz > 0.004)])
    P = np.concatenate(P)
    allv = np.concatenate([m[0] for m in lob.values()])
    key = np.floor(allv[:, [0, 2]] / 0.004).astype(np.int64)
    low = {}
    for kk, y in zip(map(tuple, key), allv[:, 1]):
        if y < low.get(kk, 9): low[kk] = y
    kp = np.floor(P[:, [0, 2]] / 0.004).astype(np.int64)
    lowest = np.array([low.get(tuple(k), 9) for k in kp])
    P = P[P[:, 1] < lowest + 0.012]
    hd = field(sex, 'heart')(P)
    P = P[(hd > 0.015) & (P[:, 1] < hra(sex, 'heart')[0][:, 1].min() + 0.03)]
    np.savez(path, p=P)
    return P


_RP = {}


def exact_inside(sex, P):
    """Inside the closed lobes by ray parity (lib.mesh.RayParity: rays along +z, +x and +y, majority vote; the lobes
    do not overlap, so their union's parity is the union's inside)."""
    from lib.mesh import RayParity
    if sex not in _RP: _RP[sex] = RayParity(*merge(list(lung_lobes(sex)[0].values())))
    return _RP[sex].inside(np.asarray(P, float))


def lungs_exact_pair(sex, mesh, n=40000, seed=3, near=0.0015):
    """Diaphragm x lungs, exact: surface samples the field puts inside or within `near` of the lobes are tested by ray
    parity on the closed lobes; depth is the exact closest-point distance to the lobe surface. Returns a dict."""
    from fit.organs_data import field
    fl = field(sex, 'lungs')
    p = sample_surface(*mesh, n, seed=seed)
    d = fl(p)
    cand = np.flatnonzero(d < near)
    ins = np.zeros(len(p), bool)
    if len(cand): ins[cand] = exact_inside(sex, p[cand])
    dep = np.zeros(len(p))
    if ins.any():
        _, dd, _ = fl.closest(p[ins], k=16); dep[ins] = dd
    frac = float(ins.mean() * 100)
    deepest = float(dep.max() * 1000) if ins.any() else 0.0
    res = dict(inside_pct=round(frac, 3), deepest_mm=round(deepest, 2), over_1mm_pct=round(float((dep > 0.001).mean() * 100), 3),
               over_3mm_pct=round(float((dep > 0.003).mean() * 100), 3),
               field_inside_pct=round(float((d < 0).mean() * 100), 3), samples=int(n), tested_exactly=int(len(cand)),
               method='surface samples within 1.5 mm of (or inside) the lung field tested by ray parity on the closed lobes '
                      '(3 directions, majority); depth = exact closest-point distance to the lobe surface')
    if ins.any():
        k = int(np.argmax(dep)); res['deepest_at'] = np.round(p[k], 4).tolist()
    return res
