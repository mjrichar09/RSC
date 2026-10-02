/**
 * Animals at the roadside.
 *
 * The pose carries the whole gameplay message, so it is deliberately readable
 * from a fixed isometric camera at speed: head down and side-on while grazing,
 * head up and turned to face the road once alert. That change is the only
 * warning the player gets, so it has to be visible in a glance, at 130 km/h,
 * in the rain.
 *
 * Four figures, built separately: a deer and a sheep, and on Mars a rover and
 * one of the swarm, which run through the same state machine with different
 * numbers. A sheep used to be the deer's boxes at two
 * thirds scale, which made it a small deer — and the two cost very different
 * amounts to hit, so they have to be told apart by *shape*, not only by size
 * and colour. A deer is long-legged and narrow with its head carried high; a
 * sheep is a lump of wool on short dark legs with a black face. Both are
 * smooth primitives (`shapes.ts`) merged per material, a few draw calls each.
 */

import * as THREE from 'three';
import type { Animal, AnimalKind } from '../sim/wildlife.js';
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

/** A rover: white and grey, brighter with the mast up and looking. */
const ROVER = 0xcfcac0;
const ROVER_ALERT = 0xf3f0e8;
const ROVER_DARK = 0x3a3a3e;
const FOIL = 0xc99a3a;

/** The swarm: dark olive-grey skin, a little lighter once it has seen you. */
const ALIEN = 0x47503f;
const ALIEN_ALERT = 0x66735a;
const EYE = 0x0a0b0a;
const ALIEN_GLOW = 0x7cff9a;

/** Coat colour calm and alert, by species. */
const COAT: Record<AnimalKind, [number, number]> = {
  deer: [HIDE, HIDE_ALERT],
  sheep: [WOOL, WOOL_ALERT],
  rover: [ROVER, ROVER_ALERT],
  alien: [ALIEN, ALIEN_ALERT],
};

const KINDS: readonly AnimalKind[] = ['deer', 'sheep', 'rover', 'alien'];

