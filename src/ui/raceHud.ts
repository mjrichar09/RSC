/**
 * Race HUD: clock, live delta, progress, splits and the finish panel.
 *
 * The delta is the part that makes chasing a ghost addictive: it compares your
 * clock against the ghost's clock *at the same point on the road*, not at the
 * same moment in time, so it answers "am I up or down" rather than "where is
 * the other car".
 */

import type { SettleResult } from '../game/career.js';
import type { Medal, Race } from '../game/race.js';
import type { DamageModel } from '../sim/damage.js';
import type { Stage } from '../sim/stage.js';
import type { UpcomingCorner } from '../sim/corners.js';

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
  private readonly pace: HTMLElement;
  private readonly best: HTMLElement;
  private readonly notes: HTMLElement;
  /** The order of the field in a network race. Empty when racing alone. */
  private readonly standings: HTMLElement;
  private standingsKey = '';
  /** What the notes currently say, so the DOM is only touched when it changes. */
  private notesKey = '';
  private lastSplitCount = -1;
  private lastPhase = '';
  private ghostTime: number | null = null;
  private ledger: SettleResult | null = null;
  /** Medals in force, which on a variant are not the stage's own. */
  private medals: Stage['def']['medals'] | null = null;
  private splitDeltas: (number | null)[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'race';
    this.root.innerHTML = `
      <div class="race-top">
        <div class="race-stage" id="race-stage"></div>
        <div class="race-clock" id="race-clock">0:00.00</div>
        <div class="race-delta" id="race-delta"></div>
        <div class="race-pace" id="race-pace"></div>
        <div class="race-best" id="race-best"></div>
        <div class="race-progress"><div id="race-progress-fill"></div></div>
        <div class="race-cps" id="race-cps"></div>
      </div>
      <div class="race-standings" id="race-standings"></div>
      <div class="race-notes" id="race-notes"></div>
      <div class="race-panel" id="race-panel"></div>`;
    parent.appendChild(this.root);

    this.standings = this.root.querySelector('#race-standings')!;
    this.clock = this.root.querySelector('#race-clock')!;
    this.stageName = this.root.querySelector('#race-stage')!;
    this.progressFill = this.root.querySelector('#race-progress-fill')!;
    this.checkpoints = this.root.querySelector('#race-cps')!;
    this.panel = this.root.querySelector('#race-panel')!;
    this.delta = this.root.querySelector('#race-delta')!;
    this.pace = this.root.querySelector('#race-pace')!;
    this.best = this.root.querySelector('#race-best')!;
    this.notes = this.root.querySelector('#race-notes')!;
  }

  /**
   * The co-driver's call: the next two corners and how far away they are.
   *
   * Reads the same corner list the roadside boards are built from, so the HUD
   * and the signs can never disagree — a note that contradicts a board is worse
   * than no note at all.
   */
  /**
   * The order of the field, closest to the finish first.
   *
   * Distances are shown as a gap to the car ahead rather than as absolute
   * progress: "+31 m" is a thing you can act on, and 1,482 m is not.
   */
  setStandings(rows: { name: string; progress: number; you: boolean }[]): void {
    const key = rows.map((r) => `${r.name}:${Math.round(r.progress / 5)}`).join('|');
    if (key === this.standingsKey) return;
    this.standingsKey = key;

    if (rows.length < 2) {
      this.standings.innerHTML = '';
      return;
    }
    const order = [...rows].sort((a, b) => b.progress - a.progress);
    this.standings.innerHTML = order
      .map((row, i) => {
        const ahead = i === 0 ? null : (order[i - 1]!.progress - row.progress);
        const gap = ahead === null ? '' : `+${Math.round(ahead)} m`;
        return `<div class="standing${row.you ? ' you' : ''}"><b>${i + 1}</b>${
          row.name
        }<span>${gap}</span></div>`;
      })
      .join('');
  }

  setNotes(upcoming: UpcomingCorner[]): void {
    const key = upcoming
      .map((u) => `${u.corner.entry}:${Math.max(Math.round(u.distance / 10) * 10, 0)}`)
      .join('|');
    if (key === this.notesKey) return;
    this.notesKey = key;

    if (upcoming.length === 0) {
      this.notes.innerHTML = '';
      return;
    }

    this.notes.innerHTML = upcoming
      .map((u, i) => {
        const { corner, distance } = u;
        const tier = corner.severity <= 2 ? 'tight' : corner.severity <= 4 ? 'mid' : 'fast';
        // The distance is what turns a note into a call. Under twenty metres it
        // is no longer a warning — you are in the corner — so it reads "now".
        const away = distance <= 15 ? 'now' : `${Math.round(distance / 10) * 10} m`;
        return `
          <div class="note ${tier} ${i === 0 ? 'next' : 'after'}">
            <i class="note-arrow ${corner.direction}"></i>
            <b>${corner.severity}</b>
            <span>${away}</span>
          </div>`;
      })
      .join('');
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

  /**
   * The money side of the result, set before the panel is shown.
   * Null while the run has not been settled — the panel then omits it rather
   * than showing zeroes.
   */
  setLedger(ledger: SettleResult | null): void {
    this.ledger = ledger;
  }

  setStage(stage: Stage, variantName?: string, medals?: Stage['def']['medals']): void {
    this.medals = medals ?? null;
    const suffix = variantName && variantName !== 'Day' ? ` · ${variantName.toUpperCase()}` : '';
    this.stageName.textContent =
      `${stage.def.name.toUpperCase()}${suffix} · ${(stage.length / 1000).toFixed(2)} km`;
    this.lastSplitCount = -1;
    this.lastPhase = '';
    this.panel.className = 'race-panel';
    this.panel.innerHTML = '';
  }

  /** Repair bill appended to the finish panel — the cost of how you drove. */
  /** Entry fee, payout and outstanding repairs for the attempt just finished. */
  private ledgerMarkup(): string {
    const l = this.ledger;
    if (!l) return '';
    const row = (label: string, value: number, tone = '') =>
      `<div class="ledger-row ${tone}"><span>${label}</span><b>${value < 0 ? '−' : ''}${Math.abs(value).toLocaleString('en-GB')}</b></div>`;

    return `
      <div class="finish-ledger">
        ${l.entryFee > 0 ? row('Entry fee', -l.entryFee, 'loss') : ''}
        ${row('Payout', l.payout, l.payout > 0 ? 'gain' : '')}
        ${l.floored ? '<div class="ledger-row"><span class="dim">recovery minimum applied</span></div>' : ''}
        ${row('Repairs outstanding', -l.repairs, l.repairs > 0 ? 'loss' : '')}
        <div class="ledger-net"><span>NET</span><b style="color:${l.net >= 0 ? '#4fd6a0' : 'var(--hot)'}">${l.net >= 0 ? '+' : '−'}${Math.abs(l.net).toLocaleString('en-GB')}</b></div>
      </div>`;
  }

  private billMarkup(damage: DamageModel | null): string {
    if (!damage) return '';
    const bill = damage.repairBill();
    if (bill.total === 0) return '<div class="finish-bill"><div class="bill-total"><span>REPAIRS</span><b>none</b></div></div>';

    const rows = bill.lines
      .slice(0, 5)
      .map((l) => `<div class="bill-row"><span>${l.label}</span><span>${l.cost}</span></div>`)
      .join('');
    const rest = bill.lines.length > 5 ? `<div class="bill-row"><span>+${bill.lines.length - 5} more</span><span></span></div>` : '';
    return `<div class="finish-bill">${rows}${rest}<div class="bill-total"><span>REPAIRS</span><b>${bill.total}</b></div></div>`;
  }

  update(race: Race, damage: DamageModel | null = null): void {
    this.clock.textContent = formatTime(race.time);

    // What this run is on for, so there is a target from the very first
    // attempt rather than only once a ghost exists.
    const projected = race.projectedTime;
    const medal = race.projectedMedal;
    if (projected === null || medal === null) {
      this.pace.textContent = '';
      this.pace.className = 'race-pace';
    } else {
      this.pace.textContent = `on for ${medal.toUpperCase()} · ${formatTime(projected)}`;
      this.pace.className = `race-pace medal-${medal}`;
    }
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
        this.showFinish(race.medal, race.finishTime ?? 0, race.stage, damage);
      } else if (race.phase === 'retired') {
        this.showRetired(race.retirement ?? 'RETIRED', race.time, damage);
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

  /** The run ended without a finish: no medal, no payout, full repair bill. */
  private showRetired(reason: string, time: number, damage: DamageModel | null): void {
    this.panel.className = 'race-panel is-open finish-retired';
    this.panel.innerHTML = `
      <div class="finish-medal">RETIRED</div>
      <div class="finish-reason">${reason}</div>
      <div class="finish-time">${formatTime(time)}</div>
      ${this.billMarkup(damage)}
      ${this.ledgerMarkup()}
      <div class="finish-hint"><b>R</b> retry · <b>Esc</b> garage</div>`;
  }

  private showFinish(medal: Medal, time: number, stage: Stage, damage: DamageModel | null): void {
    const m = this.medals ?? stage.def.medals;
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
      ${this.billMarkup(damage)}
      ${this.ledgerMarkup()}
      <div class="finish-hint"><b>R</b> retry · <b>Esc</b> garage</div>`;
  }
}
