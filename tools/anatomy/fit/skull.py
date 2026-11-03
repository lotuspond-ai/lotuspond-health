"""Skull group: places every cranial and facial bone, the mandible, the auditory ossicles, the teeth, the hyoid (female
only; the male HRA body has VH_M_hyoid) and the pituitary gland (Z-Anatomy, CC BY-SA 4.0) into each HRA head.

    python3 fit/skull.py [male|female|all]

Method (per body):
 1. Head warp (Z-Anatomy -> HRA): one thin-plate spline fitted to paired surfaces
      - brain: Z-Anatomy brain outer hull (cerebrum / cerebellum / brainstem) <-> Allen brain outer hull, matched
        label-wise by non-rigid ICP (no sliding of cerebellum onto occipital lobe),
      - eyes: Z-Anatomy eyeballs placed rigidly on the HRA eyeball centres and axes (orbit keeps its own size),
      - C1, C2, C3 and the thyroid cartilage (per-structure similarity ICP + projection, as fit.common does),
      - skin: Z-Anatomy face / scalp skin regions <-> HRA skin above the chin (non-rigid ICP inside the full warp).
 2. Joint seating: occipital condyles onto the HRA C1 superior facets (smooth local correction).
 3. Collision refinement with a smooth Gaussian displacement field shared by all skull bones (keeps their shape and
    contacts): brain off the inner table, eyes off the orbital walls, bone inside the skin with a minimum soft tissue.
 4. Mandible + lower teeth seated in the mandibular fossae / occlusion checked; pituitary checked in the sella.
 5. Measurements (report.json), QA renders, write_group().
"""
import os, sys, json, time, re
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source, sample_surface, dense_points, Surface, merge, compact, orient_outward, area, save, load  # noqa: E402
from lib.register import Sim, umeyama, icp, Warp, rotation_between  # noqa: E402
from fit.common import FIT, hra_mesh, hra_select, skin, skin_solid, anchor_meshes, anchor_controls, get_warp, write_group, Solid  # noqa: E402
from fit import skull_geom as G  # noqa: E402
from catalog import HRA_EXCLUDE  # noqa: E402

GROUP = 'skull'
SEED = 0
BRAIN_MARGIN = 0.0010  # inner table kept this far outside the Allen brain hull by the warp (dura + leptomeninges)

# ------------------------------------------------------------------------------------------------ what we place
BONES = [
    ('frontal_bone', 'Frontal_bone'), ('parietal_bone_l', 'Parietal_bonel'), ('parietal_bone_r', 'Parietal_boner'),
    ('occipital_bone', 'Occipital_bone'), ('temporal_bone_l', 'Temporal_bonel'), ('temporal_bone_r', 'Temporal_boner'),
    ('sphenoid_bone', 'Sphenoid_bone'), ('ethmoid_bone', 'Ethmoid_bone'),
    ('maxilla_l', 'Maxillal'), ('maxilla_r', 'Maxillar'), ('zygomatic_bone_l', 'Zygomatic_bonel'), ('zygomatic_bone_r', 'Zygomatic_boner'),
    ('nasal_bone_l', 'Nasal_bonel'), ('nasal_bone_r', 'Nasal_boner'), ('lacrimal_bone_l', 'Lacrimal_bonel'), ('lacrimal_bone_r', 'Lacrimal_boner'),
    ('palatine_bone_l', 'Palatine_bonel'), ('palatine_bone_r', 'Palatine_boner'),
    ('inferior_nasal_concha_l', 'Inferior_nasal_concha_bonel'), ('inferior_nasal_concha_r', 'Inferior_nasal_concha_boner'),
    ('vomer', 'Vomer'), ('mandible', 'Mandible'),
]
OSSICLES = [('malleus_l', 'Malleusl'), ('malleus_r', 'Malleusr'), ('incus_l', 'Incusl'), ('incus_r', 'Incusr'),
            ('stapes_l', 'Stapesl'), ('stapes_r', 'Stapesr')]
HYOID = ('hyoid_bone', 'Hyoid_bone')
PITUITARY = [('adenohypophysis', 'Adenohypophysis'), ('neurohypophysis', 'Neurohypophysis')]
NEURO = ['frontal_bone', 'parietal_bone_l', 'parietal_bone_r', 'occipital_bone', 'temporal_bone_l', 'temporal_bone_r', 'sphenoid_bone', 'ethmoid_bone']
ORBIT = ['frontal_bone', 'zygomatic_bone_l', 'zygomatic_bone_r', 'maxilla_l', 'maxilla_r', 'sphenoid_bone', 'ethmoid_bone',
         'lacrimal_bone_l', 'lacrimal_bone_r', 'palatine_bone_l', 'palatine_bone_r']


def snake(n):
    return re.sub(r'_+', '_', n.lower())


def tooth_list():
    zs = source('za-skeletal')
    out = []
    for o in zs.index:
        if o['path'].startswith('/Teethg/') and o['path'].count('/') == 3 and o['name'][-1] in 'lr':
            n = o['name']; base = n[:-1].replace('_tooth', '')
            out.append((snake(f'{base}_{n[-1]}'), n))
    return sorted(set(out))


def za_structures(sex):
    """[(name, part, za source, za name)] for this body."""
    s = [(n, 'skel_skull', 'za-skeletal', z) for n, z in BONES + OSSICLES]
    if sex == 'female': s.append((HYOID[0], 'skel_skull', 'za-skeletal', HYOID[1]))
    s += [(n, 'teeth', 'za-skeletal', z) for n, z in tooth_list()]
    s += [(n, 'pituitary', 'za-visceral', z) for n, z in PITUITARY]
    return s


def work_dir(sex):
    d = os.path.join(FIT, sex, GROUP, 'work'); os.makedirs(d, exist_ok=True); return d


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


