"""Landmarks (in Z-Anatomy space), HRA targets and acceptance measurements for the skull fit (fit/skull.py)."""
import os, sys, re, json, time
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, sample_surface, dense_points, Surface, merge, area, orient_outward  # noqa: E402
from fit.common import hra_mesh, skin  # noqa: E402
from fit import skull_geom as G  # noqa: E402

MM = 1000.0
MUSCLE_AREAS = r'(Temporalis_muscle|Masseter|Bucinator|Sternocleidomastoid|Spinalis_capitis|Obliquus_superior_capitis|Rectus_posterior|Rectus_lateralis|trapezius|pterygoid)'
NEURO = ['frontal_bone', 'parietal_bone_l', 'parietal_bone_r', 'occipital_bone', 'temporal_bone_l', 'temporal_bone_r', 'sphenoid_bone', 'ethmoid_bone']


def r1(x, k=2):
    if x is None: return None
    x = float(x)
    return round(x, k) if np.isfinite(x) else None


# ------------------------------------------------------------------------------------------------ Z-Anatomy landmarks
def za_landmarks():
    zs = source('za-skeletal'); nv = source('za-nervous'); vs = source('za-visceral')
    L = {}
    oc = zs.get('Occipital_bone'); c1 = zs.get('Atlas_(C1)')
    # foramen magnum: basion / opisthion on the midline section, rim = innermost occipital points around the axis
    p = sample_surface(*oc, 300000, seed=1)
    mid = p[np.abs(p[:, 0]) < 0.0015]
    lowc = mid[:, 1] < np.quantile(mid[:, 1], 0.35)
    ant = mid[lowc & (mid[:, 2] > -0.03)]; ba = ant[np.argmin(ant[:, 2])]
    post = mid[lowc & (mid[:, 2] < -0.03) & (mid[:, 2] > -0.08)]; op = post[np.argmax(post[:, 2])]
    c = (ba + op) / 2; u = (ba - op) / np.linalg.norm(ba - op)
    n = np.cross(u, [1.0, 0, 0]); n /= np.linalg.norm(n); n = n if n[1] > 0 else -n
    w = np.cross(n, u)
    rel = p - c; hh = rel @ n; a = rel @ u; b = rel @ w
    rr = np.hypot(a, b); th = np.arctan2(b, a)
    band = np.abs(hh) < 0.004
    rim = []
    for t0 in np.linspace(-np.pi, np.pi, 73)[:-1]:
        m = band & (np.abs(np.angle(np.exp(1j * (th - t0)))) < np.pi / 72) & (rr < 0.03)
        if m.any(): rim.append(p[np.flatnonzero(m)[np.argmin(rr[m])]])
    rim = np.array(rim)
    L['fm_basion'], L['fm_opisthion'], L['fm_rim'] = ba, op, rim
    # plug over the foramen: fan from the rim centroid, rim pushed 2 mm outward so the plug edge sits inside the bone
    rc = rim.mean(0)
    ring = rc + (rim - rc) * (1 + 0.002 / np.linalg.norm(rim - rc, axis=1))[:, None]
    k = len(ring)
    L['fm_plug'] = (np.concatenate([rc[None], ring]), np.array([[0, 1 + i, 1 + (i + 1) % k] for i in range(k)]))
    # occipital condyles and the C1 superior facets (the articulating areas, by side)
    d = Surface(*c1, spacing=0.0005).dist(oc[0])
    d2 = Surface(*oc, spacing=0.0005).dist(c1[0])
    for s, sg in (('L', 1), ('R', -1)):
        L[f'occ_condyle_{s}'] = np.flatnonzero((d < 0.004) & (oc[0][:, 0] * sg > 0))
        L[f'c1_facet_{s}'] = c1[0][(d2 < 0.004) & (c1[0][:, 0] * sg > 0)]
    # mandibular condyles (heads) and the mandibular fossae
    mv = zs.get('Mandible')[0]
    for s, sg, tn in (('L', 1, 'Temporal_bonel'), ('R', -1, 'Temporal_boner')):
        side = mv[:, 0] * sg > 0.03
        ytop = mv[side, 1].max()
        L[f'mand_condyle_{s}'] = np.flatnonzero(side & (mv[:, 1] > ytop - 0.006))
        dd, _ = cKDTree(mv[L[f'mand_condyle_{s}']]).query(zs.get(tn)[0])
        L[f'tmj_fossa_{s}'] = np.flatnonzero(dd < 0.004)
    # pituitary gland body: vertices below the level where the gland narrows into the infundibular stalk
    pv = np.concatenate([vs.get(nm)[0] for nm in ('Adenohypophysis', 'Neurohypophysis')])
    ys = np.arange(pv[:, 1].min(), pv[:, 1].max() + 1e-3, 0.001)
    wid = []
    for y in ys:
        m = (pv[:, 1] >= y) & (pv[:, 1] < y + 0.001)
        wid.append(np.ptp(pv[m, 0]) if m.sum() > 2 else 0.0)
    wid = np.array(wid)
    kmax = int(np.argmax(wid)); kcut = next((k for k in range(kmax, len(ys)) if wid[k] < 0.5 * wid[kmax]), len(ys) - 1)
    ycut = ys[kcut]
    for nm in ('Adenohypophysis', 'Neurohypophysis'):
        L[f'pit_body_{nm}'] = np.flatnonzero(vs.get(nm)[0][:, 1] < ycut)
    L['pit_body_ycut'] = ycut
    # eyes
    for s, S in (('l', 'L'), ('r', 'R')):
        sc = nv.get('Sclera' + s); co = nv.get('Cornea' + s)
        L[f'eye_c_{S}'] = sc[0].mean(0)
        L[f'eye_apex_{S}'] = co[0][np.argmax(co[0][:, 2])]
    # bone areas covered by thick muscles (temporalis, masseter, buccinator, pterygoids, sternocleidomastoid and the
    # nuchal / suboccipital muscles): the soft tissue over them is muscle, not scalp or subcutaneous facial tissue
    es = [o for o in zs.index if re.search(MUSCLE_AREAS, o['name']) and o['name'][-1] not in 'ji']
    pts = []
    for o in es:
        m = zs.load_entry(o); pts.append(sample_surface(*m, int(max(20, area(*m) / 2e-6)), seed=o['i']))
    L['muscle_area_pts'] = np.concatenate(pts)
    L['muscle_area_names'] = sorted(set(o['name'] for o in es))
    return L