interface Slot {
  root: THREE.Group;
  figures: Record<AnimalKind, Figure>;
  /** Which figure it last showed, for a reel frame that does not say. */
  kind: AnimalKind;
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

/**
 * A small Mars rover, about two metres long, nose along +Z.
 *
 * Six wheels on rocker-bogies and a mast with a camera head. The mast is the
 * "head": folded down along the deck while it is busy, up and looking once it
 * has seen the car — the same tell a deer gives, in a shape nobody mistakes
 * for one.
 */
function roverGeometry() {
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const body = merge([
    place(box(1.25, 0.42, 1.75), { at: [0, 0.86, 0] }),
    // The power unit, angled off the back.
    place(rod(0.16, 0.16, 0.6), { at: [0, 0.98, -1.0], turn: [1.1, 0, 0] }),
    // A dish on the deck.
    place(rod(0.26, 0.05, 0.08), { at: [0.32, 1.12, -0.35], turn: [0.3, 0, 0.2] }),
  ]);
  const foil = merge([place(box(1.1, 0.06, 1.55), { at: [0, 1.1, 0] })]);
  const running = merge([
    ...[0.82, -0.82].flatMap((x) =>
      [0.72, 0, -0.72].map((z) => place(rod(0.22, 0.22, 0.2), { at: [x, 0.24, z], turn: [0, 0, Math.PI / 2] })),
    ),
    // Rockers and bogies: a bar down each side and a strut to each wheel.
    ...[0.68, -0.68].flatMap((x) => [
      place(box(0.07, 0.07, 1.6), { at: [x, 0.56, 0] }),
      ...[0.72, 0, -0.72].map((z) => place(rod(0.035, 0.035, 0.36), { at: [x + Math.sign(x) * 0.06, 0.4, z] })),
    ]),
  ]);
  // In the head group's frame, which pivots at the front of the deck.
  const mast = merge([place(rod(0.05, 0.06, 0.85), { at: [0, 0.42, 0] })]);
  const camera = merge([
    place(box(0.36, 0.16, 0.2), { at: [0, 0.9, 0.04] }),
    place(rod(0.045, 0.045, 0.06), { at: [0.09, 0.9, 0.16], turn: [Math.PI / 2, 0, 0] }),
    place(rod(0.045, 0.045, 0.06), { at: [-0.09, 0.9, 0.16], turn: [Math.PI / 2, 0, 0] }),
  ]);
  return { body, foil, running, mast, camera };
}

/**
 * One of the swarm: gaunt, hunched, about a man's height, nose along +Z.
 *
 * Redrawn from a green blob with big eyes and antennae, which read as a toy —
 * a swarm of something you would hit for fun rather than swerve to avoid.
 * Spindly limbs, backward-jointed legs, a long skull with slit eyes, and dark
 * glossy skin: something that stands still in the road and watches you come.
 */
function alienGeometry() {
  // Torso leaning forward over the hips, ribs and a hunched back.
  const body = merge([
    place(capsule(0.13, 0.42), { at: [0, 1.12, 0.04], turn: [0.45, 0, 0], size: [1, 1, 0.8] }),
    place(capsule(0.1, 0.12), { at: [0, 0.82, -0.04] }),
    place(ball(0.12), { at: [0, 1.36, 0.1], size: [1.3, 0.8, 1] }),
    // Arms, long and thin, hanging forward past the knees.
    ...[1, -1].flatMap((side) => [
      place(rod(0.035, 0.03, 0.5), { at: [side * 0.2, 1.12, 0.2], turn: [0.35, 0, side * 0.12] }),
      place(rod(0.03, 0.022, 0.52), { at: [side * 0.22, 0.68, 0.32], turn: [-0.2, 0, side * 0.05] }),
      place(cone(0.035, 0.16), { at: [side * 0.22, 0.38, 0.36], turn: [Math.PI - 0.2, 0, 0] }),
    ]),
    // Legs bent backward at the knee, the way something that runs is built.
    ...[1, -1].flatMap((side) => [
      place(rod(0.05, 0.035, 0.48), { at: [side * 0.1, 0.62, 0.08], turn: [0.45, 0, 0] }),
      place(rod(0.032, 0.025, 0.44), { at: [side * 0.1, 0.22, -0.02], turn: [-0.35, 0, 0] }),
      place(capsule(0.03, 0.12), { at: [side * 0.1, 0.02, 0.06], turn: [Math.PI / 2, 0, 0] }),
    ]),
  ]);
  // In the head group's frame, which pivots at the neck: a long skull swept
  // back, a narrow jaw, and no ears.
  const head = merge([
    place(rod(0.04, 0.05, 0.16), { at: [0, 0.06, 0.02], turn: [0.6, 0, 0] }),
    place(ball(0.13), { at: [0, 0.16, 0.06], size: [0.85, 0.9, 1.1] }),
    place(ball(0.12), { at: [0, 0.2, -0.1], size: [0.75, 0.8, 1.6] }),
    place(cone(0.07, 0.14), { at: [0, 0.08, 0.18], turn: [Math.PI / 2 + 0.3, 0, 0], size: [1, 1, 0.8] }),
  ]);
  const eyes = merge([
    place(ball(0.045), { at: [0.06, 0.18, 0.16], size: [1.4, 0.45, 0.6], turn: [0, 0, -0.35] }),
    place(ball(0.045), { at: [-0.06, 0.18, 0.16], size: [1.4, 0.45, 0.6], turn: [0, 0, 0.35] }),
  ]);
  // A faint line of light down the spine: something to see in a dust storm,
  // and not a cartoon glow all over.
  const glow = merge([
    place(capsule(0.025, 0.36), { at: [0, 1.18, -0.06], turn: [0.45, 0, 0] }),
  ]);
  return { body, head, eyes, glow };
}

export class WildlifeView {
  readonly group = new THREE.Group();
  private readonly slots: Slot[] = [];
  /** Seconds, for the swarm's hover. Advanced by `update`, never by the clock. */
  private clock = 0;

