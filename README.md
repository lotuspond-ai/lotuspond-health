# LotusPond Health

A personal health dashboard. Upload lab reports and scans, and see each result on a detailed 3D model of the body, organ by organ. Everything is read and stored in your browser; nothing is sent to a server.

## What it does

- **Upload** lab report PDFs (text-based), CSV/JSON exports, DICOM files (`.dcm`) and scan photos. Every value read from a file is shown for review before it is added.
- **Body map**: a 3D anatomy with 33 structures, including:
  - a four-chambered heart with valves and coronary vessels
  - lungs with their fissures and a bronchial tree
  - kidneys with cortex, medullary pyramids and calyces
  - a brain with gyri and ventricles
  - liver vessels and bile ducts
  - skeleton and diaphragm

  Organs with results get a status dot. Open an organ to fly in, read labelled landmarks, switch to x-ray, or cut a cross-section (front, side or top).
- **Biomarkers**: latest value of each marker grouped by body system, with its position in the reference range and its trend over time.
- **Scans**: assign scans to body areas; view with zoom, and brightness/contrast for DICOM.

Reference ranges come from your report when it prints one; otherwise a typical adult range is used and labelled. LotusPond explains results; it does not diagnose.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (relative paths, host anywhere)
```

## Project layout

| Path | What it holds |
| --- | --- |
| `src/three/` | React Three Fiber stage: tissue materials, pond floor, camera, x-ray and cross-sections |
| `src/anatomy/organs.ts` | Organ metadata: meshes, tissues, landmarks, linked body systems |
| `src/lib/` | Biomarker catalog, file parsers, persistence (IndexedDB) |
| `src/pages/`, `src/components/` | Interface |
| `tools/anatomy/` | Python generator for `public/models/anatomy.glb` (signed-distance modelling, surface nets, quadric decimation) |

## Rebuilding the anatomy model

Requires Python 3 with NumPy.

```bash
cd tools/anatomy
python3 gen_body.py && python3 gen_organs.py && python3 gen_gut.py && python3 gen_skel.py
python3 gen_organs.py kidneys && python3 gen_detail.py     # high-detail structures (overrides heart, brain, kidneys)
python3 build_glb.py decimate $(python3 -c "from build_glb import T; print(' '.join(T))")
python3 build_glb.py write anatomy_raw.glb
cd ../.. && npx gltf-transform meshopt tools/anatomy/anatomy_raw.glb public/models/anatomy.glb --level medium
```

Model coordinates are metres with `+x` toward the person's left, `+y` up and `+z` toward the front.
