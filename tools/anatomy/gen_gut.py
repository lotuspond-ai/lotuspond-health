from common import *
t0 = time.time()
# ---------------- COLON (SDF sweep with haustra) ----------------
pts = [(-0.072, 0.948, 0.028), (-0.088, 0.990, 0.022), (-0.094, 1.040, 0.016), (-0.091, 1.084, 0.020), (-0.070, 1.080, 0.046),
       (-0.035, 1.058, 0.058), (0.005, 1.050, 0.062), (0.045, 1.062, 0.056), (0.080, 1.090, 0.036), (0.108, 1.112, -0.004),
       (0.112, 1.060, -0.012), (0.106, 0.995, -0.006), (0.096, 0.952, 0.008), (0.070, 0.935, 0.026), (0.040, 0.946, 0.030),
       (0.016, 0.944, 0.012), (0.002, 0.922, -0.016), (0.000, 0.895, -0.036), (0.000, 0.866, -0.046), (0.000, 0.846, -0.040)]
rad = [0.027, 0.025, 0.024, 0.023, 0.022, 0.0215, 0.021, 0.021, 0.021, 0.020, 0.020, 0.019, 0.018, 0.017, 0.016, 0.016, 0.017, 0.018, 0.014, 0.010]
c = catmull(np.array(pts), 16); c, u = resample(c, 0.005)
cs = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(np.array(pts), axis=0), axis=1))]); cs /= cs[-1]
r = np.interp(u, cs, rad)
L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(c, axis=0), axis=1))])
r = r * np.where(u < cs[13], 1 + 0.11 * np.cos(2 * np.pi * L / 0.026), 1.0)
sc = Scene()
sc.u(Sphere(c[0] + np.array([0.004, -0.008, 0.0]), 0.026))
for i in range(len(c) - 1): sc.u(RoundCone(c[i], c[i + 1], r[i], r[i + 1]), 0.004)
m = [mesh_scene(sc, 0.0026, smooth=1)]
m.append(tube([(-0.070, 0.930, 0.016), (-0.058, 0.914, 0.010), (-0.050, 0.896, 0.016), (-0.046, 0.884, 0.024)], 0.0036, step=0.003, sides=8))
v, t = merge(m); save('colon', v, t)

# ---------------- SMALL INTESTINE (duodenum + jejunum/ileum loops) ----------------
duo = [(-0.030, 1.110, 0.040), (-0.048, 1.108, 0.028), (-0.060, 1.090, 0.014), (-0.062, 1.062, 0.008), (-0.050, 1.042, 0.002),
       (-0.020, 1.036, -0.004), (0.012, 1.038, -0.006), (0.026, 1.052, -0.004), (0.032, 1.068, 0.004)]
rng = np.random.default_rng(7)
path = [np.array(p) for p in duo]
x0, x1 = -0.046, 0.068
layers = [(0.022, [1.040, 1.020, 1.000, 0.980, 0.962]), (0.046, [0.966, 0.986, 1.006, 1.026])]
direction = -1
path.append(np.array([0.050, 1.050, 0.020]))
for zl, rows in layers:
    for yr in rows:
        xs = np.linspace(x1, x0, 9) if direction < 0 else np.linspace(x0, x1, 9)
        ph1, ph2 = rng.uniform(0, 6.28, 2)
        for xx in xs:
            yy = yr + 0.0065 * np.sin(2 * np.pi * xx / 0.045 + ph1) + rng.normal(0, 0.0015)
            zz = zl + 0.009 * np.sin(2 * np.pi * xx / 0.06 + ph2) + rng.normal(0, 0.0015)
            path.append(np.array([xx, yy, zz]))
        direction *= -1
path += [np.array([-0.040, 0.975, 0.040]), np.array([-0.052, 0.966, 0.034])]
P = np.array(path)
radii = np.full(len(P), 0.0102); radii[:len(duo)] = 0.0118
v, t = tube(P, radii, step=0.0035, sides=11)
save('small_int', v, t)
print('time', time.time() - t0)
