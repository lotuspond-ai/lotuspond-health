"""Review fix pass for the vessels group (fit/vessels.py): extra obstacles, layer and calibre corrections, and the
measurements that go with them. numpy + scipy only.

 - Obstacles: the five lung lobes as assembled (.cache/parts/<sex>/lung_*.npz minus the rig offset; rebuilt from
   catalog.LOBE_PATH like assemble.py when missing) and the HRA thoracic aorta (ascending aorta, arch, descending aorta)
   as a capped tube: a chain of cones along its section-marched centreline with the outer-wall radius (the HRA aorta is
   double-walled and open, so ray parity cannot tell its lumen from the outside).
 - Tube geometry on the placed meshes, keeping their vertices and faces (junction stretches, vertex correspondences and
   contacts stay valid): every vertex gets a centreline parameter (arc length of its closest point on the main-trunk
   centreline) and an offset from it. Radii are scaled about the centreline (calibres, junction radius blends), sections
   re-rounded about it (crushed veins), and whole cross-sections translated (superficial layer).
"""
import os, sys, json
import numpy as np
from scipy.spatial import cKDTree
from scipy.ndimage import minimum_filter1d

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, load, save, sample_surface, area  # noqa: E402
from fit.common import FIT  # noqa: E402
from fit import vessels_geom as G  # noqa: E402

PARTS = os.path.join(FIT, '..', 'parts')
LOBES = ('lung_r_upper', 'lung_r_middle', 'lung_r_lower', 'lung_l_upper', 'lung_l_lower')


def r2(x, k=2):
    return round(float(x), k)


# ------------------------------------------------------------------------------------------------ obstacles
def lung_meshes(sex):
    """[(name, (v, f))] of the lung lobes in HRA coordinates."""
    out = []
    rig = os.path.join(PARTS, sex, 'rig.json')
    off = np.array(json.load(open(rig))['offset']) if os.path.exists(rig) else None
    for lobe in LOBES:
        p = os.path.join(PARTS, sex, lobe + '.npz')
        if off is not None and os.path.exists(p):
            v, f = load(p); out.append((f'lung/{lobe}', (v - off, f))); continue
        cache = os.path.join(FIT, sex, 'vessels', 'work', f'{lobe}.npz')
        if not os.path.exists(cache):
            from lib.mesh import remesh_solid
            from catalog import LOBE_PATH
            from fit.common import hra_mesh
            S = source(f'hra-{sex}')
            es = S.select(LOBE_PATH[lobe], path=True)
            rv, rf = remesh_solid([S.load_entry(o) for o in es], project=False, smooth=10)
            save(cache, rv, rf)
        out.append((f'lung/{lobe}', load(cache)))
    return out


def polyline_resample(P, step=0.0005):
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    t = np.arange(0, s[-1] + 1e-12, step)
    return np.stack([np.interp(t, s, P[:, k]) for k in range(3)], 1), t


class TubeObstacle:
    """Signed distance to a capped tube given by centreline points P (k, 3) and radii R (k,): distance to the closest
    point of the centreline minus the radius there (negative inside). Same query interface as vessels_geom.Obstacles."""

    def __init__(self, name, P, R, step=0.0005, bias=None, bias_mask=None):
        self.names = [name]
        self.P, s = polyline_resample(np.asarray(P, float), step)
        s0 = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
        self.R = np.interp(s, s0, R)
        self.tree = cKDTree(self.P)
        self.lo = self.P.min(0) - self.R.max() - 0.01; self.hi = self.P.max(0) + self.R.max() + 0.01
        # bias: (y (k,), centre (k, 3)) of the vertebral bodies; bias_mask (on the input points P): where the push out of
        # the tube goes toward the vertebral body at the same level (the descending aorta: a vein crossing it is routed
        # behind it, between the aorta and the vertebral bodies) instead of radially
        self.bias = bias
        self.bmask = np.interp(s, s0, np.asarray(bias_mask, float)) > 0.5 if bias_mask is not None else np.zeros(len(self.P), bool)

    def query(self, p, band=None):
        p = np.atleast_2d(np.asarray(p, float))
        d, i = self.tree.query(p)
        sd = d - self.R[i]
        # the ends are capped: beyond the end points the distance is to a sphere of the end radius
        dirn = G.unit(p - self.P[i])
        if self.bias is not None:
            m = self.bmask[i] & (sd < 0.002)
            if m.any():
                by, bc = self.bias
                c = np.stack([np.interp(p[m, 1], by, bc[:, a]) for a in range(3)], 1)
                u = c - self.P[i[m]]; u[:, 1] = 0.0
                dirn[m] = G.unit(u)
        return sd, dirn, np.zeros(len(p), int)


def hra_aorta_tube(sex):
    """The HRA thoracic aorta (ascending aorta, arch, descending aorta a and b) as one capped TubeObstacle: each piece's
    centreline marched by plane sections (vessels_geom.march: the largest polygon near the running axis, i.e. the outer
    wall of the double-walled HRA vessel) from its open ring that continues the previous piece, radius sqrt(area / pi)."""
    S = source(f'hra-{sex}'); X = 'VH_M_' if sex == 'male' else 'VH_F_'
    pts, rad, prev, desc = [], [], None, []
    for n in ('ascending_aorta', 'aortic_arch', 'descending_aorta_a', 'descending_aorta_b'):
        if X + n not in S.by_name: continue
        v, f = S.get(X + n)
        ends = G.merge_loops([e for e in G.stub_ends(v, f, min_r=0.004) if e['kind'] == 'open'])
        if not ends: continue
        if prev is None: e = min(ends, key=lambda e: e['c'][1])            # ascending aorta: from the valve end
        else: e = min(ends, key=lambda e: np.linalg.norm(e['c'] - prev))
        m = G.march(v, f, e['c'], -e['n'], step=0.002, length=0.30, r0=e['r'])
        ok = m['a'] > 0
        P, A = m['p'][ok], m['a'][ok]
        if len(P) < 3: continue
        R = np.sqrt(A / np.pi)
        # sections that cut a branch origin or the piece's own end are much larger than their neighbours: median filter
        Rm = np.array([np.median(R[max(0, i - 3):i + 4]) for i in range(len(R))])
        pts.append(P); rad.append(np.clip(R, 0.8 * Rm, 1.15 * Rm)); prev = P[-1]; desc.append(np.full(len(P), n.startswith('descending')))
    P = np.concatenate(pts); R = np.concatenate(rad)
    # vertebral body centres (anterior half of each thoracic and first lumbar vertebra)
    by, bc = [], []
    for k in list(range(1, 13)):
        nm = f'{X}thoracic_vertebra_{k}'
        if nm not in S.by_name: continue
        vv = S.get(nm)[0]; body = vv[vv[:, 2] > np.median(vv[:, 2])]
        by.append(body[:, 1].mean()); bc.append(body.mean(0))
    o = np.argsort(by); bias = (np.array(by)[o], np.array(bc)[o]) if by else None
    return TubeObstacle(f'hra_aorta_{sex}', P, R, bias=bias, bias_mask=np.concatenate(desc)), dict(points=len(P), radius_mm=[r2(np.min(R) * 1000, 1), r2(np.median(R) * 1000, 1), r2(np.max(R) * 1000, 1)],
                                                        y_range=[r2(P[:, 1].min(), 3), r2(P[:, 1].max(), 3)])


def tube_from_mesh(v, f, step=0.003):
    """(centreline P, outer radius R) of a roughly tubular mesh by slicing along its own local axis: PCA slabs."""
    from lib.mesh import pca
    c, V, sd = pca(v)
    ax = V[:, 0]
    t = (v - c) @ ax
    P, R = [], []
    for a in np.arange(t.min() + step, t.max() - step, step):
        q = v[np.abs(t - a) < step]
        if len(q) < 12: continue
        cc = q.mean(0); d = (q - cc) - np.outer((q - cc) @ ax, ax)
        P.append(cc); R.append(np.quantile(np.linalg.norm(d, axis=1), 0.9))
    return np.array(P), np.array(R)


# ------------------------------------------------------------------------------------------------ tube parameterisation
def end_loops(v, f):
    out = []
    for l in G.boundary_loops(f):
        if len(l) < 5: continue
        c, n, r = G.ring_frame(v[l]); out.append(dict(idx=l, c=c, r=r))
    return out


