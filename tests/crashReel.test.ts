/**
 * The crash cinematic replays what happened; it does not re-stage it.
 *
 * The old cinematic played a *ghost* — where the car was — and posed everything
 * else from the present. Two things gave that away immediately and both are
 * what this file pins down:
 *
 * - The car was already wrecked before it hit anything, because damage was read
 *   live rather than recorded.
 * - Whatever it hit was not there, because the simulation had moved on.
 *
 * Neither is testable through the renderer, and neither needs to be: both are
 * properties of what the reel *records*, which is plain data.
 */

import { describe, expect, it } from 'vitest';
import {
  CrashReel,
  RecordedDamage,
  RecordedDebris,
  type ReelProps,
} from '../src/game/crashReel.js';
import { DamageModel } from '../src/sim/damage.js';
import { DebrisModel, PART_BY_ID } from '../src/sim/debris.js';
import type { VehicleState } from '../src/sim/vehicle.js';
import type { Animal } from '../src/sim/wildlife.js';

const transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };

const state = {
  wheels: [0, 1, 2, 3].map(() => ({
    rotation: 0,
    steer: 0,
    compression: 0.5,
    grounded: true,
  })),
} as unknown as VehicleState;

/** The roadside, when a test does not care about it. */
const NO_PROPS = { skidStamp: 0, signs: [], markers: [] };

/** Feed the reel `seconds` of wall time at 60 fps. */
function run(
  reel: CrashReel,
  seconds: number,
  damage: DamageModel | null,
  debris: DebrisModel | null,
  animals: Animal[] = [],
  props: () => ReelProps = () => NO_PROPS,
) {
  for (let i = 0; i < seconds * 60; i++) {
    reel.capture(1 / 60, transform, state, damage, debris, animals, props());
  }
}

