/**
 * The garage: stage select, repairs and upgrades.
 *
 * This is where the economy becomes a decision rather than a number. The three
 * panels are deliberately on one screen, because the interesting choice is a
 * comparison between them — a new gearbox, or fixing the radiator and entering
 * the stage that pays for it.
 */

import { Career, type RaceTarget } from '../game/career.js';
import { GarageCar } from '../render/garageCar.js';
import { Stage, type StageDef } from '../sim/stage.js';
import { elevationProfileSvg, stageElevation, stageMapSvg } from './stageMap.js';
import { UPGRADES, levelOf, maxLevel, nextCost } from '../game/garage.js';
import { LIVERIES } from '../data/liveries.js';
import { sweepProgress } from '../game/awards.js';
import { formatTime } from './raceHud.js';

const MEDAL_TINT: Record<string, string> = {
  author: '#b06bff',
  gold: '#f2c14e',
  silver: '#c8d0d9',
  bronze: '#cd8642',
  finish: '#8b95a5',
};

/**
 * Stage maps for the list, cached by stage id.
 *
 * Building a Stage costs about 3 ms, and the garage re-renders on every repair
 * and every purchase — fifteen rows would spend 40 ms redrawing shapes that
 * cannot have changed.
 */
interface StageThumb {
  map: string;
  profile: string;
  /** Total metres climbed, which is the honest measure of how hilly it is. */
  climb: number;
}

const MAP_CACHE = new Map<string, StageThumb>();

/**
 * The shape of a stage, and its section.
 *
 * Two rows of a stage list can have identical outlines and be nothing alike to
 * drive, because one of them climbs two hundred metres. The plan says which
 * stage it is; the profile beside it says what kind of stage it is.
 *
 * The tinted route is deliberately left off the plan here: at fifty-four pixels
 * the outline is all that is readable, and the height belongs in the profile
 * next to it where there is room for it.
 */
function stageThumb(def: StageDef): StageThumb {
  const cached = MAP_CACHE.get(def.id);
  if (cached !== undefined) return cached;
  const stage = new Stage(def);
  const elevation = stageElevation(stage);
  const thumb: StageThumb = {
    map: stageMapSvg(stage, {
      size: 100,
      markers: true,
      corners: true,
      stroke: 3.4,
      elevation: false,
    }),
    profile: elevationProfileSvg(stage, 100, 18),
    climb: Math.round(elevation.climb),
  };
  MAP_CACHE.set(def.id, thumb);
  return thumb;
}

const money = (n: number): string => `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-GB')}`;

/** Which of the garage panels a narrow screen is showing. */
type GarageTab = 'stages' | 'repairs' | 'car';

export class Garage {
  private readonly root: HTMLElement;
  private readonly career: Career;
  /** The turntable. Lives across re-renders and is moved into each new one. */
  private readonly car = new GarageCar();
  private open = false;
  /** Two-step, because there is no undo behind it. */
  private confirmingReset = false;
  /**
   * Which panel is on screen on a narrow one.
   *
   * Only ever consulted by the stylesheet — on a desktop all three sections are
   * side by side and the tab bar is not rendered at all. That is deliberate:
   * deciding by CSS media query rather than by measuring the window in
   * JavaScript means there is no width to keep in sync, nothing to recompute on
   * a rotate, and the wide layout is untouched by any of this.
   */
  private tab: GarageTab = 'stages';

  /** Raised when the player commits to a stage under particular conditions. */
  onEnter: ((target: RaceTarget) => void) | null = null;
  /** Raised after a career reset, so the game can put a fresh car on the road. */
  onReset: (() => void) | null = null;
  /** Raised when the player asks for the front door. */
  onMenu: (() => void) | null = null;

