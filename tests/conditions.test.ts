/**
 * Conditions.
 *
 * Weather has to be a driving challenge rather than a filter over the screen,
 * and a variant's records have to belong to the conditions they were set in.
 */

import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/data/stages/index.js';
import {
  CLEAR_DAY,
  ambientTemperature,
  describeConditions,
  gripMultiplier,
  isWet,
  visibility,
  visibilityPenalty,
} from '../src/sim/conditions.js';
import { Stage, findVariant, stageVariants, variantKey } from '../src/sim/stage.js';
import { SURFACES } from '../src/sim/surfaces.js';
import { validateStage } from '../src/sim/runStage.js';

describe('grip', () => {
  it('leaves a dry day exactly as it was', () => {
    for (const surface of Object.values(SURFACES)) {
      expect(gripMultiplier(CLEAR_DAY, surface)).toBe(1);
    }
  });

  it('takes grip away in the rain', () => {
    const wet = { timeOfDay: 'day', weather: 'rain' } as const;
    expect(gripMultiplier(wet, SURFACES.tarmac)).toBeLessThan(1);
  });

  it('hurts tarmac far more than gravel', () => {
    // A dry racing line is what water ruins; gravel was already loose and has
    // much less to lose. A flat multiplier would miss the whole point.
    const wet = { timeOfDay: 'day', weather: 'rain' } as const;
    const tarmacLoss = 1 - gripMultiplier(wet, SURFACES.tarmac);
    const gravelLoss = 1 - gripMultiplier(wet, SURFACES.gravel);
    expect(tarmacLoss).toBeGreaterThan(gravelLoss * 2);
  });

  it('barely touches snow when it is snowing', () => {
    const snowy = { timeOfDay: 'day', weather: 'snowfall' } as const;
    expect(gripMultiplier(snowy, SURFACES.snow)).toBeGreaterThan(0.95);
  });

  it('costs visibility in fog without costing much grip', () => {
    const foggy = { timeOfDay: 'day', weather: 'fog' } as const;
    expect(gripMultiplier(foggy, SURFACES.tarmac)).toBeGreaterThan(0.93);
    expect(visibility(foggy).fogFar).toBeLessThan(visibility(CLEAR_DAY).fogFar * 0.4);
  });

  it('knows when the road is wet enough to matter', () => {
    expect(isWet(CLEAR_DAY)).toBe(false);
    expect(isWet({ timeOfDay: 'day', weather: 'rain' })).toBe(true);
  });
});

describe('visibility', () => {
  it('closes in at night', () => {
    const day = visibility(CLEAR_DAY);
    const night = visibility({ timeOfDay: 'night', weather: 'clear' });
    expect(night.fogFar).toBeLessThan(day.fogFar);
    expect(night.headlightWeight).toBe(1);
    expect(day.headlightWeight).toBe(0);
  });

  it('compounds darkness with weather', () => {
    const nightRain = visibility({ timeOfDay: 'night', weather: 'rain' });
    const dayRain = visibility({ timeOfDay: 'day', weather: 'rain' });
    expect(nightRain.fogFar).toBeLessThan(dayRain.fogFar);
  });

  it('charges harder conditions a bigger time allowance', () => {
    // The grip half of a variant's difficulty is measured by the AI; this is
    // the visibility half, which the AI cannot feel because it reads the
    // centreline rather than the screen.
    expect(visibilityPenalty(CLEAR_DAY)).toBe(1);
    expect(visibilityPenalty({ timeOfDay: 'night', weather: 'fog' })).toBeGreaterThan(
      visibilityPenalty({ timeOfDay: 'day', weather: 'overcast' }),
    );
  });

  it('never closes visibility to nothing', () => {
    for (const weather of ['clear', 'overcast', 'rain', 'fog', 'snowfall'] as const) {
      const v = visibility({ timeOfDay: 'night', weather });
      expect(v.fogNear).toBeGreaterThan(4);
      expect(v.fogFar).toBeGreaterThan(v.fogNear);
    }
  });
});

describe('ambient temperature', () => {
  it('is coldest on a snowy night and warmest on a clear day', () => {
    const cold = ambientTemperature({ timeOfDay: 'night', weather: 'snowfall' });
    const warm = ambientTemperature(CLEAR_DAY);
    expect(cold).toBeLessThan(warm);
    expect(cold).toBeGreaterThanOrEqual(0);
    expect(warm).toBeLessThanOrEqual(1);
  });
});

describe('variants', () => {
  it('always offers clear daylight, first, using the stageered numbers', () => {
    for (const def of STAGES) {
      const variants = stageVariants(def);
      expect(variants[0]!.id).toBe('day-clear');
      expect(variants[0]!.medals).toEqual(def.medals);
      expect(variants[0]!.entryFee).toBe(def.entryFee);
    }
  });

  it('scales harder conditions to slower times and bigger payouts', () => {
    const def = STAGES.find((s) => (s.variants?.length ?? 0) > 0)!;
    const [base, ...extras] = stageVariants(def);
    for (const v of extras) {
      expect(v.medals.gold).toBeGreaterThanOrEqual(base!.medals.gold);
      expect(v.payouts.gold).toBeGreaterThan(base!.payouts.gold);
      expect(v.medals.author).toBeLessThan(v.medals.gold);
    }
  });

  it('keeps records apart, so a dry gold is not a wet gold', () => {
    expect(variantKey('pine-loop', 'night-rain')).toBe('pine-loop:night-rain');
    expect(variantKey('pine-loop', 'day-clear')).not.toBe(variantKey('pine-loop', 'dusk'));
  });

  it('falls back to clear daylight for an unknown variant', () => {
    const def = STAGES[0]!;
    expect(findVariant(def, 'no-such-variant').id).toBe('day-clear');
    expect(findVariant(def, undefined).id).toBe('day-clear');
  });

  it('names itself readably', () => {
    expect(describeConditions(CLEAR_DAY)).toBe('Day');
    expect(describeConditions({ timeOfDay: 'night', weather: 'rain' })).toBe('Night · Rain');
    expect(describeConditions({ timeOfDay: 'dusk', weather: 'snowfall' })).toBe('Dusk · Snow');
  });

  it('gates harder variants behind more medals than the stage itself', () => {
    for (const def of STAGES) {
      for (const v of stageVariants(def).slice(1)) {
        expect(v.requiresMedals).toBeGreaterThanOrEqual(def.requiresMedals ?? 0);
      }
    }
  });
});

describe('every variant is drivable', () => {
  const authored = STAGES.filter((s) => (s.variants?.length ?? 0) > 0);

  it.each(authored.flatMap((def) => stageVariants(def).slice(1).map((v) => [def.name, v, def] as const)))(
    '%s in %s',
    async (_name, v, def) => {
      // A variant nobody can finish is not shippable, same bar as a stage.
      const result = await validateStage(new Stage(def), v.conditions);
      expect(result.ok, result.reason ?? '').toBe(true);
      expect(result.time!).toBeLessThan(v.medals.bronze);
    },
    90_000,
  );
});
