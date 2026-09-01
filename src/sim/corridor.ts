/**
 * The cross-section every stage is cut to.
 *
 * A rally corridor rather than a floating road: flat driveable width in the
 * middle, a verge that drops slightly and slows you down, an embankment that
 * rises on both sides, and a near-vertical wall closing the outside of each
 * bank. The bank is what keeps a mistake on the stage instead of dropping the
 * car into the void, and it is generated rather than authored so every stage
 * gets it for free.
 *
 * Its own module because three things need these numbers — the geometry
 * builder, the scenery scatter, and the renderer — and a second copy of them
 * anywhere drifts from this one the first time a verge gets wider, leaving a
 * stage with bushes hovering a metre above their own hillside.
 */

/** Corridor cross-section, in metres either side of the driveable width. */
export const VERGE_WIDTH = 3.2;
export const VERGE_DROP = 0.18;
export const BANK_WIDTH = 5.0;
export const BANK_HEIGHT = 2.4;

/**
 * Near-vertical wall closing the outside of each embankment.
 *
 * The corridor is the entire world — there is nothing beyond it — so without a
 * wall a big slide simply carries the car over the bank and into an infinite
 * fall. Rally stages are lined with rock faces, trees and snowbanks anyway, so
 * this is honest as well as necessary.
 */
export const WALL_WIDTH = 1.5;
export const WALL_HEIGHT = 8.5;

/** Height of the road's centre above its edges, metres. */
export const CROWN = 0.09;

/** The corridor's shape, for anything that has to sit on it. */
export const CORRIDOR = {
  vergeWidth: VERGE_WIDTH,
  vergeDrop: VERGE_DROP,
  bankWidth: BANK_WIDTH,
  bankHeight: BANK_HEIGHT,
  wallWidth: WALL_WIDTH,
  wallHeight: WALL_HEIGHT,
  /** Height of the corridor surface at `offset` metres from the centreline. */
  heightAt(width: number, offset: number): number {
    const from = Math.abs(offset);
    if (from <= width) return 0;
    if (from <= width + VERGE_WIDTH) {
      return -VERGE_DROP * ((from - width) / VERGE_WIDTH);
    }
    const up = Math.min((from - width - VERGE_WIDTH) / BANK_WIDTH, 1);
    return -VERGE_DROP + (BANK_HEIGHT + VERGE_DROP) * up;
  },
} as const;
