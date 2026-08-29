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
import { CORRIDOR, type PropKind, type Stage } from '../sim/stage.js';
import type { Markers } from '../sim/markers.js';
import type { Vec3 } from '../sim/math.js';
import { SURFACES } from '../sim/surfaces.js';

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
  group.add(buildProps(stage));
  const signs = buildSigns(stage);
  group.add(signs.group);

  return {
    group,
    signBoards: signs.boards,
    markers: markerView,
    crowd,
    startLights,
    dispose: () => {
      geometry.dispose();
      (road.material as THREE.Material).dispose();
    },
  };
}


/**
 * What grows beside the road, by biome.
 *
 * Every stage was the same place in a different colour: identical conifers at
 * identical spacing, and the only thing telling a Welsh moor from a Finnish
 * forest was the tint of the ground. This is the dressing that makes them read
 * as different countries — density first, then silhouette, then colour, in that
 * order of how much they matter at an isometric distance.
 *
 * All of it is scenery in the strict sense: it lives outside the corridor
 * walls, nothing collides with it, and nothing in `sim/` knows it exists. The
 * things you can hit are the stage's hazards, and they are data.
 */
interface Scatter {
  kind: 'conifer' | 'broadleaf' | 'deadTree' | 'bush' | 'boulder' | 'tuft' | 'snowFir' | 'building' | 'wall';
  /**
   * Which band it grows in.
   *
   * `verge` is the strip immediately beside the road, and it is the only band
   * that is on screen the whole time — the camera shows about thirty metres
   * across and the embankment starts ten from the centreline. `near` is the
   * embankment itself, seen at the edges of the frame and through every corner
   * that opens out. `far` is everything past the wall: the wide shots, and the
   * sense that the road goes somewhere.
   */
  band: 'verge' | 'near' | 'far';
  /** Roughly how many per 100 m of road, per side. */
  density: number;
  /** Size multiplier range. */
  size: [number, number];
  color: number;
  /** Second colour, mixed in per instance so a wood is not one flat green. */
  colorB?: number;
  /**
   * Extra metres to hold the `far` band back from the corridor.
   *
   * Trees can crowd the road; a nine-metre building cannot. Without this the
   * town's houses stood on the embankment and filled the frame, and the street
   * they were meant to line was invisible underneath them.
   */
  push?: number;
}

