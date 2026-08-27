/**
 * Telemetry recording and summarisation.
 *
 * This is the cheap half of verification: almost every question about handling,
 * and later about damage and payouts, is answerable from these numbers without
 * rendering a single pixel.
 */

import { SIM } from '../data/tuning.js';
import { length } from './math.js';
import type { SimWorld } from './world.js';

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
  wheelsGrounded: number;
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
  /** Seconds spent with any tire past its grip peak. */
  timeSliding: number;
  timeAirborne: number;
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
      wheelsGrounded: s.wheels.filter((w) => w.grounded).length,
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
        timeSliding: 0,
        timeAirborne: 0,
        finalPosition: { x: 0, y: 0, z: 0 },
      };
    }

    let distance = 0;
    let sliding = 0;
    let airborne = 0;
    let top = 0;
    let maxDrift = 0;
    let zeroToHundred: number | null = null;

    for (let i = 0; i < n; i++) {
      const s = this.samples[i]!;
      const prev = i > 0 ? this.samples[i - 1]! : null;
      if (prev) {
        const dt = s.t - prev.t;
        distance += length({ x: s.x - prev.x, y: s.y - prev.y, z: s.z - prev.z });
        if (s.saturation > 1) sliding += dt;
        if (s.wheelsGrounded === 0) airborne += dt;
      }
      const kph = Math.abs(s.speed) * 3.6;
      if (kph > top) top = kph;
      if (zeroToHundred === null && kph >= 100) zeroToHundred = s.t;
      if (s.drift > maxDrift) maxDrift = s.drift;
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
      timeSliding: sliding,
      timeAirborne: airborne,
      finalPosition: { x: last.x, y: last.y, z: last.z },
    };
  }

  toCsv(): string {
    const header = 't,x,y,z,speed,rpm,gear,drift,saturation,grounded';
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
        s.wheelsGrounded,
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
    row('time sliding', `${s.timeSliding.toFixed(2)} s`),
    row('time airborne', `${s.timeAirborne.toFixed(2)} s`),
    row(
      'final pos',
      `(${s.finalPosition.x.toFixed(1)}, ${s.finalPosition.y.toFixed(1)}, ${s.finalPosition.z.toFixed(1)})`,
    ),
  ].join('\n');
}
