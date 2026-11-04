"""Second review pass for the vessels group (fit/vessels.py): the HRA inferior vena cava as an obstacle for the veins,
companion separation (veins out of their arteries, arteries out of the HRA veins, sibling branches out of each other
beyond about one radius of their common origin), the left subclavian vein swept as a round tube through the
costoclavicular space, and the venous junctions turned back onto their stubs after the push-out. numpy + scipy only.

 - HRA inferior vena cava (hra_ivc_tube): both pieces (hepatic _a, infrahepatic _b) are double-walled and open, so ray
   parity cannot tell the lumen from the outside: their centrelines are marched by plane sections from the open ring
   where they meet (vessels_geom.march: the largest polygon near the running axis, i.e. the outer wall), radius
   sqrt(area / pi), and joined into one capped vessels_review.TubeObstacle. Its push direction is biased toward the
   vertebral body at the same level (like the descending aorta's), so the azygos vein, which the trunk warp lays into
   the vena cava from T9 to L1, is moved behind it onto the right side of the vertebral bodies (between the bodies, the
   right crus and the vena cava) instead of being pushed out sideways into the liver.
 - Companion separation (separate): a vessel's tube (centreline + radius per section, vessels_review.trunk) is an
   obstacle for the vessels that must yield to it: Z-Anatomy veins yield to Z-Anatomy arteries (the internal thoracic,
   femoral, popliteal and carotid companions), Z-Anatomy arteries yield to the HRA veins (marched tubes, as for the vena
   cava), and of two sibling arteries that leave the same parent (external / internal carotid, external / internal
   iliac, the two common iliacs, the deep femoral from the femoral) the smaller yields beyond one radius of the larger's
   wall from their common origin (the crotch keeps an overlap of about one radius). Displacements are whole cross-
   sections (vessels_review.clear_obstacle style: per centreline bin, the deepest vertex's missing clearance along the
   obstacle's outward direction, Gaussian-spread along the vessel), faded to zero at the junction rings, then the
   general push-out (fit/vessels_fix.Fixer) runs again with these tubes as extra obstacles so nothing is pushed back into
   bone, organ or skin.
"""
import os, sys, json
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import source  # noqa: E402
from fit import vessels_geom as G  # noqa: E402
from fit import vessels_review as RV  # noqa: E402

IVC_CLEAR = 0.0012        # veins kept this far outside the HRA inferior vena cava's outer wall (m; the review asks >= 1 mm)


def r2(x, k=2):
    return round(float(x), k)


def vertebral_bias(sex, which=('thoracic', 'lumbar')):
    """(y (k,), centre (k, 3)) of the anterior half of each vertebral body, sorted by height."""
    S = source(f'hra-{sex}'); X = 'VH_M_' if sex == 'male' else 'VH_F_'
    by, bc = [], []
    for kind, n in (('thoracic', 12), ('lumbar', 5)):
        if kind not in which: continue
        for k in range(1, n + 1):
            nm = f'{X}{kind}_vertebra_{k}'
            if nm not in S.by_name: continue
            vv = S.get(nm)[0]
            # the body: the anterior part of the vertebra (the arch and processes lie behind it)
            z0 = np.quantile(vv[:, 2], 0.55); body = vv[vv[:, 2] > z0]
            by.append(body[:, 1].mean()); bc.append(body.mean(0))
    o = np.argsort(by)
    return np.array(by)[o], np.array(bc)[o]


def marched_tube(v, f, start, direction, length=0.30, r0=0.008):
    """(P, R) of an HRA vessel piece marched from `start` along `direction` (outer wall), R median-filtered."""
    m = G.march(v, f, start, direction, step=0.002, length=length, r0=r0)
    ok = m['a'] > 0
    P, A = m['p'][ok], m['a'][ok]
    if len(P) < 3: return None, None
    R = np.sqrt(A / np.pi)
    Rm = np.array([np.median(R[max(0, i - 3):i + 4]) for i in range(len(R))])
    return P, np.clip(R, 0.8 * Rm, 1.15 * Rm)


