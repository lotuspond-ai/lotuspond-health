import numpy as np

BIG = 10.0

def _v(a): return np.asarray(a, dtype=np.float64)

def smin(a, b, k):
    if k <= 0: return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)

def smax(a, b, k):
    return -smin(-a, -b, k)

def rot_axes(fwd, up_hint=(0, 1, 0)):
    """Rows (u, v, w) with v = fwd."""
    v = _v(fwd); v = v / np.linalg.norm(v)
    u = np.cross(_v(up_hint), v)
    if np.linalg.norm(u) < 1e-6: u = np.cross((1, 0, 0), v)
    u = u / np.linalg.norm(u)
    w = np.cross(u, v)
    return np.stack([u, v, w])

class Prim:
    def local(self, x, y, z):
        px, py, pz = x - self.c[0], y - self.c[1], z - self.c[2]
        if getattr(self, 'R', None) is None: return px, py, pz
        R = self.R
        return (R[0, 0] * px + R[0, 1] * py + R[0, 2] * pz,
                R[1, 0] * px + R[1, 1] * py + R[1, 2] * pz,
                R[2, 0] * px + R[2, 1] * py + R[2, 2] * pz)

class Sphere(Prim):
    def __init__(self, c, r): self.c = _v(c); self.r = r; self.R = None
    def bbox(self): return self.c - self.r, self.c + self.r
    def __call__(self, x, y, z):
        return np.sqrt((x - self.c[0]) ** 2 + (y - self.c[1]) ** 2 + (z - self.c[2]) ** 2) - self.r

class Ellipsoid(Prim):
    def __init__(self, c, r, R=None):
        self.c = _v(c); self.r = _v(r); self.R = None if R is None else _v(R)
    def bbox(self):
        m = self.r.max(); return self.c - m, self.c + m
    def __call__(self, x, y, z):
        px, py, pz = self.local(x, y, z)
        rx, ry, rz = self.r
        k0 = np.sqrt((px / rx) ** 2 + (py / ry) ** 2 + (pz / rz) ** 2)
        k1 = np.sqrt((px / rx ** 2) ** 2 + (py / ry ** 2) ** 2 + (pz / rz ** 2) ** 2)
        k1 = np.maximum(k1, 1e-9)
        return k0 * (k0 - 1.0) / k1

class RoundCone(Prim):
    def __init__(self, a, b, ra, rb, scale=None):
        self.a = _v(a); self.b = _v(b); self.ra = ra; self.rb = rb; self.scale = None if scale is None else _v(scale)
        self.c = (self.a + self.b) / 2
    def bbox(self):
        r = max(self.ra, self.rb)
        if self.scale is not None: r = r / self.scale.min()
        return np.minimum(self.a, self.b) - r, np.maximum(self.a, self.b) + r
    def __call__(self, x, y, z):
        a, b, r1, r2 = self.a, self.b, self.ra, self.rb
        if self.scale is not None:
            s = self.scale
            x = (x - self.c[0]) * s[0] + self.c[0]; y = (y - self.c[1]) * s[1] + self.c[1]; z = (z - self.c[2]) * s[2] + self.c[2]
        ba = b - a; l2 = ba @ ba; rr = r1 - r2; a2 = l2 - rr * rr; il2 = 1.0 / l2
        pax, pay, paz = x - a[0], y - a[1], z - a[2]
        yv = pax * ba[0] + pay * ba[1] + paz * ba[2]
        zv = yv - l2
        qx = pax * l2 - ba[0] * yv; qy = pay * l2 - ba[1] * yv; qz = paz * l2 - ba[2] * yv
        x2 = qx * qx + qy * qy + qz * qz; y2 = yv * yv * l2; z2 = zv * zv * l2
        k = np.sign(rr) * rr * rr * x2
        c1 = np.sign(zv) * a2 * z2 > k
        c2 = np.sign(yv) * a2 * y2 < k
        d1 = np.sqrt(x2 + z2) * il2 - r2
        d2 = np.sqrt(x2 + y2) * il2 - r1
        d3 = (np.sqrt(np.maximum(x2 * a2 * il2, 0)) + yv * rr) * il2 - r1
        d = np.where(c1, d1, np.where(c2, d2, d3))
        if self.scale is not None: d = d / self.scale.max()
        return d

def Capsule(a, b, r, scale=None): return RoundCone(a, b, r, r, scale)