def trunk(v, f, start=None):
    """Main-trunk centreline of a vessel mesh from the end ring nearest to `start` (default: the highest ring) to the
    ring farthest from it. -> dict(p, s, t) or None."""
    L = end_loops(v, f)
    if len(L) < 1: return None
    a = max(L, key=lambda l: l['c'][1]) if start is None else min(L, key=lambda l: np.linalg.norm(l['c'] - start))
    others = [l for l in L if np.linalg.norm(l['c'] - a['c']) > 0.002]
    if not others: cl = G.centerline(v, f, a['idx'])
    else:
        b = max(others, key=lambda l: np.linalg.norm(l['c'] - a['c']))
        cl = G.trunk_centerline(v, f, a['idx'], b['idx'])
    if len(cl['p']) < 3: return None
    # put the exact ring centre first (the regression's first point lies a little inside the tube)
    P = np.vstack([a['c'], cl['p'][1:]])
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    return dict(p=P, s=s, t=G.unit(np.gradient(P, axis=0)), ring=a)


def project(cl, X, step=0.0005):
    """Closest centreline point for each X: (arc length s, point q, unit tangent t)."""
    Q, s = polyline_resample(cl['p'], step)
    T = G.unit(np.gradient(Q, axis=0))
    d, i = cKDTree(Q).query(X)
    return s[i], Q[i], T[i]


def sections_of(v, f, cl, step=0.002):
    """Plane sections of a vessel mesh every `step` along its centreline: list of dict(s, c (centreline point), t,
    poly (the section polygon nearest to c) or None)."""
    out = []
    Q, s = polyline_resample(cl['p'], step)
    T = G.unit(np.gradient(Q, axis=0))
    for k in range(len(Q)):
        Ls = G.slice_loops(v, f, Q[k], T[k])
        best = None
        for L in Ls:
            d = np.linalg.norm(L - Q[k], axis=1).min()
            if best is None or d < best[0]: best = (d, L)
        out.append(dict(s=s[k], c=Q[k], t=T[k], poly=best[1] if best is not None and best[0] < 0.02 else None))
    return out


def shape_stats(sec):
    """Width (max extent), aspect (major / minor principal extent) and area-equivalent diameter of a section polygon."""
    P = sec['poly']
    if P is None or len(P) < 4: return None
    t = sec['t']
    u = G.unit(np.cross(t, [1, 0, 0] if abs(t[0]) < 0.9 else [0, 1, 0])); w = np.cross(t, u)
    X = np.stack([(P - P.mean(0)) @ u, (P - P.mean(0)) @ w], 1)
    ev, evec = np.linalg.eigh(np.cov(X.T))
    proj = X @ evec
    ext = proj.max(0) - proj.min(0)
    a, _ = G.polygon_area_centroid(P, t)
    return dict(width=float(ext.max()), minor=float(ext.min()), aspect=float(ext.max() / max(ext.min(), 1e-5)), d_eq=float(2 * np.sqrt(a / np.pi)))


def calibre_profile(v, f, cl, step=0.003):
    rows = []
    for sec in sections_of(v, f, cl, step):
        st = shape_stats(sec)
        if st: rows.append(dict(s=sec['s'], c=sec['c'], **st))
    return rows


# ------------------------------------------------------------------------------------------------ measurements
def penetration_rows(VES, names, obst, per_cm2=30, deep=0.001):
    """Per vessel: fraction of surface samples inside the obstacles (sd < 0) and deeper than `deep`, deepest (mm) and
    the obstacle there."""
    rows = {}
    for n in names:
        x = VES[n]
        k = int(np.clip(area(x['v'], x['f']) * 1e4 * per_cm2, 200, 6000))
        p = sample_surface(x['v'], x['f'], k, seed=5)
        sd, _, who = obst.query(p)
        if not (sd < 0).any(): continue
        i = int(np.argmin(sd))
        rows[n] = dict(inside_frac=r2((sd < 0).mean(), 4), deeper_1mm_frac=r2((sd < -deep).mean(), 4), max_depth_mm=r2(-sd[i] * 1000, 1),
                       where=obst.names[who[i]] if who[i] >= 0 else None)
    return rows


def wall_depth_profile(x, skin, step=0.005, start=None):
    """Depth of a vessel's wall under the skin along its main trunk: per `step` of centreline, the smallest depth of the
    vertices assigned to it (the wall nearest the skin). -> (s (k,), depth (k,) metres, centre points (k, 3), cl)."""
    cl = trunk(x['v'], x['f'], start)
    if cl is None: return None
    s, q, t = project(cl, x['v'])
    sd, g = skin(x['v'])
    b = np.floor(s / step).astype(int)
    out_s, out_d, out_c = [], [], []
    for k in np.unique(b):
        m = b == k
        out_s.append((k + 0.5) * step); out_d.append(float(-sd[m].max())); out_c.append(q[m].mean(0))
    return np.array(out_s), np.array(out_d), np.array(out_c), cl


SUPERFICIAL = ('Cephalic_vein', 'Basilic_vein', 'Median_cubital_vein', 'Great_saphenous_vein', 'Small_saphenous_vein')


def measure(sex, VES, names, lungs=None, aorta=None, skin=None):
    """Measurements for the review items (informative unless a criterion is set in fit/vessels.py)."""
    out = {}
    if lungs is not None:
        rows = penetration_rows(VES, names, lungs)
        out['lungs'] = dict(per_vessel={n: r for n, r in rows.items() if r['max_depth_mm'] > 0.3},
                            worst_mm=max([r['max_depth_mm'] for r in rows.values()] + [0.0]))
    if aorta is not None:
        vn = [n for n in names if VES[n]['part'] == 'veins']
        rows = penetration_rows(VES, vn, aorta)
        out['aorta_veins'] = dict(per_vessel=rows, worst_mm=max([r['max_depth_mm'] for r in rows.values()] + [0.0]))
    # vein shape: aspect and width of the sections (crushed / crumpled veins)
    shp = {}
    for n in names:
        if not any(k in n for k in ('subclavian_vein', 'brachiocephalic_vein', 'Internal_jugular', 'Axillary_vein')): continue
        x = VES[n]; cl = trunk(x['v'], x['f'])
        if cl is None: continue
        pr = [p for p in calibre_profile(x['v'], x['f'], cl) if 0.01 < p['s'] < cl['s'][-1] - 0.01]   # 1 cm in from the end rings
        if not pr: continue
        asp = np.array([p['aspect'] for p in pr]); w = np.array([p['width'] for p in pr]); d = np.array([p['d_eq'] for p in pr])
        shp[n] = dict(max_aspect=r2(asp.max(), 2), p90_aspect=r2(np.quantile(asp, 0.9), 2), max_width_mm=r2(w.max() * 1000, 1),
                      median_d_eq_mm=r2(np.median(d) * 1000, 1))
    out['vein_sections'] = shp
    if skin is not None:
        dep = {}
        for n in names:
            if not n.startswith(SUPERFICIAL) and not n.startswith('Radial_artery'): continue
            r = wall_depth_profile(VES[n], skin)
            if r is None: continue
            s_, d_, c_, cl = r
            row = dict(median_mm=r2(np.median(d_) * 1000, 1), p10_mm=r2(np.quantile(d_, 0.1) * 1000, 1), p90_mm=r2(np.quantile(d_, 0.9) * 1000, 1),
                       length_cm=r2(cl['s'][-1] * 100, 1))
            if n.startswith(('Cephalic', 'Basilic')):
                mc = VES.get('Median_cubital_vein' + n[-1])
                if mc is not None:
                    dn = cKDTree(mc['v']).query(c_)[0]
                    if (dn < 0.03).any(): row['elbow_median_mm'] = r2(np.median(d_[dn < 0.03]) * 1000, 1)
                    if (dn > 0.05).any(): row['away_from_elbow_median_mm'] = r2(np.median(d_[dn > 0.05]) * 1000, 1)
            if n.startswith('Radial_artery') and VES[n].get('radial_zone'):
                a, b = VES[n]['radial_zone']; z = (s_ > a) & (s_ < b)
                if z.any(): row['pulse_zone_median_mm'] = r2(np.median(d_[z]) * 1000, 1); row['pulse_zone_max_mm'] = r2(d_[z].max() * 1000, 1)
            if n.startswith('Median_cubital'):
                ba = VES.get('Brachial_artery' + n[-1])
                if ba is not None: row['min_dist_to_brachial_artery_mm'] = r2(cKDTree(ba['v']).query(VES[n]['v'])[0].min() * 1000, 1)
            dep[n] = row
        out['superficial_depth'] = dep
    return out


