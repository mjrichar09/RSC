/**
 * Stage rendering.
 *
 * Builds the visible corridor from exactly the same vertex data the physics
 * collider uses, so what you drive on is what you see — no second authoring
 * step, and no chance of the two drifting apart.
 *
 * Surfaces are shown as vertex colours rather than textures: it suits the
 * flat-shaded look, it costs one buffer, and it makes a gravel-to-tarmac
 * transition a crisp visible line exactly where the grip actually changes.
 */

import * as THREE from 'three';
import { type PropKind, type Stage } from '../sim/stage.js';
import { CORRIDOR } from '../sim/corridor.js';
import { DRESSING, type SceneryItem, type SceneryKind } from '../sim/scenery.js';
import type { Markers } from '../sim/markers.js';
import type { Vec3 } from '../sim/math.js';
import { SURFACES } from '../sim/surfaces.js';
import { groundHeight } from '../sim/terrain.js';

/** Slight per-vertex value jitter so large flat areas do not read as dead. */
function mottle(index: number): number {
  const n = Math.sin(index * 12.9898) * 43758.5453;
  return 1 + ((n - Math.floor(n)) - 0.5) * 0.08;
}

export interface StageView {
  group: THREE.Group;
  /**
   * Corner boards, which have to be turned to face the camera every frame.
   *
   * A board facing down the road is seen edge-on from an isometric view — it
   * renders as a bright sliver a few pixels wide and reads as nothing. Facing
   * them at the camera's zone yaw when the stage is built is not enough either:
   * the zone at the board is not the zone at the car, so a board goes edge-on
   * exactly when the car is far enough away for it to matter.
   */
  signBoards: THREE.Mesh[];
  /** The marker poles, which have to be re-synced whenever one goes over. */
  markers: MarkerView;
  /** The hazards, whose knock-over-able ones follow their physics bodies. */
  props: PropsView;
  /** The crowd, which gets out of the way. */
  crowd: CrowdView;
  /** The lamps over the start line. */
  startLights: StartLightsView;
  dispose: () => void;
}

/**
 * Build everything visible about a stage.
 *
 * The marker poles come from the simulation's own set rather than a copy, so
 * what is drawn lying flat is exactly what the car knocked over.
 */
export function buildStageView(stage: Stage, markers: Markers): StageView {
  const group = new THREE.Group();
  const { vertices, indices, vertexSurfaces, vertexShade } = stage.geometry;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const colors = new Float32Array(vertexSurfaces.length * 3);
  const c = new THREE.Color();
  for (let i = 0; i < vertexSurfaces.length; i++) {
    c.setHex(SURFACES[vertexSurfaces[i]!].color).multiplyScalar(mottle(i) * vertexShade[i]!);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const road = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
    }),
  );
  road.receiveShadow = true;
  road.castShadow = true;
  group.add(road);

  group.add(buildTerrain(stage));
  group.add(buildGates(stage));
  const first = stage.spline.samples[0]!;
  const startLights = new StartLightsView(first.position, first.left, first.width);
  group.add(startLights.group);
  group.add(buildScenery(stage));
  const crowd = buildCrowd(stage);
  group.add(crowd.group);
  const markerView = buildEdgeMarkers(markers);
  group.add(markerView.group);
  const props = buildProps(stage);
  group.add(props.group);
  const signs = buildSigns(stage);
  group.add(signs.group);
  group.add(buildBridges(stage));

  return {
    group,
    signBoards: signs.boards,
    markers: markerView,
    crowd,
    startLights,
    props,
    dispose: () => {
      geometry.dispose();
      (road.material as THREE.Material).dispose();
    },
  };
}


/**
 * Drawing what the stage says is beside the road.
 *
 * Placement is no longer decided here — `sim/scenery.ts` owns it, because the
 * things beside the road are things the car can hit and the simulation has to
 * know where they are. This file is the other half: what each kind looks like.
 *
 * Two rules shape the geometry. It is instanced, so a tree can afford to be a
 * hundred triangles rather than a cone — three thousand of them is a third of a
 * million, which is a rounding error to any GPU made this decade, and the
 * difference between a wood and a field of traffic cones. And it is read at an
 * isometric distance, so what matters is the silhouette and the one colour
 * break inside it: a pine is a dark spire on a pale trunk, and that trunk is
 * most of what says "tree" from forty metres up.
 */

/** Merge geometries into one, keeping position and normal only. */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  let vertices = 0;
  for (const g of flat) vertices += g.getAttribute('position').count;

  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  let at = 0;
  for (const g of flat) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    position.set(p.array as Float32Array, at * 3);
    normal.set(n.array as Float32Array, at * 3);
    at += p.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  for (let i = 0; i < flat.length; i++) if (flat[i] !== parts[i]) flat[i]!.dispose();
  return merged;
}

/** A cone tier of a conifer: radius, base height, tip height. */
function tier(radius: number, from: number, to: number, segments = 9): THREE.BufferGeometry {
  const cone = new THREE.ConeGeometry(radius, to - from, segments);
  cone.translate(0, from + (to - from) / 2, 0);
  return cone;
}

function trunk(radiusTop: number, radiusBottom: number, height: number): THREE.BufferGeometry {
  const c = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 8);
  c.translate(0, height / 2, 0);
  return c;
}

/**
 * Push every vertex out along its own direction by a seeded amount.
 *
 * A dodecahedron is a rock the way a cube is a house — the right size and
 * obviously manufactured. Displacing it breaks the regularity that gives it
 * away, and it costs nothing because it happens once at build time.
 */
/**
 * Knock the regularity off a solid.
 *
 * Hashed from the vertex *position*, not from its index. Every polyhedron three
 * builds is non-indexed — each triangle carries its own three vertices — so a
 * per-index hash gave the same corner a different displacement on each face
 * touching it, and the solid came apart along every edge. On a dodecahedron at
 * detail 1 that is thirty-six separate triangles drifting away from each other,
 * which at a 2.6 m boulder's scale is gaps you can see through: the big rocks
 * read as a pile of flakes rather than as stone. Hashing the position instead
 * moves a shared corner identically for every face that owns it, so the surface
 * stays closed however finely it is subdivided.
 */
