import numpy as np, time, os
from sdf import *
S = (-1, 1)  # -1 = patient's RIGHT (viewer's left from the front), +1 = patient's LEFT.  +z anterior, +y up, metres.
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'parts')
os.makedirs(OUT, exist_ok=True)
def save(pid, v, t):
    np.savez(os.path.join(OUT, pid + '.npz'), v=v.astype(np.float32), t=t.astype(np.int32))
    print(f'{pid:<14} verts={len(v):6d} tris={len(t):6d}  x[{v[:,0].min():.3f},{v[:,0].max():.3f}] y[{v[:,1].min():.3f},{v[:,1].max():.3f}] z[{v[:,2].min():.3f},{v[:,2].max():.3f}]', flush=True)

HEART_BASE = np.array([-0.004, 1.334, -0.004]); HEART_APEX = np.array([0.074, 1.246, 0.056])
def heart_scene():
    d = HEART_APEX - HEART_BASE; dn = d / np.linalg.norm(d)
    R = rot_axes(dn, (0, 0, 1))
    sc = Scene()
    sc.u(Ellipsoid(HEART_BASE + 0.50 * d, (0.044, 0.060, 0.035), R))
    sc.u(RoundCone(HEART_BASE + 0.28 * d, HEART_APEX - 0.004 * dn, 0.040, 0.011), 0.022)
    sc.u(Ellipsoid((0.012, 1.284, 0.040), (0.040, 0.036, 0.022)), 0.016)   # right ventricle (anterior)
    sc.u(Sphere((-0.033, 1.302, 0.004), 0.026), 0.013)                     # right atrium
    sc.u(Ellipsoid((-0.020, 1.331, 0.028), (0.012, 0.010, 0.014)), 0.007)  # right auricle
    sc.u(Ellipsoid((0.008, 1.330, -0.020), (0.030, 0.020, 0.018)), 0.013)  # left atrium
    sc.u(Ellipsoid((0.042, 1.326, 0.018), (0.011, 0.009, 0.015)), 0.006)   # left auricle
    return sc

DOME_R = Ellipsoid((-0.055, 1.140, -0.010), (0.100, 0.125, 0.085))
DOME_L = Ellipsoid((0.060, 1.128, -0.012), (0.100, 0.122, 0.085))
def domes(): return Scene().u(DOME_R).u(DOME_L, 0.02)
CAVITY_T = Ellipsoid((0, 1.300, -0.010), (0.121, 0.215, 0.088))
CAVITY_A = Ellipsoid((0, 1.130, -0.008), (0.122, 0.175, 0.088))

def kidney_frame(s):
    c = np.array([0.062, 1.112, -0.064]) if s > 0 else np.array([-0.060, 1.090, -0.062])
    v = np.array([-s * 0.22, 1.0, -0.15]); v /= np.linalg.norm(v)
    u0 = np.array([s * 1.0, 0.0, -0.45]); u = u0 - v * (u0 @ v); u /= np.linalg.norm(u)
    return c, u, v, np.cross(u, v)
def kidney_scene(s, grow=0.0):
    c, u, v, w = kidney_frame(s)
    width = 0.0285 if s > 0 else 0.0245
    sc = Scene().u(Ellipsoid(c, (width + grow, 0.050 + grow, 0.019 + grow), np.stack([u, v, w])))
    if grow == 0:
        sc.s(Sphere(c - u * (width + 0.006), 0.015), 0.006)
        sc.u(RoundCone(c - u * (width - 0.016), c - u * (width + 0.010) - v * 0.014, 0.010, 0.0045), 0.004)
    return sc

STOMACH_PTS = [((0.030, 1.214, -0.010), 0.010), ((0.056, 1.214, -0.018), 0.029), ((0.074, 1.180, -0.004), 0.035),
               ((0.077, 1.140, 0.020), 0.035), ((0.062, 1.106, 0.040), 0.031), ((0.036, 1.090, 0.050), 0.026),
               ((0.008, 1.093, 0.054), 0.021), ((-0.016, 1.103, 0.048), 0.015), ((-0.030, 1.110, 0.040), 0.011)]
def stomach_scene():
    sc = Scene()
    for (a, ra), (b, rb) in zip(STOMACH_PTS[:-1], STOMACH_PTS[1:]): sc.u(RoundCone(a, b, ra, rb), 0.012)
    sc.u(Sphere((0.060, 1.216, -0.020), 0.030), 0.012)
    return sc
