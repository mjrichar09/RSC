/**
 * The three things Coldwater Pass added that are rules rather than scenery.
 *
 * A rockslide that lands on a seeded side, water that is only down one edge of
 * the road, and an animal that is not a deer. All three are the kind of thing
 * that looks right in one screenshot and is wrong everywhere else, so they are
 * checked as rules here and left to the stage validator to prove driveable.
 */

import { describe, expect, it } from 'vitest';
import { Stage, type StageDef } from '../src/sim/stage.js';
import { stageById } from '../src/data/stages/index.js';
import { ANIMAL_MASS, DEER_MASS, SHEEP_MASS, strikeImpulse } from '../src/sim/wildlife.js';
import { DamageModel } from '../src/sim/damage.js';

const def = stageById('coldwater-pass');
const stage = new Stage(def);

describe('the rockslide', () => {
  it('comes down on one side or the other, never neither', () => {
    expect(def.slide).toBeDefined();
    expect([-1, 1]).toContain(stage.slideSide);
  });

  it('lands in the same place for everyone racing the same pairing', () => {
    // The whole reason it is seeded rather than random. A hazard that moved
    // between runs would make a ghost a recording of a different road and the
    // leaderboard a comparison of different races.
    const again = new Stage(def);
    expect(again.slideSide).toBe(stage.slideSide);
    const boulders = (s: Stage) =>
      s.props.filter((p) => p.kind === 'rock').map((p) => `${p.position.x.toFixed(2)}`);
    expect(boulders(again)).toEqual(boulders(stage));
  });

  it('can land on the other side under different conditions', () => {
    // `loadStage` seeds with the variant, so the dry road and the wet road are
    // allowed to differ — and across the seeds there has to be at least one of
    // each, or "which side" was never a question.
    const sides = new Set(
      ['day-clear', 'dusk', 'rain', 'night-snow', 'a', 'b', 'c'].map(
        (v) => new Stage(def, `${def.id}:${v}`).slideSide,
      ),
    );
    expect(sides.size).toBe(2);
  });

  it('always leaves a way through', () => {
    // It reaches across its own half of the road and no further. A slide that
    // met the far verge would not be a hazard, it would be a wall, and the
    // stage validator would be the only thing that ever found out.
    const slide = def.slide!;
    const rocks = stage.props.filter(
      (p) => p.kind === 'rock' && p.position.y > -900,
    );
    expect(rocks.length).toBeGreaterThanOrEqual(slide.count);
    for (let d = slide.from; d <= slide.from + slide.length; d += 5) {
      const sample = stage.spline.at(d);
      // The far half of the road, measured from the centreline away from the
      // side the slide came down.
      const clear = { ...sample.position };
      const off = -stage.slideSide * sample.width * 0.6;
      clear.x += sample.left.x * off;
      clear.z += sample.left.z * off;
      const near = rocks.some(
        (r) => Math.hypot(r.position.x - clear.x, r.position.z - clear.z) < r.radius,
      );
      expect(near, `blocked at ${d} m`).toBe(false);
    }
  });
});

describe('the water', () => {
  const patch = def.water![0]!;
  const at = (distance: number, across: number) => {
    const s = stage.spline.at(distance);
    return {
      x: s.position.x + s.left.x * across * s.width,
      y: s.position.y,
      z: s.position.z + s.left.z * across * s.width,
    };
  };
  const mid = (patch.from + patch.to) / 2;
  /*
   * Which way `side` points, written down once.
   *
   * `side` follows the convention the animals use: -1 is the left of the road.
   * The spline's `left` vector is positive *to the left*, so the left of the
   * road is a positive multiple of it — the two are opposite signs. This is
   * the handedness trap this codebase has fallen into more than once, so the
   * conversion lives in one place and is asserted rather than assumed.
   */
  const lateralFor = (side: -1 | 1) => -side;

  it('is down one side of the road and not the other', () => {
    const wet = at(mid, lateralFor(patch.side) * 0.85);
    const dry = at(mid, -lateralFor(patch.side) * 0.85);
    expect(stage.surfaceAt(wet).surface).toBe('water');
    expect(stage.surfaceAt(dry).surface).not.toBe('water');
  });

  it('leaves the far side of the road dry, and the centreline too', () => {
    expect(stage.surfaceAt(at(mid, 0)).surface).not.toBe('water');
  });

  it('stops where it is told to', () => {
    const across = lateralFor(patch.side) * 0.85;
    expect(stage.surfaceAt(at(patch.from - 40, across)).surface).not.toBe('water');
    expect(stage.surfaceAt(at(patch.to + 40, across)).surface).not.toBe('water');
  });
});

