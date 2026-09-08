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
import { NEUTRAL_GRADE, crashGrade, gradeStrength } from '../src/render/grade.js';
import { EasedDamage } from '../src/render/foldEase.js';
import { DamageModel } from '../src/sim/damage.js';

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