function roughen(geometry: THREE.BufferGeometry, amount: number, seed = 1): THREE.BufferGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    // Quantised before hashing: two faces' copies of one corner are equal to
    // the last bit here, but rounding costs nothing and makes that a property
    // of the code rather than a hope about floating point.
    const key =
      Math.round(v.x * 1024) * 0.1731 + Math.round(v.y * 1024) * 0.3319 + Math.round(v.z * 1024) * 0.5741;
    const n = Math.sin(key + seed * 12.9898) * 43758.5453;
    const jitter = 1 + ((n - Math.floor(n)) - 0.5) * 2 * amount;
    v.multiplyScalar(jitter);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * What a kind is drawn as.
 *
 * `main` takes the recipe's colour, tinted per instance. `extra` is the second
 * material inside the same silhouette — a trunk, a roof, a cap of snow — drawn
 * at the same transform with a fixed colour. Two instanced meshes per recipe
 * rather than one, which is seven extra draw calls for the whole stage and the
 * entire difference between a tree and a green triangle.
 */
interface SceneryParts {
  main: THREE.BufferGeometry;
  extra?: { geometry: THREE.BufferGeometry; color: number };
  /** Whether the silhouette is tall enough to be worth a shadow. */
  casts: boolean;
}

const BARK = 0x4a3a2a;

function sceneryParts(kind: SceneryKind): SceneryParts {
  switch (kind) {
    // A spire in three tiers on a bare lower trunk. The gap between the ground
    // and the lowest branches is what makes a stand of them read as a wood you
    // could see through rather than a hedge.
    case 'conifer':
      return {
        main: mergeParts([tier(1.7, 1.9, 4.4), tier(1.32, 3.6, 6.0), tier(0.9, 5.4, 7.5)]),
        extra: { geometry: trunk(0.2, 0.34, 2.6), color: BARK },
        casts: true,
      };
    // Wider, heavier, four tiers: the shape snow sits on.
    case 'snowFir':
      return {
        main: mergeParts([
          tier(1.9, 1.4, 3.4, 10),
          tier(1.6, 2.8, 4.8, 10),
          tier(1.25, 4.3, 5.9, 10),
          tier(0.85, 5.5, 7.0, 10),
        ]),
        extra: { geometry: trunk(0.22, 0.38, 2.0), color: BARK },
        casts: true,
      };
    // Two overlapping lobes rather than one ball: a single sphere reads as a
    // lollipop, and the second lobe is what makes it a crown.
    case 'broadleaf': {
      const big = new THREE.IcosahedronGeometry(1.9, 1);
      big.scale(1, 0.82, 1);
      big.translate(0, 4.0, 0);
      const small = new THREE.IcosahedronGeometry(1.25, 1);
      small.translate(0.9, 3.1, -0.5);
      return {
        main: mergeParts([roughen(big, 0.09, 3), roughen(small, 0.11, 17)]),
        extra: { geometry: trunk(0.18, 0.3, 3.0), color: BARK },
        casts: true,
      };
    }
    // Trunk and three bare limbs. All silhouette, which is the whole point of
    // it: two per hundred metres, and each one reads at any distance.
    case 'deadTree': {
      const parts: THREE.BufferGeometry[] = [trunk(0.12, 0.32, 5.5)];
      for (let i = 0; i < 3; i++) {
        const limb = new THREE.CylinderGeometry(0.05, 0.11, 1.9, 5);
        limb.translate(0, 0.95, 0);
        limb.rotateZ(0.85 - i * 0.18);
        limb.rotateY((i * Math.PI * 2) / 3);
        limb.translate(0, 3.1 + i * 0.55, 0);
        parts.push(limb);
      }
      return { main: mergeParts(parts), casts: true };
    }
    // Three lobes at different heights. Heather grows in clumps, not in balls.
    case 'bush': {
      const parts: THREE.BufferGeometry[] = [];
      const lobes: [number, number, number, number][] = [
        [1.05, 0, 0.55, 0],
        [0.72, 0.85, 0.4, 0.5],
        [0.6, -0.7, 0.35, -0.4],
      ];
      for (let i = 0; i < lobes.length; i++) {
        const [r, x, y, z] = lobes[i]!;
        const lobe = new THREE.IcosahedronGeometry(r, 1);
        lobe.scale(1, 0.72, 1);
        lobe.translate(x, y, z);
        parts.push(roughen(lobe, 0.14, i * 31 + 7));
      }
      return { main: mergeParts(parts), casts: false };
    }
    // A rock, once the regularity is knocked off it.
    case 'boulder': {
      const stone = new THREE.DodecahedronGeometry(1.1, 1);
      stone.scale(1, 0.78, 1.08);
      return { main: roughen(stone, 0.17, 5), casts: false };
    }
    // Blades, not a cone. Four thin wedges leaning different ways read as grass
    // at the distance the camera actually sits at; one cone reads as a hat.
    case 'tuft': {
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.ConeGeometry(0.2, 1.15, 3);
        blade.translate(0, 0.55, 0);
        blade.rotateZ((i % 2 ? 1 : -1) * (0.18 + i * 0.06));
        blade.rotateY((i * Math.PI) / 4 + 0.3);
        blade.translate((i - 1.5) * 0.16, 0, (i % 3) * 0.12 - 0.12);
        parts.push(blade);
      }
      return { main: mergeParts(parts), casts: false };
    }
    // Walls, then a pitched roof in a second colour. A flat-topped box is a
    // shipping container; the pitch is what makes a street of them a village.
    case 'building': {
      const walls = new THREE.BoxGeometry(6, 6.4, 6);
      walls.translate(0, 3.2, 0);
      const plinth = new THREE.BoxGeometry(6.4, 0.5, 6.4);
      plinth.translate(0, 0.25, 0);
      const roof = new THREE.CylinderGeometry(0, 4.7, 2.9, 4);
      roof.rotateY(Math.PI / 4);
      roof.scale(1, 1, 0.92);
      roof.translate(0, 8.0, 0);
      const eaves = new THREE.BoxGeometry(6.7, 0.35, 6.7);
      eaves.translate(0, 6.5, 0);
      return {
        main: mergeParts([walls, plinth]),
        extra: { geometry: mergeParts([roof, eaves]), color: 0x6b4436 },
        casts: true,
      };
    }
    // Coursed stone with a capstone proud of it, which is what catches the
    // light and tells you it is a wall and not a kerb.
    //
    // Its length runs along local +Z, which is the axis yaw puts down the road.
    // Built across X instead — as it was — every wall on a town stage lay at
    // right angles to the street, and a village came out looking like a flight
    // of steps beside the road rather than a wall along it.
    case 'wall': {
      const body = new THREE.BoxGeometry(0.55, 1.15, 3.4);
      body.translate(0, 0.575, 0);
      const cap = new THREE.BoxGeometry(0.72, 0.22, 3.5);
      cap.translate(0, 1.26, 0);
      return { main: mergeParts([body, cap]), casts: false };
    }
  }
}

