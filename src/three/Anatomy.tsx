import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useAnatomyModel } from './model';
import { TISSUE, organOrNull } from '../anatomy/organs';
import { focusOf, meshSpecs, type MeshSpec } from '../anatomy/bodies';
import { GHOSTS, tissueMaterial, type MaterialTier, type TissueMaterial } from './materials';
import type { OrganId } from '../types';
import type { Body } from '../lib/body';
import { useUI } from '../state/ui';
import { useHealth } from '../lib/store';
import { meshOrgan, meshRegistry } from './registry';
import { ORGAN_SYSTEMS } from '../components/stage/status';

interface MaterialSet { solid: TissueMaterial; glass: TissueMaterial; inner?: TissueMaterial }

interface Part {
  mesh: THREE.Mesh; organ: OrganId; spec: MeshSpec;
  sets: Record<MaterialTier, MaterialSet>;
  /** Materials of the current tier. */
  solid: TissueMaterial; glass: TissueMaterial;
  /** Back faces drawn as cut tissue. Only shown when they can be seen: in a cross-section, or through see-through tissue. */
  inner?: THREE.Mesh; seeThrough: boolean;
  base: THREE.Color; dimmed: THREE.Color; dim: number; dimT: number; baseOpacity: number;
}

function materialSet(spec: MeshSpec, tier: MaterialTier, inner: boolean): MaterialSet {
  const solid = tissueMaterial(spec.tissue, tier, false, spec.double);
  const glass = tissueMaterial(spec.tissue, tier, false, spec.double); glass.transparent = true; glass.opacity = 0.2; glass.depthWrite = false;
  return { solid, glass, inner: inner ? tissueMaterial(spec.tissue, tier, true) : undefined };
}

export interface AnatomyProps {
  /** Which body model to show. */
  body: Body;
  /** Physical (clearcoat, sheen) or standard materials. */
  tier?: MaterialTier;
  /** Draw the inside of see-through tissue (lungs) as a second layer. Off on the cheapest tiers. */
  depth?: boolean;
}

