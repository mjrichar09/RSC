/**
 * The start.
 *
 * The rule worth protecting is what the countdown does *not* do: the clock
 * still starts on the car's first movement, so a jumped start is impossible
 * rather than penalised, and every time recorded before start lights existed is
 * still comparable with every time recorded after.
 */

import { describe, expect, it } from 'vitest';
import { StartLights } from '../src/game/startLights.js';

/** Run the sequence for `seconds`, collecting what it announced. */
function run(lights: StartLights, seconds: number): (string | null)[] {
  const events: (string | null)[] = [];
  for (let i = 0; i < seconds * 120; i++) {
    const event = lights.update(1 / 120);
    if (event) events.push(event);
  }
  return events;
}

describe('start lights', () => {
  it('holds the car until the green', () => {
    const lights = new StartLights();
    lights.arm();
    expect(lights.holding).toBe(true);

    run(lights, 2);
    // Still counting, still held, with lamps lit along the way.
    expect(lights.holding).toBe(true);
    expect(lights.lamps).toBeGreaterThan(0);

    run(lights, 3);
    expect(lights.holding).toBe(false);
    expect(lights.released).toBe(true);
  });

  it('lights three reds and then goes green', () => {
    const lights = new StartLights();
    lights.arm();
    const events = run(lights, 6);
    expect(events.filter((e) => e === 'lamp')).toHaveLength(3);
    expect(events.filter((e) => e === 'go')).toHaveLength(1);
    // The green is announced last, which is the only ordering that means
    // anything to somebody listening rather than watching.
    expect(events[events.length - 1]).toBe('go');
  });

  it('takes about four seconds, and the green does not linger', () => {
    const lights = new StartLights();
    lights.arm();
    let elapsed = 0;
    while (lights.holding && elapsed < 10) {
      lights.update(1 / 120);
      elapsed += 1 / 120;
    }
    expect(elapsed).toBeGreaterThan(3);
    expect(elapsed).toBeLessThan(5);

    expect(lights.greenFor).toBeGreaterThan(0);
    run(lights, 2);
    expect(lights.greenFor).toBe(0);
    expect(lights.phase).toBe('done');
  });

  it('can be skipped, for everything that is not a person', () => {
    // The AI driver, the stage validator and the screenshot harness all drive
    // from a standstill and none of them should sit through a countdown.
    const lights = new StartLights();
    lights.arm();
    lights.skip();
    expect(lights.holding).toBe(false);
    expect(lights.update(1 / 120)).toBeNull();
  });

  it('re-arms on a restart', () => {
    const lights = new StartLights();
    lights.arm();
    run(lights, 6);
    expect(lights.holding).toBe(false);
    lights.arm();
    expect(lights.holding).toBe(true);
    expect(lights.lamps).toBe(0);
  });
});

describe('timing the light', () => {
  /** Run the countdown to the green, holding `throttle` throughout. */
  const runTo = (lights: StartLights, throttle: number, after = 0) => {
    const dt = 1 / 120;
    lights.arm();
    while (!lights.released) lights.update(dt, throttle);
    for (let t = 0; t < after; t += dt) lights.update(dt, throttle);
    return lights;
  };

  it('punishes sitting on the limiter through the countdown', () => {
    const lights = runTo(new StartLights(), 1);
    // The common mistake, and it has to be the slow way to leave the line —
    // otherwise the countdown has no decision in it and the light is scenery.
    expect(lights.launch).toBe('bogged');
    expect(lights.throttleScale).toBeLessThan(1);
  });

  it('rewards going at the light', () => {
    const lights = new StartLights();
    const dt = 1 / 120;
    lights.arm();
    while (!lights.released) lights.update(dt, 0.4);
    // Flat within a tenth of the green.
    for (let t = 0; t < 0.1; t += dt) lights.update(dt, 1);
    expect(lights.launch).toBe('perfect');
    expect(lights.throttleScale).toBe(1);
  });

  it('calls a slow reaction slow, without taking anything away', () => {
    const lights = new StartLights();
    const dt = 1 / 120;
    lights.arm();
    while (!lights.released) lights.update(dt, 0);
    for (let t = 0; t < 0.5; t += dt) lights.update(dt, 0);
    for (let t = 0; t < 0.1; t += dt) lights.update(dt, 1);
    expect(lights.launch).toBe('clean');
    expect(lights.throttleScale).toBe(1);
  });

  it('recovers from a bogged launch rather than ruining the run', () => {
    const lights = runTo(new StartLights(), 1);
    const bogged = lights.throttleScale;
    for (let t = 0; t < 2; t += 1 / 120) lights.update(1 / 120, 1);
    expect(bogged).toBeLessThan(1);
    expect(lights.throttleScale).toBe(1);
  });

  it('grades the launch once and does not change its mind', () => {
    const lights = runTo(new StartLights(), 1, 1.5);
    const first = lights.launch;
    for (let t = 0; t < 2; t += 1 / 120) lights.update(1 / 120, 0.2);
    expect(lights.launch).toBe(first);
  });

  it('holds without counting until somebody says go', () => {
    const lights = new StartLights();
    lights.hold();
    for (let t = 0; t < 5; t += 1 / 120) lights.update(1 / 120, 1);
    // A network race: the host holds the whole grid until every guest has a
    // world, so a countdown that ran on its own would defeat the point.
    expect(lights.holding).toBe(true);
    expect(lights.lamps).toBe(0);
    lights.arm();
    expect(lights.holding).toBe(true);
    for (let t = 0; t < 5; t += 1 / 120) lights.update(1 / 120, 0);
    expect(lights.released).toBe(true);
  });
});
