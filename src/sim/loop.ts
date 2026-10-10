/**
 * A loop-the-loop: a piece of track that leaves the road, goes over the top
 * upside down, and puts the car back on the road further on.
 *
 * It is not part of the spline, and cannot be. Everything that hangs off the
 * centreline — the corridor's cross-section, the nearest-sample query, the
 * terrain, the camera, the AI's bearing — assumes that up is +Y, and inside a
 * loop up goes all the way round. So the loop is its own swept ribbon with its
 * own frame per sample, its own collider, and its own 3D nearest-point query,
 * and the stage's road runs along the ground underneath it: approach lane in,
 * a gentle sideways jog under the loop, exit lane out. A car that falls off the
 * top lands on that road and carries on, which is the honest failure.
 *
 * ## The shape
 *
 * A circle is the wrong shape. Its curvature is the same all the way round, so
 * the car meets the whole of it at once at the bottom: at the speed a circle
 * needs to be got round at all, the entry is about 8 g. So the curvature is
 * eased in and out — `k = a·ease(s) + b·sin⁴(πs/S)`, most of the turn
 * concentrated over the top — which is the clothoid loop roller coasters use,
 * for the same reason. The shape (`SHAPE`) was chosen by driving the real car
 * through a sweep of them: 130 m of path, 26 m tall, the most circular-looking
 * of the shapes that keep the car pressed into the deck over the top.
 *
 * The base term eases in from zero over twenty metres. As first built it
 * stepped straight to a 63 m radius at the entry, and the heave that set off
 * put the springs at full travel before the car had climbed two metres.
 *
 * A symmetric curvature puts the exit as far past the top as the entry is
 * before it, so the car rejoins the road `advance` metres ahead of where it
 * left — and the two lanes cross in side view. `shift` moves the exit lane
 * sideways, between the two crossings only, so they pass beside each other.
 *
 * ## The deck gives
 *
 * No loop this car can get over the top of is gentle enough for its
 * suspension: it costs 4 to 6 g low down, and the springs run out at about
 * 4.9. Past full travel the floor pan met the deck and stopped the car dead.
 * So the deck flexes under a wheel (`DECK_FLEX`), which is the only surface in
 * the game that does; a general bump stop would have done the same and changed
 * the landings on the five stages that reach full travel today. Two stiffer,
 * damped versions were tried and both were worse: a spring that stiff is too
 * stiff for a 120 Hz step, and they *added* energy — a car went up 25 m and
 * came out faster than it went in. What is left, a few light brushes of the
 * floor pan over the top, is not billed as an impact (`SimWorld`).
 *
 * ## Why there is a booster
 *
 * Measured, the car gets round from 70 km/h to 150 with the throttle held —
 * the engine out-climbs gravity — but flat out bottoms it hard enough to cost
 * 17% of its condition, and lifting over the top leaves almost nothing holding
 * it to the deck. A booster before the entry sets the speed, the way a toy
 * track's powered booster does, so the loop is the same loop for every car.
 */

import { type Vec3, add, cross, dot, normalize, scale, sub, v3 } from './math.js';
import type { SurfaceId } from './surfaces.js';

export interface LoopSpec {
  /** Where the car leaves the road, metres along the stage. The road must be straight here. */
  at: number;
  /** Length of the path from leaving the road to rejoining it, metres. */
  length: number;
  /**
   * How far across the exit lands from the entry, metres. Positive is to the
   * driver's left, like `lateral` everywhere else.
   */
  shift: number;
  /** Half-width of the deck between the rails, metres. */
  width: number;
  surface: SurfaceId;
  /** The powered booster before the entry: how long it is, and the speed it sets, m/s. */
  boost: { length: number; speed: number };
  /**
   * The curvature profile, when not the default: the share of the turn in the
   * sharp term, its power, and the metres the base term eases in over.
   */
  shape?: LoopShape;
}

export interface LoopShape {
  share: number;
  power: number;
  ease: number;
}

