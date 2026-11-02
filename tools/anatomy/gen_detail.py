"""High-detail structures for organ close-ups: hollow heart + valves + coronary vessels, bronchial tree, kidney internals,
adrenal glands, brain ventricles, hepatic/portal veins, bile ducts, diaphragm."""
from common import *
import sys
only = set(sys.argv[1:]); want = lambda n: not only or n in only
rng = np.random.default_rng(11)
t0 = time.time()

def lung_scene(s):
    hrt = heart_scene()
    sc = Scene().u(Ellipsoid((s * 0.070, 1.305, -0.012), (0.060, 0.170, 0.092)))
    sc.i(CAVITY_T, 0.012); sc.s(DOME_R if s < 0 else DOME_L, 0.012)
    sc.s(Fn(lambda x, y, z: hrt(x, y, z) - 0.010, (-0.08, 1.20, -0.06), (0.11, 1.38, 0.10)), 0.016)
    sc.s(Ellipsoid((0, 1.330, -0.020), (0.028, 0.240, 0.040)), 0.012)
    sc.s(Capsule((0, 1.50, -0.064), (0, 1.12, -0.066), 0.026), 0.012)
    return sc

def liver_scene():
    stm = stomach_scene(); dm = domes(); kr = kidney_scene(-1, 0.004)
    sc = Scene().u(Ellipsoid((-0.048, 1.180, -0.004), (0.096, 0.090, 0.090)))
    sc.u(Ellipsoid((0.014, 1.214, 0.024), (0.070, 0.040, 0.054)), 0.035)
    sc.i(HalfSpace((-0.05, 1.135, 0.0), (0.45, -1.0, 0.25)), 0.012)
    sc.i(Fn(lambda x, y, z: dm(x, y, z) + 0.003, (-0.3, 0.9, -0.2), (0.3, 1.4, 0.2)), 0.008)
    sc.i(CAVITY_A, 0.012)
    sc.s(Fn(lambda x, y, z: stm(x, y, z) - 0.004, (-0.05, 1.05, -0.06), (0.13, 1.26, 0.10)), 0.012)
    sc.s(Fn(lambda x, y, z: kr(x, y, z), (-0.13, 1.02, -0.12), (0.0, 1.16, -0.01)), 0.010)
    return sc

def tubes(paths, sides=8, step=0.0025):
    return merge([tube(p, r, step=step, sides=sides) for p, r in paths])

# ---------------- HEART: myocardium with four chambers ----------------
if want('heart'):
    d = HEART_APEX - HEART_BASE; dn = d / np.linalg.norm(d); R = rot_axes(dn, (0, 0, 1))
    h = heart_scene()
    h.s(Ellipsoid(HEART_BASE + 0.47 * d + np.array([0.006, 0.000, -0.010]), (0.016, 0.038, 0.013), R), 0.004)   # left ventricle
    h.s(Ellipsoid((0.004, 1.290, 0.036), (0.030, 0.026, 0.0105)), 0.004)                                          # right ventricle (crescent)
    h.s(Sphere((-0.033, 1.302, 0.004), 0.0185), 0.004)                                                            # right atrium
    h.s(Ellipsoid((0.008, 1.330, -0.020), (0.022, 0.0125, 0.0115)), 0.004)                                       # left atrium
    h.s(Capsule((0.008, 1.322, -0.012), (0.020, 1.312, -0.002), 0.008), 0.003)                                    # mitral orifice
    h.s(Capsule((-0.026, 1.302, 0.012), (-0.010, 1.296, 0.026), 0.0075), 0.003)                                   # tricuspid orifice
    h.s(Capsule((0.012, 1.300, 0.000), (0.008, 1.330, 0.010), 0.0075), 0.003)                                     # LV outflow -> aorta
    h.s(Capsule((0.010, 1.300, 0.034), (0.013, 1.330, 0.040), 0.0075), 0.003)                                     # RV outflow -> pulmonary
    v, t = mesh_scene(h, 0.0013, smooth=1); save('heart', v, t)
    rings = Scene()
    rings.u(Torus((0.015, 1.317, -0.007), (0.45, -0.35, 0.80), 0.0105, 0.0016))   # mitral
    rings.u(Torus((-0.018, 1.299, 0.019), (0.60, -0.15, 0.78), 0.0105, 0.0016))   # tricuspid
    rings.u(Torus((0.010, 1.318, 0.006), (-0.15, 1.0, 0.30), 0.0085, 0.0014))      # aortic
    rings.u(Torus((0.0115, 1.318, 0.037), (0.10, 1.0, -0.15), 0.0085, 0.0014))     # pulmonary
    v, t = mesh_scene(rings, 0.0008, smooth=1); save('valves', v, t)