def hra_ivc_tube(sex):
    """The HRA inferior vena cava (_b infrahepatic from the iliac confluence, _a hepatic up to its end) as one capped
    TubeObstacle, push biased toward the vertebral bodies at the same level. Returns (obstacle, info)."""
    S = source(f'hra-{sex}'); X = 'VH_M_' if sex == 'male' else 'VH_F_'
    parts = [n for n in ('inferior_vena_cava_b', 'inferior_vena_cava_a') if X + n in S.by_name]
    if not parts: return None, dict(error='no HRA inferior vena cava')
    pieces = {n: S.get(X + n) for n in parts}
    # the ring where the two pieces meet: the open ring of _b nearest to _a (or _b's highest ring)
    vb, fb = pieces[parts[0]]
    ends = G.merge_loops([e for e in G.stub_ends(vb, fb, min_r=0.004) if e['kind'] == 'open'])
    top = max(ends, key=lambda e: e['c'][1])
    Pb, Rb = marched_tube(vb, fb, top['c'], np.array([0, -1.0, 0]) if top['n'][1] > 0 else -top['n'], r0=top['r'])
    pts, rad = [], []
    if Pb is not None: pts.append(Pb[::-1]); rad.append(Rb[::-1])
    if len(parts) > 1:
        va, fa = pieces[parts[1]]
        ea = G.merge_loops([e for e in G.stub_ends(va, fa, min_r=0.004) if e['kind'] == 'open'])
        if ea:
            e = min(ea, key=lambda e: np.linalg.norm(e['c'] - top['c']))
            Pa, Ra = marched_tube(va, fa, e['c'], -e['n'], length=0.10, r0=e['r'])
            if Pa is not None: pts.append(Pa[1:]); rad.append(Ra[1:])
    P = np.concatenate(pts); R = np.concatenate(rad)
    bias = vertebral_bias(sex)
    ob = RV.TubeObstacle(f'hra_ivc_{sex}', P, R, bias=bias, bias_mask=np.ones(len(P), bool))
    return ob, dict(points=len(P), radius_mm=[r2(R.min() * 1000, 1), r2(np.median(R) * 1000, 1), r2(R.max() * 1000, 1)],
                    y_range=[r2(P[:, 1].min(), 3), r2(P[:, 1].max(), 3)], pieces=[X + n for n in parts])


# ------------------------------------------------------------------------------------------------ tubes
class MultiTube:
    """Signed distance to the union of several capped tubes (one KD-tree over all their resampled centreline points):
    min over the K nearest centreline points of (distance - radius there). Same query interface as TubeObstacle."""
    K = 6

    def __init__(self, tubes, step=0.0005):
        P, R, T = [], [], []
        self.names = []
        for k, (name, p, r) in enumerate(tubes):
            if p is None or len(p) < 2: continue
            q, s = RV.polyline_resample(np.asarray(p, float), step)
            s0 = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))])
            P.append(q); R.append(np.interp(s, s0, r)); T.append(np.full(len(q), len(self.names))); self.names.append(name)
        self.P = np.concatenate(P) if P else np.zeros((0, 3)); self.R = np.concatenate(R) if R else np.zeros(0)
        self.T = np.concatenate(T) if T else np.zeros(0, int)
        self.tree = cKDTree(self.P) if len(self.P) else None
        self.lo = (self.P.min(0) - self.R.max() - 0.01) if len(self.P) else np.full(3, np.inf)
        self.hi = (self.P.max(0) + self.R.max() + 0.01) if len(self.P) else np.full(3, -np.inf)

    def query(self, p, band=None):
        p = np.atleast_2d(np.asarray(p, float))
        if self.tree is None: return np.full(len(p), np.inf), np.zeros_like(p), np.zeros(len(p), int)
        k = min(self.K, len(self.P))
        d, i = self.tree.query(p, k=k)
        if k == 1: d, i = d[:, None], i[:, None]
        sd = d - self.R[i]
        j = np.argmin(sd, axis=1); r = np.arange(len(p))
        ii = i[r, j]
        return sd[r, j], G.unit(p - self.P[ii]), self.T[ii]


