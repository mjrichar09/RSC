/**
 * Somebody else's car, played back from what they sent.
 *
 * Both ends need this now. A guest plays every other car back from the host's
 * snapshots, and the host plays each guest's car back from that guest's own
 * reports — because each machine is the authority on its own car and nobody
 * else simulates it. It used to live inside `RaceGuest`; it moved here when
 * the host started needing it too, rather than being written twice.
 *
 * Samples are played back `INTERP_DELAY` behind the newest one, so a late or
 * lost packet is covered by the buffer instead of showing as a stutter. Being
 * a tenth of a second behind on a car you are not driving costs nothing; being
 * a tenth of a second wrong about where it is costs a collision.
 *
 * Each stream is on its sender's clock and is never converted to the
 * receiver's. The playback clock runs on local time and is pulled gently
 * toward `newest - INTERP_DELAY`, which needs nothing but the sender's own
 * timestamps — so there is no clock offset to estimate and none to get wrong.
 */

import type { Quat, Vec3 } from '../sim/math.js';
import { lerpVec, slerp } from '../sim/math.js';
import type { Vehicle } from '../sim/vehicle.js';

/**
 * How far behind the newest sample cars are played back, in seconds.
 *
 * Two snapshot intervals at 20 Hz: one packet can vanish entirely and the
 * buffer still has something either side of the playback time to interpolate
 * between.
 */
export const INTERP_DELAY = 0.1;

/**
 * How far past the newest sample a car may be carried, seconds.
 *
 * Two snapshot intervals. Long enough to cover a lost packet, short enough that
 * a car whose owner has genuinely stopped sending does not sail off across the
 * scenery on a velocity from a third of a second ago.
 */
export const EXTRAPOLATE_LIMIT = 0.1;

export interface Sample {
  /** The sender's clock time this state is from. */
  time: number;
  p: Vec3;
  q: Quat;
  v: Vec3;
  w: Vec3;
  health: number;
  progress: number;
}

/**
 * One sender's clock: the newest time it has stamped, and where playback is.
 *
 * A guest has one, for the host. The host has one per guest, because each
 * guest's reports are on that guest's own clock.
 */
export class PlaybackClock {
  /** Latest sender time seen. */
  newest = 0;
  /** Our playback time on the sender's clock, which chases `newest - INTERP_DELAY`. */
  playback = 0;
  private started = false;

  /**
   * Note a sample's time. False if it is older than one already seen: with an
   * unordered channel a straggler is not news, and applying it would pull a
   * car backwards through space.
   */
  note(time: number): boolean {
    if (this.started && time < this.newest) return false;
    this.newest = time;
    if (!this.started) {
      this.started = true;
      this.playback = Math.max(0, time - INTERP_DELAY);
    }
    return true;
  }

  get running(): boolean {
    return this.started;
  }

  /**
   * Move playback on by a step. Pulled toward the target rather than set to
   * it: snapping the clock every packet would show as the same stutter the
   * buffer exists to hide.
   */
  advance(dt: number): number {
    if (!this.started) return 0;
    const target = this.newest - INTERP_DELAY;
    this.playback += dt;
    this.playback += (target - this.playback) * Math.min(1, dt * 2);
    return this.playback;
  }

  /** Forget everything. A new race restarts every sender's clock at zero. */
  reset(): void {
    this.newest = 0;
    this.playback = 0;
    this.started = false;
  }
}

/** File a sample, keeping a little over the interpolation window and no more. */
export function file(buffer: Sample[], sample: Sample): void {
  buffer.push(sample);
  while (buffer.length > 2 && buffer[1]!.time < sample.time - INTERP_DELAY * 3) buffer.shift();
}

/** Interpolate a buffer at a sender time, extrapolating a little past the end. */
export function sampleAt(buffer: readonly Sample[], time: number): Sample {
  const first = buffer[0]!;
  const last = buffer[buffer.length - 1]!;
  if (time <= first.time) return first;
  if (time >= last.time) {
    // Carried forward on its last known velocity rather than stopped dead. A
    // car that freezes and then jumps reads as a far bigger fault than one
    // that keeps going and is quietly corrected — and a frozen car is also
    // the wrong thing to try to overtake. Capped hard, because a car held on
    // a stale velocity through a corner ends up somewhere it never went.
    const ahead = Math.min(time - last.time, EXTRAPOLATE_LIMIT);
    return {
      ...last,
      p: {
        x: last.p.x + last.v.x * ahead,
        y: last.p.y + last.v.y * ahead,
        z: last.p.z + last.v.z * ahead,
      },
    };
  }
  for (let i = 1; i < buffer.length; i++) {
    const b = buffer[i]!;
    if (b.time < time) continue;
    const a = buffer[i - 1]!;
    const span = b.time - a.time;
    const t = span > 0 ? (time - a.time) / span : 1;
    return {
      time,
      p: lerpVec(a.p, b.p, t),
      q: slerp(a.q, b.q, t),
      v: lerpVec(a.v, b.v, t),
      w: lerpVec(a.w, b.w, t),
      health: b.health,
      progress: b.progress,
    };
  }
  return last;
}

/** Shapes off the wire into a sample. */
export const toVec = (a: readonly [number, number, number]): Vec3 => ({ x: a[0], y: a[1], z: a[2] });
export const toQuat = (a: readonly [number, number, number, number]): Quat => ({
  x: a[0],
  y: a[1],
  z: a[2],
  w: a[3],
});

/**
 * Put a played-back car where its sample says.
 *
 * `setNextKinematic*` rather than `setTranslation` for a kinematic body: it
 * tells the solver where the body will be at the *end* of the step, so Rapier
 * derives the velocity from the motion itself and resolves contacts against a
 * car that is genuinely moving. Teleporting instead puts the body wherever it
 * was told with no motion behind it, and anything it lands inside is squeezed
 * out with an impulse the size of the overlap — which is what being hit by
 * nothing felt like.
 */
export function pose(vehicle: Vehicle, state: Sample): void {
  const body = vehicle.body;
  if (vehicle.remote) {
    body.setNextKinematicTranslation(state.p);
    body.setNextKinematicRotation(state.q);
  } else {
    body.setTranslation(state.p, true);
    body.setRotation(state.q, true);
    body.setLinvel(state.v, true);
    body.setAngvel(state.w, true);
  }
}
