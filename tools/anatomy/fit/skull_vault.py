"""Minimum thickness of the cranial vault (parietal and occipital bones), and the inward-face audit of the skull.

The collision-refinement field of fit/skull.py (refine) moves the inner table out where the Allen brain needs room and
pulls the outer table in where the scalp needs cover. Where the Z-Anatomy vault is thin (0.5-2 mm, posterior parietal
and occipital squama), the Gaussian field compresses the bone locally (Jacobian determinant down to about 0.35) and the
inner table of the same bone ends up through its outer table: faces that point into their own bone, see-through dents
in the viewer. The head warp alone never does this, and neither does the source.

Method. Every vertex of the inner table (vertex normal towards the Z-Anatomy brain) and of the outer table (normal
away from it) of the parietal and occipital bones gets a bone column: a ray along its inward normal, in Z-Anatomy space,
to the face where it leaves the bone (the opposite table). The column's thickness on the placed mesh is measured from
the vertex to that same face point (same barycentric coordinates) along the column direction of the head warp alone
(tables correctly ordered there); negative = the tables cross. The target is the Z-Anatomy column thickness, at most
T_MIN (1 mm) and at least T_FLOOR. Where a column is under its target the tables are moved apart along it: the inner
table towards the brain and the outer table towards the scalp, shared in proportion to the room each side has (Allen
brain gap above BRAIN_KEEP at the column's point nearest the brain, scalp cover above SCALP_KEEP). The brain clearance
comes first: the inner table never moves beyond its room, and on the parietal bones it does not move at all (measured:
pushing it doubled the brain samples within 1 mm of the skull in the male); where the brain side lacks the room, the
outer table takes the rest (the bone may not pass through itself) into the scalp cover, but no new thin scalp: where
the cover before this fix is at least SCALP_KEEP (the vault soft-tissue criterion's 3 mm plus a 0.5 mm margin for its ray
measure) it stops there, it does not move out where the cover is 2.5 to 3.5 mm, and only where the refinement already
left the scalp under 2.5 mm may it go down to SKIN_HARD; where neither is possible the column stays thin. The per-vertex amounts are spread over each table by a
max-preserving Gaussian envelope (no dents, no steps; never below what a vertex needs, never beyond its own side's room
unless it needs it), a correction never exceeds DISP_MAX, and further passes take up what the smoothing left. The
result is a displacement field of Z-Anatomy points that follows the tables: a point takes a convex, distance-weighted
average of the corrections of the table its nearest table vertex belongs to (exact at the table vertices, never beyond
the corrections around it: an exact Gaussian-kernel solve overshot to 8-11 mm between the interleaved vertices of the
parietal and occipital bones at the lambdoid suture and pushed bone through the scalp), faded to zero 1.5-6 mm away
from the vault. fit/skull.py
adds it after the refinement field for every structure placed with the head map, and head_map() applies the same field, so the head map stays exact for the bones."""
import os
import numpy as np
from scipy import sparse
from scipy.spatial import cKDTree

from lib.mesh import orient_outward, face_normals, RayParity, _closest_point_triangle
from fit import skull_geom as G

VAULT = ['parietal_bone_l', 'parietal_bone_r', 'occipital_bone']
AUDIT = ['frontal_bone', 'parietal_bone_l', 'parietal_bone_r', 'occipital_bone', 'temporal_bone_l', 'temporal_bone_r', 'sphenoid_bone']
T_MIN = 0.0010        # minimum inner-to-outer table thickness (where the Z-Anatomy column is at least this thick)
T_FLOOR = 0.0005      # where the source itself is thinner, at least its own thickness and never under this
BRAIN_KEEP = 0.0020   # Allen brain gap the inner table keeps where it moves: the refinement's 1.6 mm target (dura +
                      # leptomeninges) plus 0.4 mm for the 1.5 mm spacing of the Allen hull samples the gap is measured on
                      # (measured: at 1.6 mm the occipital push took the female brain samples within 1 mm from 26 to 47)
SCALP_MIN = 0.0030    # the vault soft-tissue criterion's lower bound
SCALP_THIN = 0.0025   # scalp already thinner than this before the fix (SCALP_MIN less the same 0.5 mm ray margin): the
                      # refinement's hard margin SKIN_HARD applies there