describe('the crash reel', () => {
  it('remembers the car as it was, not as it ended up', () => {
    // The whole complaint, in one assertion: the fold you are about to watch
    // arrive must not already be on the car on the way in.
    const reel = new CrashReel();
    const damage = new DamageModel({ seed: 1 });
    run(reel, 1.0, damage, null);

    // The crash.
    damage.applyImpact({ x: 0, y: 0, z: 1.9 }, 30_000);
    run(reel, 0.2, damage, null);

    const strip = reel.take(1.25)!;
    expect(strip).not.toBeNull();
    const view = new RecordedDamage(strip.at(0));

    // At the start of the strip the car is whole.
    expect(view.at(strip.at(0)).get('lights')).toBe(1);
    expect(view.at(strip.at(0)).dents).toHaveLength(0);
    // At the end it is not.
    expect(view.at(strip.at(strip.duration)).get('lights')).toBeLessThan(1);
    expect(view.at(strip.at(strip.duration)).dents.length).toBeGreaterThan(0);
  });

  it('copies the dents rather than holding the live list', () => {
    // The live list is mutated in place as folds merge, so a reference would
    // give every recorded frame the *final* set — the same bug one level down.
    const reel = new CrashReel();
    const damage = new DamageModel({ seed: 1 });
    damage.applyImpact({ x: 0, y: 0, z: 1.9 }, 20_000);
    run(reel, 0.5, damage, null);
    const strip = reel.take(1.25)!;
    const early = strip.at(0).dents.map((d) => d.depth);

    damage.applyImpact({ x: 0, y: 0, z: 1.9 }, 40_000);
    expect(strip.at(0).dents.map((d) => d.depth)).toEqual(early);
  });

  it('keeps the animals that were standing there', () => {
    const reel = new CrashReel();
    const deer = {
      distance: 100,
      side: 1,
      state: 'bolting',
      position: { x: 3, y: 0, z: 40 },
      yaw: 1,
      crossed: 0.5,
    } as Animal;
    run(reel, 0.5, null, null, [deer]);

    const strip = reel.take(1.25)!;
    const seen = strip.at(0).animals;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.position.x).toBe(3);
    expect(seen[0]!.gone).toBe(false);

    // And once it is hit, the recorded frames before that still have it.
    deer.state = 'gone';
    expect(strip.at(0).animals[0]!.gone).toBe(false);
  });

  it('never grows past its window', () => {
    const reel = new CrashReel();
    run(reel, 30, null, null);
    const strip = reel.take(1.25)!;
    // A second and a quarter of a strip, not thirty seconds of one.
    expect(strip.duration).toBeGreaterThan(1);
    expect(strip.duration).toBeLessThan(1.5);
  });

  it('has nothing to show before a race has run', () => {
    expect(new CrashReel().take(1.25)).toBeNull();
  });

  it('forgets everything on a restart', () => {
    const reel = new CrashReel();
    run(reel, 3, null, null);
    reel.reset();
    expect(reel.take(1.25)).toBeNull();
  });

  it('reports parts as they were attached at the time', () => {
    const reel = new CrashReel();
    const debris = new DebrisModel({ seed: 1 });
    run(reel, 1.0, null, debris);
    debris.detach(PART_BY_ID.get('bumperFront')!);
    run(reel, 0.2, null, debris);

    const strip = reel.take(1.25)!;
    const view = new RecordedDebris(strip.at(0));
    expect(view.at(strip.at(0)).stateOf('bumperFront')).toBe('attached');
    expect(view.at(strip.at(strip.duration)).stateOf('bumperFront')).toBe('gone');
  });

  it('remembers the road as it was, not as the crash left it', () => {
    // The other half of the same complaint. The car was recorded and the road
    // was not, so a replay of the run-up to a crash was drawn over the marks
    // the car laid *during* it and past the boards it had already flattened.
    const reel = new CrashReel();
    // A pole and a board, both standing, and no marks on the road yet.
    const props: ReelProps = { skidStamp: 0, signs: [{ fallen: 0 }], markers: [{ fallen: 0 }] };
    run(reel, 1.0, null, null, [], () => props);

    // The crash: tracks get laid and both go over.
    props.skidStamp = 40;
    props.signs = [{ fallen: 1 }];
    props.markers = [{ fallen: 1 }];
    run(reel, 0.5, null, null, [], () => props);

    const strip = reel.take(1.5)!;
    expect(strip).not.toBeNull();

    const before = strip.at(0.2);
    expect(before.skidStamp).toBe(0);
    expect(before.signsFallen[0]).toBe(0);
    expect(before.markersFallen[0]).toBe(0);

    const after = strip.at(strip.duration);
    expect(after.skidStamp).toBe(40);
    expect(after.signsFallen[0]).toBe(1);
    expect(after.markersFallen[0]).toBe(1);
  });

  it('keeps the impact events, so the cinematic can throw the burst again', () => {
    /*
     * Particles are not recorded and should not be — nine hundred of them
     * thirty times a second is a different order of thing from forty component
     * healths. The event is tiny, and re-throwing it at the right moment of the
     * playback is better than a recording: the sparks then fly at the replay's
     * own rate along with everything else.
     *
     * Without this the cinematic drew the *live* burst, thrown 1.75 s after the
     * frame on screen and a car's length down the road from where the camera
     * was pointing.
     */
    const reel = new CrashReel();
    run(reel, 1.0, null, null);
    reel.impact({
      at: { x: 1, y: 0.5, z: 2 },
      normal: { x: 0, y: 0, z: 1 },
      velocity: { x: 0, y: 0, z: 20 },
      ground: 0,
      color: 0x8a7a5e,
      severity: 0.8,
    });
    run(reel, 0.5, null, null);

    const strip = reel.take(1.5)!;
    // It sits where it happened: a second in, with half a second after it.
    const whole = strip.impactsBetween(0, strip.duration);
    expect(whole.length).toBe(1);
    expect(whole[0]!.severity).toBe(0.8);
    const at = whole[0]!.t - (strip.at(0).t);
    expect(at).toBeGreaterThan(0.8);
    expect(at).toBeLessThan(strip.duration);

    // A playhead that has not reached it yet gets nothing...
    expect(strip.impactsBetween(0, 0.5).length).toBe(0);
    // ...and no window may hand back the same burst twice, or the cinematic
    // throws it once per frame for as long as it is on that frame.
    expect(strip.impactsBetween(0, at).length).toBe(1);
    expect(strip.impactsBetween(at, strip.duration).length).toBe(0);
  });

  it('records a part that is working loose as well as one that has gone', () => {
    // `isLoose` used to ask whether a part was `attached` and coded `dragging`
    // at the same time, which is never — so every recorded part read as sound
    // and the panel sitting proud that is the car's last warning snapped flat
    // the instant the cinematic started.
    const reel = new CrashReel();
    const debris = new DebrisModel({ seed: 1 });
    run(reel, 0.5, null, debris);
    const sound = new RecordedDebris(reel.take(0.4)!.at(0));
    expect(sound.isLoose('bumperFront')).toBe(false);

    // Enough to work the mounts loose without taking it off the car: measured,
    // 15 000 N·s through the nose leaves the front bumper at 34% and hanging.
    debris.applyImpact({ x: 0, y: 0, z: 1.9 }, 15_000);
    expect(debris.stateOf('bumperFront')).toBe('attached');
    expect(debris.isLoose('bumperFront')).toBe(true);

    run(reel, 0.5, null, debris);
    const strip = reel.take(0.4)!;
    const view = new RecordedDebris(strip.at(strip.duration));
    expect(view.stateOf('bumperFront')).toBe('attached');
    expect(view.isLoose('bumperFront')).toBe(true);
  });
});
