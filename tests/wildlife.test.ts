/**
 * Wildlife and the ambient tier.
 *
 * These protect the two halves of the fairness rule. A deer is *telegraphed*:
 * it is in the same place every load, and it is always visible and always alert
 * before it moves. Wind and stones are *random*: they fire without warning, and
 * neither can end a run on its own.
 */

import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/data/stages/index.js';
import { Stage } from '../src/sim/stage.js';
import { Wildlife, DEER_MASS, STRIKE_CONCENTRATION } from '../src/sim/wildlife.js';
import { Ambient } from '../src/sim/ambient.js';
import { DamageModel } from '../src/sim/damage.js';
import { COMPONENTS } from '../src/sim/damage.js';
import { createWorld } from '../src/sim/world.js';
import { v3 } from '../src/sim/math.js';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
const stage = new Stage(STAGES[0]!);

/** A stream that yields the same sequence every time it is built. */
function stream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const place = (seed = 7) => new Wildlife(stage.spline, stage.length, { random: stream(seed) });

describe('placement', () => {
  it('puts the same animals in the same places on the same seed', () => {
    const a = place();
    const b = place();
    expect(a.animals.map((x) => [x.distance, x.side])).toEqual(
      b.animals.map((x) => [x.distance, x.side]),
    );
    expect(a.animals.length).toBeGreaterThan(0);
  });

  it('keeps clear of the start line and the run to the finish', () => {
    for (const animal of place().animals) {
      expect(animal.distance).toBeGreaterThan(60);
      expect(animal.distance).toBeLessThan(stage.length - 60);
    }
  });

  it('stands them off the road, not on it', () => {
    for (const animal of place().animals) {
      const here = stage.progressAt(animal.position);
      expect(Math.abs(here.lateral)).toBeGreaterThan(stage.spline.at(animal.distance).width);
    }
  });
});

describe('the state machine', () => {
  const first = (w: Wildlife) => w.animals[0]!;

  it('is grazing until the car is near', () => {
    const wildlife = place();
    const animal = first(wildlife);
    wildlife.update(1 / 120, animal.distance - 200, 30);
    expect(animal.state).toBe('grazing');
  });

  it('lifts its head before it does anything else', () => {
    const wildlife = place();
    const animal = first(wildlife);
    // Approaching from 50 m: inside the alert range, outside the bolt window.
    wildlife.update(1 / 120, animal.distance - 50, 30);
    expect(animal.state).toBe('alert');
  });

  it('never bolts without having been alert first', () => {
    const wildlife = new Wildlife(stage.spline, stage.length, { random: () => 0 });
    const animal = wildlife.animals[0]!;
    // Arriving already inside the bolt window, with a stream that says yes to
    // everything: the first update may only ever promote it to alert.
    wildlife.update(1 / 120, animal.distance - 20, 40);
    expect(animal.state).toBe('alert');
    wildlife.update(1 / 120, animal.distance - 20, 40);
    expect(animal.state).toBe('bolting');
  });

  it('is more likely to bolt in front of a fast car than a slow one', () => {
    const bolts = (speed: number) => {
      let count = 0;
      for (let seed = 0; seed < 40; seed++) {
        const wildlife = new Wildlife(stage.spline, stage.length, { random: stream(seed) });
        const animal = wildlife.animals[0]!;
        for (let i = 0; i < 120; i++) {
          // Hold it in the bolt window for a second, as a real approach would.
          wildlife.update(1 / 120, animal.distance - 20, speed);
        }
        if (animal.state === 'bolting') count++;
      }
      return count;
    };
    expect(bolts(36)).toBeGreaterThan(bolts(10));
  });

  it('crosses the road and leaves', () => {
    const wildlife = new Wildlife(stage.spline, stage.length, { random: () => 0 });
    const animal = wildlife.animals[0]!;
    const startedAt = { ...animal.position };
    for (let i = 0; i < 120 * 6; i++) wildlife.update(1 / 120, animal.distance - 20, 40);
    expect(animal.state).toBe('gone');
    const moved = Math.hypot(animal.position.x - startedAt.x, animal.position.z - startedAt.z);
    expect(moved).toBeGreaterThan(2);
  });
});

