/**
 * Tilt steering, which is a handedness problem wearing a costume.
 *
 * The thing that can be wrong here is not the feel, it is the sign — and a
 * sign that is wrong is wrong for exactly half the players, the ones who
 * turned their phone into landscape the other way round. Nothing in a
 * screenshot shows it and nothing on one device shows it, because a device
 * held one way is self-consistent whichever convention you picked.
 *
 * So the test that matters is the pair: the *same physical movement* —
 * dropping the right-hand side of the screen — from both of the ways a phone
 * gets held in landscape, which are opposite `beta` and have to give the same
 * steering. Every other case here is arithmetic around that one.
 */

import { describe, expect, it } from 'vitest';
import {
  TiltSteering,
  gravityInDevice,
  gravityRoll,
  shortestTurn,
  steerFromRoll,
} from '../src/ui/tilt.js';

const deg = (radians: number) => (radians * 180) / Math.PI;
const rad = (degrees: number) => (degrees * Math.PI) / 180;

describe('which way is down', () => {
  it('goes out through the back of a phone lying face up', () => {
    const g = gravityInDevice(0, 0);
    expect(g.x).toBeCloseTo(0, 6);
    expect(g.y).toBeCloseTo(0, 6);
    expect(g.z).toBeCloseTo(-1, 6);
  });

  it('goes out through the bottom edge of a phone stood upright in portrait', () => {
    expect(gravityInDevice(90, 0).y).toBeCloseTo(-1, 6);
  });

  it('goes out through whichever edge has been rolled downward', () => {
    expect(gravityInDevice(0, 90).x).toBeCloseTo(1, 6);
    expect(gravityInDevice(0, -90).x).toBeCloseTo(-1, 6);
  });
});

/**
 * The two ways a phone ends up in landscape, stated as holds.
 *
 * Turned one way, the phone's natural top edge points to the player's left, so
 * the screen's right-hand side is the phone's *bottom* edge — and `gamma` is
 * -90, which is what lays the phone's long axis flat. Dropping the screen's
 * right-hand side is then a **larger** beta. Turned the other way, `gamma` is
 * +90, the screen's right-hand side is the phone's top edge, and the very same
 * movement is a **smaller** beta.
 */
const HOLD_A = { gamma: -90, level: 20, rightDown: 42, leftDown: -2 };
const HOLD_B = { gamma: 90, level: -20, rightDown: -42, leftDown: 2 };

describe('a phone held in landscape', () => {
  it('reads the same movement the same way, held either way round', () => {
    const a = shortestTurn(
      gravityRoll(HOLD_A.level, HOLD_A.gamma)!,
      gravityRoll(HOLD_A.rightDown, HOLD_A.gamma)!,
    );
    const b = shortestTurn(
      gravityRoll(HOLD_B.level, HOLD_B.gamma)!,
      gravityRoll(HOLD_B.rightDown, HOLD_B.gamma)!,
    );
    expect(deg(a)).toBeCloseTo(22, 4);
    expect(deg(b)).toBeCloseTo(22, 4);
  });

  it('reads the other way when the left-hand side drops, held either way round', () => {
    const a = shortestTurn(
      gravityRoll(HOLD_A.level, HOLD_A.gamma)!,
      gravityRoll(HOLD_A.leftDown, HOLD_A.gamma)!,
    );
    const b = shortestTurn(
      gravityRoll(HOLD_B.level, HOLD_B.gamma)!,
      gravityRoll(HOLD_B.leftDown, HOLD_B.gamma)!,
    );
    expect(deg(a)).toBeCloseTo(-22, 4);
    expect(deg(b)).toBeCloseTo(-22, 4);
  });

  it('reads an angle, not a sideways component', () => {
    // These two poses are the same tilt across the face of the phone and
    // differ only in how much of gravity is across it at all — 1.00 g for the
    // first and 0.774 for the second, which is pitched further back.
    expect(deg(gravityRoll(12.96, -90)!)).toBeCloseTo(deg(gravityRoll(10, -50)!), 1);
    // Their sideways components are 0.224 and 0.174: a 29% difference in
    // steering for an identical tilt, which is the same corner wanting a
    // different movement depending on how the phone happens to be held.
    expect(gravityInDevice(12.96, -90).y / gravityInDevice(10, -50).y).toBeCloseTo(1.29, 1);
  });

  it('refuses to answer for a phone lying flat, rather than spinning', () => {
    expect(gravityRoll(0, 0)).toBeNull();
    expect(gravityRoll(2, 2)).toBeNull();
  });
});

