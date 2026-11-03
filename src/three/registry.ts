// Meshes of the model on stage, by name, so the camera rig and the render page can frame and sort them. Anatomy fills
// both maps whenever it takes on a model.
import type * as THREE from 'three';
import type { OrganId } from '../types';

export const meshRegistry = new Map<string, THREE.Mesh>();
/** Organ of each mesh on stage, by mesh name. */
export const meshOrgan = new Map<string, OrganId>();
