/**
 * Component damage.
 *
 * The design rules these protect: impacts land where they actually hit, effects
 * are continuous rather than binary, total failures are reachable but only from
 * genuinely big accidents, and the repair bill is proportional to what broke.
 */

import { describe, expect, it } from 'vitest';
import {
  COMPONENTS,
  DamageModel,
  impactPointFromForce,
} from '../src/sim/damage.js';
import { v3 } from '../src/sim/math.js';
import { SURFACES } from '../src/sim/surfaces.js';

/** A head-on impact pushes the car backwards, so the force direction is -z. */
const HEAD_ON = v3(0, 0, -1);
const REAR_ON = v3(0, 0, 1);
/**
 * A hit that shoves the car toward +X came from -X, and -X is the car's right:
 * nose along +Z, up along +Y, right-handed. Named for the side it landed on.
 */
const RIGHT_ON = v3(1, 0, 0);

describe('impactPointFromForce', () => {
  it('puts a head-on impact on the nose', () => {
    const p = impactPointFromForce(HEAD_ON);
    expect(p.z).toBeGreaterThan(1.5);
    expect(Math.abs(p.x)).toBeLessThan(0.1);
  });

  it('puts a rear impact on the tail', () => {
    expect(impactPointFromForce(REAR_ON).z).toBeLessThan(-1.5);
  });

  it('puts a hit from the right on the right flank', () => {
    const p = impactPointFromForce(RIGHT_ON);
    expect(p.x).toBeLessThan(-0.5);
  });

  it('never returns a point outside the chassis', () => {
    for (const d of [v3(1, 1, 1), v3(-3, 0.2, 0.4), v3(0, -1, 0), v3(0.1, 0, -5)]) {
      const p = impactPointFromForce(d);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(0.86);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(0.46);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(1.96);
    }
  });

  it('survives a zero-length direction', () => {
    expect(Number.isFinite(impactPointFromForce(v3(0, 0, 0)).z)).toBe(true);
  });
});

describe('impacts', () => {
  it('starts undamaged', () => {
    const d = new DamageModel();
    expect(d.condition).toBe(1);
    expect(d.retired).toBe(false);
    expect(d.repairBill().total).toBe(0);
  });

  it('ignores impacts below every threshold', () => {
    const d = new DamageModel();
    d.applyImpact(impactPointFromForce(HEAD_ON), 800);
    expect(d.condition).toBe(1);
  });

  it('damages the front, and only the front, in a head-on hit', () => {
    const d = new DamageModel();
    d.applyImpact(impactPointFromForce(HEAD_ON), 20_000);

    expect(d.get('panelFront')).toBeLessThan(1);
    expect(d.get('cooling')).toBeLessThan(1);
    // Nothing at the other end of the car should be touched.
    expect(d.get('panelRear')).toBe(1);
    expect(d.get('differential')).toBe(1);
    expect(d.get('tyreRL')).toBe(1);
  });

  it('damages one corner in a side hit, not both', () => {
    const d = new DamageModel();
    d.applyImpact(impactPointFromForce(RIGHT_ON), 22_000);
    expect(d.get('panelRight')).toBeLessThan(1);
    expect(d.get('panelLeft')).toBe(1);
  });

  it('scales with impact severity', () => {
    const light = new DamageModel();
    const heavy = new DamageModel();
    light.applyImpact(impactPointFromForce(HEAD_ON), 12_000);
    heavy.applyImpact(impactPointFromForce(HEAD_ON), 30_000);
    expect(heavy.condition).toBeLessThan(light.condition);
    expect(heavy.repairBill().total).toBeGreaterThan(light.repairBill().total);
  });

  it('never drives a component below zero, however many hits it takes', () => {
    const d = new DamageModel();
    for (let i = 0; i < 40; i++) d.applyImpact(impactPointFromForce(HEAD_ON), 40_000);
    for (const c of COMPONENTS) expect(d.get(c.id)).toBeGreaterThanOrEqual(0);
  });

  it('ends the race on a big enough head-on impact', () => {
    const d = new DamageModel();
    for (let i = 0; i < 4; i++) d.applyImpact(impactPointFromForce(HEAD_ON), 46_000);
    expect(d.retired).toBe(true);
    expect(d.failures.has('engine-seized')).toBe(true);
  });

  it('is softened by a rollcage — but only for what a cage protects', () => {
    const bare = new DamageModel();
    const caged = new DamageModel({ rollcage: 0.6 });
    for (const d of [bare, caged]) d.applyImpact(impactPointFromForce(HEAD_ON), 26_000);

    expect(caged.get('engine')).toBeGreaterThan(bare.get('engine'));
    // Panels are bodywork, not structure: a cage does nothing for them.
    expect(caged.get('panelFront')).toBeCloseTo(bare.get('panelFront'), 5);
  });

  it('reports what broke, so the HUD can say so', () => {
    const d = new DamageModel();
    d.applyImpact(impactPointFromForce(HEAD_ON), 20_000);
    const events = d.drainEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.amount > 0 && e.remaining >= 0)).toBe(true);
    // Draining clears them, so the same break is never reported twice.
    expect(d.drainEvents()).toEqual([]);
  });
});

