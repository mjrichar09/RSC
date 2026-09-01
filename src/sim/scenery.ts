/**
 * What stands beside the road, and which of it is solid.
 *
 * This used to live in the renderer, where it was honestly described as
 * decoration: "it lives outside the corridor walls, nothing collides with it,
 * and nothing in `sim/` knows it exists". That was true, and it was the bug.
 * A stage is a wood, a quarry or a street, and the wood is what the player
 * sees — so the wood is what the player aims at. Driving through the trunk of
 * a fully rendered pine reads as the game being broken, and it was.
 *
 * So placement moved here. The simulation owns where every tree, boulder and
 * house stands; the renderer reads that list and draws it. There is exactly one
 * scatter, it is seeded from the stage id, and it is identical in the browser,
 * in the headless tools and on every machine in a multiplayer race — which is
 * the other thing decoration in the renderer could never be.
 *
 * Not all of it is solid. A tuft of grass and a heather bush are things you
 * brush through, and giving them colliders would turn the verge into a minefield
 * of invisible kerbs. Solidity is a property of the kind, plus two limits: a
 * boulder has to be big enough to be worth stopping a car, and anything further
 * out than `SOLID_MARGIN` past the corridor wall is backdrop no car can reach,
 * so it pays no physics bill.
 */

import { type Vec3, clamp, v3 } from './math.js';
import { CORRIDOR } from './corridor.js';
import type { Spline } from './spline.js';

export type SceneryKind =
  | 'conifer'
  | 'broadleaf'
  | 'deadTree'
  | 'bush'
  | 'boulder'
  | 'tuft'
  | 'snowFir'
  | 'building'
  | 'wall';

/**
 * Which band a recipe grows in.
 *
 * `verge` is the strip immediately beside the road, and it is the only band
 * that is on screen the whole time — the camera shows about thirty metres
 * across and the embankment starts ten from the centreline. `near` is the
 * embankment itself, seen at the edges of the frame and through every corner
 * that opens out. `far` is everything past the wall: the wide shots, and the
 * sense that the road goes somewhere.
 */
export type SceneryBand = 'verge' | 'near' | 'far';