export function Anatomy({ body, tier = 'physical', depth = true }: AnatomyProps) {
  const { scene } = useAnatomyModel(body);
  const { gl, invalidate } = useThree();
  const selected = useHealth(s => s.selectedOrgan);
  const activeSystem = useHealth(s => s.activeSystem);
  const selectOrgan = useHealth(s => s.selectOrgan);
  const { hovered, setHovered, layers, xray, section } = useUI();
  const animating = useRef(true);

  const skinGhost = useMemo(() => GHOSTS.skin(), []);
  const boneGhost = useMemo(() => GHOSTS.bone(), []);
  const contextGhost = useMemo(() => GHOSTS.context(), []);
  const clipPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), []);

  const parts = useMemo(() => {
    const list: Part[] = [];
    const specs = meshSpecs(body);
    // this model replaces whatever was on stage before
    meshRegistry.clear(); meshOrgan.clear();
    const stale: THREE.Object3D[] = [];
    scene.traverse(o => { if (o.userData.lpInner) stale.push(o); });
    for (const o of stale) o.removeFromParent();
    // collect first: the loop below adds inner-layer children, which a running traverse would visit too
    const meshes: THREE.Mesh[] = [];
    scene.traverse(obj => { if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh); });
    for (const mesh of meshes) {
      const spec = specs.get(mesh.name);
      if (!spec) { mesh.visible = false; console.warn(`anatomy: no part named ${mesh.name} in the ${body} body`); continue; }
      const organ = spec.organ;
      meshRegistry.set(mesh.name, mesh); meshOrgan.set(mesh.name, organ);
      mesh.geometry.computeBoundingSphere(); mesh.geometry.computeBoundingBox();
      if (organ === 'skin') { mesh.material = skinGhost; mesh.raycast = () => {}; mesh.renderOrder = 10; continue; }
      const seeThrough = !!TISSUE[spec.tissue].opacity;
      const hasInner = spec.inner;
      const sets = { physical: materialSet(spec, 'physical', hasInner), standard: materialSet(spec, 'standard', hasInner) };
      const { solid, glass } = sets.physical;
      mesh.material = solid;
      let inner: THREE.Mesh | undefined;
      if (hasInner) {
        inner = new THREE.Mesh(mesh.geometry, sets.physical.inner);
        inner.raycast = () => {}; inner.renderOrder = seeThrough ? 1 : 0; inner.visible = false; inner.userData.lpInner = true;
        mesh.add(inner);
      }
      if (seeThrough) mesh.renderOrder = 2;
      const base = solid.color.clone();
      const hsl = { h: 0, s: 0, l: 0 }; base.getHSL(hsl);
      const dimmed = new THREE.Color().setHSL(hsl.h, hsl.s * 0.18, Math.min(hsl.l, 0.5) * 0.42);
      list.push({ mesh, organ, spec, sets, solid, glass, inner, seeThrough, base, dimmed, dim: 0, dimT: 0, baseOpacity: solid.opacity });
    }
    return list;
  }, [scene, skinGhost, body]);

  useEffect(() => { gl.localClippingEnabled = true; }, [gl]);

  // Release GPU programs, materials and vertex buffers when this body leaves the stage (another body, or teardown). The
  // parsed model stays cached, so showing this body again only uploads its buffers again.
  useEffect(() => () => {
    for (const p of parts) for (const set of Object.values(p.sets)) { set.solid.dispose(); set.glass.dispose(); set.inner?.dispose(); }
    scene.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
  }, [parts, scene]);

  // Apply state: material tier (the adaptive quality monitor may change it), focus, system highlight, x-ray, layers, cross-section.
  useEffect(() => {
    for (const p of parts) {
      const set = p.sets[tier];
      p.solid = set.solid; p.glass = set.glass;
      if (p.inner && set.inner) p.inner.material = set.inner;
    }
    // an organ id this version does not know (a scan saved by a newer app) shows the whole body, as the panels do
    const focus = selected && selected !== 'skin' && organOrNull(selected) ? selected : null;
    const bonesSolid = focus === 'marrow' || (!focus && activeSystem === 'blood');
    let box: THREE.Box3 | null = null;
    if (focus) {
      box = new THREE.Box3();
      for (const id of focusOf(body, focus)) { const m = meshRegistry.get(id); if (m) box.union(new THREE.Box3().setFromObject(m)); }
      if (box.isEmpty()) box = null;
    }
    for (const p of parts) {
      const isFocus = focus === p.organ;
      const isBone = p.organ === 'marrow';
      p.mesh.visible = !(isBone && (!layers.skeleton || (focus && focus !== 'marrow')));
      let mat: THREE.Material = p.solid;
      if (focus && !isFocus) mat = isBone ? boneGhost : contextGhost;
      else if (isBone && !bonesSolid) mat = boneGhost;
      else if (isFocus && xray && p.spec.shell) mat = p.glass;
      p.mesh.material = mat;
      const clip = isFocus && section.on && box && (p.spec.hollow || p.spec.shell) ? [clipPlane] : [];
      // Closed organs never show their back faces unless the cutting plane opens them.
      if (p.inner) p.inner.visible = mat === p.solid && (p.seeThrough ? depth || clip.length > 0 : clip.length > 0);
      p.solid.clippingPlanes = clip; p.glass.clippingPlanes = clip;
      if (p.inner) (p.inner.material as THREE.Material).clippingPlanes = clip;
      p.dimT = !focus && activeSystem && !ORGAN_SYSTEMS[p.organ]?.has(activeSystem) ? 1 : 0;
    }
    for (const [name, organ] of meshOrgan) if (organ === 'skin') meshRegistry.get(name)!.visible = layers.skin && !focus;
    if (box && section.on) {
      const t = section.depth;
      if (section.axis === 'coronal') { clipPlane.normal.set(0, 0, -1); clipPlane.constant = THREE.MathUtils.lerp(box.max.z, box.min.z, t); }
      else if (section.axis === 'sagittal') { const sgn = focus === 'liver' ? 1 : -1; clipPlane.normal.set(sgn, 0, 0); clipPlane.constant = sgn > 0 ? -THREE.MathUtils.lerp(box.min.x, box.max.x, t) : THREE.MathUtils.lerp(box.max.x, box.min.x, t); }
      else { clipPlane.normal.set(0, -1, 0); clipPlane.constant = THREE.MathUtils.lerp(box.max.y, box.min.y, t); }
    }
    animating.current = true; invalidate();
  }, [parts, body, tier, depth, selected, activeSystem, xray, layers, section, boneGhost, contextGhost, clipPlane, invalidate]);

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
    // shown on screen: the mesh and every parent (the previous body stays mounted, hidden, while the next one loads)
    const shown = (o: THREE.Object3D | null) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
    const hits = e.intersections.filter(h => (h.object as THREE.Mesh).isMesh && meshOrgan.has(h.object.name) && shown(h.object));
    const rank = (h: THREE.Intersection) => {
      const mat = (h.object as THREE.Mesh).material as THREE.Material;
      if (mat === boneGhost || mat === contextGhost) return 3;
      return mat.transparent ? 2 : 1;
    };
    hits.sort((a, b) => rank(a) - rank(b) || a.distance - b.distance);
    return hits.length ? meshOrgan.get(hits[0].object.name) ?? null : null;
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