describe('dents', () => {
  it('remembers where the car was hit, not just what it cost', () => {
    // Component health prices the damage; this is what the car looks like.
    const d = new DamageModel();
    d.applyImpact(v3(0, 0, 1.9), 18_000);
    expect(d.dents).toHaveLength(1);
    expect(d.dents[0]!.at.z).toBeCloseTo(1.9, 5);
    expect(d.dents[0]!.depth).toBeGreaterThan(0.5);
  });

  it('marks a scrape that costs nothing to repair', () => {
    // A car that only shows damage once it is expensive looks indestructible
    // right up until it looks wrecked.
    const d = new DamageModel();
    d.applyImpact(v3(0.84, 0, 0), 2600);
    expect(d.repairBill().total).toBe(0);
    expect(d.dents.length).toBeGreaterThan(0);
  });

  it('deepens one fold rather than stacking ten', () => {
    const d = new DamageModel();
    for (let i = 0; i < 6; i++) d.applyImpact(v3(0, 0, 1.9), 9000);
    expect(d.dents).toHaveLength(1);
    expect(d.dents[0]!.depth).toBeGreaterThan(0.5);
    // And it spreads, but never past the width of the car.
    expect(d.dents[0]!.reach).toBeLessThan(1.8);
  });

  it('keeps the deepest when the car runs out of room to remember', () => {
    const d = new DamageModel();
    // Twenty separate places, alternating heavy and light.
    for (let i = 0; i < 20; i++) {
      d.applyImpact(v3(-0.8 + (i % 5) * 0.4, -0.4 + (i % 3) * 0.4, -1.9 + i * 0.2), i % 2 ? 3000 : 24_000);
    }
    expect(d.dents.length).toBeLessThanOrEqual(10);
    expect(Math.max(...d.dents.map((x) => x.depth))).toBeGreaterThan(0.5);
  });

  it('tells the renderer when to reshape, and only then', () => {
    // Rebuilding fifteen deformed meshes is not a thing to do every frame.
    const d = new DamageModel();
    const before = d.dentVersion;
    d.applyImpact(v3(0, 0, 1.9), 400);
    expect(d.dentVersion).toBe(before);
    d.applyImpact(v3(0, 0, 1.9), 18_000);
    expect(d.dentVersion).toBeGreaterThan(before);
  });

  it('straightens out on a reset', () => {
    const d = new DamageModel();
    d.applyImpact(v3(0, 0, 1.9), 18_000);
    d.reset();
    expect(d.dents).toHaveLength(0);
  });
});