/**
 * Build the biome's dressing from the list the stage already scattered.
 *
 * One instanced mesh per recipe, plus one for its second material where it has
 * one. Nothing here decides *where* anything goes: that is the simulation's,
 * and it has to be, or the trees on screen are not the trees the car hits.
 */
function buildScenery(stage: Stage): THREE.Group {
  const group = new THREE.Group();
  const recipes = DRESSING[stage.def.biome] ?? DRESSING.forest!;

  const byRecipe = new Map<number, SceneryItem[]>();
  for (const item of stage.scenery) {
    const list = byRecipe.get(item.recipe);
    if (list) list.push(item);
    else byRecipe.set(item.recipe, [item]);
  }

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color();

  for (const [index, items] of byRecipe) {
    const recipe = recipes[index];
    if (!recipe || items.length === 0) continue;

    const parts = sceneryParts(recipe.kind);
    const mesh = new THREE.InstancedMesh(
      parts.main,
      new THREE.MeshStandardMaterial({
        roughness: 0.9,
        flatShading: true,
        // A floor under the shadowed faces. Scenery is mostly vertical sides,
        // and a vertical side lit only by a blue hemisphere is a navy slab
        // whatever colour it is painted — which is what a village of cream
        // houses actually looked like. Small enough that it never reads as a
        // light source, and it keeps a shape's own colour in its own shadow.
        emissive: recipe.color,
        emissiveIntensity: 0.12,
      }),
      items.length,
    );
    // Only the tall things cast: the shadow camera rides with the car, and a
    // thousand shadow-casting tufts is a bill for something nobody can see.
    mesh.castShadow = parts.casts;
    mesh.receiveShadow = false;

    const extra = parts.extra
      ? new THREE.InstancedMesh(
          parts.extra.geometry,
          new THREE.MeshStandardMaterial({
            color: parts.extra.color,
            roughness: 0.92,
            flatShading: true,
            emissive: parts.extra.color,
            emissiveIntensity: 0.12,
          }),
          items.length,
        )
      : null;
    if (extra) {
      extra.castShadow = false;
      extra.receiveShadow = false;
    }

    const a = new THREE.Color(recipe.color);
    const b = new THREE.Color(recipe.colorB ?? recipe.color);

    const tilt = new THREE.Quaternion();
    const across = new THREE.Vector3(1, 0, 0);

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      position.set(item.position.x, item.position.y, item.position.z);
      scale.set(item.size, item.size * item.stretch, item.size);
      quaternion.setFromAxisAngle(up, item.yaw);
      if (item.pitch !== 0) quaternion.multiply(tilt.setFromAxisAngle(across, item.pitch));
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      extra?.setMatrixAt(i, matrix);
      mesh.setColorAt(i, tint.copy(a).lerp(b, item.mix));
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
    if (extra) {
      extra.instanceMatrix.needsUpdate = true;
      group.add(extra);
    }

    // A cap of snow on the firs, which is most of what says "winter" from a
    // distance — the tree under it is the same tree.
    if (recipe.kind === 'snowFir') {
      const caps = new THREE.InstancedMesh(
        mergeParts([tier(1.75, 1.3, 3.3, 10), tier(1.15, 4.2, 5.8, 10), tier(0.8, 5.4, 7.1, 10)]),
        new THREE.MeshStandardMaterial({ color: 0xeef3f7, roughness: 0.8, flatShading: true }),
        items.length,
      );
      caps.castShadow = false;
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        position.set(item.position.x, item.position.y + 0.12 * item.size, item.position.z);
        scale.set(item.size * 0.97, item.size * item.stretch, item.size * 0.97);
        quaternion.setFromAxisAngle(up, item.yaw);
        matrix.compose(position, quaternion, scale);
        caps.setMatrixAt(i, matrix);
      }
      caps.instanceMatrix.needsUpdate = true;
      group.add(caps);
    }
  }

  return group;
}


/**
 * People at the corners.
 *
 * An empty road is a test track; a road with somebody standing at the outside
 * of the hairpin in a yellow jacket is an event. This is the cheapest way the
 * game gets to say that anyone else in the world cares what happens here, and
 * it costs two instanced meshes.
 *
 * They gather where a crowd actually gathers: the outside of the tightest
 * corners, where a car that gets it wrong will arrive, and at the gates. Nobody
 * is standing on a fast kink in the middle of a forest, because nobody would.
 *
 * Purely visual, and deliberately so — a car cannot hit them and never will.
 * Making them collidable would mean deciding what happens when it does, and
 * that is a different game.
 */
export function buildCrowd(stage: Stage): CrowdView {
  let seed = 0x9e3779b9;
  for (let i = 0; i < stage.def.id.length; i++) seed = (seed * 31 + stage.def.id.charCodeAt(i)) >>> 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const people: Person[] = [];

  /** Somebody standing `out` metres to `side` of the road at `distance`. */
  const stand = (distance: number, side: -1 | 1, out: number, marshal: boolean) => {
    const sample = stage.spline.at(Math.max(Math.min(distance, stage.length - 1), 0));
    const home = new THREE.Vector3(
      sample.position.x + sample.left.x * out * side,
      sample.position.y + CORRIDOR.heightAt(sample.width, out),
      sample.position.z + sample.left.z * out * side,
    );
    // Facing the road: everyone is watching the corner, not the scenery.
    const yaw = Math.atan2(-sample.left.x * side, -sample.left.z * side);
    const coat = marshal
      ? new THREE.Color(random() < 0.5 ? 0xf2c14e : 0xe8552f)
      : new THREE.Color().setHSL(random(), 0.35 + random() * 0.4, 0.28 + random() * 0.3);
    people.push({
      home,
      at: home.clone(),
      // Which way they will go when they move: away from the road, because
      // that is where the space is and where everyone else is not.
      away: new THREE.Vector3(sample.left.x * side, 0, sample.left.z * side).normalize(),
      yaw,
      facing: yaw,
      coat,
      height: 0.9 + random() * 0.22,
      alarm: 0,
      bob: random() * Math.PI * 2,
    });
  };

  // Spectators, at the corners worth watching. Severity is the pacenote scale:
  // 1 is a hairpin, 6 is a kink, so the tighter the corner the bigger the crowd.
  for (const corner of stage.corners) {
    if (corner.severity > 4) continue;
    const outside: -1 | 1 = corner.direction === 'left' ? -1 : 1;
    const count = Math.round((5 - corner.severity) * 2.5 + random() * 3);
    for (let i = 0; i < count; i++) {
      // Spread through the corner and back from the road: a knot at the apex
      // and stragglers either side of it, which is how a crowd actually sits.
      const along = corner.entry + (corner.exit - corner.entry) * (0.15 + random() * 0.9);
      const sample = stage.spline.at(Math.max(Math.min(along, stage.length - 1), 0));
      const out = sample.width + CORRIDOR.vergeWidth + 0.8 + random() * (CORRIDOR.bankWidth - 1.4);
      stand(along, outside, out, random() < 0.12);
    }
  }

  // Marshals at every gate, one either side, because that is where they stand.
  for (const gate of [0, ...stage.checkpoints.map((c) => c.distance), stage.length - 6]) {
    for (const side of [-1, 1] as const) {
      const sample = stage.spline.at(Math.max(Math.min(gate, stage.length - 1), 0));
      stand(gate + (random() - 0.5) * 6, side, sample.width + CORRIDOR.vergeWidth + 1.2, true);
    }
  }

  return new CrowdView(people);
}