export interface LoopSample {
  /** Metres along the loop's own path; 0 is where it leaves the road. */
  s: number;
  position: Vec3;
  forward: Vec3;
  /** Across the deck, to the driver's left — the loop's own left, not the world's. */
  left: Vec3;
  /** Out of the deck. Points straight down over the top. */
  up: Vec3;
}

/** Share of the turning concentrated toward the top, how sharply, and how the base eases in. */
const SHAPE: LoopShape = { share: 0.85, power: 2, ease: 20 };
/** Metres of path between samples. Fine, because this is a collider the car is on at speed. */
const STEP = 0.5;
/**
 * Straight deck lying on the road before the entry and after the exit, metres.
 *
 * The deck has no crown and the road does, so a deck that simply started at
 * the entry would be a five-centimetre step under each wheel at 100 km/h. It
 * starts below the road surface instead and rises through it, and the rails
 * rise out of the deck over the same distance, so nothing on it is an edge.
 *
 * Long, because the rise is a kick. Over eight metres it was 0.34 m/s upward
 * at the booster's speed, then flat again at the entry: the car came off the
 * kink light at the front, landed into the curve on the way back down, and
 * the heave put the springs at full travel and the floor pan on the deck.
 */
export const LOOP_RUN_IN = 24;
/** Deck height above the road's crown once clear of the run-in, metres. */
const DECK_LIFT = 0.02;
/** How far below the crown the run-in starts, metres. */
const DECK_SINK = 0.04;
/** The rails: how tall, how thick, and how deep the deck slab is under them. */
export const RAIL_HEIGHT = 0.6;
export const RAIL_WIDTH = 0.25;
export const DECK_DEPTH = 0.25;
/** Metres of path either side of the crossing over which the sideways move eases in. */
const CROSS_MARGIN = 3;
/** Columns in the deck's cross-section; see `profile`. */
export const LOOP_COLUMNS = 9;

/**
 * Cross-section of the track, from the outside of the left rail round to the
 * outside of the right: down the outside, over the top, down the inside, across
 * the deck and back out the other side. `rail` scales the rail height on the
 * run-in.
 */
function profile(width: number, rail: number): { across: number; height: number }[] {
  const r = RAIL_HEIGHT * rail;
  return [
    { across: width + RAIL_WIDTH, height: -DECK_DEPTH },
    { across: width + RAIL_WIDTH, height: r },
    { across: width, height: r },
    { across: width, height: 0 },
    { across: 0, height: 0 },
    { across: -width, height: 0 },
    { across: -width, height: r },
    { across: -width - RAIL_WIDTH, height: r },
    { across: -width - RAIL_WIDTH, height: -DECK_DEPTH },
  ];
}

const smooth = (t: number) => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

/**
 * The loop's path in its own plane: metres forward, metres up and the pitch,
 * every `STEP` from 0 to `length`, by integrating the curvature.
 */
function sidePath(length: number, shape: LoopShape = SHAPE): { x: number; y: number }[] {
  const { share, power, ease: easeOver } = shape;
  const n = Math.round(length / STEP);
  const ds = length / n;
  // The base curvature eases in from zero rather than starting at full: as
  // first built it stepped straight to a 63 m radius at the entry, the deck
  // came up into the car at 1.1 m/s, and the springs overshot from the 2.6 g
  // the curve asks for to full travel and put the floor pan on the deck.
  const ease = (i: number) => {
    const s = (i + 0.5) * ds;
    return smooth(s / easeOver) * smooth((length - s) / easeOver);
  };
  // Normalise both terms so the whole turn is exactly one revolution.
  let shaped = 0;
  let base = 0;
  for (let i = 0; i < n; i++) {
    shaped += Math.sin((Math.PI * (i + 0.5)) / n) ** (2 * power) * ds;
    base += ease(i) * ds;
  }
  const a = (2 * Math.PI * (1 - share)) / base;
  const b = (2 * Math.PI * share) / shaped;

  const out: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let pitch = 0;
  for (let i = 0; i <= n; i++) {
    out.push({ x, y });
    // Midpoint rule on the curvature, so the integration is symmetric and the
    // exit comes back down to exactly the height it left.
    const k = a * ease(i) + b * Math.sin((Math.PI * (i + 0.5)) / n) ** (2 * power);
    const half = pitch + (k * ds) / 2;
    x += Math.cos(half) * ds;
    y += Math.sin(half) * ds;
    pitch += k * ds;
  }
  return out;
}

