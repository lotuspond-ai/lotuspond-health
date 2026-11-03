"""Small rigid corrections of several bones at once, solved by Levenberg-Marquardt with analytic Jacobians.

Each body b gets a correction x -> R_b (x - c_b) + c_b + t_b about its pivot c_b (a joint centre). Distances in the
residuals are expressed in millimetres (MM below), so a weight of 1 means "1 mm of violation costs 1". Terms are written
on sample points of the bodies (in their current placement) and return residuals with Jacobians w.r.t. every body's
incremental (rotation vector, translation). Used for the shoulder girdle (clavicle and acromion under the skin, joint
contacts kept, scapula on the chest wall) and for the final collision / clearance / joint-gap pass.
"""
import numpy as np

from fit.arms_geom import rot_axis, TriMesh

MM = 1000.0  # residual units per metre


def skew(v):
    return np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])


def rotvec(R):
    ang = np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))
    if ang < 1e-9: return np.zeros(3)
    w = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / (2 * np.sin(ang))
    return w * ang


def expmap(w):
    a = np.linalg.norm(w)
    return np.eye(3) if a < 1e-12 else rot_axis(w / a, a)


class Bodies:
    def __init__(self, pivots):
        self.names = list(pivots)
        self.idx = {n: i for i, n in enumerate(self.names)}
        self.c = {n: np.asarray(pivots[n], float) for n in self.names}
        self.R = {n: np.eye(3) for n in self.names}
        self.t = {n: np.zeros(3) for n in self.names}

    @property
    def n(self): return 6 * len(self.names)

    def apply(self, name, P):
        c = self.c[name]
        return (np.asarray(P) - c) @ self.R[name].T + c + self.t[name]

    def pivot(self, name):
        return self.c[name] + self.t[name]

    def dP(self, name, P):
        """Jacobian of points P (current positions) w.r.t. the body's increment: (m, 3, 6)."""
        r = np.asarray(P) - self.pivot(name)
        J = np.zeros((len(r), 3, 6))
        # d(p)/d(dw) = -[r]x
        J[:, 0, 1] = r[:, 2]; J[:, 0, 2] = -r[:, 1]
        J[:, 1, 0] = -r[:, 2]; J[:, 1, 2] = r[:, 0]
        J[:, 2, 0] = r[:, 1]; J[:, 2, 1] = -r[:, 0]
        J[:, 0, 3] = 1; J[:, 1, 4] = 1; J[:, 2, 5] = 1
        return J

    def step(self, delta):
        for n in self.names:
            i = 6 * self.idx[n]
            dw, dt = delta[i:i + 3], delta[i + 3:i + 6]
            self.R[n] = expmap(dw) @ self.R[n]; self.t[n] = self.t[n] + dt

    def state(self):
        return {n: (self.R[n].copy(), self.t[n].copy()) for n in self.names}

    def restore(self, st):
        for n, (R, t) in st.items(): self.R[n] = R.copy(); self.t[n] = t.copy()


def softmin(c, tau):
    m = c.min()
    e = np.exp(-(c - m) / tau)
    s = e.sum()
    return m - tau * np.log(s), e / s


def solve(B, terms, iters=30, lam=1e-3, verbose=False):
    """Levenberg-Marquardt over the bodies' increments. Each term(B) -> (r (m,), J (m, B.n))."""
    def evaluate():
        rs, Js = [], []
        for t in terms:
            r, J = t(B)
            if len(r): rs.append(r); Js.append(J)
        if not rs: return np.zeros(0), np.zeros((0, B.n))
        return np.concatenate(rs), np.concatenate(Js)
    r, J = evaluate(); cost = r @ r
    for it in range(iters):
        H = J.T @ J; g = J.T @ r
        D = np.diag(np.diag(H)) + 1e-9 * np.eye(B.n)
        improved = False
        for _ in range(8):
            try: delta = -np.linalg.solve(H + lam * D, g)
            except np.linalg.LinAlgError: delta = -np.linalg.lstsq(H + lam * D, g, rcond=None)[0]
            st = B.state(); B.step(delta)
            r2, J2 = evaluate(); c2 = r2 @ r2
            if c2 < cost:
                r, J, cost = r2, J2, c2; lam = max(lam / 3, 1e-7); improved = True; break
            B.restore(st); lam *= 4
        if verbose: print(f'    LM it {it} cost {cost:.6g} lam {lam:.2g}')
        if not improved or np.linalg.norm(delta) < 1e-7: break
    return cost