# ------------------------------------------------------------------------------------------------ brain hulls
ALLEN_CEREBELLUM = r'cerebell|vermis'
ALLEN_BRAINSTEM = r'pons|medulla|olive|pyramidal|tegmentum|midbrain|colliculus|cerebral_peduncle|substantia_nigra|red_nucleus|aqueduct|fourth_ventricle|central_canal|pretectal'


def za_brain_items():
    nv = source('za-nervous'); items = []
    for o in nv.index:
        p = o['path']
        if not p.startswith('/Central_nervous_systemg/Braing') or o['name'][-1] in 'ji': continue
        lab = 1 if 'Cerebellumg' in p else 2 if 'Brainstemg' in p else 0
        items.append((nv.load_entry(o), lab))
    return items


def hra_brain_entries(sex):
    s = source(f'hra-{sex}')
    return [o for o in s.index if 'Allen_brain/' in o['path'] + '/' and not re.search(HRA_EXCLUDE, o['path'])]


def hra_brain_items(sex):
    s = source(f'hra-{sex}'); items = []
    for o in hra_brain_entries(sex):
        n = o['name']
        lab = 3 if 'white_matter_of_hindbrain' in n else 1 if re.search(ALLEN_CEREBELLUM, n) else 2 if re.search(ALLEN_BRAINSTEM, n) else 0
        items.append((s.load_entry(o), lab))
    return items


def brain_hulls(sex):
    """Labelled outer-hull samples of the Z-Anatomy brain and the Allen brain (cached)."""
    path = os.path.join(work_dir(sex), 'brain_hulls.npz')
    if os.path.exists(path):
        d = np.load(path); return d['zp'], d['zl'], d['hp'], d['hl'], d['hn']
    zp, zl = G.outer_samples(za_brain_items(), n_total=60000, h=0.0015)
    items = hra_brain_items(sex)
    hp, hl = G.outer_samples(items, n_total=80000, h=0.0015)
    amb = hl == 3
    if amb.any():  # hindbrain white matter: label as its nearest unambiguous cerebellum / brainstem neighbour
        ref = (hl == 1) | (hl == 2)
        _, j = cKDTree(hp[ref]).query(hp[amb]); hl[amb] = hl[ref][j]
    # outward normals of the Allen hull from a smoothed solid
    allm = merge([m for m, _ in items])
    g, sol = G.solid_from_patches([allm], h=0.0015, close=2)
    fld = ndimage.gaussian_filter(sol.astype(np.float32), 1.5)
    grad = np.stack([g.sample(np.gradient(fld, axis=a), hp) for a in range(3)], 1)
    hn = -grad / np.maximum(np.linalg.norm(grad, axis=1, keepdims=True), 1e-12)
    np.savez(path, zp=zp, zl=zl, hp=hp, hl=hl, hn=hn)
    return zp, zl, hp, hl, hn


# ------------------------------------------------------------------------------------------------ pair sets
def eye_frames_za():
    nv = source('za-nervous'); out = {}
    for s, S in (('l', 'L'), ('r', 'R')):
        sc = nv.get('Sclera' + s); co = nv.get('Cornea' + s)
        c = sc[0].mean(0); ax = co[0].mean(0) - c; ax /= np.linalg.norm(ax)
        out[S] = dict(c=c, ax=ax, mesh=merge([sc, co]), r=float(np.linalg.norm(sc[0] - c, axis=1).mean()))
    return out


def eye_frames_hra(sex):
    out = {}
    for S in 'LR':
        sc = hra_mesh(sex, rf'^VH_[MF]_sclera_{S}$'); co = hra_mesh(sex, rf'^VH_[MF]_cornea_{S}$')
        c = sc[0].mean(0); ax = co[0].mean(0) - c; ax /= np.linalg.norm(ax)
        out[S] = dict(c=c, ax=ax, sclera=sc, cornea=co, r=float(np.linalg.norm(sc[0] - c, axis=1).mean()))
    return out


def eye_pairs(sex, s_head, n=250):
    """Z-Anatomy eyeball samples -> the same samples placed rigidly (head scale) on the HRA eyeball centre and axis.
    The orbit therefore keeps the Z-Anatomy eye-to-wall clearance (plus the size difference of the eyeballs)."""
    za, hr = eye_frames_za(), eye_frames_hra(sex)
    S, D = [], []
    for k in 'LR':
        p = sample_surface(*za[k]['mesh'], n, seed=11)
        R = rotation_between(za[k]['ax'], hr[k]['ax'])
        q = hr[k]['c'] + s_head * (p - za[k]['c']) @ R.T
        S += [p, za[k]['c'][None]]; D += [q, hr[k]['c'][None]]
    return np.concatenate(S), np.concatenate(D)


def vertebra_pairs(sex, keys=('C1', 'C2', 'C3', 'thyroid_cartilage'), report=None):
    anchors = anchor_meshes(sex, keys=list(keys))
    T0 = get_warp(sex, 'trunk').pre
    src, dst, w = anchor_controls(anchors, T0, per_area=8.0, nmin=60, nmax=250, seed=3, report=report)
    return src, dst


def optic_pairs(sex, T0, report=None):
    """Optic chiasm and optic nerves: aligns the sella / chiasmatic sulcus and the optic canals with the HRA nerves."""
    nv = source('za-nervous')
    anchors = {
        'optic_chiasm': dict(za=merge([nv.get('Optic_chiasml'), nv.get('Optic_chiasmr')]), hra=hra_mesh(sex, r'^VH_[MF]_optic_chiasm$'), weight=2.0),
        'optic_nerve_l': dict(za=nv.get('Optic_nerve_(II)l'), hra=hra_mesh(sex, r'^VH_[MF]_left_optic_nerve$'), weight=1.5),
        'optic_nerve_r': dict(za=nv.get('Optic_nerve_(II)r'), hra=hra_mesh(sex, r'^VH_[MF]_right_optic_nerve$'), weight=1.5),
    }
    src, dst, w = anchor_controls(anchors, T0, per_area=8.0, nmin=50, nmax=150, seed=9, report=report)
    return src, dst


