/**
 * The start.
 *
 * Every race began with the car simply sitting there until the player pressed
 * something, which makes the first corner arrive at a random moment and gives
 * the stage no beginning at all. A rally start is a countdown on a gantry and a
 * marshal's arm, and the two seconds before the light goes green are the only
 * moment in a race where nothing is happening and everything is about to.
 *
 * Deliberately not part of `Race`: the clock still starts on the car's first
 * movement, which means a jumped start is impossible rather than penalised —
 * the car is *held*, and the light going green is the moment it is let go.
 * That keeps every recorded time comparable with every time recorded before
 * this existed.
 */

/** Seconds each red lamp holds before the next one lights. */
const STEP = 0.9;
/** How long the green stays lit before the gantry goes dark. */
const GREEN_FOR = 1.6;

/** Throttle above this counts as flat out. */
const FLAT = 0.9;
/**
 * Sitting flat for longer than this before the green is bouncing off the
 * limiter rather than launching, and it costs you.
 */
const LIMITER_AFTER = 0.9;
/**
 * Go flat within this of the green and the launch is perfect. Seconds.
 *
 * 0.28 was wider than a human reaction time, so simply reacting to the green
 * scored perfect and there was nothing left to be good at. Simple reaction to
 * a light is about 0.2 s, so the window has to sit *inside* that: the only way
 * through it is to read the rhythm of the lamps — they step every `STEP`
 * seconds, which is a countdown you can time — and go on the beat rather than
 * on the sight of the green. That is the skill a rally start actually has.
 *
 * Halved again from 0.15. At a twelfth of a second it is comfortably inside
 * reaction time in both directions, so it cannot be stumbled into either by
 * being quick or by being early — anticipating the beat by a frame or two is
 * the only thing that fits through it.
 */
const PERFECT_WINDOW = 0.075;
/** Past this the launch is merely late rather than mistimed. Seconds. */
const LATE_WINDOW = 0.75;
/** How long a bogged launch keeps costing power. Seconds. */
const BOG_FOR = 1.6;
/**
 * How much power a full bog takes at its worst, as a fraction.
 *
 * Calibrated against distance off the line rather than chosen, because power
 * and distance are not proportional — gearing, rolling resistance and traction
 * all sit in between, and halving the throttle does not halve the metres.
 *
 * Measured on gravel, from the line, holding flat through the whole countdown:
 *
 *   depth   1.0 s    1.5 s
 *   0.45     2.0 m    5.4 m   (what it was)
 *   0.725    1.4 m    3.9 m
 *   0.85     1.0 m    3.2 m   (half the old distance at one second)
 *   0.90     0.9 m    2.9 m
 *
 * A clean launch covers 2.9 m in that first second, so a full bog now leaves
 * the line at about a third of the pace of one that did not — which is what
 * sitting on the limiter through the countdown should cost, and what it did
 * not cost at 0.45.
 */
const BOG_DEPTH = 0.85;

export type StartPhase = 'waiting' | 'counting' | 'go' | 'done';

/**
 * How the launch went.
 *
 * `clean` is a driver who waited and went at the light. `bogged` is one who
 * held the throttle down through the whole countdown and sat on the limiter —
 * which is what most people do, and which should be the slow way to leave.
 * `late` is the honest miss. The name is what the HUD says.
 */
export type LaunchQuality = 'perfect' | 'clean' | 'late' | 'bogged';

export class StartLights {
  /** How many red lamps are lit, 0..3. */
  lamps = 0;
  phase: StartPhase = 'waiting';

  private elapsed = 0;
  /** Set when a lamp lights or the green comes on, for the sound and the HUD. */
  private pending: 'lamp' | 'go' | null = null;
  /** How long the throttle has been flat out, seconds. Reset when it lifts. */
  private flatFor = 0;
  /** Seconds since the green, or null before it. */
  private sinceGreen: number | null = null;
  /** How badly the launch was fluffed, 0..1. Set once, at the moment of release. */
  private bogged = 0;
  /** What the start was worth, once it has happened. */
  launch: LaunchQuality | null = null;

  /** True while the car is being held on the line. */
  get holding(): boolean {
    return this.phase === 'waiting' || this.phase === 'counting';
  }

  /** True once the player has been let go. */
  get released(): boolean {
    return this.phase === 'go' || this.phase === 'done';
  }

