/**
 * The sound of the place the road goes through.
 *
 * The car is fully voiced and the world it drives through is silent, which is
 * why every stage sounds like the same stage. This is the cheapest identity
 * available: a forest has birds and almost no wind, a moor is nothing but wind,
 * a coast has surf under everything, and snow is the quietest thing there is —
 * an absence you can hear, and the reason a winter stage feels different before
 * you have touched the throttle.
 *
 * Synthesised, like the engine, for the same reasons: no files to ship, no
 * loop seams, and every parameter continuous, so the wind can rise with the
 * weather instead of crossfading between two recordings of it.
 *
 * Ambience is drawn from `Math.random` on purpose. It is not simulation — it
 * never touches the car and never decides anything — and a birdcall that
 * arrives at exactly the same instant on every replay of a stage would draw
 * attention to itself in a way a real one never does.
 */

import type { Conditions } from '../sim/conditions.js';
import { whiteNoise } from './engine.js';

/** What each biome sounds like when nothing is happening. */
interface Place {
  /** Steady wind level, 0..1, and how bright it is. */
  wind: number;
  windCutoff: number;
  /** Surf: level, and seconds per swell. Zero for anywhere inland. */
  surf: number;
  surfPeriod: number;
  /** Birds per minute in daylight, and how high they sit. */
  birds: number;
  birdPitch: number;
  /** Insects and general daytime hum — a warm, dry stage has one. */
  chorus: number;
}

const PLACES: Record<string, Place> = {
  forest: { wind: 0.1, windCutoff: 340, surf: 0, surfPeriod: 0, birds: 26, birdPitch: 3200, chorus: 0.05 },
  // Open, hard and dry: wind with nothing to break it, and nothing living.
  quarry: { wind: 0.2, windCutoff: 620, surf: 0, surfPeriod: 0, birds: 3, birdPitch: 2400, chorus: 0.03 },
  // The quietest place in the game, and deliberately so.
  winter: { wind: 0.12, windCutoff: 900, surf: 0, surfPeriod: 0, birds: 0, birdPitch: 0, chorus: 0 },
  moor: { wind: 0.34, windCutoff: 420, surf: 0, surfPeriod: 0, birds: 6, birdPitch: 2100, chorus: 0.02 },
  coast: { wind: 0.26, windCutoff: 520, surf: 0.16, surfPeriod: 7.5, birds: 12, birdPitch: 1800, chorus: 0.02 },
  // Between buildings: little wind, and the birds are town birds — lower and
  // fewer than a forest's, but never silent the way the mountain is.
  town: { wind: 0.08, windCutoff: 700, surf: 0, surfPeriod: 0, birds: 10, birdPitch: 1500, chorus: 0.04 },
  // Thin air over a pass: wind with nothing to break it and nothing living.
  alpine: { wind: 0.38, windCutoff: 780, surf: 0, surfPeriod: 0, birds: 2, birdPitch: 2600, chorus: 0.01 },
};

/** Weather multiplies the wind and adds its own noise on top. */
const WEATHER_WIND: Record<string, number> = {
  clear: 1,
  overcast: 1.25,
  rain: 1.5,
  fog: 0.6,
  snowfall: 1.3,
};

export class Ambience {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;

  private readonly windGain: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly surfGain: GainNode;
  private readonly surfFilter: BiquadFilterNode;
  private readonly rainGain: GainNode;
  private readonly rainFilter: BiquadFilterNode;

  private place: Place = PLACES.forest!;
  private conditions: Conditions = { timeOfDay: 'day', weather: 'clear' };
  private surfPhase = 0;
  private untilBird = 3;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(destination);

    const noise = () => {
      const source = ctx.createBufferSource();
      source.buffer = whiteNoise(ctx, 3);
      source.loop = true;
      source.start();
      return source;
    };

    // Wind: a low roar that is always there and always moving.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.Q.value = 0.5;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noise().connect(this.windFilter).connect(this.windGain).connect(this.out);

    // Surf: the same noise, much lower and swelling slowly.
    this.surfFilter = ctx.createBiquadFilter();
    this.surfFilter.type = 'lowpass';
    this.surfFilter.frequency.value = 260;
    this.surfFilter.Q.value = 0.7;
    this.surfGain = ctx.createGain();
    this.surfGain.gain.value = 0;
    noise().connect(this.surfFilter).connect(this.surfGain).connect(this.out);

