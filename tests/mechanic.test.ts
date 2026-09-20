/**
 * The mechanic gets to the part without walking through the car.
 *
 * He used to go in a straight line, which for anything on the far side of the
 * car is across the bonnet and out through the roof. Reported as "the mechanic
 * can walk through the car", and it is the kind of thing that is obvious in
 * one frame and invisible in every number the game prints — so it is checked
 * as geometry here rather than by looking.
 *
 * The strong assertion is the last one: every component, sampled densely along
 * the whole route, never inside the bodywork. A route that clears the car for
 * the three parts somebody happened to think of is not the property wanted.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { COMPONENTS } from '../src/sim/damage.js';
import { CAR } from '../src/data/tuning.js';
import { IDLE_SPOT, crossesBody, routeAround, standingSpot } from '../src/render/mechanic.js';

/**
 * How finely a route is sampled, metres.
 *
 * Four centimetres, against a path that keeps `BODY_CLEARANCE` — 45 cm — off
 * the bodywork. A step has to be shorter than the margin it is looking for or
 * it can pass straight through the thing it is checking, and this is an order
 * of magnitude inside that.
 *
 * It was one centimetre, which is eleven times finer than the answer needs and
 * cost the exhaustive case below most of five seconds.
 */
const STEP = 0.04;

/** True if any point along the polyline is inside the car. */
function crosses(path: THREE.Vector3[], from: THREE.Vector3): boolean {
  const point = new THREE.Vector3();
  let at = from;
  for (const leg of path) {
    const span = Math.hypot(leg.x - at.x, leg.z - at.z);
    const steps = Math.max(Math.ceil(span / STEP), 1);
    for (let i = 1; i <= steps; i++) {
      point.lerpVectors(at, leg, i / steps);
      if (insideCar(point)) return true;
    }
    at = leg;
  }
  return false;
}

/** Inside the car's actual body, which is what he must never be. */
const insideCar = (p: THREE.Vector3): boolean =>
  Math.abs(p.x) < CAR.halfExtents.x && Math.abs(p.z) < CAR.halfExtents.z;

describe('where the mechanic stands', () => {
  it('puts him outside the body for every component', () => {
    for (const component of COMPONENTS) {
      const spot = standingSpot(component.at);
      expect(insideCar(spot), `${component.id} stands inside the car`).toBe(false);
    }
  });

  it('puts him at the end he is working on, not at the middle', () => {
    // A front panel is reached over the nose and a rear one over the tail. The
    // sign of z is the whole assertion: getting it wrong would have him fixing
    // the boot from the bonnet and nothing else would notice.
    expect(standingSpot({ x: 0, y: 0, z: 1.9 }).z).toBeGreaterThan(CAR.halfExtents.z);
    expect(standingSpot({ x: 0, y: 0, z: -1.9 }).z).toBeLessThan(-CAR.halfExtents.z);
    // A flank is reached from the side, and the car's right is -X.
    expect(standingSpot({ x: -0.84, y: 0, z: 0 }).x).toBeLessThan(-CAR.halfExtents.x);
    expect(standingSpot({ x: 0.84, y: 0, z: 0 }).x).toBeGreaterThan(CAR.halfExtents.x);
  });
});

describe('the walk to it', () => {
  it('goes straight when the car is not in the way', () => {
    // Two points on the same flank. The region outside one face is convex, so
    // nothing between them can be inside the car, and routing round would be a
    // lap of the car to move two metres.
    const from = new THREE.Vector3(1.4, 0, 1.5);
    const to = new THREE.Vector3(1.4, 0, -1.5);
    expect(crossesBody(from, to)).toBe(false);
    expect(routeAround(from, to)).toHaveLength(1);
  });

  it('goes around when it is', () => {
    // Front-right to rear-left: the straight line is through the whole car.
    const from = new THREE.Vector3(1.4, 0, 1.5);
    const to = new THREE.Vector3(-1.4, 0, -1.5);
    expect(crossesBody(from, to)).toBe(true);
    expect(routeAround(from, to).length).toBeGreaterThan(1);
  });

  it('takes the shorter way round a car that is longer than it is wide', () => {
    // Across the nose, not down one flank, round the tail and back up the
    // other — which is what an angle measured in metres would have chosen,
    // because four metres of length makes the ends look far apart.
    const from = new THREE.Vector3(1.4, 0, 1.6);
    const to = new THREE.Vector3(-1.4, 0, 1.6);
    const legs = routeAround(from, to);
    // Every corner it goes round is a front one.
    for (const leg of legs.slice(0, -1)) expect(leg.z).toBeGreaterThan(0);
  });

  /*
   * Both of these collect the routes that failed and assert once.
   *
   * Asserting per sample is a quarter of a million `expect` calls for the pair
   * sweep below, which is nearly all of the cost and took it to the edge of the
   * default five-second timeout — it passed here at 4.85 s and timed out on
   * CI's slower runner. The list keeps the diagnostic that mattered: which leg
   * went through the car, by name, rather than a bare false.
   */
  it('never crosses the body, from the idle spot to any component', () => {
    const through = COMPONENTS.filter((c) =>
      crosses(routeAround(IDLE_SPOT, standingSpot(c.at)), IDLE_SPOT),
    ).map((c) => c.id);
    expect(through).toEqual([]);
  });

  it('never crosses the body going from any component to any other', () => {
    // A repair round is one part after another, and the leg between two of
    // them is the one that goes furthest across the car.
    const spots = COMPONENTS.map((c) => ({ id: c.id, at: standingSpot(c.at) }));
    const through: string[] = [];
    for (const from of spots) {
      for (const to of spots) {
        if (from.id === to.id) continue;
        if (crosses(routeAround(from.at, to.at), from.at)) through.push(`${from.id} -> ${to.id}`);
      }
    }
    expect(through).toEqual([]);
  });
});
