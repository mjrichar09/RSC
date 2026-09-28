/**
 * Building small figures out of smooth primitives.
 *
 * The animals, the crowd and the mechanic were boxes, a five-sided cylinder
 * and a twenty-sided ball — readable, and plainly placeholders beside a car
 * whose paint now chips and whose road carries rubber. These helpers are what
 * they are built from instead: capsules and spheres placed and merged into one
 * geometry per material, so a figure is a handful of draw calls however many
 * parts it has, and smooth-shaded, because the normals the primitives come
 * with are already smooth.
 *
 * Still low-poly on purpose: six to ten segments round, which is round at the
 * size these are drawn and does not pretend to be a character model.
 */

import * as THREE from 'three';

/** Where a part goes: position, rotation (radians, XYZ) and scale. */
export interface Placement {
  at?: [number, number, number];
  turn?: [number, number, number];
  size?: [number, number, number];
}

const matrix = new THREE.Matrix4();
const quaternion = new THREE.Quaternion();
const euler = new THREE.Euler();
const position = new THREE.Vector3();
const scale = new THREE.Vector3();

/** Move a geometry into place, in its own coordinates. Returns it. */
export function place(geometry: THREE.BufferGeometry, p: Placement): THREE.BufferGeometry {
  euler.set(...(p.turn ?? [0, 0, 0]));
  quaternion.setFromEuler(euler);
  position.set(...(p.at ?? [0, 0, 0]));
  scale.set(...(p.size ?? [1, 1, 1]));
  matrix.compose(position, quaternion, scale);
  geometry.applyMatrix4(matrix);
  return geometry;
}

/** A capsule of radius `r` and straight length `length`, standing along Y. */
export const capsule = (r: number, length: number, round = 8): THREE.BufferGeometry =>
  new THREE.CapsuleGeometry(r, Math.max(length, 0.001), 3, round);

/** A ball of radius `r`. `lumpy` uses an icosahedron, for wool and stone. */
export const ball = (r: number, lumpy = false): THREE.BufferGeometry =>
  lumpy ? new THREE.IcosahedronGeometry(r, 1) : new THREE.SphereGeometry(r, 10, 8);

/** A cone of base radius `r` and height `h`, point up. */
export const cone = (r: number, h: number): THREE.BufferGeometry => new THREE.ConeGeometry(r, h, 8);

/** A tapered cylinder, standing along Y. */
export const rod = (top: number, bottom: number, h: number): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(top, bottom, h, 8);

/**
 * Merge parts into one geometry, keeping positions and normals.
 *
 * Everything is made non-indexed first, which is the one form every primitive
 * can be joined in, and the parts are disposed once copied.
 */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  let count = 0;
  for (const g of flat) count += g.getAttribute('position').count;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  let at = 0;
  for (const g of flat) {
    positions.set(g.getAttribute('position').array as Float32Array, at * 3);
    normals.set(g.getAttribute('normal').array as Float32Array, at * 3);
    at += g.getAttribute('position').count;
  }
  for (const g of parts) g.dispose();
  for (const g of flat) g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return out;
}