    // Rain and snowfall: a hiss, high and bright for rain, softer for snow.
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'bandpass';
    this.rainFilter.frequency.value = 4200;
    this.rainFilter.Q.value = 0.8;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    noise().connect(this.rainFilter).connect(this.rainGain).connect(this.out);
  }

  /** Where we are. Called when a stage loads. */
  setPlace(biome: string, conditions: Conditions): void {
    this.place = PLACES[biome] ?? PLACES.forest!;
    this.conditions = conditions;
    this.untilBird = 1 + Math.random() * 3;
  }

  /**
   * Advance the bed.
   *
   * `speed` matters: the world goes quiet as the car gets loud, which is both
   * true and the only way ambience can exist in a game where the engine is
   * three metres away. `presence` fades everything down behind a menu.
   */
  update(dt: number, speed: number, presence = 1): void {
    const now = this.ctx.currentTime;
    const place = this.place;
    const weather = this.conditions.weather;

    // Drowned out by the car, but never entirely: a lift at 120 km/h should
    // still let some of the world back in.
    const overCar = presence * (1 - Math.min(speed / 42, 1) * 0.75);

    const gust = 1 + Math.sin(now * 0.23) * 0.35 + Math.sin(now * 0.07) * 0.2;
    const wind = place.wind * (WEATHER_WIND[weather] ?? 1) * gust;
    this.windGain.gain.setTargetAtTime(wind * 0.14 * overCar, now, 0.4);
    this.windFilter.frequency.setTargetAtTime(place.windCutoff * (0.8 + gust * 0.3), now, 0.6);

    if (place.surf > 0) {
      // A swell rather than a loop: sine-shaped, and slow enough that no two
      // passes of the same stretch of road sound the same.
      this.surfPhase += dt / Math.max(place.surfPeriod, 0.1);
      const swell = 0.45 + 0.55 * Math.sin(this.surfPhase * Math.PI * 2) ** 2;
      this.surfGain.gain.setTargetAtTime(place.surf * swell * overCar, now, 0.3);
    }

    const rain = weather === 'rain' ? 0.1 : weather === 'snowfall' ? 0.022 : 0;
    this.rainFilter.frequency.setTargetAtTime(weather === 'snowfall' ? 2600 : 4200, now, 0.5);
    this.rainGain.gain.setTargetAtTime(rain * presence, now, 0.5);

    // Birdsong, in daylight, when the car is not shouting over it.
    const daylight = this.conditions.timeOfDay !== 'night';
    const calling = daylight && weather !== 'rain' && weather !== 'snowfall' && place.birds > 0;
    if (calling && speed < 26) {
      this.untilBird -= dt * (place.birds / 60) * (1 - Math.min(speed / 30, 1));
      if (this.untilBird <= 0) {
        this.untilBird = 0.6 + Math.random() * 2.4;
        this.chirp(place.birdPitch, overCar * presence);
      }
    }
  }

  /**
   * One birdcall: two or three notes, sliding, with a fast envelope.
   *
   * Not a recording of any particular bird and not trying to be. It is the
   * shape that matters — a short rising slide with a hard attack reads as a
   * bird from the first note, and it costs three nodes.
   */
  private chirp(pitch: number, level: number): void {
    if (level < 0.05) return;
    const now = this.ctx.currentTime;
    const notes = 2 + Math.floor(Math.random() * 2);
    const base = pitch * (0.8 + Math.random() * 0.5);

    for (let i = 0; i < notes; i++) {
      const at = now + i * (0.07 + Math.random() * 0.06);
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      const from = base * (0.9 + Math.random() * 0.35);
      osc.frequency.setValueAtTime(from, at);
      osc.frequency.exponentialRampToValueAtTime(from * (1.1 + Math.random() * 0.3), at + 0.05);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.05 * level, at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);

      osc.connect(gain).connect(this.out);
      osc.start(at);
      osc.stop(at + 0.12);
    }
  }

  /** Fade the whole bed. Used when a menu takes over. */
  setPresence(presence: number): void {
    this.out.gain.setTargetAtTime(presence, this.ctx.currentTime, 0.25);
  }
}
