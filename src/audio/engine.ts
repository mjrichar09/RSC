/**
 * Engine sound, synthesised rather than sampled.
 *
 * A four-stroke four-cylinder fires twice per revolution, so the fundamental is
 * rpm/30 Hz — about 33 Hz at idle and 253 Hz at the limiter. Everything else is
 * built on that: a sawtooth for the body, an octave up for the bark, an octave
 * down for the rumble, and a noise layer for induction. A low-pass that opens
 * with throttle is what makes the difference between on and off power audible,
 * which is the single most useful thing engine audio can tell a driver.
 *
 * Synthesis rather than samples because it tracks rpm continuously with no
 * crossfade seams, costs nothing to ship, and responds instantly to a misfire
 * or a blown engine.
 */

/** Firing events per second per rpm, for a four-stroke four-cylinder. */
const FIRINGS_PER_RPM = 1 / 30;

interface Layer {
  osc: OscillatorNode;
  gain: GainNode;
  ratio: number;
  /** Level on a trailing throttle, and level under full load. */
  offLoad: number;
  onLoad: number;
}

/** Everything the voice needs to know about the engine this frame. */
export interface EngineInput {
  rpm: number;
  maxRpm: number;
  throttle: number;
  /** Torque delivered as a fraction of what these revs allow; negative on the overrun. */
  load: number;
  /** Engine condition, 0..1 — a sick engine sounds sick. */
  health: number;
  /** Turbo condition, 0..1. A dead turbo makes no boost and no noise. */
  turboHealth: number;
  misfiring: boolean;
  /** True while the gearbox is between gears, so the note has to break. */
  shifting: boolean;
}

export class EngineVoice {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private readonly filter: BiquadFilterNode;
  private readonly layers: Layer[] = [];
  private readonly induction: GainNode;
  private readonly destination: AudioNode;
  /** Turbo whistle, and the boost it tracks. */
  private readonly whistle: OscillatorNode;
  private readonly whistleGain: GainNode;
  private boost = 0;
  private lastThrottle = 0;
  /** Seconds until the next overrun pop is allowed. */
  private popCooldown = 0;
  private started = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;

    this.out = ctx.createGain();
    this.out.gain.value = 0;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 1.4;
    this.filter.frequency.value = 400;
    this.filter.connect(this.out);
    this.out.connect(destination);

