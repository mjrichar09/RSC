/**
 * The moment after the line.
 *
 * A first gold used to arrive as a word in a ledger. This is the same
 * information delivered as an event: the screen flashes, the word lands hard
 * enough to be felt, and the sound rises rather than pings. Everything here is
 * timing — a celebration that arrives late, holds too long, or stacks on top of
 * itself reads as a bug rather than as a reward.
 *
 * Awards queue rather than overlap, biggest last, so a run that earns a
 * personal best, a gold and the sweep that gold completed plays as three beats
 * building instead of one shout.
 */

import type { Award } from '../game/awards.js';

/** How long each award holds, by weight. */
const HOLD = [1.5, 1.9, 2.4, 3.6];

/**
 * The spark burst, for the top of the board only.
 *
 * Fixed rather than random: a screenshot of the same award has to look the same
 * twice, and this is the one moment in the game most likely to be captured. The
 * angles are deliberately uneven — twelve evenly spaced sparks read as a clock
 * face rather than as a burst — and each carries its own distance and delay so
 * they do not arrive as one ring.
 */
const SPARKS = [
  [-84, 1.0, 0.00], [-52, 0.78, 0.05], [-26, 1.12, 0.02], [-8, 0.62, 0.09],
  [14, 0.94, 0.01], [38, 1.18, 0.06], [63, 0.7, 0.03], [96, 1.04, 0.08],
  [124, 0.86, 0.02], [152, 1.15, 0.05], [186, 0.66, 0.07], [212, 0.98, 0.01],
  [238, 1.08, 0.04], [266, 0.74, 0.09], [292, 1.2, 0.03], [318, 0.9, 0.06],
];

export class Celebrations {
  /** Raised as each award lands, so the mixer can make the right noise. */
  onLand: ((award: Award) => void) | null = null;

  private readonly root: HTMLElement;
  private readonly queue: Award[] = [];
  private showing: Award | null = null;
  private remaining = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'awards';
    parent.appendChild(this.root);
  }

  /** True while something is on screen or waiting to be. */
  get busy(): boolean {
    return this.showing !== null || this.queue.length > 0;
  }

  /** Queue a run's worth of awards. Biggest last: the celebration builds. */
  show(awards: readonly Award[]): void {
    this.queue.push(...awards);
  }

  clear(): void {
    this.queue.length = 0;
    this.showing = null;
    this.remaining = 0;
    this.root.innerHTML = '';
  }

  update(dt: number): void {
    if (this.showing) {
      this.remaining -= dt;
      if (this.remaining > 0) return;
      this.showing = null;
      this.root.innerHTML = '';
    }

    const next = this.queue.shift();
    if (!next) return;

    this.showing = next;
    this.remaining = HOLD[Math.min(next.weight, HOLD.length - 1)]!;
    // The heavy trimmings are built only for the tier that earns them. A ray
    // fan and sixteen sparks on every personal best would cost more than the
    // race does on a phone, and would make the rare thing look ordinary — which
    // is the more expensive of the two problems.
    const rays = next.weight >= 3 ? '<div class="award-rays"></div>' : '';
    const sparks =
      next.weight >= 3
        ? `<div class="award-sparks">${SPARKS.map(
            ([angle, reach, delay]) =>
              `<i style="--a:${angle}deg;--r:${reach};--d:${delay}s"></i>`,
          ).join('')}</div>`
        : '';
    // `data-text` carries a second copy of the word for the shimmer pass to
    // draw over the top: a gradient clipped to text cannot also carry a glow,
    // because the glow is painted from the colour the clip has thrown away.
    this.root.innerHTML = `
      <div class="award w${next.weight} ${next.medal ?? 'none'} ${next.kind}">
        ${rays}
        <div class="award-flash"></div>
        ${sparks}
        <div class="award-title" data-text="${next.title}">${next.title}</div>
        <div class="award-detail">${next.detail}</div>
      </div>`;
    this.onLand?.(next);
  }
}