  constructor(parent: THREE.Object3D) {
    const d = deerGeometry();
    const s = sheepGeometry();
    const r = roverGeometry();
    const a = alienGeometry();
    const roverDark = smooth(ROVER_DARK, 0.5);
    const foil = new THREE.MeshStandardMaterial({ color: FOIL, roughness: 0.35, metalness: 0.6 });
    const eye = smooth(EYE, 0.15);
    const glowMaterial = new THREE.MeshBasicMaterial({ color: ALIEN_GLOW });
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

      // --- rover ---
      const roverRoot = new THREE.Group();
      const shell = smooth(ROVER, 0.55);
      mesh(r.body, shell, roverRoot);
      mesh(r.foil, foil, roverRoot);
      mesh(r.running, roverDark, roverRoot);
      const roverHead = new THREE.Group();
      roverHead.position.set(0, 1.08, 0.62);
      mesh(r.mast, roverDark, roverHead);
      mesh(r.camera, shell, roverHead);
      roverRoot.add(roverHead);
      root.add(roverRoot);

      // --- one of the swarm ---
      const alienRoot = new THREE.Group();
      // Glossy rather than matte: wet-looking skin is most of what stops it
      // reading as a toy.
      const skin = smooth(ALIEN, 0.32);
      mesh(a.body, skin, alienRoot);
      mesh(a.glow, glowMaterial, alienRoot);
      const alienHead = new THREE.Group();
      alienHead.position.set(0, 1.42, 0.2);
      mesh(a.head, skin, alienHead);
      mesh(a.eyes, eye, alienHead);
      alienRoot.add(alienHead);
      root.add(alienRoot);

      root.visible = false;
      this.slots.push({
        root,
        figures: {
          deer: { root: deerRoot, head: deerHead, coat: hide },
          sheep: { root: sheepRoot, head: sheepHead, coat: fleece },
          rover: { root: roverRoot, head: roverHead, coat: shell },
          alien: { root: alienRoot, head: alienHead, coat: skin },
        },
        kind: 'deer',
      });
      this.group.add(root);
    }

    parent.add(this.group);
  }

  /** Show one species in a slot and hand back its parts to pose. */
  private show(slot: Slot, kind: AnimalKind): Figure {
    for (const k of KINDS) slot.figures[k].root.visible = k === kind;
    slot.kind = kind;
    return slot.figures[kind];
  }

  /** The swarm sways where it stands, each to its own beat; nothing else moves. */
  private hover(slot: Slot, index: number): void {
    const alien = slot.figures.alien.root;
    alien.rotation.z = slot.kind === 'alien' ? 0.05 * Math.sin(this.clock * 1.7 + index * 1.3) : 0;
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
      const figure = this.show(slot, (animal.kind as AnimalKind | undefined) ?? slot.kind);
      this.hover(slot, i);
      slot.root.position.set(animal.position.x, animal.position.y, animal.position.z);
      slot.root.rotation.set(0, animal.yaw, animal.roll, 'YZX');
      // Head up. An animal in the second before a crash has seen the car; a
      // grazing deer in a crash replay would be the wrong picture even if the
      // reel recorded the pose, which it deliberately does not.
      figure.head.rotation.x = -0.15;
      figure.coat.color.setHex(COAT[slot.kind][1]);
    }
  }

  update(animals: readonly Animal[], dt = 0): void {
    this.clock += dt;
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
      const figure = this.show(slot, animal.kind);
      this.hover(slot, i);
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
      figure.coat.color.setHex(COAT[animal.kind][alert ? 1 : 0]);
    }
  }

  clear(): void {
    for (const slot of this.slots) slot.root.visible = false;
  }
}