    // Octave down for weight, fundamental for body, octaves up for bark. The
    // *mix* moves with load, not just the volume: an engine under load grows
    // its upper harmonics and gets harsh, and the same engine on a trailing
    // throttle is mostly fundamental and rumble. Holding the mix fixed and
    // only changing the level is what makes synthesised engines sound like a
    // tone control rather than an engine.
    for (const [ratio, offLoad, onLoad, type] of [
      [0.5, 0.62, 0.42, 'sawtooth'],
      [1, 0.85, 1.0, 'sawtooth'],
      [2, 0.12, 0.44, 'square'],
      [3, 0.04, 0.22, 'sawtooth'],
      [4.5, 0.02, 0.12, 'square'],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      const gain = ctx.createGain();
      gain.gain.value = offLoad;
      osc.connect(gain).connect(this.filter);
      this.layers.push({ osc, gain, ratio, offLoad, onLoad });
    }

    // Induction roar: filtered noise that swells with load.
    const noise = ctx.createBufferSource();
    noise.buffer = whiteNoise(ctx, 2);
    noise.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900;
    band.Q.value = 0.7;
    this.induction = ctx.createGain();
    this.induction.gain.value = 0;
    noise.connect(band).connect(this.induction).connect(this.filter);
    noise.start();

    // Turbo. A rally car's whistle is half its character, and it is tied to a
    // component that already exists: a destroyed turbo makes no boost and no
    // noise, which is a thing you hear before you see it in the repair bill.
    this.whistle = ctx.createOscillator();
    this.whistle.type = 'triangle';
    this.whistle.frequency.value = 1200;
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    // Straight to the output rather than through the engine's low-pass: a
    // whistle that gets filtered off the moment you lift is not a whistle.
    this.whistle.connect(this.whistleGain).connect(this.out);
    this.destination = destination;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const layer of this.layers) layer.osc.start();
    this.whistle.start();
  }

  /**
   * Advance the voice. `dt` is the frame time, which the boost and overrun
   * behaviour need — both are time-dependent rather than instantaneous.
   */
  update(input: EngineInput, dt: number): void {
    const now = this.ctx.currentTime;
    const smooth = 0.04;
    const fundamental = Math.max(input.rpm * FIRINGS_PER_RPM, 20);
    const revs = Math.min(input.rpm / input.maxRpm, 1);
    // 0 on a trailing throttle, 1 at full load. The sound follows this rather
    // than the pedal, so labouring in too high a gear sounds like labouring.
    const load = Math.max(input.load, 0);
    // The overrun side is small in absolute terms — engine braking is a
    // fraction of what an engine can push, and the idle torque floor offsets
    // most of it — so a lift at revs measures about -0.3. Scaled here so that
    // is a full crackle rather than a rounding error.
    const overrun = Math.min(Math.max(-input.load, 0) / 0.3, 1);

    for (const layer of this.layers) {
      layer.osc.frequency.setTargetAtTime(fundamental * layer.ratio, now, smooth);
      const level = layer.offLoad + (layer.onLoad - layer.offLoad) * load;
      layer.gain.gain.setTargetAtTime(level, now, 0.08);
    }

    // Opening the filter with load is what makes power audible.
    const cutoff = 240 + load * 2900 + revs * 2400 + (1 - input.health) * 400;
    this.filter.frequency.setTargetAtTime(cutoff, now, smooth);
    this.induction.gain.setTargetAtTime(0.04 + load * 0.2 * revs, now, smooth);

    this.updateTurbo(input, dt, revs, now);
    this.updateOverrun(input, dt, revs, overrun, now);

    // A misfire is a momentary cut, and so is a gearshift — the note has to
    // break, or shifts are invisible to the ear and the car sounds like a
    // single-speed.
    // A stalled engine is silent, and that silence is information: the moment
    // the note stops is the moment the player knows they are coasting.
    const dead = input.rpm <= 1;
    const cut = input.misfiring || input.shifting;
    const level = dead ? 0 : cut ? 0.02 : 0.05 + load * 0.09 + revs * 0.05;
    this.out.gain.setTargetAtTime(
      level * (0.55 + 0.45 * input.health),
      now,
      cut ? 0.006 : smooth,
    );
    this.lastThrottle = input.throttle;
  }

  /**
   * Boost: slow to build, quick to go. The whistle rises with it, and a lift
   * while it is up dumps through the valve.
   */
  private updateTurbo(input: EngineInput, dt: number, revs: number, now: number): void {
    const wanted = revs * Math.max(input.throttle, 0) * input.turboHealth;
    // Spool is deliberately much slower than the decay: waiting for boost is
    // the feeling, and losing it the instant you lift is the other half.
    const rate = wanted > this.boost ? 1.8 : 6;
    this.boost += (wanted - this.boost) * Math.min(rate * dt, 1);

    this.whistle.frequency.setTargetAtTime(1300 + this.boost * 3400 + revs * 900, now, 0.06);
    this.whistleGain.gain.setTargetAtTime(this.boost * this.boost * 0.05, now, 0.06);

    // Dump valve: a sharp lift with boost up. The chirp is the sound of a
    // rally car being driven properly, and it costs one noise burst.
    const lifted = this.lastThrottle - input.throttle;
    if (lifted > 0.35 && this.boost > 0.35) this.dumpValve(this.boost);
  }

  /**
   * Overrun: pops and crackles on a trailing throttle at revs.
   *
   * Randomised in time on purpose — evenly spaced pops read as a machine gun
   * rather than an exhaust. This is presentation, so an unseeded stream is
   * fine; nothing here can reach the simulation.
   */
  private updateOverrun(
    input: EngineInput,
    dt: number,
    revs: number,
    overrun: number,
    now: number,
  ): void {
    this.popCooldown -= dt;
    if (overrun < 0.25 || revs < 0.35 || input.misfiring) return;
    if (this.popCooldown > 0) return;

    const intensity = overrun * revs * input.health;
    if (Math.random() > intensity * 0.85) return;

    this.popCooldown = 0.05 + Math.random() * 0.12;
    const ctx = this.ctx;
    const burst = ctx.createBufferSource();
    burst.buffer = whiteNoise(ctx, 0.12);
    const shape = ctx.createBiquadFilter();
    shape.type = 'bandpass';
    shape.frequency.value = 320 + Math.random() * 500;
    shape.Q.value = 1.2;
    const gain = ctx.createGain();
    const peak = 0.05 + intensity * 0.09;
    gain.gain.setValueAtTime(peak, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    burst.connect(shape).connect(gain).connect(this.destination);
    burst.start(now);
    burst.stop(now + 0.12);
  }

  /** The chirp of a dump valve, once per lift. */
  private dumpValve(strength: number): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.boost = 0;

    const air = ctx.createBufferSource();
    air.buffer = whiteNoise(ctx, 0.25);
    const shape = ctx.createBiquadFilter();
    shape.type = 'bandpass';
    shape.frequency.setValueAtTime(2600, now);
    shape.frequency.exponentialRampToValueAtTime(1400, now + 0.18);
    shape.Q.value = 2.2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.05 * strength, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    air.connect(shape).connect(gain).connect(this.destination);
    air.start(now);
    air.stop(now + 0.25);
  }

  silence(): void {
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
  }
}

/** A looping buffer of white noise, used by several voices. */
export function whiteNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