interface Person {
  /** Where they stand when nothing is happening. */
  home: THREE.Vector3;
  /** Where they are now. */
  at: THREE.Vector3;
  /** Unit vector away from the road. */
  away: THREE.Vector3;
  /** Facing when settled, and facing now. */
  yaw: number;
  facing: number;
  coat: THREE.Color;
  height: number;
  /** 0 calm, 1 running. Decays once the car has gone. */
  alarm: number;
  /** Phase of their run cycle, such as it is. */
  bob: number;
}

/** How close a car has to be before anyone thinks about moving. */
const SCARE_RANGE = 16;
/** How far back from where they were standing they will go. */
const SCARE_DEPTH = 5;

/**
 * The crowd, and what it does when a car arrives.
 *
 * People standing perfectly still while a rally car comes at them sideways is
 * the single least believable thing left on a stage — real spectators are
 * famous for exactly this, standing in the road until the last possible moment
 * and then not quite standing in it. So they scatter: backwards, away from the
 * road, at a speed that depends on how close the car is, and they wander back
 * once it has gone.
 *
 * They are still not collidable. A car cannot hit them and never will — making
 * them collidable would mean deciding what happens when it does, and that is a
 * different game — but a crowd that gets out of the way says the thing a crowd
 * that ignores you cannot.
 */
export class CrowdView {
  readonly group = new THREE.Group();

  private readonly people: Person[];
  private readonly bodies: THREE.InstancedMesh;
  private readonly heads: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(people: Person[]) {
    this.people = people;
    const count = Math.max(people.length, 1);

    // A body and a head. Two instanced meshes and no animation beyond a bob: at
    // this distance a standing figure is a silhouette, and a walk cycle would
    // cost more than every other thing in this file put together.
    this.bodies = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.17, 0.22, 1.25, 5),
      new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }),
      count,
    );
    this.heads = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.13, 0),
      new THREE.MeshStandardMaterial({ color: 0xc9a68a, roughness: 0.95, flatShading: true }),
      count,
    );
    this.bodies.castShadow = true;
    this.heads.castShadow = false;
    this.bodies.count = people.length;
    this.heads.count = people.length;

    people.forEach((person, i) => this.bodies.setColorAt(i, person.coat));
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    this.group.add(this.bodies, this.heads);
    this.write();
  }

  /**
   * Move anyone the car is about to arrive at.
   *
   * Only people within scaring distance are considered, and the whole crowd is
   * only rewritten when somebody actually moved — a stage's crowd is a couple
   * of hundred figures and almost all of them are somewhere else.
   */
  update(dt: number, car: THREE.Vector3 | { x: number; y: number; z: number }): void {
    let moved = false;

    for (const person of this.people) {
      const dx = person.at.x - car.x;
      const dz = person.at.z - car.z;
      const distance = Math.hypot(dx, dz);

      if (distance < SCARE_RANGE) {
        // Closer is more urgent, and the last few metres are the urgent ones.
        const urgency = 1 - distance / SCARE_RANGE;
        person.alarm = Math.min(1, Math.max(person.alarm, urgency * urgency * 1.8));
      }

      if (person.alarm > 0.002) {
        const back = person.alarm * SCARE_DEPTH;
        // Away from the road, and away from the car: a spectator on the inside
        // of a corner does not run into the one on the outside.
        const flee = distance > 0.001 ? 0.45 / Math.max(distance, 3) : 0;
        const targetX = person.home.x + person.away.x * back + dx * flee * back;
        const targetZ = person.home.z + person.away.z * back + dz * flee * back;

        // Running is quick, coming back is not: a scattered crowd re-forms over
        // seconds, which is also what stops the whole hillside twitching.
        const rate = person.alarm > 0.3 ? 9 : 1.6;
        const k = 1 - Math.pow(0.5, dt * rate);
        person.at.x += (targetX - person.at.x) * k;
        person.at.z += (targetZ - person.at.z) * k;
        person.at.y = person.home.y;

        person.bob += dt * 14 * person.alarm;
        // Turned to watch the thing that is frightening them.
        const toCar = Math.atan2(car.x - person.at.x, car.z - person.at.z);
        person.facing += shortest(person.facing, toCar) * Math.min(1, dt * 6);

        person.alarm = Math.max(0, person.alarm - dt * 0.45);
        moved = true;
      } else if (person.alarm !== 0) {
        person.alarm = 0;
        person.at.copy(person.home);
        person.facing = person.yaw;
        moved = true;
      }
    }

    if (moved) this.write();
  }

  private write(): void {
    this.people.forEach((person, i) => {
      this.quaternion.setFromAxisAngle(this.up, person.facing);
      const hop = person.alarm > 0.15 ? Math.abs(Math.sin(person.bob)) * 0.12 * person.alarm : 0;

      this.scale.set(1, person.height, 1);
      this.position.set(person.at.x, person.at.y + 0.62 * person.height + hop, person.at.z);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.bodies.setMatrixAt(i, this.matrix);

      this.scale.set(1, 1, 1);
      this.position.set(person.at.x, person.at.y + 1.32 * person.height + hop, person.at.z);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.heads.setMatrixAt(i, this.matrix);
    });
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
  }
}

