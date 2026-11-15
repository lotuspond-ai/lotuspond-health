"""Adult-calibre HRA vessels: the thread-thin HRA vessels and ducts inflated about their centrelines, once, for the
assembly (assemble.py) and for the fits that must clear them (the vessels and organs fits).

    from lib.inflate import inflated_hra
    m = inflated_hra('male')                       # {HRA structure name: (v, f)}, HRA frame: metres, HRA coordinates
    v, f = m['VH_M_descending_aorta_b']            # (before assemble.py's floor shift, like every fit output)

`inflated_hra(sex)` holds every HRA structure this step changes, in the HRA body's coordinates:
  - role 'inflated': the INFLATE vessels at their adult calibre (male descending aorta x1.5, renal arteries 2.5 mm
    radius; female common bile and hepatic ducts 2.5 mm, superior mesenteric artery 3.5 mm at its origin),
  - role 'junction': vessels and ducts whose roots move with an inflated wall: a ring of vertices shared with an
    inflated vessel, or an open border loop within NEAR_LOOP (4 mm) of one (the male coeliac trunk), blended over
    JOIN_FALLOFF (12 mm) along the neighbour,
  - role 'pushed': compliant HRA veins pushed out of the inflated arteries (veins yield to arteries: the renal veins and
    the inferior vena cava), with a bi-Laplacian falloff; their shared junction rings stay closed.
Any HRA structure not in the dict is unchanged: lib.mesh.source(f'hra-{sex}').get(name). Vertex order and faces are the
HRA mesh's, except where a stub was capped ('capped' in the manifest: faces and one centre vertex per cap appended).

The male descending aorta keeps its round section at the target calibre and its centreline moves away from the rigid
neighbours (HRA vertebral bodies, the rib cage fit's intervertebral discs) to at least RIGID_CLEAR (0.5 mm) clearance;
the female ducts stop growing where they would enter the portal vein or the hepatic arteries.

Cache: .cache/fit/<sex>/inflated/<name>.npz (v, f), manifest.json [{name, file, role, part, verts, tris, r0_mm, r1_mm,
capped}] and report.json (radii, centreline shifts, junction snaps, pushes, and every overlap before and after). The
folder is not a fit group (assemble.py does not read it as one). The cache is rebuilt when its inputs change (this
file, the HRA index, the rib cage fit's discs): `python3 lib/inflate.py [male|female|all]` rebuilds it; fits that use
it as an obstacle should call inflated_hra(sex) (which rebuilds a stale cache) rather than read the files directly.
"""
import hashlib, json, os, re, sys
import numpy as np
from scipy import sparse
from scipy.sparse.linalg import splu
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
if __name__ == '__main__': sys.path.insert(0, os.path.dirname(HERE))
from lib.mesh import source, save, load, closest_on_mesh, RayParity, cap_holes, CACHE, RAW  # noqa: E402

FIT = os.path.join(CACHE, 'fit')

# name: (('r', target radius: every 2 mm section grows to it, never shrinks) | ('k', scale factor), fade, fade length).
# fade: 'keep_top' / 'keep_bottom' leave the upper / lower end as it is (a junction with a vessel that keeps its size),
# 'only_top' inflates the upper end (an artery's origin) and fades out along the vessel. The male descending aorta is
# 12.5-13.9 mm across (adult 20-25 mm in the thorax, 18-20 mm in the abdomen): both its pieces are scaled by the same
# factor, the arch junction and the iliac bifurcation are kept as they are. keep: neighbours at whose junction the vessel
# keeps its HRA size, tapering over KEEP_TAPER (the common bile duct ends in the ring of the ventral pancreatic duct and
# the ampulla, both thin).
INFLATE = {
    'male': {'VH_M_descending_aorta_a': dict(size=('k', 1.5), fade='keep_top', length=0.025),
             'VH_M_descending_aorta_b': dict(size=('k', 1.5), fade='keep_bottom', length=0.03),
             'VH_M_left_renal_artery': dict(size=('r', 0.0025)), 'VH_M_right_renal_artery': dict(size=('r', 0.0025))},
    'female': {'VH_F_common_bile_duct': dict(size=('r', 0.0025), keep=('VH_F_ventral_pancreatic_duct', 'VH_F_hepatopancreatic_ampulla'),
                                             stop=r'blood_vasculature/.*(portal_vein|hepatic_artery)'),
               'VH_F_common_hepatic_duct': dict(size=('r', 0.0025), stop=r'blood_vasculature/.*(portal_vein|hepatic_artery)'),
               'VH_F_superior_mesenteric_artery': dict(size=('r', 0.0035), fade='only_top', length=0.045)},
}
# rigid neighbours the inflated vessels must clear by moving their centreline (HRA name regex, fit group + name regex)
RIGID = {'male': dict(vessels=('VH_M_descending_aorta_a', 'VH_M_descending_aorta_b'), hra=r'^VH_M_(thoracic|lumbar)_vertebra_\d+$',
                      fit=('ribcage', r'^disc_'))}
# compliant HRA veins pushed out of the inflated arteries (veins yield to arteries)
COMPLIANT = {'male': r'^VH_M_(renal_vein_[LR]|inferior_vena_cava_[ab])$',
             'female': r'^VH_F_(left_renal_vein|right_renal_vein|inferior_vena_cava(_[ab])?)$'}
