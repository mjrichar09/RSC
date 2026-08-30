/**
 * Telemetry recording and summarisation.
 *
 * This is the cheap half of verification: almost every question about handling,
 * and later about damage and payouts, is answerable from these numbers without
 * rendering a single pixel.
 */

import { SIM } from '../data/tuning.js';
import { length } from './math.js';
import type { VehicleState } from './vehicle.js';
import type { SimWorld } from './world.js';

/** Mean absolute slip angle of the axle starting at wheel index `i0`, degrees. */
function axleSlip(s: VehicleState, i0: number): number {
  const a = Math.abs(s.wheels[i0]!.slipAngle);
  const b = Math.abs(s.wheels[i0 + 1]!.slipAngle);
  return (((a + b) / 2) * 180) / Math.PI;
}

/** Sideways enough to be a drift rather than a line. Degrees. */
const DRIFT_FLOOR = 12;
/** Past this the car is not drifting, it is spinning. Degrees. */
const SPIN_ANGLE = 55;

export interface TelemetrySample {
  t: number;
  x: number;
  z: number;
  y: number;
  /** m/s along the car's nose. */
  speed: number;
  rpm: number;
  gear: number;
  /** Degrees between the nose and the direction of travel. */
  drift: number;
  /** Max tire saturation across the four wheels. */
  saturation: number;
  /** Yaw rate, deg/s. Signed: positive turns right. */
  yawRate: number;
  /** Mean front-axle slip angle, degrees. */
  frontSlip: number;
  /** Mean rear-axle slip angle, degrees. */
  rearSlip: number;
  /**
   * Instantaneous turn radius in metres (speed / yaw rate), capped at 999 when
   * travelling straight. The headline number for understeer/oversteer balance.
   */
  turnRadius: number;
  wheelsGrounded: number;
  /** Hottest brake disc this sample, °C. Null without a damage model. */
  brakeC: number | null;
}

export interface TelemetrySummary {
  duration: number;
  steps: number;
  distance: number;
  topSpeedKph: number;
  avgSpeedKph: number;
  /** Seconds from 0 to 100 km/h, or null if never reached. */
  zeroToHundred: number | null;
  maxDriftDeg: number;
  /**
   * The longest unbroken stretch held sideways, seconds.
   *
   * Between `DRIFT_FLOOR` and `SPIN_ANGLE` degrees, above walking pace, with
   * the car still going roughly where it is pointed. This is the number that
   * says whether a slide is a *drift* or an accident: `maxDriftDeg` counts a
   * spin as a triumph, and `timeSliding` counts a tyre being over its peak for
   * a tenth of a second on the way into a corner.
   */
  longestDrift: number;
  /** Peak drift angle reached during that stretch, degrees. */
  heldDriftDeg: number;
  /**
   * How many separate stretches were held.
   *
   * Chaining is the thing: one long drift and two drifts with a transition
   * between them are very different cars, and only this tells them apart.
   */
  driftRuns: number;
  /** Seconds spent with any tire past its grip peak. */
  timeSliding: number;
  /**
   * Seconds genuinely in flight.
   *
   * Requires the car to still be travelling, not merely to have no wheel
   * touching: a car beached across a verge with all four wheels dangling
   * satisfies the naive test indefinitely, and counting that as airtime made a
   * 45-second beaching read as a 45-second jump.
   */
  timeAirborne: number;
  /** Hottest brake disc reached, °C, or null when the run had no damage model. */
  peakBrakeC: number | null;
  /** Coolest the hottest disc got back to after that peak, °C. */
  finalBrakeC: number | null;
  finalPosition: { x: number; y: number; z: number };
}

export class TelemetryRecorder {
  readonly samples: TelemetrySample[] = [];
  private readonly interval = 1 / SIM.recordHz;
  private nextSampleAt = 0;

  /** Call once per fixed step. Samples are decimated to `SIM.recordHz`. */
  capture(world: SimWorld): void {
    if (world.time < this.nextSampleAt) return;
    this.nextSampleAt = world.time + this.interval;

    const s = world.state();
    this.samples.push({
      t: world.time,
      x: s.position.x,
      y: s.position.y,
      z: s.position.z,
      speed: s.speed,
      rpm: s.rpm,
      gear: s.gear,
      drift: (s.driftAngle * 180) / Math.PI,
      saturation: Math.max(...s.wheels.map((w) => w.saturation)),
      yawRate: (s.yawRate * 180) / Math.PI,
      frontSlip: axleSlip(s, 0),
      rearSlip: axleSlip(s, 2),
      turnRadius:
        Math.abs(s.yawRate) > 0.02 ? Math.min(Math.abs(s.speed / s.yawRate), 999) : 999,
      wheelsGrounded: s.wheels.filter((w) => w.grounded).length,
      brakeC: world.damage ? Math.max(...world.damage.brakeTemp) : null,
    });
  }

