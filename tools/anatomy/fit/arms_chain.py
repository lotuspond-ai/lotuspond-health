"""Articulated placement of the free limb: humerus about the glenohumeral centre, forearm about the elbow, hand about
the wrist, each finger about its MCP / PIP / DIP centres.

Bone maps (ZA -> HRA) are an optional shaft stretch along the bone's Z-Anatomy axis followed by an affine map
(rotation x body scale + translation). The stretch changes a long bone's length in its diaphysis only: the articular
ends keep their Z-Anatomy shape and size, so joint surfaces stay congruent with their partners.
"""
import numpy as np

from fit.arms_geom import Aff, rot_between, rot_axis, unit


def _smooth_cdf(u, a0, a1, b0, b1):
    """Integral (normalised to 1) of a bump that rises over [a0, a1], is flat to b0 and falls over [b0, b1]."""
    g = np.linspace(-0.5, 1.5, 2001)
    def ss(x): x = np.clip(x, 0, 1); return x * x * (3 - 2 * x)
    b = ss((g - a0) / (a1 - a0)) * (1 - ss((g - b0) / (b1 - b0)))
    c = np.concatenate([[0], np.cumsum(0.5 * (b[1:] + b[:-1]) * np.diff(g))])
    c /= c[-1]
    return np.interp(u, g, c)


class Stretch:
    """x -> x + dL * Phi(u) * a, u the position along the axis p0 -> p1 (0 at p0, 1 at p1), Phi rising smoothly
    from 0 (proximal end) to 1 (distal end) over the shaft only."""

    def __init__(self, p0, p1, dL, zone=(0.15, 0.32, 0.68, 0.85)):
        self.p0 = np.asarray(p0, float); self.p1 = np.asarray(p1, float)
        self.L = float(np.linalg.norm(self.p1 - self.p0)); self.a = (self.p1 - self.p0) / self.L
        self.dL = float(dL); self.zone = zone

    def __call__(self, x):
        x = np.asarray(x, float)
        if self.dL == 0: return x.copy()
        u = ((x - self.p0) @ self.a) / self.L
        return x + (self.dL * _smooth_cdf(u, *self.zone))[..., None] * self.a

    def end_shift(self):
        return self.dL * self.a

    def to_dict(self):
        return dict(p0=self.p0.tolist(), p1=self.p1.tolist(), dL=self.dL, zone=list(self.zone))


class BoneMap:
    """ZA -> HRA map of one bone: stretch (optional) then affine."""

    def __init__(self, aff, stretch=None):
        self.aff = aff; self.stretch = stretch

    def __call__(self, x):
        x = np.asarray(x, float)
        if self.stretch is not None: x = self.stretch(x)
        return self.aff(x)

    def then(self, aff2):
        return BoneMap(self.aff.then(aff2), self.stretch)

    def to_dict(self):
        return dict(A=self.aff.A.tolist(), t=self.aff.t.tolist(), stretch=self.stretch.to_dict() if self.stretch else None)

    @staticmethod
    def from_dict(d):
        st = d.get('stretch')
        return BoneMap(Aff(np.array(d['A']), np.array(d['t'])), Stretch(st['p0'], st['p1'], st['dL'], tuple(st['zone'])) if st else None)


def swing(a, b):
    """Minimal rotation taking direction a to direction b."""
    return rot_between(a, b)


def aim(aff, p_za, d_za, target_from, target_to):
    """Rotate an affine map about the image of p_za so the image of direction d_za points from target_from to
    target_to (the image of p_za is assumed to sit at target_from)."""
    cur = unit(aff.vec(d_za))
    R = swing(cur, unit(np.asarray(target_to) - np.asarray(target_from)))
    c = aff(np.asarray(p_za)[None])[0]
    return aff.then(Aff.about(R, c))


def twist_to(aff, axis_p, axis_d, v_za, v_target):
    """Rotate an affine map about the (HRA) axis through axis_p along axis_d so the image of vector v_za, projected
    perpendicular to the axis, lines up with v_target's projection. Returns (aff, angle in degrees)."""
    a = unit(axis_d)
    v1 = aff.vec(v_za); v1 = unit(v1 - (v1 @ a) * a)
    v2 = unit(v_target - (np.asarray(v_target) @ a) * a)
    ang = np.arctan2(np.cross(v1, v2) @ a, v1 @ v2)
    return aff.then(Aff.about(rot_axis(a, ang), axis_p)), float(np.degrees(ang))


def flex_abduct(dir_cur, dir_target, flex_axis):
    """Decompose the rotation of a phalanx about its proximal joint into flexion about `flex_axis` and abduction about
    the axis perpendicular to both (no axial twist). Returns the rotation matrix taking dir_cur onto dir_target."""
    f = unit(flex_axis)
    d0 = unit(dir_cur); d1 = unit(dir_target)
    # abduction axis: perpendicular to the finger and the flexion axis
    ab = unit(np.cross(d0, f))
    # abduction: bring d0 into the plane spanned by (d1's flexion plane)...: solve as two successive swings
    # 1) abduction about `ab`... equivalent and robust: swing, then remove the twist about the bone axis
    R = rot_between(d0, d1)
    # remove twist: the flexion axis should stay perpendicular to the bone and keep its angle to the abduction axis
    f1 = R @ f
    # the twist-free flexion axis: project the original flexion axis direction onto the plane perpendicular to d1
    f_t = unit(f - (f @ d1) * d1)
    ang = np.arctan2(np.cross(f1, f_t) @ d1, f1 @ f_t)
    return rot_axis(d1, ang) @ R