RIGID_CLEAR = 0.0005     # m: clearance of an inflated vessel from bone and disc
VEIN_CLEAR = 0.0005      # m: clearance of a pushed vein from the artery (vertices and face centres)
STOP_CLEAR = 0.0002      # m: a duct's growth stops this far from the vessels it must not enter
JOIN_FALLOFF = 0.012     # m: length over which a junction's snap fades into each vessel
NEAR_LOOP = 0.004        # m: a neighbour's open border loop this close to an inflated wall moves with it
KEEP_TAPER = 0.005       # m: taper back to the HRA size at a 'keep' junction
ROOT_IN = 0.0003         # m: a moved branch root's ring sits this far inside the inflated wall (no see-through crescent)
PUSH_REACH = 0.025       # m: a pushed vein's falloff reaches this far from the pushed vertices
VESSEL_PATH = r'(blood_vasculature|duct|biliary|bile|ampulla)'
VERSION = 'inflate-5'


def kind(name):
    return 'vein' if re.search(r'(vein|vena_cava)', name) else 'duct' if re.search(r'(duct|ampulla|biliary)', name) else 'artery'


def _smooth01(x):
    x = np.clip(x, 0.0, 1.0); return x * x * (3 - 2 * x)


def border_loops(f):
    """Closed border loops of a mesh, as vertex index lists."""
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    _, inv, cnt = np.unique(np.sort(e, axis=1), axis=0, return_inverse=True, return_counts=True)
    nxt = {}
    for a, b in e[cnt[inv.ravel()] == 1]: nxt.setdefault(int(a), []).append(int(b))
    out = []
    for st in list(nxt):
        while nxt.get(st):
            loop, cur = [st], nxt[st].pop()
            while cur != st and nxt.get(cur): loop.append(cur); cur = nxt[cur].pop()
            if cur == st and len(loop) >= 3: out.append(loop)
    return out


def tube_frame(v, step=0.002):
    """Centreline of a tube: smoothed centroids of `step` slices across its principal axis. Returns per vertex the
    axial coordinate t, centreline point cv, unit tangent tv, radial offset d (perpendicular to the tangent), the slice
    index b, and per slice (ok bins) the median radius; or None for a mesh too short to slice."""
    c0 = v.mean(0); _, V = np.linalg.eigh(np.cov((v - c0).T)); ax = V[:, -1]
    if ax[1] < 0: ax = -ax  # t grows upwards
    t = (v - c0) @ ax
    nb = max(int(np.ceil((t.max() - t.min()) / step)), 1)
    b = np.minimum(((t - t.min()) / step).astype(int), nb - 1)
    cnt = np.bincount(b, minlength=nb); ok = np.flatnonzero(cnt >= 6)
    if len(ok) < 3: return None
    C = np.stack([np.bincount(b, weights=v[:, k], minlength=nb) for k in range(3)], 1)[ok] / cnt[ok, None]
    tb = np.bincount(b, weights=t, minlength=nb)[ok] / cnt[ok]
    C = np.stack([np.convolve(np.pad(C[:, k], 2, mode='edge'), np.ones(5) / 5, 'valid') for k in range(3)], 1)
    T = np.gradient(C, tb, axis=0); T /= np.maximum(np.linalg.norm(T, axis=1, keepdims=True), 1e-12)
    cv = np.stack([np.interp(t, tb, C[:, k]) for k in range(3)], 1)
    tv = np.stack([np.interp(t, tb, T[:, k]) for k in range(3)], 1); tv /= np.maximum(np.linalg.norm(tv, axis=1, keepdims=True), 1e-12)
    d = v - cv; d -= np.einsum('ij,ij->i', d, tv)[:, None] * tv
    rad = np.linalg.norm(d, axis=1)
    rb = np.array([np.median(rad[b == i]) for i in ok])
    return dict(t=t, cv=cv, tv=tv, d=d, rad=rad, tb=tb, rb=rb, C=C, T=T, ax=ax, c0=c0)


