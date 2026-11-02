import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { ORGANS, TISSUE, MESH_TO_ORGAN, ORGAN_BY_ID, type MeshSpec, type Tissue } from '../anatomy/organs';
import type { OrganId, SystemId } from '../types';
import { useUI } from '../state/ui';
import { useHealth } from '../lib/store';
import { BIOMARKERS } from '../lib/catalog';

export const MODEL_URL = `${import.meta.env.BASE_URL}models/anatomy.glb`;

/** Shared lookup so the camera rig can frame meshes by name. */
export const meshRegistry = new Map<string, THREE.Mesh>();

const ghostVS = /* glsl */ `
  varying vec3 vN; varying vec3 vV;
  void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`;
const ghostFS = /* glsl */ `
  uniform vec3 uColor; uniform float uStrength; uniform float uBase;
  varying vec3 vN; varying vec3 vV;
  void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4); float a = (uBase + f) * uStrength; gl_FragColor = vec4(uColor * a, a); }`;

function ghost(color: string, strength: number, base = 0.03) {
  return new THREE.ShaderMaterial({
    vertexShader: ghostVS, fragmentShader: ghostFS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength }, uBase: { value: base } },
  });
}

function physical(t: Tissue, inner = false) {
  const d = TISSUE[t];
  const m = new THREE.MeshPhysicalMaterial({
    color: inner ? d.inner ?? d.color : d.color, roughness: inner ? 0.8 : d.rough, clearcoat: inner ? 0.1 : d.clear, clearcoatRoughness: 0.32,
    sheen: d.sheen && !inner ? 0.55 : 0, sheenColor: new THREE.Color(d.sheen ?? '#ffffff'), sheenRoughness: 0.55,
    side: inner ? THREE.BackSide : THREE.FrontSide, envMapIntensity: 0.9,
  });
  if (d.opacity) { m.transparent = true; m.opacity = inner ? d.opacity * 0.55 : d.opacity; m.depthWrite = false; }
  return m;
}

interface Part {
  mesh: THREE.Mesh; organ: OrganId; spec: MeshSpec;
  solid: THREE.MeshPhysicalMaterial; inner?: THREE.Mesh; glass: THREE.MeshPhysicalMaterial;
  base: THREE.Color; dimmed: THREE.Color; dim: number; dimT: number; baseOpacity: number;
}

const organSystems = (() => {
  const map: Record<string, Set<SystemId>> = {};
  for (const o of ORGANS) map[o.id] = new Set(o.systems);
  for (const b of BIOMARKERS) for (const o of b.organs) (map[o] ??= new Set()).add(b.system);
  return map as Record<OrganId, Set<SystemId>>;
})();

