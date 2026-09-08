/**
 * The last few seconds, kept so a crash can be replayed rather than re-staged.
 *
 * The cinematic used to play back a *ghost* — a recording of where the car was
 * — and pose everything else from the present. The comment where that happened
 * said as much and called it "a small lie". It is a bigger one than it looks,
 * and it is exactly what makes the replay read as a recreation instead of a
 * recording:
 *
 * - **The car is already wrecked before it hits anything.** Damage is read live,
 *   so the fold you are about to watch happen is on the car all the way in.
 * - **Whatever it hit is not there.** A deer is placed and stepped by the
 *   simulation, and the simulation has moved on — so the replay shows a car
 *   swerving at nothing and crumpling for no reason.
 *
 * A ghost cannot fix either, and should not try: ghosts are saved to disk and
 * compared across sessions, so their format has to stay small and stable. This
 * is the other thing — a ring buffer of the last few seconds that is never
 * saved, never compared, and thrown away the moment the cinematic ends. It can
 * afford to record whatever the picture needs.
 *
 * It holds only what the renderer actually reads: component health, part
 * attachment, brake heat, where the animals were, and how much of the roadside
 * was still standing. Not the whole simulation — a replay does not need to be
 * re-simulatable, it needs to look like what happened.
 */

import { COMPONENTS, type ComponentId, type Dent } from '../sim/damage.js';
import { PARTS, type DebrisModel, type PartId, type PartState } from '../sim/debris.js';
import type { Quat, Vec3 } from '../sim/math.js';
import type { Animal } from '../sim/wildlife.js';
import type { VehicleState } from '../sim/vehicle.js';

/**
 * Seconds kept. The cinematic opens 1.25 s before the impact, and a little
 * slack means the buffer is never empty at the moment it is asked for.
 */
const WINDOW = 2.5;
/**
 * Frames a second.
 *
 * The replay runs at about a third of real time, so 30 Hz of source is 90 Hz of
 * playback — well past what anybody can see, and cheap enough not to think
 * about: at 43 components and 20 parts, a full window is around forty
 * kilobytes and it never leaves memory.
 */
const RATE = 30;
const CAPACITY = Math.ceil(WINDOW * RATE) + 2;

const PART_CODE: Record<PartState, number> = { attached: 0, dragging: 1, gone: 2 };
const PART_STATE: PartState[] = ['attached', 'dragging', 'gone'];

export interface ReelAnimal {
  position: Vec3;
  yaw: number;
  /** Tumble, so a struck animal is lying down in the replay as it was. */
  roll: number;
  /** True once it has been hit, so the renderer can drop it as the sim does. */
  gone: boolean;
}

export interface ReelFrame {
  t: number;
  position: Vec3;
  rotation: Quat;
  steer: number;
  wheelRotation: number[];
  wheelCompression: number[];
  wheelGrounded: boolean[];
  health: Float32Array;
  parts: Uint8Array;
  brakeGlow: number[];
  brakeTint: number[];
  /**
   * The folds, copied.
   *
   * The live list is mutated in place — dents merge into each other as a corner
   * is hit repeatedly — so holding a reference would give every recorded frame
   * the *final* set of folds, which is the bug this whole file exists to fix,
   * reintroduced one level down.
   */
  dents: Dent[];
  animals: ReelAnimal[];
  /**
   * The world the car was driving through, as far as the picture is concerned.
   *
   * The car was recorded and everything around it was not, so a replay of the
   * seconds before a crash was drawn against the road *after* it: the skid
   * marks the car was still in the middle of laying were already on the tarmac,
   * and the boards and poles it was about to flatten were already flat. Both
   * are cheap to record — a stamp and two 0..1 arrays — and both are the
   * difference between watching a crash and watching its aftermath.
   */
  skidStamp: number;
  signsFallen: Float32Array;
  markersFallen: Float32Array;
}

/**
 * What the reel reads off a damage model.
 *
 * Structural rather than the class, because what it is handed is the
 * *renderer's* eased view — the reel records what a person saw, and on screen a
 * fold takes a tenth of a second to arrive. A `DamageModel` satisfies this too.
 */