describe('handling effects', () => {
  it('leaves an undamaged car completely unaffected', () => {
    const fx = new DamageModel({ random: () => 1 }).effects();
    expect(fx.engineTorque).toBe(1);
    expect(fx.wheelGrip).toEqual([1, 1, 1, 1]);
    expect(fx.steeringOffset).toBe(0);
    expect(fx.dragScale).toBe(1);
    expect(fx.wheelLost).toEqual([false, false, false, false]);
  });

  it('degrades continuously rather than in steps', () => {
    const readings = [1, 0.75, 0.5, 0.25, 0].map((health) => {
      const d = new DamageModel({ random: () => 1 });
      d.health.set('engine', health);
      return d.effects().engineTorque;
    });
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]!).toBeLessThan(readings[i - 1]!);
    }
  });

  it('loses grip on the corner with the damaged tyre only', () => {
    const d = new DamageModel({ random: () => 1 });
    d.health.set('tyreFL', 0);
    const fx = d.effects();
    expect(fx.wheelGrip[0]).toBeLessThan(0.3);
    expect(fx.wheelGrip[1]).toBe(1);
  });

  it('pulls the steering and reduces lock when the rack is bent', () => {
    const d = new DamageModel({ random: () => 1 });
    d.health.set('steering', 0.3);
    const fx = d.effects();
    expect(Math.abs(fx.steeringOffset)).toBeGreaterThan(0);
    expect(fx.steeringRange).toBeLessThan(1);
  });

  it('pulls toward whichever front corner took the hit', () => {
    // Not a coin flip: the pull has to agree with the bodywork, or the first
    // time it disagrees it reads as a bug in the steering.
    const bent = (wingFL: number, wingFR: number) => {
      const d = new DamageModel({ random: () => 1 });
      d.health.set('steering', 0.3);
      d.health.set('wingFL', wingFL);
      d.health.set('wingFR', wingFR);
      return d.effects().steeringOffset;
    };
    expect(Math.sign(bent(0.2, 1))).toBe(-Math.sign(bent(1, 0.2)));
  });

  it('pulls toward a flat front tyre, and not toward a flat rear one', () => {
    const offset = (id: 'tyreFL' | 'tyreFR' | 'tyreRL') => {
      const d = new DamageModel({ random: () => 1 });
      d.health.set(id, 0);
      return d.effects().steeringOffset;
    };
    expect(offset('tyreFL')).toBeLessThan(0);
    expect(offset('tyreFR')).toBeGreaterThan(0);
    expect(offset('tyreRL')).toBe(0);
  });

  it('makes a deflating tyre drag before it is flat', () => {
    // A puncture is not a switch. Below about a fifth of tread the carcass
    // starts folding, and the drag is what the driver notices first.
    const drag = (health: number) => {
      const d = new DamageModel({ random: () => 1 });
      d.health.set('tyreFL', health);
      return d.effects().wheelDrag[0];
    };
    expect(drag(0.5)).toBe(0);
    expect(drag(0.1)).toBeGreaterThan(0);
    expect(drag(0)).toBeGreaterThan(drag(0.1));
  });

  it('detaches a wheel when its hub is destroyed', () => {
    const d = new DamageModel({ random: () => 1 });
    d.health.set('hubRR', 0);
    expect(d.effects().wheelLost).toEqual([false, false, false, true]);
  });
});

describe('heat and fuel', () => {
  const race = (d: DamageModel, seconds: number) => {
    for (let t = 0; t < seconds * 120; t++) d.update(1 / 120, { rpmFraction: 0.62, speed: 26 });
  };

  it('never overheats with a healthy radiator', () => {
    const d = new DamageModel();
    race(d, 300);
    // Warm, not cold. `< 0.1` here used to pass because the model could only
    // subtract: a healthy radiator always shed more than the engine made, so
    // temperature pinned at the bottom and the gauge read 0 degrees on a
    // running engine. It settles at a balance point now, and what "healthy"
    // means is that the balance point is a normal operating temperature — five
    // minutes of racing must land in the band a real gauge sits in and stay
    // clear of the steam threshold at 0.82.
    expect(d.temperature).toBeGreaterThan(0.66); // ~80 C
    expect(d.temperature).toBeLessThan(0.8); // ~96 C
    expect(d.boiling).toBe(0);
    expect(d.failures.has('overheated')).toBe(false);
  });

  it('boils within a stage when the radiator is holed', () => {
    const d = new DamageModel();
    d.health.set('cooling', 0);
    race(d, 60);
    // The failure has to be able to bite inside a race, or it means nothing.
    expect(d.failures.has('overheated')).toBe(true);
  });

  it('cuts power before it boils, as a warning', () => {
    const d = new DamageModel({ random: () => 1 });
    d.health.set('cooling', 0);
    race(d, 26);
    expect(d.failures.has('overheated')).toBe(false);
    expect(d.effects().engineTorque).toBeLessThan(0.95);
  });

  it('carries enough fuel for any stage, until the line is holed', () => {
    const healthy = new DamageModel();
    race(healthy, 200);
    expect(healthy.fuel).toBeGreaterThan(0);
    expect(healthy.failures.has('out-of-fuel')).toBe(false);

    const leaking = new DamageModel();
    leaking.health.set('fuelLine', 0);
    race(leaking, 200);
    expect(leaking.failures.has('out-of-fuel')).toBe(true);
  });
});

