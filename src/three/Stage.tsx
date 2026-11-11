import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bvh, CameraControls, Html, MeshReflectorMaterial } from '@react-three/drei';
import { EffectComposer, Bloom, ToneMapping, SMAA } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Anatomy, meshRegistry } from './Anatomy';
import { AdaptiveQuality } from './AdaptiveQuality';
import { ORGAN_BY_ID } from '../anatomy/organs';
import { useUI } from '../state/ui';
import { useHealth, organSummary } from '../lib/store';
import { useStage, type Tier } from '../components/stage/stageSettings';
import { PINNED, STATUS_COLOR, pinLabel, pinState } from '../components/stage/status';
import { ISSUE_COLOR, pinIssueClass, useIssues } from '../components/stage/issues';
import type { OrganId } from '../types';

export const POND = '#0c2528';
const HOME = { pos: new THREE.Vector3(0.62, 1.24, 2.95), target: new THREE.Vector3(0, 1.04, 0) };

/** Pixel-ratio cap per tier. Above 1.5 the cost grows faster than anyone can see. */
const DPR_CAP: Record<Tier, number> = { 0: 1, 1: 1.25, 2: 1.5, 3: 1.5 };

export function StudioLight() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env; scene.environmentIntensity = 0.55;
    return () => { scene.environment = null; env.dispose(); pm.dispose(); };
  }, [gl, scene]);
  return (
    <>
      <hemisphereLight args={['#dff3f1', '#0b2326', 0.55]} />
      <directionalLight position={[1.6, 3.2, 2.4]} intensity={2.1} color="#fff4ea" />
      <directionalLight position={[-2.2, 1.6, -1.8]} intensity={1.3} color="#f2a1b8" />
      <directionalLight position={[2.4, 0.6, -2.0]} intensity={0.8} color="#7fd6d0" />
    </>
  );
}

/** Unlit pond floor: a soft radial gradient instead of a live reflection (one draw, no extra render pass). */
function useFloorTexture() {
  const tex = useMemo(() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, '#12383b'); grad.addColorStop(0.18, '#0d2d30'); grad.addColorStop(0.55, '#0a2225'); grad.addColorStop(1, '#0c2528');
    g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

function Pond({ reflective, resolution = 512 }: { reflective: boolean; resolution?: number }) {
  const floor = useFloorTexture();
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.001}>
        <circleGeometry args={[5, 96]} />
        {reflective ? (
          <MeshReflectorMaterial blur={[360, 120]} resolution={resolution} mixBlur={0.9} mixStrength={1.6} roughness={1} depthScale={0.6}
            minDepthThreshold={0.3} maxDepthThreshold={1.2} color="#071c1f" metalness={0.15} mirror={0.4} />
        ) : <meshBasicMaterial map={floor} />}
      </mesh>
      {[0.34, 0.52, 0.78].map((r, i) => (
        <mesh key={r} rotation-x={-Math.PI / 2} position-y={0.002}>
          <ringGeometry args={[r, r + 0.004, 128]} />
          <meshBasicMaterial color="#e2869e" transparent opacity={0.22 - i * 0.06} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function boxOf(ids: string[]) {
  const box = new THREE.Box3();
  for (const id of ids) { const m = meshRegistry.get(id); if (m) box.union(new THREE.Box3().setFromObject(m)); }
  return box;
}

function CameraRig() {
  const ref = useRef<CameraControls>(null);
  const selected = useHealth(s => s.selectedOrgan);
  const section = useUI(s => s.section);
  const camera = useThree(s => s.camera) as THREE.PerspectiveCamera;
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const fly = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!selected || selected === 'skin') { c.setLookAt(...HOME.pos.toArray(), ...HOME.target.toArray(), fly); return; }
    const o = ORGAN_BY_ID[selected];
    const box = boxOf(o.focus); if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3());
    let dir = new THREE.Vector3(...o.view);
    if (section.on) dir = section.axis === 'coronal' ? new THREE.Vector3(0.05, 0.08, 1) : section.axis === 'transverse' ? new THREE.Vector3(0.05, 1, 0.35) : new THREE.Vector3(selected === 'liver' ? -1 : 1, 0.08, 0.05);
    dir.normalize();
    const radius = Math.max(size.x, size.y, size.z) * 0.62;
    const dist = Math.max(0.2, radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.6);
    c.setLookAt(center.x + dir.x * dist, center.y + dir.y * dist, center.z + dir.z * dist, center.x, center.y, center.z, fly);
  }, [selected, section.on, section.axis, camera]);
  return <CameraControls ref={ref} makeDefault smoothTime={0.55} minDistance={0.12} maxDistance={6.5} dollyToCursor maxPolarAngle={Math.PI * 0.62} />;
}