class Triangle(Prim):
    def __init__(self, a, b, c, r):
        self.A = _v(a); self.B = _v(b); self.C = _v(c); self.r = r; self.c = (self.A + self.B + self.C) / 3
    def bbox(self):
        P = np.stack([self.A, self.B, self.C]); return P.min(0) - self.r, P.max(0) + self.r
    def __call__(self, x, y, z):
        a, b, c = self.A, self.B, self.C
        ba = b - a; cb = c - b; ac = a - c
        nor = np.cross(ba, ac)
        def dot3(u, px, py, pz): return u[0] * px + u[1] * py + u[2] * pz
        pa = (x - a[0], y - a[1], z - a[2]); pb = (x - b[0], y - b[1], z - b[2]); pc = (x - c[0], y - c[1], z - c[2])
        s = (np.sign(dot3(np.cross(ba, nor), *pa)) + np.sign(dot3(np.cross(cb, nor), *pb)) + np.sign(dot3(np.cross(ac, nor), *pc)))
        def segd2(e, p):
            t = np.clip(dot3(e, *p) / (e @ e), 0, 1)
            dx = e[0] * t - p[0]; dy = e[1] * t - p[1]; dz = e[2] * t - p[2]
            return dx * dx + dy * dy + dz * dz
        d_edge = np.minimum(np.minimum(segd2(ba, pa), segd2(cb, pb)), segd2(ac, pc))
        d_face = dot3(nor, *pa) ** 2 / (nor @ nor)
        return np.sqrt(np.where(s < 2, d_edge, d_face)) - self.r

class HalfSpace(Prim):
    """positive on the side the normal points to."""
    def __init__(self, p0, n):
        self.c = _v(p0); n = _v(n); self.n = n / np.linalg.norm(n)
    def bbox(self): return np.full(3, -BIG), np.full(3, BIG)
    def __call__(self, x, y, z):
        return (x - self.c[0]) * self.n[0] + (y - self.c[1]) * self.n[1] + (z - self.c[2]) * self.n[2]

class Fn(Prim):
    def __init__(self, f, lo, hi): self.f = f; self.lo = _v(lo); self.hi = _v(hi); self.c = (self.lo + self.hi) / 2
    def bbox(self): return self.lo, self.hi
    def __call__(self, x, y, z): return self.f(x, y, z)

class Displaced(Prim):
    def __init__(self, prim, fn, amp): self.p = prim; self.fn = fn; self.amp = amp; self.c = prim.c
    def bbox(self):
        lo, hi = self.p.bbox(); return lo - self.amp, hi + self.amp
    def __call__(self, x, y, z): return self.p(x, y, z) + self.fn(x, y, z)

class Scene:
    c = np.zeros(3)
    def __init__(self): self.ops = []
    def u(self, p, k=0.0): self.ops.append(('u', p, k)); return self
    def s(self, p, k=0.0): self.ops.append(('s', p, k)); return self
    def i(self, p, k=0.0): self.ops.append(('i', p, k)); return self
    def bbox(self):
        lo = np.full(3, BIG); hi = np.full(3, -BIG)
        for op, p, k in self.ops:
            if op == 'u':
                a, b = p.bbox(); lo = np.minimum(lo, a - k); hi = np.maximum(hi, b + k)
        return lo, hi
    def __call__(self, x, y, z):
        f = np.full(np.broadcast(x, y, z).shape, BIG)
        for op, p, k in self.ops:
            d = p(x, y, z)
            if op == 'u': f = smin(f, d, k)
            elif op == 's': f = smax(f, -d, k)
            else: f = smax(f, d, k)
        return f

def eval_grid(scene, lo, hi, h):
    lo = _v(lo); hi = _v(hi)
    n = np.ceil((hi - lo) / h).astype(int) + 1
    xs = [lo[i] + h * np.arange(n[i]) for i in range(3)]
    f = np.full(tuple(n), BIG, dtype=np.float64)
    for op, p, k in scene.ops:
        if op == 'i':
            d = p(xs[0][:, None, None], xs[1][None, :, None], xs[2][None, None, :])
            f = smax(f, d, k); continue
        plo, phi = p.bbox()
        pad = k + 2 * h
        sl = []; ok = True
        for a in range(3):
            i0 = max(int(np.floor((plo[a] - pad - lo[a]) / h)), 0)
            i1 = min(int(np.ceil((phi[a] + pad - lo[a]) / h)) + 1, n[a])
            if i1 <= i0: ok = False
            sl.append(slice(i0, i1))
        if not ok: continue
        X = xs[0][sl[0]][:, None, None]; Y = xs[1][sl[1]][None, :, None]; Z = xs[2][sl[2]][None, None, :]
        d = p(X, Y, Z)
        sub = f[sl[0], sl[1], sl[2]]
        f[sl[0], sl[1], sl[2]] = smin(sub, d, k) if op == 'u' else smax(sub, -d, k)
    return f, lo, h

