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
import { Ambience } from './ambience.js';
import type { Conditions } from '../sim/conditions.js';

/** Per-surface tyre character: how bright the roll is and how loud it gets. */
const SURFACE_VOICE: Record<SurfaceId, { frequency: number; q: number; gain: number }> = {
  tarmac: { frequency: 1800, q: 1.2, gain: 0.55 },
  gravel: { frequency: 1100, q: 0.5, gain: 1.0 },
  dirt: { frequency: 850, q: 0.5, gain: 0.95 },
  mud: { frequency: 600, q: 0.6, gain: 0.85 },
  snow: { frequency: 700, q: 0.8, gain: 0.6 },
  ice: { frequency: 2600, q: 2.0, gain: 0.35 },
  grass: { frequency: 950, q: 0.6, gain: 0.8 },
  // A ford is the loudest thing a tyre ever drives through, and it is broadband
  // rather than pitched: a wall of water, not a texture.
  water: { frequency: 480, q: 0.35, gain: 1.4 },
};

/**
 * What a sliding tyre sounds like, by surface.
 *
 * One narrow band at 2.4 kHz used to be every skid, so a car sliding on gravel
 * squealed like one on tarmac. Only rubber on a hard surface squeals: gravel
 * and dirt scrabble, a low broad grinding of stones; snow hushes; mud squelches
 * low; a ford makes no skid sound of its own because the water drowns it.
 * `wobble` is how much the pitch wanders, which is most of what makes a squeal
 * a squeal rather than a whistle.
 */
const SKID_VOICE: Record<SurfaceId, { frequency: number; q: number; gain: number; wobble: number }> = {
  tarmac: { frequency: 1350, q: 11, gain: 1.0, wobble: 140 },
  gravel: { frequency: 620, q: 1.1, gain: 1.35, wobble: 0 },
  dirt: { frequency: 520, q: 1.0, gain: 1.2, wobble: 0 },
  mud: { frequency: 300, q: 1.4, gain: 1.0, wobble: 0 },
  snow: { frequency: 900, q: 0.7, gain: 0.7, wobble: 0 },
  ice: { frequency: 2900, q: 6, gain: 0.35, wobble: 60 },
  grass: { frequency: 480, q: 0.9, gain: 0.8, wobble: 0 },
  water: { frequency: 400, q: 0.5, gain: 0, wobble: 0 },
};

/**
 * One-shot texture, by surface: the things a tyre throws at the car.
 *
 * `rate` is events a second at 100 km/h, plus `slide` more per unit of slip;
 * each is a burst of noise `length` seconds long through a band around
 * `frequency`. Gravel pings off the underbody — short, bright, many; snow
 * crunches under the tread — fewer, lower, longer; water sloshes against the
 * sills. Tarmac and ice throw nothing.
 */
const TEXTURE: Partial<Record<SurfaceId, { rate: number; slide: number; frequency: number; spread: number; q: number; length: number; gain: number }>> = {
  gravel: { rate: 22, slide: 40, frequency: 4200, spread: 0.45, q: 3, length: 0.022, gain: 0.07 },
  dirt: { rate: 9, slide: 26, frequency: 3000, spread: 0.4, q: 2.5, length: 0.026, gain: 0.05 },
  grass: { rate: 4, slide: 10, frequency: 1800, spread: 0.3, q: 1.5, length: 0.03, gain: 0.03 },
  mud: { rate: 6, slide: 20, frequency: 380, spread: 0.3, q: 1.2, length: 0.07, gain: 0.07 },
  snow: { rate: 10, slide: 18, frequency: 760, spread: 0.35, q: 1.4, length: 0.06, gain: 0.05 },
  water: { rate: 7, slide: 0, frequency: 320, spread: 0.4, q: 0.8, length: 0.16, gain: 0.09 },
};

/**
 * Loudest the master gain goes, at a volume of 1.
 *
 * Below unity on purpose: the limiter after it has to have something to work
 * with, and a game that arrives at full scale has nowhere to put a crash.
 */
const MAX_GAIN = 0.9;
/** Where the slider starts for somebody who has never touched it. */
export const DEFAULT_VOLUME = 1;