def skin_regions_za():
    """Z-Anatomy head skin samples labelled 1 = vault (frontal, parietal, occipital regions), 2 = face, 0 = other."""
    rg = source('za-regions')
    P, Lb = [], []
    for o in rg.index:
        if not o['path'].startswith('/Regions_of_headg') or o['name'][-1] in 'ji': continue
        if 'Auricular' in o['path']: continue
        path = o['path']
        if re.search(r'Eyebrow', path): lab = 2
        elif re.search(r'(Frontal_region|Parietal_region|Occipital_region)[lr]$', path): lab = 1
        elif 'Regions_of_faceg' in path and 'Orbital_region' not in path: lab = 2
        else: lab = 0
        v, f = rg.load_entry(o)
        n = int(max(30, area(v, f) / 4e-6))
        pts = sample_surface(v, f, n, seed=o['i']); lb = np.full(n, lab)
        if 'Nasal_region' in path:
            # the cartilaginous nose has the nasal cavity (air) beneath it: only the skin over the bony dorsum counts
            zs = source('za-skeletal')
            nb = merge([zs.get(k) for k in ('Nasal_bonel', 'Nasal_boner', 'Maxillal', 'Maxillar', 'Frontal_bone')])
            dnb, _ = cKDTree(dense_points(*nb, 0.0007)).query(pts)
            lb[dnb > 0.006] = 0
        P.append(pts); Lb.append(lb)
    return np.concatenate(P), np.concatenate(Lb)