  summarise(steps: number): TelemetrySummary {
    const n = this.samples.length;
    if (n === 0) {
      return {
        duration: 0,
        steps,
        distance: 0,
        topSpeedKph: 0,
        avgSpeedKph: 0,
        zeroToHundred: null,
        maxDriftDeg: 0,
        longestDrift: 0,
        heldDriftDeg: 0,
        driftRuns: 0,
        timeSliding: 0,
        timeAirborne: 0,
        peakBrakeC: null,
        finalBrakeC: null,
        finalPosition: { x: 0, y: 0, z: 0 },
      };
    }

    let distance = 0;
    let sliding = 0;
    let airborne = 0;
    let top = 0;
    let maxDrift = 0;
    let zeroToHundred: number | null = null;
    let driftRun = 0;
    let driftPeak = 0;
    let longestDrift = 0;
    let heldDrift = 0;
    let driftRuns = 0;

    for (let i = 0; i < n; i++) {
      const s = this.samples[i]!;
      const prev = i > 0 ? this.samples[i - 1]! : null;
      if (prev) {
        const dt = s.t - prev.t;
        distance += length({ x: s.x - prev.x, y: s.y - prev.y, z: s.z - prev.z });
        if (s.saturation > 1) sliding += dt;
        if (s.wheelsGrounded === 0 && Math.abs(s.speed) > 6) airborne += dt;
      }
      const kph = Math.abs(s.speed) * 3.6;
      if (kph > top) top = kph;
      if (zeroToHundred === null && kph >= 100) zeroToHundred = s.t;
      if (s.drift > maxDrift) maxDrift = s.drift;

      // Held sideways, rather than merely sideways. A spin passes through every
      // angle on its way round, so the upper bound is what separates a drift
      // from losing it, and the run has to be unbroken to count.
      const held = s.drift >= DRIFT_FLOOR && s.drift <= SPIN_ANGLE && Math.abs(s.speed) > 4;
      if (held && prev) {
        // A stretch counts once it has lasted long enough to have been meant.
        if (driftRun <= 0.4 && driftRun + (s.t - prev.t) > 0.4) driftRuns++;
        driftRun += s.t - prev.t;
        driftPeak = Math.max(driftPeak, s.drift);
        if (driftRun > longestDrift) {
          longestDrift = driftRun;
          heldDrift = driftPeak;
        }
      } else if (!held) {
        driftRun = 0;
        driftPeak = 0;
      }
    }

    const last = this.samples[n - 1]!;
    return {
      duration: last.t,
      steps,
      distance,
      topSpeedKph: top,
      avgSpeedKph: last.t > 0 ? (distance / last.t) * 3.6 : 0,
      zeroToHundred,
      maxDriftDeg: maxDrift,
      longestDrift,
      heldDriftDeg: heldDrift,
      driftRuns,
      timeSliding: sliding,
      timeAirborne: airborne,
      peakBrakeC: this.samples.some((s) => s.brakeC !== null)
        ? Math.max(...this.samples.map((s) => s.brakeC ?? 0))
        : null,
      finalBrakeC: last.brakeC,
      finalPosition: { x: last.x, y: last.y, z: last.z },
    };
  }

  toCsv(): string {
    const header = 't,x,y,z,speed,rpm,gear,drift,saturation,yawRate,turnRadius,grounded,brakeC';
    const rows = this.samples.map((s) =>
      [
        s.t.toFixed(4),
        s.x.toFixed(3),
        s.y.toFixed(3),
        s.z.toFixed(3),
        s.speed.toFixed(3),
        s.rpm.toFixed(0),
        s.gear,
        s.drift.toFixed(2),
        s.saturation.toFixed(3),
        s.yawRate.toFixed(2),
        s.turnRadius.toFixed(1),
        s.wheelsGrounded,
        s.brakeC === null ? '' : s.brakeC.toFixed(1),
      ].join(','),
    );
    return [header, ...rows].join('\n');
  }
}

export function formatSummary(name: string, s: TelemetrySummary): string {
  const row = (k: string, v: string) => `  ${k.padEnd(18)} ${v}`;
  return [
    `[${name}]`,
    row('duration', `${s.duration.toFixed(2)} s (${s.steps} steps)`),
    row('distance', `${s.distance.toFixed(1)} m`),
    row('top speed', `${s.topSpeedKph.toFixed(1)} km/h`),
    row('avg speed', `${s.avgSpeedKph.toFixed(1)} km/h`),
    row('0-100 km/h', s.zeroToHundred === null ? 'not reached' : `${s.zeroToHundred.toFixed(2)} s`),
    row('max drift', `${s.maxDriftDeg.toFixed(1)}°`),
    row(
      'held drift',
      `${s.longestDrift.toFixed(2)} s at up to ${s.heldDriftDeg.toFixed(0)}°, ${s.driftRuns} run${
        s.driftRuns === 1 ? '' : 's'
      }`,
    ),
    row('time sliding', `${s.timeSliding.toFixed(2)} s`),
    row('time airborne', `${s.timeAirborne.toFixed(2)} s`),
    ...(s.peakBrakeC === null
      ? []
      : [
          row(
            'brakes',
            `peak ${s.peakBrakeC.toFixed(0)}°C, ended ${(s.finalBrakeC ?? 0).toFixed(0)}°C`,
          ),
        ]),
    row(
      'final pos',
      `(${s.finalPosition.x.toFixed(1)}, ${s.finalPosition.y.toFixed(1)}, ${s.finalPosition.z.toFixed(1)})`,
    ),
  ].join('\n');
}
