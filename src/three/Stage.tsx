import { Suspense, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { Bvh, CameraControls, Html, MeshReflectorMaterial } from '@react-three/drei';
import { EffectComposer, N8AO, Bloom, Vignette, ToneMapping, SMAA } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Anatomy, meshRegistry } from './Anatomy';
import { ORGANS, ORGAN_BY_ID } from '../anatomy/organs';
import { useUI } from '../state/ui';
import { useHealth, organSummary } from '../lib/store';
import type { OrganId } from '../types';

const POND = '#0c2528';
const HOME = { pos: new THREE.Vector3(0.62, 1.24, 2.95), target: new THREE.Vector3(0, 1.04, 0) };

function StudioLight() {
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

function Pond({ quality }: { quality: 'high' | 'fast' }) {
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.001}>
        <circleGeometry args={[5, 96]} />
        {quality === 'high' ? (
          <MeshReflectorMaterial blur={[360, 120]} resolution={1024} mixBlur={0.9} mixStrength={1.6} roughness={1} depthScale={0.6}
            minDepthThreshold={0.3} maxDepthThreshold={1.2} color="#071c1f" metalness={0.15} mirror={0.4} />
        ) : <meshStandardMaterial color="#071c1f" roughness={0.9} metalness={0} />}
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
    if (!selected || selected === 'skin') { c.setLookAt(...HOME.pos.toArray(), ...HOME.target.toArray(), true); return; }
    const o = ORGAN_BY_ID[selected];
    const box = boxOf(o.focus); if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3());
    let dir = new THREE.Vector3(...o.view);
    if (section.on) dir = section.axis === 'coronal' ? new THREE.Vector3(0.05, 0.08, 1) : section.axis === 'transverse' ? new THREE.Vector3(0.05, 1, 0.35) : new THREE.Vector3(selected === 'liver' ? -1 : 1, 0.08, 0.05);
    dir.normalize();
    const radius = Math.max(size.x, size.y, size.z) * 0.62;
    const dist = Math.max(0.2, radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.6);
    c.setLookAt(center.x + dir.x * dist, center.y + dir.y * dist, center.z + dir.z * dist, center.x, center.y, center.z, true);
  }, [selected, section.on, section.axis, camera]);
  return <CameraControls ref={ref} makeDefault smoothTime={0.55} minDistance={0.12} maxDistance={6.5} dollyToCursor maxPolarAngle={Math.PI * 0.62} />;
}

const STATUS_COLOR = { none: '#7f9b98', ok: '#5fbf95', out: '#e9b949', focus: '#e2869e' };

function Pins() {
  const { layers, hovered, setHovered } = useUI();
  const measurements = useHealth(s => s.measurements);
  const selected = useHealth(s => s.selectedOrgan);
  const selectOrgan = useHealth(s => s.selectOrgan);
  const summary = useMemo(() => organSummary(measurements), [measurements]);
  const hidden = !layers.labels || (selected && selected !== 'skin');
  return (
    <>
      {ORGANS.filter(o => o.id !== 'skin' && o.id !== 'airway' && o.id !== 'esophagus').map(o => {
        const s = summary[o.id as OrganId];
        const state = !s || s.total === 0 ? 'none' : s.out > 0 ? 'out' : 'ok';
        const showLabel = hovered === o.id || state === 'out';
        return (
          <Html key={o.id} position={o.pin} center zIndexRange={[20, 0]} style={{ display: hidden ? 'none' : undefined }}>
            <button className={`pin pin--${state}${hovered === o.id ? ' is-hot' : ''}`} style={{ ['--pin' as string]: STATUS_COLOR[state] }}
              onClick={() => selectOrgan(o.id)} onPointerEnter={() => setHovered(o.id)} onPointerLeave={() => setHovered(null)}
              aria-label={`${o.name}${s?.total ? `, ${s.total} results, ${s.out} outside range` : ''}`}>
              <span className="pin__dot" />
              {showLabel && <span className="pin__label">{o.short}{s?.out ? <em>{s.out}</em> : null}</span>}
            </button>
          </Html>
        );
      })}
    </>
  );
}

function Landmarks() {
  const selected = useHealth(s => s.selectedOrgan);
  const layers = useUI(s => s.layers);
  return (
    <>
      {ORGANS.flatMap(o => o.landmarks.map(l => ({ o, l }))).map(({ o, l }) => (
        <Html key={o.id + l.name} position={l.at} zIndexRange={[20, 0]} className="lm-wrap" style={{ display: selected === o.id && layers.labels ? undefined : 'none' }}>
          <div className="landmark" tabIndex={0}>
            <span className="landmark__dot" />
            <span className="landmark__name">{l.name}</span>
            <span className="landmark__note">{l.note}</span>
          </div>
        </Html>
      ))}
    </>
  );
}

function Loader() {
  return <Html center><div className="stage-loading">Loading the 3D model…</div></Html>;
}

function ToneFix({ quality }: { quality: 'high' | 'fast' }) {
  const gl = useThree(s => s.gl); const invalidate = useThree(s => s.invalidate);
  useEffect(() => { gl.toneMapping = quality === 'high' ? THREE.NoToneMapping : THREE.NeutralToneMapping; gl.toneMappingExposure = 1.05; invalidate(); }, [gl, quality, invalidate]);
  return null;
}

export default function Stage() {
  const quality = useUI(s => s.quality);
  const selectOrgan = useHealth(s => s.selectOrgan);
  return (
    <Canvas className="stage-canvas" frameloop="demand" dpr={[1, 2]} camera={{ fov: 30, near: 0.02, far: 40, position: HOME.pos.toArray() }}
      gl={{ antialias: quality === 'fast', powerPreference: 'high-performance' }} onPointerMissed={(e) => { if (e.type === 'dblclick') selectOrgan(null); }}>
      <color attach="background" args={[POND]} />
      <fog attach="fog" args={[POND, 3.2, 7.5]} />
      <ToneFix quality={quality} />
      <StudioLight />
      <Suspense fallback={<Loader />}>
        <Bvh firstHitOnly={false}>
          <Anatomy />
        </Bvh>
        <Pins />
        <Landmarks />
      </Suspense>
      <Pond quality={quality} />
      <CameraRig />
      {quality === 'high' && (
        <EffectComposer multisampling={0} enableNormalPass={false}>
          <N8AO aoRadius={0.05} distanceFalloff={0.6} intensity={2.4} quality="medium" halfRes color="#06181b" />
          <Bloom mipmapBlur intensity={0.28} luminanceThreshold={0.86} luminanceSmoothing={0.2} />
          <Vignette offset={0.28} darkness={0.5} />
          <ToneMapping mode={ToneMappingMode.NEUTRAL} />
          <SMAA />
        </EffectComposer>
      )}
    </Canvas>
  );
}