describe('repair bills', () => {
  it('charges nothing for a pristine car and lists the worst damage first', () => {
    const d = new DamageModel();
    expect(d.repairBill().total).toBe(0);

    d.applyImpact(impactPointFromForce(HEAD_ON), 34_000);
    const bill = d.repairBill();
    expect(bill.total).toBeGreaterThan(0);
    for (let i = 1; i < bill.lines.length; i++) {
      expect(bill.lines[i]!.cost).toBeLessThanOrEqual(bill.lines[i - 1]!.cost);
    }
  });

  it('costs more the worse the accident', () => {
    const bill = (impulse: number) => {
      const d = new DamageModel();
      d.applyImpact(impactPointFromForce(HEAD_ON), impulse);
      return d.repairBill().total;
    };
    expect(bill(10_000)).toBeLessThan(bill(20_000));
    expect(bill(20_000)).toBeLessThan(bill(40_000));
  });

  it('resets to a factory-fresh car', () => {
    const d = new DamageModel();
    for (let i = 0; i < 5; i++) d.applyImpact(impactPointFromForce(HEAD_ON), 40_000);
    d.reset();
    expect(d.condition).toBe(1);
    expect(d.retired).toBe(false);
    // Operating temperature, not zero: a rally car reaches the start line warmed
    // up in service, and a repaired one is no different.
    expect(d.temperature).toBeGreaterThan(0.7);
    expect(d.boiling).toBe(0);
    expect(d.fuel).toBe(d.fuelCapacity);
  });
});

describe('warnings', () => {
  it('says nothing about a healthy car', () => {
    expect(new DamageModel().warnings()).toEqual([]);
  });

  it('predicts an overheat, with a time the player can act on', () => {
    const d = new DamageModel();
    d.health.set('cooling', 0);

    const boil = d.secondsToOverheat();
    expect(boil).not.toBeNull();
    expect(boil!).toBeGreaterThan(5);
    expect(boil!).toBeLessThan(90);

    const warning = d.warnings().find((w) => w.text.includes('overheat'));
    expect(warning?.severity).toBe('severe');
  });

  it('agrees with what actually happens', () => {
    // The prediction is derived from the same rates `update` uses, so the two
    // must not drift apart — a warning that lies is worse than no warning.
    const d = new DamageModel();
    d.health.set('cooling', 0.2);
    const predicted = d.secondsToOverheat()!;

    let elapsed = 0;
    while (!d.failures.has('overheated') && elapsed < 600) {
      d.update(1 / 120, { rpmFraction: 0.62, speed: 26 });
      elapsed += 1 / 120;
    }
    expect(elapsed).toBeCloseTo(predicted, 0);
  });

  it('never predicts an overheat the car cannot actually reach', () => {
    expect(new DamageModel().secondsToOverheat()).toBeNull();
  });

  it('warns loudest about what stops the car starting', () => {
    const d = new DamageModel();
    d.health.set('engine', 0);
    d.refreshFailures();
    expect(d.warnings()[0]!.severity).toBe('fatal');
  });

  it('predicts fuel range, and shortens it when the line is holed', () => {
    const healthy = new DamageModel().secondsToEmpty()!;
    const leaking = new DamageModel();
    leaking.health.set('fuelLine', 0);
    expect(leaking.secondsToEmpty()!).toBeLessThan(healthy);
    expect(leaking.warnings().some((w) => w.text.includes('Fuel line'))).toBe(true);
  });
});