def head_skin_za():
    rg = source('za-regions')
    es = [o for o in rg.index if o['path'].startswith('/Regions_of_headg') and 'Auricular' not in o['path'] and o['name'][-1] not in 'ji']
    ears = [o for o in rg.index if o['path'].startswith('/Regions_of_headg/Auricular') and o['name'][-1] not in 'ji']
    ec = {}
    for s in 'lr':
        e = [o for o in ears if o['name'].endswith(s)]
        ec[s] = rg.load(e)[0].mean(0)
    return rg.load(es), ec


def head_skin_hra(sex, ref_pts, ear_centres, radius=0.014, ear_r=0.03):
    """HRA skin samples near the (provisionally warped) Z-Anatomy head skin, without the ears."""
    sk = skin(sex)
    p = dense_points(*sk, spacing=0.002)
    lo = ref_pts.min(0) - 0.03; hi = ref_pts.max(0) + 0.03
    p = p[np.all((p > lo) & (p < hi), axis=1)]
    d, _ = cKDTree(ref_pts).query(p)
    keep = d < radius
    for c in ear_centres: keep &= np.linalg.norm(p - c, axis=1) > ear_r
    return p[keep]


def build_head_warp(sex, rebuild=False, hyoid_pairs=False):
    """The head warp (cached as its control points)."""
    wd = work_dir(sex)
    path = os.path.join(wd, 'head_warp.npz')
    if os.path.exists(path) and not rebuild:
        d = np.load(path)
        pre = Sim(float(d['s']), d['R'], d['t'])
        return Warp(d['src'], d['dst'], pre=pre, smoothing=float(d['smoothing']), max_points=10 ** 9), json.load(open(os.path.join(wd, 'head_warp.json')))
    info = {}
    t0 = time.time()
    zp, zl, hp, hl, hn = brain_hulls(sex)
    log(sex, 'brain hulls', len(zp), len(hp))
    # 1. similarity on the brain
    c0 = Sim(1.0, np.eye(3), hp.mean(0) - zp.mean(0))
    T, err = icp(zp[::3], hp, init=c0, iters=80, scale=True, trim=0.95)
    info['brain_similarity'] = repr(T); info['brain_similarity_rms_mm'] = round(err * 1000, 2)
    log(sex, 'brain similarity', T, round(err * 1000, 2))
    # 2. label-wise non-rigid brain correspondences
    rng = np.random.default_rng(SEED)
    sub = rng.choice(len(zp), min(len(zp), 12000), replace=False)
    Wb, cur = G.nricp_labels(zp[sub], zl[sub], hp, hl, T, schedule=(3e2, 1e2, 3e1, 1e1, 3), n_ctrl=3000, trim=0.9)
    proj, dist = G.project_labels(cur, zl[sub], hp, hl)
    _, jn = cKDTree(hp).query(proj)
    chi = hra_mesh(sex, r'^VH_[MF]_optic_chiasm$')
    dchi, _ = cKDTree(chi[0]).query(proj)
    ok = (dist < 0.003) & (dchi > 0.004)
    # targets on the Allen hull moved outward by the leptomeningeal / dural gap the inner table should keep
    bsrc = zp[sub][ok]; bdst = proj[ok] + BRAIN_MARGIN * hn[jn[ok]]
    info['brain_nricp_resid_mm'] = [round(float(np.mean(dist) * 1000), 2), round(float(np.quantile(dist, 0.9) * 1000), 2)]
    log(sex, 'brain nricp resid mean/p90 mm', info['brain_nricp_resid_mm'])
    # 3. eyes
    esrc, edst = eye_pairs(sex, T.s)
    # 4. vertebrae / larynx
    rep = {}
    keys = ['C1', 'C2', 'C3', 'thyroid_cartilage'] + (['hyoid'] if hyoid_pairs and sex == 'male' else [])
    vsrc, vdst = vertebra_pairs(sex, keys=keys, report=rep)
    info['vertebra_anchors'] = rep
    rep2 = {}
    osrc, odst = optic_pairs(sex, T, report=rep2)
    info['optic_anchors'] = rep2
    # fixed pairs (subsample the brain to keep the spline system small)
    bi = G.fps(bsrc, 2600, seed=1)
    fs = np.concatenate([bsrc[bi], esrc, vsrc, osrc]); fd = np.concatenate([bdst[bi], edst, vdst, odst])
    # 5. skin: correspondences found inside the full warp
    zsk, ear = head_skin_za()
    zs_pts = sample_surface(*zsk, 6000, seed=5)
    prov = Warp(fs, fd, pre=T, smoothing=3.0 * len(fs) * 1e-6, max_points=10 ** 9)
    ref = prov(zs_pts)
    ears = prov(np.array([ear['l'], ear['r']]))
    hs = head_skin_hra(sex, ref, ears)
    log(sex, 'skin samples za/hra', len(zs_pts), len(hs))
    ssub = G.fps(zs_pts, 2200, seed=2)
    W, cur = G.nricp_labels(zs_pts[ssub], np.zeros(len(ssub), int), hs, np.zeros(len(hs), int), prov,
                            schedule=(3e1, 1e1, 3), n_ctrl=2200, trim=0.9, extra=(fs, fd))
    d_sk, j = cKDTree(hs).query(cur)
    good = d_sk < 0.004
    ssrc = zs_pts[ssub][good]; sdst = hs[j[good]]
    info['skin_icp_resid_mm'] = [round(float(np.mean(d_sk) * 1000), 2), round(float(np.quantile(d_sk, 0.9) * 1000), 2)]
    log(sex, 'skin resid mean/p90 mm', info['skin_icp_resid_mm'])
    # 6. final warp: one spline through all pairs
    src = np.concatenate([fs, ssrc]); dst = np.concatenate([fd, sdst])
    smoothing = 3.0 * len(src) * 1e-6
    W = Warp(src, dst, pre=T, smoothing=smoothing, max_points=10 ** 9)
    np.savez(path, src=T.inverse()(W.centres), dst=W.centres + W.rbf(W.centres), s=T.s, R=T.R, t=T.t, smoothing=smoothing)
    W = Warp(T.inverse()(W.centres), W.centres + W.rbf(W.centres), pre=T, smoothing=smoothing, max_points=10 ** 9)
    # residuals per pair set
    def res(s, d): r = np.linalg.norm(W(s) - d, axis=1) * 1000; return [round(float(r.mean()), 2), round(float(np.quantile(r, 0.9)), 2)]
    info['residual_mean_p90_mm'] = dict(brain=res(bsrc, bdst), eyes=res(esrc, edst), vertebrae=res(vsrc, vdst), optic=res(osrc, odst), skin=res(ssrc, sdst))
    info['n_pairs'] = dict(brain=int(len(bi)), eyes=int(len(esrc)), vertebrae=int(len(vsrc)), optic=int(len(osrc)), skin=int(len(ssrc)))
    info['brain_margin_mm'] = BRAIN_MARGIN * 1000
    info['seconds'] = round(time.time() - t0, 1)
    json.dump(info, open(os.path.join(wd, 'head_warp.json'), 'w'), indent=1)
    log(sex, 'head warp', info['residual_mean_p90_mm'])
    return W, info