def oriented(m):
    v, f = m
    return v, orient_outward(v, f)


# ------------------------------------------------------------------------------------------------ HRA targets
class Targets:
    def __init__(self, sex, brain_hp, brain_hl, brain_hn):
        self.sex = sex
        self.skin = skin(sex)
        self.brain_p, self.brain_l, self.brain_n = brain_hp, brain_hl, brain_hn
        self.eyes = {}
        for S in 'LR':
            sc = hra_mesh(sex, rf'^VH_[MF]_sclera_{S}$'); co = hra_mesh(sex, rf'^VH_[MF]_cornea_{S}$')
            m = merge([sc, co])
            g, sdf = G.local_sdf([m], h=0.0003, pad=0.004, close=2)
            c = sc[0].mean(0); ax = co[0].mean(0) - c; ax /= np.linalg.norm(ax)
            self.eyes[S] = dict(c=c, ax=ax, mesh=m, grid=g, sdf=sdf, pts=sample_surface(*m, 6000, seed=4),
                                apex=co[0][np.argmax((co[0] - c) @ ax)], r=float(np.linalg.norm(sc[0] - c, axis=1).mean()))
        self.c1 = oriented(hra_mesh(sex, r'^VH_[MF]_cervical_vertebra_1$'))
        self.c1_signed = G.SignedSurface(*self.c1, spacing=0.0004)
        self.c2 = hra_mesh(sex, r'^VH_[MF]_cervical_vertebra_2$')
        self.cord = [hra_mesh(sex, rf'^VH_[MF]_C{k}_segment_of_cervical_spinal_cord$') for k in (1, 2, 3, 4)]
        self.chiasm = hra_mesh(sex, r'^VH_[MF]_optic_chiasm$')
        self.hypothalamus = hra_mesh(sex, r'^Allen_(hypothalamus|tuberal_region_of_HTH|mammillary_region_of_HTH|preoptic_region_of_HTH|supraoptic_region_of_HTH)_[LR]$')
        self.thyroid_cart = hra_mesh(sex, r'^VH_[MF]_thyroid_cartilage$')
        self.epiglottis = hra_mesh(sex, r'^VH_[MF]_epiglott?ic_cartilage$')
        self.hyoid = hra_mesh(sex, r'^VH_M_hyoid$') if sex == 'male' else None
        self.orbit_contents = dict(
            extraocular_muscles=hra_mesh(sex, ('path', r'_muscles_of_eye/')),
            optic_nerves_and_sheaths=hra_mesh(sex, ('path', r'_nerves_of_eye/')),
            ophthalmic_vessels=hra_mesh(sex, r'^VH_[MF]_(ophthalmic|superior_ophthalmic|inferior_ophthalmic|opthalmic|central_retinal|long_posterior_ciliary)_(vein|artery)_[LR]$'))
        v, f = self.skin
        keep = v[:, 1] > v[:, 1].max() - 0.35
        fk = f[keep[f].all(1)]
        used = np.unique(fk); remap = -np.ones(len(v), np.int64); remap[used] = np.arange(len(used))
        self.head_skin = (v[used], remap[fk])
        self.skin_signed = G.SignedSurface(*self.head_skin, spacing=0.0008)
        self.skin_vn = G.vertex_normals(*self.head_skin)

    def cord_axis(self):
        cs = np.array([m[0].mean(0) for m in self.cord])
        c = cs.mean(0); _, _, Vt = np.linalg.svd(cs - c); ax = Vt[0] if Vt[0][1] > 0 else -Vt[0]
        return c, ax


# ------------------------------------------------------------------------------------------------ cavity status
class Cavity:
    def __init__(self, cranium_meshes, plug, h=0.001, ball=0.005):
        self.g, self.cav, self.wall, self.ext = G.cavity_grid(cranium_meshes, [plug], h=h, ball=ball)
        self.dcav = (ndimage.distance_transform_edt(~self.cav) * h).astype(np.float32)
        self.dext = (ndimage.distance_transform_edt(~self.ext) * h).astype(np.float32)

    def status(self, p):
        """(inside cavity bool, distance to the cavity for points outside it)."""
        dc = self.g.sample(self.dcav, p); de = self.g.sample(self.dext, p)
        inside = dc <= de
        return inside, dc