/** Shortest signed angle from `a` to `b`. */
function shortest(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Rolling ground colour per biome, under and beyond the corridor. */
const TERRAIN_COLOUR: Record<string, [number, number]> = {
  forest: [0x2f4429, 0x24361f],
  quarry: [0x5a4a35, 0x453927],
  winter: [0xc3cdd6, 0xa8b4c0],
  moor: [0x3f4a30, 0x333c26],
  coast: [0x415034, 0x33402a],
  town: [0x8a8172, 0x6d665b],
  alpine: [0x4a5340, 0x6e6a60],
};

/**
 * Distant ground beyond the corridor.
 *
 * Without it the world stops at the embankment walls and the isometric camera
 * looks straight over them into fog — the stage reads as a ribbon floating in
 * nothing. This is a coarse noise-displaced grid covering the stage's bounding
 * area, sitting below road level so it never intrudes on the driving surface,
 * and it is the difference between a test track and a place.
 *
 * Deliberately low resolution: it is scenery, it is always distant, and it must
 * cost nothing.
 */
function buildTerrain(stage: Stage): THREE.Group {
  const group = new THREE.Group();

  // Bounding box of the centreline, generously padded.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of stage.spline.samples) {
    minX = Math.min(minX, s.position.x);
    maxX = Math.max(maxX, s.position.x);
    minZ = Math.min(minZ, s.position.z);
    maxZ = Math.max(maxZ, s.position.z);
  }
  const pad = 260;
  minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;

  const cells = 40;
  const geometry = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ, cells, cells);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((minX + maxX) / 2, 0, (minZ + maxZ) / 2);

  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(position.count * 3);
  const [near, far] = TERRAIN_COLOUR[stage.def.biome] ?? TERRAIN_COLOUR.forest!;
  const a = new THREE.Color(near);
  const b = new THREE.Color(far);
  const mixed = new THREE.Color();

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);

    // The rule itself lives in `sim/terrain.ts`, because the scenery scatter
    // has to stand its trees on exactly this surface and used to guess at it.
    const y = groundHeight(stage.spline, x, z);
    // The colour still reads off the noise alone, so a hillside is green at the
    // same height whatever the road beside it is doing.
    const h =
      Math.sin(x * 0.011) * Math.cos(z * 0.013) * 9 +
      Math.sin(x * 0.037 + 1.7) * Math.cos(z * 0.029 - 0.9) * 3.5;

    position.setY(i, y);
    mixed.copy(a).lerp(b, Math.min(Math.max(h / 12, 0), 1));
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }),
  );
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

/**
 * Roadside hazards.
 *
 * Instanced per kind, and deliberately chunky: at this camera distance a
 * hazard has to be unmistakable, because hitting one is expensive and the
 * player needs to have seen it coming.
 */
/**
 * The size each kind's geometry is authored at.
 *
 * Props carry their own radius and height so the simulation can vary them —
 * a wood of identically sized trunks reads as wallpaper — and the instance
 * scale is that size over this one.
 */
const PROP_BASE: Record<PropKind, { radius: number; height: number }> = {
  tree: { radius: 0.52, height: 7.5 },
  sapling: { radius: 0.16, height: 3.0 },
  rock: { radius: 0.85, height: 1.3 },
  bale: { radius: 0.75, height: 1.5 },
  pole: { radius: 0.16, height: 2.2 },
  building: { radius: 3.2, height: 9 },
  gatePost: { radius: 0.28, height: 3.4 },
  signPost: { radius: 0.09, height: 2.0 },
  // Drawn a metre tall and stretched to whatever the crossing needs, which is
  // how a single instanced mesh carries piers from 18 m to 51 m.
  pier: { radius: 1.5, height: 1 },
};

/**
 * The instanced hazards, plus the handful of them that move.
 *
 * A sapling is a dynamic body in the simulation, so its instance has to be
 * re-posed from that body — otherwise it goes over in the physics and stays
 * standing on screen, which is the worst of both.
 */
export class PropsView {
  readonly group = new THREE.Group();
  /** Instance slot for each movable prop, in stage order. */
  private movable: {
    meshes: THREE.InstancedMesh[];
    index: number;
    scale: THREE.Vector3;
    /**
     * Half the prop's height.
     *
     * The physics body is centred on the shape and the geometry stands on its
     * own origin, so the two are half a sapling apart. Rotated by the body,
     * which is the whole point: a sapling lying flat has its base at one end of
     * itself, not underneath its middle.
     */
    lift: number;
  }[] = [];
  private readonly offset = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();

  /**
   * A prop can be drawn from more than one mesh — a trunk under a canopy — and
   * all of them have to move together when it goes over. A sapling whose leaves
   * fall and whose trunk stays standing is worse than one that does neither.
   */
  claim(meshes: THREE.InstancedMesh[], index: number, scale: THREE.Vector3, lift: number): void {
    this.movable.push({ meshes, index, scale: scale.clone(), lift });
  }

