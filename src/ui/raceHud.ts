/**
 * Race HUD: clock, progress, splits and the finish panel.
 *
 * Split deltas are left as placeholders here and filled in properly in P3, when
 * there is a ghost to compare against — the layout reserves the space now so it
 * does not move once there is.
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
  private lastSplitCount = -1;
  private lastPhase = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'race';
    this.root.innerHTML = `
      <div class="race-top">
        <div class="race-stage" id="race-stage"></div>
        <div class="race-clock" id="race-clock">0:00.00</div>
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
        return `<span class="${split ? 'done' : ''}">${split ? formatTime(split.time) : `CP${i + 1}`}</span>`;
      }).join('');
    }

    if (race.phase !== this.lastPhase) {
      this.lastPhase = race.phase;
      if (race.phase === 'finished' && race.medal) {
        this.showFinish(race.medal, race.finishTime ?? 0, race.stage);
      }
    }
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
