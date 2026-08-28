/**
 * The ground under a stage.
 *
 * A centreline says where a road goes and almost nothing about what it is. Left
 * to itself every stage came out flat in both directions at once — level across,
 * level along — and a flat road takes the same line at the same speed
 * everywhere on it.
 *
 * The two things worth protecting here are that the shaping is *deterministic*
 * (a stage must be the same road every time it loads, in the browser and in
 * every headless run) and that it stays *drivable* — `npm run stages` is the
 * real gate for the second, and these are the cheap checks that come first.
 */

import { describe, expect, it } from 'vitest';
import { shapeCamber, terrainRise } from '../src/sim/terrain.js';
import { Spline, type ControlPoint } from '../src/sim/spline.js';
import { Stage } from '../src/sim/stage.js';
import { STAGES } from '../src/data/stages/index.js';

const cp = (x: number, z: number, banking?: number): ControlPoint => ({
  pos: { x, y: 0, z },
  width: 6,
  surface: 'gravel',
  ...(banking === undefined ? {} : { banking }),
});

/**
 * A **left**-hand corner: heading up +z, curving toward +x.
 *
 * +x is the driver's left, not their right — `cross(up, forward)` in a
 * right-handed Y-up world with the nose along +z points left. This is the trap
 * that has cost this project more time than anything else, and it caught this
 * test first: it was written as a right-hander and the camber came out
 * negative, which was the code being right and the test being wrong.
 */
const leftHander = (): ControlPoint[] => [
  cp(0, 0),
  cp(0, 40),
  cp(4, 78),
  cp(18, 110),
  cp(46, 128),
  cp(86, 132),
];

/** The same corner mirrored: a right-hander. */
const rightHander = (): ControlPoint[] =>
  leftHander().map((p) => ({ ...p, pos: { ...p.pos, x: -p.pos.x } }));

describe('camber', () => {
  it('raises the outside of the corner, whichever way it goes', () => {
    // The claim being protected is one sentence — the outside edge of a banked
    // corner is the higher one — and it is checked through the real spline
    // frames in both directions, because a sign that is right in one direction
    // and wrong in the other passes any single-corner test.
    for (const [points, sign] of [
      [leftHander(), -1],
      [rightHander(), 1],
    ] as const) {
      const banked = shapeCamber(points, 'test', { mood: () => 1 });
      const spline = new Spline(banked);
      const inCorner = spline.at(spline.length * 0.6);
      expect(Math.sign(inCorner.curvature)).toBe(sign);
      // `left` points to the driver's left; a positive y means the left edge is
      // the high one. In a left-hander the outside is the right-hand edge, so
      // the left edge should be the low one, and the other way round.
      expect(Math.sign(inCorner.left.y)).toBe(sign);
      expect(Math.abs(inCorner.left.y)).toBeGreaterThan(0.01);
    }
  });

  it('drops the outside away when a corner is off-camber', () => {
    const banked = shapeCamber(leftHander(), 'test', { mood: () => 1 });
    const fallen = shapeCamber(leftHander(), 'test', { mood: () => -1 });
    for (let i = 1; i < banked.length - 1; i++) {
      expect(Math.sign(fallen[i]!.banking!)).toBe(-Math.sign(banked[i]!.banking!));
    }
  });

  it('leaves a straight flat', () => {
    const straight = shapeCamber([cp(0, 0), cp(0, 60), cp(0, 120), cp(0, 180)], 'test', {
      mood: () => 1,
    });
    for (const point of straight) expect(Math.abs(point.banking!)).toBeLessThan(1e-6);
  });

  it('never argues with an authored value', () => {
    // A stage that has been given banking by hand has been given it for a
    // reason, and the procedural pass is not entitled to an opinion.
    const authored = shapeCamber(
      leftHander().map((p, i) => (i === 3 ? cp(18, 110, -0.4) : p)),
      'test',
    );
    expect(authored[3]!.banking).toBe(-0.4);
  });

  it('is flat at both ends, where the grid and the run-off are', () => {
    const shaped = shapeCamber(leftHander(), 'test', { mood: () => 1 });
    expect(shaped[0]!.banking).toBe(0);
    expect(shaped[shaped.length - 1]!.banking).toBe(0);
  });
});

describe('elevation', () => {
  const rise = terrainRise('pine-loop', 800);

  it('is level at the start line and at the finish', () => {
    // A grid on a slope, or a finish run-off tipping downhill, is a car rolling
    // off the end of the world.
    expect(rise(0)).toBeCloseTo(0, 10);
    expect(rise(800)).toBeCloseTo(0, 10);
  });

  it('rolls in between', () => {
    let lowest = Infinity;
    let highest = -Infinity;
    for (let d = 0; d <= 800; d += 2) {
      lowest = Math.min(lowest, rise(d));
      highest = Math.max(highest, rise(d));
    }
    expect(highest - lowest).toBeGreaterThan(1.5);
  });

  it('stays gentle enough to drive up', () => {
    // Measured: 2.2 m of amplitude at a 96 m wavelength gave one-in-three
    // slopes and put a quarter of a stage's AI lap off the road.
    let steepest = 0;
    for (let d = 2; d <= 800; d += 2) steepest = Math.max(steepest, Math.abs(rise(d) - rise(d - 2)) / 2);
    expect(steepest).toBeLessThan(0.12);
  });

  it('gives every stage its own ground', () => {
    const a = terrainRise('pine-loop', 800);
    const b = terrainRise('quarry-run', 800);
    const sample = (f: (d: number) => number) => [100, 200, 300, 400].map(f);
    expect(sample(a)).not.toEqual(sample(b));
    // And the same stage is the same road every time it is built.
    expect(sample(terrainRise('pine-loop', 800))).toEqual(sample(a));
  });
});

describe('a shaped stage', () => {
  it('is no longer flat from end to end', () => {
    const stage = new Stage(STAGES[0]!);
    const heights = stage.spline.samples.map((s) => s.position.y);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(3);
  });

  it('has a crown down the middle of the road', () => {
    // Every real road sheds water sideways. Small, but it is why running wide
    // costs a little more than the width does.
    const stage = new Stage(STAGES[0]!);
    // Nine columns per row: wall, bank, verge, edge, centre, edge, verge, bank,
    // wall. Row 40 is well past the start apron.
    const row = 40 * 9;
    const centre = stage.geometry.vertices[(row + 4) * 3 + 1]!;
    const left = stage.geometry.vertices[(row + 3) * 3 + 1]!;
    const right = stage.geometry.vertices[(row + 5) * 3 + 1]!;
    expect(centre).toBeGreaterThan(Math.max(left, right));
    // A crown, not a hump: an inch or two over a car's width.
    expect(centre - Math.max(left, right)).toBeLessThan(0.25);
  });

  it('builds the same stage twice', () => {
    const one = new Stage(STAGES[1]!).spline.samples.map((s) => s.position.y);
    const two = new Stage(STAGES[1]!).spline.samples.map((s) => s.position.y);
    expect(one).toEqual(two);
  });

  it('does not modify the stage definition it was given', () => {
    // Definitions are module-level constants shared by every world that loads
    // them; a stage that grew a hill each time it was built would be a fine way
    // to spend an afternoon.
    const before = STAGES[0]!.controlPoints.map((p) => ({ ...p.pos }));
    new Stage(STAGES[0]!);
    new Stage(STAGES[0]!);
    expect(STAGES[0]!.controlPoints.map((p) => ({ ...p.pos }))).toEqual(before);
  });
});