SCALP_KEEP = 0.0035   # scalp cover the outer table keeps: SCALP_MIN plus 0.5 mm, because the criterion marches rays from the
                      # skin along its normal in 0.25 mm steps, which reads up to 0.5 mm under the closest-point cover used
                      # here (measured: a 3.0 mm keep read 2.75 on 10 female occipital rays and moved the p5 from 3.0 to 2.8)
SKIN_HARD = 0.0010    # ... and never gives up, even for the bone's own thickness (the refinement's hard skin margin), used
                      # only where the refinement already left the scalp under SCALP_THIN; where the cover is SCALP_THIN to
                      # SCALP_KEEP the outer table does not move out, and above it stops at SCALP_KEEP: no new thin scalp
                      # (measured: a 3 mm floor everywhere left 1.79 cm2 of the male left parietal inside out; 1.41 with this)
SIG_ENV = 0.0025      # envelope smoothing along a table
SIG_INT = 0.0007      # interpolation kernel of the correction field (mesh edges are about 1.4 mm)
FADE0, FADE1 = 0.0015, 0.0060   # the field is full up to 1.5 mm from a table and fades to zero at 6 mm
K_NB = 24
CS_TABLE = 0.25      # table vertex: vertex normal within about 75 deg of the direction to (inner) or from (outer) the brain
DISP_MAX = 0.0030     # largest correction of a table vertex
INNER_MOVES = ['occipital_bone']   # bones whose inner table may move towards the brain (within its room)
INNER_KEEP = {}       # per-bone brain gap the inner table keeps where it moves (default BRAIN_KEEP)
SRC_MIN = 0.0003      # a column is targeted where its Z-Anatomy and warp-placed thicknesses both exceed this


class VaultFix:
    """Displacement field of Z-Anatomy points (metres): the vault-table correction. lab 0 = inner, 1 = outer table.
    A point takes the weighted average of the corrections of the table its nearest table vertex belongs to, with
    weights exp(-d^2 / 2 sig^2) / (d^2 + eps^2) over its K_NB nearest vertices of that table: a convex combination, so
    the field is exact at the table vertices (eps = 1 micrometre) and never exceeds the corrections around a point
    (no overshoot between close vertices that carry different corrections, e.g. the interleaved parietal and occipital
    vertices along the lambdoid suture); scaled by a fade that is 1 up to FADE0 from that table and 0 beyond FADE1
    (smoothstep)."""
    EPS = 1e-6

    def __init__(self, xs, lab, disp, sig=SIG_INT, fade=(FADE0, FADE1), coef=None):
        self.xs = np.asarray(xs, float); self.lab = np.asarray(lab, np.int64); self.disp = np.asarray(disp, float)
        self.sig = float(sig); self.fade = (float(fade[0]), float(fade[1]))
        self.tree = cKDTree(self.xs) if len(self.xs) else None
        self.sub = {s: (np.flatnonzero(self.lab == s), cKDTree(self.xs[self.lab == s])) for s in (0, 1) if (self.lab == s).any()}
        self.coef = self.disp   # kept in the saved file for compatibility; the convex weights need no solve

    def __call__(self, x):
        x = np.asarray(x, float)
        out = np.zeros_like(x)
        if self.tree is None or not len(x) or not np.abs(self.disp).max() > 0: return out
        f0, f1 = self.fade
        d, j = self.tree.query(x, distance_upper_bound=f1)
        near = np.isfinite(d)
        if not near.any(): return out
        side = np.full(len(x), -1); side[near] = self.lab[j[near]]
        e2 = self.EPS ** 2
        for s, (idx, tr) in self.sub.items():
            m = np.flatnonzero(side == s)
            if not len(m): continue
            dd, jj = tr.query(x[m], k=min(K_NB, len(idx)), distance_upper_bound=f1 + 4 * self.sig)
            ok = np.isfinite(dd)
            dd = np.where(ok, dd, 0); d0 = dd[:, :1]
            # relative to the nearest vertex (no underflow): Gaussian ratio times the inverse-square-distance ratio
            w = np.where(ok, np.exp(-0.5 * (dd ** 2 - d0 ** 2) / self.sig ** 2) * (d0 ** 2 + e2) / (dd ** 2 + e2), 0.0)
            jj = np.where(ok, jj, 0)
            val = np.einsum('ik,ikj->ij', w, self.disp[idx][jj]) / np.maximum(w.sum(1), 1e-12)[:, None]
            u = np.clip((d0[:, 0] - f0) / (f1 - f0), 0, 1)
            out[m] = val * (1 - u * u * (3 - 2 * u))[:, None]
        return out

    def save(self, path):
        np.savez(path, xs=self.xs, lab=self.lab, disp=self.disp, coef=self.coef, sig=self.sig, fade=np.array(self.fade))

    @staticmethod
    def load(path):
        if not os.path.exists(path): return None
        d = np.load(path)
        return VaultFix(d['xs'], d['lab'], d['disp'], float(d['sig']), tuple(d['fade']), coef=d['coef'] if 'coef' in d else None)