export interface ReelDamage {
  get(id: ComponentId): number;
  brakeGlow(index: number): number;
  brakeTint(index: number): number;
  readonly dents: readonly Dent[];
}

/** What the reel needs from the world besides the car. */
export interface ReelProps {
  /** `SkidMarks.stamp`: the road as it was at this instant. */
  skidStamp: number;
  /**
   * Only `fallen` is recorded. `knockedToward` is set once, when a thing goes
   * over, and never changes — so the live value is the recorded one, and a
   * board that has not fallen yet has `fallen` 0 and does not use it.
   */
  signs: readonly { fallen: number }[];
  markers: readonly { fallen: number }[];
}

/**
 * A stand-in for the live `DamageModel`, reading a recorded frame.
 *
 * The renderer only ever asks a damage model three questions, so this is the
 * whole of it. Deliberately not a `DamageModel` subclass: it has no history, no
 * thresholds and nothing to apply an impact to, and pretending otherwise would
 * invite somebody to hand it to something that wanted to change it.
 */
export class RecordedDamage {
  private readonly index = new Map<ComponentId, number>();

  constructor(private frame: ReelFrame) {
    for (let i = 0; i < COMPONENTS.length; i++) this.index.set(COMPONENTS[i]!.id, i);
  }

  at(frame: ReelFrame): this {
    this.frame = frame;
    return this;
  }

  get(id: ComponentId): number {
    const i = this.index.get(id);
    return i === undefined ? 1 : (this.frame.health[i] ?? 1);
  }

  get dents(): readonly Dent[] {
    return this.frame.dents;
  }

  /**
   * A version that changes with the frame, so the renderer rebuilds the folds
   * as the replay runs. Frames are 1/30 s apart and each has its own dent list,
   * so the frame's own timestamp is exactly the right key.
   */
  get dentVersion(): number {
    return this.frame.t;
  }

  brakeGlow(i: number): number {
    return this.frame.brakeGlow[i] ?? 0;
  }

  brakeTint(i: number): number {
    return this.frame.brakeTint[i] ?? 0;
  }
}

/** The same, for the parts that fall off. */
export class RecordedDebris {
  private readonly index = new Map<PartId, number>();

  constructor(private frame: ReelFrame) {
    for (let i = 0; i < PARTS.length; i++) this.index.set(PARTS[i]!.id, i);
  }

  at(frame: ReelFrame): this {
    this.frame = frame;
    return this;
  }

  stateOf(id: PartId): PartState {
    const i = this.index.get(id);
    if (i === undefined) return 'attached';
    return PART_STATE[this.frame.parts[i] ?? 0] ?? 'attached';
  }

  isLoose(id: PartId): boolean {
    // The live model calls a part loose when it is still attached and hanging.
    // Recorded, that is the `dragging` code's neighbour: a part that is on the
    // car and already flagged. Kept simple on purpose — this drives a wobble,
    // not a collider.
    return this.stateOf(id) === 'attached' && (this.frame.parts[this.index.get(id) ?? 0] ?? 0) === 1;
  }
}

/**
 * A frame of nothing, for constructing the recorded views before there is
 * anything to show. They are pointed at a real frame every time one is drawn.
 */
export const EMPTY_REEL_FRAME: ReelFrame = {
  t: 0,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  steer: 0,
  wheelRotation: [0, 0, 0, 0],
  wheelCompression: [0.5, 0.5, 0.5, 0.5],
  wheelGrounded: [true, true, true, true],
  health: new Float32Array(COMPONENTS.length).fill(1),
  parts: new Uint8Array(PARTS.length),
  brakeGlow: [0, 0, 0, 0],
  brakeTint: [0, 0, 0, 0],
  dents: [],
  animals: [],
  skidStamp: 0,
  signsFallen: new Float32Array(0),
  markersFallen: new Float32Array(0),
};

export class CrashReel {
  private readonly frames: ReelFrame[] = [];
  /** Next slot to write. The buffer is a ring once it is full. */
  private next = 0;
  private since = 0;
  private clock = 0;