def inflate_tube(v, f, size, fade=None, length=0.0, keep_loops=(), step=0.002):
    """Inflate a vessel radially about its centreline: each vertex moves along its radial direction (perpendicular to
    the local tangent) by the factor (('k', k)) or so that its 2 mm section reaches the radius (('r', r): the section's
    median radius, never shrinking; the factor is smoothed along the vessel). `fade` keeps one end as it is or inflates
    one end only, with a smoothstep over `length`; keep_loops (vertex index lists) keep their HRA size, tapering over
    KEEP_TAPER. Returns (v2, median radius before, after, per-vertex growth weight 0..1, frame)."""
    fr = tube_frame(v, step)
    if fr is None: return v.copy(), None, None, np.zeros(len(v)), None
    t, d = fr['t'], fr['d']
    r0 = float(np.median(fr['rb']))
    if size[0] == 'k':
        kv = np.full(len(v), max(size[1], 1.0))
    else:
        kb = np.maximum(size[1] / np.maximum(fr['rb'], 1e-5), 1.0)
        kb = np.convolve(np.pad(kb, 2, mode='edge'), np.ones(5) / 5, 'valid')
        kv = np.interp(t, fr['tb'], kb)
    w = np.ones(len(v))
    if fade == 'keep_top': w = _smooth01((t.max() - t) / length)
    elif fade == 'keep_bottom': w = _smooth01((t - t.min()) / length)
    elif fade == 'only_top': w = 1 - _smooth01((t.max() - t) / length)
    if keep_loops and size[0] == 'r':
        # towards a kept junction the target radius eases to the junction ring's own radius: the duct keeps its calibre
        # down to the ring (no neck) and the ring itself stays where it is
        radv = np.interp(t, fr['tb'], fr['rb'])
        for L in keep_loops:
            dl, _ = cKDTree(v[L]).query(v)
            kend = np.maximum(float(np.linalg.norm(d[L], axis=1).mean()) / np.maximum(radv, 1e-5), 1.0)
            kend = np.where(dl < 1e-9, 1.0, kend)
            kv = kend + (kv - kend) * _smooth01(dl / KEEP_TAPER)
    else:
        for L in keep_loops:
            dl, _ = cKDTree(v[L]).query(v)
            w = w * _smooth01(dl / KEEP_TAPER)
    v2 = v + ((kv - 1) * w)[:, None] * d
    rad2 = np.linalg.norm(v2 - fr['cv'] - np.einsum('ij,ij->i', v2 - fr['cv'], fr['tv'])[:, None] * fr['tv'], axis=1)
    b = np.minimum(((t - t.min()) / step).astype(int), int(np.ceil((t.max() - t.min()) / step)) - 1)
    r1 = float(np.median([np.median(rad2[b == i]) for i in np.unique(b) if (b == i).sum() >= 6]))
    return v2, r0, r1, w, fr


# ------------------------------------------------------------------------------------------------ obstacles
class Obstacles:
    """Signed distance (negative inside) to a set of closed meshes (open ones capped): the union's distance is the
    minimum over its members; with the closest surface point of the member that gives it."""

    def __init__(self, meshes, names=None):
        self.m = []
        for i, (v, f) in enumerate(meshes):
            if not len(f): continue
            vc, fc = cap_holes(v, f)
            self.m.append(dict(v=vc, f=fc, rp=RayParity(vc, fc), lo=vc.min(0), hi=vc.max(0), name=(names[i] if names else str(i))))

    def sd(self, p, reach=0.01):
        p = np.asarray(p, float)
        sd = np.full(len(p), np.inf); q = p.copy(); who = np.full(len(p), -1)
        for i, o in enumerate(self.m):
            near = np.all((p > o['lo'] - reach) & (p < o['hi'] + reach), axis=1)
            if not near.any(): continue
            idx = np.flatnonzero(near)
            qq, dd = closest_on_mesh(o['v'], o['f'], p[idx], k=16)
            ins = o['rp'].inside(p[idx])
            s = np.where(ins, -dd, dd)
            better = s < sd[idx]
            sd[idx[better]] = s[better]; q[idx[better]] = qq[better]; who[idx[better]] = i
        return sd, q, who

    def push(self, p, clear, reach=0.01):
        """Per point the vector that takes it `clear` outside the union (zero where it already is)."""
        sd, q, _ = self.sd(p, reach)
        need = clear - sd
        bad = np.isfinite(sd) & (need > 0)
        out = np.zeros_like(p)
        if bad.any():
            dvec = p[bad] - q[bad]; n = np.linalg.norm(dvec, axis=1, keepdims=True)
            dirn = dvec / np.maximum(n, 1e-12)
            dirn = np.where((sd[bad] < 0)[:, None], -dirn, dirn)
            out[bad] = dirn * need[bad, None]
        return out, sd


def penetration(v, f, obst, clear=0.0):
    """Share of the vertices of (v, f) inside the obstacles (deeper than `clear`) and the deepest (mm)."""
    sd, _, _ = obst.sd(v)
    ins = sd < -clear
    return dict(share=round(float(ins.mean()), 4), deepest_mm=round(float(max(0.0, -sd[np.isfinite(sd)].min() if np.isfinite(sd).any() else 0.0)) * 1000, 2),
                min_clear_mm=round(float(sd[np.isfinite(sd)].min()) * 1000, 2) if np.isfinite(sd).any() else None)


# ------------------------------------------------------------------------------------------------ smooth fields
def _weld(meshes, tol=1e-6):
    """Weld meshes by position: returns (V, F, ids) where ids[i] maps mesh i's vertices to welded nodes."""
    allv = np.concatenate([m[0] for m in meshes])
    tr = cKDTree(allv); pr = tr.query_pairs(tol, output_type='ndarray')
    n = len(allv)
    from scipy.sparse.csgraph import connected_components
    if len(pr):
        _, lab = connected_components(sparse.coo_matrix((np.ones(len(pr)), (pr[:, 0], pr[:, 1])), shape=(n, n)), directed=False)
    else: lab = np.arange(n)
    _, node = np.unique(lab, return_inverse=True)
    V = np.zeros((node.max() + 1, 3)); V[node] = allv
    ids, F, o = [], [], 0
    for v, f in meshes:
        ids.append(node[o:o + len(v)]); F.append(node[o:o + len(v)][f]); o += len(v)
    return V, np.concatenate(F), ids


