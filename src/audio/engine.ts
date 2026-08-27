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
}

export class EngineVoice {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private readonly filter: BiquadFilterNode;
  private readonly layers: Layer[] = [];
  private readonly induction: GainNode;
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

    // Octave down for weight, fundamental for body, octave up for bark.
    for (const [ratio, level, type] of [
      [0.5, 0.5, 'sawtooth'],
      [1, 1, 'sawtooth'],
      [2, 0.32, 'square'],
      [3, 0.14, 'sawtooth'],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      const gain = ctx.createGain();
      gain.gain.value = level;
      osc.connect(gain).connect(this.filter);
      this.layers.push({ osc, gain, ratio });
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
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const layer of this.layers) layer.osc.start();
  }

  /**
   * @param rpm       engine speed
   * @param maxRpm    redline, for normalising
   * @param throttle  0..1
   * @param health    engine condition, 0..1 — a sick engine sounds sick
   * @param misfiring whether the engine is cutting out this instant
   */
  update(rpm: number, maxRpm: number, throttle: number, health: number, misfiring: boolean): void {
    const now = this.ctx.currentTime;
    const smooth = 0.04;
    const fundamental = Math.max(rpm * FIRINGS_PER_RPM, 20);
    const load = Math.min(rpm / maxRpm, 1);

    for (const layer of this.layers) {
      layer.osc.frequency.setTargetAtTime(fundamental * layer.ratio, now, smooth);
    }

    // Opening the filter with throttle is what makes power audible.
    const cutoff = 260 + throttle * 2600 + load * 2300 + (1 - health) * 400;
    this.filter.frequency.setTargetAtTime(cutoff, now, smooth);

    this.induction.gain.setTargetAtTime(0.05 + throttle * 0.16 * load, now, smooth);

    // A misfire is a momentary cut, which is exactly how it should sound.
    const level = misfiring ? 0.02 : 0.055 + throttle * 0.075 + load * 0.05;
    this.out.gain.setTargetAtTime(level * (0.55 + 0.45 * health), now, misfiring ? 0.005 : smooth);
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