  /** Pose the knocked-over ones from the bodies carrying them. */
  sync(props: readonly { body: { translation(): { x: number; y: number; z: number }; rotation(): { x: number; y: number; z: number; w: number } } }[]): void {
    for (let i = 0; i < this.movable.length && i < props.length; i++) {
      const slot = this.movable[i]!;
      const body = props[i]!.body;
      const t = body.translation();
      const r = body.rotation();
      this.quaternion.set(r.x, r.y, r.z, r.w);
      this.offset.set(0, -slot.lift, 0).applyQuaternion(this.quaternion);
      this.position.set(t.x + this.offset.x, t.y + this.offset.y, t.z + this.offset.z);
      this.matrix.compose(this.position, this.quaternion, slot.scale);
      for (const mesh of slot.meshes) {
        mesh.setMatrixAt(slot.index, this.matrix);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }
}

/**
 * What a hazard looks like.
 *
 * Authored base-at-origin and at the size `PROP_BASE` names, so the instance
 * scale is the prop's own size over that one — a wood of identically sized
 * trunks reads as wallpaper, and the simulation varies them for exactly that
 * reason.
 *
 * These are the things the game charges you for hitting, so they get the detail
 * before anything else does. A house that is a grey box and a tree that is a
 * green triangle are the same object at a glance, and the player is meant to be
 * reading the difference between them at ninety kilometres an hour.
 */
function propParts(kind: PropKind): SceneryParts {
  switch (kind) {
    // A mature trunk carrying three tiers. The trunk is the point: it is what
    // the collider is, and a canopy sitting on nothing reads as a bush.
    case 'tree':
      return {
        main: mergeParts([tier(1.55, 2.2, 4.6), tier(1.2, 3.8, 6.1), tier(0.8, 5.4, 7.5)]),
        extra: { geometry: trunk(0.2, 0.32, 2.8), color: BARK },
        casts: true,
      };
    // Thin and bright: it has to read as the one you are allowed to hit.
    case 'sapling':
      return {
        main: mergeParts([tier(0.5, 0.9, 2.1, 7), tier(0.34, 1.8, 3.0, 7)]),
        extra: { geometry: trunk(0.05, 0.08, 1.1), color: 0x6b5a3a },
        casts: false,
      };
    // A house, with a roof on it. The corner of one of these is the hardest
    // thing in the game to hit, and it should not look like a shipping crate.
    case 'building': {
      const walls = new THREE.BoxGeometry(6.4, 6.2, 6.4);
      walls.translate(0, 3.1, 0);
      const plinth = new THREE.BoxGeometry(6.8, 0.55, 6.8);
      plinth.translate(0, 0.275, 0);
      const roof = new THREE.CylinderGeometry(0, 5.0, 3.1, 4);
      roof.rotateY(Math.PI / 4);
      roof.translate(0, 7.6, 0);
      const eaves = new THREE.BoxGeometry(7.1, 0.4, 7.1);
      eaves.translate(0, 6.3, 0);
      return {
        main: mergeParts([walls, plinth]),
        extra: { geometry: mergeParts([roof, eaves]), color: 0x6b4436 },
        casts: true,
      };
    }
    // Stone, once the regularity is knocked off it.
    case 'rock': {
      const stone = new THREE.DodecahedronGeometry(0.95, 1);
      stone.scale(1, 0.72, 1.05);
      stone.translate(0, 0.62, 0);
      return { main: roughen(stone, 0.19, 11), casts: true };
    }
    // Round bale: a drum with the twine showing, and flat ends the light picks
    // out so it reads as lying on its side rather than as a barrel.
    case 'bale': {
      const drum = new THREE.CylinderGeometry(0.75, 0.75, 1.5, 14);
      drum.translate(0, 0.75, 0);
      const bands: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 3; i++) {
        const band = new THREE.TorusGeometry(0.76, 0.05, 5, 14);
        band.rotateX(Math.PI / 2);
        band.translate(0, 0.35 + i * 0.4, 0);
        bands.push(band);
      }
      return {
        main: drum,
        extra: { geometry: mergeParts(bands), color: 0x6f5c30 },
        casts: true,
      };
    }
    // A marker post with a reflective band near the top — the same thing that
    // makes the road's own edge markers readable at a distance.
    case 'pole': {
      const post = new THREE.CylinderGeometry(0.09, 0.11, 2.2, 6);
      post.translate(0, 1.1, 0);
      const band = new THREE.CylinderGeometry(0.12, 0.12, 0.3, 6);
      band.translate(0, 1.85, 0);
      return { main: post, extra: { geometry: band, color: 0xe8552f }, casts: false };
    }
    // Never built: gate posts are drawn by `buildGates`, banner and all, and
    // sign posts by `buildSigns` with the board they carry.
    case 'gatePost':
      return { main: new THREE.BoxGeometry(0.4, 3.4, 0.4), casts: false };
    case 'signPost':
      return { main: new THREE.BoxGeometry(0.12, 1.9, 0.12), casts: false };
    // A bridge column. Tapered and eight-sided rather than round: at this
    // camera distance a smooth cylinder has no edge to catch the light and
    // reads as a flat grey stripe, and the taper is what makes a fifty-metre
    // one look like it is holding something up rather than like a pipe.
    case 'pier': {
      const shaft = new THREE.CylinderGeometry(1.5, 2.1, 1, 8);
      shaft.translate(0, 0.5, 0);
      return { main: shaft, casts: true };
    }
  }
}

/** Base colour of each hazard. */
const PROP_COLOUR: Record<PropKind, number> = {
  tree: 0x33512f,
  sapling: 0x6f9c4e,
  building: 0xcbbda4,
  rock: 0x6a6a68,
  bale: 0xb59a55,
  pole: 0xdcd6c6,
  gatePost: 0xf2c14e,
  signPost: 0x6b7280,
  pier: 0x8a8579,
};

function buildProps(stage: Stage): PropsView {
  const view = new PropsView();
  const group = view.group;
  if (stage.props.length === 0) return view;

  const byKind = new Map<PropKind, typeof stage.props>();
  for (const prop of stage.props) {
    // Gate posts are props so the simulation gives them colliders; they are
    // drawn with their gate, banner and all, rather than as another hazard.
    if (prop.kind === 'gatePost' || prop.kind === 'signPost') continue;
    // Piers are drawn with their bridge, along with the deck they carry.
    if (prop.kind === 'pier') continue;
    const list = byKind.get(prop.kind) ?? [];
    list.push(prop);
    byKind.set(prop.kind, list);
  }

  for (const [kind, props] of byKind) {
    const parts = propParts(kind);
    const colour = PROP_COLOUR[kind];
    const mesh = new THREE.InstancedMesh(
      parts.main,
      new THREE.MeshStandardMaterial({
        color: colour,
        roughness: 0.85,
        flatShading: true,
        // The same floor the scenery gets: a hazard whose shaded side goes navy
        // is a hazard whose shape you cannot read until you are in it.
        emissive: colour,
        emissiveIntensity: 0.12,
      }),
      props.length,
    );
    mesh.castShadow = parts.casts;
    mesh.receiveShadow = true;

    const extra = parts.extra
      ? new THREE.InstancedMesh(
          parts.extra.geometry,
          new THREE.MeshStandardMaterial({
            color: parts.extra.color,
            roughness: 0.9,
            flatShading: true,
            emissive: parts.extra.color,
            emissiveIntensity: 0.12,
          }),
          props.length,
        )
      : null;
    if (extra) {
      extra.castShadow = false;
      extra.receiveShadow = true;
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const tilt = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const across = new THREE.Vector3(1, 0, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1, 1, 1);
    // The base shape each kind is drawn at, so a prop that carries its own size
    // is drawn at that size rather than at the geometry's.
    const base = PROP_BASE[kind];

    props.forEach((prop, i) => {
      scl.set(prop.radius / base.radius, prop.height / base.height, prop.radius / base.radius);
      // Geometry stands on its own origin, so the prop's position is where its
      // base goes rather than where its middle does.
      pos.set(prop.position.x, prop.position.y, prop.position.z);
      q.setFromAxisAngle(up, prop.yaw);
      // Rocks look wrong perfectly upright; a little tilt reads as natural.
      if (kind === 'rock') q.multiply(tilt.setFromAxisAngle(across, prop.yaw * 0.3));
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
      extra?.setMatrixAt(i, m);
      if (prop.mass !== undefined) {
        view.claim(extra ? [mesh, extra] : [mesh], i, scl, prop.height / 2);
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    if (extra) {
      extra.instanceMatrix.needsUpdate = true;
      group.add(extra);
    }
  }

  return view;
}

/**
 * The lamps on the start gantry.
 *
 * Three reds and a green, hung over the start line where the car is already
 * looking. A HUD countdown alone would work and would say nothing about the
 * place: a gantry with lamps on it is the difference between a timer and a
 * start line.
 */
export class StartLightsView {
  readonly group = new THREE.Group();

  private readonly lamps: THREE.Mesh[] = [];
  private readonly green: THREE.Mesh;

  constructor(at: Vec3, left: Vec3, width: number) {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(width * 1.15, 0.3, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x232830, roughness: 0.8, flatShading: true }),
    );
    beam.position.set(at.x, at.y + 4.3, at.z);
    beam.lookAt(at.x + left.x, at.y + 4.3, at.z + left.z);
    beam.rotateY(Math.PI / 2);
    beam.castShadow = true;
    this.group.add(beam);

    // Unlit lamps are dark glass; lighting one is a colour and an emissive,
    // which reads from any distance and costs nothing.
    const dark = () =>
      new THREE.MeshStandardMaterial({ color: 0x1a1d22, emissive: 0x000000, roughness: 0.4 });

    for (let i = 0; i < 4; i++) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), dark());
      // Strung across the beam, reds first and the green on the end.
      const across = (i - 1.5) * 1.0;
      lamp.position.set(
        at.x + left.x * across,
        at.y + 3.95,
        at.z + left.z * across,
      );
      this.group.add(lamp);
      this.lamps.push(lamp);
    }
    this.green = this.lamps[3]!;
  }

