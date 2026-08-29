/**
 * What the driver can see.
 *
 * These are gameplay properties, not visual ones: how much of the screen the
 * weather takes, whether the wipers clear it, and what happens when they are
 * broken. The look is the renderer's business and is checked by eye; the rules
 * are checked here.
 */

import { describe, expect, it } from 'vitest';
import { Vision, type VisionInput } from '../src/sim/vision.js';
import { DEFAULT_SETTINGS, migrateProfile } from '../src/game/save.js';
import { COMPONENT_BY_ID } from '../src/sim/damage.js';

const base: VisionInput = {
  conditions: { timeOfDay: 'day', weather: 'clear' },
  speed: 25,
  surface: 'tarmac',
  wiperHealth: 1,
  lightHealth: 1,
};

/** Run the model for `seconds`, returning the last state. */
function run(vision: Vision, seconds: number, input: Partial<VisionInput> = {}) {
  let state = vision.update(1 / 120, { ...base, ...input });
  for (let i = 1; i < seconds * 120; i++) {
    state = vision.update(1 / 120, { ...base, ...input });
  }
  return state;
}

describe('soiling', () => {
  it('leaves a clear screen clear', () => {
    const state = run(new Vision(), 30);
    expect(state.occlusion).toBe(0);
    expect(state.darkness).toBe(0);
  });

  it('builds up in rain and is cleared by the wipers', () => {
    const vision = new Vision();
    const wet = { conditions: { timeOfDay: 'day', weather: 'rain' } } as Partial<VisionInput>;

    // Long enough for several sweeps: the screen is never allowed to stay at
    // its worst, because the wipers keep taking it back down.
    let worst = 0;
    let best = 1;
    for (let i = 0; i < 120 * 12; i++) {
      const state = vision.update(1 / 120, { ...base, ...wet });
      worst = Math.max(worst, state.occlusion);
      best = Math.min(best, state.occlusion);
    }
    expect(worst).toBeGreaterThan(0.2);
    expect(best).toBeLessThan(0.15);
  });

  it('never takes the whole screen, whatever is falling', () => {
    // A view you cannot see through at all is not difficulty, it is a black
    // rectangle — so every material has a ceiling below one.
    for (const weather of ['rain', 'snowfall'] as const) {
      const state = run(new Vision(), 60, {
        conditions: { timeOfDay: 'night', weather },
        wiperHealth: 0,
      });
      expect(state.occlusion, weather).toBeLessThan(0.8);
    }
    const muddy = run(new Vision(), 60, { surface: 'mud', wiperHealth: 0 });
    expect(muddy.occlusion).toBeLessThan(0.95);
  });

  it('knows mud from rain, because they do not look alike', () => {
    expect(run(new Vision(), 5, { surface: 'mud' }).kind).toBe('mud');
    expect(
      run(new Vision(), 5, { conditions: { timeOfDay: 'day', weather: 'snowfall' } }).kind,
    ).toBe('snow');
    expect(run(new Vision(), 5, { conditions: { timeOfDay: 'day', weather: 'rain' } }).kind).toBe(
      'water',
    );
  });

  it('throws more off the road the faster you go', () => {
    const slow = run(new Vision(), 4, { surface: 'mud', speed: 4, wiperHealth: 0 });
    const fast = run(new Vision(), 4, { surface: 'mud', speed: 30, wiperHealth: 0 });
    expect(fast.occlusion).toBeGreaterThan(slow.occlusion);
  });
});

describe('wipers', () => {
  it('sweeps out, comes back, and parks', () => {
    // A wiper does not teleport to the far side and start again. The return
    // stroke is what makes it read as a wiper rather than as a wipe effect.
    const vision = new Vision();
    const wet = { conditions: { timeOfDay: 'day', weather: 'rain' } } as Partial<VisionInput>;
    let sawOutbound = false;
    let sawReturn = false;
    let lastOutbound = 0;
    let returnFell = false;
    let previous: number | null = null;
    for (let i = 0; i < 120 * 6; i++) {
      const state = vision.update(1 / 120, { ...base, ...wet });
      if (state.wiper === null) {
        previous = null;
        continue;
      }
      if (state.wiperReturning) {
        sawReturn = true;
        if (previous !== null && state.wiper < previous) returnFell = true;
      } else {
        sawOutbound = true;
        lastOutbound = Math.max(lastOutbound, state.wiper);
      }
      previous = state.wiper;
    }
    expect(sawOutbound).toBe(true);
    expect(sawReturn).toBe(true);
    // The blade travels back the way it came rather than jumping.
    expect(returnFell).toBe(true);
    expect(lastOutbound).toBeGreaterThan(0.9);
  });

  it('clears the glass on the way out, not on the way back', () => {
    // The clearing used to hang off a progress threshold narrower than one
    // fixed step, so it was stepped straight over and the wipers silently
    // stopped working — with the blade still sweeping, which is worse than
    // not having one.
    const vision = new Vision();
    const wet = { conditions: { timeOfDay: 'day', weather: 'rain' } } as Partial<VisionInput>;
    let dirtiest = 0;
    let cleanest = 1;
    for (let i = 0; i < 120 * 12; i++) {
      const state = vision.update(1 / 120, { ...base, ...wet });
      dirtiest = Math.max(dirtiest, state.occlusion);
      cleanest = Math.min(cleanest, state.occlusion);
    }
    expect(dirtiest).toBeGreaterThan(0.2);
    expect(cleanest).toBeLessThan(0.15);
  });

  it('sweeps across the screen and parks again', () => {
    const vision = new Vision();
    const wet = { conditions: { timeOfDay: 'day', weather: 'rain' } } as Partial<VisionInput>;
    const positions: number[] = [];
    let parked = 0;
    for (let i = 0; i < 120 * 6; i++) {
      const state = vision.update(1 / 120, { ...base, ...wet });
      if (state.wiper === null) parked++;
      else positions.push(state.wiper);
    }
    expect(positions.length).toBeGreaterThan(0);
    expect(parked).toBeGreaterThan(0);
    expect(Math.min(...positions)).toBeLessThan(0.1);
    expect(Math.max(...positions)).toBeGreaterThan(0.9);
  });

  it('leaves the screen dirty when they are dead', () => {
    const wet = { conditions: { timeOfDay: 'night', weather: 'rain' } } as Partial<VisionInput>;
    const working = run(new Vision(), 12, { ...wet, wiperHealth: 1 });
    const broken = run(new Vision(), 12, { ...wet, wiperHealth: 0 });

    expect(broken.wipersDead).toBe(true);
    expect(broken.wiper).toBeNull();
    expect(broken.occlusion).toBeGreaterThan(working.occlusion + 0.2);
  });

  it('is a component you can pay to fix', () => {
    // Cheap, fragile, and on a wet night the most important part on the car —
    // which is only true if it is actually in the damage model.
    const wipers = COMPONENT_BY_ID.get('wipers');
    expect(wipers).toBeDefined();
    expect(wipers!.repairCost).toBeGreaterThan(0);
    expect(wipers!.threshold).toBeLessThan(4000);
  });
});