if want('coronary'):
    hs = heart_scene(); art = []; ven = []
    for pts, r in [([(0.012, 1.328, 0.024), (0.024, 1.305, 0.055), (0.040, 1.285, 0.062), (0.056, 1.265, 0.062), (0.073, 1.248, 0.055)], 0.0020),      # LAD
                   ([(0.016, 1.326, 0.016), (0.040, 1.322, 0.008), (0.058, 1.302, -0.010), (0.052, 1.282, -0.030)], 0.0018),                         # circumflex
                   ([(0.034, 1.294, 0.060), (0.058, 1.288, 0.046), (0.074, 1.268, 0.030)], 0.0013),                                                  # diagonal
                   ([(0.056, 1.306, -0.004), (0.072, 1.282, 0.006), (0.080, 1.262, 0.022)], 0.0013),                                                 # obtuse marginal
                   ([(-0.004, 1.324, 0.026), (-0.022, 1.312, 0.036), (-0.046, 1.296, 0.026), (-0.058, 1.276, 0.000), (-0.050, 1.256, -0.026), (-0.030, 1.246, -0.036)], 0.0019),  # RCA
                   ([(-0.030, 1.246, -0.036), (0.000, 1.240, -0.032), (0.030, 1.241, -0.020)], 0.0014),                                              # posterior descending
                   ([(-0.050, 1.290, 0.022), (-0.030, 1.266, 0.042), (-0.010, 1.252, 0.048)], 0.0012)]:                                              # acute marginal
        art.append((surface_path(hs, pts, 0.0010), r))
    for pts, r in [([(0.072, 1.252, 0.050), (0.052, 1.272, 0.064), (0.030, 1.296, 0.060), (0.020, 1.318, 0.040), (0.040, 1.322, 0.000), (0.040, 1.300, -0.028)], 0.0017),
                   ([(0.040, 1.300, -0.028), (0.000, 1.288, -0.036), (-0.030, 1.284, -0.022)], 0.0024)]:
        ven.append((surface_path(hs, pts, 0.0010), r))
    v, t = tubes(art, 8, 0.0018); save('coronary', v, t)
    v, t = tubes(ven, 8, 0.0018); save('cardiac_veins', v, t)

# ---------------- LUNGS: bronchial tree ----------------
if want('bronchi'):
    paths = []
    for s, roots in ((-1, [((-0.052, 1.302, -0.028), (-0.35, 0.80, -0.10), 0.026, 0.0042), ((-0.052, 1.302, -0.028), (-0.45, -0.25, 0.75), 0.024, 0.0036), ((-0.052, 1.302, -0.028), (-0.30, -0.85, -0.35), 0.030, 0.0046)]),
                     (1, [((0.060, 1.312, -0.032), (0.35, 0.75, 0.25), 0.028, 0.0040), ((0.060, 1.312, -0.032), (0.25, -0.85, -0.35), 0.030, 0.0044)])):
        ls = lung_scene(s); inside = lambda p, ls=ls: float(ls(np.array(p[0]), np.array(p[1]), np.array(p[2])))
        for p0, d, L, r in roots:
            for pts, rr in branch_tree(np.array(p0), np.array(d), L, r, 6, inside, rng, spread=0.75, lr=0.78, rr=0.74):
                paths.append((pts, [max(x, 0.0007) for x in rr]))
    v, t = tubes(paths, 6, 0.0022); save('bronchi', v, t)