CORNERS = np.array([[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]])
EDGES = [(0,1),(2,3),(4,5),(6,7),(0,2),(1,3),(4,6),(5,7),(0,4),(1,5),(2,6),(3,7)]

def surface_nets(f, lo, h):
    nx, ny, nz = f.shape
    cv = [f[i:nx-1+i, j:ny-1+j, k:nz-1+k] for i, j, k in CORNERS]
    anyin = np.zeros(cv[0].shape, bool); allin = np.ones(cv[0].shape, bool)
    for c in cv: s = c < 0; anyin |= s; allin &= s
    active = anyin & ~allin
    idx = np.argwhere(active); M = len(idx)
    vals = np.stack([c[active] for c in cv], 1)
    acc = np.zeros((M, 3)); cnt = np.zeros(M)
    for a, b in EDGES:
        fa = vals[:, a]; fb = vals[:, b]
        m = (fa < 0) != (fb < 0)
        t = fa[m] / (fa[m] - fb[m])
        acc[m] += CORNERS[a] + t[:, None] * (CORNERS[b] - CORNERS[a]); cnt[m] += 1
    vpos = (idx + acc / cnt[:, None]) * h + lo
    vid = -np.ones(active.shape, np.int64); vid[active] = np.arange(M)
    inside = f < 0
    quads = []
    ch = inside[:-1, 1:-1, 1:-1] != inside[1:, 1:-1, 1:-1]; e0 = inside[:-1, 1:-1, 1:-1]
    quads.append((vid[:, :-1, :-1][ch], vid[:, 1:, :-1][ch], vid[:, 1:, 1:][ch], vid[:, :-1, 1:][ch], e0[ch]))
    ch = inside[1:-1, :-1, 1:-1] != inside[1:-1, 1:, 1:-1]; e0 = inside[1:-1, :-1, 1:-1]
    quads.append((vid[:-1, :, :-1][ch], vid[:-1, :, 1:][ch], vid[1:, :, 1:][ch], vid[1:, :, :-1][ch], e0[ch]))
    ch = inside[1:-1, 1:-1, :-1] != inside[1:-1, 1:-1, 1:]; e0 = inside[1:-1, 1:-1, :-1]
    quads.append((vid[:-1, :-1, :][ch], vid[1:, :-1, :][ch], vid[1:, 1:, :][ch], vid[:-1, 1:, :][ch], e0[ch]))
    tris = []
    for A, B, C, D, e0 in quads:
        a = A; b = np.where(e0, B, D); c = C; d = np.where(e0, D, B)
        use_ac = np.sum((vpos[a] - vpos[c]) ** 2, 1) <= np.sum((vpos[b] - vpos[d]) ** 2, 1)
        tris.append(np.where(use_ac[:, None], np.stack([a, b, c], 1), np.stack([a, b, d], 1)))
        tris.append(np.where(use_ac[:, None], np.stack([a, c, d], 1), np.stack([b, c, d], 1)))
    return vpos, np.concatenate(tris, 0)

def grad(fn, p, e=2e-4):
    gx = fn(p[:, 0] + e, p[:, 1], p[:, 2]) - fn(p[:, 0] - e, p[:, 1], p[:, 2])
    gy = fn(p[:, 0], p[:, 1] + e, p[:, 2]) - fn(p[:, 0], p[:, 1] - e, p[:, 2])
    gz = fn(p[:, 0], p[:, 1], p[:, 2] + e) - fn(p[:, 0], p[:, 1], p[:, 2] - e)
    return np.stack([gx, gy, gz], 1) / (2 * e)

def project(fn, p, iters=2, maxstep=None):
    for _ in range(iters):
        d = fn(p[:, 0], p[:, 1], p[:, 2]); g = grad(fn, p)
        step = (d / np.maximum(np.sum(g * g, 1), 1e-8))[:, None] * g
        if maxstep is not None:
            n = np.linalg.norm(step, axis=1, keepdims=True)
            step = step * np.minimum(1, maxstep / np.maximum(n, 1e-12))
        p = p - step
    return p