# ------------------------------------------------------------------------------------------------ tube edits
def rmf(Q, T):
    """Rotation-minimising frame (u, w) along a resampled centreline Q with unit tangents T."""
    u = np.zeros_like(Q); a = np.array([1.0, 0, 0]) if abs(T[0][0]) < 0.9 else np.array([0, 1.0, 0])
    u[0] = G.unit(np.cross(T[0], a))
    for k in range(1, len(Q)):
        x = u[k - 1] - (u[k - 1] @ T[k]) * T[k]
        u[k] = G.unit(x) if np.linalg.norm(x) > 1e-9 else G.unit(np.cross(T[k], a))
    return u, np.cross(T, u)


def param(x, cl, step=0.0005):
    """Per vertex of a vessel: arc length s, closest centreline point q and the index into the resampled centreline."""
    Q, s = polyline_resample(cl['p'], step)
    d, i = cKDTree(Q).query(x['v'])
    return s[i], Q[i], i, Q, s


def scale_about(x, cl, k_of_s):
    """Scale every cross-section of a vessel about its centreline by k(s) (array function of arc length)."""
    s, q, _, _, _ = param(x, cl)
    k = k_of_s(s)
    x['v'] = q + k[:, None] * (x['v'] - q)
    return k


def raised(t):
    t = np.clip(t, 0.0, 1.0)
    return 0.5 * (1 + np.cos(np.pi * t))


L_BLEND = 0.040     # junction radius blend length (m)


def ring_radius(x, near):
    L = end_loops(x['v'], x['f'])
    l = min(L, key=lambda l: np.linalg.norm(l['c'] - near))
    return l, l['r']


def junction_radius_blend(VES, J, log=print, skip=('aortic_bifurcation',)):
    """Arteries that continue (chain) or branch from (fork / branch) an HRA stub: cross-sections scaled about the
    centreline so the start radius matches the stub's (a fork's children keep Z-Anatomy's child / parent ratio at the
    stub's size), blended back to the Z-Anatomy radius over L_BLEND (raised cosine)."""
    out = {}
    for j in J:
        if j['part'] != 'arteries' or j['kind'] not in ('chain', 'fork', 'branch') or j['key'].split(':')[0] in skip: continue
        for n in j['vessels']:
            x = VES[n]
            if x.get('dropped'): continue
            l, r0 = ring_radius(x, j['c'])
            if j['kind'] == 'chain': k0 = j['end']['r'] / r0
            else:
                # a fork's child keeps Z-Anatomy's child / parent ratio at the stub's size (from its Z-Anatomy ring)
                rz = G.ring_frame(x['za_v'][l['idx']])[2] if len(x['za_v']) == len(x['v']) else r0
                k0 = min(1.0, j['end']['r'] / j['za_r']) * rz / r0
            if 0.85 <= k0 <= 1.15: continue
            cl = trunk(x['v'], x['f'], start=l['c'])
            if cl is None: continue
            L = min(L_BLEND, 0.8 * cl['s'][-1])
            scale_about(x, cl, lambda s: 1 + (k0 - 1) * raised((s - 0.004) / (L - 0.004)))
            out[j['key'] + ('' if len(j['vessels']) == 1 else '') + ':' + n] = dict(za_start_r_mm=r2(r0 * 1000, 1), hra_r_mm=r2(j['end']['r'] * 1000, 1),
                                                                                  start_scale=r2(k0, 2), blend_cm=r2(L * 100, 1))
            log(f'  radius blend {j["key"]} {n}: x{k0:.2f} at the ring, back to Z-Anatomy over {L * 100:.1f} cm')
    return out


# pelvic arteries: target diameters (m) and the vessels whose cross-sections are scaled
PELVIC_D = {'male': dict(EIA=0.0080, IIA=0.0055), 'female': dict(EIA=0.0072, IIA=0.0050)}
CIA_MAX = {'male': 0.0105, 'female': 0.0100}


def median_d(x, cl):
    pr = calibre_profile(x['v'], x['f'], cl, step=0.004)
    d = np.array([p['d_eq'] for p in pr])
    # the first and last 8 mm are junction sections (branch mouths, cut rings)
    s = np.array([p['s'] for p in pr])
    m = (s > 0.008) & (s < cl['s'][-1] - 0.008)
    return float(np.median(d[m] if m.sum() >= 3 else d))


def pelvic_calibres(sex, VES, J, aorta_tube=None, log=print):
    """Scale the iliac arteries' cross-sections about their centrelines to adult calibres: common iliac about 0.7 x the
    HRA aorta's end diameter (at most CIA_MAX), external iliac and internal iliac PELVIC_D; the external iliac never
    wider than its common iliac, the internal iliac never wider than the external. One factor per vessel (the ring
    centres stay where they are, so the tree stays joined)."""
    jb = [j for j in J if j['key'].startswith('aortic_bifurcation')]
    r_ao = jb[0]['end']['r'] if jb else None
    if aorta_tube is not None:
        # outer radius of the HRA aorta over its last 4 cm above the end
        P, Rr = aorta_tube.P, aorta_tube.R
        s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
        m = (s > s[-1] - 0.05) & (s < s[-1] - 0.01)
        if m.any(): r_ao = float(np.median(Rr[m]))
    out = dict(aorta_end_d_mm=r2(2 * r_ao * 1000, 1) if r_ao else None)
    tgt_cia = min(CIA_MAX[sex], 0.7 * 2 * r_ao) if r_ao else CIA_MAX[sex]
    for side in 'lr':
        d_par = None
        for key, n in (('CIA', f'Common_iliac_artery{side}'), ('EIA', f'External_iliac_artery{side}'), ('IIA', f'Internal_iliac_artery{side}')):
            x = VES.get(n)
            if x is None or x.get('dropped') or not x['placed']: continue
            cl = trunk(x['v'], x['f'])
            if cl is None: continue
            d0 = median_d(x, cl)
            tgt = tgt_cia if key == 'CIA' else PELVIC_D[sex][key]
            if key == 'EIA' and d_par: tgt = min(tgt, 0.95 * d_par)
            if key == 'IIA' and out.get(f'EIA_{side}'): tgt = min(tgt, out[f'EIA_{side}']['after_mm'] / 1000)
            k = tgt / d0
            if k < 1.0:
                scale_about(x, cl, lambda s, k=k: np.full(len(s), k))
            d1 = median_d(x, cl)
            out[f'{key}_{side}'] = dict(before_mm=r2(d0 * 1000, 1), target_mm=r2(tgt * 1000, 1), after_mm=r2(d1 * 1000, 1), scale=r2(min(k, 1.0), 3))
            if key == 'CIA': d_par = d1
            log(f'  calibre {n}: {d0 * 1000:.1f} -> {d1 * 1000:.1f} mm (target {tgt * 1000:.1f})')
    return out


RR_END = 0.020     # re-round: falloff of an end ring's re-snap (m)