def _bary(q, A, B, C):
    v0, v1, v2 = B - A, C - A, q - A
    d00 = (v0 * v0).sum(1); d01 = (v0 * v1).sum(1); d11 = (v1 * v1).sum(1); d20 = (v2 * v0).sum(1); d21 = (v2 * v1).sum(1)
    den = np.where(np.abs(d00 * d11 - d01 ** 2) > 1e-30, d00 * d11 - d01 ** 2, 1e-30)
    b = (d11 * d20 - d01 * d21) / den; c = (d00 * d21 - d01 * d20) / den
    w = np.clip(np.stack([1 - b - c, b, c], 1), 0, 1)
    return w / np.maximum(w.sum(1, keepdims=True), 1e-12)


def _ray_exit(orig, dirs, v, f, tmax=0.015, step=0.0015):
    """First face hit by each ray (origin just inside the bone, along the inward vertex normal): (face, barycentric
    weights, distance); face -1 where nothing is hit within tmax."""
    A = v[f[:, 0]]; B = v[f[:, 1]]; C = v[f[:, 2]]
    cen = (A + B + C) / 3
    ext = np.max(np.stack([np.linalg.norm(A - cen, axis=1), np.linalg.norm(B - cen, axis=1), np.linalg.norm(C - cen, axis=1)], 1), 1)
    rad = float(np.quantile(ext, 0.999)) + step
    tree = cKDTree(cen)
    ts = np.arange(0, tmax + step, step)
    fi = np.full(len(orig), -1); W = np.zeros((len(orig), 3)); dist = np.full(len(orig), np.inf)
    for k in range(len(orig)):
        o, d = orig[k], dirs[k]
        cand = tree.query_ball_point(o + ts[:, None] * d, rad)
        idx = np.unique(np.concatenate([np.asarray(c, np.int64) for c in cand]))
        if not len(idx): continue
        a = A[idx]; e1 = B[idx] - a; e2 = C[idx] - a
        p = np.cross(d, e2); det = np.einsum('ij,ij->i', e1, p)
        ok = np.abs(det) > 1e-14
        inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
        tv = o - a
        u = np.einsum('ij,ij->i', tv, p) * inv
        q = np.cross(tv, e1)
        w = (q @ d) * inv
        t = np.einsum('ij,ij->i', e2, q) * inv
        m = ok & (u >= -1e-9) & (w >= -1e-9) & (u + w <= 1 + 1e-9) & (t > 1e-7) & (t < tmax)
        if m.any():
            j = np.flatnonzero(m)[np.argmin(t[m])]
            fi[k] = idx[j]; W[k] = (1 - u[j] - w[j], u[j], w[j]); dist[k] = t[j]
    return fi, W, dist