/** Container for the HTML labels. drei's <Html> otherwise attaches labels to R3F's event element, which changes while
 *  the canvas unmounts (for example on sign-out); each label then mounts a second React root on the same node and
 *  the final teardown throws "removeChild … not a child of this node". A stable container avoids that. */
type Portal = RefObject<HTMLElement>;

function Pins({ portal }: { portal: Portal }) {
  const { layers, hovered, setHovered } = useUI();
  const measurements = useHealth(s => s.measurements);
  const selected = useHealth(s => s.selectedOrgan);
  const selectOrgan = useHealth(s => s.selectOrgan);
  const summary = useMemo(() => organSummary(measurements), [measurements]);
  const issues = useIssues().organs;
  // Each <Html> re-projects itself every frame, so hidden pins are unmounted rather than hidden.
  if (!layers.labels || (selected && selected !== 'skin')) return null;
  return (
    <>
      {PINNED.map(o => {
        const s = summary[o.id as OrganId];
        const state = pinState(s);
        const showLabel = hovered === o.id || state === 'out';
        return (
          <Html key={o.id} portal={portal} position={o.pin} center zIndexRange={[20, 0]}>
            <button className={`pin pin--${state}${hovered === o.id ? ' is-hot' : ''}${pinIssueClass(issues, o.id)}`} style={{ ['--pin' as string]: issues[o.id] ? ISSUE_COLOR[issues[o.id]!] : STATUS_COLOR[state] }}
              onClick={() => selectOrgan(o.id)} onPointerEnter={() => setHovered(o.id)} onPointerLeave={() => setHovered(null)}
              aria-label={pinLabel(o.name, s)}>
              <span className="pin__dot" />
              {showLabel && <span className="pin__label">{o.short}{s?.out ? <em>{s.out}</em> : null}</span>}
            </button>
          </Html>
        );
      })}
    </>
  );
}

/** Landmark labels of the open organ only (all of them mounted at once cost a projection each per frame). */
function Landmarks({ portal }: { portal: Portal }) {
  const selected = useHealth(s => s.selectedOrgan);
  const labels = useUI(s => s.layers.labels);
  // Notes open on hover / keyboard focus, and on tap for touch screens (no hover there).
  const [open, setOpen] = useState<string | null>(null);
  if (!selected || !labels) return null;
  const o = ORGAN_BY_ID[selected];
  const toggle = (key: string) => setOpen(v => (v === key ? null : key));
  return (
    <>
      {o.landmarks.map(l => (
        <Html key={o.id + l.name} portal={portal} position={l.at} zIndexRange={[20, 0]} className="lm-wrap">
          <div className={`landmark${open === o.id + l.name ? ' is-open' : ''}`} tabIndex={0} role="button" aria-expanded={open === o.id + l.name}
            onClick={() => toggle(o.id + l.name)} onKeyDown={e => e.key === 'Enter' && toggle(o.id + l.name)}>
            <span className="landmark__dot" />
            <span className="landmark__name">{l.name}</span>
            <span className="landmark__note">{l.note}</span>
          </div>
        </Html>
      ))}
    </>
  );
}

/**
 * Fit the scene into the part of the canvas the phone bottom sheet leaves visible. The camera's field of view
 * is mapped onto that visible strip (camera.setViewOffset with a frame shorter than the canvas), so framing
 * and centring work as if the canvas ended at the sheet. The camera is managed here (aspect included).
 */