def load_za(sex):
    out = {}
    for name, part, src, zname in za_structures(sex):
        v, f = source(src).get(zname)
        out[name] = (v, f, part, zname)
    return out


# ------------------------------------------------------------------------------------------------ refinement
REF = dict(gap_brain=0.0016, soft_min=0.0034, soft_max_vault=0.0095, eye_clear=0.0010, condyle_gap=0.0015, ball=0.005,
           sigma=0.012, sigma_fine=0.006, ridge=1e-3, iters=4, iters_fine=3, w_brain=3.0, w_brain_out=5.0, w_skin_out=6.0, w_skin=2.0, w_skin_far=1.0,
           w_eye=3.0, w_condyle=3.0, w_keep=0.6, max_step=0.0015, skin_hard=0.0008, orbit_clear=0.0003)


def voxel_subsample(p, h):
    k = np.round(p / h).astype(np.int64)
    _, i = np.unique(k, axis=0, return_index=True)
    return np.sort(i)


class MultiField:
    """Sum of Gaussian correction fields (coarse to fine)."""

    def __init__(self): self.fields = []

    def __call__(self, x):
        out = np.zeros_like(np.asarray(x, float))
        for f in self.fields: out += f(x)
        return out


def refine(sex, Wz, Z, T, L, M, zsk, cfg=REF, log=log):
    """Smooth correction field D (in head-warp space) so that the brain clears the inner table, the eyes clear the
    orbital walls, bone and teeth stay inside the skin with a minimum soft-tissue cover (and the scalp over the vault
    does not exceed the upper bound), and the occipital condyles rest on the C1 facets. Gaussian fields (a coarse
    sigma, then a finer one) move every skull bone, tooth and the pituitary together, so the bones keep their shape and
    their contacts; a keep term holds the field at zero wherever nothing is violated."""
    bones = [n for n in Z if Z[n][2] == 'skel_skull' and not re.match(r'(malleus|incus|stapes|hyoid)', n)]
    teeth = [n for n in Z if Z[n][2] == 'teeth']
    cranium = [n for n in bones if n != 'mandible']
    V0 = {n: Wz(Z[n][0]) for n in Z}
    F = {n: Z[n][1] for n in Z}
    S0, own = [], []
    for n in bones + teeth:
        i = voxel_subsample(V0[n], 0.0015); S0.append(V0[n][i]); own += [n] * len(i)
    S0 = np.concatenate(S0); own = np.array(own)
    is_cran = np.isin(own, cranium)
    cond0 = np.concatenate([V0['occipital_bone'][L[f'occ_condyle_{S}']] for S in 'LR'])
    S0 = np.concatenate([S0, cond0]); is_cond = np.r_[np.zeros(len(own), bool), np.ones(len(cond0), bool)]
    is_cran = np.r_[is_cran, np.ones(len(cond0), bool)]
    D = MultiField()
    plug0 = Wz(L['fm_plug'][0]); rim0 = Wz(L['fm_rim'])
    bp, bn = T.brain_p, T.brain_n
    hv, hf = T.head_skin; vn = T.skin_vn
    zp, zl = zsk
    wzp0 = Wz(zp); mpts0 = Wz(L['muscle_area_pts'])
    dz, jz = cKDTree(wzp0).query(hv)
    vault_all = np.flatnonzero((dz < 0.008) & (zl[jz] == 1))[::2]
    hist = []
    relaxed = np.zeros(len(S0), bool)
    stages = [(cfg['sigma'], cfg['iters']), (cfg['sigma_fine'], cfg['iters_fine'])]
    it = 0
    for si, (sigma, n_it) in enumerate(stages):
        field = G.Correction(S0[G.fps(S0, 2500 if si == 0 else 4500, seed=4 + si)], sigma=sigma, ridge=cfg['ridge'])
        D.fields.append(field)
        for k in range(n_it + (1 if si == len(stages) - 1 else 0)):
            disp = D(S0); S = S0 + disp
            cur = {n: (V0[n] + D(V0[n]), F[n]) for n in cranium + ['mandible'] + teeth}
            cran = merge([cur[n] for n in cranium])
            rim = rim0 + D(rim0); fmc = rim.mean(0)
            _, _, Vt = np.linalg.svd(rim - fmc); fmn = Vt[2] if Vt[2][1] > 0 else -Vt[2]
            C = M.Cavity([cur[n] for n in cranium], (plug0 + D(plug0), L['fm_plug'][1]), h=0.0015, ball=cfg['ball'])
            hgt = (bp - fmc) @ fmn
            above = hgt > 0.001
            inside, dcav = C.status(bp)
            db = Surface(*cran, spacing=0.0006).dist(bp)
            rad = np.linalg.norm((bp - fmc) - hgt[:, None] * fmn, axis=1)
            fm_zone = (hgt < 0.008) & (rad < 0.022)   # the medulla legitimately leaves the cavity through the foramen
            inside = inside | fm_zone
            sgn = np.where(inside, db, -np.maximum(dcav, 1e-4))
            need = np.minimum(cfg['gap_brain'] - sgn, cfg['max_step'])
            vb = above & (need > 0)
            fdisp = field(S0)  # this stage's own displacement: targets are increments of it
            tgt = fdisp.copy(); wts = np.full(len(S0), cfg['w_keep']); best = np.zeros(len(S0))
            if vb.any():
                ci = np.flatnonzero(is_cran); tr = cKDTree(S[ci])
                for kk, js in zip(np.flatnonzero(vb), tr.query_ball_point(bp[vb], 0.006)):
                    if not js: continue
                    js = ci[np.asarray(js)]; js = js[need[kk] > best[js]]
                    tgt[js] = fdisp[js] + need[kk] * bn[kk]; best[js] = need[kk]
                    wts[js] = np.maximum(wts[js], cfg['w_brain_out'] if not inside[kk] else cfg['w_brain'])
            ss = T.skin_signed(S)
            _, js_ = T.skin_signed.tree.query(S); nsk = T.skin_signed.n[js_]
            # where the brain needs the bone to move out (the Allen brain lies within a few mm of the skin) the brain
            # wins over the soft-tissue minimum; only bone closer than `skin_hard` to the skin is pulled back in
            relaxed |= best > 0
            smin = np.where(relaxed, cfg['skin_hard'], cfg['soft_min'])
            vs = ss > -smin
            tgt[vs] = fdisp[vs] - np.minimum(ss[vs] + smin[vs], cfg['max_step'])[:, None] * nsk[vs]
            wts[vs] = np.where(ss[vs] > -cfg['skin_hard'], cfg['w_skin_out'], cfg['w_skin'])
            # orbital contents (extraocular muscles, optic nerves, ophthalmic vessels): orbital walls clear them
            near_orb = np.flatnonzero(np.min([np.linalg.norm(S - E['c'], axis=1) for E in T.eyes.values()], axis=0) < 0.045)
            so_ = T.orbit_signed(S[near_orb]); _, ko = T.orbit_signed.tree.query(S[near_orb]); no_ = T.orbit_signed.n[ko]
            # only near the contents' surfaces (the sign of a thin tube's signed distance is unreliable far from it)
            bado = (so_ < cfg['orbit_clear']) & (so_ > -0.002)
            jo = near_orb[bado]
            tgt[jo] = fdisp[jo] + np.minimum(cfg['orbit_clear'] - so_[bado], cfg['max_step'])[:, None] * no_[bado]; wts[jo] = np.maximum(wts[jo], cfg['w_eye'])
            # scalp over the vault thicker than the upper bound (not over muscle attachment areas): pull bone outward
            HF = G.HardField([cur[n] for n in bones + teeth], spacing=0.0005)
            t = HF.march(hv[vault_all] - vn[vault_all] * 1e-4, -vn[vault_all], tmax=0.03)
            hit = np.isfinite(t)
            hitp = hv[vault_all] - vn[vault_all] * np.where(hit, t, 0)[:, None]
            dm, _ = cKDTree(mpts0 + D(mpts0)).query(hitp)
            far = hit & (t > cfg['soft_max_vault']) & (dm > 0.004)
            if far.any():
                dd, jj = cKDTree(S).query(hitp[far]); ok = dd < 0.003
                jj = jj[ok]; amt = np.minimum(t[far][ok] - cfg['soft_max_vault'], cfg['max_step'])
                free = ~vs[jj] & (best[jj] == 0)
                tgt[jj[free]] = fdisp[jj[free]] + amt[free][:, None] * vn[vault_all][far][ok][free]
                wts[jj[free]] = cfg['w_skin_far']
            n_eye = 0
            for E in T.eyes.values():
                m = np.flatnonzero(np.linalg.norm(S - E['c'], axis=1) < 0.022)
                sd = E['grid'].sample(E['sdf'], S[m]); bad = sd < cfg['eye_clear']
                if bad.any():
                    j = m[bad]; rdir = S[j] - E['c']; rdir /= np.linalg.norm(rdir, axis=1, keepdims=True)
                    tgt[j] = fdisp[j] + (cfg['eye_clear'] - sd[bad])[:, None] * rdir; wts[j] = cfg['w_eye']; n_eye += int(bad.sum())
            jc = np.flatnonzero(is_cond)
            s1 = T.c1_signed(S[jc]); _, k1 = T.c1_signed.tree.query(S[jc]); n1 = T.c1_signed.n[k1]
            face = np.abs(s1) <= np.quantile(np.abs(s1), 0.5)
            jc, s1, n1 = jc[face], s1[face], n1[face]
            tgt[jc] = fdisp[jc] + (cfg['condyle_gap'] - s1)[:, None] * n1; wts[jc] = cfg['w_condyle']
            stat = dict(it=it, sigma_mm=sigma * 1000, brain_viol_1p6=round(float(vb[above].mean()), 4),
                        brain_within_1mm=round(float(((sgn < 0.001) & above).mean()), 4), brain_out=int((above & ~inside).sum()),
                        min_gap_mm=round(float(sgn[above].min() * 1000), 2), skin_viol=int(vs.sum()), bone_out=int((ss > 0).sum()),
                        vault_thick=int(far.sum()), eye_viol=n_eye, orbit_viol=int(bado.sum()), condyle_gap_mm=round(float(np.mean(np.abs(s1)) * 1000), 2),
                        max_disp_mm=round(float(np.linalg.norm(disp, axis=1).max() * 1000), 2))
            hist.append(stat); log(sex, 'refine', stat); it += 1
            if si == len(stages) - 1 and k == n_it: break
            field.fit(S0, tgt, wts)
    return D, hist