const DRESSING: Record<string, Scatter[]> = {
  // Deep northern forest: trees to the edge of the road and nothing to see past
  // them. The density is the character — this stage should feel like a corridor.
  forest: [
    { kind: 'conifer', band: 'far', density: 26, size: [0.8, 1.7], color: 0x2b4a2c, colorB: 0x1f3a22 },
    { kind: 'broadleaf', band: 'far', density: 6, size: [0.7, 1.2], color: 0x466b32, colorB: 0x5b7a34 },
    { kind: 'deadTree', band: 'far', density: 2, size: [0.7, 1.1], color: 0x6b5b45 },
    { kind: 'bush', band: 'near', density: 30, size: [0.4, 0.8], color: 0x3c5a2e, colorB: 0x2f4a26 },
    { kind: 'tuft', band: 'near', density: 22, size: [0.5, 1.0], color: 0x50703a },
    { kind: 'tuft', band: 'verge', density: 46, size: [0.3, 0.6], color: 0x4a6b34, colorB: 0x3a5a2c },
    { kind: 'bush', band: 'verge', density: 10, size: [0.25, 0.45], color: 0x35512b },
  ],
  // Worked stone: almost nothing grows, and what does is scrub clinging to
  // spoil heaps. Open, bright and hard-edged.
  quarry: [
    { kind: 'boulder', band: 'far', density: 16, size: [0.7, 2.4], color: 0x7a7268, colorB: 0x8d8272 },
    { kind: 'deadTree', band: 'far', density: 2, size: [0.6, 1.0], color: 0x6f6150 },
    { kind: 'boulder', band: 'near', density: 14, size: [0.3, 0.8], color: 0x847b6f, colorB: 0x6d6459 },
    { kind: 'tuft', band: 'near', density: 10, size: [0.4, 0.8], color: 0x8a8256 },
    { kind: 'boulder', band: 'verge', density: 26, size: [0.16, 0.4], color: 0x8d8478, colorB: 0x736a5e },
    { kind: 'tuft', band: 'verge', density: 12, size: [0.25, 0.5], color: 0x8a8256 },
  ],
  // Snow-laden firs thinning into open white, and drifts against the banks.
  winter: [
    { kind: 'snowFir', band: 'far', density: 16, size: [0.9, 1.8], color: 0x27402f, colorB: 0x1e3327 },
    { kind: 'deadTree', band: 'far', density: 3, size: [0.8, 1.3], color: 0x5d5347 },
    { kind: 'boulder', band: 'near', density: 16, size: [0.4, 1.0], color: 0xe6edf2, colorB: 0xcfd9e2 },
    { kind: 'bush', band: 'near', density: 5, size: [0.4, 0.7], color: 0x38503c },
    { kind: 'boulder', band: 'verge', density: 30, size: [0.2, 0.5], color: 0xeff4f8, colorB: 0xd8e2ea },
    { kind: 'tuft', band: 'verge', density: 8, size: [0.2, 0.45], color: 0x7d8a76 },
  ],
  // Open moorland: no trees at all, and that absence is the whole look. Heather
  // and gorse in clumps, with stone breaking through.
  moor: [
    { kind: 'boulder', band: 'far', density: 8, size: [0.5, 1.8], color: 0x6f6c66 },
    { kind: 'bush', band: 'far', density: 14, size: [0.5, 1.1], color: 0x5a4a63, colorB: 0x6b5a2f },
    { kind: 'bush', band: 'near', density: 30, size: [0.35, 0.75], color: 0x6a4f6b, colorB: 0x7a6634 },
    { kind: 'tuft', band: 'near', density: 26, size: [0.5, 1.0], color: 0x7a7340, colorB: 0x8d8449 },
    { kind: 'bush', band: 'verge', density: 34, size: [0.22, 0.5], color: 0x74566f, colorB: 0x84713a },
    { kind: 'tuft', band: 'verge', density: 30, size: [0.28, 0.55], color: 0x8a8149 },
  ],
  // A town stage is walls, not vegetation. Buildings crowd the far band right
  // up to the corridor so the road reads as a street with no run-off, and the
  // verge carries low stone walls rather than anything soft to land in.
  town: [
    { kind: 'building', band: 'far', density: 10, size: [0.55, 1.1], color: 0xe8dcc2, colorB: 0xcdb89a, push: 26 },
    { kind: 'wall', band: 'verge', density: 22, size: [0.9, 1.4], color: 0xc8bca8, colorB: 0xa89b89 },
    { kind: 'tuft', band: 'verge', density: 8, size: [0.2, 0.45], color: 0x5f6b3c },
    { kind: 'broadleaf', band: 'far', density: 4, size: [0.6, 1.0], color: 0x4a6b3a, push: 8 },
  ],
  // High alpine: firs at the bottom, rock and nothing at the top. The stage
  // crosses three surfaces, so its dressing has to cover the whole range.
  alpine: [
    { kind: 'snowFir', band: 'far', density: 14, size: [0.8, 1.7], color: 0x2a4433, colorB: 0x1f3628 },
    { kind: 'boulder', band: 'far', density: 12, size: [0.8, 2.6], color: 0x8f8a82, colorB: 0x746f68 },
    { kind: 'boulder', band: 'near', density: 18, size: [0.35, 0.9], color: 0xa8a49c, colorB: 0x827d75 },
    { kind: 'tuft', band: 'near', density: 14, size: [0.4, 0.9], color: 0x6d7a4c },
    { kind: 'boulder', band: 'verge', density: 24, size: [0.18, 0.45], color: 0xb2ada4, colorB: 0x8d887f },
    { kind: 'tuft', band: 'verge', density: 14, size: [0.25, 0.5], color: 0x74804f },
  ],
  // Wind-bent pines and dune grass, thinning toward the water.
  coast: [
    { kind: 'conifer', band: 'far', density: 9, size: [0.6, 1.1], color: 0x3d5a3c, colorB: 0x4a6440 },
    { kind: 'boulder', band: 'far', density: 7, size: [0.6, 1.8], color: 0x8a8378 },
    { kind: 'tuft', band: 'near', density: 34, size: [0.6, 1.2], color: 0xa8a06a, colorB: 0x8f9a5c },
    { kind: 'bush', band: 'near', density: 8, size: [0.4, 0.8], color: 0x53663c },
    { kind: 'tuft', band: 'verge', density: 52, size: [0.3, 0.7], color: 0xb3ab72, colorB: 0x97a05f },
  ],
};

/** How far out from the road scenery is scattered, metres. */
const SCENERY_REACH = 105;
/** Total instances allowed per stage, whatever the recipe asks for. */
const SCENERY_BUDGET = 3200;

