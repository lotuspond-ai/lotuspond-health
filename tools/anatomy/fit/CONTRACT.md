# Fitting contract

The fitting step places Z-Anatomy structures (CC BY-SA 4.0, built on BodyParts3D) that the Visible Human bodies from the
Human Reference Atlas (HRA) lack into each HRA body: `male` (1.83 m) and `female` (1.67 m). Each fitting module owns one
group of structures and writes them where `assemble.py` picks them up.

## Coordinates and data

- Everything is in metres. Axes in both datasets: +x = the person's left, +y = up, +z = front. HRA bodies are centred at
  mid-height (male skin y −0.915…0.915, female −0.795…0.872); keep the HRA coordinates as they are. The floor shift
  happens later, in `assemble.py`.
- Raw meshes: `tools/anatomy/.cache/raw/<source>/` (index.json plus `<n>.pos`/`<n>.idx`), read with `lib.mesh.source(sid)`:
  `hra-male`, `hra-female`, `za-skeletal`, `za-visceral`, `za-muscular`, `za-cardio`, `za-nervous`, `za-lymphoid`, `za-regions`.
- HRA names: `VH_M_<name>` / `VH_F_<name>` (spelling differs between the sexes; select by group path where it does),
  plus `Allen_<region>_L/R` for the brain. Never use anything matching `catalog.HRA_EXCLUDE`.
- Z-Anatomy whole structures end in `l` / `r` (left / right) or have no suffix (midline). Names ending in `j` or `i`
  are label patches and label lines: never use them. In za-skeletal, names like `<Muscle>o[lr]` / `<Muscle>e[lr]` are
  muscle origin/insertion areas, not bones.

## Tools (read these files first)

- `lib/mesh.py`: loading, merging, components, orientation, surface sampling, `Surface` nearest-point queries, voxel
  `Grid` and signed distances.
- `lib/register.py`: `Sim`, `umeyama`, `icp`, `Warp` (3D thin-plate spline), `nonrigid_icp`, `rotation_between`.
- `fit/common.py`: `get_warp(sex, 'trunk')` (the cached smooth warp from Z-Anatomy space into the body's trunk, neck and
  head, fitted to 50+ paired structures: vertebrae, pelvis, airway, lungs, heart, liver, kidneys…), `hra_mesh`,
  `skin(sex)`, `skin_solid(sex)` (signed distance to the skin, negative inside), `Solid` (signed distance to any closed
  meshes, with a cache file), `penetration(mesh, solid)`, `write_group(...)`.
- `lib/qa.py`: `render_views(items, cams, prefix)` writes PNG renders (headless Chromium); view them with the Read tool.
- Python: `/tmp/claude-0/-home-user-lotuspond-health/cb096f78-613f-58bf-af53-30f52243c340/scratchpad/venv/bin/python`
  (numpy, scipy). Pipeline code may use only numpy, scipy and the repo's `lib/`. Run from `tools/anatomy/`.
- The machine has 4 cores shared with other jobs: keep runs lean (subsample, cache intermediate results under
  `.cache/fit/<sex>/<group>/`), and avoid running more than one heavy job at a time.

## Shared data

- Adult-calibre HRA vessels (`lib/inflate.py`): `from lib.inflate import inflated_hra; m = inflated_hra(sex)` returns
  `{HRA structure name: (v, f)}` in the HRA body's coordinates for every HRA structure the assembly changes: the
  inflated vessels (male descending aorta a/b at x1.5, about 21/19 mm across, its centreline moved off the vertebral
  bodies and discs by up to 3 mm with 0.5 mm clearance; male renal arteries 2.5 mm radius; female common bile and
  hepatic ducts 2.5 mm; female superior mesenteric artery 3.5 mm at its origin), the branches moved with them (the
  aortic arch, superior and inferior mesenteric arteries, coeliac trunk...; the female hepatic, cystic and pancreatic
  ducts) and the HRA veins pushed out of them (male renal veins and inferior vena cava, female left renal vein). Any
  structure not in it is unchanged (`lib.mesh.source(f'hra-{sex}').get(name)`). Fits whose structures must clear these
  vessels (the vessels fit's azygos system, the organs fit's oesophagus and diaphragm crura) should use these meshes as
  their obstacles instead of the raw HRA ones: `assemble.py` draws them. Cached in `.cache/fit/<sex>/inflated/`
  (`<name>.npz`, `manifest.json` with each structure's role, `report.json` with radii, shifts and every overlap before
  and after); rebuilt when its inputs change (it reads the rib cage fit's discs), or with `python3 lib/inflate.py
  [male|female|all]`. This folder is not a fit group: never write into it from a fit.

## Outputs

`python3 fit/<group>.py [male|female|all]` (default all) must write, per sex,
`.cache/fit/<sex>/<group>/` via `write_group(sex, group, outputs, report)`:

- one `.npz` per output structure (vertices in the HRA body's coordinates, consistent outward winding),
- `manifest.json`: name, file, `part` (an id from `catalog.PARTS`), optional `tissue`, source Z-Anatomy names,
- `report.json`: the acceptance measurements, each with its threshold and pass/fail,
- QA renders `qa-*.png` in the same folder.

Group names and the parts they fill:

| group | structures | parts |
|---|---|---|
| `arms` | clavicles, scapulae, humeri, radii, ulnae, all hand bones | `skel_arms`, `skel_hands` |
| `skull` | cranial and facial bones, mandible, hyoid (female only: the male HRA body has one), auditory ossicles, teeth, pituitary | `skel_skull`, `teeth`, `pituitary` |
| `feet` | tarsals, metatarsals, phalanges, sesamoids of both feet | `skel_feet` |
| `thorax` | ribs 1–12, costal cartilages, sternum (manubrium, body, xiphoid), intervertebral discs | `skel_thorax`, `costal_cartilage`, `discs` |
| `viscera` | stomach, esophagus, diaphragm, adrenal glands, thyroid gland, parathyroid glands | `stomach`, `esophagus`, `diaphragm`, `adrenals`, `thyroid`, `parathyroids` |
| `vessels` | Z-Anatomy arteries and veins that continue the HRA vascular tree into the neck, head, arms, pelvis and legs | `arteries`, `veins` |

Do not edit files outside your own `fit/<group>.py` (and helper modules named `fit/<group>_*.py`), and do not run git
commands that change state. If a shared file needs a change, say so in your final report instead.