# ------------------------------------------------------------------------------------------------ terms
def term_surface_band(body, P0, surf, lo=None, hi=None, w=1.0, inside=True, mode='each', tau=0.0005):
    w = w * MM
    """Keep the clearance of points of `body` w.r.t. a fixed closed surface within [lo, hi].
    inside=True: clearance = -signed distance (points meant to be inside, e.g. bone under skin);
    inside=False: clearance = +signed distance (points meant to stay outside, e.g. scapula over the ribs).
    mode 'each': one hinge residual per point; 'min': one residual on the soft-min clearance of the set."""
    P0 = np.asarray(P0, float)

    def f(B):
        P = B.apply(body, P0)
        d, q, fi, nrm = surf.closest(P)
        s = np.sign(np.einsum('ij,ij->i', P - q, nrm)); s[s == 0] = 1
        sd = d * s
        # gradient of the signed distance: unit vector from the closest point (or the face normal on the surface)
        g = (P - q) / np.maximum(d, 1e-9)[:, None] * s[:, None]
        tiny = d < 1e-7
        if tiny.any(): g[tiny] = surf.fn[fi[tiny]]
        cl = -sd if inside else sd
        gcl = -g if inside else g
        Jp = B.dP(body, P)  # (m, 3, 6)
        Jc = np.einsum('mi,mij->mj', gcl, Jp)  # d clearance / d increment
        i0 = 6 * B.idx[body]
        if mode == 'each':
            r = np.zeros(len(P)); J = np.zeros((len(P), B.n))
            if lo is not None:
                m = cl < lo; r[m] += w * (lo - cl[m]); J[m, i0:i0 + 6] += -w * Jc[m]
            if hi is not None:
                m = cl > hi; r[m] += w * (cl[m] - hi); J[m, i0:i0 + 6] += w * Jc[m]
            keep = r != 0
            return r[keep], J[keep]
        mval, wts = softmin(cl, tau)
        gm = wts @ Jc
        r = []; J = []
        if lo is not None and mval < lo: r.append(w * (lo - mval)); row = np.zeros(B.n); row[i0:i0 + 6] = -w * gm; J.append(row)
        if hi is not None and mval > hi: r.append(w * (mval - hi)); row = np.zeros(B.n); row[i0:i0 + 6] = w * gm; J.append(row)
        return np.array(r), np.array(J).reshape(-1, B.n)
    return f


