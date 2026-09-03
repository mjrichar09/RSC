/**
 * Visual representation of the car.
 *
 * Reads sim state, never writes it. Deliberately built from primitives: a
 * strong silhouette in flat-shaded blocks tells you everything you need about
 * body attitude, and it is the whole point of the "minimal now, models later"
 * approach — this file is the only thing that has to change later.
 */

import * as THREE from 'three';
import { CAR } from '../data/tuning.js';
import type { Quat, Vec3 } from '../sim/math.js';
import type { ComponentId, DamageModel, Dent } from '../sim/damage.js';
import type { DebrisModel, PartId, PartState } from '../sim/debris.js';

/**
 * What this view actually needs of a damage model.
 *
 * Three questions, and a recorded crash frame can answer all three as well as
 * the live model can. Declared structurally rather than importing the recorded
 * types from `game/`: the renderer reads the simulation and nothing else, and
 * a `render/ -> game/` import would be a new edge on a diagram that does not
 * have one.
 */
export interface DamageLike {
  get(id: ComponentId): number;
  brakeGlow(index: number): number;
  brakeTint(index: number): number;
  /** Where the metal went. Folds are geometry, not a texture. */
  readonly dents: readonly Dent[];
  /** Bumped when the dent list changes, so the mesh is rebuilt only then. */
  readonly dentVersion: number;
}

/** The same, for the parts that come off. */
export interface DebrisLike {
  stateOf(id: PartId): PartState;
  isLoose(id: PartId): boolean;
}

/** One recorded frame, as much of it as the car needs. */
export interface PosedFrame {
  position: Vec3;
  rotation: Quat;
  steer: number;
  wheelRotation: number[];
  wheelCompression: number[];
  wheelGrounded: boolean[];
}
import type { GhostSample } from '../sim/replay.js';
import type { VehicleState } from '../sim/vehicle.js';
import { PALETTE } from './scene.js';
import { DEFAULT_LIVERY, type Livery } from '../data/liveries.js';

export interface CarViewOptions {
  /**
   * Render as a ghost: translucent, unlit-ish, no shadow and no contact
   * markers. It has to be legible enough to chase and faint enough that it is
   * never mistaken for the car you are driving.
   */
  ghost?: boolean;
  /**
   * Body colour. Rival cars in a network race are told apart by paint, which
   * is the only cue that survives all four of them being sideways in a cloud
   * of gravel at once.
   */
  body?: number;
  /** Full paint scheme, overriding `body`. */
  livery?: Livery;
  /** Competition number, painted on the roof and the doors. */
  number?: number;
}

const flat = (color: number, roughness = 0.6, ghost = false) =>
  new THREE.MeshStandardMaterial({
    color: ghost ? 0x5fd0ff : color,
    roughness,
    metalness: 0.05,
    flatShading: true,
    ...(ghost
      ? { transparent: true, opacity: 0.34, depthWrite: false, emissive: 0x143a4a }
      : {}),
  });

/**
 * Deterministic value noise from a position, 0..1.
 *
 * Keyed off the vertex rather than drawn from a stream, so the same car
 * crumples identically on every machine rendering it — which matters the moment
 * two people are looking at the same car in a network race.
 */