# ---------------- KIDNEYS: cortex shell, medullary pyramids, pelvis + calyces, adrenal glands ----------------
if want('kidneys'):
    cortex = []; med = []; pel = []; adr = []
    for s in S:
        c, u, v_, w = kidney_frame(s); width = 0.0285 if s > 0 else 0.0245
        k = kidney_scene(s)
        k.s(Ellipsoid(c - u * 0.004, (width - 0.0085, 0.050 - 0.0095, 0.019 - 0.0065), np.stack([u, v_, w])), 0.003)
        cortex.append(mesh_scene(k, 0.0011, smooth=1))
        ms = Scene(); apices = []
        for th in np.radians(np.linspace(-68, 68, 7)):
            base = c + u * (width - 0.013) * np.cos(th) + v_ * 0.036 * np.sin(th)
            apex = c - u * 0.006 + v_ * 0.020 * np.sin(th)
            ms.u(RoundCone(base, apex, 0.0068, 0.0022), 0.0015); apices.append(apex)
        med.append(mesh_scene(ms, 0.0008, smooth=1))
        hil = c - u * (width + 0.010) - v_ * 0.014; pc = c - u * 0.012
        ps = Scene().u(RoundCone(pc, hil, 0.0085, 0.0042))
        for a in apices: ps.u(RoundCone(pc + (a - pc) * 0.15, a - (a - pc) * 0.12, 0.0026, 0.0034), 0.002)
        pel.append(mesh_scene(ps, 0.0008, smooth=1))
        top = c + v_ * 0.047 - u * 0.007
        ad = Scene().u(Triangle(top - u * 0.017 + w * 0.002 - v_ * 0.004, top + u * 0.010 - v_ * 0.002, top + v_ * 0.024 - u * 0.004, 0.0021))
        ad.u(Triangle(top - u * 0.017 - v_ * 0.004, top + v_ * 0.024 - u * 0.004, top - u * 0.008 - v_ * 0.006 + w * 0.006, 0.0018), 0.002)
        adr.append(mesh_scene(ad, 0.0008, smooth=1))
    v, t = merge(cortex); save('kidneys', v, t)
    v, t = merge(med); save('kidney_medulla', v, t)
    v, t = merge(pel); save('kidney_pelvis', v, t)
    v, t = merge(adr); save('adrenals', v, t)

# ---------------- BRAIN with ventricular system ----------------
if want('brain'):
    import importlib.util
    def gyroid(x, y, z):
        f = 2 * np.pi / 0.024
        wx = x + 0.004 * np.sin(83 * y + 1.3) + 0.003 * np.sin(57 * z + 0.4)
        wy = y + 0.004 * np.sin(71 * z + 2.1) + 0.003 * np.sin(49 * x + 1.7)
        wz = z + 0.004 * np.sin(66 * x + 0.7) + 0.003 * np.sin(61 * y + 2.9)
        g = np.sin(f * wx) * np.cos(f * wy) + np.sin(f * wy) * np.cos(f * wz) + np.sin(f * wz) * np.cos(f * wx)
        return 0.0034 * np.exp(-(g / 0.40) ** 2)
    cer = Scene()
    for s in S:
        cer.u(Ellipsoid((s * 0.031, 1.682, -0.010), (0.040, 0.053, 0.081)), 0.012)
        cer.u(Ellipsoid((s * 0.049, 1.643, 0.008), (0.023, 0.026, 0.046)), 0.014)
    cer.s(Fn(lambda x, y, z: np.maximum(np.abs(x) - 0.0016, 1.664 - y), (-0.01, 1.6, -0.12), (0.01, 1.75, 0.1)), 0.003)
    for s in S:
        cer.s(Fn(lambda x, y, z, s=s: np.maximum(np.abs((y - 1.660) - 0.32 * z) - 0.0015, 0.030 - s * x), (-0.1, 1.6, -0.06), (0.1, 1.72, 0.08)), 0.002)
    brain = Scene().u(Displaced(cer, gyroid, 0.004))
    folia = lambda x, y, z: 0.0012 * (0.5 + 0.5 * np.sin(2 * np.pi * ((y - 1.62) + 0.35 * (z + 0.06)) / 0.0040))
    cb = Scene()
    for s in S: cb.u(Ellipsoid((s * 0.024, 1.620, -0.062), (0.030, 0.024, 0.031)), 0.012)
    cb.s(Capsule((0, 1.640, -0.035), (0, 1.600, -0.095), 0.0022), 0.002)    # vermis groove
    brain.u(Displaced(cb, folia, 0.0012), 0.004)
    brain.u(RoundCone((0, 1.648, -0.022), (0, 1.560, -0.030), 0.0135, 0.0100), 0.006)
    brain.u(Ellipsoid((0, 1.626, -0.013), (0.015, 0.014, 0.013)), 0.005)   # pons
    vent = Scene()
    for s in S:
        pts = [(s * 0.010, 1.680, 0.036), (s * 0.012, 1.690, 0.012), (s * 0.014, 1.690, -0.014), (s * 0.016, 1.682, -0.040), (s * 0.024, 1.666, -0.046), (s * 0.030, 1.650, -0.030), (s * 0.034, 1.642, -0.008)]
        rad = [0.0045, 0.0050, 0.0048, 0.0052, 0.0045, 0.0038, 0.0030]
        for (a, ra), (b, rb) in zip(zip(pts[:-1], rad[:-1]), zip(pts[1:], rad[1:])): vent.u(RoundCone(a, b, ra, rb, scale=(1.6, 1, 1)), 0.003)
    vent.u(Capsule((0, 1.668, 0.016), (0, 1.660, -0.012), 0.0035, scale=(3.0, 0.7, 1)), 0.003)       # third ventricle
    vent.u(Capsule((0, 1.640, -0.026), (0, 1.606, -0.044), 0.0020), 0.003)                          # aqueduct / fourth
    brain.s(vent, 0.002)
    v, t = mesh_scene(brain, 0.0016, smooth=1); save('brain', v, t)