  /** Light `reds` of the three red lamps, and the green if `go`. */
  set(reds: number, go: boolean): void {
    for (let i = 0; i < 3; i++) {
      const material = this.lamps[i]!.material as THREE.MeshStandardMaterial;
      const lit = i < reds && !go;
      material.color.setHex(lit ? 0xff3b21 : 0x2a1a18);
      material.emissive.setHex(lit ? 0xd42a12 : 0x000000);
    }
    const material = this.green.material as THREE.MeshStandardMaterial;
    material.color.setHex(go ? 0x4fd6a0 : 0x18241f);
    material.emissive.setHex(go ? 0x2fbb84 : 0x000000);
  }
}

/** Start line, checkpoint gates and finish line, as paired posts plus a banner. */
/**
 * Corner warning boards.
 *
 * Drawn into a canvas rather than built from geometry: an arrow with a number
 * on it is a picture, and a picture is one texture and two triangles instead of
 * a dozen extruded shapes. One texture per direction-and-severity pair, cached,
 * so a stage with eight corners still uses at most a handful.
 */
const SIGN_TEXTURES = new Map<string, THREE.CanvasTexture>();

function signTexture(direction: 'left' | 'right', severity: number): THREE.CanvasTexture {
  const key = `${direction}${severity}`;
  const cached = SIGN_TEXTURES.get(key);
  if (cached) return cached;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Colour carries the severity before the number is legible: a tight corner
  // is red at a distance where the arrow is still four pixels wide.
  const accent = severity <= 2 ? '#e8552f' : severity <= 4 ? '#f2c14e' : '#7fd6a0';
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#12161c';
  ctx.fillRect(7, 7, size - 14, size - 14);

  // The arrow, bent the way the road goes. Severity decides how sharply.
  const bend = 1 - (severity - 1) / 6;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 13;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.save();
  if (direction === 'left') {
    ctx.translate(size, 0);
    ctx.scale(-1, 1);
  }
  ctx.beginPath();
  ctx.moveTo(34, size - 24);
  ctx.lineTo(34, size * (0.62 - bend * 0.16));
  ctx.quadraticCurveTo(34, 30, 34 + 26 + bend * 30, 30);
  ctx.stroke();
  // Arrow head.
  const tipX = 34 + 26 + bend * 30;
  ctx.beginPath();
  ctx.moveTo(tipX + 22, 30);
  ctx.lineTo(tipX - 4, 14);
  ctx.lineTo(tipX - 4, 46);
  ctx.closePath();
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = accent;
  ctx.font = "700 46px ui-monospace, 'SF Mono', monospace";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(severity), size / 2, size - 22);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  SIGN_TEXTURES.set(key, texture);
  return texture;
}

function buildSigns(stage: Stage): { group: THREE.Group; boards: THREE.Mesh[] } {
  const group = new THREE.Group();
  const boards: THREE.Mesh[] = [];
  const postGeo = new THREE.BoxGeometry(0.12, 1.9, 0.12);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9 });
  // 1.9 m across: larger than a real corner board, because at race distance
  // under an orthographic camera a real one is about eight pixels.
  const boardGeo = new THREE.PlaneGeometry(1.9, 1.9);

  for (const sign of stage.signs) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(sign.position.x, sign.position.y + 0.95, sign.position.z);
    post.castShadow = true;
    group.add(post);

    const board = new THREE.Mesh(
      boardGeo,
      new THREE.MeshBasicMaterial({
        map: signTexture(sign.corner.direction, sign.corner.severity),
        // Visible from behind too: with a camera that changes zone the board
        // would otherwise vanish on half the stage.
        side: THREE.DoubleSide,
      }),
    );
    board.position.set(sign.position.x, sign.position.y + 2.6, sign.position.z);
    board.rotation.y = sign.yaw;
    group.add(board);
    boards.push(board);
  }
  return { group, boards };
}

/**
 * The bridges, where the stage passes over itself.
 *
 * The corridor was always a ribbon in space — verge, bank and wall, with open
 * air underneath — so an overpass was already geometrically an overpass. What
 * it had was no structure: a road hanging in the sky above another road, with
 * the ground dipping away beneath it because the terrain takes the *lowest*
 * nearby road. From the lower leg of Grand Traverse that reads as a bug, and it
 * is the thing "it needs a bridge so that it makes sense" is asking for.
 *
 * Three parts, and each is doing a job:
 *
 * - A **soffit** under the carried span, so the road has a visible underside
 *   rather than being a surface you can see the sky through from below.
 * - **Piers** at each end, which are what turn a slab into a bridge. They are
 *   `sim/` props, placed there and given colliders there — a fifty-metre
 *   concrete column is not decoration — and drawn here from that same list.
 * - An **edge beam** down each side of the deck, which at this camera distance
 *   is most of what actually reads as a bridge: it is the horizontal line under
 *   the parapet that says the road is being carried.
 */
