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
const HOLD = [1.5, 1.9, 2.4, 3.2];

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
    this.root.innerHTML = `
      <div class="award w${next.weight} ${next.medal ?? 'none'} ${next.kind}">
        <div class="award-flash"></div>
        <div class="award-title">${next.title}</div>
        <div class="award-detail">${next.detail}</div>
      </div>`;
    this.onLand?.(next);
  }
}