describe('sheep', () => {
  it('weigh a fraction of a deer, and cost a fraction to hit', () => {
    expect(SHEEP_MASS).toBeLessThan(DEER_MASS / 3);
    expect(ANIMAL_MASS.sheep).toBe(SHEEP_MASS);
    // At the same speed, through the same curve.
    const speed = 25;
    expect(strikeImpulse(speed, 'sheep')).toBeLessThan(strikeImpulse(speed, 'deer') / 2);
  });

  it('still defaults to a deer, so the old harness prices what it always did', () => {
    // `npm run crash -- --deer=` calls this with one argument and must keep
    // getting the number it was calibrated against.
    expect(strikeImpulse(30)).toBe(strikeImpulse(30, 'deer'));
  });

  it('stand together on the stage rather than being spread down it', () => {
    const flock = def.flocks![0]!;
    expect(flock.kind).toBe('sheep');
    expect(flock.count).toBeGreaterThan(8);
    // Tight enough to be a flock and not a fence: the whole thing inside a
    // couple of car lengths of road either side of where it was placed.
    expect(flock.spread).toBeLessThan(160);
  });
});

describe('the pass itself', () => {
  it('climbs and descends far enough to be the stage it claims to be', () => {
    const heights = def.controlPoints.map((c) => c.pos.y);
    const summit = Math.max(...heights);
    expect(summit).toBeGreaterThan(180);
    // It finishes below where it started: a pass goes over, not up and back.
    expect(heights[heights.length - 1]!).toBeLessThan(0);
    expect(summit - heights[heights.length - 1]!).toBeGreaterThan(250);
  });

  it('never doubles back onto itself', () => {
    expect(stage.selfIntersections()).toHaveLength(0);
  });

  it('builds no bridges, because nothing here crosses anything', () => {
    // The stack marches away from the approach. Marched the other way it walks
    // the climb back over the road it started on, 200 m up, and `findCrossings`
    // carries it on piers.
    expect(stage.crossings).toHaveLength(0);
  });
});

describe('a stage with none of it', () => {
  it('is unchanged by any of this', () => {
    // Everything above is opt-in data. A stage that asks for no slide, no
    // water and no flock has to behave exactly as it did.
    const plain = stageById('pine-loop') as StageDef;
    expect(plain.slide).toBeUndefined();
    const built = new Stage(plain);
    expect(built.slideSide).toBe(0);
    expect(built.surfaceAt(built.spline.at(100).position).surface).not.toBe('water');
  });
});

describe('what the water is for', () => {
  /** Coast for `secs` with the discs at `from` C, wet or dry, and report them. */
  const cool = (from: number, wet: boolean, secs: number): number => {
    const damage = new DamageModel();
    damage.brakeTemp.fill(from);
    const corners = [0, 1, 2, 3].map(() => ({ torque: 0, spin: 0, wet }));
    for (let i = 0; i < secs * 120; i++) damage.updateBrakes(1 / 120, corners, 18);
    return Math.max(...damage.brakeTemp);
  };

  it('takes heat out of a cooked disc far faster than air does', () => {
    // The reason it is worth the grip and the time it costs. Two seconds in it
    // has to be worth taking, or nobody ever will.
    const dry = cool(480, false, 2);
    const wet = cool(480, true, 2);
    expect(wet).toBeLessThan(dry - 150);
  });

  it('brings a disc back from past the fade threshold to something usable', () => {
    // Fade begins at 520 C. A descent that ends there and a gutter that cannot
    // fix it is a stage with a dead end in it.
    expect(cool(560, true, 3)).toBeLessThan(300);
  });

  it('does nothing to a disc that was not hot', () => {
    // It is a cooling path, not a temperature setter: a cold brake driven
    // through water must not come out colder than the air around it.
    const damage = new DamageModel();
    const ambient = damage.brakeTemp[0]!;
    expect(cool(ambient, true, 2)).toBeCloseTo(ambient, 1);
  });

  it('cools only the wheels that are in it', () => {
    // Two wheels in the gutter and two on dry road is the interesting case and
    // the one a player will actually try.
    const damage = new DamageModel();
    damage.brakeTemp.fill(480);
    const corners = [
      { torque: 0, spin: 0, wet: true },
      { torque: 0, spin: 0, wet: false },
      { torque: 0, spin: 0, wet: true },
      { torque: 0, spin: 0, wet: false },
    ];
    for (let i = 0; i < 240; i++) damage.updateBrakes(1 / 120, corners, 18);
    expect(damage.brakeTemp[0]!).toBeLessThan(damage.brakeTemp[1]! - 150);
    expect(damage.brakeTemp[2]!).toBeLessThan(damage.brakeTemp[3]! - 150);
  });
});