def bilaplacian_fill(V, F, fixed, val):
    """Displacement field over a mesh graph minimising the bi-Laplacian energy with the given vertices fixed; every
    connected component without a fixed vertex stays at zero."""
    n = len(V)
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]); e = np.unique(np.sort(e, axis=1), axis=0)
    e = e[e[:, 0] != e[:, 1]]
    A = sparse.coo_matrix((np.ones(2 * len(e)), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    deg = np.asarray(A.sum(1)).ravel()
    from scipy.sparse.csgraph import connected_components
    _, lab = connected_components(A, directed=False)
    has = np.zeros(lab.max() + 1, bool); has[lab[fixed]] = True
    fixed = fixed | ~has[lab]  # components with nothing fixed stay where they are
    x = np.zeros((n, 3)); x[fixed] = val[fixed] if val.shape[0] == n else 0
    free = np.flatnonzero(~fixed)
    if not len(free): return x
    Dg = sparse.diags(np.maximum(deg, 1))
    L = (Dg - A).tocsr()
    M = (L.T @ L).tocsr()
    Mff = M[free][:, free].tocsc(); Mfc = M[free][:, np.flatnonzero(fixed)]
    lu = splu(Mff + sparse.identity(len(free)) * 1e-12)
    rhs = -(Mfc @ x[fixed])
    x[free] = np.stack([lu.solve(rhs[:, k]) for k in range(3)], 1)
    return x


# ------------------------------------------------------------------------------------------------ the step
def _signature(sex):
    h = hashlib.sha1(open(os.path.abspath(__file__), 'rb').read())
    p = os.path.join(RAW, f'hra-{sex}', 'index.json'); st = os.stat(p); h.update(f'{st.st_size}:{st.st_mtime}'.encode())
    rg = RIGID.get(sex)
    if rg:
        d = os.path.join(FIT, sex, rg['fit'][0])
        for fn in sorted(os.listdir(d)) if os.path.isdir(d) else ():
            if re.search(rg['fit'][1], fn) and fn.endswith('.npz'):
                st = os.stat(os.path.join(d, fn)); h.update(f'{fn}:{st.st_size}:{st.st_mtime}'.encode())
    return h.hexdigest()


def _fit_meshes(sex, group, rx):
    d = os.path.join(FIT, sex, group); out = []
    man = os.path.join(d, 'manifest.json')
    if not os.path.exists(man): return out
    for e in json.load(open(man)):
        if re.search(rx, e['name']): out.append((e['name'], load(os.path.join(d, e['file']))))
    return out


def _rigid_shift(sex, raw, new, w, log):
    """Move the centreline of the RIGID vessels (one chain: the aorta's pieces) away from bone and disc: per 2 mm slice
    of the chain a shift perpendicular to its axis, smoothed along it, grown until every vertex clears RIGID_CLEAR;
    each vertex takes its slice's shift times its own growth weight (the kept ends stay in place)."""
    rg = RIGID.get(sex)
    if not rg: return
    names = [n for n in rg['vessels'] if n in new]
    if not names: return
    s = source(f'hra-{sex}')
    R = np.concatenate([raw[n][0] for n in names]); P0 = np.concatenate([new[n] for n in names]); W = np.concatenate([w[n] for n in names])
    lo, hi = R.min(0) - 0.03, R.max(0) + 0.03
    obs, onames = [], []
    for o in s.index:
        if re.search(rg['hra'], o['name']):
            m = s.load_entry(o)
            if np.any(np.all((m[0] > lo) & (m[0] < hi), axis=1)): obs.append(m); onames.append(o['name'])
    for n, m in _fit_meshes(sex, *rg['fit']):
        if np.any(np.all((m[0] > lo) & (m[0] < hi), axis=1)): obs.append(m); onames.append(f'{rg["fit"][0]}/{n}')
    ob = Obstacles(obs, onames)
    fr = tube_frame(R)
    t = fr['t']; step = 0.002
    nb = int(np.ceil((t.max() - t.min()) / step)) + 1
    b = np.minimum(((t - t.min()) / step).astype(int), nb - 1)
    tb = np.interp(np.arange(nb) * step + t.min() + step / 2, fr['tb'], fr['tb'])
    Tb = np.stack([np.interp(np.arange(nb) * step + t.min() + step / 2, fr['tb'], fr['T'][:, k]) for k in range(3)], 1)
    Tb /= np.maximum(np.linalg.norm(Tb, axis=1, keepdims=True), 1e-12)
    g = np.exp(-0.5 * (np.arange(-12, 13) / 4.0) ** 2); g /= g.sum()
    S = np.zeros((nb, 3))
    before = penetration(P0, None, ob, 0.0)
    for it in range(60):
        P = P0 + W[:, None] * S[b]
        push, sd = ob.push(P, RIGID_CLEAR + 1e-4)
        mag = np.linalg.norm(push, axis=1)
        if mag.max() < 2e-5: break
        D = np.zeros((nb, 3)); M = np.zeros(nb)
        for i in np.flatnonzero(mag > 0):
            if mag[i] > M[b[i]]: M[b[i]] = mag[i]; D[b[i]] = push[i] / max(W[i], 0.2)
        D -= np.einsum('ij,ij->i', D, Tb)[:, None] * Tb
        Ds = np.stack([np.convolve(np.pad(D[:, k], 12, mode='edge'), g, 'valid') for k in range(3)], 1)
        # smoothing lowers a peak: scale so that no slice gets less than it needs along its own push direction
        need = np.linalg.norm(D, axis=1); got = np.einsum('ij,ij->i', Ds, D / np.maximum(need, 1e-12)[:, None])
        sc = np.max(np.where(need > 0, need / np.maximum(got, 1e-9), 0)) if (need > 0).any() else 1.0
        S += Ds * min(max(sc, 1.0), 1.3)
    P = P0 + W[:, None] * S[b]
    after = penetration(P, None, ob, 0.0)
    sd, _, who = ob.sd(P)
    o = 0
    for n in names:
        k = len(new[n]); new[n] = P[o:o + k]; o += k
    sh = np.linalg.norm(S, axis=1)
    yb = np.array([R[b == i][:, 1].mean() if (b == i).any() else np.nan for i in range(nb)])
    log['rigid_profile'] = [dict(y=round(float(yb[i]), 4), shift_mm=round(float(sh[i]) * 1000, 2), dir=np.round(S[i] / max(sh[i], 1e-12), 2).tolist())
                            for i in range(0, nb, 5) if sh[i] > 1e-4]
    log['rigid'] = dict(vessels=names, obstacles=len(obs), clearance_mm=RIGID_CLEAR * 1000, iterations=it + 1, shift_max_mm=round(float(sh.max()) * 1000, 2),
                        shift_at_y=round(float(R[np.argmin(np.abs(b - int(np.argmax(sh))))][1]), 4), before=before, after=after,
                        closest_after={onames[i]: round(float(sd[who == i].min()) * 1000, 2) for i in np.unique(who[(who >= 0) & (sd < 0.002)])})


def _stop_growth(sex, name, raw_v, new_v, raw_f, rx, log):
    """A duct's growth stops where it would enter the vessels matching rx: per vertex the share of its growth that keeps
    STOP_CLEAR from them (none where growing would take an HRA duct already in or against them deeper; a vertex whose
    growth leads out of them grows), then smoothed by a min-preserving average so the duct dents smoothly instead of
    stepping (it grows on its free side)."""
    s = source(f'hra-{sex}')
    lo, hi = raw_v.min(0) - 0.02, raw_v.max(0) + 0.02
    obs, onames = [], []
    for o in s.index:
        if re.search(rx, o['path']):
            m = s.load_entry(o)
            if np.any(np.all((m[0] > lo) & (m[0] < hi), axis=1)): obs.append(m); onames.append(o['name'])
    if not obs: return new_v
    ob = Obstacles(obs, onames)
    sd0 = ob.sd(raw_v)[0]; sd1 = ob.sd(new_v)[0]
    target = np.minimum(sd0, STOP_CLEAR)
    a = np.ones(len(raw_v))
    bad = sd1 < target - 1e-6
    with np.errstate(invalid='ignore'): den = sd0 - sd1  # inf - inf far from every vessel: never 'bad'
    a[bad] = np.clip((sd0[bad] - target[bad]) / np.maximum(den[bad], 1e-9), 0, 1)
    a[bad & (sd0 <= STOP_CLEAR)] = 0.0
    # min-preserving smoothing: a stays at most its own value, neighbours ease into the dent
    e = np.concatenate([raw_f[:, [0, 1]], raw_f[:, [1, 2]], raw_f[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    A = sparse.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(len(raw_v),) * 2).tocsr(); deg = np.maximum(np.asarray(A.sum(1)).ravel(), 1)
    s_ = a.copy()
    for _ in range(3): s_ = np.minimum(s_, 0.5 * s_ + 0.5 * (A @ s_) / deg)
    for _ in range(6): s_ = np.minimum(a, 0.5 * s_ + 0.5 * (A @ s_) / deg)
    out = raw_v + s_[:, None] * (new_v - raw_v)
    sd2 = ob.sd(out)[0]
    log.setdefault('stopped', {})[name] = dict(at=onames, vertices_held=int((s_ < 0.99).sum()),
                                               before=dict(inside_share=round(float((sd0 < 0).mean()), 4), deepest_mm=round(float(max(0, -sd0.min())) * 1000, 2)),
                                               unstopped=dict(inside_share=round(float((sd1 < 0).mean()), 4), deepest_mm=round(float(max(0, -sd1.min())) * 1000, 2)),
                                               after=dict(inside_share=round(float((sd2 < 0).mean()), 4), deepest_mm=round(float(max(0, -sd2.min())) * 1000, 2)))
    return out


def _cap_loops(v, f, loops):
    nv, nf = [], []
    for L in loops:
        ci = len(v) + len(nv); nv.append(v[L].mean(0))
        nf += [(L[(i + 1) % len(L)], L[i], ci) for i in range(len(L))]
    if not nv: return v, f
    return np.vstack([v, np.array(nv)]), np.vstack([f, np.array(nf, np.int64)])


def compute(sex):
    """Build the inflated set; returns ({name: (v, f)}, {name: manifest extras}, report)."""
    s = source(f'hra-{sex}')
    spec = INFLATE.get(sex, {})
    idx = {o['name']: o for o in s.index}
    raw = {n: s.load_entry(idx[n]) for n in spec if n in idx}
    log = {}
    if not raw: return {}, {}, log
    # neighbours: HRA vessels and ducts near the inflated ones
    lo = np.min([m[0].min(0) for m in raw.values()], 0) - 0.03; hi = np.max([m[0].max(0) for m in raw.values()], 0) + 0.03
    cand = {}
    for o in s.index:
        if o['name'] in raw or not re.search(VESSEL_PATH, o['path']): continue
        m = s.load_entry(o)
        if np.any(np.all((m[0] > lo) & (m[0] < hi), axis=1)): cand[o['name']] = m
    # 1. inflate each vessel about its own centreline
    new, w, rr = {}, {}, {}
    for n, m in raw.items():
        sp = spec[n]
        keep = []
        for kn in sp.get('keep', ()):
            if kn not in cand: continue
            kv = cand[kn][0]; tr = cKDTree(kv)
            for L in border_loops(m[1]):
                if tr.query(m[0][L])[0].mean() < 0.0015: keep.append(L)
        v2, r0, r1, wv, _ = inflate_tube(m[0], m[1], sp['size'], sp.get('fade'), sp.get('length', 0.0), keep_loops=keep)
        if sp.get('stop'): v2 = _stop_growth(sex, n, m[0], v2, m[1], sp['stop'], log)
        new[n], w[n], rr[n] = v2, wv, (r0, r1)
        if keep: log.setdefault('kept_ends', {})[n] = len(keep)
    # 2. the aorta's centreline moves off bone and disc
    _rigid_shift(sex, raw, new, w, log)
    # 3. junctions: rings of vertices shared with an inflated vessel take one displacement (cross-section weighted)
    trees = {n: cKDTree(m[0]) for n, m in raw.items()}
    for n, m in list(cand.items()):
        if any(np.any(trees[k].query(m[0], distance_upper_bound=1e-6)[0] < 1e-6) for k in trees):
            raw[n] = m; new[n] = m[0].copy(); w[n] = np.zeros(len(m[0]))
    names = list(raw)
    disp = {n: new[n] - raw[n][0] for n in names}
    allv = np.concatenate([raw[n][0] for n in names]); own = np.concatenate([np.full(len(raw[n][0]), i) for i, n in enumerate(names)])
    D = np.concatenate([disp[n] for n in names]); wt = np.array([(rr[n][1] or 0.0) ** 2 if n in rr else 0.0 for n in names])[own]
    from scipy.sparse.csgraph import connected_components
    pr = cKDTree(allv).query_pairs(1e-6, output_type='ndarray')
    _, grp = connected_components(sparse.coo_matrix((np.ones(len(pr)), (pr[:, 0], pr[:, 1])), shape=(len(allv),) * 2), directed=False)
    nstr = np.zeros(grp.max() + 1, int); np.add.at(nstr, grp, 1)
    shared = nstr[grp] > 1
    wsum = np.zeros(grp.max() + 1); np.add.at(wsum, grp, wt)
    dsum = np.zeros((grp.max() + 1, 3)); np.add.at(dsum, grp, D * wt[:, None])
    cons = dsum / np.maximum(wsum, 1e-30)[:, None]
    mism, o0 = {}, 0
    for i, n in enumerate(names):
        k = len(raw[n][0]); sl = slice(o0, o0 + k); o0 += k
        sh = np.flatnonzero(shared[sl])
        if not len(sh): continue
        corr = cons[grp[sl][sh]] - disp[n][sh]
        mism[n] = round(float(np.linalg.norm(corr, axis=1).max()) * 1000, 2)
        d, j = cKDTree(raw[n][0][sh]).query(raw[n][0])
        new[n] = new[n] + (1 - _smooth01(d / JOIN_FALLOFF))[:, None] * corr[j]
    log['junctions_snapped_mm'] = mism
    role = {n: ('inflated' if n in rr else 'junction') for n in names}
    # 4. branch roots that stop short of an inflated wall (open loop within NEAR_LOOP): they take the nearest wall's move
    infl = [n for n in names if n in rr]
    wallv = np.concatenate([raw[n][0] for n in infl]); walld = np.concatenate([new[n] - raw[n][0] for n in infl]); wt_ = cKDTree(wallv)
    from lib.mesh import closest_on_mesh as _com
    near = {}
    for n, m in cand.items():
        if n in raw: continue
        same = [k for k in infl if kind(k) == kind(n)]  # an artery's root follows an artery, a duct a duct; veins are pushed
        if not same: continue
        moved = None
        for L in border_loops(m[1]):
            dd = min(float(_com(*raw[k], m[0][L], k=16)[1].mean()) for k in same)
            if dd > NEAR_LOOP: continue
            _, j = wt_.query(m[0][L])
            corr = walld[j]
            dl, jl = cKDTree(m[0][L]).query(m[0])
            add = (1 - _smooth01(dl / JOIN_FALLOFF))[:, None] * corr[jl]
            moved = add if moved is None else moved + add
            near.setdefault(n, []).append(dict(loop_r_mm=round(float(np.linalg.norm(m[0][L] - m[0][L].mean(0), axis=1).mean()) * 1000, 2),
                                               wall_dist_mm=round(dd * 1000, 2), moved_mm=round(float(np.linalg.norm(corr, axis=1).max()) * 1000, 2)))
        if moved is not None:
            # the root ring sits in the wall: ring vertices still outside (or within ROOT_IN of) the inflated wall are
            # pulled ROOT_IN inside it, blended along the branch over KEEP_TAPER
            vn = m[0] + moved
            wall = Obstacles([(new[k], raw[k][1]) for k in same])
            holes = [(k, H) for k in same for H in border_loops(raw[k][1][:len(raw[k][1])])]
            snap = np.zeros_like(vn); ring = []
            for L in border_loops(m[1]):
                sd, q, _ = wall.sd(vn[L])
                if not np.isfinite(sd).all() or np.median(sd) > NEAR_LOOP: continue
                # the wall's own opening for this branch (its border loop nearest the root): the root ring flares onto
                # its rim, vertex by vertex at the same angle about the opening's axis (no see-through crescent)
                cL = vn[L].mean(0); best = None
                for k, H in holes:
                    cH = new[k][H].mean(0); rH = np.linalg.norm(new[k][H] - cH, axis=1).mean()
                    dc = np.linalg.norm(cH - cL)
                    if dc < NEAR_LOOP + rH and (best is None or dc < best[0]): best = (dc, k, H)
                if best is not None:
                    _, k, H = best; PH = new[k][H]; cH = PH.mean(0)
                    _, Vh = np.linalg.eigh(np.cov((PH - cH).T)); ax = Vh[:, 0]
                    e1 = PH[0] - cH; e1 -= ax * (e1 @ ax); e1 /= np.linalg.norm(e1); e2 = np.cross(ax, e1)
                    thH = np.arctan2((PH - cH) @ e2, (PH - cH) @ e1); o = np.argsort(thH)
                    thL = np.arctan2((vn[L] - cH) @ e2, (vn[L] - cH) @ e1)
                    tgt = np.stack([np.interp(thL, thH[o], PH[o][:, c], period=2 * np.pi) for c in range(3)], 1)
                    snap[L] = tgt - vn[L]; ring += list(L)
                    near[n][-1]['flared_to_opening_r_mm'] = round(float(np.linalg.norm(PH - cH, axis=1).mean()) * 1000, 2)
                    continue
                nin = q - vn[L]; nin /= np.maximum(np.linalg.norm(nin, axis=1, keepdims=True), 1e-12)
                nin = np.where((sd < 0)[:, None], -nin, nin)
                snap[L] = np.where((sd > -ROOT_IN)[:, None], nin * (sd + ROOT_IN)[:, None], 0.0); ring += list(L)
            if ring:
                dl, jl = cKDTree(vn[ring]).query(vn)
                vn = vn + (1 - _smooth01(dl / (1.5 * KEEP_TAPER)))[:, None] * snap[np.array(ring)][jl]
                sd2 = wall.sd(vn[ring])[0]
                near[n][-1]['root_ring_outside_after_mm'] = round(float(max(0.0, sd2.max())) * 1000, 2)
            raw[n] = m; new[n] = vn; role[n] = 'junction'; names.append(n)
    log['near_loops'] = near
    # 5. open stubs of inflated vessels that are not junctions (a branch stub mid-vessel): capped
    capped = {}
    loopc = [(k, mk[0][L].mean(0)) for k, mk in list(cand.items()) + [(k, raw[k]) for k in infl] for L in border_loops(mk[1])]
    for n in infl:
        v0, f0 = raw[n]
        fr = tube_frame(v0)
        if fr is None: continue
        t = fr['t']
        caps = []
        for L in border_loops(f0):
            c = v0[L].mean(0); tc = float(np.median(t[L]))
            if tc - t.min() < 0.008 or t.max() - tc < 0.008: continue        # the vessel's own ends
            if w[n][L].mean() < 0.2: continue                                  # not enlarged
            rl = np.linalg.norm(v0[L] - c, axis=1).mean()
            jn = any(np.linalg.norm(c2 - c) < max(NEAR_LOOP, 1.5 * rl) for k, c2 in loopc if k != n)
            jn = jn or any(k != n and cKDTree(mk[0]).query(v0[L], distance_upper_bound=1e-6)[0].min() < 1e-6 for k, mk in list(cand.items()) + [(k, raw[k]) for k in infl]
                           if np.all(c > mk[0].min(0) - 0.005) and np.all(c < mk[0].max(0) + 0.005))
            if not jn: caps.append(L)
        if caps:
            capped[n] = [round(float(np.linalg.norm(v0[L] - v0[L].mean(0), axis=1).mean()) * 1000, 2) for L in caps]
            vv, ff = _cap_loops(new[n], f0, caps)
            new[n] = vv; raw[n] = (np.vstack([v0, vv[len(v0):]]), ff)
    log['capped_stubs_r_mm'] = capped
    out = {n: (new[n], raw[n][1]) for n in names}
    # 6. compliant veins pushed out of the arteries (veins yield to arteries)
    vrx = COMPLIANT.get(sex)
    pushed = {}
    if vrx:
        art = [out[n] for n in out if not re.search(r'(vein|duct|ampulla)', n)]
        if art:
            ob = Obstacles(art, [n for n in out if not re.search(r'(vein|duct|ampulla)', n)])
            vn = [o['name'] for o in s.index if re.search(vrx, o['name'])]
            vm = [out[n] if n in out else s.load_entry(idx[n]) for n in vn]
            V, F, ids = _weld(vm)
            sd0 = ob.sd(V)[0]
            before = {n: dict(inside_share=round(float((sd0[ids[i]] < 0).mean()), 4), deepest_mm=round(float(max(0, -sd0[ids[i]].min())) * 1000, 2)) for i, n in enumerate(vn)}
            X = np.zeros_like(V); fixed_val = np.zeros_like(V); fixed = np.zeros(len(V), bool); pushed_nodes = np.zeros(len(V), bool)
            for it in range(8):
                P = V + X
                pv, sd = ob.push(P, VEIN_CLEAR + 5e-5)
                pc, _ = ob.push(P[F].mean(1), VEIN_CLEAR + 5e-5)  # a face centre inside the artery pushes its corners
                for k in range(3):
                    big = np.linalg.norm(pc, axis=1) > np.linalg.norm(pv[F[:, k]], axis=1)
                    pv[F[big, k]] = pc[big]
                bad = np.linalg.norm(pv, axis=1) > 1e-6
                if not bad.any(): break
                pushed_nodes |= bad
                fixed_val[bad] = X[bad] + pv[bad]
                dist, _ = cKDTree(V[pushed_nodes]).query(V)
                fixed = pushed_nodes | (dist > PUSH_REACH)
                fv = np.where(pushed_nodes[:, None], fixed_val, 0.0)
                X = bilaplacian_fill(V, F, fixed, fv)
            sd1 = ob.sd(V + X)[0]
            for i, n in enumerate(vn):
                mv = np.linalg.norm(X[ids[i]], axis=1)
                after = dict(inside_share=round(float((sd1[ids[i]] < 0).mean()), 4), deepest_mm=round(float(max(0, -sd1[ids[i]].min())) * 1000, 2))
                if mv.max() > 1e-6:
                    out[n] = ((vm[i][0] + X[ids[i]]), vm[i][1]); role[n] = role.get(n, 'pushed')
                    pushed[n] = dict(moved_max_mm=round(float(mv.max()) * 1000, 2), moved_vertices=int((mv > 1e-5).sum()), before=before[n], after=after)
                else: pushed[n] = dict(moved_max_mm=0.0, before=before[n], after=after)
    log['pushed'] = pushed
    log['radius_mm'] = {n: dict(before=round(r0 * 1000, 2), after=round(r1 * 1000, 2)) for n, (r0, r1) in rr.items() if r0 is not None}
    extra = {n: dict(role=role.get(n, 'pushed'), r0_mm=(round(rr[n][0] * 1000, 2) if n in rr and rr[n][0] else None),
                     r1_mm=(round(rr[n][1] * 1000, 2) if n in rr and rr[n][1] else None), capped=n in capped) for n in out}
    return out, extra, log


_MEM = {}
def inflated_hra(sex, rebuild=False):
    """{HRA structure name: (v, f)} of every HRA structure the inflation changes (HRA frame); cached on disk."""
    if sex in _MEM and not rebuild: return _MEM[sex]
    d = os.path.join(FIT, sex, 'inflated'); man = os.path.join(d, 'manifest.json'); rep = os.path.join(d, 'report.json')
    sig = _signature(sex)
    if not rebuild and os.path.exists(man) and os.path.exists(rep):
        try:
            r = json.load(open(rep))
            if r.get('signature') == sig:
                _MEM[sex] = {e['name']: load(os.path.join(d, e['file'])) for e in json.load(open(man))}
                return _MEM[sex]
        except (ValueError, KeyError, OSError): pass
    out, extra, log = compute(sex)
    os.makedirs(d, exist_ok=True)
    for fn in os.listdir(d):
        if fn.endswith('.npz'): os.remove(os.path.join(d, fn))
    m = []
    for n, (v, f) in out.items():
        save(os.path.join(d, n + '.npz'), v, f)
        m.append(dict(name=n, file=n + '.npz', verts=int(len(v)), tris=int(len(f)), **extra[n]))
    json.dump(m, open(man, 'w'), indent=1)
    json.dump(dict(signature=sig, version=VERSION, **log), open(rep, 'w'), indent=1, default=float)
    _MEM[sex] = {n: load(os.path.join(d, n + '.npz')) for n in out}
    return _MEM[sex]


def inflation_report(sex):
    p = os.path.join(FIT, sex, 'inflated', 'report.json')
    return json.load(open(p)) if os.path.exists(p) else {}


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    for sx in (('male', 'female') if which == 'all' else (which,)):
        m = inflated_hra(sx, rebuild=True)
        r = inflation_report(sx)
        print(sx, len(m), 'structures:', ', '.join(f'{n}' for n in m))
        print(json.dumps({k: v for k, v in r.items() if k != 'signature'}, indent=1, default=float)[:6000])
