"""Ribcage fit, part 1: inputs and cached intermediates.

  warped(sex)    the Z-Anatomy ribs, costal cartilages, sternum and thoracic vertebrae through the cached trunk warp
                 (the warp takes minutes to build on a busy machine, so the result is cached, keyed by the warp file)
  targets(sex)   HRA structures the fit is measured against: lung lobes (rebuilt from their segments exactly as
                 assemble.py does), heart, liver, spleen, kidneys, great vessels, vertebrae, sacrum and skin, each as a
                 closed surface with a voxel signed-distance field
Everything is cached under .cache/fit/<sex>/ribcage/cache/.
"""
import os, re, sys, json, time
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import (source, merge, compact, orient_outward, remesh_solid, dense_points, closest_on_mesh,  # noqa: E402
                      face_normals, sample_grid)
from fit.common import FIT, hra_mesh, skin  # noqa: E402
from catalog import LOBE_PATH, HRA_EXCLUDE  # noqa: E402

GROUP = 'ribcage'
ORD = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth']
SIDES = 'lr'                      # Z-Anatomy suffixes: l = the person's left (+x), r = right (-x)


def out_dir(sex):
    return os.path.join(FIT, sex, GROUP)


def cache_dir(sex):
    d = os.path.join(out_dir(sex), 'cache'); os.makedirs(d, exist_ok=True); return d


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


# ------------------------------------------------------------------------------------------------ Z-Anatomy inputs
def za_structures():
    """{key: Z-Anatomy name}. Keys: rib_<n>_<s>, cart_<n>_<s>, manubrium, sternum_body, xiphoid, za_T<n> (+ C7, L1)."""
    out = {}
    for n in range(1, 13):
        for s in SIDES:
            out[f'rib_{n}_{s}'] = f'{ORD[n - 1]}_rib{s}'
            if n <= 10: out[f'cart_{n}_{s}'] = f'Costal_cartilage_of_{ORD[n - 1].lower()}_rib{s}'
    out.update(manubrium='Manubrium_of_sternum', sternum_body='Body_of_sternum', xiphoid='Xiphoid_process')
    for k in ['C7'] + [f'T{i}' for i in range(1, 13)] + ['L1']:
        out[f'za_{k}'] = {'C7': 'Vertebra_C7', 'L1': 'Vertebra_L1'}.get(k, f'Vertebra_{k}')
    return out


def za_meshes():
    """Z-Anatomy meshes in their own space, outward-oriented, unreferenced vertices dropped."""
    s = source('za-skeletal')
    out = {}
    for key, name in za_structures().items():
        v, f = compact(*s.get(name))
        out[key] = (v, orient_outward(v, f))
    return out


def _warp_key(sex):
    p = os.path.join(FIT, sex, 'warp-trunk.npz')
    st = os.stat(p)
    return f'{int(st.st_mtime)}-{st.st_size}'


def warped(sex):
    """{key: (v_hra, f)}: every Z-Anatomy input through get_warp(sex, 'trunk'), plus the unwarped originals as
    {key: (v_za, f)} under the second return value."""
    za = za_meshes()
    path = os.path.join(cache_dir(sex), 'warped.npz')
    key = _warp_key(sex)
    if os.path.exists(path):
        d = np.load(path)
        if str(d['key']) == key and all(f'{k}.v' in d for k in za):
            return {k: (d[f'{k}.v'].astype(np.float64), za[k][1]) for k in za}, za
    from fit.common import get_warp
    log(sex, 'building the trunk warp (cached afterwards)')
    w = get_warp(sex, 'trunk')
    keys = list(za)
    allv = np.concatenate([za[k][0] for k in keys])
    log(sex, f'warping {len(allv)} vertices')
    wv = w(allv)
    out, i = {}, 0
    for k in keys:
        n = len(za[k][0]); out[k] = (wv[i:i + n], za[k][1]); i += n
    np.savez(path, key=key, **{f'{k}.v': out[k][0].astype(np.float32) for k in keys})
    log(sex, 'warp cached')
    return {k: (v.astype(np.float32).astype(np.float64), f) for k, (v, f) in out.items()}, za


