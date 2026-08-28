/**
 * Audio mixer.
 *
 * Owns the AudioContext and every voice. Browsers will not start audio without
 * a user gesture, so the whole graph is built lazily on the first key press and
 * the game is silent but perfectly playable until then.
 */

import type { SurfaceId } from '../sim/surfaces.js';
import type { VehicleState } from '../sim/vehicle.js';
import { EngineVoice, whiteNoise } from './engine.js';

/** Per-surface tyre character: how bright the roll is and how loud it gets. */
const SURFACE_VOICE: Record<SurfaceId, { frequency: number; q: number; gain: number }> = {
  tarmac: { frequency: 1800, q: 1.2, gain: 0.55 },
  gravel: { frequency: 1100, q: 0.5, gain: 1.0 },
  dirt: { frequency: 850, q: 0.5, gain: 0.95 },
  mud: { frequency: 600, q: 0.6, gain: 0.85 },
  snow: { frequency: 700, q: 0.8, gain: 0.6 },
  ice: { frequency: 2600, q: 2.0, gain: 0.35 },
  grass: { frequency: 950, q: 0.6, gain: 0.8 },
};

export class Mixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engine: EngineVoice | null = null;

  private rollFilter: BiquadFilterNode | null = null;
  private rollGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private skidFilter: BiquadFilterNode | null = null;
  private skidGain: GainNode | null = null;

  private muted = false;

  /** True once audio is actually running. */
  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * Build the graph. Must be called from a user gesture, and is safe to call
   * repeatedly — later calls just resume a suspended context.
   */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;

    // A gentle limiter keeps a big impact from clipping the whole mix.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    this.master.connect(limiter).connect(ctx.destination);

    this.engine = new EngineVoice(ctx, this.master);
    this.engine.start();

    // Tyre roll: broadband noise shaped per surface.
    const rollSource = ctx.createBufferSource();
    rollSource.buffer = whiteNoise(ctx, 2);
    rollSource.loop = true;
    this.rollFilter = ctx.createBiquadFilter();
    this.rollFilter.type = 'bandpass';
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    rollSource.connect(this.rollFilter).connect(this.rollGain).connect(this.master);
    rollSource.start();

    // Wind rush: a low-passed roar that only depends on speed.
    const windSource = ctx.createBufferSource();
    windSource.buffer = whiteNoise(ctx, 2);
    windSource.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSource.connect(this.windFilter).connect(this.windGain).connect(this.master);
    windSource.start();

    // Skid: a narrower, higher band that only appears past the grip limit.
    const skidSource = ctx.createBufferSource();
    skidSource.buffer = whiteNoise(ctx, 2);
    skidSource.loop = true;
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 2400;
    this.skidFilter.Q.value = 5;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    skidSource.connect(this.skidFilter).connect(this.skidGain).connect(this.master);
    skidSource.start();

    void ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Drive every continuous voice from the current vehicle state. */
  update(
    state: VehicleState,
    options: {
      maxRpm: number;
      throttle: number;
      engineHealth: number;
      turboHealth: number;
      misfiring: boolean;
      /** Frame time, for the boost and overrun behaviour. */
      dt: number;
    },
  ): void {
    if (!this.ctx || !this.engine || !this.rollGain || !this.rollFilter) return;

    const now = this.ctx.currentTime;
    this.engine.update(
      {
        rpm: state.rpm,
        maxRpm: options.maxRpm,
        throttle: options.throttle,
        load: state.engineLoad,
        health: options.engineHealth,
        turboHealth: options.turboHealth,
        misfiring: options.misfiring,
        shifting: state.shifting,
      },
      options.dt,
    );

    const speed = Math.abs(state.speed);
    const grounded = state.wheels.filter((w) => w.grounded);
    const surface = grounded[0]?.surface.id ?? 'tarmac';
    const voice = SURFACE_VOICE[surface];

    // Roll noise rises with speed and disappears entirely in the air, which is
    // the clearest possible cue that the car has left the ground.
    const airborne = grounded.length === 0;
    const rollLevel = airborne ? 0 : Math.min(speed / 34, 1) * 0.13 * voice.gain;
    this.rollFilter.frequency.setTargetAtTime(voice.frequency * (0.7 + speed / 90), now, 0.06);
    this.rollFilter.Q.setTargetAtTime(voice.q, now, 0.1);
    this.rollGain.gain.setTargetAtTime(rollLevel, now, 0.06);

    // Wind. Separate from tyre roll because it does not care what the surface
    // is and does not stop when the car leaves the ground — in the air it is
    // the *only* thing you hear, which is what makes a jump feel long.
    if (this.windGain && this.windFilter) {
      const wind = Math.min(speed / 46, 1);
      this.windGain.gain.setTargetAtTime(wind * wind * 0.075, now, 0.12);
      this.windFilter.frequency.setTargetAtTime(420 + speed * 26, now, 0.12);
    }

    // Skid is driven by how far past the grip limit the worst tyre is.
    const slip = Math.max(0, Math.max(...state.wheels.map((w) => w.saturation)) - 1);
    const skidLevel = airborne ? 0 : Math.min(slip * 1.4, 1) * 0.1 * Math.min(speed / 12, 1);
    this.skidGain?.gain.setTargetAtTime(skidLevel, now, 0.05);
    this.skidFilter?.frequency.setTargetAtTime(1700 + slip * 900, now, 0.08);
  }

  /**
   * A one-shot impact: a low thud for mass and a noise burst for the crunch,
   * both scaled by how hard the hit was.
   */
  impact(severity: number): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const strength = Math.min(Math.max(severity, 0), 1);
    if (strength < 0.02) return;

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(90 + strength * 60, now);
    thump.frequency.exponentialRampToValueAtTime(38, now + 0.22);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.28 * strength, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    thump.connect(thumpGain).connect(this.master);
    thump.start(now);
    thump.stop(now + 0.3);

    const crunch = ctx.createBufferSource();
    crunch.buffer = whiteNoise(ctx, 0.3);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(1500 + strength * 1400, now);
    band.frequency.exponentialRampToValueAtTime(500, now + 0.18);
    band.Q.value = 1.1;
    const crunchGain = ctx.createGain();
    crunchGain.gain.setValueAtTime(0.3 * strength, now);
    crunchGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    crunch.connect(band).connect(crunchGain).connect(this.master);
    crunch.start(now);
    crunch.stop(now + 0.25);
  }

  /** Silence everything continuous — used when a menu opens or a run ends. */
  quiet(): void {
    this.engine?.silence();
    if (!this.ctx) return;
    this.rollGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    this.skidGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }
}