def reround(VES, names, J, log=print, smooth_iters=12, only_crushed=None):
    """Re-sweep crushed veins as round tubes about their main-trunk centrelines, keeping vertices and faces: each vertex
    goes to the circle of the Z-Anatomy radius at its centreline parameter (the Z-Anatomy vertex's distance to the
    Z-Anatomy centreline, binned and smoothed along the vessel), at its own angle about the centreline (rotation-
    minimising frame); the angles are then evened out by a few rounds of neighbour averaging on the circle. The end ring
    at a junction keeps its centre (the centreline starts there). A re-sweep is kept only where it makes the sections
    rounder (p90 and max aspect 1 cm in from the ends, as measured); `only_crushed` (p90, max) re-sweeps only veins
    whose sections exceed either (after the push-out: a vein the re-route kept round is left as it is)."""
    out = {}
    for n in names:
        x = VES.get(n)
        if x is None or x.get('dropped') or not x['placed']: continue
        jj = [j for j in J if n in j['vessels']]
        start = jj[0]['c'] if jj else None
        cl = trunk(x['v'], x['f'], start=start)
        if cl is None: continue
        s, q, idx, Q, sQ = param(x, cl)
        T = G.unit(np.gradient(Q, axis=0)); U, W = rmf(Q, T)
        # Z-Anatomy radius per vertex (via the vertex correspondence; vertices made by a cut have none)
        zv, zf = x['za_v'], x['za_f']
        if x.get('orig_index') is not None:
            inv = -np.ones(len(x['v']), int); oi = x['orig_index']; ok = oi >= 0; inv[oi[ok]] = np.flatnonzero(ok)
        else: inv = np.arange(len(x['v']))
        zcl = trunk(zv, zf)
        rz = np.full(len(x['v']), np.nan)
        if zcl is not None:
            Qz, _ = polyline_resample(zcl['p'], 0.0005)
            dz, _ = cKDTree(Qz).query(zv)
            has = inv >= 0; rz[has] = dz[inv[has]]
        b = np.floor(s / 0.004).astype(int); nb = b.max() + 1
        rb = np.full(nb, np.nan)
        for k in range(nb):
            m = (b == k) & np.isfinite(rz)
            if m.sum() >= 3: rb[k] = np.median(rz[m])
        good = np.isfinite(rb)
        if good.sum() < 2: continue
        sk = (np.arange(nb) + 0.5) * 0.004
        rb = np.interp(sk, sk[good], rb[good])
        K = np.exp(-0.5 * ((sk[:, None] - sk[None]) / 0.006) ** 2); rb = (K @ rb) / K.sum(1)
        cj = [j for j in jj if j['kind'] == 'chain']
        if cj:
            # a chain junction's ring takes the HRA stub's end radius, blended back to Z-Anatomy's over 3 cm
            rb = rb + (cj[0]['end']['r'] - rb[0]) * raised((sk - 0.004) / 0.030)
        r_v = np.interp(s, sk, rb)
        o = x['v'] - q
        e = G.unit(o - np.einsum('ij,ij->i', o, T[idx])[:, None] * T[idx])
        # even out the angles: neighbour averaging of the unit offsets, kept perpendicular to the centreline
        from scipy import sparse
        E = G.edge_list(x['f']); nv = len(x['v'])
        A_ = sparse.coo_matrix((np.ones(2 * len(E)), (np.r_[E[:, 0], E[:, 1]], np.r_[E[:, 1], E[:, 0]])), shape=(nv, nv)).tocsr()
        deg = np.maximum(np.asarray(A_.sum(1)).ravel(), 1)
        for _ in range(smooth_iters):
            e = e + 0.5 * ((A_ @ e) / deg[:, None] - e)
            e = G.unit(e - np.einsum('ij,ij->i', e, T[idx])[:, None] * T[idx])
        before = calibre_profile(x['v'], x['f'], cl)

        def p90max(rows):
            a = [p['aspect'] for p in rows if 0.01 < p['s'] < cl['s'][-1] - 0.01]
            return (float(np.quantile(a, 0.9)), float(max(a))) if a else (None, None)
        pb, mb = p90max(before)
        if only_crushed is not None and pb is not None and pb <= only_crushed[0] and mb <= only_crushed[1]:
            out[n] = dict(skipped='round already', p90_aspect=r2(pb, 2), max_aspect=r2(mb, 2))
            log(f'  re-round {n}: round already (p90 / max section aspect {pb:.2f} / {mb:.2f})'); continue
        v_old = x['v'].copy()
        x['v'] = q + r_v[:, None] * e
        # the end rings keep their centres (continuity with what they join; a chain junction's ring goes back onto the
        # HRA stub's end): each ring's centre shift is undone with a raised-cosine falloff over RR_END of centreline
        snapped = []
        for l in end_loops(x['v'], x['f']):
            tgt = v_old[l['idx']].mean(0)
            for j in cj:
                if np.linalg.norm(tgt - j['end']['c']) < 0.02 and min(end_loops(v_old, x['f']), key=lambda m: np.linalg.norm(v_old[m['idx']].mean(0) - j['end']['c']))['idx'][0] == l['idx'][0]:
                    tgt = j['end']['c']
            dc = tgt - x['v'][l['idx']].mean(0)
            s_l = float(project(cl, l['c'][None])[0][0])
            x['v'] = x['v'] + raised(np.abs(s - s_l) / RR_END)[:, None] * dc
            snapped.append(r2(np.linalg.norm(dc) * 1000, 1))
        after = calibre_profile(x['v'], x['f'], cl)
        # kept only where it makes the sections rounder (1 cm in from the ends, as measured): a short vein whose upper
        # end is a confluence (the female right brachiocephalic) is not a single tube there
        pa, ma = p90max(after)
        if pb is not None and pa is not None and (pa > pb or ma > 1.1 * max(mb, 2.0)):
            x['v'] = v_old
            out[n] = dict(reverted=True, p90_max_aspect_before=[r2(pb, 2), r2(mb, 2)], p90_max_aspect_would_be=[r2(pa, 2), r2(ma, 2)])
            log(f'  re-round {n}: not kept (p90 / max section aspect {pb:.2f} / {mb:.2f} -> {pa:.2f} / {ma:.2f})')
            continue
        out[n] = dict(max_aspect_before=r2(max(p['aspect'] for p in before), 2) if before else None,
                      max_aspect_after=r2(max(p['aspect'] for p in after), 2) if after else None,
                      max_width_before_mm=r2(max(p['width'] for p in before) * 1000, 1) if before else None,
                      max_width_after_mm=r2(max(p['width'] for p in after) * 1000, 1) if after else None,
                      za_radius_mm=[r2(rb.min() * 1000, 1), r2(np.median(rb) * 1000, 1), r2(rb.max() * 1000, 1)], end_ring_resnap_mm=snapped)
        log(f'  re-round {n}: {out[n]}')
    return out


# ------------------------------------------------------------------------------------------------ superficial layer
ZA_LIMB_SKIN = r'(arm|elbow|forearm|wrist|hand|Cubital|Deltoid|thigh|knee|leg|ankle|foot|Gluteal|Femoral_triangle|digits|Nail|Perionyx|sole|heel|calcane|Sural|popl)'
SUP_GROUPS = (('Cephalic_vein', 'Basilic_vein', 'Median_cubital_vein'), ('Great_saphenous_vein', 'Small_saphenous_vein'))
SUP_MIN, SUP_MAX, SUP_IF = 0.0020, 0.005, 0.006     # target wall depth clip(Z-Anatomy depth, 2, 5) mm where it is < 6 mm (2 mm: clear of the push-out's 1.5 mm skin rule)
SUP_STEP, SUP_SIGMA, SUP_FADE = 0.004, 0.010, 0.025
SUP_SPACE, SUP_PASSES = 0.003, 8    # spatial averaging of a group's shifts (sigma, m); passes (each re-measures the depths)
SUP_KEEP = 0.0015                   # a shift never takes a wall vertex shallower than this (the push-out's skin rule)
SUP_ERODE = 3                       # bins over which a cut-back shift is eroded (odd)
DEEP_VEINS = ('Axillary_vein', 'Brachial_veins', 'Subclavian', 'Femoral_vein', 'Popliteal_vein', 'Left_subclavian', 'Right_subclavian')
_ZSK = {}


def za_skin_tree():
    if 'tree' not in _ZSK:
        import re
        S = source('za-regions')
        pts = []
        for o in S.index:
            n = o['name']
            if n[-1:] not in 'lr' or not re.search(ZA_LIMB_SKIN, n, re.I): continue
            v, f = S.load_entry(o)
            if len(f): pts.append(np.concatenate([v, sample_surface(v, f, int(np.clip(area(v, f) / 0.0015 ** 2, 200, 200000)), seed=1)]))
        _ZSK['tree'] = cKDTree(np.concatenate(pts))
    return _ZSK['tree']


def depth_field(x, cl, skin, ztree, step=SUP_STEP):
    """Per centreline bin: wall depth under the HRA skin (the section's shallowest vertex), its outward skin normal, the
    Z-Anatomy wall depth under its own skin (same vertices before the deformation)."""
    s, q, _, _, _ = param(x, cl)
    sd, g = skin(x['v'])
    zd = ztree.query(x['za_v'])[0] if len(x['za_v']) == len(x['v']) else None
    b = np.floor(s / step).astype(int); nb = b.max() + 1
    D = np.full(nb, np.nan); ZD = np.full(nb, np.nan); N = np.zeros((nb, 3))
    for k in np.unique(b):
        m = np.flatnonzero(b == k); i = m[np.argmax(sd[m])]
        D[k] = -sd[i]; N[k] = g[i]
        if zd is not None: ZD[k] = zd[m].min()
    return s, b, D, ZD, N