# ------------------------------------------------------------------------------------------------ voxel solids
from lib.mesh import _closest_point_triangle  # noqa: E402


def closest_faces(v, f, p, k=8, tree=None):
    """Exact closest points on a triangle mesh with the triangle they lie on: (q, d, t)."""
    p = np.asarray(p, float)
    A, B, C = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    tree = tree or cKDTree((A + B + C) / 3)
    _, cand = tree.query(p, k=min(k, len(f)))
    if cand.ndim == 1: cand = cand[:, None]
    best_d = np.full(len(p), np.inf); best_q = np.zeros_like(p); best_t = np.zeros(len(p), np.int64)
    for j in range(cand.shape[1]):
        t = cand[:, j]
        q = _closest_point_triangle(p, A[t], B[t], C[t])
        d = np.linalg.norm(q - p, axis=1)
        m = d < best_d; best_d[m] = d[m]; best_q[m] = q[m]; best_t[m] = t[m]
    return best_q, best_d, best_t


class Part:
    """One closed (or patch) surface with cached search structures."""

    def __init__(self, v, f):
        self.v, self.f = v, f
        self.tree = cKDTree(v[f].mean(1))
        self.fn = face_normals(v, f)

    def unsigned(self, p, k=8):
        return closest_faces(self.v, self.f, p, k=k, tree=self.tree)[1]

    def closest(self, p, k=8):
        q, d, _ = closest_faces(self.v, self.f, p, k=k, tree=self.tree)
        return q, d

    def signed(self, p, k=8):
        """Signed by the closest triangle's outward normal (closed, outward-wound meshes)."""
        q, d, t = closest_faces(self.v, self.f, p, k=k, tree=self.tree)
        return np.where(np.einsum('ij,ij->i', p - q, self.fn[t]) < 0, -d, d)