function hash3(x: number, y: number, z: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * A number plate, drawn to a canvas.
 *
 * One number in one weight, and it has to change the instant the player types a
 * different one — which is a texture generated in four lines rather than an
 * atlas and a pipeline.
 */
function numberTexture(value: number, ink: number, ground: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const draw = canvas.getContext('2d')!;

  const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
  // A rounded panel rather than the whole face: a decal with a visible edge
  // reads as something applied to the car, and a full-bleed one reads as the
  // panel simply being a different colour.
  draw.fillStyle = hex(ground);
  draw.beginPath();
  draw.roundRect(10, 18, size - 20, size - 36, 12);
  draw.fill();

  draw.fillStyle = hex(ink);
  draw.font = 'bold 78px ui-monospace, "SF Mono", Menlo, monospace';
  draw.textAlign = 'center';
  draw.textBaseline = 'middle';
  draw.fillText(String(value), size / 2, size / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Steel showing through the paint along a fold.
 *
 * Paint does not bend; it cracks off the ridge of a crease and leaves primer
 * and bare metal behind. A panel that only darkens reads as dirty, and a panel
 * with bright metal along its ridges reads as bent.
 */
const BARE_METAL = new THREE.Color(0x9aa0a6);

/**
 * Spacing of the fold planes, metres.
 *
 * Crumpled sheet does not curve, it kinks: it buckles onto a few flat facets
 * that meet at hard lines. Snapping displaced vertices onto planes this far
 * apart is what produces those lines, and it is the single thing that most
 * separates folded metal from a dented balloon. Roughly a hand's width, which
 * is about the size of a real buckle in a door skin.
 */
const CREASE = 0.13;

/** A crazed windscreen: milky, not shattered — this car still has to be driven. */
const WINDSCREEN_CRAZED = new THREE.Color(0xd8dee3);

/** Disc colours: cool cast iron, heat-tinted bronze, cherry red, and white heat. */
const DISC_COLD = new THREE.Color(0x8d949c);
const DISC_TINT = new THREE.Color(0x6b4a34);
const DISC_GLOW = new THREE.Color(0xff3b12);
const DISC_WHITE = new THREE.Color(0xffd9a0);

export class CarView {
  readonly group = new THREE.Group();

  private readonly chassis = new THREE.Group();
  private readonly wheels: THREE.Group[] = [];
  private readonly discs: THREE.Mesh[] = [];

  private readonly ghost: boolean;
  /** The number painted on this car. Kept so a repaint can keep it. */
  private raceNumber = 0;
  /** Meshes that take each of the livery's three colours. */
  private readonly bodyMeshes: THREE.Mesh[] = [];
  private readonly trimMeshes: THREE.Mesh[] = [];
  private accentMesh: THREE.Mesh | null = null;
  /** Roof and door numbers, which are redrawn when the number changes. */
  private readonly decals: THREE.Mesh[] = [];

  /**
   * Undeformed vertex positions of everything that can crumple.
   *
   * Deformation is applied from these each time rather than accumulated onto
   * the live geometry: a car that folded a little further on every frame would
   * fold itself flat in about ten seconds.
   */
  private readonly restGeometry = new Map<THREE.Mesh, Float32Array>();
  /** Signature of the damage the current geometry was built from. */
  private shapeKey = -1;
  /** Bumped by a repaint, so the vertex colours are rebuilt with the new paint. */
  private paintEpoch = 0;
  /**
   * How each deformable mesh folds: which of its own axes collapses, which way
   * is outward along it, how far the mesh reaches that way, and which
   * components' health drives the fold.
   */
  /**
   * The livery colour a deformable mesh wears.
   *
   * Its material is held at white so the vertex colours can carry the paint,
   * so the material is no longer where the paint can be read from.
   */
  private readonly paintOf = new Map<THREE.Mesh, THREE.Color>();
  /** How far gone each corner's suspension is, 0..1, read by the wheel pose. */
  private readonly cornerDamage: [number, number, number, number] = [0, 0, 0, 0];
  /** Rest vertices of the windscreen, which shatters rather than folding. */
  private screenRestGeometry: Float32Array | null = null;
  /** Windscreen health the glass was last built for. */
  private glassAt = -1;
  private readonly folds = new Map<
    THREE.Mesh,
    { axis: 0 | 1 | 2; sign: number; half: [number, number, number]; components: ComponentId[] }
  >();
  /** Undamaged pose of each deformable part, to deform away from. */
  private readonly restPose = new Map<THREE.Mesh, { position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }>();
  private nose!: THREE.Mesh;
  /** Headlight beams, and the glowing lamp faces that go with them. */
  private readonly headlights: THREE.SpotLight[] = [];
  private readonly lamps: THREE.Mesh[] = [];
  /** How much headlights matter here: 0 in daylight, 1 at night. */
  private headlightWeight = 0;
  private cabin!: THREE.Mesh;
  private body!: THREE.Mesh;
  private screen!: THREE.Mesh;
  /** The panels that can come off, and where they sit while they are still on. */
  private readonly parts = new Map<PartId, THREE.Mesh>();
  private readonly partRest = new Map<PartId, THREE.Vector3>();
  /** Which component's health deforms each panel. */
  private readonly partComponent = new Map<PartId, ComponentId>();

  constructor(parent: THREE.Object3D, options: CarViewOptions = {}) {
    const h = CAR.halfExtents;
    const isGhost = options.ghost === true;
    const livery = options.livery ?? DEFAULT_LIVERY;
    const bodyColor = options.body ?? livery.body;
    const trimColor = options.body === undefined ? livery.trim : PALETTE.carCabin;
    const accentColor = options.body === undefined ? livery.accent : PALETTE.carAccent;
    this.ghost = isGhost;

    // Segmented, not because the shape needs it but because a box with eight
    // corners cannot be dented: crumple is vertices moving, and a face with no
    // vertices in the middle of it can only ever be scaled.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 2, h.y * 1.3, h.z * 2, 8, 5, 11),
      flat(bodyColor, 0.6, isGhost),
    );
    body.position.y = -0.05;
    body.castShadow = !isGhost;
    this.chassis.add(body);

    // Cabin, set back and narrowed — this is what makes the direction of travel
    // readable at a glance from a fixed isometric angle.
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.62, h.y * 1.0, h.z * 0.92, 6, 5, 6),
      flat(trimColor, 0.4, isGhost),
    );
    cabin.position.set(0, h.y * 1.05, -0.16);
    cabin.castShadow = !isGhost;
    this.chassis.add(cabin);

    // Nose wedge in the bright accent colour: an unmistakable "this end is the
    // front" cue, which matters enormously when the car is sideways under a
    // fixed camera and you have to read its heading instantly.
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.5, h.y * 0.42, h.z * 0.34, 7, 4, 4),
      flat(accentColor, 0.5, isGhost),
    );
    nose.position.set(0, h.y * 0.42, h.z * 0.86);
    nose.castShadow = !isGhost;
    this.chassis.add(nose);

    // Rear wing, in the dark cabin colour rather than the nose accent — two
    // bright ends would make the car's heading ambiguous at a glance.
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.95, h.y * 0.16, h.z * 0.2, 7, 3, 3),
      flat(trimColor, 0.5, isGhost),
    );
    wing.position.set(0, h.y * 1.55, -h.z * 0.92);
    wing.castShadow = !isGhost;
    this.chassis.add(wing);

    // Bolt-on panels, each its own mesh.
    //
    // Two reasons, and both are gameplay rather than decoration: a panel has to
    // be able to *leave*, and a panel that deforms on its own shows you where
    // the car was hit. One body mesh can only say "damaged"; twelve say "the
    // front left is folded in and the mirror is gone", which is a thing you can
    // look at and price.
    const panelMat = () => flat(bodyColor, 0.55, isGhost);
    const trimMat = () => flat(trimColor, 0.55, isGhost);

    const box = (x: number, y: number, z: number) =>
      // A 3x2x3 box has about four vertices under a dent, which cannot show a
      // fold at all — the crease had nowhere to land and every impact came out
      // as a smooth bowl. Six segments an axis is a few hundred extra vertices
      // across the whole car, reshaped a handful of times in a race.
      new THREE.BoxGeometry(x, y, z, 6, 4, 6);
    /** id, geometry, position, material, and the component that deforms it. */
    const panels: [PartId, THREE.BoxGeometry, [number, number, number], THREE.Material, ComponentId][] = [
      ['bonnet', box(h.x * 1.5, h.y * 0.12, h.z * 0.6), [0, h.y * 0.62, h.z * 0.42], panelMat(), 'bonnet'],
      ['boot', box(h.x * 1.45, h.y * 0.12, h.z * 0.42), [0, h.y * 0.6, -h.z * 0.62], panelMat(), 'boot'],
      ['bumperFront', box(h.x * 1.72, h.y * 0.24, h.z * 0.12), [0, -h.y * 0.28, h.z * 0.99], trimMat(), 'panelFront'],
      ['bumperRear', box(h.x * 1.72, h.y * 0.24, h.z * 0.12), [0, -h.y * 0.28, -h.z * 0.99], trimMat(), 'panelRear'],
      ['wingFL', box(h.x * 0.16, h.y * 0.5, h.z * 0.42), [h.x * 0.98, h.y * 0.15, h.z * 0.6], panelMat(), 'wingFL'],
      ['wingFR', box(h.x * 0.16, h.y * 0.5, h.z * 0.42), [-h.x * 0.98, h.y * 0.15, h.z * 0.6], panelMat(), 'wingFR'],
      ['doorLeft', box(h.x * 0.12, h.y * 0.62, h.z * 0.5), [h.x * 1.02, h.y * 0.2, -0.08], panelMat(), 'doorL'],
      ['doorRight', box(h.x * 0.12, h.y * 0.62, h.z * 0.5), [-h.x * 1.02, h.y * 0.2, -0.08], panelMat(), 'doorR'],
      ['quarterRL', box(h.x * 0.16, h.y * 0.5, h.z * 0.42), [h.x * 0.98, h.y * 0.15, -h.z * 0.62], panelMat(), 'quarterRL'],
      ['quarterRR', box(h.x * 0.16, h.y * 0.5, h.z * 0.42), [-h.x * 0.98, h.y * 0.15, -h.z * 0.62], panelMat(), 'quarterRR'],
      ['mirrorL', box(0.1, 0.1, 0.16), [h.x * 1.12, h.y * 0.62, h.z * 0.3], trimMat(), 'mirrorL'],
      ['mirrorR', box(0.1, 0.1, 0.16), [-h.x * 1.12, h.y * 0.62, h.z * 0.3], trimMat(), 'mirrorR'],
      ['exhaust', box(0.1, 0.1, h.z * 0.3), [h.x * 0.45, -h.y * 0.62, -h.z * 1.02], trimMat(), 'exhaust'],
      ['wing', box(h.x * 1.95, h.y * 0.16, h.z * 0.2), [0, h.y * 1.55, -h.z * 0.92], trimMat(), 'panelRear'],
    ];

    // Which of the three livery colours each bolt-on panel wears.
    const trimParts = new Set<PartId>([
      'bumperFront',
      'bumperRear',
      'mirrorL',
      'mirrorR',
      'exhaust',
      'wing',
    ]);

    for (const [id, geometry, position, material, component] of panels) {
      // The rear wing was built above so the nose/cabin block could reference
      // it; everything else is created here.
      const mesh = id === 'wing' ? wing : new THREE.Mesh(geometry, material);
      if (id !== 'wing') {
        mesh.position.set(position[0], position[1], position[2]);
        this.chassis.add(mesh);
      }
      mesh.castShadow = !isGhost;
      (trimParts.has(id) ? this.trimMeshes : this.bodyMeshes).push(mesh);
      this.parts.set(id, mesh);
      this.partRest.set(id, mesh.position.clone());
      this.partComponent.set(id, component);
      if (!isGhost) this.keepRestGeometry(mesh, [component]);
      this.restPose.set(mesh, {
        position: mesh.position.clone(),
        scale: mesh.scale.clone(),
        color: this.paintOf.get(mesh)?.clone() ?? (mesh.material as THREE.MeshStandardMaterial).color.clone(),
      });
    }

    // The windscreen is not detachable, but it does crack and darken, and it is
    // the one panel whose damage is read from inside the silhouette.
    const screen = new THREE.Mesh(
      box(h.x * 1.4, h.y * 0.5, h.z * 0.06),
      flat(0x9fb6c4, 0.2, isGhost),
    );
    screen.position.set(0, h.y * 1.0, h.z * 0.36);
    screen.castShadow = false;
    this.chassis.add(screen);
    this.screen = screen;
    this.restPose.set(screen, {
      position: screen.position.clone(),
      scale: screen.scale.clone(),
      color: (screen.material as THREE.MeshStandardMaterial).color.clone(),
    });

    this.group.add(this.chassis);

    const tireGeo = new THREE.CylinderGeometry(CAR.wheelRadius, CAR.wheelRadius, 0.26, 20);
    tireGeo.rotateZ(Math.PI / 2); // cylinder axis along local X, i.e. the axle
    const tireMat = flat(PALETTE.tire, 0.9, isGhost);
    const hubGeo = new THREE.BoxGeometry(0.28, CAR.wheelRadius * 0.9, CAR.wheelRadius * 0.9);
    const hubMat = flat(0xb9c0c9, 0.4, isGhost);
    // The disc is a ring on the *outboard* face, which is how you see one on a
    // real car: through the wheel, around the hub. A cylinder tucked inside the
    // tyre was invisible from an isometric camera — the tyre is in front of it.
    // MeshBasic because a hot disc emits its own light, and has to read at
    // night, which is when it matters most.
    const discGeo = new THREE.RingGeometry(CAR.wheelRadius * 0.42, CAR.wheelRadius * 0.76, 24);
    discGeo.rotateY(Math.PI / 2);

    for (let i = 0; i < 4; i++) {
      const wheel = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.castShadow = !isGhost;
      wheel.add(tire);
      // The hub spins with the wheel and makes rotation (and lockup) visible.
      wheel.add(new THREE.Mesh(hubGeo, hubMat));
      // Each disc owns its material: four corners reach four temperatures, and
      // the front pair does most of the work.
      const disc = new THREE.Mesh(
        discGeo,
        new THREE.MeshBasicMaterial({ color: DISC_COLD, side: THREE.DoubleSide }),
      );
      // Outboard face. Wheel 0 is the front left, and the car's left is +X.
      disc.position.x = i % 2 === 0 ? 0.135 : -0.135;
      wheel.add(disc);
      this.discs.push(disc);
      this.wheels.push(wheel);
      this.group.add(wheel);

    }

    parent.add(this.group);

    this.body = body;
    this.cabin = cabin;
    this.nose = nose;
    this.bodyMeshes.push(body);
    this.trimMeshes.push(cabin, wing);
    this.accentMesh = nose;
    // Registered before the paint pass, not after it: `keepRestGeometry` moves
    // a mesh's paint into its vertex colours, and `setLivery` has to already
    // know which meshes carry their colour that way.
    const hull: [THREE.Mesh, ComponentId[]][] = [
      [body, ['panelLeft', 'panelRight', 'panelFloor']],
      [cabin, ['panelRoof']],
      [nose, ['panelFront']],
      [wing, ['panelRear']],
    ];
    for (const [mesh, components] of hull) {
      if (!isGhost) this.keepRestGeometry(mesh, components);
      this.restPose.set(mesh, {
        position: mesh.position.clone(),
        scale: mesh.scale.clone(),
        color: this.paintOf.get(mesh)?.clone() ?? (mesh.material as THREE.MeshStandardMaterial).color.clone(),
      });
    }

    if (!isGhost) {
      this.buildHeadlights(h);
      this.buildDecals(h);
      this.setLivery(livery, options.number ?? 0);
    }

  }

  /**
   * The competition number, on the roof and on both doors.
   *
   * On the roof because of the camera: from a fixed isometric view the roof is
   * the largest flat surface the player ever sees, and it is the one panel that
   * is never hidden by the car's own body. The doors are for the garage
   * turntable, where the car is seen from the side.
   *
   * Drawn to a canvas rather than shipped as an atlas — it is one number in one
   * weight, it has to change the instant the player types a different one, and
   * a texture generated in four lines beats a pipeline.
   */
  private buildDecals(h: { x: number; y: number; z: number }): void {
    const roof = new THREE.Mesh(
      new THREE.PlaneGeometry(h.x * 1.1, h.z * 0.62),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
    );
    // Face-up, with the top of the number toward the nose: that is which way
    // round a competition number is painted, and from a fixed isometric camera
    // the roof is the panel the player looks at most.
    roof.rotation.set(-Math.PI / 2, 0, Math.PI);
    roof.position.set(0, h.y * 1.56, -0.16);
    this.chassis.add(roof);
    this.decals.push(roof);

    for (const side of [-1, 1] as const) {
      const door = new THREE.Mesh(
        new THREE.PlaneGeometry(h.z * 0.52, h.y * 0.66),
        new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
      );
      door.rotation.y = (side * Math.PI) / 2;
      door.position.set(side * h.x * 1.09, h.y * 0.22, -0.08);
      this.chassis.add(door);
      this.decals.push(door);
    }
  }

  /**
   * Repaint the car, live.
   *
   * The garage turntable has to change the moment a livery is picked, and the
   * rest pose has to change with it — damage darkens each panel *from its own
   * colour*, so a repaint that forgot the rest pose would have a scuffed wing
   * fade back toward the paint it used to wear.
   */
  setLivery(livery: Livery, raceNumber = this.raceNumber): void {
    this.raceNumber = raceNumber;
    if (this.ghost) return;

    const paint = (meshes: THREE.Mesh[], color: number) => {
      for (const mesh of meshes) {
        const rest = this.restPose.get(mesh);
        if (rest) rest.color.setHex(color);
        // A deformable panel keeps its paint in its vertices and its material
        // at white; painting the material as well would multiply the two.
        const base = this.paintOf.get(mesh);
        if (base) {
          base.setHex(color);
          this.fillColour(mesh, base);
        } else {
          (mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
        }
      }
    };
    // Force the next reshape to re-lay the vertex colours, or a repaint made
    // over a damaged car would leave the creases wearing the old livery.
    this.paintEpoch++;
    this.shapeKey = -1;
    paint(this.bodyMeshes, livery.body);
    paint(this.trimMeshes, livery.trim);
    if (this.accentMesh) paint([this.accentMesh], livery.accent);

    const texture = numberTexture(raceNumber, livery.number, livery.numberBack);
    for (const decal of this.decals) {
      const material = decal.material as THREE.MeshBasicMaterial;
      material.map?.dispose();
      material.map = texture;
      material.visible = raceNumber > 0;
      material.needsUpdate = true;
    }
  }

  /**
   * Remember a mesh's undamaged vertices, and give it geometry of its own.
   *
   * The panels are built from a shared `box()` helper, and two panels sharing
   * one BufferGeometry would crumple as one — a dent in the left door would
   * appear in the right one too.
   */
  private keepRestGeometry(mesh: THREE.Mesh, components: ComponentId[] = []): void {
    if (this.restGeometry.has(mesh)) return;
    mesh.geometry = mesh.geometry.clone();
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const rest = Float32Array.from(position.array as Float32Array);
    this.restGeometry.set(mesh, rest);

    // Paint moves into the vertices. A crease has to be able to show bare metal
    // along its ridge while the flat beside it keeps the livery, and one colour
    // on the material can only ever say one of those two things.
    const material = mesh.material as THREE.MeshStandardMaterial;
    const base = material.color.clone();
    this.paintOf.set(mesh, base);
    material.vertexColors = true;
    material.color.setHex(0xffffff);
    mesh.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array((rest.length / 3) * 3), 3),
    );
    this.fillColour(mesh, base);

    // Which of the mesh's own axes collapses, and which way along it is
    // outward. Taken from where the part sits on the car: a door faces
    // sideways and folds across the car, a bonnet faces forward and
    // concertinas along it. The hull sits at the middle and has no facing, so
    // it pinches across its flanks.
    let half: [number, number, number] = [0.001, 0.001, 0.001];
    for (let i = 0; i < rest.length; i += 3) {
      half[0] = Math.max(half[0], Math.abs(rest[i]!));
      half[1] = Math.max(half[1], Math.abs(rest[i + 1]!));
      half[2] = Math.max(half[2], Math.abs(rest[i + 2]!));
    }
    const away = [mesh.position.x, mesh.position.y, mesh.position.z];
    let axis: 0 | 1 | 2 = 0;
    for (const a of [1, 2] as const) if (Math.abs(away[a]!) > Math.abs(away[axis]!)) axis = a;
    const sign = Math.abs(away[axis]!) < 0.05 ? 1 : Math.sign(away[axis]!);
    this.folds.set(mesh, { axis, sign, half, components });
  }

  /** Lay one flat colour into a mesh's vertex colours. */
  private fillColour(mesh: THREE.Mesh, color: THREE.Color): void {
    const attribute = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attribute) return;
    const array = attribute.array as Float32Array;
    for (let i = 0; i < array.length; i += 3) {
      array[i] = color.r;
      array[i + 1] = color.g;
      array[i + 2] = color.b;
    }
    attribute.needsUpdate = true;
  }

  /**
   * Headlights.
   *
   * Two spotlights down the nose, plus the lamp faces that show they are lit.
   * Their intensity and reach come from the `lights` component, which until now
   * was a repair line with nothing behind it — 260 to fix something that had
   * never once mattered. On a night variant it decides whether you can see the
   * next corner.
   */
  private buildHeadlights(h: { x: number; y: number; z: number }): void {
    const lampGeo = new THREE.BoxGeometry(0.3, 0.16, 0.1);

    for (const side of [-1, 1]) {
      // Decay 0: this is an arcade light meant to reach 90 m of road, not a
      // physically-falling-off lamp. With realistic decay the beam dies a few
      // metres from the bumper and lights nothing you need to see.
      const beam = new THREE.SpotLight(0xfff0d0, 0, 95, 0.55, 0.45, 0);
      beam.position.set(side * h.x * 0.62, h.y * 0.35, h.z * 0.95);
      // The target has to be parented to the car too, or the beam stays
      // pointing at wherever the car happened to be when the scene was built.
      beam.target.position.set(side * h.x * 0.62, -h.y * 0.6, h.z * 0.95 + 18);
      this.chassis.add(beam);
      this.chassis.add(beam.target);
      this.headlights.push(beam);

      const lamp = new THREE.Mesh(
        lampGeo,
        new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 0 }),
      );
      lamp.position.set(side * h.x * 0.55, h.y * 0.35, h.z * 0.99);
      this.chassis.add(lamp);
      this.lamps.push(lamp);
    }
  }

  /** Tell the car how much the headlights matter here. */
  setHeadlightWeight(weight: number): void {
    this.headlightWeight = weight;
  }

  /**
   * Deform and discolour the car to match its condition.
   *
   * The damage panel says what is broken; this makes it visible on the thing
   * you are actually looking at. A crumpled nose and a sunken corner are read
   * without taking your eyes off the road, which an abstract readout never is.
   *
   * Purely presentational — nothing here feeds back into the simulation.
   */
  /**
   * Fold the metal.
   *
   * One pass, from the rest vertices, doing three things that used to be done
   * in two places and fought each other:
   *
   * 1. **Buckle**, from component health. The panel collapses along the axis it
   *    faces and *fattens across the other two* — the metal has to go
   *    somewhere. The old version scaled the whole mesh down instead, which is
   *    why a wrecked car read as a small tidy car rather than a wrecked one:
   *    at full damage the silhouette shrank by half and the dents went with it.
   * 2. **Dents**, from where the car was actually hit. Same as before, except
   *    the core pushes in and a ring around it pushes *out*, so a dent displaces
   *    metal rather than deleting it.
   * 3. **Creases**. Displacement is snapped onto planes `CREASE` apart, so the
   *    fold lands on flat facets meeting at hard lines. Sheet metal kinks; it
   *    does not curve. With `flatShading` the normals follow for free, and this
   *    is the single change that most makes the result read as bent metal.
   *
   * Bare steel is written into the vertex colours wherever the surface moved,
   * because paint cracks off a ridge — a panel that only darkens reads as
   * dirty rather than damaged.
   *
   * Rebuilt only when the damage or the paint changes. Both change a handful of
   * times in a race and never between them, and reshaping the whole car is not
   * something to do sixty times a second for no reason.
   */
  private reshape(damage: DamageLike): void {
    // Health is quantised into 24ths: a fold that rebuilt on every hundredth of
    // a percent of wear would rebuild every frame the car was touching anything.
    let key = damage.dentVersion * 131 + this.paintEpoch * 7;
    for (const [, fold] of this.folds) {
      for (const c of fold.components) key = (key * 31 + Math.round(damage.get(c) * 24)) | 0;
    }
    if (key === this.shapeKey) return;
    this.shapeKey = key;

    for (const [mesh, rest] of this.restGeometry) {
      const attribute = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const array = attribute.array as Float32Array;
      const colors = (mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined)
        ?.array as Float32Array | undefined;
      const fold = this.folds.get(mesh)!;
      const paint = this.paintOf.get(mesh) ?? new THREE.Color(0xffffff);

      // Worst of the components this panel answers to: a hull with a folded
      // left flank is folded, whatever the right one is doing.
      let health = 1;
      for (const c of fold.components) health = Math.min(health, damage.get(c));
      const wear = 1 - health;

      const { axis, sign, half } = fold;
      const across: [number, number] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];

      for (let i = 0; i < array.length; i += 3) {
        const local = [rest[i]!, rest[i + 1]!, rest[i + 2]!];
        const move = [0, 0, 0];

        // --- 1. buckle, and the swell that pays for it ---------------------
        if (wear > 0.01) {
          // 1 at the face that took the hit, 0 at the far side.
          const t = Math.min(Math.max((sign * local[axis]! / half[axis]! + 1) * 0.5, 0), 1);
          // Not linear in wear. A panel at 40% is bent; a panel at 0% has had
          // the structure behind it fold, and it should not look like a
          // slightly worse version of bent. The exponent keeps ordinary racing
          // damage where it was and lets a written-off car actually collapse.
          const squeeze = wear ** 1.5 * 0.62 * t ** 1.6;
          move[axis]! -= sign * squeeze * half[axis]!;
          // Displaced metal goes sideways. Proportional to how far the vertex
          // already is from the mesh's own axis, so the panel splays rather
          // than inflating uniformly. Kept well under the squeeze: at parity
          // the panels splay into plates wider than the car they are on.
          for (const b of across) move[b]! += local[b]! * squeeze * 0.32;
        }

        // --- 2. dents ------------------------------------------------------
        // The vertex in the car's frame, which is the frame the dents are in.
        const x = local[0]! + mesh.position.x;
        const y = local[1]! + mesh.position.y;
        const z = local[2]! + mesh.position.z;

        for (const dent of damage.dents) {
          const ox = dent.at.x - x;
          const oy = dent.at.y - y;
          const oz = dent.at.z - z;
          const distance = Math.hypot(ox, oy, oz);
          if (distance > dent.reach) continue;

          // Sharp at the point of contact, crossing zero at a third of the
          // reach and pushing outward beyond it: the fold has a lip, the way a
          // real one does, and the panel keeps roughly the volume it had.
          const t = distance / dent.reach;
          const shape = (1 - t) ** 2 * (1 - 3 * t);
          const push = (shape > 0 ? shape : shape * 2.4) * dent.depth * 0.9;
          const scale = distance > 1e-4 ? push / distance : 0;
          move[0]! += ox * scale;
          move[1]! += oy * scale;
          move[2]! += oz * scale;

          // Torn rather than pressed: a few centimetres of deterministic
          // noise, keyed off the vertex position so the same car crumples the
          // same way on every machine showing it.
          const wobble = Math.abs(shape) * dent.depth * 0.1;
          move[0]! += (hash3(x, y, z) - 0.5) * wobble;
          move[1]! += (hash3(y, z, x) - 0.5) * wobble;
          move[2]! += (hash3(z, x, y) - 0.5) * wobble;
        }

        // A panel with nothing left splits: the fold runs out of metal and the
        // sheet tears along the crease rather than carrying on bending. Keyed
        // off the same hashed noise so it is deterministic, and only in the
        // last fifth of the wear, where the alternative is a panel that is
        // merely very bent.
        if (wear > 0.8) {
          const tear = (wear - 0.8) * 5;
          const rip = (hash3(local[0]! * 7.3, local[1]! * 5.1, local[2]! * 3.7) - 0.45) * tear * 0.34;
          for (const b of across) move[b]! += Math.sign(local[b]! || 1) * Math.max(rip, 0);
        }

        // --- 3. creases ----------------------------------------------------
        // Pull the displaced surface onto discrete planes. Weighted by how far
        // this vertex actually moved, so undamaged metal stays exactly where it
        // was and only the folded part facets.
        const moved = Math.hypot(move[0]!, move[1]!, move[2]!);
        let crease = 0;
        if (moved > 0.004) {
          const bite = Math.min(moved * 5, 0.85);
          for (let a = 0; a < 3; a++) {
            const at = local[a]! + move[a]!;
            const snap = (Math.round(at / CREASE) * CREASE - at) * bite;
            move[a]! += snap;
            crease += Math.abs(snap);
          }
        }

        array[i] = local[0]! + move[0]!;
        array[i + 1] = local[1]! + move[1]!;
        array[i + 2] = local[2]! + move[2]!;

        // --- bare metal along the folds ------------------------------------
        if (colors) {
          // Keyed to the crease correction rather than to total displacement.
          // Paint cracks off a ridge, not off a panel that has been pushed
          // bodily inward — driven off the whole move, a folded car went
          // uniformly grey and lost its livery entirely. Capped short of bare,
          // because even a wreck has paint left between its creases.
          const exposed = Math.min(crease / 0.075, 1) ** 1.2 * 0.62;
          const dull = 1 - wear * 0.3;
          colors[i] = (paint.r * (1 - exposed) + BARE_METAL.r * exposed) * dull;
          colors[i + 1] = (paint.g * (1 - exposed) + BARE_METAL.g * exposed) * dull;
          colors[i + 2] = (paint.b * (1 - exposed) + BARE_METAL.b * exposed) * dull;
        }
      }

      attribute.needsUpdate = true;
      const colorAttribute = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (colorAttribute) colorAttribute.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }
  }

  private applyDamage(damage: DamageLike): void {
    /**
     * Where a damaged panel *sits*. What it looks like is `reshape`'s job.
     *
     * This used to scale the mesh down along its axis, which is why a badly
     * wrecked car read as a neat small car: at full damage every panel was half
     * its size and the silhouette shrank instead of getting uglier. Metal that
     * folds does not go away, so nothing here touches scale any more — a
     * damaged panel is only shoved into the car and left rough.
     */
    const shove = (mesh: THREE.Mesh, health: number, axis: 'x' | 'y' | 'z', shift: number) => {
      const rest = this.restPose.get(mesh);
      if (!rest) return;
      const hurt = 1 - health;

      mesh.scale.copy(rest.scale);
      mesh.position.copy(rest.position);
      mesh.position[axis] = rest.position[axis] - shift * hurt;
      (mesh.material as THREE.MeshStandardMaterial).roughness = 0.6 + hurt * 0.35;
    };

    shove(this.nose, damage.get('panelFront'), 'z', 0.3);
    shove(this.cabin, damage.get('panelRoof'), 'y', 0.16);
    shove(this.body, Math.min(damage.get('panelLeft'), damage.get('panelRight')), 'x', 0);

    // Every bolt-on panel folds along the axis it faces, toward the middle of
    // the car, and takes a twist with it. The twist is what turns a uniform
    // squash into something that reads as crumpled: a dented wing sits skewed,
    // not merely smaller.
    for (const [id, mesh] of this.parts) {
      const component = this.partComponent.get(id);
      if (!component) continue;
      const rest = this.partRest.get(id)!;
      const health = damage.get(component);
      const hurt = 1 - health;

      // Panels on the flanks fold inward across the car; ends fold along it.
      const lateral = Math.abs(rest.x) > 0.5;
      shove(mesh, health, lateral ? 'x' : 'z', lateral ? Math.sign(rest.x) * 0.1 : Math.sign(rest.z) * 0.18);
      if (hurt > 0.02) {
        // Signed from the panel's own position so the two sides fold opposite
        // ways rather than all leaning together. Halved when the panels stopped
        // shrinking: 39 degrees on a full-size door swings it clear of the car
        // and reads as a plate lying on the roof rather than as a folded skin.
        const twist = hurt * 0.34;
        mesh.rotation.set(
          lateral ? 0 : twist * Math.sign(rest.z || 1),
          twist * 0.6 * Math.sign(rest.x || 1),
          lateral ? twist * Math.sign(rest.x || 1) : twist * 0.4,
        );
      } else {
        mesh.rotation.set(0, 0, 0);
      }
    }

    this.applyGlass(damage);

    // Headlights: below half health one side dies outright, so the beam goes
    // lopsided before it goes dark. That is a far more useful warning than a
    // dimmer being turned down evenly.
    const lightsHealth = damage.get('lights');
    for (let i = 0; i < this.headlights.length; i++) {
      const sideAlive = i === 0 || lightsHealth > 0.5;
      const strength = sideAlive ? lightsHealth : 0;
      const beam = this.headlights[i]!;
      beam.intensity = strength * this.headlightWeight * 30;
      beam.distance = 40 + strength * 65;
      beam.angle = 0.4 + strength * 0.18;
      const lamp = this.lamps[i]!.material as THREE.MeshBasicMaterial;
      lamp.opacity = strength * this.headlightWeight;
    }

    for (let i = 0; i < 4; i++) {
      const key = ['FL', 'FR', 'RL', 'RR'][i]!;
      const view = this.wheels[i]!;
      this.cornerDamage[i] = 1 - damage.get(`suspension${key}` as never);
      // A detached wheel is simply gone; a flat one squats on its rim.
      view.visible = damage.get(`hub${key}` as never) > 0;
      const tyre = damage.get(`tyre${key}` as never);
      view.scale.set(1, tyre <= 0 ? 0.55 : 1, 1);

      // Cold grey → oxidised bronze → red → orange-white, in two stages, the
      // same two the thermal model reports: discolouration first, then light.
      const disc = this.discs[i];
      if (disc) {
        const mat = disc.material as THREE.MeshBasicMaterial;
        mat.color.copy(DISC_COLD).lerp(DISC_TINT, damage.brakeTint(i));
        const glow = damage.brakeGlow(i);
        if (glow > 0) mat.color.lerp(DISC_GLOW, glow).lerp(DISC_WHITE, glow * glow);
      }
    }
  }

  /**
   * The windscreen: crazes, then goes.
   *
   * Glass does not fold, so it gets its own path rather than going through
   * `reshape`. It crazes milky first — that is the part you have to keep
   * driving through — and then, past about a third of its health, it starts
   * losing itself: the pane goes translucent and its vertices scatter, so what
   * is left reads as shards in a frame rather than as a dirty window.
   *
   * Rebuilt only when the health has actually moved, in twentieths.
   */
  private applyGlass(damage: DamageLike): void {
    const rest = this.restPose.get(this.screen);
    if (!rest) return;
    const health = damage.get('windscreen');
    const material = this.screen.material as THREE.MeshStandardMaterial;
    const cracked = 1 - health;

    material.color.copy(rest.color).lerp(WINDSCREEN_CRAZED, cracked);
    material.roughness = 0.2 + cracked * 0.7;

    // Past a third gone the glass starts leaving the frame.
    const blown = Math.min(Math.max((0.35 - health) / 0.35, 0), 1);
    material.transparent = true;
    material.opacity = 1 - blown * 0.86;

    const step = Math.round(blown * 20);
    if (step === this.glassAt) return;
    this.glassAt = step;

    const attribute = this.screen.geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    this.screenRestGeometry ??= Float32Array.from(array);
    const restVerts = this.screenRestGeometry;

    for (let i = 0; i < array.length; i += 3) {
      const x = restVerts[i]!;
      const y = restVerts[i + 1]!;
      const z = restVerts[i + 2]!;
      // Scattered, not folded: each vertex is thrown its own way, so the pane
      // breaks into slivers instead of denting like a panel.
      const throwOut = blown * 0.16;
      array[i] = x + (hash3(x, y, z) - 0.5) * throwOut;
      array[i + 1] = y + (hash3(y, z, x) - 0.5) * throwOut;
      array[i + 2] = z + (hash3(z, x, y) - 0.5) * throwOut * 0.4;
    }
    attribute.needsUpdate = true;
    this.screen.geometry.computeVertexNormals();
  }

  /**
   * Show what the debris model says: a gone part is gone, and a dragging one
   * hangs at one corner and scrapes. The dragging pose is the telegraph — it is
   * the only warning the player gets before the part finally lets go.
   */
  private applyDebris(debris: DebrisLike): void {
    for (const [id, mesh] of this.parts) {
      const state = debris.stateOf(id);
      mesh.visible = state !== 'gone';
      const rest = this.partRest.get(id)!;
      // These poses are applied *after* the damage deformation and deliberately
      // override it: a part that is hanging off is no longer sitting where its
      // dents left it.
      if (state === 'dragging') {
        // Hanging at one corner and flapping. A rigid dragging part reads as a
        // panel that has simply been moved; the flap is what says it is only
        // still attached by one bolt, and it is the last warning the player
        // gets before it lets go.
        const beat = performance.now() * 0.011 + rest.z;
        mesh.position.set(rest.x - 0.12, rest.y - 0.2 + Math.sin(beat) * 0.035, rest.z);
        mesh.rotation.set(Math.sin(beat * 1.3) * 0.16, 0, 0.5 + Math.sin(beat) * 0.12);
      } else if (debris.isLoose(id)) {
        // Sitting proud and skewed: the tell that this one is about to go.
        mesh.position.set(rest.x, rest.y + 0.07, rest.z);
        mesh.rotation.set(-0.18, 0, 0.06);
      }
    }
  }

  /** Where a dragging part touches the road, in world space, for sparks. */
  dragPoint(id: PartId): THREE.Vector3 | null {
    const mesh = this.parts.get(id);
    if (!mesh || !mesh.visible) return null;
    return mesh.getWorldPosition(new THREE.Vector3());
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }

  /** Pose this view from a recorded ghost frame rather than from live sim state. */
  updateFromGhost(sample: GhostSample): void {
    this.group.position.set(sample.position.x, sample.position.y, sample.position.z);
    this.group.quaternion.set(
      sample.rotation.x,
      sample.rotation.y,
      sample.rotation.z,
      sample.rotation.w,
    );
    for (let i = 0; i < 4; i++) {
      const mount = CAR.wheelPositions[i]!;
      const view = this.wheels[i]!;
      // Ghosts do not record suspension travel; it is not visible at this
      // opacity and it would cost four more floats a frame.
      view.position.set(mount.x, mount.y + CAR.suspensionRestLength * 0.5, mount.z);
      view.rotation.set(sample.wheelRotation[i]!, i < 2 ? sample.steer : 0, 0, 'YXZ');
    }
  }

  /**
   * Pose from a recorded crash frame: the car *as it was*, damage and all.
   *
   * `updateFromGhost` above is the other kind of playback and stays as it is —
   * a ghost is a rival's line, drawn translucent, and its damage is nobody's
   * business. This one is the crash cinematic, where the whole point is that
   * the fold appears at the moment of the impact rather than being on the car
   * on the way in.
   */
  updateFromReel(frame: PosedFrame, damage: DamageLike, debris: DebrisLike): void {
    this.applyDamage(damage);
    this.reshape(damage);
    this.applyDebris(debris);

    this.group.position.set(frame.position.x, frame.position.y, frame.position.z);
    this.group.quaternion.set(
      frame.rotation.x,
      frame.rotation.y,
      frame.rotation.z,
      frame.rotation.w,
    );
    for (let i = 0; i < 4; i++) {
      const mount = CAR.wheelPositions[i]!;
      const view = this.wheels[i]!;
      const grounded = frame.wheelGrounded[i] ?? true;
      const compression = frame.wheelCompression[i] ?? 0.5;
      const drop = grounded
        ? (1 - compression) * CAR.suspensionRestLength
        : CAR.suspensionRestLength;
      view.position.set(mount.x, mount.y + CAR.suspensionRestLength - drop, mount.z);
      view.rotation.set(frame.wheelRotation[i]!, i < 2 ? frame.steer : 0, 0, 'YXZ');
    }
  }

  update(
    transform: { position: Vec3; rotation: Quat },
    state: VehicleState,
    damage: DamageModel | null = null,
    debris: DebrisModel | null = null,
  ): void {
    if (this.ghost) return;
    if (damage) {
      this.applyDamage(damage);
      this.reshape(damage);
    }
    if (debris) this.applyDebris(debris);
    const { position, rotation } = transform;
    this.group.position.set(position.x, position.y, position.z);
    this.group.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

    for (let i = 0; i < 4; i++) {
      const w = state.wheels[i]!;
      const mount = CAR.wheelPositions[i]!;
      const view = this.wheels[i]!;

      // Suspension travel: an ungrounded wheel hangs at full droop.
      const drop = w.grounded ? (1 - w.compression) * CAR.suspensionRestLength : CAR.suspensionRestLength;
      // A collapsed corner: the body settles onto the wheel and the wheel
      // leans. Read at a glance from a fixed camera, and it says which corner
      // took the hit before any panel does — a car sitting nose-down on a dead
      // left front is legible in a way a repair list is not.
      const sag = this.cornerDamage[i]!;
      view.position.set(
        mount.x,
        mount.y - drop + CAR.suspensionRestLength * 0.5 + sag * 0.085,
        mount.z,
      );
      // 'YZX': spin about the axle first, then camber, then steer. With the
      // old 'YXZ' the camber went on innermost and the spin carried it round
      // with the wheel, which reads as a wobble rather than a lean.
      view.rotation.set(w.rotation, w.steer, Math.sign(mount.x) * sag * 0.3, 'YZX');

    }
  }
}