def laplacian(v, t, iters=2, lam=0.5, mu=-0.53):
    n = len(v)
    e = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    deg = np.maximum(np.bincount(e[:, 0], minlength=n).astype(float), 1)
    for _ in range(iters):
        for f in (lam, mu):
            s = np.zeros_like(v); np.add.at(s, e[:, 0], v[e[:, 1]])
            v = v + f * (s / deg[:, None] - v)
    return v

def mesh_scene(scene, h, lo=None, hi=None, proj=True, smooth=1, pad=None):
    blo, bhi = scene.bbox()
    pad = 3 * h if pad is None else pad
    lo = blo - pad if lo is None else _v(lo)
    hi = bhi + pad if hi is None else _v(hi)
    f, lo, h = eval_grid(scene, lo, hi, h)
    v, t = surface_nets(f, lo, h)
    if smooth: v = laplacian(v, t, iters=smooth)
    if proj: v = project(scene, v, iters=2, maxstep=h)
    return v, t

# ---------- tube sweeps ----------
def catmull(points, n_per=12, alpha=0.5):
    P = _v(points)
    if len(P) == 2:
        t = np.linspace(0, 1, n_per + 1)[:, None]; return P[0] * (1 - t) + P[1] * t
    P = np.concatenate([2 * P[:1] - P[1:2], P, 2 * P[-1:] - P[-2:-1]])
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        def tj(ti, a, b): return ti + max(np.linalg.norm(b - a), 1e-6) ** alpha
        t0 = 0; t1 = tj(t0, p0, p1); t2 = tj(t1, p1, p2); t3 = tj(t2, p2, p3)
        ts = np.linspace(t1, t2, n_per, endpoint=False)[:, None]
        A1 = (t1 - ts) / (t1 - t0) * p0 + (ts - t0) / (t1 - t0) * p1
        A2 = (t2 - ts) / (t2 - t1) * p1 + (ts - t1) / (t2 - t1) * p2
        A3 = (t3 - ts) / (t3 - t2) * p2 + (ts - t2) / (t3 - t2) * p3
        B1 = (t2 - ts) / (t2 - t0) * A1 + (ts - t0) / (t2 - t0) * A2
        B2 = (t3 - ts) / (t3 - t1) * A2 + (ts - t1) / (t3 - t1) * A3
        out.append((t2 - ts) / (t2 - t1) * B1 + (ts - t1) / (t2 - t1) * B2)
    out.append(P[-2][None])
    return np.concatenate(out)

def resample(curve, step):
    seg = np.linalg.norm(np.diff(curve, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)]); L = s[-1]; n = max(int(np.ceil(L / step)), 2)
    ss = np.linspace(0, L, n + 1)
    return np.stack([np.interp(ss, s, curve[:, i]) for i in range(3)], 1), ss / L

