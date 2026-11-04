"""Organs fit, part 6: stomach and oesophagus helpers shared by the fits (organs_bed builds the stomach,
organs_tube the oesophagus, organs.py measures them).

  loop_axis                 centre, normal and radius of a closed ring of points
  orifices                  the cardiac and pyloric rims of the open Z-Anatomy stomach (and its other holes)
  duodenal_opening          the rim of the HRA duodenum's superior part at its proximal end (the pyloric junction)
  esophagus_field           the oesophagus as a solid organ for contacts (outer wall, ends capped, lumen included)
  warped_esophagus_field    the same for the warped Z-Anatomy oesophagus (the stand-in the diaphragm is fitted around)

(The earlier as-rigid-as-possible stomach fit and the carried Z-Anatomy oesophagus mesh were replaced by organs_bed
and organs_tube: the first crumpled the stomach in the HRA male's small bed, the second folded the tube's wall.)
"""
from scipy.spatial import cKDTree
import numpy as np

from fit.organs_data import hra
from fit.organs_geom import boundary_loops, centreline, resample_polyline


def loop_axis(P):
    """Centre, unit normal (by PCA) and mean radius of a closed ring of points."""
    c = P.mean(0)
    n = np.linalg.svd(P - c)[2][2]
    return c, n / np.linalg.norm(n), float(np.linalg.norm(P - c, axis=1).mean())


def orifices(v, f, sex, eso_end):
    """(pylorus loop, cardia loop, other loops) of the open Z-Anatomy stomach: the cardia is the loop nearest the
    oesophagus's lower end, the pylorus the loop nearest the HRA duodenum; Z-Anatomy's stomach also has a 3 cm hole in
    its anterior wall, which is filled (see fill_holes)."""
    loops = [np.array(l) for l in boundary_loops(f) if len(l) >= 8]
    duo = hra(sex, 'duo_sup')[0].mean(0)
    ic = int(np.argmin([np.linalg.norm(v[l].mean(0) - eso_end) for l in loops]))
    rest = [l for i, l in enumerate(loops) if i != ic]
    ip = int(np.argmin([np.linalg.norm(v[l].mean(0) - duo) for l in rest]))
    return rest[ip], loops[ic], [l for i, l in enumerate(rest) if i != ip]


def duodenal_opening(sex, near):
    """Rim of the HRA duodenum superior part at its proximal end (the one nearest `near`): the outer wall loop."""
    v, f = hra(sex, 'duo_sup')
    loops = [np.array(l) for l in boundary_loops(f) if len(l) >= 8]
    cs = [v[l].mean(0) for l in loops]
    d = np.array([np.linalg.norm(c - near) for c in cs])
    close = [l for l, dd in zip(loops, d) if dd < d.min() + 0.006]          # outer and inner walls at that end
    rad = [loop_axis(v[l])[2] for l in close]
    ring = close[int(np.argmax(rad))]
    return v[ring]


def warped_esophagus_field(W, h=0.0008):
    """esophagus_field of the warped Z-Anatomy oesophagus (the stand-in the diaphragm is fitted around)."""
    v0, f = W['esophagus']
    top = v0[v0[:, 1] > v0[:, 1].max() - 0.004].mean(0)
    bot = v0[v0[:, 1] < v0[:, 1].min() + 0.004].mean(0)
    return esophagus_field(v0, f, centreline(v0, top, bot, n=120, iters=4), h)


def esophagus_field(v, f, C, h=0.0006):
    """The oesophagus as a solid organ for contacts: its outer wall (faces whose normal points away from the
    centreline C), the open ends capped, lumen included; the lumen wall takes no part."""
    from fit.organs_geom import mesh_field
    Cd = resample_polyline(C, 400)[0]
    cen = v[f].mean(1)
    _, j = cKDTree(Cd).query(cen)
    fa = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    outer = np.einsum('ij,ij->i', fa, cen - Cd[j]) > 0
    return mesh_field(v, f[outer], h, cap=True)
