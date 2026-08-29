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