function scatterGeometry(kind: Scatter['kind']): THREE.BufferGeometry {
  switch (kind) {
    case 'conifer':
      return new THREE.ConeGeometry(1.6, 7.5, 6);
    case 'snowFir':
      return new THREE.ConeGeometry(1.8, 7, 6);
    case 'broadleaf':
      return new THREE.IcosahedronGeometry(2.4, 0);
    case 'deadTree':
      return new THREE.CylinderGeometry(0.16, 0.3, 5.5, 5);
    case 'bush':
      return new THREE.IcosahedronGeometry(1.1, 0);
    case 'boulder':
      return new THREE.DodecahedronGeometry(1.1, 0);
    case 'tuft':
      return new THREE.ConeGeometry(0.55, 1.1, 4);
    // Buildings and walls are the only scenery that stands on the ground rather
    // than being sunk into it, so their geometry is translated up by half its
    // height: a box centred on the origin buries half a house.
    case 'building': {
      const box = new THREE.BoxGeometry(6, 9, 6);
      box.translate(0, 4.5, 0);
      return box;
    }
    case 'wall': {
      const box = new THREE.BoxGeometry(3.4, 1.4, 0.6);
      box.translate(0, 0.7, 0);
      return box;
    }
  }
}

/**
 * Scatter the biome's vegetation along the road, outside the corridor.
 *
 * Placed along the centreline rather than across the bounding box: a stage is a
 * ribbon through a landscape, and scattering over its bounding box puts nine
 * tenths of the instances where the camera never looks.
 */