class Tables:
    """Inner / outer table vertices of the vault bones in Z-Anatomy space and, for each, the point where a ray along
    its inward normal leaves the bone (the opposite table: the bone column through the vertex)."""

    def __init__(self, Z, zp, bones=VAULT, max_thick=0.015):
        tz = cKDTree(zp)
        self.bones = [b for b in bones if b in Z]
        self.rows = []   # per bone: dict
        for b in self.bones:
            v, f0 = Z[b][0], Z[b][1]
            f = orient_outward(v, f0)
            vn = G.vertex_normals(v, f)
            _, j = tz.query(v); u = zp[j] - v; u /= np.maximum(np.linalg.norm(u, axis=1, keepdims=True), 1e-12)
            cs = np.einsum('ij,ij->i', vn, u)
            row = dict(name=b, f=f)
            for lab, verts in ((0, np.flatnonzero(cs > CS_TABLE)), (1, np.flatnonzero(cs < -CS_TABLE))):
                fi, w, d = _ray_exit(v[verts] - vn[verts] * 1e-5, -vn[verts], v, f, tmax=max_thick)
                ok = fi >= 0
                row[lab] = dict(verts=verts[ok], pf=fi[ok], pw=w[ok], src_thick=d[ok])
            self.rows.append(row)
        self.xs = np.concatenate([Z[r['name']][0][r[s]['verts']] for r in self.rows for s in (0, 1)])
        self.lab = np.concatenate([np.full(len(r[s]['verts']), s) for r in self.rows for s in (0, 1)])
        self.bone = np.concatenate([np.full(len(r[s]['verts']), r['name'], dtype=object) for r in self.rows for s in (0, 1)])
        self.src_thick = np.concatenate([r[s]['src_thick'] for r in self.rows for s in (0, 1)])

    def thickness(self, Y, cols=None):
        """Signed thickness (m), partner point and the partner face's unit normal for every table vertex, on placed
        vertices Y[name] (same order as xs)."""
        Q, N, Yv = [], [], []
        for r in self.rows:
            y = Y[r['name']]; f = r['f']
            fn = face_normals(y, f)
            for s in (0, 1):
                e = r[s]
                q = np.einsum('ik,ikj->ij', e['pw'], y[f[e['pf']]])
                n = fn[e['pf']]
                yv = y[e['verts']]
                Q.append(q); N.append(n); Yv.append(yv)
        Q, N, Yv = np.concatenate(Q), np.concatenate(N), np.concatenate(Yv)
        T = np.einsum('ij,ij->i', Q - Yv, N if cols is None else cols)
        return T, Q, N, Yv


def _smoother(x, sig):
    tr = cKDTree(x)
    pairs = tr.query_pairs(3 * sig, output_type='ndarray')
    d = np.linalg.norm(x[pairs[:, 0]] - x[pairs[:, 1]], axis=1)
    w = np.exp(-0.5 * (d / sig) ** 2)
    n = len(x)
    K = sparse.coo_matrix((np.r_[w, w, np.ones(n)], (np.r_[pairs[:, 0], pairs[:, 1], np.arange(n)], np.r_[pairs[:, 1], pairs[:, 0], np.arange(n)])), shape=(n, n)).tocsr()
    return sparse.diags(1 / np.asarray(K.sum(1)).ravel()) @ K


