// Offline renders for the 2D body map, at the best settings the stage has: physical materials, ambient occlusion,
// bloom, MSAA plus SMAA, supersampling. No floor: a plain pond-coloured background blends into the stage at any size. Also renders flat-colour ID maps (no antialiasing) that the 2D view hit-tests against.
// tools/render-bodymap.mjs opens tools/bodymap-render.html (entry: ./main.tsx) in headless Chromium and calls
// window.__bodymap. Never part of the app bundle.
import { Suspense, useEffect, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { EffectComposer, Bloom, ToneMapping, SMAA, N8AO } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { Anatomy } from '../Anatomy';
import { meshOrgan, meshRegistry } from '../registry';
import { POND, StudioLight } from '../Stage';
import { ORGANS, ORGAN_BY_ID, TISSUE, type Vec3 } from '../../anatomy/organs';
import { RIGS, focusOf, landmarksOf, meshSpecs, organsIn, pinOf } from '../../anatomy/bodies';
import { isBody, type Body } from '../../lib/body';
import { useHealth } from '../../lib/store';
import type { OrganId } from '../../types';

/** ID map index 0 is empty space; organs follow in this order. */
const ID_ORGANS = ORGANS.filter(o => o.id !== 'skin').map(o => o.id);
/** Well-separated flat colours, one per organ (exact values are what the 2D view decodes). */
const PALETTE: [number, number, number][] = [[0, 0, 0], ...ID_ORGANS.map((_, i) => {
  const c = new THREE.Color().setHSL(i / ID_ORGANS.length, 0.75, i % 2 ? 0.42 : 0.6, THREE.SRGBColorSpace);
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)] as [number, number, number];
})];

const FOV = 30;
const params = new URLSearchParams(location.search);
const BODY_ID: Body = isBody(params.get('body')) ? (params.get('body') as Body) : 'female';
/** Whole-body framing: the camera circles the body's vertical axis, close enough for the body to fill the 2:3 frame
 *  with the raised hands inside it (cropping around mid-shin), and 7% of the frame above the head, clear of the
 *  stage's title and tools. */
const BODY = (() => {
  const rig = RIGS[BODY_ID], [lo, hi] = rig.bounds;
  const halfWidth = Math.max(-lo[0], hi[0]);
  const tanV = Math.tan(THREE.MathUtils.degToRad(FOV / 2)), tanH = tanV * (2 / 3);
  const distance = (halfWidth / tanH) * 1.06;
  const half = distance * tanV;
  return { target: new THREE.Vector3(0, rig.height + 0.14 * half - half, 0), distance, elevation: 4 };
})();
/** Fog was tuned for a 2.7 m whole-body view. */
const FOG = BODY.distance / 2.7;

type View = { kind: 'body'; deg: number } | { kind: 'organ'; organ: OrganId };
/** sizes: [width, height, WebP quality] per output image; id: size of the ID map (body views only). */
interface ShotOptions { sizes: [number, number, number][]; id?: [number, number] }
type P3 = [number, number, number];
interface Shot {
  images: string[];
  /** Colour of the empty background after tone mapping (the 2D stage is painted with it so the image edge disappears). */
  background: [number, number, number];
  id?: { width: number; height: number; data: string };
  boxes?: Record<string, [number, number, number, number]>;
  pins?: Record<string, P3>;
  landmarks?: P3[];
  /** Names of the landmarks, in the same order. */
  names?: string[];
  camera: { position: P3; target: P3 };
}

const ao = params.get('ao') !== '0';
const bloom = params.get('bloom') !== '0';
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const nextFrames = async (n: number) => { for (let i = 0; i < n; i++) await new Promise(r => requestAnimationFrame(r)); };

