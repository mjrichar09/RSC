/**
 * Ghost recording and playback.
 *
 * Ghosts store sampled transforms, not inputs. Replaying inputs would be
 * smaller, but it would make every saved ghost depend on the physics producing
 * bit-identical results forever — so any tuning change or engine upgrade would
 * silently corrupt every time a player had ever set. Recording where the car
 * actually was costs a couple of hundred kilobytes and survives everything.
 *
 * Each frame also stores how far along the stage the car was, which is what
 * makes a live delta possible: "where was the ghost when it had come this far"
 * is a lookup by distance, not by time.
 */

import { SIM } from '../data/tuning.js';
import type { Quat, Vec3 } from './math.js';
import { lerp, lerpVec, slerp } from './math.js';
import type { VehicleState } from './vehicle.js';

/**
 * Floats per frame:
 *   0     time
 *   1-3   position
 *   4-7   rotation
 *   8     steering angle
 *   9-12  wheel rotation
 *   13    distance along the stage
 */
export const GHOST_STRIDE = 14;

export interface Ghost {
  stageId: string;
  /** Finish time in seconds. */
  time: number;
  /** Recorded at, epoch milliseconds. */
  recordedAt: number;
  frames: Float32Array;
}

export interface GhostSample {
  position: Vec3;
  rotation: Quat;
  steer: number;
  wheelRotation: number[];
}

export class GhostRecorder {
  private readonly frames: number[] = [];
  private readonly interval = 1 / SIM.recordHz;
  private nextAt = 0;

  /** Call once per fixed step while the race is running. */
  capture(time: number, distance: number, state: VehicleState): void {
    if (time < this.nextAt) return;
    this.nextAt = time + this.interval;

    const w = state.wheels;
    this.frames.push(
      time,
      state.position.x,
      state.position.y,
      state.position.z,
      state.rotation.x,
      state.rotation.y,
      state.rotation.z,
      state.rotation.w,
      w[0]!.steer,
      w[0]!.rotation,
      w[1]!.rotation,
      w[2]!.rotation,
      w[3]!.rotation,
      distance,
    );
  }

  get frameCount(): number {
    return this.frames.length / GHOST_STRIDE;
  }

  finish(stageId: string, time: number): Ghost {
    return {
      stageId,
      time,
      recordedAt: Date.now(),
      frames: Float32Array.from(this.frames),
    };
  }

  reset(): void {
    this.frames.length = 0;
    this.nextAt = 0;
  }
}

export class GhostPlayer {
  readonly ghost: Ghost;
  private readonly count: number;

  constructor(ghost: Ghost) {
    this.ghost = ghost;
    this.count = ghost.frames.length / GHOST_STRIDE;
  }

  private field(frame: number, offset: number): number {
    return this.ghost.frames[frame * GHOST_STRIDE + offset]!;
  }

  /** Interpolated pose at a point in time, clamped to the ends of the run. */
  sampleAt(time: number): GhostSample | null {
    if (this.count === 0) return null;

    const last = this.count - 1;
    // Frames are recorded at a fixed rate, so the index is a direct estimate
    // rather than a search.
    const raw = time * SIM.recordHz;
    const i = Math.min(Math.max(Math.floor(raw), 0), last);
    const j = Math.min(i + 1, last);
    const t = j === i ? 0 : Math.min(Math.max(raw - i, 0), 1);

    const pos = (f: number) => ({ x: this.field(f, 1), y: this.field(f, 2), z: this.field(f, 3) });
    const rot = (f: number) => ({
      x: this.field(f, 4),
      y: this.field(f, 5),
      z: this.field(f, 6),
      w: this.field(f, 7),
    });

    return {
      position: lerpVec(pos(i), pos(j), t),
      rotation: slerp(rot(i), rot(j), t),
      steer: lerp(this.field(i, 8), this.field(j, 8), t),
      wheelRotation: [9, 10, 11, 12].map((o) => lerp(this.field(i, o), this.field(j, o), t)),
    };
  }

  /**
   * When the ghost had travelled `distance` along the stage.
   *
   * This is what a live delta is made of: comparing the player's clock against
   * the ghost's clock at the same point on the road, rather than comparing
   * positions at the same moment in time.
   */
  timeAtDistance(distance: number): number | null {
    if (this.count === 0) return null;
    if (distance <= this.field(0, 13)) return this.field(0, 0);

    // Distance is monotonic (it is the race's furthest-reached value), so a
    // binary search is valid.
    let lo = 0;
    let hi = this.count - 1;
    if (distance >= this.field(hi, 13)) return this.field(hi, 0);

    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.field(mid, 13) <= distance) lo = mid;
      else hi = mid;
    }

    // Whenever the ghost was stationary the distance plateaus across several
    // frames. Walk back to the start of the plateau: the answer a delta wants
    // is when the ghost *first* got this far, not when it finally moved on.
    while (lo > 0 && this.field(lo - 1, 13) >= distance) lo--;

    const dLo = this.field(lo, 13);
    const dHi = this.field(hi, 13);
    const t = dHi > dLo ? (distance - dLo) / (dHi - dLo) : 0;
    return lerp(this.field(lo, 0), this.field(hi, 0), t);
  }

  get duration(): number {
    return this.count === 0 ? 0 : this.field(this.count - 1, 0);
  }
}