describe('roll to lock', () => {
  it('is straight at the pose it was given as straight', () => {
    expect(steerFromRoll(0.4, 0.4)).toBe(0);
  });

  it('ignores a hand that is merely not still', () => {
    expect(steerFromRoll(rad(1), 0)).toBe(0);
    expect(steerFromRoll(rad(-1), 0)).toBe(0);
  });

  it('comes off the dead zone gently rather than jumping', () => {
    const justPast = steerFromRoll(rad(3), 0);
    expect(justPast).toBeGreaterThan(0);
    expect(justPast).toBeLessThan(0.1);
  });

  it('reaches full lock at a wrist roll and no further', () => {
    expect(steerFromRoll(rad(35), 0)).toBeCloseTo(1, 2);
    expect(steerFromRoll(rad(90), 0)).toBe(1);
    expect(steerFromRoll(rad(-90), 0)).toBe(-1);
    // Half the roll is not far off half the lock, which is the property that
    // makes a tilt input predictable: it is linear between the dead zone and
    // the stop, not eased.
    expect(steerFromRoll(rad(18.6), 0)).toBeCloseTo(0.5, 1);
  });

  it('is measured from the reference, not from level', () => {
    // Playing on a sofa, holding the phone 30° off level the whole time.
    const lounging = rad(30);
    expect(steerFromRoll(lounging, lounging)).toBe(0);
    expect(steerFromRoll(lounging + rad(35), lounging)).toBeCloseTo(1, 2);
  });

  it('does not slam the other way when the reading crosses the seam', () => {
    // A reference near the wrap — reachable by holding the phone almost upside
    // down, and reached for a moment by anybody who drops it. Twenty degrees
    // each way from it is a little over half lock; a plain subtraction reads
    // the right-hand one as -340°, which is full *left* lock in the middle of
    // a right-hand corner. The assertion is the sign.
    const near = rad(170);
    expect(steerFromRoll(rad(-170), near)).toBeCloseTo(0.54, 2);
    expect(steerFromRoll(rad(150), near)).toBeCloseTo(-0.54, 2);
    expect(deg(shortestTurn(rad(170), rad(-170)))).toBeCloseTo(20, 6);
    expect(deg(shortestTurn(rad(-170), rad(170)))).toBeCloseTo(-20, 6);
  });
});

describe('the input as the game reads it', () => {
  /** Switched on without the permission dance, which is all `enable` adds. */
  const armed = () => {
    const tilt = new TiltSteering();
    tilt.recentre();
    (tilt as unknown as { on: boolean }).on = true;
    return tilt;
  };

  it('says nothing at all until it is switched on', () => {
    const tilt = new TiltSteering();
    tilt.feed(12, -90);
    expect(tilt.steer).toBeNull();
    expect(tilt.enabled).toBe(false);
  });

  it('takes the pose it was switched on in as straight ahead', () => {
    const tilt = armed();
    tilt.feed(HOLD_A.level, HOLD_A.gamma);
    expect(tilt.steer).toBe(0);
    tilt.feed(HOLD_A.level + 35, HOLD_A.gamma);
    expect(tilt.steer!).toBeCloseTo(1, 2);
    tilt.feed(HOLD_A.level - 35, HOLD_A.gamma);
    expect(tilt.steer!).toBeCloseTo(-1, 2);
  });

  it('steers the same way for the player who turned their phone the other way', () => {
    const tilt = armed();
    tilt.feed(HOLD_B.level, HOLD_B.gamma);
    expect(tilt.steer).toBe(0);
    tilt.feed(HOLD_B.rightDown, HOLD_B.gamma);
    expect(tilt.steer!).toBeGreaterThan(0.5);
    tilt.feed(HOLD_B.leftDown, HOLD_B.gamma);
    expect(tilt.steer!).toBeLessThan(-0.5);
  });

  it('holds the last reading through a phone laid flat', () => {
    const tilt = armed();
    tilt.feed(20, -90);
    tilt.feed(33, -90);
    const held = tilt.steer!;
    expect(held).toBeGreaterThan(0.3);
    // Face up on a table: no answer, and the wheel stays where it was rather
    // than snapping straight in the middle of a corner.
    tilt.feed(0, 0);
    expect(tilt.steer).toBe(held);
  });

  it('forgets its reference when the phone is picked up differently', () => {
    const tilt = armed();
    tilt.feed(HOLD_A.level, HOLD_A.gamma);
    tilt.feed(HOLD_A.rightDown, HOLD_A.gamma);
    expect(tilt.steer!).toBeGreaterThan(0.4);

    // Turned round: whatever is being held now is what the player means by
    // straight, whether or not the arithmetic needed telling.
    tilt.recentre();
    expect(tilt.steer).toBeNull();
    tilt.feed(HOLD_B.level, HOLD_B.gamma);
    expect(tilt.steer).toBe(0);
  });
});