function toBase64(bytes: Uint8Array) {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function boxOf(ids: string[]) {
  const box = new THREE.Box3();
  for (const id of ids) { const m = meshRegistry.get(id); if (m) box.union(new THREE.Box3().setFromObject(m)); }
  return box;
}

function Bridge({ setAo }: { setAo: (on: boolean) => void }) {
  const { gl, camera, invalidate } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const target = new THREE.Vector3();

    // ID scene: the same geometry with flat unlit colours, in three layers so that the organ a person would aim at
    // wins, as the 3D picker ranks hits: bones first, then see-through tissue, then solid organs over both.
    const idScene = new THREE.Scene();
    const idMeshes: { mesh: THREE.Mesh; layer: number }[] = [];
    const specs = meshSpecs(BODY_ID);
    for (const [name, orig] of meshRegistry) {
      const organ = meshOrgan.get(name);
      if (!organ || organ === 'skin') continue;
      const [r, g, b] = PALETTE[ID_ORGANS.indexOf(organ) + 1];
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.LinearSRGBColorSpace), toneMapped: false, fog: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(orig.geometry, mat);
      mesh.matrixAutoUpdate = false; orig.updateWorldMatrix(true, false); mesh.matrix.copy(orig.matrixWorld); mesh.updateMatrixWorld(true);
      const spec = specs.get(name)!;
      idMeshes.push({ mesh, layer: organ === 'marrow' ? 0 : TISSUE[spec.tissue].opacity ? 1 : 2 });
      idScene.add(mesh);
    }

    function place(view: View) {
      if (view.kind === 'body') {
        const a = THREE.MathUtils.degToRad(view.deg), e = THREE.MathUtils.degToRad(BODY.elevation);
        target.copy(BODY.target);
        cam.position.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).multiplyScalar(BODY.distance).add(target);
      } else {
        // Frame the organ's own meshes plus its landmarks (the 3D rig's focus list can include neighbours).
        const o = ORGAN_BY_ID[view.organ];
        const focus = focusOf(BODY_ID, o.id);
        const own = focus.filter(id => meshOrgan.get(id) === o.id);
        const box = boxOf(own.length ? own : focus);
        for (const l of landmarksOf(BODY_ID, o.id)) box.expandByPoint(new THREE.Vector3(...l.at));
        if (box.isEmpty()) console.error(`render: nothing to frame for ${o.id} in the ${BODY_ID} body`);
        box.getCenter(target);
        const size = box.getSize(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z) * 0.62;
        const vf = THREE.MathUtils.degToRad(FOV / 2), hf = Math.atan(Math.tan(vf) * cam.aspect);
        const dist = Math.max(0.2, radius / Math.sin(Math.min(vf, hf)) * 1.3);
        cam.position.copy(new THREE.Vector3(...o.view).normalize()).multiplyScalar(dist).add(target);
      }
      cam.lookAt(target); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    }

    function project(p: Vec3): P3 {
      const v = new THREE.Vector3(...p);
      const depth = -v.clone().applyMatrix4(cam.matrixWorldInverse).z;
      const ndc = v.project(cam);
      return [r4((ndc.x + 1) / 2), r4((1 - ndc.y) / 2), r4(cam.position.distanceTo(target) - depth)];
    }

    function background(): [number, number, number] {
      const c = document.createElement('canvas'); c.width = c.height = 8;
      const g = c.getContext('2d')!; g.drawImage(gl.domElement, 0, 0, 8, 8);
      const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
      return [r, gg, b];
    }

    async function encode(sizes: [number, number, number][]) {
      const src = gl.domElement;
      return Promise.all(sizes.map(([w, h, quality]) => new Promise<string>((resolve, reject) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d')!;
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(src, 0, 0, w, h);
        c.toBlob(async b => { if (!b) return reject(new Error('encode failed')); resolve(toBase64(new Uint8Array(await b.arrayBuffer()))); }, 'image/webp', quality);
      })));
    }

    /** The background is never pure black, so a black corner means the frame failed. */
    function blank() {
      const c = document.createElement('canvas'); c.width = c.height = 4;
      const g = c.getContext('2d')!; g.drawImage(gl.domElement, 0, 0, 4, 4);
      const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
      return r + gg + b === 0;
    }

    function idPass(w: number, h: number) {
      const rt = new THREE.WebGLRenderTarget(w, h, { samples: 0, type: THREE.UnsignedByteType, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      const prev = { target: gl.getRenderTarget(), autoClear: gl.autoClear, color: gl.getClearColor(new THREE.Color()), alpha: gl.getClearAlpha() };
      const c = cam.clone(); c.aspect = w / h; c.updateProjectionMatrix();
      gl.setRenderTarget(rt); gl.autoClear = false; gl.setClearColor(0x000000, 1); gl.clear(true, true, true);
      for (const layer of [0, 1, 2]) {
        for (const m of idMeshes) m.mesh.visible = m.layer === layer;
        gl.render(idScene, c); gl.clearDepth();
      }
      const px = new Uint8Array(w * h * 4);
      gl.readRenderTargetPixels(rt, 0, 0, w, h, px);
      gl.setRenderTarget(prev.target); gl.autoClear = prev.autoClear; gl.setClearColor(prev.color, prev.alpha);
      rt.dispose();
      const lookup = new Map(PALETTE.map(([r, g, b], i) => [(r << 16) | (g << 8) | b, i]));
      const idx = new Uint8Array(w * h);
      const box = PALETTE.map(() => [w, h, -1, -1]);
      let stray = 0;
      for (let y = 0; y < h; y++) {
        const row = (h - 1 - y) * w; // GL rows run bottom-up
        for (let x = 0; x < w; x++) {
          const o = (row + x) * 4;
          const i = lookup.get((px[o] << 16) | (px[o + 1] << 8) | px[o + 2]);
          if (i === undefined) { stray++; continue; }
          idx[y * w + x] = i;
          if (i) { const b = box[i]; if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
        }
      }
      if (stray) console.warn(`id map: ${stray} pixels did not match the palette`);
      const boxes: Record<string, [number, number, number, number]> = {};
      box.forEach((b, i) => { if (i && b[2] >= 0) boxes[ID_ORGANS[i - 1]] = [r4(b[0] / w), r4(b[1] / h), r4((b[2] + 1) / w), r4((b[3] + 1) / h)]; });
      return { width: w, height: h, data: toBase64(idx), boxes };
    }

    const api = {
      // the ID colours are shared by both bodies; `present` lists the organs this body has (the male has no breasts)
      palette: () => ({ organs: ID_ORGANS, colors: PALETTE, present: ID_ORGANS.filter(id => organsIn(BODY_ID).has(id)) }),
      framing: () => ({ fov: FOV, body: { target: BODY.target.toArray(), distance: BODY.distance, elevation: BODY.elevation } }),
      body: () => BODY_ID,
      async shot(view: View, opts: ShotOptions): Promise<Shot> {
        useHealth.setState({ selectedOrgan: view.kind === 'organ' ? view.organ : null });
        await new Promise(r => setTimeout(r, 50)); // React commits; Anatomy applies the focus materials
        place(view);
        invalidate();
        await nextFrames(2);
        // N8AO occasionally fills a view with NaN (a black frame, e.g. the brain close-up): render that one without it.
        if (ao && blank()) {
          console.info(`no ambient occlusion for ${view.kind === 'organ' ? view.organ : `${view.deg}°`}`);
          setAo(false); await new Promise(r => setTimeout(r, 100)); invalidate(); await nextFrames(2);
        }
        const out: Shot = { images: await encode(opts.sizes), background: background(), camera: { position: cam.position.toArray() as P3, target: target.toArray() as P3 } };
        if (ao) { setAo(true); await new Promise(r => setTimeout(r, 50)); }
        if (view.kind === 'body') {
          out.pins = Object.fromEntries(ORGANS.flatMap(o => { const p = o.id !== 'skin' && pinOf(BODY_ID, o.id); return p ? [[o.id, project(p)]] : []; }));
          if (opts.id) { const { boxes, ...id } = idPass(...opts.id); out.id = id; out.boxes = boxes; }
        } else {
          const marks = landmarksOf(BODY_ID, view.organ);
          out.landmarks = marks.map(l => project(l.at)); out.names = marks.map(l => l.name);
        }
        return out;
      },
    };
    (window as unknown as { __bodymap: typeof api }).__bodymap = api;
  }, [gl, camera, invalidate, setAo]);
  return null;
}

/** `flat`: no renderer tone mapping; the composer's ToneMapping pass does it. */
export function RenderScene() {
  const [aoOn, setAo] = useState(ao);
  return (
    <Canvas flat frameloop="demand" dpr={1} camera={{ fov: FOV, near: 0.02, far: 40 }} gl={{ preserveDrawingBuffer: true, antialias: false }}>
      <color attach="background" args={[POND]} />
      <fog attach="fog" args={[POND, 3.2 * FOG, 7.5 * FOG]} />
      <StudioLight />
      <Suspense fallback={null}>
        <Anatomy body={BODY_ID} tier="physical" depth />
        <Bridge setAo={setAo} />
      </Suspense>
      <EffectComposer multisampling={4} enableNormalPass={false}>
        {aoOn && <N8AO aoRadius={0.05} distanceFalloff={0.6} intensity={2.4} quality="high" color="#06181b" />}
        {bloom && <Bloom mipmapBlur intensity={0.28} luminanceThreshold={0.86} luminanceSmoothing={0.2} />}
        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
        <SMAA />
      </EffectComposer>
    </Canvas>
  );
}
