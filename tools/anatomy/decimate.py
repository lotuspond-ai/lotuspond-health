"""Quadric-error edge-collapse mesh decimation (pure Python, lazy heap)."""
import heapq, math
import numpy as np

def decimate(V, T, target):
    V = [list(map(float, p)) for p in V]
    F = [list(map(int, f)) for f in T]
    nV = len(V)
    if nV <= target: return np.array(V), np.array(F)
    alive_f = [True] * len(F)
    vf = [set() for _ in range(nV)]
    for fi, (a, b, c) in enumerate(F): vf[a].add(fi); vf[b].add(fi); vf[c].add(fi)
    Q = [[0.0] * 10 for _ in range(nV)]
    for a, b, c in F:
        ax, ay, az = V[a]; bx, by, bz = V[b]; cx, cy, cz = V[c]
        ux, uy, uz = bx - ax, by - ay, bz - az; vx, vy, vz = cx - ax, cy - ay, cz - az
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        l = math.sqrt(nx * nx + ny * ny + nz * nz)
        if l < 1e-20: continue
        nx /= l; ny /= l; nz /= l; d = -(nx * ax + ny * ay + nz * az); w = l
        K = (nx * nx * w, nx * ny * w, nx * nz * w, nx * d * w, ny * ny * w, ny * nz * w, ny * d * w, nz * nz * w, nz * d * w, d * d * w)
        for vi in (a, b, c):
            q = Q[vi]
            for i in range(10): q[i] += K[i]
    def qerr(q, x, y, z):
        return (q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y
                + q[7] * z * z + 2 * q[8] * z + q[9])
    def best(u, v):
        q = [Q[u][i] + Q[v][i] for i in range(10)]
        a, b, c, d, e, f, g, h, i_, j = q
        det = a * (e * h - f * f) - b * (b * h - f * c) + c * (b * f - e * c)
        pu = V[u]; pv = V[v]
        mid = ((pu[0] + pv[0]) / 2, (pu[1] + pv[1]) / 2, (pu[2] + pv[2]) / 2)
        cands = [mid, tuple(pu), tuple(pv)]
        if abs(det) > 1e-14:
            r0, r1, r2 = -d, -g, -i_
            x = (r0 * (e * h - f * f) - b * (r1 * h - f * r2) + c * (r1 * f - e * r2)) / det
            y = (a * (r1 * h - f * r2) - r0 * (b * h - f * c) + c * (b * r2 - r1 * c)) / det
            z = (a * (e * r2 - r1 * f) - b * (b * r2 - r1 * c) + r0 * (b * f - e * c)) / det
            if math.dist((x, y, z), mid) < math.dist(pu, pv): cands.insert(0, (x, y, z))
        bc = None; be = 1e30
        for p in cands:
            er = qerr(q, *p)
            if er < be: be = er; bc = p
        return max(be, 0.0), bc
    ver = [0] * nV; heap = []; seen = set()
    for a, b, c in F:
        for u, v in ((a, b), (b, c), (c, a)):
            k = (u, v) if u < v else (v, u)
            if k in seen: continue
            seen.add(k); e, p = best(*k); heap.append((e, k[0], k[1], p, 0, 0))
    heapq.heapify(heap); del seen
    alive_v = [True] * nV; count = nV
    def nbrs(u):
        s = set()
        for fi in vf[u]: s.update(F[fi])
        s.discard(u); return s
    def fnormal(f, override=None, pos=None):
        pts = [pos if (override is not None and vi == override) else V[vi] for vi in f]
        ax, ay, az = pts[0]; bx, by, bz = pts[1]; cx, cy, cz = pts[2]
        ux, uy, uz = bx - ax, by - ay, bz - az; vx, vy, vz = cx - ax, cy - ay, cz - az
        return (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    while count > target and heap:
        e, u, v, p, su, sv = heapq.heappop(heap)
        if not (alive_v[u] and alive_v[v]) or ver[u] != su or ver[v] != sv: continue
        nu = nbrs(u); nv = nbrs(v)
        if v not in nu or len(nu & nv) != 2: continue
        ok = True
        for vv, other in ((u, v), (v, u)):
            for fi in vf[vv]:
                f = F[fi]
                if other in f: continue
                n0 = fnormal(f); n1 = fnormal(f, vv, p)
                l0 = math.sqrt(n0[0] ** 2 + n0[1] ** 2 + n0[2] ** 2); l1 = math.sqrt(n1[0] ** 2 + n1[1] ** 2 + n1[2] ** 2)
                if l1 < 1e-24 or l0 < 1e-24 or (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) < 0.25: ok = False; break
            if not ok: break
        if not ok: continue
        V[u] = list(p)
        for i in range(10): Q[u][i] += Q[v][i]
        for fi in list(vf[v]):
            f = F[fi]
            if u in f:
                alive_f[fi] = False
                for vi in f: vf[vi].discard(fi)
            else:
                f[f.index(v)] = u; vf[u].add(fi)
        vf[v] = set(); alive_v[v] = False; count -= 1; ver[u] += 1
        for w in nbrs(u):
            k = (u, w) if u < w else (w, u)
            e2, p2 = best(*k)
            heapq.heappush(heap, (e2, k[0], k[1], p2, ver[k[0]], ver[k[1]]))
    remap = -np.ones(nV, np.int64); out = []
    for i in range(nV):
        if alive_v[i]: remap[i] = len(out); out.append(V[i])
    Fo = np.array([[remap[a], remap[b], remap[c]] for fi, (a, b, c) in enumerate(F) if alive_f[fi]], np.int64)
    Fo = Fo[(Fo[:, 0] != Fo[:, 1]) & (Fo[:, 1] != Fo[:, 2]) & (Fo[:, 0] != Fo[:, 2])]
    return np.array(out), Fo