function buildBridges(stage: Stage): THREE.Group {
  const group = new THREE.Group();
  if (stage.crossings.length === 0) return group;

  const concrete = new THREE.MeshStandardMaterial({
    color: 0x8a8579,
    roughness: 0.95,
    flatShading: true,
    // The same emissive floor everything vertical here gets: a pier lit only by
    // the hemisphere light comes out navy whatever colour it is painted.
    emissive: 0x8a8579,
    emissiveIntensity: 0.12,
  });

  for (const crossing of stage.crossings) {
    const [from, to] = crossing.span;
    // Along the span at the spline's own resolution, so a bridge on a curve
    // follows it instead of cutting the corner.
    const step = 6;
    const count = Math.max(Math.ceil((to - from) / step), 1);
    for (let i = 0; i < count; i++) {
      const at = from + ((to - from) * (i + 0.5)) / count;
      const sample = stage.spline.at(at);
      const length = (to - from) / count + 0.3;
      const half = sample.width + CORRIDOR.vergeWidth;

      const soffit = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 1.1, length), concrete);
      soffit.position.set(sample.position.x, sample.position.y - 0.9, sample.position.z);
      soffit.rotation.y = Math.atan2(sample.forward.x, sample.forward.z);
      soffit.castShadow = true;
      soffit.receiveShadow = true;
      group.add(soffit);

      for (const side of [-1, 1]) {
        const beam = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, length), concrete);
        beam.position.set(
          sample.position.x + sample.left.x * half * side,
          sample.position.y - 0.55,
          sample.position.z + sample.left.z * half * side,
        );
        beam.rotation.y = Math.atan2(sample.forward.x, sample.forward.z);
        beam.castShadow = true;
        group.add(beam);
      }
    }
  }

  // The columns. Their positions, heights and colliders all come from `sim/`;
  // this only draws what is already there.
  const piers = stage.props.filter((prop) => prop.kind === 'pier');
  if (piers.length > 0) {
    const parts = propParts('pier');
    const mesh = new THREE.InstancedMesh(parts.main, concrete, piers.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const base = PROP_BASE.pier;
    piers.forEach((prop, i) => {
      m.compose(
        new THREE.Vector3(prop.position.x, prop.position.y, prop.position.z),
        q.setFromAxisAngle(up, prop.yaw),
        new THREE.Vector3(prop.radius / base.radius, prop.height / base.height, prop.radius / base.radius),
      );
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  return group;
}

function buildGates(stage: Stage): THREE.Group {
  const gates = new THREE.Group();

  const postGeo = new THREE.BoxGeometry(0.4, 3.4, 0.4);
  const make = (
    position: { x: number; y: number; z: number },
    right: { x: number; y: number; z: number },
    width: number,
    color: number,
  ) => {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, flatShading: true });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, mat);
      post.position.set(
        position.x + right.x * width * side,
        position.y + 1.7,
        position.z + right.z * width * side,
      );
      post.castShadow = true;
      gates.add(post);
    }
    // A thin banner across the top reads as a gate from the isometric angle,
    // where two separate posts do not.
    const banner = new THREE.Mesh(new THREE.BoxGeometry(width * 2, 0.5, 0.25), mat);
    banner.position.set(position.x, position.y + 3.3, position.z);
    banner.lookAt(position.x + right.x, position.y + 3.3, position.z + right.z);
    banner.rotateY(Math.PI / 2);
    gates.add(banner);
  };

  const first = stage.spline.samples[0]!;
  make(first.position, first.left, first.width, 0x4fd6a0);

  for (const cp of stage.checkpoints) make(cp.position, cp.left, cp.width, 0xf2c14e);

  const last = stage.spline.samples[stage.spline.samples.length - 1]!;
  make(last.position, last.left, last.width, 0xe8552f);

  return gates;
}

/**
 * Posts along the road edge. Purely visual, but on a fixed isometric camera
 * they are what makes the road's direction and width readable at a glance —
 * the same job real rally stage marker poles do.
 */
function buildEdgeMarkers(markers: Markers): MarkerView {
  const count = Math.max(markers.all.length, 1);

  // A pole with a band near the top, not a stake: the band is what makes it
  // read as a marker placed by somebody rather than a stick in the ground, and
  // it is the part that stays visible when the pole is lying down.
  const pole = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.075, 0.09, 1.15, 6),
    new THREE.MeshStandardMaterial({ color: 0xf0ece0, roughness: 0.75, flatShading: true }),
    count,
  );
  const band = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.095, 0.095, 0.3, 6),
    new THREE.MeshStandardMaterial({ color: 0xe8552f, roughness: 0.6, flatShading: true }),
    count,
  );
  pole.castShadow = true;
  band.castShadow = true;

  const group = new THREE.Group();
  group.add(pole, band);

  const view = new MarkerView(group, pole, band);
  view.sync(markers);
  return view;
}

/**
 * The marker poles on screen, following the simulation's own idea of them.
 *
 * Two instanced meshes and one rebuild whenever something changes, which is a
 * couple of times a lap — the poles stand still the rest of the time, and
 * rewriting a hundred and sixty matrices every frame to say so would be a
 * waste of the only per-frame budget this renderer has.
 */
export class MarkerView {
  readonly group: THREE.Group;
  private readonly pole: THREE.InstancedMesh;
  private readonly band: THREE.InstancedMesh;
  private version = -1;

  constructor(group: THREE.Group, pole: THREE.InstancedMesh, band: THREE.InstancedMesh) {
    this.group = group;
    this.pole = pole;
    this.band = band;
  }

  /** Redraw if the poles have changed since last time. */
  sync(markers: Markers): void {
    if (markers.version === this.version) return;
    this.version = markers.version;

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const axis = new THREE.Vector3();

    markers.all.forEach((marker, i) => {
      // A fallen pole rotates about the axis across the direction it was hit,
      // so it goes over the way the car pushed it rather than in some default
      // direction that will be wrong three times out of four.
      const tip = (marker.fallen * Math.PI) / 2;
      axis.set(Math.cos(marker.knockedToward), 0, -Math.sin(marker.knockedToward)).normalize();
      quaternion.setFromAxisAngle(axis, tip);

      // Its centre swings down as it falls: upright it is half a pole above the
      // ground, flat it is a pole-radius above it.
      const half = 0.575;
      const lift = Math.cos(tip) * half + 0.09;
      const lean = Math.sin(tip) * half;
      const push = { x: Math.sin(marker.knockedToward), z: Math.cos(marker.knockedToward) };

      for (const [mesh, height] of [
        [this.pole, 0] as const,
        [this.band, 0.42] as const,
      ]) {
        // The band rides near the top of the pole, so it swings furthest.
        const along = height;
        position.set(
          marker.position.x + push.x * (lean + Math.sin(tip) * along),
          marker.position.y + lift + Math.cos(tip) * along,
          marker.position.z + push.z * (lean + Math.sin(tip) * along),
        );
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);
      }
    });

    this.pole.instanceMatrix.needsUpdate = true;
    this.band.instanceMatrix.needsUpdate = true;
  }
}