# ------------------------------------------------------------------------------------------------ QA renders
COLORS = dict(bone='#e9e3cf', mandible='#e2d9bd', teeth='#fffdf2', pituitary='#e0475a', brain='#d6a2b1', eyes='#f4f7ff',
              skin='#d9a88f', c1='#b8c4a0', cord='#efe08a', ossicle='#f0b040', hyoid='#c9d6a8', chiasm='#f2d23c')


def render_qa(sex, P, T, outdir, prefix='qa', extra=()):
    from lib.qa import render_views
    bones = merge([P[n][:2] for n in P if P[n][2] == 'skel_skull' and n not in ('mandible',) and not re.match(r'(malleus|incus|stapes)', n)])
    mand = P['mandible'][:2]
    teeth = merge([P[n][:2] for n in P if P[n][2] == 'teeth'])
    pit = merge([P[n][:2] for n in P if P[n][2] == 'pituitary'])
    oss = merge([P[n][:2] for n in P if re.match(r'(malleus|incus|stapes)', n)])
    brain = hra_mesh(sex, ('path', r'Allen_brain/'))
    eyes = merge([T.eyes[S]['mesh'] for S in 'LR'])
    c12 = merge([T.c1, T.c2]) if hasattr(T, 'c2') else T.c1
    cord = merge(T.cord)
    hs = T.head_skin
    c = brain[0].mean(0)
    items_skin = [dict(mesh=hs, color=COLORS['skin'], opacity=0.22)]
    core = [dict(mesh=bones, color=COLORS['bone']), dict(mesh=mand, color=COLORS['mandible']), dict(mesh=teeth, color=COLORS['teeth']),
            dict(mesh=eyes, color=COLORS['eyes']), dict(mesh=c12, color=COLORS['c1']), dict(mesh=cord, color=COLORS['cord'])] + list(extra)
    if 'hyoid_bone' in P: core.append(dict(mesh=P['hyoid_bone'][:2], color=COLORS['hyoid']))
    elif T.hyoid is not None: core.append(dict(mesh=T.hyoid, color=COLORS['hyoid']))
    R = 0.17
    cams = {'front': dict(dir=(0, 0.05, 1), target=c - [0, 0.03, 0], radius=R), 'side': dict(dir=(1, 0.05, 0), target=c - [0, 0.03, 0], radius=R),
            'back': dict(dir=(0, 0.05, -1), target=c - [0, 0.03, 0], radius=R), 'top': dict(dir=(0, 1, 0.001), up=(0, 0, -1), target=c, radius=0.13)}
    files = render_views(items_skin + core, cams, os.path.join(outdir, prefix))
    # brain + eyes inside the ghosted skull (bone ghosted)
    cams2 = {'brain-side': dict(dir=(1, 0.05, 0.2), target=c, radius=0.14), 'brain-front': dict(dir=(0, 0.05, 1), target=c, radius=0.14)}
    files += render_views([dict(mesh=brain, color=COLORS['brain']), dict(mesh=eyes, color=COLORS['eyes']), dict(mesh=pit, color=COLORS['pituitary']),
                           dict(mesh=bones, color=COLORS['bone'], opacity=0.35), dict(mesh=mand, color=COLORS['mandible'], opacity=0.35)],
                          cams2, os.path.join(outdir, prefix))
    # midline sagittal cut through the pituitary: brain in the cranium, pituitary in the sella
    pc = pit[0].mean(0)
    clip = [dict(normal=(-1, 0, 0), constant=float(pc[0]))]
    items = [dict(mesh=hs, color=COLORS['skin'], opacity=0.25), dict(mesh=bones, color=COLORS['bone']), dict(mesh=mand, color=COLORS['mandible']),
             dict(mesh=teeth, color=COLORS['teeth']), dict(mesh=brain, color=COLORS['brain']), dict(mesh=pit, color=COLORS['pituitary']),
             dict(mesh=T.chiasm, color=COLORS['chiasm']), dict(mesh=c12, color=COLORS['c1']), dict(mesh=cord, color=COLORS['cord'])]
    files += render_views(items, {'sagittal': dict(dir=(1, 0, 0), target=c - [0, 0.03, 0], radius=0.15, clip=clip),
                                  'sella': dict(dir=(1, 0.0, 0.0), target=pc, radius=0.028, clip=clip)}, os.path.join(outdir, prefix))
    # axial cut through the orbits: eyes in the orbits
    ec = (T.eyes['L']['c'] + T.eyes['R']['c']) / 2
    files += render_views([dict(mesh=bones, color=COLORS['bone']), dict(mesh=eyes, color=COLORS['eyes']), dict(mesh=brain, color=COLORS['brain']),
                           dict(mesh=hs, color=COLORS['skin'], opacity=0.25)],
                          {'orbits': dict(dir=(0, 1, 0.001), up=(0, 0, -1), target=ec - [0, 0, 0.02], radius=0.07, clip=[dict(normal=(0, -1, 0), constant=float(ec[1]))])},
                          os.path.join(outdir, prefix))
    # occipito-atlantal joint and foramen magnum from below / behind
    fm = P['occipital_bone'][0][:, :].mean(0)
    files += render_views([dict(mesh=bones, color=COLORS['bone']), dict(mesh=c12, color=COLORS['c1']), dict(mesh=cord, color=COLORS['cord']),
                           dict(mesh=mand, color=COLORS['mandible']), dict(mesh=brain, color=COLORS['brain'])],
                          {'base': dict(dir=(0, -1, -0.35), up=(0, 0, 1), target=T.c1[0].mean(0) + [0, 0.01, 0], radius=0.07),
                           'cv-joint': dict(dir=(1, -0.1, -0.6), target=T.c1[0].mean(0) + [0, 0.01, 0], radius=0.05, clip=[dict(normal=(-1, 0, 0), constant=float(T.c1[0].mean(0)[0] + 0.012))])},
                          os.path.join(outdir, prefix))
    return files


