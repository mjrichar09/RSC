/**
 * What a crash *adds* to the frame.
 *
 * A crash used to subtract: the picture stayed as it was and there was less car
 * in it, and slowing the clock down made that longer rather than bigger. Three
 * of the four things that fixed it are plain data and belong here — where the
 * hit landed, what the colour does while the world is slow, and how the metal
 * gets from straight to folded. The fourth is particles, which are pixels and
 * are checked by looking.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { NEUTRAL_GRADE, crashGrade, gradeStrength } from '../src/render/grade.js';
import { EasedDamage } from '../src/render/foldEase.js';
import { DamageModel } from '../src/sim/damage.js';
import {
  ParticleField,
  emitCrashDebris,
  emitImpactBurst,
  emitImpactSparks,
  updateWheelEffects,
} from '../src/render/fx.js';
import { SURFACES } from '../src/sim/surfaces.js';

describe('the grade during an impact', () => {
  it('does nothing at all at zero', () => {
    // The contract every switch in the game relies on: `?drama=0`, the K key
    // and a network race all drive one number to zero, and at zero the effect
    // has to be genuinely inert rather than merely quiet.
    expect(crashGrade(NEUTRAL_GRADE, 0)).toBe(NEUTRAL_GRADE);
    expect(gradeStrength(crashGrade(NEUTRAL_GRADE, 0))).toBe(0);
  });

  it('drains colour and closes the corners as it comes on', () => {
    const half = crashGrade(NEUTRAL_GRADE, 0.5);
    const full = crashGrade(NEUTRAL_GRADE, 1);
    expect(full.saturation).toBeLessThan(half.saturation);
    expect(full.vignette).toBeGreaterThan(half.vignette);
    // Never all the way to monochrome: the one frame where you most want to
    // see which way up the car is is not the frame to take its colour away.
    expect(full.saturation).toBeGreaterThan(0.3);
  });

  it('keeps the vignette off the end of its own scale', () => {
    // Dusk already spends 0.3 of this. Dusk plus a crash used to close the
    // frame to a keyhole.
    const dusk = { ...NEUTRAL_GRADE, vignette: 0.3 };
    expect(crashGrade(dusk, 1).vignette).toBeLessThanOrEqual(0.55);
  });

  it('is not neutral, so the pass that draws it is not skipped', () => {
    // `VisionPass.idle` skips the whole pass on a neutral grade, which on a
    // clear afternoon is every frame. If the crash grade did not register here
    // it would be computed and then thrown away.
    expect(gradeStrength(crashGrade(NEUTRAL_GRADE, 1))).toBeGreaterThan(0.02);
  });
});

describe('the metal folding', () => {
  const dented = () => {
    const damage = new DamageModel({ seed: 1 });
    damage.applyImpact({ x: 0, y: 0.2, z: 1.9 }, 30_000);
    return damage;
  };

  it('takes the car exactly as it finds it', () => {
    // A career car that starts a stage with a folded corner has to be folded on
    // the first frame, not fold itself in as the lights go out.
    const damage = dented();
    const eased = new EasedDamage();
    eased.attach(damage);
    eased.advance(1 / 60);
    expect(eased.get('panelFront')).toBeCloseTo(damage.get('panelFront'), 5);
    expect(eased.dents.length).toBe(damage.dents.length);
    expect(eased.dents[0]!.depth).toBeCloseTo(damage.dents[0]!.depth, 5);
  });

  it('lags a fold that arrives while it is watching, and catches up', () => {
    const damage = new DamageModel({ seed: 1 });
    const eased = new EasedDamage();
    eased.attach(damage);
    eased.advance(1 / 60);
    expect(eased.get('panelFront')).toBe(1);

    damage.applyImpact({ x: 0, y: 0.2, z: 1.9 }, 30_000);
    const target = damage.get('panelFront');
    expect(target).toBeLessThan(1);

    // One frame in, the panel is on its way and not there.
    eased.advance(1 / 60);
    expect(eased.get('panelFront')).toBeGreaterThan(target);
    expect(eased.get('panelFront')).toBeLessThan(1);

    // And it arrives, inside the half second the crash replay waits before it
    // cuts — a fold still moving when the strip is taken is a fold the replay
    // shows finishing twice.
    for (let i = 0; i < 30; i++) eased.advance(1 / 60);
    expect(eased.get('panelFront')).toBeCloseTo(target, 5);
    expect(eased.dents[0]!.depth).toBeCloseTo(damage.dents[0]!.depth, 5);
  });

  it('repairs instantly, because metal does not unfold', () => {
    const damage = dented();
    const eased = new EasedDamage();
    eased.attach(damage);
    eased.advance(1 / 60);
    expect(eased.get('panelFront')).toBeLessThan(1);

    damage.reset();
    eased.advance(1 / 60);
    expect(eased.get('panelFront')).toBe(1);
  });

  it('cannot be finished in one frame by a stalled tab', () => {
    // The frame delta is capped for the same reason the physics accumulator is:
    // a tab that comes back after a second must not hand this a second of
    // catch-up and complete every fold before the first frame is drawn.
    const damage = new DamageModel({ seed: 1 });
    const eased = new EasedDamage();
    eased.attach(damage);
    eased.advance(1 / 60);
    damage.applyImpact({ x: 0, y: 0.2, z: 1.9 }, 30_000);
    eased.advance(5);
    expect(eased.get('panelFront')).toBeGreaterThan(damage.get('panelFront'));
  });

  it('bumps its version only while something is moving', () => {
    // `reshape` rebuilds the whole car on a version change, so a version that
    // ticked every frame would rebuild every frame for nothing.
    const damage = dented();
    const eased = new EasedDamage();
    eased.attach(damage);
    for (let i = 0; i < 60; i++) eased.advance(1 / 60);
    const settled = eased.dentVersion;
    eased.advance(1 / 60);
    expect(eased.dentVersion).toBe(settled);
  });
});

describe('what a crash throws off', () => {
  const at = { x: 0, y: 0.5, z: 0 };
  const velocity = { x: 0, y: 0, z: 20 };
  const throwAll = (field: ParticleField, ground = 0) => {
    emitImpactSparks(field, at, { x: 0, y: 0.3, z: 1 }, 1);
    emitImpactBurst(field, { x: 0, y: 0, z: 0 }, new THREE.Color(0x8a7a5e), 1);
    emitCrashDebris(field, at, velocity, ground, 1);
  };

  /** A car sliding on gravel with every wheel spraying — a car in a crash. */
  const sliding = () => {
    const wheel = {
      contact: { x: 0, y: 0, z: 0 },
      grounded: true,
      compression: 0.5,
      load: 3000,
      steer: 0,
      spin: 10,
      rotation: 0,
      slipAngle: 0.6,
      slipRatio: 0.3,
      saturation: 1.25,
      surface: SURFACES.gravel,
    };
    return [wheel, wheel, wheel, wheel] as never;
  };
  const noSkids = { lift() {}, lay() {} } as never;

  it('survives the wheel spray of the slide that caused it', () => {
    /*
     * The whole bug, measured. Everything shared one 900-slot ring and gravel
     * spray fills it at about 2 400 a second, so a crash's debris was entirely
     * recycled within half a second of a three-second lifetime — emitted,
     * correct, and gone before anybody could see it. A crash happens while the
     * car is sliding on a loose surface, which is peak spray, so this was the
     * common case and not the corner one.
     */
    const scene = new THREE.Object3D();
    const spray = new ParticleField(scene);
    const impacts = new ParticleField(scene, 320);

    throwAll(impacts);
    expect(impacts.alive).toBeGreaterThan(40);
    // Only the debris is thrown with a lifespan over two seconds, so that is
    // how it is told apart from the sparks and the dust without tagging it.
    const shards = impacts.survivors(2);
    expect(shards).toBeGreaterThan(15);

    for (let i = 0; i < 60; i++) {
      updateWheelEffects(spray, noSkids, sliding(), velocity, 1 / 60);
      spray.update(1 / 60);
      impacts.update(1 / 60);
    }
    // A second on, every shard is still there. It has a life of two to three
    // and a half seconds and it is entitled to all of it.
    expect(impacts.survivors(2)).toBe(shards);
  });

  it('is evicted in under a second when it shares the spray pool', () => {
    // The counter-example, kept so the fix cannot be quietly undone by moving
    // the emitters back onto the shared field.
    const scene = new THREE.Object3D();
    const shared = new ParticleField(scene);
    throwAll(shared);
    expect(shared.survivors(2)).toBeGreaterThan(15);
    for (let i = 0; i < 30; i++) {
      updateWheelEffects(shared, noSkids, sliding(), velocity, 1 / 60);
      shared.update(1 / 60);
    }
    // Half a second, and there is not one shard left — the pool is full of
    // gravel, which is why `alive` is no use as a check and `survivors` is.
    expect(shared.survivors(2)).toBe(0);
    expect(shared.alive).toBe(900);
  });

  it('lands the debris on the ground and leaves it there', () => {
    const scene = new THREE.Object3D();
    const field = new ParticleField(scene, 320);
    emitCrashDebris(field, { x: 0, y: 3, z: 0 }, velocity, 0.25, 1);
    for (let i = 0; i < 120; i++) field.update(1 / 60);
    expect(field.lowest).toBeCloseTo(0.25, 3);
  });

  it('gets the debris down inside a second, so it is wreckage and not confetti', () => {
    /*
     * Measured off a `shoot` frame: thrown as high as the dust it comes with
     * and falling under the same 0.55 g the spray uses, a shard was still in
     * the air two and a half seconds after the impact — three seconds of
     * lifetime spent floating. Debris is only evidence once it is on the road,
     * so it is thrown low and falls at more than four times the dust's rate.
     */
    const scene = new THREE.Object3D();
    const field = new ParticleField(scene, 320);
    emitCrashDebris(field, { x: 0, y: 0.9, z: 0 }, velocity, 0, 1);
    for (let i = 0; i < 60; i++) field.update(1 / 60);
    expect(field.lowest).toBeCloseTo(0, 3);
  });
});
