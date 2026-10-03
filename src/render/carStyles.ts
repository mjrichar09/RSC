/**
 * Other bodies for the same car.
 *
 * Skins, not cars: every one of these is driven by exactly the physics the
 * rally car is — same wheelbase, same track, same collider, same tyres — so a
 * time set in a monster truck is a time set in the stock car, and arcade's
 * board stays one board. What changes is only what is drawn over it.
 *
 * That constraint shapes both of them. The wheels are drawn where the physics
 * has them, so a bigger wheel has to be lifted by exactly how much bigger it
 * is or it sinks into the road; and the body is lifted to clear it. Nothing
 * here may move a contact patch.
 */

import * as THREE from 'three';
import { CAR } from '../data/tuning.js';

export type CarStyle = 'rally' | 'monster' | 'rover';

export const CAR_STYLES: Record<CarStyle, { name: string }> = {
  rally: { name: 'Rally car' },
  monster: { name: 'Monster truck' },
  rover: { name: 'Mars rover' },
};

export const isCarStyle = (value: unknown): value is CarStyle =>
  typeof value === 'string' && value in CAR_STYLES;

/** How a style places its wheels, relative to where the physics has them. */
export interface WheelLayout {
  /** Scale on the drawn wheel: across the tyre, and its diameter. */
  width: number;
  size: number;
  /** Drawn further out than the physics wheel, metres. */
  spread: number;
  /** Raised, so a bigger wheel still meets the road where the physics does. */
  lift: number;
  /** The body raised above the wheels, metres. */
  body: number;
}

const MONSTER_SIZE = 2.1;

export const WHEEL_LAYOUT: Record<CarStyle, WheelLayout> = {
  rally: { width: 1, size: 1, spread: 0, lift: 0, body: 0 },
  // Wheels as tall as the car, standing out past the body, and the body
  // carried high above them on its shocks.
  monster: {
    width: 2,
    size: MONSTER_SIZE,
    spread: 0.36,
    lift: CAR.wheelRadius * (MONSTER_SIZE - 1),
    body: 0.72,
  },
  // The rover's own wheels are the rally car's size; its deck sits low.
  rover: { width: 1.15, size: 1, spread: 0.06, lift: 0, body: 0 },
};

const solid = (color: number, roughness = 0.6, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

const piece = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  at: [number, number, number],
  turn: [number, number, number] = [0, 0, 0],
): THREE.Mesh => {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...at);
  mesh.rotation.set(...turn);
  mesh.castShadow = true;
  return mesh;
};

/** A rod from one point to another, in the parent's frame. */
function strut(from: THREE.Vector3, to: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const length = from.distanceTo(to);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 8), material);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  mesh.castShadow = true;
  return mesh;
}

/**
 * What a monster truck adds to the rally car's body: shocks down to every
 * wheel, a roll cage over the cab with a light bar on it, and a push bar.
 *
 * Built in the chassis frame *before* the body lift, so it rides up with the
 * body; the shocks reach down to where the lifted wheels' hubs are drawn.
 */
export function buildMonsterExtras(): THREE.Group {
  const group = new THREE.Group();
  const layout = WHEEL_LAYOUT.monster;
  const chrome = solid(0xc9ced4, 0.25, 0.8);
  const spring = solid(0xd6402e, 0.4, 0.3);
  const black = solid(0x1d1f22, 0.6);
  const h = CAR.halfExtents;

  for (const mount of CAR.wheelPositions) {
    const side = Math.sign(mount.x);
    // From the frame, above the wheel, to the hub — whose height in the
    // chassis frame is the hub's drawn height less the body's lift.
    const top = new THREE.Vector3(side * h.x * 0.7, 0.05, mount.z);
    const hub = new THREE.Vector3(
      mount.x + side * layout.spread * 0.6,
      mount.y + CAR.suspensionRestLength * 0.5 + layout.lift - layout.body,
      mount.z,
    );
    group.add(strut(top, hub, 0.07, chrome));
    // A coil round the upper half, in the colour every monster truck uses.
    const coil = strut(top, top.clone().lerp(hub, 0.55), 0.12, spring);
    group.add(coil);
    // And a trailing arm from the frame's centreline to the hub.
    group.add(strut(new THREE.Vector3(0, -0.3, mount.z * 0.7), hub, 0.05, black));
  }

  // A roll cage over the cab: two hoops and the bar along the top.
  const cageMat = solid(0x24262a, 0.45, 0.4);
  for (const z of [0.38, -0.7]) {
    group.add(strut(new THREE.Vector3(h.x * 0.78, 0.28, z), new THREE.Vector3(h.x * 0.62, 0.95, z), 0.045, cageMat));
    group.add(strut(new THREE.Vector3(-h.x * 0.78, 0.28, z), new THREE.Vector3(-h.x * 0.62, 0.95, z), 0.045, cageMat));
    group.add(strut(new THREE.Vector3(h.x * 0.62, 0.95, z), new THREE.Vector3(-h.x * 0.62, 0.95, z), 0.045, cageMat));
  }
  // The light bar, on the front hoop.
  group.add(piece(new THREE.BoxGeometry(h.x * 1.3, 0.12, 0.16), black, [0, 1.04, 0.38]));
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0x8a7a50, roughness: 0.3 });
  for (let i = -2; i <= 2; i++) {
    group.add(piece(new THREE.BoxGeometry(0.16, 0.09, 0.04), lamp, [i * 0.22, 1.04, 0.47]));
  }
  // A tubular push bar across the nose.
  const bar = solid(0x24262a, 0.4, 0.5);
  group.add(strut(new THREE.Vector3(h.x * 0.7, -0.22, h.z + 0.12), new THREE.Vector3(-h.x * 0.7, -0.22, h.z + 0.12), 0.06, bar));
  group.add(strut(new THREE.Vector3(h.x * 0.6, 0.08, h.z + 0.05), new THREE.Vector3(-h.x * 0.6, 0.08, h.z + 0.05), 0.05, bar));
  for (const side of [1, -1]) {
    group.add(strut(new THREE.Vector3(side * h.x * 0.6, -0.22, h.z + 0.12), new THREE.Vector3(side * h.x * 0.6, 0.08, h.z + 0.05), 0.05, bar));
  }
  return group;
}