def gauss_along(vec, w, step, sigma):
    sk = np.arange(len(vec)) * step
    K = np.exp(-0.5 * ((sk[:, None] - sk[None]) / sigma) ** 2)
    return (K @ (vec * w[:, None])) / K.sum(1, keepdims=True)


def _deep_end_fade(VES, n, members, x, cl, sk):
    """1, fading to 0 over SUP_FADE toward each end ring that joins a deep vein in Z-Anatomy (judged in Z-Anatomy space:
    after the deformation a misplaced superficial vein can lie beside a deep vein it does not join)."""
    fade = np.ones(len(sk))
    for l in end_loops(x['v'], x['f']):
        # the ring joins a deep vein if it touches it in Z-Anatomy (centre within its own radius + 3 mm of that vein's
        # surface); a deep vein merely nearby (the brachial veins under the median cubital vein) is not a junction
        deep = False; zr = x['za_v'][l['idx']]; zc = zr.mean(0); rr = float(np.linalg.norm(zr - zc, axis=1).mean())
        for m, y in VES.items():
            if m in members or y['part'] != 'veins' or not y['placed'] or y.get('dropped') or not m.startswith(DEEP_VEINS): continue
            if np.linalg.norm(y['za_v'] - zc, axis=1).min() < rr + 0.003: deep = True; break
        if not deep: continue
        s_l = float(project(cl, l['c'][None])[0][0])
        if min(s_l, cl['s'][-1] - s_l) > 0.010: continue        # a side branch (perforator), not an end of the trunk
        fade = np.minimum(fade, G.smoothstep(np.abs(sk - s_l) / SUP_FADE))
    return fade


def superficial_layer(sex, VES, skin, log=print):
    """Superficial veins back under the skin (they sit 1.5-3.5 cm deep after the deformation): for the cephalic, basilic
    and median cubital veins of each arm (moved together) and the great and small saphenous veins of each leg, the
    target wall depth is clip(Z-Anatomy depth under its own skin, 2, 5) mm where that depth is under 6 mm. Each
    centreline bin's shift (current wall depth - target, along the skin's outward normal at its shallowest vertex) is
    smoothed along the vessel (Gaussian, sigma 1 cm), faded to zero over 2.5 cm toward an end that joins a deep vein, and
    the group's per-vertex shifts are averaged in space (sigma 6 mm), so cross-sections move as a whole and the veins of a
    group stay joined."""
    ztree = za_skin_tree()
    out = {}
    v0 = {n: VES[n]['v'].copy() for m in SUP_GROUPS for n in [k + s for k in m for s in 'lr'] if n in VES}
    for side, members in [(sd, mm) for _ in range(SUP_PASSES) for sd in 'lr' for mm in SUP_GROUPS]:
        if True:
            names = [m + side for m in members if m + side in VES and VES[m + side]['placed'] and not VES[m + side].get('dropped')]
            Xs, Ds, own, Ss = [], [], [], []
            for n in names:
                x = VES[n]
                cl = trunk(x['v'], x['f'])
                if cl is None or len(x['za_v']) != len(x['v']): continue
                s, b, D, ZD, N = depth_field(x, cl, skin, ztree)
                w = np.isfinite(D) & np.isfinite(ZD) & (ZD < SUP_IF)
                tgt = np.clip(np.nan_to_num(ZD, nan=1.0), SUP_MIN, SUP_MAX)
                delta = np.where(w, np.nan_to_num(D) - tgt, 0.0)
                vec = gauss_along(delta[:, None] * N, w.astype(float), SUP_STEP, SUP_SIGMA)
                sk = (np.arange(len(D)) + 0.5) * SUP_STEP
                vec *= _deep_end_fade(VES, n, names, x, cl, sk)[:, None]
                dv = np.stack([np.interp(s, sk, vec[:, a]) for a in range(3)], 1)
                Xs.append(x['v']); Ds.append(dv); own.append(n); Ss.append(s)
                if n not in out:    # the first pass's numbers are the 'before' state
                    out[n] = dict(target_bins=int(w.sum()), bins=int(np.isfinite(D).sum()), depth_before_median_mm=r2(np.nanmedian(D) * 1000, 1),
                                  depth_before_target_bins_mm=r2(np.median(D[w]) * 1000, 1) if w.any() else None,
                                  za_depth_target_bins_mm=r2(np.median(ZD[w]) * 1000, 1) if w.any() else None)
            if not Xs: continue
            X = np.concatenate(Xs); Dd = np.concatenate(Ds)
            tr = cKDTree(X); M = tr.sparse_distance_matrix(tr, 3 * SUP_SPACE, output_type='coo_matrix')
            i, j, d = np.r_[M.row, np.arange(len(X))], np.r_[M.col, np.arange(len(X))], np.r_[M.data, np.zeros(len(X))]
            K = np.exp(-0.5 * (d / SUP_SPACE) ** 2)
            num = np.zeros_like(X); den = np.zeros(len(X))
            np.add.at(num, i, K[:, None] * Dd[j]); np.add.at(den, i, K)
            Dsm = num / den[:, None]
            # never out through the skin (a crease or fold can turn a smoothed outward shift into a crossing): per vertex
            # the largest fraction of the shift that leaves it SUP_KEEP under the skin (or no shallower than it is), per
            # centreline bin the smallest, eroded over +-2 bins and smoothed along the vessel; then averaged in space
            # again so the veins of the group stay joined
            sd0 = skin(X)[0]
            al = np.zeros(len(X)); done = np.zeros(len(X), bool)
            for a in (1.0, 0.75, 0.5, 0.25):
                sda = skin(X + a * Dsm)[0]
                ok = ~done & ((-sda >= SUP_KEEP) | (sda <= sd0)); al[ok] = a; done |= ok
            o = 0; Da = np.zeros_like(Dsm)
            for n, s in zip(own, Ss):
                k = len(s); b = np.floor(s / SUP_STEP).astype(int); nb = b.max() + 1
                ab = np.ones(nb); np.minimum.at(ab, b, al[o:o + k])
                ab = minimum_filter1d(ab, SUP_ERODE, mode="nearest")
                ab = gauss_along(ab[:, None], np.ones(nb), SUP_STEP, SUP_STEP)[:, 0]
                Da[o:o + k] = np.interp(s, (np.arange(nb) + 0.5) * SUP_STEP, ab)[:, None] * Dsm[o:o + k]; o += k
            num = np.zeros_like(X); np.add.at(num, i, K[:, None] * Da[j]); Dsm = num / den[:, None]
            o = 0
            for n in own:
                k = len(VES[n]['v']); VES[n]['v'] = VES[n]['v'] + Dsm[o:o + k]
                out[n]['max_shift_mm'] = r2(np.linalg.norm(VES[n]['v'] - v0[n], axis=1).max() * 1000, 1); o += k
            log(f'  superficial layer {side}: ' + ', '.join(f'{n} max {out[n]["max_shift_mm"]} mm' for n in own))
    return out


RADIAL_D = (0.002, 0.004)     # radial artery wall depth at the pulse
RADIAL_ZONE = 0.050           # over the distal 5 cm proximal to the radial styloid