# ------------------------------------------------------------------------------------------------ mandible seating
def seat_mandible(P, L, fmn, js_target=0.0008, pen_tol=0.0002, log=log):
    """Rigid seating of the mandible (with the lower teeth) in the mandibular fossae: the smallest rotation about the
    bicondylar axis plus sagittal translation that leaves a joint space (articular disc) of at least `js_target` between
    each condylar head and the temporal bone, without upper/lower tooth interpenetration. The Z-Anatomy source has the
    condylar heads overlapping the roofs of the fossae by ~1.5-2 mm, so seating lowers the jaw to a rest position
    (teeth slightly apart). Returns (P updated, info)."""
    mv, mf = P['mandible'][:2]
    heads = {}
    for S in 'LR':
        sel = np.isin(mf, L[f'mand_condyle_{S}']).all(1)
        heads[S] = sample_surface(mv, mf[sel], 1200, seed=1)
    cL, cR = heads['L'].mean(0), heads['R'].mean(0)
    lat = cL - cR; lat /= np.linalg.norm(lat)
    up = fmn - (fmn @ lat) * lat; up /= np.linalg.norm(up)
    fw = np.cross(lat, up)
    if fw[2] < 0: fw = -fw
    piv = (cL + cR) / 2
    sdfs = {S: G.local_sdf([P[tn][:2]], h=0.00035, pad=0.003, close=1) for S, tn in (('L', 'temporal_bone_l'), ('R', 'temporal_bone_r'))}
    lower = [n for n in P if n.startswith('lower_')]; upper = [n for n in P if n.startswith('upper_')]
    U = merge([P[n][:2] for n in upper]); Lw = merge([P[n][:2] for n in lower])
    gu, su = G.local_sdf([U], h=0.00025, pad=0.004)
    pl = sample_surface(*Lw, 6000, seed=2)
    inc = Lw[0][np.argmax(Lw[0] @ fw)]

    def move(p, th, dy, dz):
        R = rotation_axis(lat, th)
        return (p - piv) @ R.T + piv + dy * up + dz * fw

    def evaluate(th, dy, dz):
        js = min(float(g.sample(f_, move(heads[S], th, dy, dz)).min()) for S, (g, f_) in sdfs.items())
        pen = float(max(0.0, -gu.sample(su, move(pl, th, dy, dz)).min()))
        return js, pen

    js0, pen0 = evaluate(0.0, 0.0, 0.0)
    info = dict(before=dict(min_joint_space_mm=round(js0 * 1000, 2), teeth_penetration_mm=round(pen0 * 1000, 2)))
    if js0 >= js_target and pen0 <= pen_tol:
        info['result'] = 'already seated'; return P, info
    best = None; best_js = (-1.0, None)
    for th in np.radians(np.arange(-3.0, 2.01, 1.0)):
        for dy in np.arange(-0.006, 0.00051, 0.0005):
            for dz in np.arange(-0.002, 0.00201, 0.0005):
                motion = np.linalg.norm(move(np.array([cL, cR, inc]), th, dy, dz) - np.array([cL, cR, inc]), axis=1).max()
                if best is not None and motion >= best[0]: continue
                js, pen = evaluate(th, dy, dz)
                if pen <= pen_tol and js > best_js[0]: best_js = (js, (th, dy, dz))
                if js >= js_target and pen <= pen_tol:
                    best = (motion, th, dy, dz, js, pen)
    if best is None:
        info['result'] = f'no seating with >= {js_target * 1000:.1f} mm joint space within the search range; best joint space {best_js[0] * 1000:.2f} mm'
        if best_js[1] is None or best_js[0] <= js0: return P, info
        th, dy, dz = best_js[1]; js, pen = evaluate(th, dy, dz); motion = None
    else:
        motion, th, dy, dz, js, pen = best
    for n in ['mandible'] + lower:
        v, f, part = P[n]; P[n] = (move(v, th, dy, dz), f, part)
    gap_inc = float(np.linalg.norm(move(inc[None], th, dy, dz)[0] - inc))
    info.update(result='seated', rotation_deg=round(float(np.degrees(th)), 2), down_mm=round(float(-dy * 1000), 2), forward_mm=round(float(dz * 1000), 2),
                lower_incisor_moved_mm=round(gap_inc * 1000, 2),
                after=dict(min_joint_space_mm=round(js * 1000, 2), teeth_penetration_mm=round(pen * 1000, 2)))
    log('mandible seating', info)
    return P, info