function buildScenery(stage: Stage): THREE.Group {
  const group = new THREE.Group();
  const recipes = DRESSING[stage.def.biome] ?? DRESSING.forest!;

  // Seeded from the stage id: the same wood every time it loads, in the browser
  // and in the screenshot harness.
  let seed = 0;
  for (let i = 0; i < stage.def.id.length; i++) seed = (seed * 31 + stage.def.id.charCodeAt(i)) >>> 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const step = 12;
  const samples = Math.max(Math.floor(stage.length / step), 1);
  const total = recipes.reduce((sum, r) => sum + r.density, 0) * 2 * (stage.length / 100);
  const budget = Math.min(1, SCENERY_BUDGET / Math.max(total, 1));

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color();

  for (const recipe of recipes) {
    const perSample = (recipe.density / 100) * step * 2 * budget;
    const count = Math.max(Math.ceil(perSample * samples), 1);
    const geometry = scatterGeometry(recipe.kind);
    const mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }),
      count,
    );
    // Only the tall things cast: the shadow camera rides with the car and a
    // thousand shadow-casting tufts is a bill for something nobody can see.
    mesh.castShadow =
      recipe.kind === 'conifer' ||
      recipe.kind === 'snowFir' ||
      recipe.kind === 'broadleaf' ||
      recipe.kind === 'building';
    mesh.receiveShadow = false;

    const a = new THREE.Color(recipe.color);
    const b = new THREE.Color(recipe.colorB ?? recipe.color);

    let n = 0;
    for (let i = 0; i < samples && n < count; i++) {
      const d = i * step + random() * step;
      const sample = stage.spline.at(Math.min(d, stage.length - 1));
      // The embankment, from the outer edge of the verge to just short of the
      // wall; and everything past the wall.
      const vergeFrom = sample.width + 0.35;
      const vergeTo = sample.width + CORRIDOR.vergeWidth - 0.4;
      const bankFrom = sample.width + CORRIDOR.vergeWidth + 0.6;
      const bankTo = sample.width + CORRIDOR.vergeWidth + CORRIDOR.bankWidth - 0.5;
      const beyond = sample.width + CORRIDOR.vergeWidth + CORRIDOR.bankWidth + 2 + (recipe.push ?? 0);

      for (let k = 0; k < perSample && n < count; k++) {
        if (perSample < 1 && random() > perSample) continue;
        const side = random() < 0.5 ? -1 : 1;
        const onCorridor = recipe.band !== 'far';
        // Far scenery is weighted toward the road: what is close is what is seen.
        const out =
          recipe.band === 'verge'
            ? vergeFrom + (vergeTo - vergeFrom) * random()
            : recipe.band === 'near'
              ? bankFrom + (bankTo - bankFrom) * random()
              : beyond + (SCENERY_REACH - beyond) * random() ** 2;
        const along = (random() - 0.5) * step;

        position.set(
          sample.position.x + sample.left.x * out * side + sample.forward.x * along,
          // On the embankment rather than at road level, or a bush on a bank
          // hovers a metre above its own hillside.
          sample.position.y + (onCorridor ? CORRIDOR.heightAt(sample.width, out) : 0),
          sample.position.z + sample.left.z * out * side + sample.forward.z * along,
        );

        const size = recipe.size[0] + random() * (recipe.size[1] - recipe.size[0]);
        // Sunk slightly so nothing hovers over ground that undulates under it.
        // Buildings and walls stand on it instead: their geometry already has
        // its base at the origin, and a sunk house loses its ground floor.
        const standing = recipe.kind === 'building' || recipe.kind === 'wall';
        position.y -= standing ? 0.15 : 0.6 * size;
        scale.set(size, size * (0.85 + random() * 0.4), size);
        // A wall follows the road. Given a random yaw like everything else it
        // read as scattered planks rather than as the edge of a street.
        quaternion.setFromAxisAngle(
          up,
          recipe.kind === 'wall'
            ? Math.atan2(sample.forward.x, sample.forward.z) + (random() - 0.5) * 0.12
            : random() * Math.PI * 2,
        );
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(n, matrix);

        tint.copy(a).lerp(b, random());
        mesh.setColorAt(n, tint);
        n++;
      }
    }

    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);

    // A cap of snow on the firs, which is most of what says "winter" from a
    // distance — the tree under it is the same tree.
    if (recipe.kind === 'snowFir') {
      const caps = new THREE.InstancedMesh(
        new THREE.ConeGeometry(1.5, 3.4, 6),
        new THREE.MeshStandardMaterial({ color: 0xeef3f7, roughness: 0.8, flatShading: true }),
        Math.max(n, 1),
      );
      caps.castShadow = false;
      for (let i = 0; i < n; i++) {
        mesh.getMatrixAt(i, matrix);
        matrix.decompose(position, quaternion, scale);
        position.y += 2.0 * scale.y;
        matrix.compose(position, quaternion, scale);
        caps.setMatrixAt(i, matrix);
      }
      caps.count = n;
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

    // Two octaves of cheap trig noise: enough to read as landscape, and
    // deterministic, so the same stage always looks the same.
    const h =
      Math.sin(x * 0.011) * Math.cos(z * 0.013) * 9 +
      Math.sin(x * 0.037 + 1.7) * Math.cos(z * 0.029 - 0.9) * 3.5;

    // Follow the road's local height rather than a single global minimum, so
    // the ground sits just below the corridor everywhere instead of dropping
    // into a canyon wherever the stage climbs.
    const nearest = stage.spline.locate({ x, y: 0, z });
    const roadHeight = nearest.sample.position.y;
    const distance = Math.abs(nearest.lateral);
    const clearance = Math.min(Math.max((distance - 30) / 110, 0), 1);

    position.setY(i, roadHeight - 4 + h * clearance);
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
function buildProps(stage: Stage): THREE.Group {
  const group = new THREE.Group();
  if (stage.props.length === 0) return group;

  const byKind = new Map<PropKind, typeof stage.props>();
  for (const prop of stage.props) {
    // Gate posts are props so the simulation gives them colliders; they are
    // drawn with their gate, banner and all, rather than as another hazard.
    if (prop.kind === 'gatePost') continue;
    const list = byKind.get(prop.kind) ?? [];
    list.push(prop);
    byKind.set(prop.kind, list);
  }

  const build: Record<PropKind, () => { geometry: THREE.BufferGeometry; color: number }> = {
    // Trunk plus canopy merged into one silhouette by stacking two cylinders.
    tree: () => ({ geometry: new THREE.ConeGeometry(1.5, 5.5, 6), color: 0x33512f }),
    rock: () => ({ geometry: new THREE.DodecahedronGeometry(0.95, 0), color: 0x6a6a68 }),
    bale: () => ({ geometry: new THREE.CylinderGeometry(0.75, 0.75, 1.5, 8), color: 0xb59a55 }),
    pole: () => ({ geometry: new THREE.BoxGeometry(0.22, 2.2, 0.22), color: 0xdcd6c6 }),
    // Never built: gate posts are drawn by `buildGates`.
    gatePost: () => ({ geometry: new THREE.BoxGeometry(0.4, 3.4, 0.4), color: 0xf2c14e }),
  };

  for (const [kind, props] of byKind) {
    const { geometry, color } = build[kind]();
    const mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true }),
      props.length,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1, 1, 1);

    props.forEach((prop, i) => {
      pos.set(prop.position.x, prop.position.y + prop.height / 2, prop.position.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), prop.yaw);
      // Rocks look wrong perfectly upright; a little tilt reads as natural.
      if (kind === 'rock') q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), prop.yaw * 0.3));
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  return group;
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
