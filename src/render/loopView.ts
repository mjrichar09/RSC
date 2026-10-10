/**
 * Drawing the loop-the-loop and its booster.
 *
 * The ribbon is the collider's own rows (`TrackLoop.geometry`), so the deck the
 * car is seen on is the deck it is on; this file only paints it, as track
 * pieces in the same colours as the road it leaves, continuing the sequence so
 * the loop reads as more of the same track bent round on itself.
 *
 * The booster's tyres stand where the simulation put their colliders (props of
 * kind `booster`); the housing over them is above anything a car on its wheels
 * can reach, which is the only reason it can be drawn without a collider.
 */

import * as THREE from 'three';
import type { Stage } from '../sim/stage.js';
import { LOOP_COLUMNS } from '../sim/loop.js';
import { tickToyTrack, toyTrackMaterial } from './toyTrack.js';

/**
 * Where each column of the loop's cross-section sits, in the toy shader's
 * terms: the deck is 0 to 1, the rails' inner faces just past it, and the
 * outsides and the slab's underside pale. Column order is `profile` in
 * `sim/loop.ts`.
 */
const COLUMN_ACROSS = [2.0, 1.8, 1.2, 1.0, 0, 1.0, 1.2, 1.8, 2.0];

/** Height of the booster housing's underside above the deck, metres. */
const HOUSING_CLEARANCE = 2.7;

export function buildLoopView(stage: Stage): THREE.Group | null {
  const loop = stage.loop;
  if (!loop) return null;
  const group = new THREE.Group();

  // The ribbon. Flat-shaded, because the rails are a sharp-cornered section
  // and smoothed normals round them into a tube.
  const { vertices, indices, along } = loop.geometry;
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  // Distance along the *stage*, so the pieces carry on the road's sequence.
  const stageAlong = new Float32Array(along.length);
  for (let i = 0; i < along.length; i++) stageAlong[i] = loop.spec.at + along[i]!;
  indexed.setAttribute('aAlong', new THREE.BufferAttribute(stageAlong, 1));
  const across = new Float32Array(along.length);
  for (let i = 0; i < across.length; i++) across[i] = COLUMN_ACROSS[i % LOOP_COLUMNS]!;
  indexed.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  indexed.setIndex(new THREE.BufferAttribute(indices, 1));
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  geometry.computeVertexNormals();

  const material = toyTrackMaterial({ clear: true });
  const ribbon = new THREE.Mesh(geometry, material);
  ribbon.castShadow = true;
  ribbon.receiveShadow = true;
  ribbon.onBeforeRender = () => tickToyTrack(material);
  group.add(ribbon);

  group.add(buildBooster(stage));
  return group;
}

/**
 * The booster: two fat tyres spinning flat either side of the track, and a
 * housing bridging over it on their axles.
 */
function buildBooster(stage: Stage): THREE.Group {
  const loop = stage.loop!;
  const group = new THREE.Group();
  const tyres = stage.props.filter((p) => p.kind === 'booster');
  const yaw = Math.atan2(loop.forward.x, loop.forward.z);

  const rubber = new THREE.MeshStandardMaterial({ color: 0x1c1c22, roughness: 0.85, emissive: 0x1c1c22, emissiveIntensity: 0.15 });
  const hub = new THREE.MeshStandardMaterial({ color: 0xffd21a, roughness: 0.4, metalness: 0.3 });
  const shell = new THREE.MeshStandardMaterial({ color: 0xe8202a, roughness: 0.38, metalness: 0.2, emissive: 0xe8202a, emissiveIntensity: 0.12 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0xffd21a, roughness: 0.4 });

  for (const tyre of tyres) {
    const spin = new THREE.Group();
    spin.position.set(tyre.position.x, tyre.position.y, tyre.position.z);
    // Tread blocks, so the spin can be seen; a smooth drum turning looks still.
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(tyre.radius, tyre.radius, tyre.height, 20), rubber);
    drum.position.y = tyre.height / 2;
    spin.add(drum);
    for (let i = 0; i < 10; i++) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.22, tyre.height * 0.9, 0.16), rubber);
      const a = (i / 10) * Math.PI * 2;
      block.position.set(Math.cos(a) * tyre.radius, tyre.height / 2, Math.sin(a) * tyre.radius);
      block.rotation.y = -a;
      spin.add(block);
    }
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(tyre.radius * 0.55, tyre.radius * 0.55, 0.08, 16), hub);
    cap.position.y = tyre.height + 0.04;
    spin.add(cap);
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(tyre.radius * 1.1, 0.06, 0.12), stripe);
      spoke.position.y = tyre.height + 0.1;
      spoke.rotation.y = (i * Math.PI) / 3;
      spin.add(spoke);
    }
    // Spinning the way that throws the car forward: the inside of each tyre
    // moves down the road, so the two turn opposite ways.
    const side = Math.sign(
      (tyre.position.x - loop.origin.x) * loop.left.x + (tyre.position.z - loop.origin.z) * loop.left.z,
    );
    drum.onBeforeRender = () => {
      spin.rotation.y = side * (performance.now() / 1000) * 9;
    };
    group.add(spin);

    // The axle up to the housing.
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, HOUSING_CLEARANCE - tyre.height + 0.2, 10), shell);
    axle.position.set(tyre.position.x, tyre.position.y + (HOUSING_CLEARANCE + tyre.height) / 2, tyre.position.z);
    group.add(axle);
  }

  if (tyres.length === 2) {
    const [a, b] = tyres as [(typeof tyres)[0], (typeof tyres)[0]];
    const span = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) + a.radius * 2;
    const housing = new THREE.Group();
    housing.position.set(
      (a.position.x + b.position.x) / 2,
      (a.position.y + b.position.y) / 2 + HOUSING_CLEARANCE,
      (a.position.z + b.position.z) / 2,
    );
    housing.rotation.y = yaw;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(span, 0.7, 2.4), shell);
    roof.position.y = 0.35;
    roof.castShadow = true;
    housing.add(roof);
    const band = new THREE.Mesh(new THREE.BoxGeometry(span + 0.02, 0.18, 2.42), stripe);
    band.position.y = 0.38;
    housing.add(band);
    group.add(housing);
  }
  return group;
}