def rotation_axis(axis, th):
    a = np.asarray(axis, float); a = a / np.linalg.norm(a)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * K @ K


def hyoid_check(sex, Wfull, T):
    """The female hyoid is placed by the head warp, which never sees an HRA hyoid. On the male the same warp (also
    built without the HRA hyoid) is compared with VH_M_hyoid: a leave-one-out check of the method. On the female the
    head-warp placement is compared with the trunk warp's."""
    zs = source('za-skeletal'); hv, hf = zs.get(HYOID[1])
    ph = Wfull(hv)
    if sex == 'male':
        ref = T.hyoid
        S = Surface(*ref, spacing=0.0004)
        d = S.dist(sample_surface(ph, hf, 3000, seed=8))
        d2 = Surface(ph, hf, spacing=0.0004).dist(sample_surface(*ref, 3000, seed=9))
        return dict(what='Z-Anatomy hyoid placed by the male head warp (built without the HRA hyoid) vs VH_M_hyoid',
                    mean_surface_distance_mm=round(float((d.mean() + d2.mean()) / 2 * 1000), 2), p90_mm=round(float(np.quantile(np.r_[d, d2], 0.9) * 1000), 2),
                    centroid_offset_mm=[round(float(x * 1000), 1) for x in ph.mean(0) - ref[0].mean(0)])
    tw = get_warp(sex, 'trunk')(hv)
    return dict(what='female hyoid: head-warp placement vs the trunk warp placement', centroid_offset_mm=[round(float(x * 1000), 1) for x in ph.mean(0) - tw.mean(0)],
                mean_vertex_offset_mm=round(float(np.linalg.norm(ph - tw, axis=1).mean() * 1000), 2))


