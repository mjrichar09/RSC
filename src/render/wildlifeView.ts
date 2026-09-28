/**
 * Animals at the roadside.
 *
 * The pose carries the whole gameplay message, so it is deliberately readable
 * from a fixed isometric camera at speed: head down and side-on while grazing,
 * head up and turned to face the road once alert. That change is the only
 * warning the player gets, so it has to be visible in a glance, at 130 km/h,
 * in the rain.
 *
 * Two animals, built separately. A sheep used to be the deer's boxes at two
 * thirds scale, which made it a small deer — and the two cost very different
 * amounts to hit, so they have to be told apart by *shape*, not only by size
 * and colour. A deer is long-legged and narrow with its head carried high; a
 * sheep is a lump of wool on short dark legs with a black face. Both are
 * smooth primitives (`shapes.ts`) merged per material, a few draw calls each.
 */

import * as THREE from 'three';
import type { Animal } from '../sim/wildlife.js';
import type { Vec3 } from '../sim/math.js';
import { ball, capsule, cone, merge, place, rod } from './shapes.js';

/**
 * Enough for any stage this game builds.
 *
 * A kilometre of scattered animals carries about three, which is where 8 came
 * from. A flock is a dozen standing together on one summit, and a view pool
 * smaller than the animal list silently drops everything past the end of it —
 * the sheep at the back of the flock would be solid, billable, and invisible.
 */
const POOL = 26;

const HIDE = 0x6b5136;
const HIDE_ALERT = 0x8f6a44;
/** Belly, rump and tail: the pale underside every deer has. */
const PALE = 0xcdb99a;
const DARK = 0x2a2320;
const ANTLER = 0xd8c8a6;

/** Wool, and a dark face: pale against a dark verge, and never mistaken for a deer. */
const WOOL = 0xcfc8b6;
const WOOL_ALERT = 0xeae3d2;
const FACE = 0x2b2622;

interface Figure {
  root: THREE.Group;
  head: THREE.Group;
  /** The coat, which is what brightens when the animal is alert. */
  coat: THREE.MeshStandardMaterial;
}

interface Slot {
  root: THREE.Group;
  deer: Figure;
  sheep: Figure;
}

const smooth = (color: number, roughness = 0.85) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });

/** Deer geometry, built once and shared by every deer in the pool. */
function deerGeometry() {
  const body = merge([
    // Barrel, lying along the length of the animal.
    place(capsule(0.25, 0.72), { at: [0, 1.06, 0], turn: [Math.PI / 2, 0, 0], size: [0.9, 1, 1.05] }),
    // Shoulders and haunch, which is what stops it reading as a sausage.
    place(ball(0.27), { at: [0, 1.1, 0.4], size: [0.9, 1.05, 1] }),
    place(ball(0.28), { at: [0, 1.1, -0.42], size: [0.95, 1.05, 1] }),
    // Legs: a muscled upper, a knee, and a thin lower meeting it exactly. The
    // rear ones were angled at the hock at first and the two halves missed
    // each other, which read as a broken leg; straight and jointed reads as a
    // deer standing still, which is what it is doing.
    ...[0.13, -0.13].flatMap((x) =>
      [0.44, -0.46].flatMap((z) => [
        place(rod(0.075, 0.05, 0.44), { at: [x, 0.81, z] }),
        place(ball(0.05), { at: [x, 0.59, z] }),
        place(rod(0.042, 0.03, 0.56), { at: [x, 0.31, z] }),
      ]),
    ),
  ]);
  const pale = merge([
    place(ball(0.24), { at: [0, 0.92, 0], size: [0.75, 0.42, 1.9] }),
    place(ball(0.16), { at: [0, 1.12, -0.66], size: [1, 1.1, 0.6] }),
    place(cone(0.07, 0.2), { at: [0, 1.18, -0.76], turn: [-2.2, 0, 0] }),
  ]);
  const hooves = merge(
    [0.13, -0.13].flatMap((x) => [
      place(ball(0.04), { at: [x, 0.04, 0.45], size: [1, 0.8, 1.3] }),
      place(ball(0.04), { at: [x, 0.04, -0.45], size: [1, 0.8, 1.3] }),
    ]),
  );
  // The head group pivots at the shoulders; all of this is in its frame.
  // Carried forward, not upright: a deer's neck leaves the shoulders at about
  // forty degrees. Upright, with the alert pose tipping it back, it read as a
  // llama.
  const neckHead = merge([
    place(rod(0.075, 0.12, 0.55), { at: [0, 0.22, 0.12], turn: [0.62, 0, 0] }),
    place(capsule(0.1, 0.18), { at: [0, 0.45, 0.3], turn: [Math.PI / 2 - 0.2, 0, 0], size: [0.85, 1, 1] }),
    // Muzzle, tapering to the nose.
    place(rod(0.055, 0.085, 0.18), { at: [0, 0.41, 0.48], turn: [Math.PI / 2 - 0.25, 0, 0] }),
    // Ears, out to the sides and up.
    place(cone(0.05, 0.17), { at: [0.1, 0.56, 0.24], turn: [0, 0, -0.7], size: [1, 1, 0.5] }),
    place(cone(0.05, 0.17), { at: [-0.1, 0.56, 0.24], turn: [0, 0, 0.7], size: [1, 1, 0.5] }),
  ]);
  const nose = merge([place(ball(0.035), { at: [0, 0.39, 0.57] })]);
  const antlers = merge(
    [1, -1].flatMap((side) => [
      place(rod(0.012, 0.02, 0.32), { at: [side * 0.08, 0.69, 0.2], turn: [-0.25, 0, -side * 0.45] }),
      place(rod(0.01, 0.015, 0.16), { at: [side * 0.13, 0.77, 0.3], turn: [0.6, 0, -side * 0.2] }),
      place(rod(0.009, 0.014, 0.14), { at: [side * 0.19, 0.85, 0.14], turn: [-0.5, 0, -side * 0.5] }),
    ]),
  );
  return { body, pale, hooves, neckHead, nose, antlers };
}