def tube(points, radii, step=0.004, sides=10, caps=True, flat=None, ref=(0, 1, 0), rfun=None):
    P = _v(points)
    c = catmull(P, 16); c, u = resample(c, step)
    cs = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]); cs /= cs[-1]
    r = np.interp(u, cs, np.broadcast_to(_v(radii), (len(P),)))
    if rfun is not None: r = r * rfun(u, c)
    T = np.gradient(c, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    n = len(c); N = np.zeros_like(c); refv = _v(ref)
    n0 = refv - T[0] * (refv @ T[0])
    if np.linalg.norm(n0) < 1e-4: n0 = np.cross(T[0], (1, 0, 0))
    N[0] = n0 / np.linalg.norm(n0)
    for i in range(1, n):
        if flat is not None:
            m = refv - T[i] * (refv @ T[i])
            if np.linalg.norm(m) > 1e-4: N[i] = m / np.linalg.norm(m); continue
        v = N[i - 1] - T[i] * (N[i - 1] @ T[i]); N[i] = v / np.linalg.norm(v)
    Bv = np.cross(T, N)
    ang = np.linspace(0, 2 * np.pi, sides, endpoint=False); ca, sa = np.cos(ang), np.sin(ang)
    fx, fy = (1, 1) if flat is None else flat
    rings = c[:, None, :] + r[:, None, None] * (fx * ca[None, :, None] * N[:, None, :] + fy * sa[None, :, None] * Bv[:, None, :])
    verts = [rings.reshape(-1, 3)]; tris = []
    I = np.arange(n * sides).reshape(n, sides)
    a = I[:-1, :]; b = I[1:, :]; a2 = np.roll(a, -1, 1); b2 = np.roll(b, -1, 1)
    tris.append(np.stack([a, a2, b2], -1).reshape(-1, 3)); tris.append(np.stack([a, b2, b], -1).reshape(-1, 3))
    base = n * sides
    if caps:
        for end, sgn in ((0, -1), (n - 1, 1)):
            prev = I[end]
            for th in (0.45, 0.8, 1.15):
                cc = c[end] + sgn * T[end] * r[end] * np.sin(th); rr = r[end] * np.cos(th)
                verts.append(cc + rr * (fx * ca[:, None] * N[end] + fy * sa[:, None] * Bv[end]))
                cur = base + np.arange(sides); base += sides
                p2 = np.roll(prev, -1); c2 = np.roll(cur, -1)
                if sgn > 0: tris += [np.stack([prev, p2, c2], -1), np.stack([prev, c2, cur], -1)]
                else: tris += [np.stack([prev, c2, p2], -1), np.stack([prev, cur, c2], -1)]
                prev = cur
            verts.append((c[end] + sgn * T[end] * r[end])[None]); ti = base; base += 1
            p2 = np.roll(prev, -1)
            tris.append(np.stack([prev, p2, np.full(sides, ti)], -1) if sgn > 0 else np.stack([prev, np.full(sides, ti), p2], -1))
    return np.concatenate(verts), np.concatenate(tris)

def merge(meshes):
    V = []; T = []; off = 0
    for v, t in meshes: V.append(v); T.append(t + off); off += len(v)
    return np.concatenate(V), np.concatenate(T)

class Torus(Prim):
    """ring of major radius R, tube radius r, centred at c, ring plane normal n."""
    def __init__(self, c, n, R, r):
        self.c = _v(c); n = _v(n); n = n / np.linalg.norm(n); self.R_, self.r = R, r
        self.R = rot_axes(n, (1, 0, 0) if abs(n[0]) < 0.9 else (0, 0, 1))  # local y = normal
    def bbox(self): return self.c - self.R_ - self.r, self.c + self.R_ + self.r
    def __call__(self, x, y, z):
        px, py, pz = self.local(x, y, z)
        q = np.sqrt(px * px + pz * pz) - self.R_
        return np.sqrt(q * q + py * py) - self.r

def surface_path(scene, pts, offset, n=60, iters=4):
    """Catmull-Rom through pts, then snap every sample onto the scene surface (+offset outward)."""
    c = catmull(_v(pts), 16); c, _ = resample(c, max(np.linalg.norm(np.diff(c, axis=0), axis=1).sum() / n, 1e-4))
    f = lambda x, y, z: scene(x, y, z) - offset
    return project(f, c, iters=iters)

def branch_tree(start, direction, length, radius, gens, inside, rng, spread=0.62, lr=0.80, rr=0.70, twist=1.9):
    """Recursive bifurcating tree; `inside(p)` <= 0 keeps a tip inside an organ. Returns list of (points, radii)."""
    out = []
    def grow(p0, d, L, r, g, phase):
        d = d / np.linalg.norm(d)
        p1 = p0 + d * L
        for _ in range(6):                       # pull tips back inside the organ
            if inside(p1) <= -0.002: break
            L *= 0.75; p1 = p0 + d * L
        mid = (p0 + p1) / 2 + rng.normal(0, L * 0.06, 3)
        out.append(([p0, mid, p1], [r, r * 0.93, r * 0.86]))
        if g <= 0 or inside(p1) > 0: return
        a = np.cross(d, (0, 1, 0) if abs(d[1]) < 0.9 else (1, 0, 0)); a /= np.linalg.norm(a)
        b = np.cross(d, a)
        ax = a * np.cos(phase) + b * np.sin(phase)
        for sgn in (1, -1):
            nd = d * np.cos(spread * 0.5) + ax * sgn * np.sin(spread * 0.5) + rng.normal(0, 0.08, 3)
            grow(p1, nd, L * lr * rng.uniform(0.85, 1.1), r * rr, g - 1, phase + twist)
    grow(_v(start), _v(direction), length, radius, gens, rng.uniform(0, 3.14))
    return out