def fit(Z, P, Pw, zp, brain_p, brain_n, skin_signed, log=print, passes=8):
    """The vault correction for placed vertices P[name][0] (head warp + refinement field). Returns (VaultFix, Tables,
    info). Target thickness per column: the Z-Anatomy thickness, at most T_MIN, at least T_FLOOR; columns that are
    not valid in the source itself (ray leaving through a face that does not face away from it) are not targeted."""
    tabs = Tables(Z, zp)
    tb = cKDTree(brain_p)

    def brain_gap(p):
        _, j = tb.query(p); return np.einsum('ij,ij->i', p - brain_p[j], brain_n[j])

    t_src = tabs.thickness({b: Z[b][0] for b in tabs.bones})[0]
    # the bone column through each table vertex, as placed by the head warp alone (tables correctly ordered there):
    # thickness is measured, and the tables pushed apart, along it
    _, qw, _, yw = tabs.thickness({b: Pw[b] for b in tabs.bones})
    cols = qw - yw; cols /= np.maximum(np.linalg.norm(cols, axis=1, keepdims=True), 1e-12)
    valid = (t_src > SRC_MIN) & (np.einsum('ij,ij->i', qw - yw, cols) > SRC_MIN)
    keep_b = np.array([INNER_KEEP.get(b, BRAIN_KEEP) for b in tabs.bone])
    target = np.clip(t_src, T_FLOOR, T_MIN)
    S = {s: _smoother(tabs.xs[tabs.lab == s], SIG_ENV) for s in (0, 1)}
    disp = np.zeros_like(tabs.xs)
    VF = VaultFix(tabs.xs, tabs.lab, disp)
    hist = []
    t0 = None
    floor = None

    def stats(t):
        u = valid & (t < target - 1e-5)
        return dict(min=round(float(t[valid].min() * 1000), 2), p1=round(float(np.quantile(t[valid], 0.01) * 1000), 2),
                    n_under_target=int(u.sum()), n_crossed=int((valid & (t < 0)).sum()), n_columns=int(valid.sum()))
    for it in range(passes + 1):
        Y = {b: P[b][0] + VF(Z[b][0]) for b in tabs.bones}
        t, q, n, yv = tabs.thickness(Y, cols)
        if t0 is None: t0 = t.copy()
        gap_v, gap_q = brain_gap(yv), brain_gap(q)
        cov_v, cov_q = -skin_signed(yv), -skin_signed(q)
        inner = tabs.lab == 0
        cov_c = np.where(inner, cov_q, cov_v)   # the column's scalp cover, at its outer-table end
        if floor is None:   # no new thin scalp: SCALP_KEEP where the cover is at least that before this fix
            floor = np.where(cov_c >= SCALP_KEEP, SCALP_KEEP, np.where(cov_c >= SCALP_THIN, cov_c, SKIN_HARD))
        # the column's brain room is measured from its point nearest the brain: where the tables cross that is the
        # crossed outer table, not the inner-table vertex behind it
        room_b = np.maximum(np.minimum(gap_v, gap_q) - keep_b, 0)
        room_s = np.maximum(np.where(inner, cov_q, cov_v) - SCALP_KEEP, 0)
        need = np.where(valid, np.maximum(target - t, 0), 0)
        st = dict(pass_=it, **stats(t), need_max_mm=round(float(need.max() * 1000), 2),
                  no_room_both_sides=int(((room_b + room_s) < need - 1e-5).sum()), unfixable=int((need > room_b + np.maximum(cov_c - floor, 0) + 1e-5).sum()), max_disp_mm=round(float(np.linalg.norm(disp, axis=1).max() * 1000), 2))
        hist.append(st); log('vault thickness', st)
        if it == passes or need.max() < 2e-5: break
        tot = room_b + room_s
        own = np.where(inner, room_b, room_s); other = np.where(inner, room_s, room_b)
        frac = np.where(tot > 1e-6, own / np.maximum(tot, 1e-12), np.where(inner, 0.0, 1.0))
        a_req = need * frac * 1.15   # the envelope's last smoothing and the interpolation lose a little at isolated peaks
        # priorities: the brain clearance first (the inner table never goes beyond its room), then the bone (it may
        # not pass through itself: where the brain side lacks the room the outer table takes the rest, into the scalp
        # cover down to SKIN_HARD), then the scalp cover
        skin_room = np.maximum(cov_c - floor, 0)
        a_req = np.where(inner, np.minimum(a_req, room_b),
                         np.minimum(np.maximum(a_req, need - np.minimum(other, need)), np.maximum(skin_room, 0)))
        # bones whose inner table stays where the brain-clearance refinement put it (measured: on the parietals the
        # inner-table push doubled the brain samples within 1 mm of the skull): their outer table takes the whole need
        fixed_in = ~np.isin(tabs.bone, INNER_MOVES)
        a_req = np.where(inner & fixed_in, 0.0, np.where(~inner & fixed_in, np.minimum(need * 1.15, skin_room), a_req))
        dirs = -cols    # away from the opposite table: the inner table towards the brain, the outer towards the scalp
        new = np.zeros_like(disp)
        for s in (0, 1):
            m = tabs.lab == s
            a_s, Ks = a_req[m], S[s]
            env = a_s.copy()
            for _ in range(12): env = np.maximum(a_s, Ks @ env)
            env = Ks @ env
            env = np.minimum(env, np.maximum(a_s, own[m]))   # spread only within the side's own room
            wsum = Ks @ (dirs[m] * (a_s + 1e-9)[:, None])
            nrm = np.linalg.norm(wsum, axis=1, keepdims=True)
            dn = np.where(nrm > 1e-12, wsum / np.maximum(nrm, 1e-12), dirs[m])
            new[m] = env[:, None] * dn
        disp = disp + new
        nd = np.linalg.norm(disp, axis=1, keepdims=True)
        disp *= np.minimum(1.0, DISP_MAX / np.maximum(nd, 1e-12))   # a column the push does not open is not pushed further
        VF = VaultFix(tabs.xs, tabs.lab, disp)
    info = dict(bones=tabs.bones, inner_table_moves_on=INNER_MOVES, t_min_mm=T_MIN * 1000, t_floor_mm=T_FLOOR * 1000, brain_keep_mm=BRAIN_KEEP * 1000, scalp_keep_mm=SCALP_KEEP * 1000,
                n_table_vertices=int(len(tabs.xs)), n_columns_scalp_floor_hard=int((floor < SCALP_THIN).sum()), scalp_thin_mm=SCALP_THIN * 1000, passes=hist, thickness_before_mm=stats(t0), thickness_after_mm=stats(t),
                source_thickness_mm=dict(p1=round(float(np.quantile(t_src[valid], 0.01) * 1000), 2), median=round(float(np.median(t_src[valid]) * 1000), 2)),
                max_displacement_mm=round(float(np.linalg.norm(disp, axis=1).max() * 1000), 2),
                n_vertices_moved_over_0p1mm=int((np.linalg.norm(disp, axis=1) > 1e-4).sum()))
    tabs.cols, tabs.valid, tabs.target = cols, valid, target
    return VF, tabs, info


