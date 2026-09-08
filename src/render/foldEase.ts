/**
 * The fold arriving, instead of the fold appearing.
 *
 * Damage is a step. `applyImpact` runs inside one physics step and the wing is
 * bent on the next frame drawn — which is correct, and reads as the car
 * *cutting* to a damaged version of itself rather than being damaged. Slowing
 * the world down made that snap longer to wait for and no less of a snap: at
 * 0.34× the crash cinematic holds on a car that changes shape between two
 * frames of a sequence built entirely to be looked at.
 *
 * So this is a `DamageLike` that lags the real one. The renderer reads it; the
 * simulation, the damage panel and the repair bill all keep reading the live
 * model, because the metal being *seen* to bend over a tenth of a second must
 * not mean the car is undamaged for a tenth of a second.
 *
 * Two rules make it honest rather than merely smooth:
 *
 * - **Metal folds; it does not unfold.** Health going down is eased, health
 *   going back up — a repair — is instant. A wing un-crumpling over a tenth of
 *   a second is a visual effect nothing in the game means.
 * - **The first frame after a reset adopts whatever it is given.** A career car
 *   that starts a stage with a folded corner has to be folded on the first
 *   frame, not fold itself in as the lights go out.
 *
 * Real seconds throughout. The whole point of it is a duration a person
 * experiences, and the world's clock is the one being slowed down.
 */

import { COMPONENTS, type ComponentId, type Dent } from '../sim/damage.js';
import type { DamageLike } from './carView.js';

/**
 * How fast the metal moves, in units of health (or dent depth) per second.
 *
 * A full 0-to-1 collapse in about an eighth of a second, which is 0.36 s at the
 * cinematic's 0.34× — long enough to see the panel move and far short of the
 * half-second the replay now waits before it cuts, so a fold is always finished
 * inside the strip that shows it.
 */
const FOLD_RATE = 8;

/** How far a dent has to move before it counts as a different dent. */
const SAME_DENT = 0.05;

export class EasedDamage implements DamageLike {
  /** The live model, or null between stages. */
  source: DamageLike | null = null;

  private readonly shown = new Map<ComponentId, number>();
  private shownDents: Dent[] = [];
  private version = 0;
  /** True until the next advance, which takes the source exactly as it is. */
  private adopting = true;

  /** Point at a new car — or at none. Nothing is animated across that. */
  attach(source: DamageLike | null): void {
    this.source = source;
    this.shown.clear();
    this.shownDents = [];
    this.adopting = true;
    this.version++;
  }

  /**
   * Move the shown state toward the real one.
   *
   * Must be called on every path that draws the car, which is three: the live
   * loop, the crash cinematic and the harness seek. A renderer-side envelope
   * that only advances in one of them freezes in the other two — the camera
   * shake got this exactly wrong once and it read as the slow motion causing
   * the shake.
   */
  advance(wallDt: number): void {
    const source = this.source;
    if (!source) return;
    // Capped for the same reason the frame delta is: a stalled tab must not
    // hand this a second of catch-up and finish every fold in one frame.
    const step = this.adopting ? Infinity : FOLD_RATE * Math.min(wallDt, 0.1);
    let changed = this.adopting;

    for (const component of COMPONENTS) {
      const target = source.get(component.id);
      const now = this.shown.get(component.id) ?? target;
      // Down is eased, up is instant: see the header.
      const next = target >= now ? target : Math.max(target, now - step);
      if (next !== now) changed = true;
      this.shown.set(component.id, next);
    }

    const dents = source.dents;
    if (this.shownDents.length > dents.length) {
      this.shownDents.length = dents.length;
      changed = true;
    }
    for (let i = 0; i < dents.length; i++) {
      const dent = dents[i]!;
      let shown = this.shownDents[i];
      // The live list merges dents into each other in place, so an index can
      // become a different fold between two frames. A fold that has moved is a
      // new one and starts from flat; one that has not keeps what it had.
      if (
        !shown ||
        Math.abs(shown.at.x - dent.at.x) > SAME_DENT ||
        Math.abs(shown.at.y - dent.at.y) > SAME_DENT ||
        Math.abs(shown.at.z - dent.at.z) > SAME_DENT
      ) {
        shown = { at: { ...dent.at }, reach: dent.reach, depth: this.adopting ? dent.depth : 0 };
        this.shownDents[i] = shown;
        changed = true;
        if (this.adopting) continue;
      }
      shown.at.x = dent.at.x;
      shown.at.y = dent.at.y;
      shown.at.z = dent.at.z;
      shown.reach = dent.reach;
      const next =
        dent.depth > shown.depth ? Math.min(dent.depth, shown.depth + step) : dent.depth;
      if (next !== shown.depth) {
        shown.depth = next;
        changed = true;
      }
    }

    this.adopting = false;
    if (changed) this.version++;
  }

  get(id: ComponentId): number {
    return this.shown.get(id) ?? this.source?.get(id) ?? 1;
  }

  get dents(): readonly Dent[] {
    return this.shownDents;
  }

  /**
   * Bumped whenever anything moved, which is what makes `reshape` rebuild
   * through the fold. An integer, deliberately: the shape key it feeds is
   * bit-twiddled into an int32, and a fractional version there quietly
   * collapses every distinct value onto the same key.
   */
  get dentVersion(): number {
    return this.version;
  }

  // Heat is already a continuous quantity and needs no smoothing of its own.
  brakeGlow(index: number): number {
    return this.source?.brakeGlow(index) ?? 0;
  }

  brakeTint(index: number): number {
    return this.source?.brakeTint(index) ?? 0;
  }
}
