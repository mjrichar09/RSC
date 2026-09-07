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
import type { LaunchQuality } from '../game/startLights.js';
import type { DamageModel } from '../sim/damage.js';
import type { Stage } from '../sim/stage.js';
import type { UpcomingCorner } from '../sim/corners.js';
import type { BoardEntry } from '../net/leaderboard.js';
import { escapeHtml } from './escape.js';

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

/** What the HUD calls each launch. Short, because it is on screen for a second. */
const LAUNCH_WORD: Record<LaunchQuality, string> = {
  perfect: 'PERFECT START',
  clean: 'GOOD START',
  late: 'SLOW AWAY',
  bogged: 'BOGGED DOWN',
};

export class RaceHud {
  /** Pressed on the finish panel's retry button. */
  onRetry: (() => void) | null = null;
  /** Pressed on the finish panel's way-out button. */
  onLeave: (() => void) | null = null;
  /** What the finish panel offers. Set by whoever knows the mode. */
  private actions: { retry: boolean; leave: string } = { retry: true, leave: 'Garage' };

  /** Tell the finish panel what it may offer, and what to call the way out. */
  setActions(actions: { retry: boolean; leave: string }): void {
    this.actions = actions;
  }

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
  private readonly missedBanner: HTMLElement;
  /** The order of the field in a network race. Empty when racing alone. */
  private readonly standings: HTMLElement;
  /** The start countdown, over the middle of the screen. */
  private readonly lights: HTMLElement;
  private lightsKey = '';
  private standingsKey = '';
  /** What the notes currently say, so the DOM is only touched when it changes. */
  private notesKey = '';
  private stripKey = '';
  private missedKey = '';
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
      <div class="race-lights" id="race-lights"></div>
      <div class="race-standings" id="race-standings"></div>
      <div class="race-missed" id="race-missed"></div>
      <div class="race-notes" id="race-notes"></div>
      <div class="race-panel" id="race-panel"></div>`;
    parent.appendChild(this.root);

    this.lights = this.root.querySelector('#race-lights')!;
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
    this.missedBanner = this.root.querySelector('#race-missed')!;
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

  /**
   * The start lights, on the HUD as well as on the gantry.
   *
   * The gantry is where they belong and the HUD is where they can be seen: the
   * camera can be anywhere on the apron when a race begins, and a countdown you
   * might be looking away from is not a countdown.
   */
  setLights(reds: number, go: boolean, launch: LaunchQuality | null = null): void {
    const key = `${reds}:${go}:${launch ?? ''}`;
    if (key === this.lightsKey) return;
    this.lightsKey = key;

    if (reds === 0 && !go) {
      this.lights.innerHTML = '';
      return;
    }
    const lamps = [0, 1, 2]
      .map((i) => `<i class="${go ? 'go' : i < reds ? 'lit' : ''}"></i>`)
      .join('');
    // Once the launch has been graded the word says how it went rather than
    // "GO" — the whole point of timing the light is that you find out.
    const word = launch ? LAUNCH_WORD[launch] : go ? 'GO' : 'READY';
    const tone = launch ? `launch-${launch}` : go ? 'go' : '';
    this.lights.innerHTML = `
      <div class="lights-row">${lamps}</div>
      <div class="lights-word ${tone}">${word}</div>`;
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
    this.stripKey = '';
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
    this.stripKey = '';
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

    // Missed gates change the strip without changing the split count, so the
    // key has to carry both or a run stays looking clean after driving round
    // the outside of a checkpoint.
    const stripKey = `${race.splits.length}:${race.missed.join(',')}`;
    if (stripKey !== this.stripKey) {
      this.stripKey = stripKey;
      const total = race.stage.checkpoints.length;
      this.checkpoints.innerHTML = Array.from({ length: total }, (_, i) => {
        if (race.missed.includes(i)) return `<span class="missed">CP${i + 1}</span>`;
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

    // A missed gate is only recoverable if you know you missed it, and the one
    // place a driver is definitely looking is the middle of the screen. Naming
    // the gate matters as much as the warning: "CP2 MISSED" is something to act
    // on, and "checkpoint missed" is something to be baffled by.
    const missed = race.missed.length > 0 && race.phase === 'running'
      ? `CP${race.missed[0]! + 1} MISSED · GO BACK`
      : '';
    if (missed !== this.missedKey) {
      this.missedKey = missed;
      this.missedBanner.textContent = missed;
      this.missedBanner.classList.toggle('show', missed !== '');
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

  /**
   * Add the board to the finish panel: who is quickest, and where you came.
   *
   * Appended after the panel is already up rather than built into it, for the
   * same reason `markRecord` is: the times arrive from a network and the panel
   * must not wait for them. A run that finished shows its own time instantly
   * and grows the board a moment later, or never — an unreachable board leaves
   * a panel that is exactly what it was before any of this existed.
   */
  markBoard(board: {
    /** Null when the board could not be reached, which is not the same as empty. */
    top: BoardEntry[] | null;
    /** Your place, 0-based, or null if you did not make it. */
    rank: number | null;
    /** Your name, so your row can be picked out of the three. */
    you: string;
    yourTime: number;
    /** Your own best before this run: null for a first, undefined if unbeaten. */
    beat?: number | null;
    /** The others in a multiplayer race, already in finishing order. */
    rivals?: { name: string; time: number | null }[];
  }): void {
    const section = document.createElement('div');
    section.className = 'finish-board';

    // An unreachable board and an empty one are different things and must not
    // read alike: "this is the first time set here" is a claim about the world,
    // and making it because a request failed is telling the player something
    // false about a race they just drove.
    const reached = board.top !== null;

    // Three, which is what fits beside a time without becoming a table. The
    // rest of the ten is on the stage-select screen.
    const podium = (board.top ?? []).slice(0, 3);
    // Which of the three is you, by name rather than by this run's rank. They
    // are not the same question: you can already hold second from last week and
    // have just driven a slower lap, and keying off the rank puts you on the
    // board twice — once in the podium and once again underneath with a dash,
    // which reads as two contradictory results for one race.
    const yourRow = podium.findIndex(
      (entry) => entry.name.toLowerCase() === board.you.toLowerCase(),
    );

    const rows = podium
      .map(
        (entry, i) =>
          `<div class="board-row${i === yourRow ? ' is-you' : ''}">
            <u>${i + 1}</u><span>${escapeHtml(entry.name)}</span><b>${formatTime(entry.time)}</b>
          </div>`,
      )
      .join('');

    // Your own row, unless you are already one of the three above.
    const yours =
      yourRow >= 0
        ? ''
        : `<div class="board-row is-you">
             <u>${board.rank !== null ? board.rank + 1 : '—'}</u>
             <span>${escapeHtml(board.you)}</span><b>${formatTime(board.yourTime)}</b>
           </div>`;

    const best =
      board.beat === undefined
        ? ''
        : `<div class="board-note">${
            board.beat === null
              ? 'Your first time here'
              : `Your best, by ${(board.beat - board.yourTime).toFixed(2)}s`
          }</div>`;

    const rivals = board.rivals?.length
      ? `<div class="board-rivals"><h4>This race</h4>${board.rivals
          .map(
            (r) =>
              `<div class="board-row"><span>${escapeHtml(r.name)}</span><b>${
                r.time === null ? 'retired' : formatTime(r.time)
              }</b></div>`,
          )
          .join('')}</div>`
      : '';

    const heading = !reached
      ? 'Your time'
      : podium.length === 0
        ? 'No times yet — this is the first'
        : 'Fastest here';

    section.innerHTML = `<h4>${heading}</h4>${rows}${yours}${best}${rivals}`;

    // Before the buttons, so the way out stays the last thing on the panel.
    const actions = this.panel.querySelector('.finish-actions');
    if (actions) this.panel.insertBefore(section, actions);
    else this.panel.append(section);
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
      ${this.actionsMarkup()}`;
    this.bindActions();
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
      ${this.actionsMarkup()}`;
    this.bindActions();
  }

  /**
   * What to do next.
   *
   * These were a line of text naming two keys, which on a phone is a dead end:
   * the run ends, the panel appears, and there is nothing to press. They are
   * buttons now, and the key hints stay alongside for anyone who has keys.
   *
   * Retry is offered only where it is actually allowed. In a career with the
   * practice aids off, a run you can repeat for free is a run with no
   * consequences in it — so there the panel offers the way out and not the way
   * round.
   */
  private actionsMarkup(): string {
    const retry = this.actions.retry
      ? `<button class="finish-btn" data-finish="retry">Retry<i>R</i></button>`
      : '';
    return `
      <div class="finish-actions">
        ${retry}
        <button class="finish-btn ghost" data-finish="leave">${this.actions.leave}<i>Esc</i></button>
      </div>`;
  }

  private bindActions(): void {
    for (const el of this.panel.querySelectorAll('[data-finish]')) {
      el.addEventListener('click', () => {
        if ((el as HTMLElement).dataset.finish === 'retry') this.onRetry?.();
        else this.onLeave?.();
      });
    }
  }
}