def inward_faces(v, f, eps=3e-4):
    """Faces whose front side lies inside their own mesh (a sheet through another sheet of the same bone): the
    review's measure (ray-parity inside test 0.3 mm in front of and behind each face centroid). (cm2, %, mask)"""
    f = orient_outward(v, f)
    fn = face_normals(v, f); c = v[f].mean(1)
    ar = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
    rp = RayParity(v, f)
    bad = rp.inside(c + eps * fn) & ~rp.inside(c - eps * fn)
    return float(ar[bad].sum() * 1e4), float(100 * ar[bad].sum() / ar.sum()), bad


def criteria(P, P_field, tabs, info, max_inward_cm2=0.25, max_thin_pct=1.0):
    """Report criteria: (1) faces pointing into their own bone, per cranial bone, on the meshes as written (exact
    winding) against the refinement-field placement as written before this fix (volume-rule winding: what the review
    measured); (2) vault columns thinner than their target (min(1 mm, Z-Anatomy), at least 0.5 mm)."""
    from lib.mesh import orient_exact
    from fit.skull_measure import crit
    per = {}
    for b in AUDIT:
        if b not in P: continue
        v, f = P[b][0], P[b][1]
        a1, p1, _ = inward_faces_wound(v, orient_exact(v, f))
        a0, p0, _ = inward_faces_wound(P_field[b][0], orient_outward(P_field[b][0], P_field[b][1]))
        per[b] = dict(after_cm2=round(a1, 2), after_pct=round(p1, 3), before_cm2=round(a0, 2), before_pct=round(p0, 3))
    worst = max(per, key=lambda b: per[b]['after_cm2'])
    out = [crit('cranial bones: faces pointing into their own bone (inner table through the outer table, or wound inside out; largest bone)', per[worst]['after_cm2'],
                f'<= {max_inward_cm2} cm2 per bone', per[worst]['after_cm2'] <= max_inward_cm2, unit='cm2', bone=worst,
                before_cm2={b: per[b]['before_cm2'] for b in per}, after_cm2={b: per[b]['after_cm2'] for b in per})]
    Y = {b: P[b][0] for b in tabs.bones}
    t = tabs.thickness(Y, tabs.cols)[0]
    ok = tabs.valid
    thin = ok & (t < tabs.target - 1e-4)
    pct = round(float(thin.sum() / ok.sum() * 100), 2)
    out.append(crit('vault bone columns (parietal, occipital) thinner than min(1 mm, Z-Anatomy thickness), inner to outer table', pct,
                    f'<= {max_thin_pct} % of columns', pct <= max_thin_pct, unit='%', n_columns=int(ok.sum()), n_thin=int(thin.sum()),
                    n_crossed=int((ok & (t < 0)).sum()), min_mm=round(float(t[ok].min() * 1000), 2), p1_mm=round(float(np.quantile(t[ok], 0.01) * 1000), 2),
                    before=info['thickness_before_mm']))
    return out, dict(method=__doc__.strip(), inward_faces_per_bone=per, fix=info)


def inward_faces_wound(v, f, eps=3e-4):
    """inward_faces() for a mesh whose winding is already final (no re-orientation), counting only the faces of a
    face's own connected component (a bone's separate pieces may overlap: the temporal bone's inner-ear shells)."""
    from lib.mesh import components
    fn = face_normals(v, f); c = v[f].mean(1)
    ar = 0.5 * np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1)
    lab = np.zeros(len(f), np.int64)
    for i, cf in enumerate(components(v, f)): lab[cf] = i
    rp = RayParity(v, f, lab)
    bad = rp.inside(c + eps * fn, lab) & ~rp.inside(c - eps * fn, lab)
    return float(ar[bad].sum() * 1e4), float(100 * ar[bad].sum() / ar.sum()), bad
