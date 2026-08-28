/**
 * Corner detection, and the notes and maps built from it.
 *
 * The property that matters most is agreement: the roadside board, the
 * co-driver's call and the dot on the map all come from one list, so the only
 * way they can contradict each other is if that list is wrong.
 */

import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/data/stages/index.js';
import { Stage } from '../src/sim/stage.js';
import {
  type Corner,
  cornersAhead,
  describeCorner,
  findCorners,
  severityFor,
} from '../src/sim/corners.js';
import { mapProjection, routePath, stageMapSvg } from '../src/ui/stageMap.js';

const stages = STAGES.map((def) => new Stage(def));

describe('finding corners', () => {
  it('finds some on every stage', () => {
    for (const stage of stages) {
      expect(stage.corners.length, stage.def.id).toBeGreaterThan(0);
    }
  });

  it('reports them in order and never overlapping', () => {
    for (const stage of stages) {
      let previousExit = -1;
      for (const corner of stage.corners) {
        expect(corner.entry, stage.def.id).toBeGreaterThanOrEqual(previousExit);
        expect(corner.entry).toBeLessThanOrEqual(corner.apex);
        expect(corner.apex).toBeLessThanOrEqual(corner.exit);
        previousExit = corner.exit;
      }
    }
  });

  it('never calls one note over a third of a stage', () => {
    // The first version did exactly that: it merged everything bending the same
    // way into one corner and reported half of North Pass as a single "Right 5"
    // 416 m long. A note that covers a third of the stage is not a note.
    for (const stage of stages) {
      for (const corner of stage.corners) {
        expect(corner.exit - corner.entry, `${stage.def.id} at ${corner.entry}`).toBeLessThan(
          Math.max(stage.length / 3, 150),
        );
      }
    }
  });

  it('agrees with the road it was read from', () => {
    for (const stage of stages) {
      for (const corner of stage.corners) {
        const k = stage.spline.at(corner.apex).curvature;
        // Positive curvature is a right-hander — measured against the car's own
        // yaw rate, not assumed.
        expect(corner.direction, `${stage.def.id} at ${corner.apex}`).toBe(k > 0 ? 'right' : 'left');
        expect(corner.radius).toBeCloseTo(1 / Math.abs(k), 4);
        expect(corner.severity).toBe(severityFor(corner.radius));
      }
    }
  });

  it('rates a tighter corner as a lower number, the way a co-driver does', () => {
    expect(severityFor(10)).toBe(1);
    expect(severityFor(10)).toBeLessThan(severityFor(40));
    expect(severityFor(40)).toBeLessThan(severityFor(300));
    expect(severityFor(500)).toBe(6);
  });

  it('describes a hairpin as one', () => {
    const hairpin = { direction: 'left', severity: 1 } as Corner;
    expect(describeCorner(hairpin)).toBe('Left 1 hairpin');
    expect(describeCorner({ direction: 'right', severity: 4 } as Corner)).toBe('Right 4');
  });

  it('is stable: the same stage gives the same corners', () => {
    const a = findCorners(stages[0]!.spline, stages[0]!.length);
    const b = findCorners(stages[0]!.spline, stages[0]!.length);
    expect(a).toEqual(b);
  });
});

describe('the notes ahead', () => {
  it('keeps a corner on screen until its apex is passed', () => {
    const stage = stages[0]!;
    const first = stage.corners[0]!;

    const early = cornersAhead(stage.corners, first.entry - 100, 2);
    expect(early[0]!.corner).toBe(first);
    expect(early[0]!.distance).toBeCloseTo(100, 0);

    // Turned in, but not yet at the apex: still the corner being driven.
    const inside = cornersAhead(stage.corners, (first.entry + first.apex) / 2, 2);
    expect(inside[0]!.corner).toBe(first);
    expect(inside[0]!.distance).toBeLessThan(0);

    // Past the apex: it belongs to the road behind now.
    const after = cornersAhead(stage.corners, first.apex + 1, 2);
    expect(after[0]!.corner).not.toBe(first);
  });

  it('runs out gracefully at the finish', () => {
    const stage = stages[0]!;
    expect(cornersAhead(stage.corners, stage.length, 2)).toEqual([]);
  });
});

describe('stage maps', () => {
  it('keeps every stage inside its own box', () => {
    for (const stage of stages) {
      const projection = mapProjection(stage, 100);
      for (let d = 0; d <= stage.length; d += 10) {
        const p = projection.project(stage.spline.at(d).position);
        expect(p.x, stage.def.id).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(100);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(100);
      }
    }
  });

  it('does not stretch a stage into a square', () => {
    // A long thin stage has to come out long and thin, because the shape is the
    // part you recognise.
    const stage = stages[0]!;
    const projection = mapProjection(stage, 100);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let worldMinX = Infinity;
    let worldMaxX = -Infinity;
    let worldMinZ = Infinity;
    let worldMaxZ = -Infinity;
    for (let d = 0; d <= stage.length; d += 4) {
      const world = stage.spline.at(d).position;
      const p = projection.project(world);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      worldMinX = Math.min(worldMinX, world.x);
      worldMaxX = Math.max(worldMaxX, world.x);
      worldMinZ = Math.min(worldMinZ, world.z);
      worldMaxZ = Math.max(worldMaxZ, world.z);
    }
    const drawn = (maxX - minX) / (maxY - minY);
    const real = (worldMaxX - worldMinX) / (worldMaxZ - worldMinZ);
    expect(drawn).toBeCloseTo(real, 2);
  });

  it('draws a route, the markers and the corners', () => {
    const stage = stages[0]!;
    expect(routePath(stage, mapProjection(stage, 100)).startsWith('M')).toBe(true);

    const svg = stageMapSvg(stage, { corners: true });
    expect(svg).toContain('class="map-route"');
    expect(svg).toContain('class="map-start"');
    expect(svg).toContain('class="map-finish"');
    expect(svg).toContain('class="map-car"');
    // One dot per corner, plus the checkpoints and the start and finish.
    const circles = svg.match(/<circle/g)?.length ?? 0;
    expect(circles).toBe(stage.corners.length + stage.checkpoints.length + 3);
  });

  it('starts with nothing driven', () => {
    // The progress path is a dash over a fixed 1000-unit length, so a fresh map
    // shows the route and none of it filled in.
    expect(stageMapSvg(stages[0]!)).toContain('stroke-dasharray="0 1000"');
  });
});
