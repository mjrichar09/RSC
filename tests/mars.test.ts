/**
 * Red Planet: the rules that make it Mars, tested as rules.
 *
 * None of this drives the stage. Whether the AI gets round it, and how fast, is
 * `stages.test.ts` and `npm run stages`; the jump's landing was settled with a
 * probe that recorded the flight, and is described in `data/stages/mars.ts`.
 * These are the cheap checks that the pieces are wired: the world falls at
 * Mars's rate, the rover and the swarm are what stand by the road, a car in the
 * air does not hit anything on the ground, and the rocket cannot be reached.
 */

import { describe, expect, it } from 'vitest';
import { stageById } from '../src/data/stages/index.js';
import { MARS_GRAVITY } from '../src/data/stages/mars.js';
import { describeConditions, visibility } from '../src/sim/conditions.js';
import { Stage, stageVariants } from '../src/sim/stage.js';
import { createWorld } from '../src/sim/world.js';
import { Wildlife } from '../src/sim/wildlife.js';
import { CRATER_APRON, groundHeight } from '../src/sim/terrain.js';
import { v3 } from '../src/sim/math.js';

const def = stageById('red-planet');
const stage = new Stage(def);

describe('the planet', () => {
  it('falls at Mars gravity, and everywhere else at Earth gravity', async () => {
    const mars = await createWorld({ stage });
    expect(mars.world.gravity.y).toBeCloseTo(-MARS_GRAVITY, 5);
    const earth = await createWorld({ stage: new Stage(stageById('pine-loop')) });
    expect(earth.world.gravity.y).toBeCloseTo(-9.81, 5);
  });

  it('has a dust storm instead of rain and snow', () => {
    const variants = stageVariants(def);
    expect(variants.map((v) => v.conditions.weather)).toEqual(['clear', 'dust']);
    const storm = variants[1]!.conditions;
    expect(describeConditions(storm)).toBe('Day · Dust storm');
    // And it closes the world in: closer than snow, not as total as fog.
    expect(visibility(storm).fogFar).toBeLessThan(visibility({ timeOfDay: 'day', weather: 'snowfall' }).fogFar);
    expect(visibility(storm).fogFar).toBeGreaterThan(visibility({ timeOfDay: 'day', weather: 'fog' }).fogFar);
  });
});

describe('the car on Mars', () => {
  /*
   * Its Earth weight on the ground. With Mars's own, a tyre had a third of its
   * grip; with the grip handed back by a multiplier instead, the car tipped
   * onto two wheels in the first hairpin. Settled on its springs, a car
   * carrying its Earth weight sits exactly as low as it does on Earth.
   */
  it('sits on its springs as it does on Earth', async () => {
    const settle = async (s: Stage) => {
      const world = await createWorld({ stage: s });
      for (let i = 0; i < 240; i++) world.step({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      const p = world.state().position;
      return p.y - s.spline.at(s.progressAt(p).distance).position.y;
    };
    const mars = await settle(stage);
    const earth = await settle(new Stage(stageById('pine-loop')));
    expect(Math.abs(mars - earth)).toBeLessThan(0.02);
  });
});

describe('the craters', () => {
  it('are many, and every one clear of the corridor', () => {
    expect(stage.craters.length).toBeGreaterThan(40);
    for (const c of stage.craters) {
      const near = stage.progressAt({ x: c.x, y: 0, z: c.z });
      // The corridor's wall is under 18 m out; the apron stays past it.
      expect(Math.abs(near.lateral) - c.radius * CRATER_APRON).toBeGreaterThan(18);
    }
  });

  it('drop the open ground out from under themselves, and nowhere else', () => {
    const c = stage.craters[0]!;
    const flat = groundHeight(stage.spline, c.x, c.z);
    expect(groundHeight(stage.spline, c.x, c.z, stage.craters)).toBeLessThan(flat - c.depth);
    const away = c.radius * CRATER_APRON + 1;
    expect(groundHeight(stage.spline, c.x + away, c.z, [c])).toBeCloseTo(groundHeight(stage.spline, c.x + away, c.z), 6);
  });
});

describe('what stands by the road', () => {
  it('is rovers and a swarm, not deer and sheep', async () => {
    const world = await createWorld({ stage, damage: true });
    const kinds = new Set(world.wildlife!.animals.map((a) => a.kind));
    expect(kinds).toEqual(new Set(['rover', 'alien']));
  });

  it('has a rover that crosses whatever the car is doing, and parks on the far side', () => {
    const wildlife = new Wildlife(stage.spline, stage.length, { scatter: 'rover', random: () => 0.01 });
    const rover = wildlife.animals[0]!;
    const side = Math.sign(stage.progressAt(rover.position).lateral);
    // A car crawling up at walking pace, 150 m off: a deer would ignore it.
    for (let i = 0; i < 120 * 30; i++) wildlife.update(1 / 120, rover.distance - 150, 1.5);
    expect(rover.state).toBe('bolting');
    expect(rover.crossed).toBe(1);
    // Over the road, and stopped there rather than gone.
    expect(Math.sign(stage.progressAt(rover.position).lateral)).toBe(-side);
  });

  it('is not hit by a car flying over it', () => {
    const wildlife = new Wildlife(stage.spline, stage.length, { scatter: 'rover', random: () => 0.5 });
    const rover = wildlife.animals[0]!;
    const over = v3(rover.position.x, rover.position.y + 16, rover.position.z);
    const level = v3(rover.position.x, rover.position.y + 0.8, rover.position.z);
    const flat = { x: 0, y: 0, z: 0, w: 1 };
    expect(wildlife.strike(over, v3(0, 0, 37), flat)).toBeNull();
    expect(wildlife.strike(level, v3(0, 0, 37), flat)?.kind).toBe('rover');
  });
});

describe('the launch', () => {
  it('stands the rocket where no car can reach it', () => {
    expect(stage.launchPad).not.toBeNull();
    const pad = stage.launchPad!;
    expect(Math.abs(stage.progressAt(pad).lateral)).toBeGreaterThan(38);
  });

  it('refuses a pad a car could reach', () => {
    expect(() => new Stage({ ...def, launch: { at: 20, side: -1, offset: 20 } })).toThrow(/within reach/);
  });
});
