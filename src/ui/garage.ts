/**
 * The garage: stage select, repairs and upgrades.
 *
 * This is where the economy becomes a decision rather than a number. The three
 * panels are deliberately on one screen, because the interesting choice is a
 * comparison between them — a new gearbox, or fixing the radiator and entering
 * the stage that pays for it.
 */

import { Career, type RaceTarget } from '../game/career.js';
import { UPGRADES, levelOf, maxLevel, nextCost } from '../game/garage.js';
import { formatTime } from './raceHud.js';

const MEDAL_TINT: Record<string, string> = {
  author: '#b06bff',
  gold: '#f2c14e',
  silver: '#c8d0d9',
  bronze: '#cd8642',
  finish: '#8b95a5',
};

const money = (n: number): string => `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-GB')}`;

export class Garage {
  private readonly root: HTMLElement;
  private readonly career: Career;
  private open = false;

  /** Raised when the player commits to a stage under particular conditions. */
  onEnter: ((target: RaceTarget) => void) | null = null;

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
      case 'repair-all':
        await this.career.repairAll();
        break;
      case 'repair-essentials':
        await this.career.repairEssentials();
        break;
      case 'repair':
        await this.career.repairComponent(id as never);
        break;
      case 'buy':
        await this.career.buy(id as never);
        break;
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
          <div class="garage-money"><span>FUNDS</span><b>${money(this.career.money)}</b></div>
        </header>
        ${this.warningsPanel()}
        <div class="garage-cols">
          <section>${this.stagesPanel()}</section>
          <section>${this.repairsPanel()}</section>
          <section>${this.upgradesPanel()}</section>
        </div>
        <footer class="garage-foot">
          <span><b>1</b>–<b>${Math.min(9, this.career.targets().length)}</b> enter stage · <b>Esc</b> close</span>
          <button data-action="close">Close</button>
        </footer>
      </div>`;
  }

  /**
   * What is actually wrong, in words, above everything else.
   *
   * A condition percentage is not a warning — "Car at 93%" was what the garage
   * said while the radiator was holed and the next two races were guaranteed to
   * end in an overheat. The player has to be able to make the repair decision
   * knowing what declining it costs.
   */
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

        return `
          <div class="stage-row ${check.allowed ? '' : 'locked'}">
            <div class="stage-key">${key}</div>
            <div class="stage-body">
              <div class="stage-name">${def.name} <span class="dim">· ${variant.name}</span></div>
              <div class="stage-meta">${def.biome} · ${variant.entryFee === 0 ? 'free entry' : `entry ${money(variant.entryFee)}`}${
                check.reason === 'locked' ? ` · <span class="locked-note">locked</span>` : ''
              }</div>
              <div class="stage-meta">${best}</div>
            </div>
            <div class="stage-pay">
              <div><b style="color:${MEDAL_TINT.gold}">${money(variant.payouts.gold)}</b> gold</div>
              <div class="dim">${money(variant.payouts.finish)} finish</div>
            </div>
            <button data-action="enter" data-id="${this.career.keyFor(target)}" ${check.allowed ? '' : 'disabled'}>
              ${check.allowed ? 'Enter' : reason}
            </button>
          </div>`;
      })
      .join('');

    return `<h3>STAGES</h3>${rows}`;
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
    const essentials = this.career.carIsDriveable
      ? ''
      : `<button class="wide warn" data-action="repair-essentials">Repair essentials only</button>`;

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