describe('a strike', () => {
  it('only fires when the car is actually on top of one', () => {
    const wildlife = place();
    const animal = wildlife.animals[0]!;
    const far = v3(animal.position.x + 20, animal.position.y, animal.position.z);
    expect(wildlife.strike(far, v3(0, 0, 25))).toBeNull();
    expect(wildlife.strike(animal.position, v3(0, 0, 25))).not.toBeNull();
    // And it is over: the animal cannot be hit twice.
    expect(wildlife.strike(animal.position, v3(0, 0, 25))).toBeNull();
  });

  it('is expensive at speed and harmless at a crawl', () => {
    const bill = (kph: number) => {
      const damage = new DamageModel();
      damage.applyImpact(v3(0, 0, 1.8), (DEER_MASS * (kph / 3.6) * STRIKE_CONCENTRATION));
      return damage.repairBill().total;
    };
    expect(bill(20)).toBe(0);
    expect(bill(90)).toBeGreaterThan(200);
    expect(bill(120)).toBeGreaterThan(bill(90));
  });

  it('cannot end a run on its own, however fast', () => {
    // The fairness rule at its limit: a deer at 200 km/h is a disaster and an
    // expensive one, but it is not allowed to be an instant retirement.
    const damage = new DamageModel();
    damage.applyImpact(v3(0, 0, 1.8), DEER_MASS * (200 / 3.6) * STRIKE_CONCENTRATION);
    expect(damage.retired).toBe(false);
  });
});

describe('wind and stones', () => {
  it('does not blow at all in a forest', () => {
    const sheltered = new Ambient({ biome: 'forest', random: stream(3) });
    expect(sheltered.windy).toBe(false);
    for (let i = 0; i < 120 * 120; i++) sheltered.update(1 / 120, 35, 'gravel');
    expect(sheltered.gust).toBe(0);
  });

  it('blows on an exposed coast, and never hard enough to spin the car', () => {
    const exposed = new Ambient({
      biome: 'coast',
      conditions: { timeOfDay: 'day', weather: 'rain' },
      random: stream(5),
    });
    expect(exposed.windy).toBe(true);

    let peak = 0;
    let gusted = false;
    for (let i = 0; i < 120 * 300; i++) {
      exposed.update(1 / 120, 35, 'tarmac');
      peak = Math.max(peak, Math.abs(exposed.gust));
      if (exposed.gust !== 0) gusted = true;
    }
    expect(gusted).toBe(true);
    // A tenth of a g at the very most: enough to move the line, never the car.
    expect(peak).toBeLessThan(1.2);
  });

  it('leaves a parked car alone', () => {
    const ambient = new Ambient({ biome: 'coast', random: stream(9) });
    for (let i = 0; i < 120 * 120; i++) ambient.update(1 / 120, 0, 'gravel');
    expect(ambient.gust).toBe(0);
    expect(ambient.drainStones()).toEqual([]);
  });

  it('throws stones on loose surfaces only, and they are cosmetic', () => {
    const onGravel = new Ambient({ biome: 'quarry', random: stream(11) });
    const onTarmac = new Ambient({ biome: 'quarry', random: stream(11) });
    let gravelStones = 0;
    let tarmacStones = 0;
    for (let i = 0; i < 120 * 600; i++) {
      onGravel.update(1 / 120, 34, 'gravel');
      onTarmac.update(1 / 120, 34, 'tarmac');
      gravelStones += onGravel.drainStones().length;
      tarmacStones += onTarmac.drainStones().length;
    }
    expect(gravelStones).toBeGreaterThan(0);
    expect(tarmacStones).toBe(0);

    // Cosmetic means cosmetic: a stone may mark a light or a panel and must
    // never reach anything that decides whether the car finishes.
    const damage = new DamageModel();
    for (let i = 0; i < 40; i++) damage.applyImpact(v3(0, 0.2, 1.8), 4800);
    expect(damage.retired).toBe(false);
    expect(damage.get('cooling')).toBe(1);
    expect(damage.get('engine')).toBe(1);
    const marked = COMPONENTS.filter((c) => damage.get(c.id) < 1).map((c) => c.id);
    expect(marked).toContain('lights');
  });
});

describe('in the world', () => {
  it('is off for a run with no damage model, so validation is not at their mercy', async () => {
    const world = await createWorld({ stage });
    expect(world.wildlife).toBeNull();
    expect(world.ambient).toBeNull();
  });

  it('is on for a race, and resets with everything else', async () => {
    const world = await createWorld({ stage, damage: true });
    expect(world.wildlife).not.toBeNull();
    expect(world.wildlife!.animals.length).toBeGreaterThan(0);

    world.wildlife!.animals[0]!.state = 'gone';
    world.step(NEUTRAL);
    world.clearDebris();
    expect(world.wildlife!.animals[0]!.state).toBe('grazing');
  });

  it('places the same animals on every load of the same stage', async () => {
    const a = await createWorld({ stage: new Stage(STAGES[0]!), damage: true });
    const b = await createWorld({ stage: new Stage(STAGES[0]!), damage: true });
    expect(a.wildlife!.animals.map((x) => x.distance)).toEqual(
      b.wildlife!.animals.map((x) => x.distance),
    );
  });
});
