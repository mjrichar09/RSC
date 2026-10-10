/**
 * The loop-the-loop on Sparkle Speedway, tested as rules.
 *
 * Whether the AI gets round the whole stage, and how fast, is `stages.test.ts`
 * and `npm run stages`. These are the pieces the loop depends on: that it meets
 * the road it leaves, that nothing else on the stage is under it, that a wheel
 * on it knows it is on it, that the booster sets the speed, and — the one
 * integration test — that a car driven into it comes out of the other end on
 * the exit lane, undamaged, having been upside down at the top.
 */

import { describe, expect, it } from 'vitest';
import { stageById } from '../src/data/stages/index.js';
import { LOOP_AT } from '../src/data/stages/toy.js';
import { CORRIDOR, Stage, stageVariants } from '../src/sim/stage.js';
import { createWorld } from '../src/sim/world.js';
import { Driver } from '../src/sim/driver.js';
import { Markers } from '../src/sim/markers.js';
import { add, rotate, scale, v3 } from '../src/sim/math.js';

const def = stageById('sparkle-speedway');
const stage = new Stage(def);
const loop = stage.loop!;

describe('the stage', () => {
  it('is day only', () => {
    expect(stageVariants(def).map((v) => v.id)).toEqual(['day-clear']);
  });

  /*
   * Positive curvature is a right turn, and `left.y` is how far the left edge
   * sits above the centre per metre across. As first written every turn
   * leaned out of itself: the outside edge the low one, by up to 2.5 m.
   */
  it('banks every turn into itself', () => {
    let banked = 0;
    for (const s of stage.spline.samples) {
      if (Math.abs(s.left.y) < 0.05 || Math.abs(s.curvature) < 0.005) continue;
      banked++;
      // Turning right, the outside is the left: it has to be the high edge.
      expect(Math.sign(s.left.y)).toBe(Math.sign(s.curvature));
    }
    expect(banked).toBeGreaterThan(20);
  });

  it('has a loop where the stage says', () => {
    expect(loop).not.toBeNull();
    expect(loop.spec.at).toBe(LOOP_AT);
    // Tall enough to be a loop, not a hump.
    expect(loop.top).toBeGreaterThan(15);
  });
});

describe('the loop and its road', () => {
  it('puts the car down on the exit lane, square to it', () => {
    const exit = stage.spline.locate(loop.exit);
    expect(Math.abs(exit.lateral)).toBeLessThan(0.3);
    expect(exit.sample.forward.x * loop.forward.x + exit.sample.forward.z * loop.forward.z).toBeGreaterThan(0.999);
  });

  it('refuses a loop whose exit misses the road', () => {
    expect(() => new Stage({ ...def, loop: { ...def.loop!, shift: def.loop!.shift + 2 } })).toThrow(/beside the road/);
  });

  it('refuses a checkpoint on the loop', () => {
    // Enough gates that one of them has to land in the loop's span.
    expect(() => new Stage({ ...def, checkpoints: 40 })).toThrow(/on the loop/);
  });

  /*
   * The way up and the way down cross in side view. As first built the
   * sideways move was spread over the whole loop, they were five metres apart
   * there against nearly eight of deck and rails, and the car on the way down
   * landed on the way up.
   */
  it('passes the way up and the way down beside each other', () => {
    const { vertices, along } = loop.geometry;
    const width = loop.spec.width + 0.25;
    for (let i = 0; i < loop.samples.length; i++) {
      const a = loop.samples[i]!;
      if (a.s < 0 || a.s > loop.spec.length / 2) continue;
      for (let j = i + 1; j < loop.samples.length; j++) {
        const b = loop.samples[j]!;
        if (b.s < loop.spec.length / 2 || b.s > loop.spec.length) continue;
        // Neighbours over the top are close because they are neighbours.
        if (b.s - a.s < 30) continue;
        const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
        // Two deck centrelines closer than two decks and a car are the two
        // lanes inside each other.
        if (Math.abs(a.position.y - b.position.y) < 3) expect(d).toBeGreaterThan(2 * width);
      }
    }
    expect(vertices.length / 3).toBe(along.length);
  });

  it('never passes through its own road', () => {
    const { vertices, along } = loop.geometry;
    for (let v = 0; v < along.length; v++) {
      const s = along[v]!;
      // The two low ends lie on the road by design.
      if (s < 25 || s > loop.spec.length - 25) continue;
      const p = v3(vertices[v * 3]!, vertices[v * 3 + 1]!, vertices[v * 3 + 2]!);
      const here = stage.spline.locate(p);
      const ground = here.sample.position.y + CORRIDOR.heightAt(here.sample.width, here.lateral);
      expect(p.y - ground).toBeGreaterThan(0.5);
    }
  });
});

