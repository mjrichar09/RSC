/**
 * Race HUD: clock, live delta, progress, splits and the finish panel.
 *
 * The delta is the part that makes chasing a ghost addictive: it compares your
 * clock against the ghost's clock *at the same point on the road*, not at the
 * same moment in time, so it answers "am I up or down" rather than "where is
 * the other car".
 */

import type { Medal, Race } from '../game/race.js';
import type { Stage } from '../sim/stage.js';

export const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

const MEDAL_LABEL: Record<Medal, string> = {
  author: 'AUTHOR',
  gold: 'GOLD',
  silver: 'SILVER',
  bronze: 'BRONZE',
  finish: 'FINISHED',
};

export class RaceHud {
  private readonly root: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly stageName: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly checkpoints: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly delta: HTMLElement;
  private readonly best: HTMLElement;
  private lastSplitCount = -1;
  private lastPhase = '';
  private ghostTime: number | null = null;
  private splitDeltas: (number | null)[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'race';
    this.root.innerHTML = `
      <div class="race-top">
        <div class="race-stage" id="race-stage"></div>
        <div class="race-clock" id="race-clock">0:00.00</div>
        <div class="race-delta" id="race-delta"></div>
        <div class="race-best" id="race-best"></div>
        <div class="race-progress"><div id="race-progress-fill"></div></div>
        <div class="race-cps" id="race-cps"></div>
      </div>
      <div class="race-panel" id="race-panel"></div>`;
    parent.appendChild(this.root);

    this.clock = this.root.querySelector('#race-clock')!;
    this.stageName = this.root.querySelector('#race-stage')!;
    this.progressFill = this.root.querySelector('#race-progress-fill')!;
    this.checkpoints = this.root.querySelector('#race-cps')!;
    this.panel = this.root.querySelector('#race-panel')!;
    this.delta = this.root.querySelector('#race-delta')!;
    this.best = this.root.querySelector('#race-best')!;
  }

  /** Personal best for this stage, shown under the clock. Null hides it. */
  setBest(time: number | null): void {
    this.ghostTime = time;
    this.best.textContent = time === null ? 'no time set' : `PB ${formatTime(time)}`;
    this.best.classList.toggle('none', time === null);
  }

  /**
   * Live delta against the ghost, in seconds. Negative is ahead. Null when
   * there is no ghost or it has not reached this far.
   */
  setDelta(seconds: number | null): void {
    if (seconds === null) {
      this.delta.textContent = '';
      this.delta.className = 'race-delta';
      return;
    }
    const ahead = seconds < 0;
    this.delta.textContent = `${ahead ? '−' : '+'}${Math.abs(seconds).toFixed(2)}`;
    this.delta.className = `race-delta ${ahead ? 'ahead' : 'behind'}`;
  }

  /** Per-checkpoint deltas against the ghost, aligned with the split list. */
  setSplitDeltas(deltas: (number | null)[]): void {
    this.splitDeltas = deltas;
    this.lastSplitCount = -1;
  }

  setStage(stage: Stage): void {
    this.stageName.textContent = `${stage.def.name.toUpperCase()} · ${(stage.length / 1000).toFixed(2)} km`;
    this.lastSplitCount = -1;
    this.lastPhase = '';
    this.panel.className = 'race-panel';
    this.panel.innerHTML = '';
  }

  update(race: Race): void {
    this.clock.textContent = formatTime(race.time);
    this.clock.classList.toggle('staged', race.phase === 'staging');
    this.progressFill.style.width = `${(race.progress * 100).toFixed(1)}%`;

    if (race.splits.length !== this.lastSplitCount) {
      this.lastSplitCount = race.splits.length;
      const total = race.stage.checkpoints.length;
      this.checkpoints.innerHTML = Array.from({ length: total }, (_, i) => {
        const split = race.splits[i];
        if (!split) return `<span>CP${i + 1}</span>`;
        const d = this.splitDeltas[i];
        const label =
          d === null || d === undefined
            ? formatTime(split.time)
            : `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`;
        const tone = d === null || d === undefined ? '' : d < 0 ? 'ahead' : 'behind';
        return `<span class="done ${tone}">${label}</span>`;
      }).join('');
    }

    if (race.phase !== this.lastPhase) {
      this.lastPhase = race.phase;
      if (race.phase === 'finished' && race.medal) {
        this.showFinish(race.medal, race.finishTime ?? 0, race.stage);
      }
    }
  }

  /** Adds the record banner to the finish panel after a run beats the ghost. */
  markRecord(previous: number | null): void {
    const banner = document.createElement('div');
    banner.className = 'finish-record';
    banner.textContent =
      previous === null ? 'FIRST TIME SET' : `NEW RECORD  −${(previous - this.ghostTime!).toFixed(2)}`;
    this.panel.prepend(banner);
  }

  private showFinish(medal: Medal, time: number, stage: Stage): void {
    const m = stage.def.medals;
    const rows = (
      [
        ['author', m.author],
        ['gold', m.gold],
        ['silver', m.silver],
        ['bronze', m.bronze],
      ] as const
    )
      .map(
        ([name, target]) =>
          `<div class="medal-row ${medal === name ? 'earned' : ''} ${time <= target ? 'beaten' : ''}">
             <span>${name}</span><b>${formatTime(target)}</b>
             <i>${time <= target ? `−${(target - time).toFixed(2)}` : `+${(time - target).toFixed(2)}`}</i>
           </div>`,
      )
      .join('');

    this.panel.className = `race-panel is-open medal-${medal}`;
    this.panel.innerHTML = `
      <div class="finish-medal">${MEDAL_LABEL[medal]}</div>
      <div class="finish-time">${formatTime(time)}</div>
      <div class="finish-medals">${rows}</div>
      <div class="finish-hint"><b>R</b> to restart</div>`;
  }
}