/** How far forward of the entry the exit lands, for a loop of this length, metres. */
export function loopAdvance(length: number, shape?: LoopShape): number {
  const path = sidePath(length, shape);
  return path[path.length - 1]!.x;
}

export interface LoopGeometry {
  vertices: Float32Array;
  indices: Uint32Array;
  /** Metres along the loop's path, per vertex row (`LOOP_COLUMNS` to a row). */
  along: Float32Array;
}

export class TrackLoop {
  readonly spec: LoopSpec;
  readonly samples: LoopSample[] = [];
  /** Path length including the run-in and run-out, metres. */
  readonly length: number;
  /** Metres forward of the entry the exit lands. */
  readonly advance: number;
  /** Where the car leaves the road, and the frame it leaves in. */
  readonly origin: Vec3;
  readonly forward: Vec3;
  readonly left: Vec3;
  readonly geometry: LoopGeometry;
  /** Highest point of the deck above the road, metres. */
  readonly top: number;
  /** Metres along the path where the way up passes over the way down. */
  readonly crossing: number;
  private readonly min: Vec3;
  private readonly max: Vec3;

  /**
   * @param origin The road's crown at `spec.at`.
   * @param forward The road's heading there, flat.
   */
  constructor(spec: LoopSpec, origin: Vec3, forward: Vec3) {
    this.spec = spec;
    this.origin = origin;
    this.forward = normalize(v3(forward.x, 0, forward.z));
    this.left = normalize(cross(v3(0, 1, 0), this.forward));
    const side = sidePath(spec.length, spec.shape);
    this.advance = side[side.length - 1]!.x;

    // The path in plan and elevation, run-in to run-out, in world space.
    const raw: { s: number; position: Vec3; rail: number }[] = [];
    const place = (x: number, y: number, across: number) =>
      add(add(origin, scale(this.forward, x)), add(v3(0, y, 0), scale(this.left, across)));
    const runSteps = Math.round(LOOP_RUN_IN / STEP);
    for (let i = -runSteps; i < 0; i++) {
      const x = i * STEP;
      const t = (x + LOOP_RUN_IN) / LOOP_RUN_IN;
      raw.push({ s: x, position: place(x, -DECK_SINK + (DECK_SINK + DECK_LIFT) * t, 0), rail: smooth(t) });
    }
    // Where the way up crosses the way down in side view. The curvature is
    // symmetric, so the two halves are mirror images about the midline and
    // the crossing is where the way up passes it.
    let over = 0;
    while (over < side.length - 1 && side[over]!.x < this.advance / 2) over++;
    const crossAt = (over / (side.length - 1)) * spec.length;
    this.crossing = crossAt;
    for (let i = 0; i < side.length; i++) {
      const s = (i / (side.length - 1)) * spec.length;
      const p = side[i]!;
      // Sideways only between the two crossings, so where the lanes pass each
      // other they are the whole of `shift` apart. Spread over the whole loop,
      // as first built, they were five metres apart there against nearly eight
      // of deck and rails: the car clipped the far rail on the way up, went
      // light, and on the way down landed on the way up and stopped dead.
      const t = (s - crossAt + CROSS_MARGIN) / (spec.length - 2 * crossAt + 2 * CROSS_MARGIN);
      raw.push({ s, position: place(p.x, p.y + DECK_LIFT, spec.shift * smooth(t)), rail: 1 });
    }
    for (let i = 1; i <= runSteps; i++) {
      const x = this.advance + i * STEP;
      const t = 1 - (i * STEP) / LOOP_RUN_IN;
      raw.push({
        s: spec.length + i * STEP,
        position: place(x, -DECK_SINK + (DECK_SINK + DECK_LIFT) * t, spec.shift),
        rail: smooth(t),
      });
    }

    // Frames: the tangent from the neighbours, the loop's fixed left axis, and
    // up as whatever is square to both. The left axis never lines up with the
    // tangent — the sideways drift is small — so this is defined everywhere,
    // including straight up and upside down.
    let top = 0;
    for (let i = 0; i < raw.length; i++) {
      const prev = raw[Math.max(i - 1, 0)]!.position;
      const next = raw[Math.min(i + 1, raw.length - 1)]!.position;
      const f = normalize(sub(next, prev));
      const up = normalize(cross(f, this.left));
      const left = normalize(cross(up, f));
      this.samples.push({ s: raw[i]!.s, position: raw[i]!.position, forward: f, left, up });
      top = Math.max(top, raw[i]!.position.y - origin.y);
    }
    this.top = top;
    this.length = spec.length + 2 * LOOP_RUN_IN;

    // The ribbon. The same rows for the collider and for the picture.
    const columns = LOOP_COLUMNS;
    const vertices = new Float32Array(this.samples.length * columns * 3);
    const along = new Float32Array(this.samples.length * columns);
    const min = v3(Infinity, Infinity, Infinity);
    const max = v3(-Infinity, -Infinity, -Infinity);
    let v = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const sample = this.samples[i]!;
      for (const p of profile(spec.width, raw[i]!.rail)) {
        const point = add(add(sample.position, scale(sample.left, p.across)), scale(sample.up, p.height));
        vertices[v * 3] = point.x;
        vertices[v * 3 + 1] = point.y;
        vertices[v * 3 + 2] = point.z;
        along[v] = sample.s;
        min.x = Math.min(min.x, point.x);
        min.y = Math.min(min.y, point.y);
        min.z = Math.min(min.z, point.z);
        max.x = Math.max(max.x, point.x);
        max.y = Math.max(max.y, point.y);
        max.z = Math.max(max.z, point.z);
        v++;
      }
    }
    // Closed round the cross-section — the last column joins the first along
    // the slab's underside — so the deck is a solid strip rather than a sheet.
    const indices = new Uint32Array((this.samples.length - 1) * columns * 6);
    let t = 0;
    for (let i = 0; i < this.samples.length - 1; i++) {
      for (let c = 0; c < columns; c++) {
        const c2 = (c + 1) % columns;
        const a = i * columns + c;
        const b = i * columns + c2;
        const d = (i + 1) * columns + c;
        const e = (i + 1) * columns + c2;
        // Wound outward, which `FIX_INTERNAL_EDGES` needs: it works from the
        // mesh's pseudo-normals, and wound inward every contact on the deck
        // would push the car into it.
        indices[t++] = a;
        indices[t++] = b;
        indices[t++] = d;
        indices[t++] = b;
        indices[t++] = e;
        indices[t++] = d;
      }
    }
    this.geometry = { vertices, indices, along };
    // A car's reach either side of the ribbon.
    const pad = 3;
    this.min = v3(min.x - pad, min.y - pad, min.z - pad);
    this.max = v3(max.x + pad, max.y + pad, max.z + pad);
  }

  /** Where the car rejoins the road, on the road's crown. */
  get exit(): Vec3 {
    return add(add(this.origin, scale(this.forward, this.advance)), scale(this.left, this.spec.shift));
  }

  /** Whether a point is anywhere near the ribbon. Cheap: it runs per wheel per step. */
  near(point: Vec3): boolean {
    return (
      point.x >= this.min.x &&
      point.x <= this.max.x &&
      point.y >= this.min.y &&
      point.y <= this.max.y &&
      point.z >= this.min.z &&
      point.z <= this.max.z
    );
  }

  /**
   * Where a point is on the loop, or null when it is not on it.
   *
   * Nearest in three dimensions, which is the whole reason this is not the
   * spline's query: seen from above, the top of the loop is directly over its
   * own entry and exit, and a nearest-in-plan answer cannot tell them apart.
   * "On it" is within the rails and no more than a car's height off the deck,
   * so a car on the road underneath is not on the loop.
   */
  locate(point: Vec3, hint?: number): { index: number; sample: LoopSample; lateral: number; height: number } | null {
    if (!this.near(point)) return null;
    let best = -1;
    let bestD = Infinity;
    const scan = (lo: number, hi: number) => {
      for (let i = lo; i <= hi; i++) {
        const p = this.samples[i]!.position;
        const dx = p.x - point.x;
        const dy = p.y - point.y;
        const dz = p.z - point.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    };
    if (hint !== undefined && hint >= 0 && hint < this.samples.length) {
      scan(Math.max(0, hint - 24), Math.min(this.samples.length - 1, hint + 24));
      if (bestD > 9) scan(0, this.samples.length - 1);
    } else {
      scan(0, this.samples.length - 1);
    }
    const sample = this.samples[best]!;
    const delta = sub(point, sample.position);
    const lateral = dot(delta, sample.left);
    const height = dot(delta, sample.up);
    if (Math.abs(lateral) > this.spec.width + RAIL_WIDTH + 0.5) return null;
    if (height < -0.6 || height > 3.2) return null;
    return { index: best, sample, lateral, height };
  }

  /**
   * Where a point is relative to the booster, or null when it is not on it:
   * on the approach lane, from `boost.length` before the run-in to the entry,
   * and on the deck rather than flying over it.
   *
   * All the way to the entry, not just the booster's own length: ending at the
   * run-in left twenty metres of full throttle before the loop, and the car
   * arrived two metres a second over the speed the loop was built for.
   */
  boostAt(point: Vec3): { forward: Vec3 } | null {
    const delta = sub(point, this.origin);
    const x = dot(delta, this.forward);
    if (x > 0 || x < -LOOP_RUN_IN - this.spec.boost.length) return null;
    if (Math.abs(dot(delta, this.left)) > this.spec.width) return null;
    if (Math.abs(delta.y) > 2.5) return null;
    return { forward: this.forward };
  }

  /** Where the booster starts, on the road's crown. */
  boostStart(): Vec3 {
    return add(this.origin, scale(this.forward, -LOOP_RUN_IN - this.spec.boost.length));
  }

  /** Stretch of the stage, metres along it, that the booster and the loop take up. */
  span(): [number, number] {
    return [this.spec.at - LOOP_RUN_IN - this.spec.boost.length, this.spec.at + this.advance + LOOP_RUN_IN];
  }
}