def shape_metrics(Z, P, P_warp=None):
    """How far each placed bone departs from a similarity copy of its Z-Anatomy source (non-rigid shape change), and how
    much the collision refinement moved it relative to the plain head warp."""
    out = {}
    for n in Z:
        if Z[n][2] != 'skel_skull' and not n.startswith(('upper', 'lower')): continue
        zv = Z[n][0]; pv = P[n][0]
        T = umeyama(zv, pv, scale=True)
        r = np.linalg.norm(T(zv) - pv, axis=1) * 1000
        e = dict(similarity_scale=round(float(T.s), 3), nonrigid_rms_mm=round(float(np.sqrt((r ** 2).mean())), 2), nonrigid_max_mm=round(float(r.max()), 2))
        if P_warp is not None:
            dd = np.linalg.norm(pv - P_warp[n][0], axis=1) * 1000
            e['refinement_shift_mean_mm'] = round(float(dd.mean()), 2); e['refinement_shift_max_mm'] = round(float(dd.max()), 2)
        out[n] = e
    return out


def place_all(Z, Wfull):
    return {n: (Wfull(v), f, part) for n, (v, f, part, _) in Z.items()}


def outputs_for(P, Z):
    out = []
    for n in P:
        v, f, part = P[n]
        out.append(dict(name=n, part=part, mesh=(v, orient_outward(v, f)), source=[Z[n][3]]))
    return out


def run(sex, argv, L, zsk):
    from fit import skull_measure as M
    t0 = time.time()
    W, info = build_head_warp(sex, rebuild='--rebuild' in argv)
    Z = load_za(sex)
    zp, zl, hp, hl, hn = brain_hulls(sex)
    T = M.Targets(sex, hp, hl, hn)
    log(sex, 'targets ready', round(time.time() - t0))
    hist = []
    fpath = os.path.join(work_dir(sex), 'field.npz')
    if '--warp-only' in argv:
        Wfull = W
    else:
        if '--reuse' in argv and os.path.exists(fpath):
            d = np.load(fpath, allow_pickle=True)
            D = MultiField()
            for k in range(int(d['n'])):
                f_ = G.Correction(d[f'c{k}'], sigma=float(d[f's{k}'])); f_.w = d[f'w{k}']; D.fields.append(f_)
            hist = list(d['hist'])
        else:
            D, hist = refine(sex, W, Z, T, L, M, zsk)
            np.savez(fpath, n=len(D.fields), hist=np.array(hist, dtype=object), **{f'c{k}': f_.c for k, f_ in enumerate(D.fields)},
                     **{f's{k}': f_.sigma for k, f_ in enumerate(D.fields)}, **{f'w{k}': f_.w for k, f_ in enumerate(D.fields)})
        Wfull = lambda x, W=W, D=D: (lambda y: y + D(y))(W(x))
    P = place_all(Z, Wfull)
    rim = Wfull(L['fm_rim']); _, _, Vt = np.linalg.svd(rim - rim.mean(0)); fmn = Vt[2] if Vt[2][1] > 0 else -Vt[2]
    P, seat = seat_mandible(P, L, fmn)
    log(sex, 'placed', round(time.time() - t0))
    crits, det, aux = M.measure(sex, P, T, L, Wfull, zsk, log=log)
    det['hyoid_method_check'] = hyoid_check(sex, Wfull, T)
    det['bone_shape'] = shape_metrics(Z, P, place_all(Z, W))
    base_path = os.path.join(work_dir(sex), 'za_baseline.json')
    if os.path.exists(base_path):
        base = json.load(open(base_path))
    else:
        bc, bd = M.za_baseline(load_za(sex), L, zp, zl, log=log)
        base = dict(criteria=bc, details=bd); json.dump(base, open(base_path, 'w'), indent=1)
    d = os.path.join(FIT, sex, GROUP)
    for fn in os.listdir(d):
        if fn.startswith('qa-') and fn.endswith('.png'): os.remove(os.path.join(d, fn))
    qa = render_qa(sex, P, T, d)
    log(sex, 'rendered', round(time.time() - t0))
    report = dict(group=GROUP, sex=sex, status='pass' if all(c['pass'] for c in crits) else 'partial',
                  criteria=crits, details=det, mandible_seating=seat, head_warp=info, refinement=hist,
                  za_source_reference=dict(note='the same measurements on the unwarped Z-Anatomy skull with its own brain, eyes, C1, chiasm and teeth',
                                           criteria=base['criteria'], details=base['details']),
                  method=__doc__.strip(), qa_images=[os.path.basename(q) for q in qa], seconds=round(time.time() - t0, 1))
    write_group(sex, GROUP, outputs_for(P, Z), report)
    with open(os.path.join(work_dir(sex), 'criteria.txt'), 'w') as fh:
        for c in crits:
            line = f"{'PASS' if c['pass'] else 'FAIL'} {c['criterion']}: {c['value']} ({c['threshold']}) " + json.dumps({k: v for k, v in c.items() if k not in ('criterion', 'value', 'threshold', 'pass')})
            print(sex, line, flush=True); fh.write(line + '\n')
        fh.write(json.dumps(det, indent=1))
    print(json.dumps(det, indent=1))
    np.savez(os.path.join(work_dir(sex), 'placed.npz'), **{f'{n}__v': P[n][0].astype(np.float32) for n in P}, **{f'{n}__f': P[n][1].astype(np.int32) for n in P})
    log(sex, 'done', round(time.time() - t0))
    return report


def main(argv):
    from fit import skull_measure as M
    which = argv[1] if len(argv) > 1 and not argv[1].startswith('--') else 'all'
    sexes = ('male', 'female') if which == 'all' else (which,)
    L = M.za_landmarks()
    zsk = M.skin_regions_za()
    for sex in sexes:
        run(sex, argv, L, zsk)


if __name__ == '__main__':
    main(sys.argv)