def _rasterise(shape, lo, h, meshes, close=2, opening=0):
    v, f = merge(meshes)
    shell = np.zeros(shape, bool)
    pts = dense_points(v, f, spacing=h * 0.45)
    ijk = np.round((pts - lo) / h).astype(int)
    ok = np.all((ijk >= 0) & (ijk < np.array(shape)), axis=1); ijk = ijk[ok]
    shell[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    st = ndimage.generate_binary_structure(3, 1)
    if close:
        solid = ndimage.binary_fill_holes(ndimage.binary_dilation(shell, st, iterations=close))
        solid = ndimage.binary_erosion(solid, st, iterations=close) | shell
    else:
        solid = shell
    solid = ndimage.binary_fill_holes(solid)
    if opening: solid = ndimage.binary_opening(solid, st, iterations=opening)
    return solid


def _occ_sdf(occ, h):
    sdf = (ndimage.distance_transform_edt(~occ) - ndimage.distance_transform_edt(occ)) * h
    return np.where(occ, sdf + 0.5 * h, sdf - 0.5 * h).astype(np.float32)


BAND = 2.5      # voxels around a surface where the field holds exact distances


def build_field(meshes, h, mode='normal', close=2, opening=0, pad=0.012):
    """Signed distance field of the union of `meshes`. mode 'normal': each mesh is a closed, outward-wound surface and
    the band holds exact signed distances (union = min over meshes); mode 'occ': the meshes are patches of one solid,
    the band holds exact unsigned distances signed by the voxel occupancy."""
    v, f = merge(meshes)
    lo = v.min(0) - pad - (close + 2) * h; hi = v.max(0) + pad + (close + 2) * h
    shape = tuple(np.ceil((hi - lo) / h).astype(int) + 1)
    if mode == 'occ':
        occ = _rasterise(shape, lo, h, meshes, close=close, opening=opening)
        sdf = _occ_sdf(occ, h)
        band = np.argwhere(np.abs(sdf) < BAND * h)
        p = lo + band * h
        part = Part(v, f)
        d = part.unsigned(p)
        sdf[band[:, 0], band[:, 1], band[:, 2]] = np.where(sdf[band[:, 0], band[:, 1], band[:, 2]] < 0, -d, d)
        return Field(lo, h, sdf)
    out = None
    fixed = []
    for m in meshes:
        occ = _rasterise(shape, lo, h, [m], close=1)
        sdf = _occ_sdf(occ, h)
        m = (m[0], orient_by_field(m[0], m[1], Field(lo, h, sdf)))
        fixed.append(m)
        band = np.argwhere(np.abs(sdf) < BAND * h)
        p = lo + band * h
        d = Part(*m).signed(p)
        occ_sign = sdf[band[:, 0], band[:, 1], band[:, 2]]
        # trust the triangle normal near the surface, the occupancy further in (normals can mislead at sharp edges)
        d = np.where((np.abs(d) > 1.2 * h) & (np.sign(d) != np.sign(occ_sign)), np.sign(occ_sign) * np.abs(d), d)
        sdf[band[:, 0], band[:, 1], band[:, 2]] = d
        out = sdf if out is None else np.minimum(out, sdf)
    fld = Field(lo, h, out)
    fld.fixed = fixed                       # the meshes with every face turned outward
    return fld


def orient_by_field(v, f, fld):
    """Turn each face so its normal points out of the solid (along the field's gradient). Robust where surface
    extraction left non-manifold edges and winding-based orientation fails."""
    fn = face_normals(v, f)
    c = v[f].mean(1)
    g = fld.grad(c, e=fld.h)
    flip = np.einsum('ij,ij->i', fn, g) < 0
    f = f.copy(); f[flip] = f[flip][:, ::-1]
    return f


class Field:
    """Signed distance (m, negative inside) on a voxel grid, trilinearly sampled."""

    def __init__(self, lo, h, sdf):
        self.lo, self.h, self.sdf = np.asarray(lo, float), float(h), sdf.astype(np.float32)
        self.hi = self.lo + h * (np.array(sdf.shape) - 1)

    def __call__(self, p):
        p = np.asarray(p, float)
        q = ((p - self.lo) / self.h).T
        out = ndimage.map_coordinates(self.sdf, q, order=1, mode='nearest')
        # outside the grid: a positive lower bound on the distance
        far = np.any((p < self.lo) | (p > self.hi), axis=1)
        if far.any():
            c = np.clip(p[far], self.lo, self.hi)
            out[far] = np.maximum(out[far], np.linalg.norm(p[far] - c, axis=1))
        return out

    def grad(self, p, e=None):
        e = e or self.h * 0.75
        g = np.zeros((len(p), 3))
        for a in range(3):
            d = np.zeros(3); d[a] = e
            g[:, a] = (self(p + d) - self(p - d)) / (2 * e)
        n = np.linalg.norm(g, axis=1, keepdims=True)
        return g / np.maximum(n, 1e-9)

    def save(self, path):
        np.savez_compressed(path, lo=self.lo, h=self.h, sdf=self.sdf)

    @staticmethod
    def load(path):
        d = np.load(path); return Field(d['lo'], float(d['h']), d['sdf'])


class Target:
    """An HRA solid: its surface parts and a signed distance field (exact within BAND voxels of the surface)."""

    def __init__(self, name, parts, field, mode):
        self.name, self.field, self.mode = name, field, mode
        self.parts = [Part(v, f) for v, f in parts]
        self.mesh = merge(parts)
        self._all = None

    def sdf(self, p):
        return self.field(p)

    def exact(self, p):
        """Signed distance with an exact magnitude everywhere (sign from the field away from the surface)."""
        p = np.asarray(p, float)
        s = self.field(p)
        if self.mode == 'normal':
            d = np.min([pt.signed(p) for pt in self.parts], axis=0)
            far = np.abs(d) > 1.2 * self.field.h
            return np.where(far, np.sign(s) * np.abs(d), d)
        if self._all is None: self._all = Part(*self.mesh)
        d = self._all.unsigned(p)
        return np.where(s < 0, -d, d)


def _hra_entries(sex, sel, exclude=None):
    s = source(f'hra-{sex}')
    out = []
    for o in s.index:
        if re.search(HRA_EXCLUDE, o['path']): continue
        if not re.search(sel, o['path']): continue
        if exclude and re.search(exclude, o['path']): continue
        out.append(o)
    return out


def _load_entries(sex, es):
    s = source(f'hra-{sex}')
    return [s.load_entry(o) for o in es]


VERT_NAMES = [(f'C{i}', f'cervical_vertebra_{i}') for i in range(2, 8)] + [(f'T{i}', f'thoracic_vertebra_{i}') for i in range(1, 13)] + \
             [(f'L{i}', f'lumbar_vertebra_{i}') for i in range(1, 7)] + [('S', 'sacrum')]


def vertebra_meshes(sex):
    """{'C2'..'L5' (female: ..'L6'), 'S': sacrum}: closed HRA vertebra meshes, outward-oriented."""
    out = {}
    s = source(f'hra-{sex}')
    for key, name in VERT_NAMES:
        es = s.select(rf'^VH_[MF]_{name}$')
        if not es: continue
        v, f = compact(*s.load(es))
        out[key] = (v, orient_outward(v, f))
    return out


def lumbar_count(sex):
    return sum(1 for k in vertebra_meshes(sex) if k.startswith('L'))


# HRA solids to keep the thorax clear of (assemble.py builds the same surfaces for the app)
SOLIDS = {
    'heart': dict(sel=r'cardiac_chamber/', h=0.001, close=2),
    'liver': dict(sel=r'_liver/', exclude=r'(ligament|artery|vein|duct|_portal)', h=0.0015, close=2, opening=1),
    'spleen': dict(sel=r'_spleen/', exclude=r'(artery|vein)', h=0.0015, close=2, opening=1),
    'kidneys': dict(sel=r'(kidney_capsule_[LR]$|hilum_of_kidney_[LR]$)', h=0.0015, close=2),
    'aorta': dict(sel=r'blood_vasculature/.*(aortic_arch|ascending_aorta|descending_aorta|brachiocephalic_artery|left_common_carotid_artery|left_subclavian_artery)', h=0.001, close=1),
    'great_veins': dict(sel=r'blood_vasculature/.*(superior_vena_cava|brachiocephalic_vein|pulmonary_trunk|pulmonary_artery_[LR])', h=0.001, close=1),
    'trachea': dict(sel=r'tracheobronchial_tree/.*VH_[MF]_(trachea|left_main_bronchus|right_main_bronchus)$', h=0.001, close=1),
}


def _build_lobes(sex):
    out = {}
    for lobe, rx in LOBE_PATH.items():
        es = _hra_entries(sex, rx)
        out[lobe] = remesh_solid(_load_entries(sex, es), project=False, smooth=10)   # as assemble.py builds the lobes
    return out


def targets(sex, which=None):
    """{name: Target}: 'lungs' (the five lobes), 'skin', the SOLIDS above, and 'V:<key>' for each vertebra."""
    cd = cache_dir(sex)
    want = which or (['lungs', 'skin'] + list(SOLIDS) + ['V:' + k for k in vertebra_meshes(sex)])
    out = {}
    for name in want:
        tag = name.replace(':', '_')
        mpath = os.path.join(cd, f'target-{tag}-mesh.npz'); fpath = os.path.join(cd, f'target-{tag}-sdf.npz')
        mode = 'normal' if (name == 'lungs' or name.startswith('V:')) else 'occ'
        if os.path.exists(mpath) and (name == 'skin' or os.path.exists(fpath)):
            d = np.load(mpath)
            parts = [(d[f'v{i}'].astype(np.float64), d[f'f{i}'].astype(np.int64)) for i in range(int(d['n']))]
            if name == 'skin':
                from fit.common import skin_solid
                sk = skin_solid(sex); fld = Field(sk.lo, sk.h, sk.sdf)
            else:
                fld = Field.load(fpath)
            out[name] = Target(name, parts, fld, 'normal' if name == 'skin' else mode); continue
        t0 = time.time()
        if name == 'lungs':
            lp = os.path.join(cd, 'lobes.npz')
            if os.path.exists(lp):
                d = np.load(lp); lobes = {k: (d[k + '.v'].astype(np.float64), d[k + '.f'].astype(np.int64)) for k in LOBE_PATH}
            else:
                log(sex, 'rebuilding the lung lobes from their segments')
                lobes = _build_lobes(sex)
                np.savez(lp, **{k + '.v': v for k, (v, f) in lobes.items()}, **{k + '.f': f for k, (v, f) in lobes.items()})
            parts = [lobes[k] for k in LOBE_PATH]
            fld = build_field(parts, 0.001, mode='normal'); parts = fld.fixed
        elif name == 'skin':
            v, f = skin(sex); parts = [(v, orient_outward(v, f))]
            from fit.common import skin_solid
            sk = skin_solid(sex); fld = Field(sk.lo, sk.h, sk.sdf)
        elif name.startswith('V:'):
            parts = [vertebra_meshes(sex)[name[2:]]]
            fld = build_field(parts, 0.0007, mode='normal'); parts = fld.fixed
        else:
            spec = SOLIDS[name]
            es = _hra_entries(sex, spec['sel'], spec.get('exclude'))
            if not es: continue
            parts = _load_entries(sex, es)
            fld = build_field(parts, spec['h'], mode='occ', close=spec.get('close', 2), opening=spec.get('opening', 0))
        np.savez(mpath, n=len(parts), **{f'v{i}': p[0].astype(np.float32) for i, p in enumerate(parts)}, **{f'f{i}': p[1].astype(np.int32) for i, p in enumerate(parts)})
        if name != 'skin': fld.save(fpath)          # the skin field is common.skin_solid's own cache
        out[name] = Target(name, [(p[0].astype(np.float32).astype(np.float64), p[1]) for p in parts], fld, 'normal' if name == 'skin' else mode)
        log(sex, f'target {name}: {sum(len(p[1]) for p in parts)} tris, grid {fld.sdf.shape} ({time.time() - t0:.0f} s)')
    return out


def spine_lung_overlap(sex, T=None, threshold=0.0005):
    """Where the HRA lungs overlap the HRA vertebrae themselves (impossible in a body: a segmentation conflict in the
    reference data): {(vertebra key, side 'l'/'r'): depth in m} for overlaps deeper than threshold. Cached."""
    path = os.path.join(cache_dir(sex), 'spine-lung-overlap.json')
    if os.path.exists(path):
        return {tuple(k.split('/')): v for k, v in json.load(open(path)).items()}
    T = T or targets(sex)
    L = T['lungs']; out = {}
    for name, t in T.items():
        if not name.startswith('V:'): continue
        v = t.mesh[0]
        d = L.sdf(v)
        near = d < 0.002
        if near.any(): d[near] = L.exact(v[near])
        xc = v[:, 0].mean()
        for side, m in (('l', v[:, 0] > xc), ('r', v[:, 0] <= xc)):
            depth = float(max(0.0, -d[m].min()))
            if depth > threshold: out[(name[2:], side)] = depth
    json.dump({f'{k[0]}/{k[1]}': round(v, 5) for k, v in out.items()}, open(path, 'w'), indent=1)
    return out


def cord_points(sex):
    """Vertices of the HRA spinal cord (locates the canal)."""
    return merge(_load_entries(sex, _hra_entries(sex, r'spinal_cord')))[0]