def radial_pulse(sex, VES, skin, log=print):
    """Radial artery at the wrist: over the RADIAL_ZONE proximal to the tip of the radial styloid (the placed radius
    keeps Z-Anatomy's vertex order: the styloid tip is the Z-Anatomy radius's lowest vertex) the wall depth is brought to
    clip(Z-Anatomy depth, 2, 4) mm, faded in over 2 cm proximally and out over 1.5 cm past the styloid (the artery then
    turns dorsally into the anatomical snuffbox)."""
    ztree = za_skin_tree(); out = {}
    for side in 'lr':
        n = f'Radial_artery{side}'; x = VES.get(n)
        p = os.path.join(FIT, sex, 'arms', f'Radius{side}.npz')
        if x is None or not os.path.exists(p): continue
        rv = load(p)[0]; zr = source('za-skeletal').get(f'Radius{side}')[0]
        if len(rv) != len(zr): continue
        sty = rv[int(np.argmin(zr[:, 1]))]
        cl = trunk(x['v'], x['f'])
        s, b, D, ZD, N = depth_field(x, cl, skin, ztree)
        sk = (np.arange(len(D)) + 0.5) * SUP_STEP
        s_sty = float(project(cl, sty[None])[0][0])
        w = G.smoothstep((sk - (s_sty - RADIAL_ZONE)) / 0.02) * (1 - G.smoothstep((sk - s_sty) / 0.015))
        w = np.where(np.isfinite(D), w, 0.0)
        tgt = np.clip(np.nan_to_num(ZD, nan=RADIAL_D[1]), *RADIAL_D)
        vec = gauss_along(np.nan_to_num(D - tgt)[:, None] * N, np.ones(len(D)), SUP_STEP, 0.006) * w[:, None]
        dv = np.stack([np.interp(s, sk, vec[:, a]) for a in range(3)], 1)
        x['v'] = x['v'] + dv
        zone = (sk > s_sty - RADIAL_ZONE) & (sk < s_sty)
        _, _, D2, _, _ = depth_field(x, cl, skin, ztree)
        out[n] = dict(styloid_at_cm=r2(s_sty * 100, 1), depth_before_zone_median_mm=r2(np.nanmedian(D[zone]) * 1000, 1) if zone.any() else None,
                      depth_after_zone_median_mm=r2(np.nanmedian(D2[:len(zone)][zone[:len(D2)]]) * 1000, 1) if zone.any() else None,
                      max_shift_mm=r2(np.linalg.norm(dv, axis=1).max() * 1000, 1))
        x['radial_zone'] = (float(s_sty - RADIAL_ZONE), float(s_sty))
        log(f'  radial pulse {n}: {out[n]}')
    return out


# neck and brain arteries: adult reference diameters (m), median over the vessel away from its end rings
NECK_D = {'male': dict(CCA=0.0075, ICA=0.0050, ECA=0.0042, BAS=0.0034), 'female': dict(CCA=0.0066, ICA=0.0046, ECA=0.0038, BAS=0.0031)}


def neck_calibres(sex, VES, log=print):
    """Z-Anatomy common carotids (female: 9.7-10.3 mm, doubling the HRA stubs) and external carotids (wider than the
    internal carotids) scaled down about their centrelines to adult reference diameters (NECK_D); the basilar artery
    (half normal, narrower than each vertebral) scaled up to its reference. One factor per vessel; never applied to
    the vertebral arteries (their course through the transverse foramina is checked against the bone)."""
    out = {}
    for key, names, up in (('CCA', ('Right_common_carotid_artery', 'Left_common_carotid_artery'), False),
                           ('ICA', ('Internal_carotid_arteryl', 'Internal_carotid_arteryr'), False),
                           ('ECA', ('External_carotid_arteryl', 'External_carotid_arteryr'), False),
                           ('BAS', ('Basilar_artery',), True)):
        for n in names:
            x = VES.get(n)
            if x is None or x.get('dropped') or not x['placed']: continue
            cl = trunk(x['v'], x['f'])
            if cl is None: continue
            d0 = median_d(x, cl); tgt = NECK_D[sex][key]
            if key == 'ECA':
                ica = out.get('ICA_' + n[-1])
                if ica: tgt = min(tgt, 0.85 * ica['after_mm'] / 1000)
            k = tgt / d0
            if (k < 0.92) or (up and k > 1.08):
                scale_about(x, cl, lambda s, k=k: np.full(len(s), k))
            else: k = 1.0
            d1 = median_d(x, cl)
            out[f'{key}_{n[-1] if key != "CCA" else n[0].lower()}'] = dict(vessel=n, before_mm=r2(d0 * 1000, 1), reference_mm=r2(tgt * 1000, 1), after_mm=r2(d1 * 1000, 1), scale=r2(k, 3))
            log(f'  calibre {n}: {d0 * 1000:.1f} -> {d1 * 1000:.1f} mm (reference {tgt * 1000:.1f})')
    return out


# ------------------------------------------------------------------------------------------------ bridges
def sweep(P, R, n=16):
    """Open tube along a polyline P (k, 3) with radii R (k,): rings of n vertices in a rotation-minimising frame."""
    T = G.unit(np.gradient(P, axis=0)); U, W = rmf(P, T)
    a = 2 * np.pi * np.arange(n) / n
    V = P[:, None, :] + R[:, None, None] * (np.cos(a)[None, :, None] * U[:, None, :] + np.sin(a)[None, :, None] * W[:, None, :])
    k = np.arange(len(P) - 1)[:, None] * n; i = np.arange(n)[None, :]
    a0 = (k + i).ravel(); a1 = (k + (i + 1) % n).ravel(); b0 = a0 + n; b1 = a1 + n
    F = np.concatenate([np.stack([a0, a1, b1], 1), np.stack([a0, b1, b0], 1)])
    return V.reshape(-1, 3), F


def hermite(p0, m0, p1, m1, step=0.002):
    L = np.linalg.norm(p1 - p0); k = max(int(L / step), 4)
    t = np.linspace(0, 1, k + 1)[:, None]
    h00 = 2 * t ** 3 - 3 * t ** 2 + 1; h10 = t ** 3 - 2 * t ** 2 + t; h01 = -2 * t ** 3 + 3 * t ** 2; h11 = t ** 3 - t ** 2
    return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1


# (key, HRA vessel, part, target: ('za', name) a placed Z-Anatomy vessel's centreline / ('hra', name pattern) an HRA
# vessel's wall, sexes)
BRIDGES = [
    ('uterine_artery_bridge_l', 'left_uterine_artery', 'arteries', ('za', 'Internal_iliac_arteryl'), ('female',)),
    ('uterine_artery_bridge_r', 'right_uterine_artery', 'arteries', ('za', 'Internal_iliac_arteryr'), ('female',)),
    ('uterine_vein_bridge_l', 'left_uterine_vein', 'veins', ('hra', 'internal_iliac_vein_[LR]', 'l'), ('female',)),
    ('uterine_vein_bridge_r', 'right_uterine_vein', 'veins', ('hra', 'internal_iliac_vein_[LR]', 'r'), ('female',)),
]


def bridges(sex, VES, log=print):
    """HRA vessels that stop short of the vessel they arise from / drain into (female: the uterine arteries end on the
    pelvic side wall about 4.5 cm from the internal iliac arteries, the uterine veins 1.2-2 cm short of the internal iliac
    veins) are joined to it by a swept tube of the HRA vessel's end radius: a cubic Hermite curve that leaves the HRA
    vessel's open ring along its axis (starting one radius inside it) and enters the target along the line between them
    (ending on the target's centreline, or half a target radius inside an HRA vein's wall). Returns {key: info}; the
    tubes are added to VES as placed vessels without a Z-Anatomy source."""
    from fit.vessels import hra_stub
    out = {}
    for key, hn, part, tgt, sexes in BRIDGES:
        if sex not in sexes: continue
        name, hm = hra_stub(sex, hn)
        if hm is None: continue
        hv, hf = hm
        ends = [e for e in G.stub_ends(hv, hf, min_r=0.0005) if e['kind'] == 'open']
        if tgt[0] == 'za':
            y = VES.get(tgt[1])
            if y is None or y.get('dropped'): continue
            cl = trunk(y['v'], y['f'])
            Q, _ = polyline_resample(cl['p'], 0.001)
            e = min(ends, key=lambda e: cKDTree(Q).query(e['c'])[0])
            q = Q[cKDTree(Q).query(e['c'])[1]]; inside = 0.0
        else:
            from fit.vessels import hra_stub as _hs
            tn, tm = _hs(sex, tgt[1], tgt[2])
            tv, tf = tm
            e = min(ends, key=lambda e: np.linalg.norm(tv - e['c'], axis=1).min())
            T = G.TriSet(tv, tf)
            qs, _ = T.closest(e['c'][None]); q0 = qs[0]
            u = G.unit(q0 - e['c']); q = q0 + u * 0.0015; inside = 0.0015
        p0 = e['c'] - e['n'] * e['r']                       # one radius inside the HRA vessel's open end
        L = float(np.linalg.norm(q - e['c']))
        m0 = e['n'] * 1.2 * L; m1 = G.unit(q - e['c']) * 0.8 * L
        P = hermite(p0, m0 * (L + e['r']) / max(L, 1e-6), q, m1)
        V_, F_ = sweep(P, np.full(len(P), e['r']))
        VES[key] = dict(za=key, name=key, part=part, side=key[-1], region='pelvis', v=V_, f=F_, placed=True, za_v=V_.copy(), za_f=F_,
                        orig_index=None, source=[], bridge=dict(start=e['c'], start_r=e['r'], end=q))
        out[key] = dict(hra=name, target=tgt[1], gap_bridged_mm=r2(L * 1000, 1), radius_mm=r2(e['r'] * 1000, 2), length_mm=r2(np.linalg.norm(np.diff(P, axis=0), axis=1).sum() * 1000, 1))
        log(f'  bridge {key}: {out[key]}')
    return out