/** Sheep geometry, built once and shared by every sheep in the pool. */
function sheepGeometry() {
  // A fleece is lumps, not a smooth ellipsoid: overlapping icosahedra read as
  // wool from forty metres up in a way a sphere never does.
  const lumps: [number, number, number, number][] = [
    [0, 0.66, 0, 0.3],
    [0, 0.68, 0.24, 0.26],
    [0, 0.68, -0.26, 0.27],
    [0.15, 0.62, 0.08, 0.22],
    [-0.15, 0.62, 0.08, 0.22],
    [0.14, 0.62, -0.18, 0.22],
    [-0.14, 0.62, -0.18, 0.22],
    [0, 0.8, -0.05, 0.22],
  ];
  const wool = merge(lumps.map(([x, y, z, r]) => place(ball(r, true), { at: [x, y, z] })));
  const legs = merge(
    [0.12, -0.12].flatMap((x) => [
      place(rod(0.035, 0.03, 0.42), { at: [x, 0.21, 0.24] }),
      place(rod(0.035, 0.03, 0.42), { at: [x, 0.21, -0.24] }),
    ]),
  );
  const face = merge([
    place(capsule(0.085, 0.13), { at: [0, 0.02, 0.12], turn: [Math.PI / 2 - 0.5, 0, 0] }),
    // Ears straight out to the sides, which is most of a sheep's face.
    place(capsule(0.03, 0.09), { at: [0.1, 0.06, 0.06], turn: [0, 0, Math.PI / 2 - 0.3], size: [1, 1, 0.55] }),
    place(capsule(0.03, 0.09), { at: [-0.1, 0.06, 0.06], turn: [0, 0, -Math.PI / 2 + 0.3], size: [1, 1, 0.55] }),
  ]);
  const topknot = merge([place(ball(0.09, true), { at: [0, 0.11, 0.03] })]);
  return { wool, legs, face, topknot };
}

export class WildlifeView {
  readonly group = new THREE.Group();
  private readonly slots: Slot[] = [];