/**
 * A Mars rover's body, in the chassis frame: a low white deck on gold foil, a
 * mast with a camera head at the front, a power unit angled off the back, a
 * dish, an arm folded across the nose, and rocker-bogie suspension down each
 * side to six wheels — the middle pair drawn by the car view, which knows where
 * the other four are.
 */
export function buildRoverBody(): THREE.Group {
  const group = new THREE.Group();
  const white = solid(0xe7e4dc, 0.5);
  white.emissive.setHex(0x2a2826);
  const foil = solid(0xc99a3a, 0.3, 0.7);
  const dark = solid(0x2d2f33, 0.55, 0.3);
  const grey = solid(0x8d9196, 0.45, 0.5);
  const h = CAR.halfExtents;

  // The deck and the foil-wrapped electronics box under it.
  group.add(piece(new THREE.BoxGeometry(h.x * 1.75, 0.34, h.z * 1.35), white, [0, 0.22, -0.05]));
  group.add(piece(new THREE.BoxGeometry(h.x * 1.45, 0.26, h.z * 1.15), foil, [0, -0.06, -0.05]));
  // Equipment on the deck.
  group.add(piece(new THREE.BoxGeometry(0.5, 0.18, 0.6), grey, [-0.35, 0.48, -0.5]));
  group.add(piece(new THREE.CylinderGeometry(0.34, 0.08, 0.08, 18), grey, [0.42, 0.5, -0.35], [0.35, 0, -0.3]));

  // The mast: a post at the front left, a camera head on top.
  group.add(piece(new THREE.CylinderGeometry(0.05, 0.065, 1.2, 10), dark, [0.48, 0.98, 1.05]));
  group.add(piece(new THREE.BoxGeometry(0.42, 0.2, 0.24), white, [0.48, 1.62, 1.08]));
  for (const x of [0.38, 0.58]) {
    group.add(piece(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 10), dark, [x, 1.62, 1.22], [Math.PI / 2, 0, 0]));
  }

  // The power unit, angled up off the back.
  group.add(piece(new THREE.CylinderGeometry(0.2, 0.2, 0.75, 12), dark, [0, 0.42, -1.55], [1.05, 0, 0]));
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    group.add(
      piece(new THREE.BoxGeometry(0.03, 0.6, 0.22), dark, [Math.cos(a) * 0.22, 0.42 + Math.sin(a) * 0.1, -1.55], [1.05, a, 0]),
    );
  }

  // The arm, folded across the nose, with its turret at the end.
  group.add(strut(new THREE.Vector3(-0.55, 0.15, 1.25), new THREE.Vector3(0.3, 0.12, 1.5), 0.06, grey));
  group.add(piece(new THREE.BoxGeometry(0.3, 0.24, 0.24), grey, [0.38, 0.12, 1.52]));

  // Rocker-bogie: down each side, from the body's pivot to the rear wheel, and
  // a bogie from there to the front and middle ones.
  for (const side of [1, -1]) {
    const x = side * (h.x + 0.02);
    const pivot = new THREE.Vector3(x, 0.32, -0.25);
    const bogie = new THREE.Vector3(x, 0.08, 0.66);
    const hubY = CAR.wheelPositions[0]!.y + CAR.suspensionRestLength * 0.5;
    group.add(strut(pivot, new THREE.Vector3(x, hubY, -1.32), 0.05, grey));
    group.add(strut(pivot, bogie, 0.05, grey));
    group.add(strut(bogie, new THREE.Vector3(x, hubY, 1.32), 0.045, grey));
    group.add(strut(bogie, new THREE.Vector3(x, hubY, 0), 0.045, grey));
  }
  return group;
}

/**
 * A rover wheel, in a wheel's own frame (axle along X): a wide aluminium drum
 * with chevron grousers, a dark hub and spokes. The rally tyre's size, so it
 * meets the road where the physics does.
 */
export function buildRoverWheel(): THREE.Group {
  const group = new THREE.Group();
  const metal = solid(0xb7bbbf, 0.35, 0.7);
  const dark = solid(0x2a2c30, 0.5, 0.4);
  const r = CAR.wheelRadius;
  const drum = new THREE.CylinderGeometry(r * 0.97, r * 0.97, 0.3, 24, 1, true);
  drum.rotateZ(Math.PI / 2);
  const drumMesh = new THREE.Mesh(drum, metal);
  drumMesh.castShadow = true;
  group.add(drumMesh);
  // Grousers: ridges across the tread, which is what makes it a rover wheel.
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const g = piece(new THREE.BoxGeometry(0.32, 0.035, 0.05), dark, [0, Math.cos(a) * r, Math.sin(a) * r], [a, 0, 0]);
    group.add(g);
  }
  // Hub and spokes on both faces.
  for (const face of [1, -1]) {
    group.add(piece(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 12), dark, [face * 0.15, 0, 0], [0, 0, Math.PI / 2]));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      group.add(
        piece(new THREE.BoxGeometry(0.02, r * 0.85, 0.035), metal, [face * 0.15, Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45], [a, 0, 0]),
      );
    }
  }
  return group;
}