function ViewInset() {
  const inset = useUI(s => s.stageInset);
  const size = useThree(s => s.size);
  const invalidate = useThree(s => s.invalidate);
  const get = useThree(s => s.get);
  const current = useRef(0);
  const apply = useCallback((px: number) => {
    const { camera, size: { width: w, height: h } } = get();
    if (!w || !h || !(camera instanceof THREE.PerspectiveCamera)) return;
    const visible = h - px;
    camera.aspect = w / visible;
    if (px > 0.5) camera.setViewOffset(w, visible, 0, 0, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }, [get]);
  useEffect(() => {
    const camera = get().camera as THREE.Camera & { manual?: boolean };
    camera.manual = true;
    return () => { camera.manual = false; apply(0); };
  }, [get, apply]);
  useEffect(() => { apply(current.current); invalidate(); }, [size, apply, invalidate]);
  useEffect(() => invalidate(), [inset, invalidate]);
  useFrame((_, dt) => {
    const target = Math.min(inset, size.height * 0.6);
    if (Math.abs(target - current.current) < 0.5) return;
    current.current += (target - current.current) * (1 - Math.pow(0.0005, Math.min(dt, 0.05)));
    if (Math.abs(target - current.current) < 0.5) current.current = target;
    apply(current.current);
    invalidate();
  });
  return null;
}

function Loader({ portal }: { portal: Portal }) {
  return <Html portal={portal} center><div className="stage-loading">Loading the 3D model…</div></Html>;
}

function ToneFix({ composer }: { composer: boolean }) {
  const gl = useThree(s => s.gl); const invalidate = useThree(s => s.invalidate);
  useEffect(() => { gl.toneMapping = composer ? THREE.NoToneMapping : THREE.NeutralToneMapping; gl.toneMappingExposure = 1.05; invalidate(); }, [gl, composer, invalidate]);
  return null;
}

/** Studio effects. N8AO was dropped: its render-target shim throws on every frame with three r187. */
function StudioEffects() {
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <Bloom mipmapBlur intensity={0.28} luminanceThreshold={0.86} luminanceSmoothing={0.2} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <SMAA />
    </EffectComposer>
  );
}

/** Draw one fresh frame whenever the stage comes back into view (and drop a pointer cursor left by a hover). */
function Resume({ active }: { active: boolean }) {
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => { if (active) invalidate(); else document.body.style.cursor = ''; }, [active, invalidate]);
  return null;
}

/**
 * The interactive 3D stage. `active` is false while the stage is hidden (2D mode, another page, signed out, background
 * tab or scrolled away): the canvas then stops rendering altogether.
 */
export default function Stage({ active = true }: { active?: boolean }) {
  const tier = useStage(s => s.tier);
  const selectOrgan = useHealth(s => s.selectOrgan);
  const labelLayer = useRef<HTMLDivElement>(null);
  const labels = labelLayer as Portal;
  const screenDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const dpr = Math.min(screenDpr, DPR_CAP[tier]);
  // Multisampling costs the most where it helps the least: on high-density screens edges are already fine at the
  // capped pixel ratio. (A context attribute, fixed when the canvas is created.)
  const msaa = screenDpr < 1.5;
  const studio = tier === 3;
  return (
    <>
    <Canvas className="stage-canvas" frameloop={active ? 'demand' : 'never'} dpr={dpr} camera={{ fov: 30, near: 0.02, far: 40, position: HOME.pos.toArray() }}
      gl={{ antialias: msaa, powerPreference: 'high-performance' }} onPointerMissed={(e) => { if (e.type === 'dblclick') selectOrgan(null); }}>
      <color attach="background" args={[POND]} />
      <fog attach="fog" args={[POND, 3.2, 7.5]} />
      <ToneFix composer={studio} />
      <StudioLight />
      <Suspense fallback={<Loader portal={labels} />}>
        <Bvh firstHitOnly={false}>
          <Anatomy tier={tier >= 2 ? 'physical' : 'standard'} depth={tier >= 1} />
        </Bvh>
        <Pins portal={labels} />
        <Landmarks portal={labels} />
        <AdaptiveQuality active={active} />
      </Suspense>
      <Pond reflective={studio} />
      <ViewInset />
      <CameraRig />
      <Resume active={active} />
      {studio && <StudioEffects />}
    </Canvas>
    <div ref={labelLayer} className="stage-labels" />
    </>
  );
}
