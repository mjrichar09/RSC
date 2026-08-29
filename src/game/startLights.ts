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

export type StartPhase = 'waiting' | 'counting' | 'go' | 'done';

export class StartLights {
  /** How many red lamps are lit, 0..3. */
  lamps = 0;
  phase: StartPhase = 'waiting';

  private elapsed = 0;
  /** Set when a lamp lights or the green comes on, for the sound and the HUD. */
  private pending: 'lamp' | 'go' | null = null;

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

  /** Begin the sequence. Called when a stage loads and on every restart. */
  arm(): void {
    this.phase = 'counting';
    this.lamps = 0;
    this.elapsed = 0;
    this.pending = null;
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
  }

  /**
   * Advance the sequence, returning what just happened so the caller can make
   * a noise about it. Returns null on the frames where nothing changed.
   */
  update(dt: number): 'lamp' | 'go' | null {
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
      }
    } else if (this.elapsed >= GREEN_FOR) {
      this.phase = 'done';
    }

    return this.pending;
  }
}