export class Mixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /**
   * The muffle applied after a big impact: everything downstream of the mix
   * goes briefly deaf, the way it does when you have just hit something.
   * Transparent at rest, so it costs nothing when the effect is switched off.
   */
  private duckFilter: BiquadFilterNode | null = null;
  private duckGain: GainNode | null = null;
  private ducked = 0;
  private engine: EngineVoice | null = null;
  private ambience: Ambience | null = null;
  /** Where the ambience thinks it is, held until the graph exists to play it. */
  private place: { biome: string; conditions: Conditions } | null = null;

  private rollFilter: BiquadFilterNode | null = null;
  private rollGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private skidFilter: BiquadFilterNode | null = null;
  private skidGain: GainNode | null = null;
  /** A quarter-second of noise the texture one-shots are cut from. */
  private grit: AudioBuffer | null = null;
  /** Texture events owed but not yet played, carried between frames. */
  private owed = 0;
  /** The surface under most of the car last frame, to hear it change. */
  private underfoot: SurfaceId | null = null;
  private clock = 0;

  private muted = false;
  /**
   * Master volume, 0 to 1.
   *
   * Separate from the mute, and both survive each other: turning the sound down
   * to a tenth and then muting and unmuting has to come back at a tenth, not at
   * whatever the code happened to hard-code. That constant used to be written
   * out in three places, which is exactly how a setting gets lost.
   */
  private volume = DEFAULT_VOLUME;

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
    this.master.gain.value = this.level;

    // A gentle limiter keeps a big impact from clipping the whole mix.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    // master -> muffle -> limiter -> out. The impact voices go through it too,
    // and deliberately: the duck ramps in over a tenth of a second, so the
    // crunch itself lands clean and only its tail is swallowed.
    this.duckFilter = ctx.createBiquadFilter();
    this.duckFilter.type = 'lowpass';
    this.duckFilter.frequency.value = 20000;
    this.duckFilter.Q.value = 0.4;
    this.duckGain = ctx.createGain();
    this.duckGain.gain.value = 1;
    this.master.connect(this.duckFilter).connect(this.duckGain).connect(limiter).connect(ctx.destination);

    this.engine = new EngineVoice(ctx, this.master);
    this.engine.start();

    // The world under the car. Built here rather than lazily because audio can
    // only start from a gesture, and by the time one arrives the stage has
    // usually been loaded for a while — so the place is remembered and applied.
    this.ambience = new Ambience(ctx, this.master);
    if (this.place) this.ambience.setPlace(this.place.biome, this.place.conditions);

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

    this.grit = whiteNoise(ctx, 0.25);

    void ctx.resume();
  }

  /** Where the race is. Safe to call before audio has started. */
  setPlace(biome: string, conditions: Conditions): void {
    this.place = { biome, conditions };
    this.ambience?.setPlace(biome, conditions);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.applyLevel();
    return this.muted;
  }

  /**
   * Set the master volume, 0 to 1.
   *
   * Unmutes on the way, because a player who has just dragged the slider up and
   * heard nothing has been given a puzzle rather than a control.
   */
  setVolume(value: number): void {
    this.volume = Math.min(Math.max(value, 0), 1);
    if (this.volume > 0) this.muted = false;
    this.applyLevel();
  }

  get level(): number {
    return this.muted ? 0 : this.volume * MAX_GAIN;
  }

  get currentVolume(): number {
    return this.volume;
  }

  /** Ramped, never set: a gain that jumps is a click in the speakers. */
  private applyLevel(): void {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(this.level, this.ctx.currentTime, 0.05);
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
    // The world under the car, which gets quieter as the car gets louder.
    this.ambience?.update(options.dt, speed);
    const grounded = state.wheels.filter((w) => w.grounded);
    // The surface under most of the car, not under whichever wheel was first
    // in the list: with one wheel on the verge the car sounded as if it had
    // left the road.
    const count = new Map<SurfaceId, number>();
    for (const w of grounded) count.set(w.surface.id, (count.get(w.surface.id) ?? 0) + 1);
    let surface: SurfaceId = 'tarmac';
    let most = 0;
    for (const [id, n] of count) {
      if (n > most) {
        most = n;
        surface = id;
      }
    }
    const voice = SURFACE_VOICE[surface];
    // Onto a new surface: one crunch as the tyres cross the edge, at speed.
    if (grounded.length > 0 && this.underfoot && surface !== this.underfoot && speed > 6) {
      this.grain(TEXTURE[surface] ?? TEXTURE.gravel!, Math.min(speed / 25, 1.4) * 2.2, now);
    }
    if (grounded.length > 0) this.underfoot = surface;

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

    // Skid is driven by how far past the grip limit the worst tyre is, and
    // sounds like whatever that tyre is sliding on.
    const slip = Math.max(0, Math.max(...state.wheels.map((w) => w.saturation)) - 1);
    const skid = SKID_VOICE[surface];
    const skidLevel = airborne ? 0 : Math.min(slip * 1.4, 1) * 0.1 * Math.min(speed / 12, 1) * skid.gain;
    this.clock += options.dt;
    const wander = skid.wobble * (Math.sin(this.clock * 23) * 0.6 + Math.sin(this.clock * 9.7) * 0.4);
    this.skidGain?.gain.setTargetAtTime(skidLevel, now, 0.05);
    this.skidFilter?.frequency.setTargetAtTime(skid.frequency + slip * skid.frequency * 0.35 + wander, now, 0.04);
    this.skidFilter?.Q.setTargetAtTime(skid.q, now, 0.1);

    // The texture: stones, crunch and slosh, at a rate set by speed and slide.
    const texture = TEXTURE[surface];
    if (texture && !airborne && speed > 2) {
      this.owed += (texture.rate * (speed / 28) + texture.slide * Math.min(slip, 1.5)) * options.dt;
      // Never more than a handful in one frame: a stall that hands this a
      // second of owed events would fire them all at once.
      let fire = Math.min(Math.floor(this.owed), 6);
      this.owed -= Math.floor(this.owed);
      for (; fire > 0; fire--) this.grain(texture, 1, now + Math.random() * options.dt);
    } else {
      this.owed = 0;
    }
  }

  /**
   * One grain of surface texture: a short burst of noise through a band,
   * each a little different in pitch and level so a stream of them reads as
   * stones rather than as a clock ticking.
   */
  private grain(
    texture: { frequency: number; spread: number; q: number; length: number; gain: number },
    weight: number,
    at: number,
  ): void {
    if (!this.ctx || !this.master || !this.grit) return;
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this.grit;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = texture.frequency * (1 + (Math.random() - 0.5) * 2 * texture.spread);
    filter.Q.value = texture.q;
    const gain = ctx.createGain();
    const level = texture.gain * weight * (0.5 + Math.random() * 0.7);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + texture.length);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(at, Math.random() * 0.2, texture.length + 0.01);
  }

  /**
   * Muffle the mix, 0..1.
   *
   * Called every frame while an impact is being dramatised. Only touches the
   * graph when the value has actually moved: a `setTargetAtTime` sixty times a
   * second to say "still zero" is a scheduling event for nothing.
   */
  duck(amount: number): void {
    const next = Math.min(Math.max(amount, 0), 1);
    if (Math.abs(next - this.ducked) < 0.01) return;
    this.ducked = next;
    if (!this.ctx || !this.duckFilter || !this.duckGain) return;
    const now = this.ctx.currentTime;
    // Down fast, back up slowly: hearing returns over about half a second.
    const glide = next > 0.05 ? 0.05 : 0.22;
    this.duckFilter.frequency.setTargetAtTime(20000 - next * 19_400, now, glide);
    this.duckGain.gain.setTargetAtTime(1 - next * 0.45, now, glide);
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

  /**
   * A start-gantry lamp, and the green.
   *
   * Two tones from the same shape: a short dry beep for each red and a longer,
   * brighter one a fifth above for the green. The interval is the whole trick —
   * three of the same note and then a higher one is a countdown in any
   * language, and nobody has to be told which one means go.
   */
  startLight(go: boolean): void {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const base = go ? 880 : 587;
    const parts: [number, number][] = go
      ? [
          [1, 0.22],
          [1.5, 0.14],
          [2, 0.06],
        ]
      : [
          [1, 0.16],
          [2, 0.04],
        ];

    for (const [ratio, level] of parts) {
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(base * ratio, now);
      const gain = this.ctx.createGain();
      const length = go ? 0.55 : 0.16;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(level, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
      // Filtered, or a square wave at this level is a fire alarm.
      const tone = this.ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = go ? 2600 : 1600;
      osc.connect(tone).connect(gain).connect(this.master);
      osc.start(now);
      osc.stop(now + length + 0.05);
    }
  }

  /**
   * A fanfare, sized to the moment.
   *
   * A rising arpeggio rather than a jingle: it can be as long or as short as
   * the award deserves without being a different piece of music, and the last
   * note landing above the first is what makes it read as an achievement
   * rather than as a notification. Bigger awards get more notes, a wider
   * spread and a tail that rings.
   */
  fanfare(weight: number): void {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    // A major triad plus the octave, and the ninth on top for the big ones.
    const steps = [0, 4, 7, 12, 16, 19];
    const notes = Math.min(3 + weight, steps.length);
    const root = 392; // G4: high enough to cut through an engine, low enough to sit under it.

    for (let i = 0; i < notes; i++) {
      const at = now + i * (weight >= 3 ? 0.085 : 0.1);
      const freq = root * Math.pow(2, steps[i]! / 12);
      const ring = i === notes - 1 ? 1.1 + weight * 0.35 : 0.28;

      for (const [ratio, level] of [
        [1, 0.15],
        [2, 0.05],
        [3, 0.02],
      ] as [number, number][]) {
        const osc = this.ctx.createOscillator();
        osc.type = i === notes - 1 ? 'triangle' : 'square';
        osc.frequency.setValueAtTime(freq * ratio, at);
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(level * (0.7 + weight * 0.12), at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + ring);
        const tone = this.ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = 3200;
        osc.connect(tone).connect(gain).connect(this.master);
        osc.start(at);
        osc.stop(at + ring + 0.05);
      }
    }
  }

  /**
   * Silence the car — used when a menu opens or a run ends.
   *
   * The world keeps going, quietly. A menu that kills the wind as well as the
   * engine reads as the game being switched off; a menu with the stage still
   * breathing behind it reads as a pause.
   */
  quiet(): void {
    this.engine?.silence();
    // Forget the road, so coming back from a menu is not a crunch.
    this.owed = 0;
    this.underfoot = null;
    if (!this.ctx) return;
    this.rollGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    this.skidGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    this.ambience?.update(1 / 60, 0, 0.35);
  }
}