export function Anatomy() {
  const { scene } = useGLTF(MODEL_URL, false, true);
  const { gl, invalidate } = useThree();
  const selected = useHealth(s => s.selectedOrgan);
  const activeSystem = useHealth(s => s.activeSystem);
  const selectOrgan = useHealth(s => s.selectOrgan);
  const { hovered, setHovered, layers, xray, section } = useUI();
  const animating = useRef(true);

  const skinGhost = useMemo(() => ghost('#8fd3dc', 0.32, 0.022), []);
  const boneGhost = useMemo(() => ghost('#efe6d2', 0.30, 0.05), []);
  const contextGhost = useMemo(() => ghost('#9fd6dd', 0.20, 0.015), []);
  const clipPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), []);

  const parts = useMemo(() => {
    const list: Part[] = [];
    scene.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const organ = MESH_TO_ORGAN[mesh.name];
      if (!organ) return;
      const spec = ORGAN_BY_ID[organ].meshes.find(m => m.id === mesh.name)!;
      meshRegistry.set(mesh.name, mesh);
      mesh.geometry.computeBoundingSphere(); mesh.geometry.computeBoundingBox();
      if (organ === 'skin') { mesh.material = skinGhost; mesh.raycast = () => {}; mesh.renderOrder = 10; return; }
      const solid = physical(spec.tissue);
      const glass = physical(spec.tissue); glass.transparent = true; glass.opacity = 0.2; glass.depthWrite = false;
      mesh.material = solid;
      let inner: THREE.Mesh | undefined;
      if (spec.hollow || (TISSUE[spec.tissue].opacity && spec.tissue !== 'diaphragm')) {
        inner = new THREE.Mesh(mesh.geometry, physical(spec.tissue, true));
        inner.raycast = () => {}; inner.renderOrder = TISSUE[spec.tissue].opacity ? 1 : 0;
        mesh.add(inner);
      }
      if (TISSUE[spec.tissue].opacity) mesh.renderOrder = 2;
      const base = solid.color.clone();
      const hsl = { h: 0, s: 0, l: 0 }; base.getHSL(hsl);
      const dimmed = new THREE.Color().setHSL(hsl.h, hsl.s * 0.18, Math.min(hsl.l, 0.5) * 0.42);
      list.push({ mesh, organ, spec, solid, inner, glass, base, dimmed, dim: 0, dimT: 0, baseOpacity: solid.opacity });
    });
    return list;
  }, [scene, skinGhost]);

  useEffect(() => { gl.localClippingEnabled = true; }, [gl]);

  // Apply state: focus, system highlight, x-ray, layers, cross-section.
  useEffect(() => {
    const focus = selected && selected !== 'skin' ? selected : null;
    const bonesSolid = focus === 'marrow' || (!focus && activeSystem === 'blood');
    let box: THREE.Box3 | null = null;
    if (focus) {
      box = new THREE.Box3();
      for (const id of ORGAN_BY_ID[focus].focus) { const m = meshRegistry.get(id); if (m) box.union(new THREE.Box3().setFromObject(m)); }
    }
    for (const p of parts) {
      const isFocus = focus === p.organ;
      const isBone = p.organ === 'marrow';
      p.mesh.visible = !(isBone && !layers.skeleton);
      let mat: THREE.Material = p.solid;
      if (focus && !isFocus) mat = isBone ? boneGhost : contextGhost;
      else if (isBone && !bonesSolid) mat = boneGhost;
      else if (isFocus && xray && p.spec.shell) mat = p.glass;
      p.mesh.material = mat;
      if (p.inner) p.inner.visible = mat === p.solid;
      p.mesh.castShadow = false;
      const clip = isFocus && section.on && box && (p.spec.hollow || p.spec.shell) ? [clipPlane] : [];
      p.solid.clippingPlanes = clip; p.glass.clippingPlanes = clip;
      if (p.inner) (p.inner.material as THREE.Material).clippingPlanes = clip;
      p.dimT = !focus && activeSystem && !organSystems[p.organ]?.has(activeSystem) ? 1 : 0;
    }
    const skin = meshRegistry.get('skin'); if (skin) skin.visible = layers.skin && !focus;
    if (box && section.on) {
      const t = section.depth;
      if (section.axis === 'coronal') { clipPlane.normal.set(0, 0, -1); clipPlane.constant = THREE.MathUtils.lerp(box.max.z, box.min.z, t); }
      else if (section.axis === 'sagittal') { const sgn = focus === 'liver' ? 1 : -1; clipPlane.normal.set(sgn, 0, 0); clipPlane.constant = sgn > 0 ? -THREE.MathUtils.lerp(box.min.x, box.max.x, t) : THREE.MathUtils.lerp(box.max.x, box.min.x, t); }
      else { clipPlane.normal.set(0, -1, 0); clipPlane.constant = THREE.MathUtils.lerp(box.max.y, box.min.y, t); }
    }
    animating.current = true; invalidate();
  }, [parts, selected, activeSystem, xray, layers, section, boneGhost, contextGhost, clipPlane, invalidate]);

  useEffect(() => { animating.current = true; invalidate(); }, [hovered, invalidate]);

  useFrame((_, dt) => {
    if (!animating.current) return;
    let busy = false;
    const k = 1 - Math.pow(0.0004, Math.min(dt, 0.05));
    for (const p of parts) {
      p.dim += (p.dimT - p.dim) * k;
      if (Math.abs(p.dim - p.dimT) > 0.003) busy = true; else p.dim = p.dimT;
      p.solid.color.copy(p.base).lerp(p.dimmed, p.dim);
      const hot = hovered === p.organ && p.mesh.material === p.solid;
      p.solid.emissive.set(hot ? '#3b1a22' : '#000000');
      p.solid.envMapIntensity = 0.9 - 0.6 * p.dim;
      if (p.baseOpacity < 1) p.solid.opacity = p.baseOpacity * (1 - 0.45 * p.dim);
    }
    animating.current = busy;
    if (busy) invalidate();
  });

  const pick = (e: ThreeEvent<PointerEvent | MouseEvent>): OrganId | null => {
    const hits = e.intersections.filter(h => (h.object as THREE.Mesh).isMesh && MESH_TO_ORGAN[h.object.name] && h.object.visible);
    const rank = (h: THREE.Intersection) => {
      const mat = (h.object as THREE.Mesh).material as THREE.Material;
      if (mat === boneGhost || mat === contextGhost) return 3;
      return mat.transparent ? 2 : 1;
    };
    hits.sort((a, b) => rank(a) - rank(b) || a.distance - b.distance);
    return hits.length ? MESH_TO_ORGAN[hits[0].object.name] : null;
  };

  return (
    <primitive
      object={scene}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); const o = pick(e); if (o !== hovered) setHovered(o); document.body.style.cursor = o ? 'pointer' : ''; }}
      onPointerOut={() => { setHovered(null); document.body.style.cursor = ''; }}
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); if (e.delta > 6) return; const o = pick(e); if (o) selectOrgan(o); }}
    />
  );
}

useGLTF.preload(MODEL_URL, false, true);