  /** Green, and for how long — the HUD flashes for as long as this is above 0. */
  get greenFor(): number {
    return this.phase === 'go' ? Math.max(GREEN_FOR - this.elapsed, 0) : 0;
  }

  /**
   * How much of the throttle actually reaches the wheels, 0..1.
   *
   * A launch fluffed by sitting on the limiter through the countdown does not
   * hook up: the engine is past its torque peak with nothing left to give, and
   * the first second and a half off the line is spent recovering. This is what
   * makes timing the light worth more than holding the pedal down — the reward
   * for getting it right is that nothing is taken away.
   */
  get throttleScale(): number {
    if (this.bogged <= 0 || this.sinceGreen === null) return 1;
    const left = Math.max(1 - this.sinceGreen / BOG_FOR, 0);
    return 1 - this.bogged * BOG_DEPTH * left;
  }

  /**
   * Score the launch, once, at the moment the throttle goes down.
   *
   * The whole point is that holding the pedal flat through the countdown is
   * the *slow* way to leave the line. Sitting on the limiter is not a launch,
   * it is waiting with the engine past its torque peak, and dumping that into
   * the road bogs the car. Waiting and going at the light costs nothing.
   */
  private gradeLaunch(): LaunchQuality {
    // Flat well before the green: the engine has been on the limiter.
    if (this.flatFor > (this.sinceGreen ?? 0) + LIMITER_AFTER) {
      this.bogged = Math.min((this.flatFor - LIMITER_AFTER) / 1.6, 1);
      return 'bogged';
    }
    const delay = this.sinceGreen ?? 0;
    if (delay <= PERFECT_WINDOW) return 'perfect';
    if (delay <= LATE_WINDOW) return 'clean';
    return 'late';
  }

  /**
   * Hold the car with the gantry dark, waiting for somebody else to say when.
   *
   * A network race: the host holds the grid until every guest has built a
   * world, so the countdown cannot start when the stage loads.
   */
  hold(): void {
    this.phase = 'waiting';
    this.lamps = 0;
    this.elapsed = 0;
    this.pending = null;
    this.flatFor = 0;
    this.sinceGreen = null;
    this.bogged = 0;
    this.launch = null;
  }

  /** Begin the sequence. Called when a stage loads and on every restart. */
  arm(): void {
    this.phase = 'counting';
    this.lamps = 0;
    this.elapsed = 0;
    this.pending = null;
    this.flatFor = 0;
    this.sinceGreen = null;
    this.bogged = 0;
    this.launch = null;
  }

  /**
   * Let the car go immediately.
   *
   * The AI driver, the stage validator and the screenshot harness all drive
   * from a standstill and none of them should sit through a countdown.
   */
  skip(): void {
    this.phase = 'done';
    this.lamps = 0;
    this.elapsed = 0;
    this.pending = null;
    this.bogged = 0;
    this.sinceGreen = null;
    this.launch = null;
  }

  /**
   * Advance the sequence, returning what just happened so the caller can make
   * a noise about it. Returns null on the frames where nothing changed.
   */
  update(dt: number, throttle = 0): 'lamp' | 'go' | null {
    // Tracked in every phase, because the interesting question spans the green:
    // how long they were flat *before* it, and how quickly they went after.
    this.flatFor = throttle >= FLAT ? this.flatFor + dt : 0;
    if (this.sinceGreen !== null) {
      this.sinceGreen += dt;
      if (this.launch === null && throttle >= FLAT) this.launch = this.gradeLaunch();
    }

    if (this.phase === 'waiting' || this.phase === 'done') return null;
    this.elapsed += dt;
    this.pending = null;

    if (this.phase === 'counting') {
      const lit = Math.min(Math.floor(this.elapsed / STEP) + 1, 3);
      if (lit !== this.lamps) {
        this.lamps = lit;
        this.pending = 'lamp';
      }
      // Three lamps, then one more beat holding on all three: the pause with
      // everything lit is what makes the green mean something.
      if (this.elapsed >= STEP * 4) {
        this.phase = 'go';
        this.elapsed = 0;
        this.pending = 'go';
        this.sinceGreen = 0;
        // Graded here for anyone already flat at the light, and in `update`
        // for anyone who goes after it. Both paths run once.
        if (this.flatFor > 0) this.launch = this.gradeLaunch();
      }
    } else if (this.elapsed >= GREEN_FOR) {
      this.phase = 'done';
    }

    return this.pending;
  }
}