def vessel_tube(x, step=0.004):
    """(P, R, cl) of a placed vessel: its main-trunk centreline (vessels_review.trunk) and the radius along it (median
    vertex distance per bin, Gaussian-smoothed)."""
    cl = RV.trunk(x['v'], x['f'])
    if cl is None: return None, None, None
    s, q, idx, Q, sQ = RV.param(x, cl)
    d = np.linalg.norm(x['v'] - q, axis=1)
    b = np.floor(s / step).astype(int); nb = b.max() + 1
    rb = np.full(nb, np.nan)
    for k in range(nb):
        m = b == k
        if m.sum() >= 3: rb[k] = np.median(d[m])
    ok = np.isfinite(rb)
    if ok.sum() < 2: return None, None, None
    sk = (np.arange(nb) + 0.5) * step
    rb = np.interp(sk, sk[ok], rb[ok])
    K = np.exp(-0.5 * ((sk[:, None] - sk[None]) / 0.006) ** 2); rb = (K @ rb) / K.sum(1)
    return cl['p'], np.interp(cl['s'], sk, rb), cl


def hra_vein_tubes(sex, near_pts, pad=0.02, names=None):
    """Marched outer-wall tubes of the HRA veins near the given points: every open ring of each HRA vein mesh (merged
    double-wall loops) marched inward (vessels_geom.march), [(name, P, R)]."""
    S = source(f'hra-{sex}')
    if names is None:
        import json as _json
        from fit.common import FIT
        parts = _json.load(open(os.path.join(FIT, '..', 'parts', sex, 'structures.json')))
        names = [o['name'] for o in parts.get('veins', []) if o.get('source', 'HRA') == 'HRA' and 'pulmonary' not in o['name']]
    tree = cKDTree(near_pts)
    out = []
    for n in names:
        if n not in S.by_name: continue
        v, f = S.get(n)
        lo, hi = v.min(0) - pad, v.max(0) + pad
        c = (lo + hi) / 2
        idx = tree.query_ball_point(c, float(np.linalg.norm(hi - lo) / 2))
        if not idx or not np.any(np.all((near_pts[idx] >= lo) & (near_pts[idx] <= hi), axis=1)): continue
        ends = G.merge_loops([e for e in G.stub_ends(v, f, min_r=0.0015) if e['kind'] == 'open'])
        for e in ends:
            P, R = marched_tube(v, f, e['c'], -e['n'], length=0.25, r0=e['r'])
            if P is not None and len(P) >= 4: out.append((n, P, R))
    return out


def section_push(x, need_fn, pins, step=0.004, sigma=0.008, iters=6, extra_w=None):
    """Whole-section displacement of one vessel (vessels_review.clear_obstacle style) from a per-bin ask function:
    need_fn(centres (nb, 3), radii (nb,), s (nb,)) -> asks (nb, 3) (zero where satisfied). The asks are Gaussian-spread
    along the vessel (weights x ask, scaled by the nearest ask's kernel value), multiplied by the junction pin weights
    (and extra_w(s) if given), and applied to every vertex by its centreline parameter. Returns the largest shift (m)."""
    moved = 0.0
    for it in range(iters):
        P, R, cl = vessel_tube(x, step)
        if P is None: break
        s, q, _, _, _ = RV.param(x, cl)
        nb = int(np.floor(s.max() / step)) + 1
        sk = (np.arange(nb) + 0.5) * step
        C = np.stack([np.interp(sk, cl['s'], cl['p'][:, a]) for a in range(3)], 1)
        Rk = np.interp(sk, cl['s'], R)
        vec = need_fn(C, Rk, sk)
        mag = np.linalg.norm(vec, axis=1)
        if mag.max() < 1e-4: break
        K = np.exp(-0.5 * ((sk[:, None] - sk[None]) / sigma) ** 2)
        W = K * mag[None]; den = W.sum(1); kmax = (K * (mag[None] > 1e-6)).max(1)
        fld = np.where((den > 0)[:, None], kmax[:, None] * (W @ vec) / np.maximum(den, 1e-12)[:, None], 0.0)
        if extra_w is not None: fld = fld * extra_w(sk)[:, None]
        dv = np.stack([np.interp(s, sk, fld[:, a]) for a in range(3)], 1) * pins.get(x['_name'], np.ones(len(x['v'])))[:, None]
        x['v'] = x['v'] + dv; moved = max(moved, float(np.linalg.norm(dv, axis=1).max()))
    return moved