def term_body_gap(bA, PA0, bB, VB0, FB, lo=None, hi=None, w=1.0, mode='each', tau=0.0003):
    w = w * MM
    """Gap between body A's points and body B's (moving) closed mesh within [lo, hi]
    (positive = apart; negative = A's points inside B)."""
    PA0 = np.asarray(PA0, float); VB0 = np.asarray(VB0, float)
    cache = {}

    def f(B):
        PA = B.apply(bA, PA0)
        key = (B.R[bB].tobytes(), B.t[bB].tobytes())
        if cache.get('key') != key:
            cache['key'] = key; cache['T'] = TriMesh(B.apply(bB, VB0), FB, k=12)
        T = cache['T']
        d, q, fi, nrm = T.closest(PA)
        s = np.sign(np.einsum('ij,ij->i', PA - q, nrm)); s[s == 0] = 1
        sd = d * s
        g = (PA - q) / np.maximum(d, 1e-9)[:, None] * s[:, None]
        tiny = d < 1e-7
        if tiny.any(): g[tiny] = T.fn[fi[tiny]]
        JA = np.einsum('mi,mij->mj', g, B.dP(bA, PA))
        JB = -np.einsum('mi,mij->mj', g, B.dP(bB, q))
        iA, iB = 6 * B.idx[bA], 6 * B.idx[bB]
        if mode == 'each':
            r = np.zeros(len(PA)); J = np.zeros((len(PA), B.n))
            if lo is not None:
                m = sd < lo; r[m] += w * (lo - sd[m]); J[m, iA:iA + 6] -= w * JA[m]; J[m, iB:iB + 6] -= w * JB[m]
            if hi is not None:
                m = sd > hi; r[m] += w * (sd[m] - hi); J[m, iA:iA + 6] += w * JA[m]; J[m, iB:iB + 6] += w * JB[m]
            keep = r != 0
            return r[keep], J[keep]
        mval, wts = softmin(sd, tau)
        gA = wts @ JA; gB = wts @ JB
        r = []; J = []
        if lo is not None and mval < lo:
            r.append(w * (lo - mval)); row = np.zeros(B.n); row[iA:iA + 6] = -w * gA; row[iB:iB + 6] = -w * gB; J.append(row)
        if hi is not None and mval > hi:
            r.append(w * (mval - hi)); row = np.zeros(B.n); row[iA:iA + 6] = w * gA; row[iB:iB + 6] = w * gB; J.append(row)
        return np.array(r), np.array(J).reshape(-1, B.n)
    return f


def term_point_target(body, p0, target, w=1.0, tol=0.0):
    w = w * MM
    """Point of a body near a fixed target point (hinge beyond `tol`)."""
    p0 = np.asarray(p0, float)[None]; target = np.asarray(target, float)

    def f(B):
        p = B.apply(body, p0)[0]
        d = p - target; n = np.linalg.norm(d)
        if n <= tol: return np.zeros(0), np.zeros((0, B.n))
        u = d / n
        J = np.zeros((1, B.n)); i0 = 6 * B.idx[body]
        J[0, i0:i0 + 6] = w * (u @ B.dP(body, p[None])[0])
        return np.array([w * (n - tol)]), J
    return f


def term_points_pair(bA, pA0, bB, pB0, w=1.0, tol=0.0):
    w = w * MM
    """Point of body A near point of body B (both moving)."""
    pA0 = np.asarray(pA0, float)[None]; pB0 = np.asarray(pB0, float)[None]

    def f(B):
        a = B.apply(bA, pA0)[0]; b = B.apply(bB, pB0)[0]
        d = a - b; n = np.linalg.norm(d)
        if n <= tol: return np.zeros(0), np.zeros((0, B.n))
        u = d / n
        J = np.zeros((1, B.n))
        iA, iB = 6 * B.idx[bA], 6 * B.idx[bB]
        J[0, iA:iA + 6] += w * (u @ B.dP(bA, a[None])[0]); J[0, iB:iB + 6] -= w * (u @ B.dP(bB, b[None])[0])
        return np.array([w * (n - tol)]), J
    return f


def term_direction(body, d0, target, w=1.0):
    """Direction d0 carried by the body (rotation only) aligned with a fixed target direction."""
    d0 = np.asarray(d0, float); target = np.asarray(target, float) / np.linalg.norm(target)

    def f(B):
        d = B.R[body] @ d0
        r = w * (d - target)
        J = np.zeros((3, B.n)); i0 = 6 * B.idx[body]
        J[:, i0:i0 + 3] = -w * skew(d)
        return r, J
    return f


def term_regular(body, sig_rot, sig_t):
    def f(B):
        i0 = 6 * B.idx[body]
        r = np.r_[rotvec(B.R[body]) / sig_rot, B.t[body] / sig_t]
        J = np.zeros((6, B.n))
        J[:3, i0:i0 + 3] = np.eye(3) / sig_rot; J[3:, i0 + 3:i0 + 6] = np.eye(3) / sig_t
        return r, J
    return f