  /**
   * Record, if enough time has passed.
   *
   * Driven by the *wall* clock, not the simulation's: this is a picture of what
   * a person saw, and during a crash the simulation's clock is the one being
   * slowed down.
   */
  capture(
    wallDt: number,
    transform: { position: Vec3; rotation: Quat },
    state: VehicleState,
    damage: ReelDamage | null,
    debris: DebrisModel | null,
    animals: readonly Animal[],
    props: ReelProps,
  ): void {
    this.clock += wallDt;
    this.since += wallDt;
    if (this.since < 1 / RATE) return;
    this.since = 0;

    const health = new Float32Array(COMPONENTS.length);
    if (damage) for (let i = 0; i < COMPONENTS.length; i++) health[i] = damage.get(COMPONENTS[i]!.id);
    else health.fill(1);

    const parts = new Uint8Array(PARTS.length);
    if (debris) for (let i = 0; i < PARTS.length; i++) parts[i] = PART_CODE[debris.stateOf(PARTS[i]!.id)];

    const frame: ReelFrame = {
      t: this.clock,
      position: { ...transform.position },
      rotation: { ...transform.rotation },
      // The front wheels; the rears do not steer, and the ghost format records
      // the same single angle for the same reason.
      steer: state.wheels[0]?.steer ?? 0,
      wheelRotation: state.wheels.map((w) => w.rotation),
      wheelCompression: state.wheels.map((w) => w.compression),
      wheelGrounded: state.wheels.map((w) => w.grounded),
      health,
      parts,
      brakeGlow: [0, 1, 2, 3].map((i) => damage?.brakeGlow(i) ?? 0),
      brakeTint: [0, 1, 2, 3].map((i) => damage?.brakeTint(i) ?? 0),
      dents: (damage?.dents ?? []).map((d) => ({ at: { ...d.at }, depth: d.depth, reach: d.reach })),
      // Only what is drawn: an animal's whole behaviour state is the
      // simulation's business, and the picture needs where it stood.
      animals: animals.map((a) => ({
        position: { ...a.position },
        yaw: a.yaw,
        roll: a.roll,
        gone: a.state === 'gone',
      })),
      skidStamp: props.skidStamp,
      signsFallen: Float32Array.from(props.signs, (sign) => sign.fallen),
      markersFallen: Float32Array.from(props.markers, (marker) => marker.fallen),
    };

    if (this.frames.length < CAPACITY) this.frames.push(frame);
    else this.frames[this.next] = frame;
    this.next = (this.next + 1) % CAPACITY;
  }

  /** Everything held, oldest first. */
  private ordered(): ReelFrame[] {
    if (this.frames.length < CAPACITY) return this.frames;
    return [...this.frames.slice(this.next), ...this.frames.slice(0, this.next)];
  }

  /**
   * Take the last `seconds` as a playable strip, or null if there is not enough.
   *
   * A copy, because the reel keeps recording the moment the cinematic starts —
   * the world is still running behind it — and a strip that changed underneath
   * the playback would show the crash happening twice.
   */
  take(seconds: number): ReelStrip | null {
    const all = this.ordered();
    if (all.length < 4) return null;
    const end = all[all.length - 1]!.t;
    const from = all.filter((f) => f.t >= end - seconds);
    if (from.length < 4) return null;
    return new ReelStrip(from);
  }

  reset(): void {
    this.frames.length = 0;
    this.next = 0;
    this.since = 0;
    this.clock = 0;
  }
}

/** A recorded strip, sampled by time from its own start. */
export class ReelStrip {
  readonly duration: number;
  private readonly start: number;

  constructor(private readonly frames: ReelFrame[]) {
    this.start = frames[0]!.t;
    this.duration = frames[frames.length - 1]!.t - this.start;
  }

  /**
   * The frame at a time, without interpolating.
   *
   * Nearest rather than blended, and that is deliberate: the whole point of the
   * strip is that a car with a folded wing and a wing that is still straight
   * are different cars, and a half-folded blend of two damage states is a third
   * car that never existed. At 30 Hz played back at a third speed, the seam is
   * far below what anyone can see.
   */
  at(time: number): ReelFrame {
    const t = this.start + Math.max(0, Math.min(time, this.duration));
    let best = this.frames[0]!;
    for (const frame of this.frames) {
      if (frame.t <= t) best = frame;
      else break;
    }
    return best;
  }
}