describe('the headlight cone', () => {
  it('is only dark at night', () => {
    expect(run(new Vision(), 1).darkness).toBe(0);
    expect(
      run(new Vision(), 1, { conditions: { timeOfDay: 'night', weather: 'clear' } }).darkness,
    ).toBeGreaterThan(0.9);
  });

  it('shrinks with the lights', () => {
    const night = { conditions: { timeOfDay: 'night', weather: 'clear' } } as Partial<VisionInput>;
    const good = run(new Vision(), 1, { ...night, lightHealth: 1 });
    const broken = run(new Vision(), 1, { ...night, lightHealth: 0 });
    expect(broken.coneReach).toBeLessThan(good.coneReach);
    expect(broken.coneAngle).toBeLessThan(good.coneAngle);
    // Never nothing: a car with dead lights still sees the road under itself.
    expect(broken.coneReach).toBeGreaterThan(0.2);
  });
});

describe('the setting', () => {
  it('has a default and survives a reload', () => {
    expect(DEFAULT_SETTINGS.vision).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.vision).toBeLessThanOrEqual(1);
    expect(migrateProfile({ version: 4, settings: { vision: 0.35 } }).settings.vision).toBe(0.35);
  });

  it('gives an older profile the default rather than nothing', () => {
    expect(migrateProfile({ version: 3 }).settings).toEqual(DEFAULT_SETTINGS);
    expect(migrateProfile({ version: 4, settings: { vision: 42 } }).settings.vision).toBe(1);
  });
});


describe('the glass outside the arc', () => {
  const wet = { conditions: { timeOfDay: 'day', weather: 'rain' } } as Partial<VisionInput>;

  it('cakes up, and the wipers never touch it', () => {
    // The blades clear an arc. Everything outside it — the corners, the top,
    // the strip along the bottom — keeps what lands on it for the whole stage,
    // and that hard boundary between swept and caked glass is the single thing
    // that most separates a windscreen from a grain filter over the frame.
    const vision = new Vision();
    let crust = 0;
    let sweeps = 0;
    let previous: number | null = null;
    for (let i = 0; i < 120 * 40; i++) {
      const state = vision.update(1 / 120, { ...base, ...wet });
      // The crust only ever goes up, whatever the wipers are doing.
      expect(state.crust).toBeGreaterThanOrEqual(crust - 1e-9);
      crust = state.crust;
      if (previous !== null && state.wiper !== null && previous > state.wiper) sweeps++;
      previous = state.wiper;
    }
    expect(crust).toBeGreaterThan(0.2);
    // ...and the swept glass was cleared many times over the same run.
    expect(sweeps).toBeGreaterThan(3);
  });

  it('stays clear on a dry road', () => {
    // Fine dust off dry gravel dirties a screen; it does not build a crust on
    // it, and a stage that ends with the corners packed solid after a dry
    // afternoon is a windscreen nobody recognises.
    const dry = run(new Vision(), 60, { surface: 'gravel', speed: 30 });
    expect(dry.crust).toBeLessThan(0.05);
  });

  it('packs deepest in mud and least in rain', () => {
    const water = run(new Vision(), 60, { ...wet, wiperHealth: 1 });
    const filth = run(new Vision(), 60, { surface: 'mud', speed: 30 });
    expect(filth.crust).toBeGreaterThan(water.crust);
    // Never quite total: even a caked screen has gaps, and a black rectangle is
    // not difficulty.
    expect(filth.crust).toBeLessThan(0.95);
  });

  it('is washed off by a restart, like everything else', () => {
    const vision = new Vision();
    run(vision, 30, wet);
    vision.reset();
    expect(vision.update(1 / 120, { ...base, ...wet }).crust).toBeLessThan(0.01);
  });
});