export interface SceneryRecipe {
  kind: SceneryKind;
  band: SceneryBand;
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

/** A collider for a piece of scenery that is worth hitting. */
export interface SceneryCollider {
  shape: 'cylinder' | 'box';
  /** Centre of the shape in world space. */
  center: Vec3;
  /** Cylinder radius, or half the box's extent across its own facing. */
  radius: number;
  /** Half the vertical extent. */
  halfHeight: number;
  /** Half the box's extent along its own facing. Cylinders ignore it. */
  halfDepth: number;
  yaw: number;
}

export interface SceneryItem {
  kind: SceneryKind;
  /** Index into the biome's recipe list, so the renderer can batch by recipe. */
  recipe: number;
  /** Where the renderer anchors it: already sunk into the ground. */
  position: Vec3;
  yaw: number;
  /** Uniform size multiplier. */
  size: number;
  /** Extra vertical stretch on top of `size`, so a wood is not one silhouette. */
  stretch: number;
  /** Blend between the recipe's two colours, 0..1. */
  mix: number;
  /**
   * Tilt about the local across-axis, radians, applied after `yaw`.
   *
   * Only the things that lie along the ground get one. A wall on a climbing
   * street has to climb with it; left level it reads as a flight of steps, one
   * horizontal slab per placement, which is exactly how it looked.
   */
  pitch: number;
  /** Metres from the centreline. */
  offset: number;
  /** Present when this is something the car can hit. */
  solid?: SceneryCollider;
}

export const DRESSING: Record<string, SceneryRecipe[]> = {
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
export const SCENERY_REACH = 105;
/** Total instances allowed per stage, whatever the recipe asks for. */
export const SCENERY_BUDGET = 3200;

/**
 * How far past the outside of the corridor something can stand and still get a
 * collider, metres.
 *
 * Every collider is a broadphase entry and they are not free: measured with
 * `npm run perf`, giving one to everything within forty-six metres took a stage
 * step from 71 µs to 155 — more than doubling the simulation to hold trees no
 * car can reach. The embankment tops out at 2.4 m and the wall behind it stands
 * 8.5, so a car still on its wheels never leaves the corridor at all; what
 * leaves it is one coming off a crest sideways, and that lands in the first few
 * metres past the wall, not sixty metres into the wood. Past this margin,
 * scenery is a picture, and a picture costs nothing.
 *
 * Measured from the wall rather than from the centreline so a wide road and a
 * narrow one both keep the same run-off before the trees stop being real.
 */
export const SOLID_MARGIN = 12;

/**
 * The footprint of each kind at size 1, or null when it is soft.
 *
 * `radius` is the half-extent across the thing's own facing and `depth` the
 * half-extent along it; a kind with no `depth` is a cylinder and only has the
 * one. The two are not interchangeable: a stone wall is three metres of length
 * and half a metre of thickness, and which of those faces the road is the whole
 * difference between a wall beside a street and a barrier across it.
 *
 * Trees collide as their trunk, not their canopy. A pine drawn three metres
 * across at the base is mostly branches, and a collider that wide stops the car
 * a car's width short of the thing it appears to be hitting — which reads as
 * worse than no collider at all.
 */
const FOOTPRINT: Record<SceneryKind, { radius: number; height: number; depth?: number } | null> = {
  conifer: { radius: 0.42, height: 7.5 },
  snowFir: { radius: 0.45, height: 7.0 },
  broadleaf: { radius: 0.34, height: 5.0 },
  deadTree: { radius: 0.3, height: 5.5 },
  boulder: { radius: 0.95, height: 1.7 },
  building: { radius: 3.0, height: 9, depth: 3.0 },
  wall: { radius: 0.3, height: 1.4, depth: 1.7 },
  // Soft. You brush through heather, and you brush through grass.
  bush: null,
  tuft: null,
};

/**
 * The smallest thing worth colliding with, metres of half-extent.
 *
 * Two numbers, because the verge and the embankment are run-off and the wood
 * past the wall is not. Off the corridor, anything above knee height is a real
 * obstacle and should be one. On it, the bar is much higher: those bands are
 * strewn with scatter at 0.16 to 0.9 to give a quarry floor or a scree slope
 * its texture, and a run-off area with a rock every four metres is not a rally
 * stage, it is a cattle grid — measured, making all of it solid left the AI
 * unable to finish Grand Traverse in snow at all, because the place a car goes
 * when it runs wide on ice had become a boulder field.
 *
 * So what stands on the corridor has to be big enough to have been seen and
 * avoided. A metre and a half across is a rock you drive around; anything under
 * it is ground.
 */
const MIN_SOLID_EXTENT = 0.55;
const MIN_SOLID_EXTENT_ON_CORRIDOR = 0.75;

/** Kinds whose geometry stands on the ground rather than being sunk into it. */
const STANDING = new Set<SceneryKind>(['building', 'wall']);

/**
 * Clearance a solid thing must leave the driveable road, metres.
 *
 * Not the same question as how far out it was scattered. A stage is a ribbon
 * that can pass within thirty metres of itself, and scenery reaches a hundred
 * out — so a pine placed forty metres off one leg of Pine Loop stands squarely
 * in the middle of another. Drawn, that was always harmless; it disappears into
 * the trees at the side of the road you are on. Given a collider it was a tree
 * in the road, and it cost the AI ten seconds in the first sector of that stage
 * before this check existed.
 *
 * So solidity asks the road itself, not the scatter: whatever leg of whatever
 * corner this thing turned out to be nearest, is it clear of it?
 */
const ROAD_CLEARANCE = 0.4;

/**
 * How far a yawed box reaches across the road.
 *
 * A box turned to lie along the verge is only as wide as its thickness; the
 * same box turned across it is as wide as its length. Yaw maps the box's local
 * +Z onto the road's forward, so its axes in world terms are (cos, −sin) and
 * (sin, cos), and what matters is their projection onto the road's `left`.
 */
function acrossSpan(radius: number, depth: number, yaw: number, left: Vec3): number {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return (
    Math.abs(radius * (cos * left.x - sin * left.z)) +
    Math.abs(depth * (sin * left.x + cos * left.z))
  );
}

function colliderFor(
  kind: SceneryKind,
  size: number,
  stretch: number,
  position: Vec3,
  yaw: number,
  offset: number,
  reach: number,
  band: SceneryBand,
  spline: Spline,
): SceneryCollider | undefined {
  const base = FOOTPRINT[kind];
  if (!base) return undefined;
  if (offset > reach) return undefined;

  const radius = base.radius * size;
  const depth = (base.depth ?? base.radius) * size;
  // Measured on the larger dimension: a wall is thin and still worth stopping a
  // car, and a pebble is small in both.
  const floor = band === 'far' ? MIN_SOLID_EXTENT : MIN_SOLID_EXTENT_ON_CORRIDOR;
  if (Math.max(radius, depth) < floor) return undefined;

  // Nothing solid overhangs road anyone drives on — including a different part
  // of this one. What has to clear it is the shape's reach *across* that road,
  // which for a box is not its widest dimension: a stone wall is three metres
  // long and lies along the verge, so measuring it by its length would reject
  // every wall on a town stage and leave the street with nothing down its sides.
  const near = spline.locate(position);
  const span = base.depth === undefined ? radius : acrossSpan(radius, depth, yaw, near.sample.left);
  if (Math.abs(near.lateral) < near.sample.width + span + ROAD_CLEARANCE) return undefined;

  const halfHeight = (base.height * size * stretch) / 2;

  return {
    shape: base.depth === undefined ? 'cylinder' : 'box',
    center: v3(position.x, position.y + halfHeight, position.z),
    radius,
    halfHeight,
    halfDepth: depth,
    yaw,
  };
}

/**
 * Scatter a biome's dressing along a road.
 *
 * Placed along the centreline rather than across the bounding box: a stage is a
 * ribbon through a landscape, and scattering over its bounding box puts nine
 * tenths of the instances where the camera never looks.
 *
 * Takes the spline rather than the `Stage` that owns it, because it runs from
 * inside that stage's constructor.
 */
export function scatterScenery(id: string, biome: string, spline: Spline): SceneryItem[] {
  const recipes = DRESSING[biome] ?? DRESSING.forest!;
  const items: SceneryItem[] = [];
  const length = spline.length;

  // Seeded from the stage id: the same wood every time it loads, in the
  // browser, in the screenshot harness and on every machine in a race.
  let seed = 0;
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const step = 12;
  const samples = Math.max(Math.floor(length / step), 1);
  const total = recipes.reduce((sum, r) => sum + r.density, 0) * 2 * (length / 100);
  const budget = Math.min(1, SCENERY_BUDGET / Math.max(total, 1));

  for (let r = 0; r < recipes.length; r++) {
    const recipe = recipes[r]!;
    const perSample = (recipe.density / 100) * step * 2 * budget;
    const count = Math.max(Math.ceil(perSample * samples), 1);
    let n = 0;

    for (let i = 0; i < samples && n < count; i++) {
      const d = i * step + random() * step;
      const sample = spline.at(Math.min(d, length - 1));
      // The embankment, from the outer edge of the verge to just short of the
      // wall; and everything past the wall.
      const vergeFrom = sample.width + 0.35;
      const vergeTo = sample.width + CORRIDOR.vergeWidth - 0.4;
      const bankFrom = sample.width + CORRIDOR.vergeWidth + 0.6;
      const bankTo = sample.width + CORRIDOR.vergeWidth + CORRIDOR.bankWidth - 0.5;
      const beyond = sample.width + CORRIDOR.vergeWidth + CORRIDOR.bankWidth + 2 + (recipe.push ?? 0);
      // Outside of the wall, plus the run-off a launched car can cover.
      const reach =
        sample.width + CORRIDOR.vergeWidth + CORRIDOR.bankWidth + CORRIDOR.wallWidth + SOLID_MARGIN;

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

        const position = v3(
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
        const standing = STANDING.has(recipe.kind);
        position.y -= standing ? 0.15 : 0.6 * size;
        const stretch = 0.85 + random() * 0.4;
        // A wall follows the road. Given a random yaw like everything else it
        // read as scattered planks rather than as the edge of a street.
        const yaw =
          recipe.kind === 'wall'
            ? Math.atan2(sample.forward.x, sample.forward.z) + (random() - 0.5) * 0.12
            : random() * Math.PI * 2;
        // A wall follows the ground as well as the road. The forward vector is
        // a unit tangent, so its y component is the sine of the gradient.
        const pitch = recipe.kind === 'wall' ? -Math.asin(clamp(sample.forward.y, -1, 1)) : 0;
        const mix = random();

        const item: SceneryItem = {
          kind: recipe.kind,
          recipe: r,
          position,
          yaw,
          size,
          stretch,
          mix,
          pitch,
          offset: out,
        };
        const solid = colliderFor(recipe.kind, size, stretch, position, yaw, out, reach, recipe.band, spline);
        if (solid) item.solid = solid;
        items.push(item);
        n++;
      }
    }
  }

  return items;
}