# ------------------------------------------------------------------------------------------------ azygos route
AZ_STEP = 0.003
AZ_GRID = np.arange(-0.030, 0.03001, 0.0015)   # horizontal search window around a section centre (m)
BONE_CLEAR, ORGAN_CLEAR, AORTA_CLEAR = 0.0008, 0.0003, 0.0005


def route_azygos(sex, VES, ivc, aorta, bones, organs, pins, contacts=(), log=print, names=('Azygos_vein',)):
    """Sections of the azygos (and hemi-azygos) veins that lie inside the HRA inferior vena cava (with IVC_CLEAR) are
    moved, in their horizontal plane, to the nearest position where the whole section is clear of the vena cava, the
    HRA aorta, every bone (0.8 mm) and the solid organs (0.3 mm), preferring positions behind the vena cava's centre
    (anterior to it lies the liver; the azygos runs on the right side of the vertebral bodies, behind the right crus):
    a 1.5 mm grid search over +-3 cm, chosen from the top down with a continuity cost (the shift of the section above).
    The chosen shifts are spread along the vein like the other whole-section moves (Gaussian 8 mm, so the stretch
    above and below follows smoothly), faded at the junction rings; a vein that a moved one drains (Z-Anatomy end-ring
    contact) follows at its contact ring, decaying over 3 cm."""
    out = {}
    if ivc is None: return out
    g = AZ_GRID; DX, DZ = np.meshgrid(g, g)
    OFF = np.stack([DX.ravel(), np.zeros(DX.size), DZ.ravel()], 1)
    for n in names:
        x = VES.get(n)
        if x is None or not x['placed'] or x.get('dropped'): continue
        x['_name'] = n
        P, R, cl = vessel_tube(x, step=AZ_STEP)
        if P is None: continue
        s, q, _, _, _ = RV.param(x, cl)
        nb = int(np.floor(s.max() / AZ_STEP)) + 1
        sk = (np.arange(nb) + 0.5) * AZ_STEP
        C = np.stack([np.interp(sk, cl['s'], cl['p'][:, a]) for a in range(3)], 1)
        Rk = np.interp(sk, cl['s'], R)
        sdc, _, _ = ivc.query(C)
        need = Rk + IVC_CLEAR - sdc
        bad = np.flatnonzero(need > 1e-4)
        d0 = float(max(0.0, -(np.min(ivc.query(x['v'])[0]))))
        if not len(bad):
            out[n] = dict(depth_before_mm=r2(d0 * 1000, 1), moved_mm=0.0); continue
        # IVC centre z at each section's height (prefer behind it)
        iz = np.interp(C[bad, 1], ivc.P[np.argsort(ivc.P[:, 1]), 1], ivc.P[np.argsort(ivc.P[:, 1]), 2])
        cand = (C[bad][:, None, :] + OFF[None]).reshape(-1, 3)
        r_ = np.repeat(Rk[bad], len(OFF))
        ok = ivc.query(cand)[0] >= r_ + IVC_CLEAR
        ok &= aorta.query(cand)[0] >= r_ + AORTA_CLEAR
        sb = np.full(len(cand), np.inf); m = ok.copy()
        sb[m] = bones.query(cand[m])[0]; ok &= sb >= r_ + BONE_CLEAR + 0.0002
        if organs is not None:
            so = np.full(len(cand), np.inf); m = ok.copy()
            so[m] = organs.query(cand[m])[0]; ok &= so >= r_ + ORGAN_CLEAR + 0.0002
        ok = ok.reshape(len(bad), len(OFF))
        vec = np.zeros((nb, 3)); prev = None; unresolved = 0
        for kk in np.argsort(-C[bad, 1]):           # from the top down
            k = bad[kk]
            if not ok[kk].any(): unresolved += 1; continue
            front = np.maximum(0.0, (C[k, 2] + OFF[:, 2]) - iz[kk])
            cost = np.linalg.norm(OFF, axis=1) + 2.0 * front + (0.7 * np.linalg.norm(OFF - prev, axis=1) if prev is not None else 0.0)
            cost[~ok[kk]] = np.inf
            b = int(np.argmin(cost)); vec[k] = OFF[b]; prev = OFF[b]
        mag = np.linalg.norm(vec, axis=1)
        K = np.exp(-0.5 * ((sk[:, None] - sk[None]) / 0.008) ** 2)
        W = K * mag[None]; den = W.sum(1); kmax = (K * (mag[None] > 1e-6)).max(1)
        fld = np.where((den > 0)[:, None], kmax[:, None] * (W @ vec) / np.maximum(den, 1e-12)[:, None], 0.0)
        v0 = x['v'].copy()
        dv = np.stack([np.interp(s, sk, fld[:, a]) for a in range(3)], 1) * pins.get(n, np.ones(len(x['v'])))[:, None]
        x['v'] = x['v'] + dv
        # partners draining into it at an end-ring contact follow at the contact, decaying along them over 3 cm
        follow = {}
        tv = cKDTree(v0)
        for a, ia, b_, ib in contacts:
            # (child, child's ring (original indices), partner, ...): a vein whose end ring lies on this one
            if b_ != n or a not in VES or a in names or not VES[a]['placed'] or VES[a].get('dropped'): continue
            other = a; y = VES[other]
            ring = np.asarray(ia)
            if y.get('orig_index') is not None:
                inv = -np.ones(int(max(y['orig_index'].max(), ring.max())) + 1, int); ok_ = y['orig_index'] >= 0
                inv[y['orig_index'][ok_]] = np.flatnonzero(ok_); ring = inv[ring]; ring = ring[ring >= 0]
            if not len(ring): continue
            if True:
                dd, ii = tv.query(y['v'][ring])
                if dd.min() > 0.004: continue
                sh = dv[ii].mean(0)
                if np.linalg.norm(sh) < 2e-4: continue
                gdist = G.geodesic(G.graph(y['v'], y['f']), ring.tolist(), limit=0.04)
                w = RV.raised(np.where(np.isfinite(gdist), gdist, 1.0) / 0.030) * pins.get(other, np.ones(len(y['v'])))
                y['v'] = y['v'] + w[:, None] * sh
                follow[other] = r2(np.linalg.norm(sh) * 1000, 1)
        d1 = float(max(0.0, -(np.min(ivc.query(x['v'])[0]))))
        out[n] = dict(depth_before_mm=r2(d0 * 1000, 1), depth_after_mm=r2(d1 * 1000, 1), sections_moved=int(len(bad)), unresolved_sections=unresolved,
                      max_shift_mm=r2(np.linalg.norm(dv, axis=1).max() * 1000, 1), y_range=[r2(C[bad, 1].min(), 3), r2(C[bad, 1].max(), 3)], partners_followed_mm=follow)
        log(f'  azygos route {n}: {out[n]}')
    return out