def settle_bridges(F, VES, keys, log=print):
    """Push the bridge tubes out of bones and organs with the group's Fixer (ends pinned over 8 mm)."""
    keys = [k for k in keys if k in VES]
    if not keys: return None
    X = np.concatenate([VES[k]['v'] for k in keys]); off = np.cumsum([0] + [len(VES[k]['v']) for k in keys])
    Fc = np.concatenate([VES[k]['f'] + o for k, o in zip(keys, off[:-1])])
    groups = np.concatenate([np.full(len(VES[k]['v']), i) for i, k in enumerate(keys)])
    pin = []
    for k in keys:
        b = VES[k]['bridge']; v = VES[k]['v']
        d = np.minimum(np.linalg.norm(v - b['start'], axis=1) - b['start_r'], np.linalg.norm(v - b['end'], axis=1))
        pin.append(G.smoothstep(d / 0.008))
    X2, hist = F.run(X, groups, np.concatenate(pin), log=log, faces=Fc, iters=20, probe_iters=10)
    for i, k in enumerate(keys): VES[k]['v'] = X2[off[i]:off[i + 1]]
    return hist[-1] if hist else None


# ------------------------------------------------------------------------------------------------ internal thoracic vessels
IT_OFFSET = 0.0125     # centre this far lateral to the sternum's lateral border (m)
IT_BEHIND = 0.0015     # wall this far behind the costal cartilages' posterior surface (m)
IT_NAMES = ('Internal_thoracic_artery', 'Internal_thoracic_veins')
IT_GAP = 0.0005        # the vein runs medial to its artery, wall to wall this far apart (m)


def internal_thoracic(sex, VES, log=print, step=0.004):
    """The internal thoracic artery and veins run behind the costal cartilages about 1-1.5 cm lateral to the sternum
    (they hugged its edges or lay behind it): at each level of the placed sternum (rib cage group: manubrium and body)
    the section centre is moved to IT_OFFSET lateral to the sternum's border there and, where a costal cartilage or
    rib lies in front of that point, to IT_BEHIND behind its posterior surface; the shifts are smoothed along the vessel
    (sigma 1 cm) and faded in over 3 cm from the upper end (its origin / its end on the brachiocephalic vein).
    The vein (Z-Anatomy models the venae comitantes as one vessel, the single vein they form above the third cartilage)
    runs beside its artery on the medial side: its target offset is the artery's less both radii and IT_GAP (both at
    the same offset laid the artery inside the vein over 8-9 cm)."""
    rc = os.path.join(FIT, sex, 'ribcage')
    try:
        SV = np.concatenate([load(os.path.join(rc, n + '.npz'))[0] for n in ('manubrium', 'sternum_body')])
        man = json.load(open(os.path.join(rc, 'manifest.json')))
        CV = np.concatenate([load(os.path.join(rc, o['file']))[0] for o in man if o['part'] == 'costal_cartilage' or o['name'].lower().startswith('rib')])
    except (OSError, ValueError):
        return {}
    ylo, yhi = SV[:, 1].min(), SV[:, 1].max()
    ctree = cKDTree(CV[:, :2])
    out = {}
    for side in 'lr':
        sgn = 1.0 if side == 'l' else -1.0
        r_art = None
        for base in IT_NAMES:
            n = base + side; x = VES.get(n)
            if x is None or x.get('dropped') or not x['placed']: continue
            cl = trunk(x['v'], x['f'])
            if cl is None: continue
            s, q, _, _, _ = param(x, cl)
            b = np.floor(s / step).astype(int); nb = b.max() + 1
            want = np.zeros((nb, 3)); wx = np.zeros(nb); wz = np.zeros(nb); off0 = []
            r_v = np.median(np.linalg.norm(x['v'] - q, axis=1))
            if base.endswith('artery'): r_art = r_v; offset = IT_OFFSET
            else: offset = IT_OFFSET - ((r_art or 0.0012) + r_v + IT_GAP)
            for k in np.unique(b):
                c = x['v'][b == k].mean(0)
                if not (ylo + 0.004 < c[1] < yhi - 0.004): continue
                band = np.abs(SV[:, 1] - c[1]) < 0.006
                if not band.any(): continue
                edge = SV[band, 0].max() if side == 'l' else SV[band, 0].min()
                off0.append((c[0] - edge) * sgn)
                want[k, 0] = edge + sgn * offset - c[0]; wx[k] = 1
                nb_ = np.asarray(ctree.query_ball_point([edge + sgn * offset, c[1]], 0.004), int)
                nb_ = nb_[(CV[nb_, 2] > c[2] - 0.015) & (CV[nb_, 2] < c[2] + 0.030)] if len(nb_) else nb_   # the anterior wall only
                if len(nb_):
                    zp = CV[nb_, 2].min()                      # posterior surface of the cartilage / rib in front
                    want[k, 2] = (zp - IT_BEHIND - r_v) - c[2]; wz[k] = 1
            if not wx.any(): continue
            vx = gauss_along(want * np.array([1, 0, 0]), wx, step, 0.010)
            vz = gauss_along(want * np.array([0, 0, 1]), wz, step, 0.010)
            sk = (np.arange(nb) + 0.5) * step
            vec = (vx + vz) * G.smoothstep(sk / 0.030)[:, None]
            dv = np.stack([np.interp(s, sk, vec[:, a]) for a in range(3)], 1)
            x['v'] = x['v'] + dv
            out[n] = dict(levels=int(wx.sum()), target_offset_mm=r2(offset * 1000, 1), lateral_offset_before_mm=[r2(np.min(off0) * 1000, 1), r2(np.median(off0) * 1000, 1)] if off0 else None,
                          max_shift_mm=r2(np.linalg.norm(dv, axis=1).max() * 1000, 1))
            log(f'  internal thoracic {n}: {out[n]}')
    return out


def internal_thoracic_offsets(sex, VES):
    """Centre offset (mm) lateral to the placed sternum's border along the internal thoracic vessels: min / median."""
    rc = os.path.join(FIT, sex, 'ribcage')
    try: SV = np.concatenate([load(os.path.join(rc, n + '.npz'))[0] for n in ('manubrium', 'sternum_body')])
    except OSError: return {}
    out = {}
    for side in 'lr':
        sgn = 1.0 if side == 'l' else -1.0
        for base in IT_NAMES:
            x = VES.get(base + side)
            if x is None or x.get('dropped'): continue
            cl = trunk(x['v'], x['f'])
            if cl is None: continue
            Q, _ = polyline_resample(cl['p'], 0.004)
            off = []
            for c in Q:
                if not (SV[:, 1].min() + 0.004 < c[1] < SV[:, 1].max() - 0.004): continue
                band = np.abs(SV[:, 1] - c[1]) < 0.006
                if band.any(): off.append((c[0] - (SV[band, 0].max() if side == 'l' else SV[band, 0].min())) * sgn)
            if off: out[base + side] = dict(min_mm=r2(np.min(off) * 1000, 1), median_mm=r2(np.median(off) * 1000, 1), levels=len(off))
    return out


# ------------------------------------------------------------------------------------------------ carotid sheath
IJV_GAP = 0.001        # wall-to-wall gap between the internal jugular vein and the carotid in the sheath (m)
IJV_FAR = 0.004        # act only where the vein's centre is this much farther from its place than that