describe('what stands under the loop', () => {
  const [from, to] = loop.span();

  it('has no corner calls for the road under it', () => {
    for (const c of stage.corners) expect(c.exit < from || c.entry > to).toBe(true);
  });

  it('has no marker poles under it', () => {
    const markers = new Markers(stage.spline, stage.length, [loop.span()]);
    for (const m of markers.all) expect(m.distance < from || m.distance > to).toBe(true);
  });

  it('keeps the booster tyres off the road', () => {
    const tyres = stage.props.filter((p) => p.kind === 'booster');
    expect(tyres).toHaveLength(2);
    for (const t of tyres) {
      const here = stage.progressAt(t.position);
      expect(Math.abs(here.lateral) - t.radius).toBeGreaterThan(loop.spec.width);
    }
  });
});

describe('a wheel on the deck', () => {
  /*
   * Over the top of the loop the nearest road sample in plan is the jog
   * underneath, and a point on the deck read as on the bank, or the verge,
   * whatever happened to be below it.
   */
  it('reads the deck, wherever the road underneath is', () => {
    for (const sample of loop.samples) {
      if (sample.s < 0 || sample.s > loop.spec.length) continue;
      expect(stage.surfaceAt(sample.position).surface).toBe(loop.spec.surface);
    }
  });

  it('is on the loop, and a car on the road under it is not', () => {
    const top = loop.samples.reduce((best, s) => (s.position.y > best.position.y ? s : best));
    expect(loop.locate(add(top.position, scale(top.up, 0.7)))).not.toBeNull();
    const below = stage.spline.at(loop.spec.at + loop.advance / 2);
    expect(loop.locate(add(below.position, v3(0, 0.7, 0)))).toBeNull();
  });
});

describe('the booster', () => {
  /*
   * It brings a car to the speed the loop is built for from either side: a
   * car that arrives slow is pushed up to it, and one that arrives flat out is
   * held back to it. Measured with the throttle fixed, so it is the booster
   * and not a driver doing it.
   */
  it.each([
    ['slow', 16, 0.6],
    ['fast', 40, 1],
  ])('sets the speed for a car that arrives %s', async (_name, arrive, throttle) => {
    const world = await createWorld({ stage });
    const start = add(loop.boostStart(), scale(loop.forward, -30));
    world.vehicle.reset(add(start, v3(0, 0.6, 0)), Math.atan2(loop.forward.x, loop.forward.z));
    world.vehicle.body.setLinvel(scale(loop.forward, arrive), true);
    const entry = loop.origin;
    let speed = 0;
    for (let i = 0; i < 1200; i++) {
      world.step({ throttle, brake: 0, steer: 0, handbrake: 0 });
      const p = world.state().position;
      const ahead = (p.x - entry.x) * loop.forward.x + (p.z - entry.z) * loop.forward.z;
      if (ahead > -1) {
        speed = world.state().speed;
        break;
      }
    }
    expect(Math.abs(speed - loop.spec.boost.speed)).toBeLessThan(1.5);
  });
});

describe('driving it', () => {
  /*
   * The whole point, end to end and once: the AI in at the booster, upside
   * down at the top, out on the exit lane going forward, and the car not a
   * penny worse for it. Every one of those failed at least once on the way —
   * the floor pan on the deck, the way down landing on the way up, the AI
   * reversing off the top because it read itself as facing backwards.
   */
  it('goes over the top and comes out on the exit lane, undamaged', async () => {
    const world = await createWorld({ stage, damage: true });
    const driver = new Driver(stage);
    world.rescue(loop.span()[0] - 120);
    let inverted = false;
    let highest = 0;
    let out = false;
    for (let i = 0; i < 120 * 30 && !out; i++) {
      world.step(driver.input(world.state(), world.dt));
      const state = world.state();
      const up = rotate(state.rotation, v3(0, 1, 0));
      if (up.y < -0.9) inverted = true;
      highest = Math.max(highest, state.position.y - loop.origin.y);
      const along = stage.progressAt(state.position).distance;
      out = inverted && along > loop.span()[1] + 20 && !loop.locate(state.position);
    }
    expect(inverted).toBe(true);
    expect(highest).toBeGreaterThan(loop.top - 2);
    expect(out).toBe(true);
    const state = world.state();
    expect(state.speed).toBeGreaterThan(15);
    expect(Math.abs(stage.progressAt(state.position).lateral)).toBeLessThan(loop.spec.width);
    expect(world.damage!.condition).toBeGreaterThan(0.99);
  }, 60_000);
});