  constructor(parent: THREE.Object3D) {
    const d = deerGeometry();
    const s = sheepGeometry();
    const pale = smooth(PALE);
    const dark = smooth(DARK, 0.6);
    const antler = smooth(ANTLER, 0.7);
    const face = smooth(FACE);

    for (let i = 0; i < POOL; i++) {
      const root = new THREE.Group();
      const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D) => {
        const m = new THREE.Mesh(geometry, material);
        m.castShadow = true;
        parent.add(m);
        return m;
      };

      // --- deer ---
      const deerRoot = new THREE.Group();
      const hide = smooth(HIDE);
      mesh(d.body, hide, deerRoot);
      mesh(d.pale, pale, deerRoot);
      mesh(d.hooves, dark, deerRoot);
      // Neck and head in their own group so the whole assembly can pivot at the
      // shoulders — grazing is the head down between the front legs.
      const deerHead = new THREE.Group();
      deerHead.position.set(0, 1.2, 0.55);
      mesh(d.neckHead, hide, deerHead);
      mesh(d.nose, dark, deerHead);
      // Half of them are stags. By slot, so a given animal keeps its antlers.
      if (i % 2 === 0) mesh(d.antlers, antler, deerHead);
      deerRoot.add(deerHead);
      root.add(deerRoot);

      // --- sheep ---
      const sheepRoot = new THREE.Group();
      const fleece = smooth(WOOL, 0.95);
      mesh(s.wool, fleece, sheepRoot);
      mesh(s.legs, face, sheepRoot);
      const sheepHead = new THREE.Group();
      sheepHead.position.set(0, 0.74, 0.4);
      mesh(s.face, face, sheepHead);
      mesh(s.topknot, fleece, sheepHead);
      sheepRoot.add(sheepHead);
      root.add(sheepRoot);

      root.visible = false;
      this.slots.push({
        root,
        deer: { root: deerRoot, head: deerHead, coat: hide },
        sheep: { root: sheepRoot, head: sheepHead, coat: fleece },
      });
      this.group.add(root);
    }

    parent.add(this.group);
  }

  /** Show one species in a slot and hand back its parts to pose. */
  private show(slot: Slot, sheep: boolean): Figure {
    slot.deer.root.visible = !sheep;
    slot.sheep.root.visible = sheep;
    return sheep ? slot.sheep : slot.deer;
  }

  /**
   * Pose from a recorded crash frame.
   *
   * A deer is placed and stepped by the simulation, so by the time the
   * cinematic runs it has moved on or been marked gone — and the replay showed
   * a car swerving at nothing and crumpling for no reason. The reel keeps where
   * each animal stood; this puts them back.
   */
  updateFromReel(
    animals: readonly { position: Vec3; yaw: number; roll: number; gone: boolean; kind?: string }[],
  ): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      const animal = animals[i];
      // By index, exactly as `update` does: each view belongs to one animal for
      // the life of the stage, so filtering the list would shuffle every deer
      // after the first one that had been hit.
      if (!animal || animal.gone) {
        slot.root.visible = false;
        continue;
      }
      slot.root.visible = true;
      // The reel does not record species; the slot still shows whichever it
      // showed live, which is the right animal because slots never change hands.
      const figure = animal.kind ? this.show(slot, animal.kind === 'sheep') : slot.sheep.root.visible ? slot.sheep : slot.deer;
      slot.root.position.set(animal.position.x, animal.position.y, animal.position.z);
      slot.root.rotation.set(0, animal.yaw, animal.roll, 'YZX');
      // Head up. An animal in the second before a crash has seen the car; a
      // grazing deer in a crash replay would be the wrong picture even if the
      // reel recorded the pose, which it deliberately does not.
      figure.head.rotation.x = -0.15;
      figure.coat.color.setHex(figure === slot.sheep ? WOOL_ALERT : HIDE_ALERT);
    }
  }

  update(animals: readonly Animal[]): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      const animal = animals[i];
      if (!animal || animal.state === 'gone') {
        slot.root.visible = false;
        continue;
      }

      slot.root.visible = true;
      // Species is fixed for the life of the stage, but it is applied every
      // frame rather than once: the pool is reused across stage loads, and a
      // slot that kept the last stage's animal would be a sheep where a deer
      // stands.
      const sheep = animal.kind === 'sheep';
      const figure = this.show(slot, sheep);
      slot.root.position.set(animal.position.x, animal.position.y, animal.position.z);
      // Yaw then roll: a struck animal tumbles about its own long axis and ends
      // up lying on its side, which is most of what makes the aftermath read as
      // one. `rotation.order` matters here — applied the other way round it
      // spins about the world's axis and cartwheels.
      slot.root.rotation.set(0, animal.yaw, animal.roll, 'YZX');

      // Head down to graze, up the moment it has seen you. The coat brightens
      // with it, because a silhouette alone is hard to read against a dark
      // verge at night — and night is exactly when this matters.
      const alert = animal.state !== 'grazing';
      figure.head.rotation.x = alert ? -0.15 : 1.15;
      figure.coat.color.setHex(sheep ? (alert ? WOOL_ALERT : WOOL) : alert ? HIDE_ALERT : HIDE);
    }
  }

  clear(): void {
    for (const slot of this.slots) slot.root.visible = false;
  }
}