describe('warning accuracy', () => {
  it('does not claim a cosmetic failure stops the car', () => {
    const d = new DamageModel();
    d.health.set('lights', 0);
    d.health.set('panelFront', 0);
    d.refreshFailures();

    // Destroyed headlights are not a reason the car cannot start, and saying so
    // trains the player to ignore the warnings that matter.
    expect(d.retired).toBe(false);
    expect(d.warnings().some((w) => w.severity === 'fatal')).toBe(false);
  });

  it('does claim a real failure stops the car', () => {
    const d = new DamageModel();
    d.health.set('hubRL', 0);
    d.refreshFailures();
    expect(d.retired).toBe(true);
    const fatal = d.warnings().filter((w) => w.severity === 'fatal');
    expect(fatal).toHaveLength(1);
    expect(fatal[0]!.text).toContain('rear left wheel');
  });
});

describe('tyre wear', () => {
  const wheel = (saturation: number, abrasion = 1, load = 2900) => ({
    saturation,
    load,
    surface: { abrasion },
  });
  const four = (w: ReturnType<typeof wheel>) => [w, w, w, w];

  const wearFor = (
    wheels: ReturnType<typeof four>,
    seconds = 10,
    rate = 0.012,
  ): number => {
    const d = new DamageModel();
    for (let i = 0; i < seconds * 120; i++) d.wearTyres(1 / 120, wheels, rate);
    return 1 - d.get('tyreFL');
  };

  it('does not wear a tyre that is gripping', () => {
    expect(wearFor(four(wheel(0.5)))).toBe(0);
    expect(wearFor(four(wheel(0.89)))).toBe(0);
  });

  it('wears faster the harder the tyre is sliding', () => {
    expect(wearFor(four(wheel(1.4)))).toBeGreaterThan(wearFor(four(wheel(1.0))));
  });

  it('wears faster under load, so the loaded outside tyre goes first', () => {
    expect(wearFor(four(wheel(1.3, 1, 5000)))).toBeGreaterThan(wearFor(four(wheel(1.3, 1, 1500))));
  });

  it('wears most on gravel and barely at all on ice', () => {
    const gravel = wearFor(four(wheel(1.3, SURFACES.gravel.abrasion)));
    const tarmac = wearFor(four(wheel(1.3, SURFACES.tarmac.abrasion)));
    const ice = wearFor(four(wheel(1.3, SURFACES.ice.abrasion)));
    expect(gravel).toBeGreaterThan(tarmac);
    expect(tarmac).toBeGreaterThan(ice);
    expect(ice).toBeLessThan(gravel * 0.2);
  });

  it('wears each corner independently', () => {
    const d = new DamageModel();
    const wheels = [wheel(1.4), wheel(0.5), wheel(0.5), wheel(0.5)];
    for (let i = 0; i < 600; i++) d.wearTyres(1 / 120, wheels, 0.012);
    expect(d.get('tyreFL')).toBeLessThan(1);
    expect(d.get('tyreFR')).toBe(1);
  });

  it('wears a soft compound faster, which is the trade for the grip', () => {
    expect(wearFor(four(wheel(1.3)), 10, 0.012 * 2.05)).toBeGreaterThan(
      wearFor(four(wheel(1.3)), 10, 0.012),
    );
  });

  it('stops at a puncture rather than going negative, and announces it', () => {
    const d = new DamageModel();
    const wheels = four(wheel(1.5, 2));
    for (let i = 0; i < 120 * 400; i++) d.wearTyres(1 / 120, wheels, 0.02);
    expect(d.get('tyreFL')).toBe(0);

    const events = d.drainEvents();
    expect(events.some((e) => e.component === 'tyreFL' && e.remaining === 0)).toBe(true);
    // And it is only announced once, however long the wheel keeps spinning.
    for (let i = 0; i < 1200; i++) d.wearTyres(1 / 120, wheels, 0.02);
    expect(d.drainEvents()).toEqual([]);
  });

  it('costs a few percent over a careful lap, not a whole tyre', () => {
    // Roughly a 45-second stage spent mostly gripping, occasionally sliding.
    const worn = wearFor(four(wheel(1.05, SURFACES.gravel.abrasion)), 45);
    expect(worn).toBeGreaterThan(0.01);
    expect(worn).toBeLessThan(0.2);
  });
});
