// Tissue materials shared by the interactive stage and the offline body-map renders.
import * as THREE from 'three';
import { TISSUE, type Tissue } from '../anatomy/organs';

/** 'physical' adds clearcoat and sheen (the studio look); 'standard' is the cheaper fast tier. */
export type MaterialTier = 'physical' | 'standard';

export type TissueMaterial = THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial;

/** `double`: thin sheets such as valve leaflets and ligaments, drawn from both sides. */
export function tissueMaterial(t: Tissue, tier: MaterialTier, inner = false, double = false): TissueMaterial {
  const d = TISSUE[t];
  const common = {
    color: inner ? d.inner ?? d.color : d.color, roughness: inner ? 0.8 : d.rough,
    side: inner ? THREE.BackSide : double ? THREE.DoubleSide : THREE.FrontSide, envMapIntensity: 0.9,
  };
  const m = tier === 'physical'
    ? new THREE.MeshPhysicalMaterial({
      ...common, clearcoat: inner ? 0.1 : d.clear, clearcoatRoughness: 0.32,
      sheen: d.sheen && !inner ? 0.55 : 0, sheenColor: new THREE.Color(d.sheen ?? '#ffffff'), sheenRoughness: 0.55,
    })
    // Without a clearcoat layer, wet tissue reads a little matte; a lower roughness keeps some of the shine.
    : new THREE.MeshStandardMaterial({ ...common, roughness: inner ? 0.8 : Math.max(0.2, d.rough - d.clear * 0.18) });
  if (d.opacity) { m.transparent = true; m.opacity = inner ? d.opacity * 0.55 : d.opacity; m.depthWrite = false; }
  return m;
}

const ghostVS = /* glsl */ `
  varying vec3 vN; varying vec3 vV;
  void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`;
const ghostFS = /* glsl */ `
  uniform vec3 uColor; uniform float uStrength; uniform float uBase;
  varying vec3 vN; varying vec3 vV;
  void main(){
    // clamp: rounding can push the dot product past 1, and pow() of a negative base is NaN (bloom spreads it into a glow).
    float f = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.4); float a = (uBase + f) * uStrength; gl_FragColor = vec4(uColor * a, a); }`;

/** See-through fresnel shell used for the skin, the skeleton and organs around the one in focus. */
export function ghost(color: string, strength: number, base = 0.03) {
  return new THREE.ShaderMaterial({
    vertexShader: ghostVS, fragmentShader: ghostFS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength }, uBase: { value: base } },
  });
}

export const GHOSTS = {
  skin: () => ghost('#8fd3dc', 0.42, 0.03),
  bone: () => ghost('#efe6d2', 0.30, 0.05),
  context: () => ghost('#9fd6dd', 0.13, 0.01),
};