  constructor(parent: HTMLElement, career: Career) {
    this.career = career;

    this.root = document.createElement('div');
    this.root.className = 'garage';
    parent.appendChild(this.root);

    // One delegated listener rather than rebinding on every redraw, since the
    // whole panel is re-rendered whenever money or condition changes.
    this.root.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (target) void this.handle(target.dataset.action!, target.dataset.id ?? '');
    });

    this.setOpen(false);
  }

  private async handle(action: string, id: string): Promise<void> {
    switch (action) {
      case 'tab': {
        this.tab = id as GarageTab;
        this.render();
        return;
      }
      case 'enter': {
        const target = this.career.targets().find((t) => this.career.keyFor(t) === id);
        if (target && this.career.canEnter(target).allowed) {
          if (await this.career.enter(target)) {
            this.setOpen(false);
            this.onEnter?.(target);
          }
        }
        break;
      }
      case 'livery':
        await this.career.setLivery(id);
        this.car.setLivery(this.career.livery, this.career.raceNumber);
        break;
      case 'number': {
        await this.career.setRaceNumber(Number(id));
        this.car.setLivery(this.career.livery, this.career.raceNumber);
        break;
      }
      case 'repair-all':
        await this.career.repairAll();
        break;
      case 'repair-essentials':
        await this.career.repairEssentials();
        break;
      case 'salvage':
        await this.career.salvage();
        break;
      case 'practice':
        await this.career.setPractice(!this.career.profile.settings.practice);
        break;
      case 'reset':
        this.confirmingReset = true;
        break;
      case 'reset-cancel':
        this.confirmingReset = false;
        break;
      case 'reset-confirm':
        await this.career.reset();
        this.confirmingReset = false;
        this.onReset?.();
        break;
      case 'repair':
        await this.career.repairComponent(id as never);
        break;
      case 'buy':
        await this.career.buy(id as never);
        break;
      case 'menu':
        this.setOpen(false);
        this.onMenu?.();
        return;
      case 'close':
        this.setOpen(false);
        return;
    }
    this.render();
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle('is-open', open);
    // Hide the in-race HUD rather than relying on the overlay's opacity: a
    // frozen clock ghosting through the garage reads like a bug.
    this.root.parentElement?.classList.toggle('in-garage', open);
    if (open) this.render();
    // Nothing renders while the garage is shut: a second WebGL context turning
    // a car nobody is looking at is pure waste.
    this.car.setActive(open);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Enter the nth row from the keyboard, if it can be entered. */
  async enterByIndex(index: number): Promise<void> {
    const target = this.career.targets()[index];
    if (target) await this.handle('enter', this.career.keyFor(target));
  }

  render(): void {
    if (!this.open) return;
    this.root.innerHTML = `
      <div class="garage-inner">
        <header class="garage-head">
          <div>
            <div class="garage-title">GARAGE</div>
            <div class="garage-sub">${this.conditionLine()} · ${this.career.medalsHeld} medal${this.career.medalsHeld === 1 ? '' : 's'}</div>
          </div>
          <div class="garage-car-slot" id="garage-car-slot"></div>
          <div class="garage-money"><span>FUNDS</span><b>${money(this.career.money)}</b></div>
        </header>
        ${this.warningsPanel()}
        ${this.tabBar()}
        <div class="garage-cols" data-tab-active="${this.tab}">
          <section data-tab="stages">${this.stagesPanel()}</section>
          <section data-tab="repairs">${this.repairsPanel()}</section>
          <section data-tab="car">${this.upgradesPanel()}${this.progressPanel()}${this.paintPanel()}</section>
        </div>
        <footer class="garage-foot">
          <span><b>1</b>–<b>${Math.min(9, this.career.targets().length)}</b> enter stage · <b>Esc</b> close · <b>drag</b> the car to turn it</span>
          <span class="garage-foot-right">
            <button data-action="menu">Main menu</button>
            ${
              this.confirmingReset
                ? `<span class="reset-warn">Erases every record, ghost, upgrade and penny.</span>
                   <button class="warn" data-action="reset-confirm">Yes, start again</button>
                   <button data-action="reset-cancel">Keep my career</button>`
                : `<button data-action="reset">Reset career</button>`
            }
            <button data-action="close">Close</button>
          </span>
        </footer>
      </div>`;

    // The turntable survives the re-render and is moved into the new DOM: a
    // canvas keeps its WebGL context when it is re-parented, and rebuilding one
    // on every repair would drop the context each time.
    this.root.querySelector('#garage-car-slot')?.appendChild(this.car.root);
    this.car.setCondition(this.career.buildDamage());
    this.car.setLivery(this.career.livery, this.career.raceNumber);
  }

  /**
   * What is actually wrong, in words, above everything else.
   *
   * A condition percentage is not a warning — "Car at 93%" was what the garage
   * said while the radiator was holed and the next two races were guaranteed to
   * end in an overheat. The player has to be able to make the repair decision
   * knowing what declining it costs.
   */
  /**
   * The tab bar, on a phone.
   *
   * Rendered always and hidden by the stylesheet above the breakpoint, so a
   * window being resized needs no help from here. Stages first because it is
   * the thing a player came to the garage to do; repairs second because it is
   * the thing they cannot leave without.
   */
  private tabBar(): string {
    const tabs: [GarageTab, string][] = [
      ['stages', 'Next stage'],
      ['repairs', 'Repairs'],
      ['car', 'Car'],
    ];
    // The repair bill on the tab itself: on a phone the repairs panel is off
    // screen, and "you owe 4 200" is exactly the thing that must not be.
    const owed = this.career.repairBill().total;
    return `<nav class="garage-tabs">${tabs
      .map(([id, label]) => {
        const badge = id === 'repairs' && owed > 0 ? ` <b>${money(owed)}</b>` : '';
        return `<button data-action="tab" data-id="${id}" class="${
          this.tab === id ? 'on' : ''
        }">${label}${badge}</button>`;
      })
      .join('')}</nav>`;
  }

  private warningsPanel(): string {
    const warnings = this.career.warnings();
    if (warnings.length === 0) return '';
    const rows = warnings
      .map((w) => `<div class="warn-row ${w.severity}"><i></i><span>${w.text}</span></div>`)
      .join('');
    return `<div class="garage-warnings">${rows}</div>`;
  }

  private conditionLine(): string {
    const condition = this.career.condition;
    const driveable = this.career.carIsDriveable;
    if (!driveable) return `<span class="bad">CAR UNDRIVEABLE — repair before entering</span>`;
    if (condition > 0.995) return 'Car in perfect condition';
    return `Car at ${(condition * 100).toFixed(0)}% · repairs outstanding`;
  }

  /**
   * One row per stage-and-conditions pairing. A night variant is a separate
   * entry with its own record, fee and payouts, because that is what it is:
   * the same road, a different race.
   */
  private stagesPanel(): string {
    const targets = this.career.targets();
    const rows = targets
      .map((target, i) => {
        const { def, variant } = target;
        const record = this.career.recordFor(target);
        const check = this.career.canEnter(target);
        const reason =
          check.reason === 'too-poor'
            ? 'not enough funds'
            : check.reason === 'undriveable'
              ? 'car undriveable'
              : check.reason === 'locked'
                ? `${variant.requiresMedals} medal${variant.requiresMedals === 1 ? '' : 's'}`
                : '';

        const best = record
          ? `<span style="color:${MEDAL_TINT[record.medal]}">${formatTime(record.time)} · ${record.medal}</span>`
          : '<span class="dim">no time set</span>';

        // Only the first nine rows have a number key, so the rest show none
        // rather than a key that does nothing.
        const key = i < 9 ? `${i + 1}` : '';
        const thumb = stageThumb(def);

        return `
          <div class="stage-row ${check.allowed ? '' : 'locked'}">
            <div class="stage-key">${key}</div>
            <div class="stage-map-thumb">${thumb.map}</div>
            <div class="stage-body">
              <div class="stage-name">${def.name} <span class="dim">· ${variant.name}</span></div>
              <div class="stage-meta">${def.biome} · <span class="stage-climb">▲ ${thumb.climb} m</span>${
                check.reason === 'locked' ? ` · <span class="locked-note">locked</span>` : ''
              }</div>
              <div class="stage-profile-thumb">${thumb.profile}</div>
              <div class="stage-meta">${best}</div>
            </div>
            <div class="stage-pay">
              <div><b style="color:${MEDAL_TINT.gold}">${money(variant.payouts.gold)}</b> gold</div>
              <div class="dim">${money(variant.payouts.finish)} finish</div>
              <div class="stage-fee ${variant.entryFee > this.career.money ? 'bad' : ''}">
                ${variant.entryFee === 0 ? 'free to enter' : `entry ${money(variant.entryFee)}`}
              </div>
            </div>
            <button data-action="enter" data-id="${this.career.keyFor(target)}" ${check.allowed ? '' : 'disabled'}>
              ${
                check.allowed
                  ? variant.entryFee === 0
                    ? 'Enter · free'
                    : `Enter · ${money(variant.entryFee)}`
                  : reason
              }
            </button>
          </div>`;
      })
      .join('');

    return `<h3>STAGES</h3>${rows}`;
  }

  /**
   * Paint and number.
   *
   * Next to the turntable rather than in a menu of its own: the whole point is
   * that the car in front of you changes as you press the swatches.
   */
  /**
   * How close the career is to each clean sweep.
   *
   * A milestone nobody can see coming is a milestone nobody is chasing. This is
   * what turns "eleven golds" into "two more".
   */
  private progressPanel(): string {
    const keys = this.career.targets().map((t) => this.career.keyFor(t));
    const rows = sweepProgress(keys, this.career.profile.records)
      .reverse()
      .map(({ medal, have, of }) => {
        const done = have >= of;
        const label = medal === 'finish' ? 'finished' : medal;
        return `
          <div class="sweep${done ? ' is-done' : ''}">
            <span style="color:${MEDAL_TINT[medal] ?? 'inherit'}">${label}</span>
            <div class="sweep-bar"><i style="width:${((have / Math.max(of, 1)) * 100).toFixed(0)}%;background:${MEDAL_TINT[medal] ?? '#8b95a5'}"></i></div>
            <b>${have}/${of}</b>
          </div>`;
      })
      .join('');

    // Practice aids live here rather than on a key, because turning them off is
    // a decision about how you want to play rather than something to do mid-corner.
    const on = this.career.profile.settings.practice;
    const practice = `
      <h3>PRACTICE</h3>
      <button class="wide${on ? ' is-on' : ''}" data-action="practice">
        Restart and rescue: ${on ? 'ON' : 'OFF'}
      </button>
      <p class="hint">
        ${
          on
            ? 'R and Q work in a career run. Off is how a career is meant to be played.'
            : 'A career run has to be finished or retired. Arcade keeps them either way.'
        }
      </p>`;

    return `<h3>PROGRESS</h3><div class="sweeps">${rows}</div>${practice}`;
  }

  private paintPanel(): string {
    const current = this.career.livery;
    const swatches = LIVERIES.map(
      (livery) => `
        <button
          class="swatch${livery.id === current.id ? ' is-on' : ''}"
          data-action="livery"
          data-id="${livery.id}"
          title="${livery.name}"
        >
          <i style="background:#${livery.body.toString(16).padStart(6, '0')}"></i>
          <i style="background:#${livery.accent.toString(16).padStart(6, '0')}"></i>
        </button>`,
    ).join('');

    const numbers = [3, 7, 11, 22, 46, 88]
      .map(
        (n) =>
          `<button class="race-number${n === this.career.raceNumber ? ' is-on' : ''}" data-action="number" data-id="${n}">${n}</button>`,
      )
      .join('');

    return `
      <h3>PAINT</h3>
      <div class="swatches">${swatches}</div>
      <div class="swatch-name">${current.name}</div>
      <h3>NUMBER</h3>
      <div class="race-numbers">${numbers}</div>`;
  }

  private repairsPanel(): string {
    const bill = this.career.repairBill();
    if (bill.total === 0) {
      return `<h3>REPAIRS</h3><p class="dim pad">Nothing to fix. The car is as good as it gets.</p>`;
    }

    const affordable = bill.total <= this.career.money;
    const rows = bill.lines
      .map(
        (line) => `
        <div class="repair-row">
          <span>${line.label}</span>
          <b>${money(line.cost)}</b>
          <button data-action="repair" data-id="${line.id}" ${line.cost <= this.career.money ? '' : 'disabled'}>fix</button>
        </div>`,
      )
      .join('');

    // Fixing only what stops the car starting is the move when money is tight.
    const cost = this.career.essentialsCost();
    const essentials = this.career.carIsDriveable
      ? ''
      : this.career.canSalvage
        ? // The dead end: the car cannot start and the repair that would let it
          // costs more than there is. Salvage is the way out, and it is meant
          // to hurt — everything you have, for a car that only just runs.
          `<p class="dim pad">
             The car cannot start, and the ${money(cost)} to make it start is more
             than you have. A salvage job takes everything left and puts the broken
             parts back together at a quarter strength — enough to earn again.
           </p>
           <button class="wide warn" data-action="salvage">
             Salvage the car · ${money(this.career.money)}
           </button>`
        : `<button class="wide warn" data-action="repair-essentials">
             Repair essentials only · ${money(cost)}
           </button>`;

    return `
      <h3>REPAIRS</h3>
      <div class="repair-list">${rows}</div>
      <div class="repair-total"><span>TOTAL</span><b>${money(bill.total)}</b></div>
      ${essentials}
      <button class="wide" data-action="repair-all" ${affordable ? '' : 'disabled'}>
        ${affordable ? `Repair everything · ${money(bill.total)}` : 'Cannot afford full repair'}
      </button>`;
  }

  private upgradesPanel(): string {
    const rows = UPGRADES.map((upgrade) => {
      const level = levelOf(this.career.upgrades, upgrade.id);
      const cost = nextCost(this.career.upgrades, upgrade.id);
      const pips = Array.from(
        { length: maxLevel(upgrade.id) },
        (_, i) => `<i class="${i < level ? 'on' : ''}"></i>`,
      ).join('');

      return `
        <div class="upgrade-row">
          <div class="upgrade-head">
            <span>${upgrade.label}</span>
            <div class="pips">${pips}</div>
          </div>
          <div class="upgrade-desc">${upgrade.description}</div>
          <button data-action="buy" data-id="${upgrade.id}"
            ${cost !== null && cost <= this.career.money ? '' : 'disabled'}>
            ${cost === null ? 'fully upgraded' : `${money(cost)}`}
          </button>
        </div>`;
    }).join('');

    return `<h3>UPGRADES</h3><div class="upgrade-list">${rows}</div>`;
  }
}