/**
 * How stiff the deck is under a wheel past the car's own travel, N/m, and how
 * far before full travel it starts to carry, metres.
 *
 * A toy track's deck is plastic and it gives; this is that, and it is the only
 * surface in the game that does. Without it there is no loop this car can
 * drive: one it can get over the top of costs it 4 to 6 g at the bottom, its
 * springs run out at about 4.9, and past that the floor pan met the deck and
 * stopped the car from 110 km/h in a step. A general bump stop would do the
 * same job and change every landing and kerb on every other stage.
 */
export const DECK_FLEX = 250_000;
export const DECK_FLEX_FROM = 0.04;

/**
 * The booster's push, newtons along the road, for a car of `mass` going
 * `speed` m/s along it.
 *
 * Proportional to the error, so it holds a car at the set speed rather than
 * flinging it, and capped, so arriving flat out is a firm slowing rather than
 * a wall. A toy booster pinches the car between two spinning tyres, and that
 * is what this is: it brings a car to the tyres' speed from either side.
 */
export const BOOST_GAIN = 3;
export const BOOST_MAX_ACCEL = 14;
export function boostForce(mass: number, speed: number, target: number): number {
  const accel = Math.max(-BOOST_MAX_ACCEL, Math.min(BOOST_MAX_ACCEL, (target - speed) * BOOST_GAIN));
  return mass * accel;
}