# ------------------------------------------------------------------------------------------------ companion separation
SEP_CLEAR = 0.0005        # wall-to-wall clearance kept between a vessel and the one it yields to (m)
SIB_NEAR = 0.006          # two arteries whose end rings lie this close (beyond their radii) leave a common origin


def _tube_need(obst, clear):
    def need(C, Rk, sk):
        sd, dn, _ = obst.query(C)
        m = Rk + clear - sd
        return np.where((m > 1e-4)[:, None], dn * m[:, None], 0.0)
    return need


def separate(sex, VES, pins, log=print, clear=SEP_CLEAR, hra_tubes=None):
    """Companion separation by whole cross-sections (section_push, tube against tube: a section of radius r centred at
    c yields until r + clear <= its centre's distance to the other vessel's wall), in this order:
     1. sibling arteries that leave a common origin (end rings within SIB_NEAR of each other: external / internal carotid,
        external / internal iliac, a branch from its parent's side): the smaller yields to the larger beyond one radius
        of the larger from its origin ring (weight 0 up to that, raised-cosine ramp over one more radius); equal ones
        (radii within 15 %) both yield, half each;
     2. Z-Anatomy arteries yield to the HRA veins (marched outer-wall tubes, hra_vein_tubes);
     3. Z-Anatomy veins yield to the Z-Anatomy arteries (their tubes after 1-2).
    Returns (info, artery MultiTube, HRA vein MultiTube) for the push-out's extra obstacles."""
    names = [n for n, x in VES.items() if x['placed'] and not x.get('dropped')]
    for n in names: VES[n]['_name'] = n
    arts = [n for n in names if VES[n]['part'] == 'arteries']
    veins = [n for n in names if VES[n]['part'] == 'veins']
    info = dict(siblings={}, arteries_from_hra_veins={}, veins_from_arteries={})
    tubes = {}
    for n in arts:
        P, R, cl = vessel_tube(VES[n]); tubes[n] = (P, R, cl)
    # ---- 1. siblings
    SIB_SKIP = ('cerebral', 'communicating', 'Pericallosal', 'Insular', 'cerebellar', 'Basilar', 'palmar')
    sib = [n for n in arts if tubes[n][0] is not None and not any(k in n for k in SIB_SKIP) and np.median(tubes[n][1]) >= 0.0012]
    rings = {n: RV.end_loops(VES[n]['v'], VES[n]['f']) for n in sib}
    tob = {n: RV.TubeObstacle(n, tubes[n][0], tubes[n][1]) for n in sib}
    box = {n: (VES[n]['v'].min(0) - 0.005, VES[n]['v'].max(0) + 0.005) for n in sib}
    pairs = []
    for i, a in enumerate(sib):
        for b in sib[i + 1:]:
            if np.any(np.minimum(box[a][1], box[b][1]) < np.maximum(box[a][0], box[b][0])): continue
            best = None
            for la in rings[a]:
                for lb in rings[b]:
                    d = np.linalg.norm(la['c'] - lb['c']) - la['r'] - lb['r']
                    if d < SIB_NEAR and (best is None or d < best[0]): best = (d, la, lb)
            if best is None:
                # a branch whose origin ring lies on the other's side (the deep femoral on the femoral)
                for me, other in ((a, b), (b, a)):
                    for l in rings[me]:
                        sd, _, _ = tob[other].query(l['c'][None])
                        if sd[0] < 0.5 * l['r'] and (best is None or sd[0] < best[0]):
                            best = (float(sd[0]), l if me == a else None, l if me == b else None)
            if best is not None: pairs.append((a, b, best[1], best[2]))
    for a, b, la, lb in pairs:
        ra = float(np.median(tubes[a][1])); rb = float(np.median(tubes[b][1]))
        if abs(ra - rb) <= 0.15 * max(ra, rb): yielders = [(a, b, la, 0.5), (b, a, lb, 0.5)]
        elif ra < rb: yielders = [(a, b, la, 1.0)]
        else: yielders = [(b, a, lb, 1.0)]
        for me, other, ring, k in yielders:
            if ring is None: continue
            x = VES[me]; Po, Ro, _ = tubes[other]
            ob = RV.TubeObstacle(other, Po, Ro) if Po is not None else None
            if ob is None: continue
            sd0 = ob.query(x['v'])[0]; d0 = float(max(0.0, -sd0.min()))
            r_big = float(np.median(Ro))
            # weight along the yielding vessel from its origin ring: 0 within one radius of the larger, ramp over one more
            _, _, cl = vessel_tube(x)
            if cl is None: continue
            s_ring = float(RV.project(cl, ring['c'][None])[0][0])
            w = lambda sk, s_ring=s_ring, r_big=r_big: 1.0 - RV.raised((np.abs(sk - s_ring) - r_big) / r_big)
            need = _tube_need(ob, clear)
            mv = section_push(x, lambda C, Rk, sk: k * need(C, Rk, sk), pins, extra_w=w)
            sd1 = ob.query(x['v'])[0]
            info['siblings'][f'{me} from {other}'] = dict(depth_before_mm=r2(d0 * 1000, 1), depth_after_mm=r2(max(0.0, -sd1.min()) * 1000, 1),
                                                        max_shift_mm=r2(mv * 1000, 1), share=k)
        if a in tubes: tubes[a] = vessel_tube(VES[a])
        if b in tubes: tubes[b] = vessel_tube(VES[b])
    # ---- 2. arteries out of the HRA veins
    if hra_tubes is None:
        pts = np.concatenate([VES[n]['v'] for n in arts]) if arts else np.zeros((0, 3))
        hra_tubes = hra_vein_tubes(sex, pts)
    HV = MultiTube(hra_tubes)
    for n in arts:
        x = VES[n]
        if not np.any(np.all((x['v'] >= HV.lo) & (x['v'] <= HV.hi), axis=1)): continue
        sd0 = HV.query(x['v'])[0]
        if (clear - sd0).max() <= 1e-4: continue
        mv = section_push(x, _tube_need(HV, clear), pins)
        sd1 = HV.query(x['v'])[0]
        info['arteries_from_hra_veins'][n] = dict(depth_before_mm=r2(max(0.0, -sd0.min()) * 1000, 1), depth_after_mm=r2(max(0.0, -sd1.min()) * 1000, 1),
                                                  max_shift_mm=r2(mv * 1000, 1))
        tubes[n] = vessel_tube(x)
    # ---- 3. veins out of the arteries
    AT = MultiTube([(n, P, R) for n, (P, R, cl) in tubes.items() if P is not None])
    for n in veins:
        x = VES[n]
        P, R, cl = vessel_tube(x)
        if P is None: continue
        # tube against tube: also an artery lying inside a larger vein (no vein vertex inside the artery)
        C = P; sd = AT.query(C)[0]
        if (R + clear - sd).max() <= 1e-4: continue
        d0 = float(max(0.0, (R + clear - sd).max() - clear))
        mv = section_push(x, _tube_need(AT, clear), pins)
        P1, R1, _ = vessel_tube(x)
        d1 = float(max(0.0, (R1 + clear - AT.query(P1)[0]).max() - clear)) if P1 is not None else None
        info['veins_from_arteries'][n] = dict(overlap_before_mm=r2(d0 * 1000, 1), overlap_after_mm=r2(d1 * 1000, 1) if d1 is not None else None,
                                              max_shift_mm=r2(mv * 1000, 1))
    for k in info:
        if info[k]: log(f'  separation {k}: ' + ', '.join(f'{a} {b.get("depth_before_mm", b.get("overlap_before_mm"))}->{b.get("depth_after_mm", b.get("overlap_after_mm"))} mm' for a, b in info[k].items()))
    AT = MultiTube([(n, *vessel_tube(VES[n])[:2]) for n in arts])
    return info, AT, HV