# ------------------------------------------------------------------------------------------------ measurements
def crit(name, value, threshold, ok, **extra):
    d = dict(criterion=name, value=value, threshold=threshold)
    d.update(extra); d['pass'] = bool(ok)
    return d


def groups(P):
    bones = [n for n in P if P[n][2] == 'skel_skull' and not re.match(r'(malleus|incus|stapes)', n)]
    cranium = [n for n in bones if n not in ('mandible', 'hyoid_bone')]
    teeth = [n for n in P if P[n][2] == 'teeth']
    return bones, cranium, teeth


ALL_PARTS = ('brain', 'eyes', 'skin', 'c1', 'fm', 'tmj', 'teeth', 'pit', 'hyoid')


def measure(sex, P, T, L, Wfull, za_skin, extra_info=None, log=print, parts=ALL_PARTS):
    """P: placed meshes {name: (v, f, part)} in HRA space. Wfull: callable mapping Z-Anatomy points to their final
    HRA position (warp + all corrections). L: Z landmarks. Returns (criteria list, details dict, aux)."""
    out, det, aux = [], {}, {}
    t0 = time.time()
    bones, cranium, teeth = groups(P)
    bone_all = merge([P[n][:2] for n in bones])
    cran = merge([P[n][:2] for n in cranium])
    hard = merge([P[n][:2] for n in bones + teeth])
    SB = Surface(*cran, spacing=0.0005)
    rim = Wfull(L['fm_rim']); fmc = rim.mean(0)
    _, _, Vt = np.linalg.svd(rim - fmc); fmn = Vt[2] if Vt[2][1] > 0 else -Vt[2]
    aux['fm'] = (fmc, fmn, rim)

    # ---------------- brain in the cranial cavity
    if 'brain' in parts:
        plug = (Wfull(L['fm_plug'][0]), L['fm_plug'][1])
        C = Cavity([P[n][:2] for n in cranium], plug, h=0.001, ball=0.005)
        bp = T.brain_p
        above = (bp - fmc) @ fmn > 0
        inside, _ = C.status(bp)
        d = SB.dist(bp)
        outside = ~inside
        close = d < 0.001
        viol = (outside | close) & above
        frac = float(viol[above].mean())
        gap = d[above & inside]
        out.append(crit('brain surface samples within 1 mm of the skull or outside the cranial cavity', r1(frac * 100, 3), '<= 0.5 %', frac <= 0.005,
                        unit='% of brain outer-surface samples above the foramen magnum', n_samples=int(above.sum()), n_within_1mm=int((close & above).sum()),
                        n_outside=int((outside & above).sum())))
        out.append(crit('minimum brain-to-inner-table gap', r1(gap.min() * MM), 'report', True, unit='mm',
                        p1_mm=r1(np.quantile(gap, 0.01) * MM), p5_mm=r1(np.quantile(gap, 0.05) * MM), median_mm=r1(np.median(gap) * MM)))
        below = ~above
        det['brainstem_below_foramen_magnum'] = dict(n_samples=int(below.sum()), max_depth_below_plane_mm=r1(-((bp[below] - fmc) @ fmn).min() * MM) if below.any() else 0.0,
                                                      min_dist_to_bone_mm=r1(d[below].min() * MM) if below.any() else None)
        aux['brain_viol'] = bp[viol]; aux['cavity'] = C
        log(f'  measure: brain {time.time() - t0:.0f}s')

    # ---------------- eyes in the orbits
    if 'eyes' in parts:
        hard_pts = dense_points(*cran, spacing=0.0004)
        for S in 'LR':
            e = T.eyes[S]
            near = hard_pts[np.linalg.norm(hard_pts - e['c'], axis=1) < 0.022]
            sd = e['grid'].sample(e['sdf'], near)
            pen = float(max(0.0, -sd.min()))
            dclear = cKDTree(near).query(e['pts'])[0]
            seat = Wfull(L[f'eye_c_{S}'][None])[0]
            off = e['c'] - seat
            out.append(crit(f'eye {S} penetration into orbital bone', r1(pen * MM), '<= 0.5 mm', pen <= 0.0005, unit='mm',
                            min_clearance_mm=r1(dclear.min() * MM), p5_clearance_mm=r1(np.quantile(dclear, 0.05) * MM)))
            out.append(crit(f'eyeball {S} centre to orbit centre offset', r1(np.linalg.norm(off) * MM), 'report', True, unit='mm',
                            offset_xyz_mm=[r1(x * MM, 1) for x in off],
                            note='orbit centre = the Z-Anatomy eyeball centre (its seat in the Z-Anatomy orbit) carried by the final skull deformation'))
            aux[f'eye_pen_{S}'] = near[sd < 0]
        if hasattr(T, 'orbit_contents'):
            ec = np.array([T.eyes[S]['c'] for S in 'LR'])
            lo = ec.min(0) - [0.03, 0.03, 0.06]; hi = ec.max(0) + [0.03, 0.03, 0.02]
            orb = [P[n][:2] for n in ('frontal_bone', 'sphenoid_bone', 'ethmoid_bone', 'maxilla_l', 'maxilla_r', 'zygomatic_bone_l', 'zygomatic_bone_r',
                                       'lacrimal_bone_l', 'lacrimal_bone_r', 'palatine_bone_l', 'palatine_bone_r') if n in P]
            go, so = G.local_sdf(orb, h=0.0004, pad=0.002, close=1)
            oc = {}
            for k, m in T.orbit_contents.items():
                if not len(m[1]): continue
                q = sample_surface(*m, 8000, seed=6)
                q = q[np.all((q > lo + 0.003) & (q < hi - 0.003), axis=1)]
                sd = go.sample(so, q)
                oc[k] = dict(fraction_inside_bone=r1((sd < 0).mean(), 4), max_depth_mm=r1(max(0.0, -sd.min()) * MM), n=int(len(q)))
            worst = max((v['fraction_inside_bone'] for v in oc.values()), default=0.0)
            out.append(crit('orbital contents (extraocular muscles, optic nerves and sheaths, ophthalmic vessels) inside orbital bone', r1(worst * 100, 2),
                            'report (<= 1 %)', worst <= 0.01, unit='% of surface samples (worst group)', groups=oc))
        log(f'  measure: eyes {time.time() - t0:.0f}s')

    # ---------------- soft tissue and bone inside the skin
    if 'skin' in parts:
        mus_tree = cKDTree(Wfull(L['muscle_area_pts']))
        HF = G.HardField([P[n][:2] for n in bones + teeth], h=0.0004)
        bs = dense_points(*bone_all, spacing=0.001)
        ss = T.skin_signed(bs)
        n_out = int((ss > 0).sum())
        out.append(crit('bone outside the skin', n_out, '0 samples', n_out == 0, unit='bone surface samples (1 mm spacing)', max_protrusion_mm=r1(max(0.0, ss.max()) * MM),
                        n_samples=int(len(bs))))
        aux['bone_out'] = bs[ss > 0]
        zsk, zlab = za_skin
        wz = Wfull(zsk)
        hv, hf = T.head_skin; vn = T.skin_vn
        dz, jz = cKDTree(wz).query(hv)
        vlab = np.where(dz < 0.008, zlab[jz], 0)
        for lab_id, name, lo, hi in ((1, 'vault', 3.0, 10.0), (2, 'face', 3.0, 20.0)):
            idx = np.flatnonzero(vlab == lab_id)
            if len(idx) > 3000: idx = np.random.default_rng(1).choice(idx, 3000, replace=False)
            o = hv[idx] - vn[idx] * 1e-4
            t = HF.march(o, -vn[idx], tmax=0.03)
            hit = np.isfinite(t)
            hitp = o - vn[idx] * np.where(hit, t, 0)[:, None]
            dm, _ = mus_tree.query(hitp)
            musc = hit & (dm < 0.004)
            if musc.any():
                tm = t[musc] * MM
                det[f'soft_tissue_{name}_muscle_covered_mm'] = dict(n=int(musc.sum()), p5=r1(np.quantile(tm, 0.05), 1), median=r1(np.median(tm), 1), p95=r1(np.quantile(tm, 0.95), 1),
                                                                   note='over temporalis / masseter / buccinator / nuchal-muscle attachment areas (muscle, not scalp); not in the statistic')
            aux[f'soft_{name}_muscle'] = (hv[idx][musc], t[musc] * MM)
            hit = hit & ~musc
            th = t[hit] * MM
            if not len(th):
                out.append(crit(f'soft tissue over the {name}', None, f'{lo:g}-{hi:g} mm', False)); continue
            p5, p50, p95 = np.quantile(th, [0.05, 0.5, 0.95])
            inr = float(((th >= lo) & (th <= hi)).mean())
            out.append(crit(f'soft tissue over the {name} (skin to bone along the inward skin normal; p5-p95)', [r1(p5, 1), r1(p95, 1)], f'{lo:g}-{hi:g} mm',
                            p5 >= lo and p95 <= hi, unit='mm', min_mm=r1(th.min(), 1), median_mm=r1(p50, 1), max_mm=r1(th.max(), 1),
                            fraction_in_range=r1(inr, 3), n_rays=int(len(idx)), n_hit_within_30mm=int(hit.sum())))
            aux[f'soft_{name}'] = (hv[idx][hit], th, -vn[idx][hit])
        log(f'  measure: skin {time.time() - t0:.0f}s')

    # ---------------- occipital condyles on the C1 superior facets
    if 'c1' in parts:
        occ = P['occipital_bone'][0]
        for S in 'LR':
            cp = occ[L[f'occ_condyle_{S}']]
            sd = T.c1_signed(cp)
            pen = float(max(0.0, -sd.min()))
            dd = np.abs(sd)
            q = np.sort(dd)[:max(3, len(dd) // 3)]  # the third of the condyle surface facing the facet
            out.append(crit(f'occipital condyle {S} to HRA C1 superior facet gap', r1(q.mean() * MM), '<= 4 mm', q.mean() <= 0.004 and pen <= 0.001, unit='mm',
                            min_mm=r1(dd.min() * MM), penetration_mm=r1(pen * MM)))

    # ---------------- foramen magnum over the spinal cord
    if 'fm' in parts:
        cc, ax = T.cord_axis()
        tt = ((fmc - cc) @ fmn) / (ax @ fmn); hitp = cc + tt * ax
        offv = hitp - fmc; offv -= (offv @ fmn) * fmn
        out.append(crit('foramen magnum centre over the HRA spinal cord axis (in-plane offset)', r1(np.linalg.norm(offv) * MM), '<= 5 mm', np.linalg.norm(offv) <= 0.005,
                        unit='mm', offset_xyz_mm=[r1(x * MM, 1) for x in offv]))
        bsx = T.brain_p[(T.brain_l == 2) & (np.abs((T.brain_p - fmc) @ fmn) < 0.004)]
        if len(bsx):
            mo = bsx.mean(0) - fmc; mo -= (mo @ fmn) * fmn
            det['medulla_centre_offset_from_foramen_centre_mm'] = r1(np.linalg.norm(mo) * MM)
        det['foramen_magnum'] = dict(length_mm=r1(np.linalg.norm(Wfull(L['fm_basion'][None])[0] - Wfull(L['fm_opisthion'][None])[0]) * MM),
                                     width_mm=r1((rim[:, 0].max() - rim[:, 0].min()) * MM), centre=[r1(x, 4) for x in fmc])

    # ---------------- mandibular condyles in the fossae
    if 'tmj' in parts:
        for S, tn in (('L', 'temporal_bone_l'), ('R', 'temporal_bone_r')):
            g_, sdf_ = G.local_sdf([P[tn][:2]], h=0.00035, pad=0.003, close=1)
            mv, mf = P['mandible'][:2]
            sel = np.isin(mf, L[f'mand_condyle_{S}']).all(1)
            cp = sample_surface(mv, mf[sel], 1500, seed=1)
            sd = g_.sample(sdf_, cp)
            pen = float(max(0.0, -sd.min())); js = float(sd.min())
            fos = P[tn][0][L[f'tmj_fossa_{S}']]
            dcf = np.linalg.norm(cp.mean(0) - fos.mean(0))
            out.append(crit(f'mandibular condyle {S} in the mandibular fossa (min joint space condyle-to-temporal bone)', r1(js * MM), '0-4 mm (no overlap)',
                            0 <= js <= 0.004, unit='mm', condyle_to_fossa_centroid_mm=r1(dcf * MM), overlap_mm=r1(pen * MM),
                            fraction_of_condylar_head_overlapping=r1((sd < 0).mean(), 3)))
        log(f'  measure: joints {time.time() - t0:.0f}s')

    # ---------------- teeth occlusion
    if 'teeth' in parts:
        up = [n for n in teeth if n.startswith('upper')]; lo_ = [n for n in teeth if n.startswith('lower')]
        U = merge([P[n][:2] for n in up]); Lw = merge([P[n][:2] for n in lo_])
        gu, su = G.local_sdf([U], h=0.00025, pad=0.002)
        gl, sl = G.local_sdf([Lw], h=0.00025, pad=0.002)
        pl = sample_surface(*Lw, 40000, seed=2); pu = sample_surface(*U, 40000, seed=3)
        pen1 = float(max(0.0, -gu.sample(su, pl).min())); pen2 = float(max(0.0, -gl.sample(sl, pu).min()))
        dmin = float(cKDTree(dense_points(*U, 0.0003)).query(pl)[0].min())
        out.append(crit('upper / lower teeth interpenetration', r1(max(pen1, pen2) * MM), '<= 1 mm', max(pen1, pen2) <= 0.001, unit='mm', min_gap_mm=r1(dmin * MM),
                        note='voxel SDF at 0.25 mm: depths below ~0.3 mm are at the voxel resolution'))
        log(f'  measure: teeth {time.time() - t0:.0f}s')

    # ---------------- pituitary in the sella, below the chiasm and hypothalamus
    if 'pit' in parts:
        ad = P['adenohypophysis'][:2]; ne = P['neurohypophysis'][:2]
        body = np.concatenate([ad[0][L['pit_body_Adenohypophysis']], ne[0][L['pit_body_Neurohypophysis']]])
        pit = merge([ad, ne])
        sph = P['sphenoid_bone'][:2]
        pp = sample_surface(*pit, 6000, seed=5)
        dsp = Surface(*sph, spacing=0.0003).dist(pp)
        gc = body.mean(0)
        up_ax = fmn  # the head's superior axis (normal of the foramen magnum plane)
        rng = np.random.default_rng(7); dirs = rng.normal(size=(1500, 3)); dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        cone = dirs[dirs @ (-up_ax) > np.cos(np.radians(50))]
        tl = G.ray_hits_accel(np.repeat(gc[None], len(cone), 0), cone, *sph, tmax=0.012)
        dch = Surface(*T.chiasm, spacing=0.0003).dist(pp)
        dhy = Surface(*T.hypothalamus, spacing=0.0003).dist(pp)
        body_top = (body @ up_ax).max(); ch_bot = (T.chiasm[0] @ up_ax).min()
        hit_frac = float(np.isfinite(tl).mean())
        det['pituitary'] = dict(gland_body_centre=[r1(x, 4) for x in gc], min_dist_to_sphenoid_mm=r1(dsp.min() * MM), median_dist_to_sphenoid_mm=r1(np.median(dsp) * MM),
                                sella_floor_cone_rays_hit_fraction=r1(hit_frac, 3), min_dist_to_optic_chiasm_mm=r1(dch.min() * MM),
                                gland_body_top_below_chiasm_bottom_mm=r1((ch_bot - body_top) * MM), min_dist_to_hypothalamus_mm=r1(dhy.min() * MM))
        out.append(crit('pituitary inside the sella turcica (rays from the gland centre within 50 deg of straight down hit the sella floor within 12 mm)', r1(hit_frac, 3),
                        '>= 0.95', hit_frac >= 0.95, unit='fraction', min_dist_to_sphenoid_mm=r1(dsp.min() * MM)))
        out.append(crit('pituitary gland below the optic chiasm (gland-body top to chiasm bottom, along the head axis)', r1((ch_bot - body_top) * MM), '> 0 mm', ch_bot - body_top > 0,
                        unit='mm', min_dist_pituitary_to_chiasm_mm=r1(dch.min() * MM)))
        out.append(crit('pituitary below the hypothalamus (min distance from the stalk to the Allen hypothalamus)', r1(dhy.min() * MM), 'report', True, unit='mm',
                        gland_body_top_below_hypothalamus_bottom_mm=r1(((T.hypothalamus[0] @ up_ax).min() - body_top) * MM)))
        log(f'  measure: pituitary {time.time() - t0:.0f}s')

    # ---------------- hyoid (placed only in the female; the male HRA body has its own)
    if 'hyoid' in parts:
        if 'hyoid_bone' in P:
            hy = P['hyoid_bone'][:2]; hp_ = sample_surface(*hy, 3000)
            det['hyoid'] = dict(min_dist_to_thyroid_cartilage_mm=r1(Surface(*T.thyroid_cart, spacing=0.0005).dist(hp_).min() * MM),
                                min_dist_to_epiglottis_mm=r1(Surface(*T.epiglottis, spacing=0.0005).dist(hp_).min() * MM),
                                min_dist_to_mandible_mm=r1(Surface(*P['mandible'][:2], spacing=0.0005).dist(hp_).min() * MM),
                                soft_tissue_min_mm=r1(-T.skin_signed(hp_).max() * MM))
    if extra_info: det.update(extra_info)
    return out, det, aux


class ZTargets:
    """The Z-Anatomy partners of the skull (its own brain, eyes, C1, chiasm, hypothalamus): source reference values."""

    def __init__(self, zp, zl):
        nv = source('za-nervous'); zs = source('za-skeletal')
        self.brain_p, self.brain_l = zp, zl
        self.eyes = {}
        for s, S in (('l', 'L'), ('r', 'R')):
            sc = nv.get('Sclera' + s); co = nv.get('Cornea' + s)
            m = merge([sc, co])
            g, sdf = G.local_sdf([m], h=0.0003, pad=0.004, close=2)
            c = sc[0].mean(0)
            self.eyes[S] = dict(c=c, mesh=m, grid=g, sdf=sdf, pts=sample_surface(*m, 6000, seed=4))
        self.c1 = oriented(zs.get('Atlas_(C1)'))
        self.c1_signed = G.SignedSurface(*self.c1, spacing=0.0004)
        self.chiasm = merge([nv.get('Optic_chiasml'), nv.get('Optic_chiasmr')])
        self.hypothalamus = nv.get('Hypothalamus')


def za_baseline(Z, L, zp, zl, log=print):
    """The same measurements on the unwarped Z-Anatomy skull with its own partners (what the source itself gives)."""
    T = ZTargets(zp, zl)
    P = {n: (v, f, part) for n, (v, f, part, _) in Z.items()}
    ident = lambda x: np.asarray(x, float)
    crits, det, _ = measure('za', P, T, L, ident, None, log=log, parts=('brain', 'eyes', 'c1', 'tmj', 'teeth', 'pit'))
    return crits, det
