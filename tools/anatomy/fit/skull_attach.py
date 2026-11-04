"""Attachments for the skull fit (fit/skull.py): the pituitary stalk to the hypothalamus and the female hyoid to the larynx.

- Pituitary stalk: the gland body rides with the sella (skull refinement field) but the infundibular stalk must reach the
  tuber cinereum. The stalk (the pituitary vertices above the Z-Anatomy level where the gland narrows into the stalk) is
  stretched with a smooth falloff (0 at the gland body, 1 at the stalk's top ring) so that its top ring meets the Allen
  tuberal hypothalamus with a STALK_GAP contact; the gland body does not move.
- Hyoid (female only: the HRA female has the laryngeal cartilages but no hyoid): the bone keeps the orientation the head
  warp gives it and is translated so that its centroid sits where the male HRA hyoid sits relative to the male HRA
  thyroid cartilage, scaled by the size of the female thyroid cartilage (larynx frame: superior horn tips, head up).
"""
import os, sys
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from lib.mesh import dense_points, Surface  # noqa: E402
from fit.common import hra_mesh  # noqa: E402

STALK_GAP = 0.00025   # top ring of the stalk this far from the tuberal hypothalamus (0-0.5 mm contact)


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def stretch_stalk(sex, P, L, up, log=print):
    """Stretch the infundibular stalk of the placed pituitary (P['adenohypophysis'], P['neurohypophysis']) up to the
    tuberal hypothalamus. up: the head's superior axis. Returns (P updated, info)."""
    tub = hra_mesh(sex, r'^Allen_tuberal_region_of_HTH_[LR]$')
    if not len(tub[1]): tub = hra_mesh(sex, r'^Allen_(hypothalamus|tuberal_region_of_HTH)_[LR]$')
    tp = dense_points(*tub, 0.0002); tt = cKDTree(tp)
    parts = ('adenohypophysis', 'neurohypophysis')
    stalk = {}; body_h = []
    for nm in parts:
        v = P[nm][0]; b = np.zeros(len(v), bool); b[L[f'pit_body_{nm.capitalize()}']] = True
        stalk[nm] = ~b; body_h.append((v[b] @ up).max())
    allstalk = np.concatenate([P[nm][0][stalk[nm]] for nm in parts])
    h = allstalk @ up
    h_cut = float(max(body_h)); h_top = float(h.max())
    ring = allstalk[h > h_top - 0.0006]
    rc = ring.mean(0)
    d0, j = tt.query(rc)
    # the target: the tuberal surface point nearest the ring centre, approached along the stalk (ring centre -> target)
    tgt = tp[j]; dirn = (tgt - rc) / max(np.linalg.norm(tgt - rc), 1e-9)
    disp = tgt - STALK_GAP * dirn - rc
    gap_before = float(tt.query(ring)[0].min())
    for nm in parts:
        v, f, part = P[nm]
        w = np.zeros(len(v)); hv = v[stalk[nm]] @ up
        w[stalk[nm]] = smoothstep((hv - h_cut) / max(h_top - h_cut, 1e-4))
        P[nm] = (v + w[:, None] * disp, f, part)
    allstalk2 = np.concatenate([P[nm][0][stalk[nm]] for nm in parts])
    ring2 = allstalk2[(allstalk2 @ up) > (allstalk2 @ up).max() - 0.0006]
    info = dict(stalk_top_gap_to_tuberal_hypothalamus_before_mm=round(gap_before * 1000, 2),
                stalk_top_gap_after_mm=round(float(tt.query(ring2)[0].min()) * 1000, 2),
                stalk_top_ring_centre_gap_after_mm=round(float(tt.query(ring2.mean(0))[0]) * 1000, 2),
                stalk_top_moved_mm=round(float(np.linalg.norm(disp)) * 1000, 2),
                stalk_length_before_mm=round((h_top - h_cut) * 1000, 2), target='Allen tuberal region of the hypothalamus')
    log('pituitary stalk', info)
    return P, info


def larynx_frame(thyroid):
    """(origin = midpoint of the superior horn tips, rows lat / up / forward, horn separation) of a thyroid cartilage."""
    v = thyroid[0]; mid = np.median(v[:, 0])
    tips = []
    for sg in (1, -1):
        s = v[(v[:, 0] - mid) * sg > 0.004]
        tips.append(s[s[:, 1] > s[:, 1].max() - 0.002].mean(0))
    tl, tr = tips
    lat = (tl - tr) / np.linalg.norm(tl - tr)
    up = np.array([0, 1.0, 0]); up -= (up @ lat) * lat; up /= np.linalg.norm(up)
    fw = np.cross(lat, up); fw = fw if fw[2] > 0 else -fw
    B = np.stack([lat, up, fw])
    ext = np.ptp(v @ B.T, axis=0)
    return (tl + tr) / 2, B, (tl, tr), ext


def place_hyoid(sex, P, log=print):
    """Translate the female hyoid to the male HRA hyoid's position relative to the thyroid cartilage (sagittal offset
    scaled by the thyroid size ratio; the female's own lateral offset kept). Returns (P updated, info)."""
    if 'hyoid_bone' not in P: return P, None
    mt = hra_mesh('male', r'^VH_M_thyroid_cartilage$'); mh = hra_mesh('male', r'^VH_M_hyoid$')
    ft = hra_mesh(sex, r'^VH_[MF]_thyroid_cartilage$')
    mo, mB, _, mext = larynx_frame(mt); fo, fB, ftips, fext = larynx_frame(ft)
    k = float(np.mean(fext / mext))
    moff = mB @ (mh[0].mean(0) - mo)
    v, f, part = P['hyoid_bone']
    foff = fB @ (v.mean(0) - fo)
    target = np.array([foff[0], k * moff[1], k * moff[2]])
    d = fB.T @ (target - foff)
    hp0 = dense_points(v, f, 0.0003)
    S = Surface(*ft, spacing=0.0003)
    info = dict(male_offset_lat_up_fw_mm=[round(float(x) * 1000, 1) for x in moff], thyroid_size_ratio=round(k, 3),
                female_offset_before_mm=[round(float(x) * 1000, 1) for x in foff], female_offset_after_mm=[round(float(x) * 1000, 1) for x in target],
                moved_mm=[round(float(x) * 1000, 2) for x in d],
                min_dist_to_thyroid_cartilage_before_mm=round(float(S.dist(hp0).min()) * 1000, 2),
                min_dist_to_superior_horn_tips_before_mm=[round(float(np.linalg.norm(hp0 - t, axis=1).min()) * 1000, 2) for t in ftips])
    v2 = v + d; hp = hp0 + d
    P['hyoid_bone'] = (v2, f, part)
    info.update(min_dist_to_thyroid_cartilage_after_mm=round(float(S.dist(hp).min()) * 1000, 2),
                min_dist_to_superior_horn_tips_after_mm=[round(float(np.linalg.norm(hp - t, axis=1).min()) * 1000, 2) for t in ftips])
    log('hyoid', info)
    return P, info