# ---------------- LIVER vessels + bile ducts ----------------
if want('liver_vessels'):
    lv = liver_scene(); inside = lambda p: float(lv(np.array(p[0]), np.array(p[1]), np.array(p[2])))
    hv = []
    for d in ((-0.80, -0.40, 0.45), (-0.15, -0.45, 0.88), (0.75, -0.30, 0.60)):
        hv += branch_tree(np.array([-0.022, 1.238, -0.014]), np.array(d), 0.034, 0.0048, 4, inside, rng, spread=0.80, lr=0.76, rr=0.72)
    pv = []
    for d in ((-0.90, 0.30, 0.25), (0.85, 0.40, 0.30)):
        pv += branch_tree(np.array([-0.026, 1.150, 0.004]), np.array(d), 0.030, 0.0052, 4, inside, rng, spread=0.85, lr=0.76, rr=0.72)
    pv.append(([(-0.004, 1.095, 0.002), (-0.018, 1.122, 0.004), (-0.026, 1.150, 0.004)], [0.0058, 0.0058, 0.0055]))   # portal trunk
    v, t = tubes([(p, [max(x, 0.0008) for x in r]) for p, r in hv], 7, 0.0022); save('hepatic_veins', v, t)
    v, t = tubes([(p, [max(x, 0.0008) for x in r]) for p, r in pv], 7, 0.0022); save('portal_vein', v, t)
    bd = [([(-0.030, 1.150, 0.020), (-0.034, 1.138, 0.016), (-0.040, 1.118, 0.014), (-0.050, 1.095, 0.014), (-0.056, 1.078, 0.016)], 0.0026),
          ([(-0.034, 1.138, 0.016), (-0.032, 1.155, 0.010), (-0.040, 1.172, 0.004), (-0.060, 1.182, 0.004)], 0.0019),
          ([(-0.032, 1.155, 0.010), (-0.014, 1.170, 0.010), (0.010, 1.190, 0.018)], 0.0017)]
    v, t = tubes(bd, 8, 0.002); save('bile_ducts', v, t)

# ---------------- DIAPHRAGM ----------------
if want('diaphragm'):
    dm = domes()
    sc = Scene().u(Fn(lambda x, y, z: np.abs(dm(x, y, z)) - 0.0030, (-0.18, 1.0, -0.15), (0.18, 1.3, 0.12)))
    sc.i(Ellipsoid((0, 1.150, -0.010), (0.122, 0.20, 0.090)), 0.006)
    sc.i(HalfSpace((0, 1.148, 0), (0, -1, 0)), 0.008)
    sc.s(Capsule((-0.022, 1.30, -0.014), (-0.021, 1.10, -0.012), 0.0115), 0.002)   # caval opening
    sc.s(Capsule((0.020, 1.30, -0.030), (0.034, 1.10, -0.012), 0.0085), 0.002)    # oesophageal hiatus
    sc.s(Capsule((0.012, 1.30, -0.046), (0.014, 1.10, -0.036), 0.0105), 0.002)    # aortic hiatus
    v, t = mesh_scene(sc, 0.0022, smooth=1); save('diaphragm', v, t)
print('time', round(time.time() - t0, 1))