def carotid_sheath(sex, VES, log=print, step=0.004):
    """The internal jugular vein lies lateral to the common / internal carotid artery in the carotid sheath (the female
    right one ran 13-22 mm in front of it): at each level of the carotid (common carotid below its bifurcation,
    internal carotid above, up to the skull base), the vein's section centre is moved to the carotid's lateral side,
    wall to wall IJV_GAP apart (lateral = away from the midline, perpendicular to the carotid in the horizontal plane),
    where it lies more than IJV_FAR from that place; the shift is smoothed along the vein (sigma 1.5 cm) and faded out
    over 3 cm toward both ends (the jugular foramen above, the venous angle below)."""
    out = {}
    for side in 'lr':
        sgn = 1.0 if side == 'l' else -1.0
        v = VES.get(f'Internal_jugular_vein{side}')
        cca = VES.get('Left_common_carotid_artery' if side == 'l' else 'Right_common_carotid_artery')
        ica = VES.get(f'Internal_carotid_artery{side}')
        if v is None or v.get('dropped'): continue
        car = [c for c in (cca, ica) if c is not None and not c.get('dropped') and c['placed']]
        if not car: continue
        # carotid axis points with radii
        CP, CR = [], []
        for c in car:
            cl = trunk(c['v'], c['f'])
            if cl is None: continue
            s, q, _, _, _ = param(c, cl)
            Q, sQ = polyline_resample(cl['p'], 0.002)
            rr = np.linalg.norm(c['v'] - q, axis=1); b = np.floor(s / 0.002).astype(int)
            R = np.array([np.median(rr[b == k]) if (b == k).any() else np.nan for k in range(len(Q))])
            R = np.where(np.isfinite(R), R, np.nanmedian(R))
            CP.append(Q); CR.append(R)
        CP = np.concatenate(CP); CR = np.concatenate(CR)
        ytop = CP[:, 1].max() - 0.01                                # below the skull base entry of the ICA
        ct = cKDTree(CP[:, [1]])
        cl = trunk(v['v'], v['f'])
        s, q, _, _, _ = param(v, cl)
        rv = np.linalg.norm(v['v'] - q, axis=1)
        b = np.floor(s / step).astype(int); nb = b.max() + 1
        want = np.zeros((nb, 3)); w = np.zeros(nb); dist0 = []
        for k in np.unique(b):
            m = b == k; c = v['v'][m].mean(0)
            if c[1] > ytop or c[1] < CP[:, 1].min() + 0.01: continue
            ii = ct.query_ball_point([c[1]], 0.003)
            if not ii: continue
            j = ii[int(np.argmin(np.linalg.norm(CP[ii] - c, axis=1)))]
            lat = np.array([sgn, 0.0, 0.0])
            tgt = CP[j] + lat * (CR[j] + np.median(rv[m]) + IJV_GAP)
            dlt = tgt - c; dlt[1] = 0.0
            dist0.append(float(np.linalg.norm(c - tgt)))
            if np.linalg.norm(dlt) > IJV_FAR:
                want[k] = dlt * (1 - IJV_FAR / np.linalg.norm(dlt)); w[k] = 1
        if not w.any():
            out[f'Internal_jugular_vein{side}'] = dict(moved=False, max_offset_from_place_mm=r2(max(dist0) * 1000, 1) if dist0 else None); continue
        sk = (np.arange(nb) + 0.5) * step
        vec = gauss_along(want, w, step, 0.015)
        vec *= (G.smoothstep(sk / 0.03) * G.smoothstep((cl['s'][-1] - sk) / 0.03))[:, None]
        dv = np.stack([np.interp(s, sk, vec[:, a]) for a in range(3)], 1)
        v['v'] = v['v'] + dv
        out[f'Internal_jugular_vein{side}'] = dict(moved=True, levels=int(w.sum()), max_offset_from_place_before_mm=r2(max(dist0) * 1000, 1),
                                                   max_shift_mm=r2(np.linalg.norm(dv, axis=1).max() * 1000, 1))
        log(f'  carotid sheath Internal_jugular_vein{side}: {out[f"Internal_jugular_vein{side}"]}')
    return out


def ijv_position(VES):
    """Internal jugular vein centre relative to its carotid at the vein's levels: anterior (z) and lateral offsets (mm)."""
    out = {}
    for side in 'lr':
        sgn = 1.0 if side == 'l' else -1.0
        v = VES.get(f'Internal_jugular_vein{side}')
        car = [VES.get(n) for n in (('Left_common_carotid_artery' if side == 'l' else 'Right_common_carotid_artery'), f'Internal_carotid_artery{side}')]
        car = [c for c in car if c is not None and not c.get('dropped')]
        if v is None or not car: continue
        CP = np.concatenate([polyline_resample(trunk(c['v'], c['f'])['p'], 0.002)[0] for c in car])
        Q, _ = polyline_resample(trunk(v['v'], v['f'])['p'], 0.004)
        ant, lat = [], []
        for c in Q:
            ii = np.flatnonzero(np.abs(CP[:, 1] - c[1]) < 0.003)
            if not len(ii) or c[1] > CP[:, 1].max() - 0.01: continue
            j = ii[np.argmin(np.linalg.norm(CP[ii] - c, axis=1))]
            ant.append((c[2] - CP[j, 2]) * 1000); lat.append((c[0] - CP[j, 0]) * sgn * 1000)
        if ant: out[f'Internal_jugular_vein{side}'] = dict(anterior_mm=[r2(np.min(ant), 1), r2(np.median(ant), 1), r2(np.max(ant), 1)],
                                                          lateral_mm=[r2(np.min(lat), 1), r2(np.median(lat), 1), r2(np.max(lat), 1)], levels=len(ant))
    return out


# ------------------------------------------------------------------------------------------------ clearance pre-pass
def clear_obstacle(VES, names, obst, pins, clear=0.0010, step=0.004, sigma=0.008, iters=5, log=print, label='obstacle'):
    """Move vessels out of an obstacle (the lung lobes; the HRA aorta for the veins) by whole cross-sections before the
    general push-out: per centreline bin, the deepest vertex's missing clearance along the obstacle's outward direction
    there; spread along the vessel like the push-out (Gaussian sigma 8 mm, weights x ask, scaled by the nearest ask's
    kernel value, so an asking section gets its full push and its neighbours nearly the same), scaled by the junction
    pin weights (0 at the junction rings); repeated while any vertex is still inside (a moved section can meet another
    part of the obstacle). The push-out that follows then has few organ asks left (it was 10x slower with them)."""
    out = {}
    for n in names:
        x = VES[n]
        sd, dn, _ = obst.query(x['v'])
        if not np.isfinite(sd).any() or (clear - sd).max() <= 1e-4: continue
        d0 = float(max(0.0, -sd.min())); moved = 0.0
        for it in range(iters):
            need = clear - sd
            if (need > 1e-4).sum() == 0: break
            cl = trunk(x['v'], x['f'])
            if cl is None: break
            s, q, _, _, _ = param(x, cl)
            b = np.floor(s / step).astype(int); nb = b.max() + 1
            vec = np.zeros((nb, 3)); mag = np.zeros(nb)
            ask = need > 1e-4
            for k in np.unique(b[ask]):
                m = np.flatnonzero(b == k); i = m[np.argmax(need[m])]
                mag[k] = need[i]; vec[k] = dn[i] * need[i]
            sk = np.arange(nb) * step
            K = np.exp(-0.5 * ((sk[:, None] - sk[None]) / sigma) ** 2)
            W = K * mag[None]; den = W.sum(1); kmax = (K * (mag[None] > 0)).max(1)
            fld = np.where((den > 0)[:, None], kmax[:, None] * (W @ vec) / np.maximum(den, 1e-12)[:, None], 0.0)
            dv = np.stack([np.interp(s, sk + 0.5 * step, fld[:, a]) for a in range(3)], 1) * pins.get(n, np.ones(len(x['v'])))[:, None]
            x['v'] = x['v'] + dv; moved = max(moved, float(np.linalg.norm(dv, axis=1).max()))
            sd, dn, _ = obst.query(x['v'])
        out[n] = dict(depth_before_mm=r2(d0 * 1000, 1), depth_after_mm=r2(max(0.0, -float(np.nanmin(np.where(np.isfinite(sd), sd, 1.0)))) * 1000, 1),
                      max_shift_mm=r2(moved * 1000, 1))
    if out: log(f'  {label} clearance: ' + ', '.join(f'{k} {v["depth_before_mm"]}->{v["depth_after_mm"]} mm' for k, v in out.items()))
    return out
