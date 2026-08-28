/**
 * The front door.
 *
 * The game used to open straight into the garage, which meant the first thing
 * it asked was "which stage will you spend money on" — a fine second question
 * and a strange first one. It also left the other two ways to play effectively
 * undiscoverable: arcade did not exist, and multiplayer was a key nobody had
 * been told about.
 *
 * Three ways in, and the difference between them is what happens to the car:
 *
 * - **Career** keeps it. Damage carries, repairs cost money, stages unlock.
 * - **Arcade** does not. Every stage and every condition is open, entry is
 *   free, the car starts fixed, and nothing you do to it follows you out.
 * - **Multiplayer** is up to three other people in the same world.
 */

import { STAGES } from '../data/stages/index.js';
import type { Career } from '../game/career.js';
import { stageVariants, type StageDef, type StageVariant } from '../sim/stage.js';
import { formatTime } from './raceHud.js';

export interface ArcadePick {
  def: StageDef;
  variant: StageVariant;
}

type Screen = 'main' | 'arcade';

export class StartMenu {
  onCareer: (() => void) | null = null;
  onArcade: ((pick: ArcadePick) => void) | null = null;
  onMultiplayer: (() => void) | null = null;

  private readonly root: HTMLElement;
  private readonly career: Career;
  private screen: Screen = 'main';
  private open = false;

  constructor(parent: HTMLElement, career: Career) {
    this.career = career;
    this.root = document.createElement('div');
    this.root.className = 'menu';
    parent.appendChild(this.root);

    this.root.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (target) this.handle(target.dataset.action!, target.dataset.id ?? '');
    });

    this.setOpen(false);
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean, screen: Screen = 'main'): void {
    this.open = open;
    if (open) this.screen = screen;
    this.root.classList.toggle('is-open', open);
    this.root.parentElement?.classList.toggle('in-menu', open);
    if (open) this.render();
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  private handle(action: string, id: string): void {
    switch (action) {
      case 'career':
        this.setOpen(false);
        this.onCareer?.();
        return;
      case 'arcade':
        this.screen = 'arcade';
        break;
      case 'multiplayer':
        this.setOpen(false);
        this.onMultiplayer?.();
        return;
      case 'back':
        this.screen = 'main';
        break;
      case 'drive': {
        const pick = this.arcadePicks().find((p) => `${p.def.id}:${p.variant.id}` === id);
        if (pick) {
          this.setOpen(false);
          this.onArcade?.(pick);
        }
        return;
      }
    }
    this.render();
  }

  /** Every stage under every condition, with nothing locked. */
  private arcadePicks(): ArcadePick[] {
    return STAGES.flatMap((def) => stageVariants(def).map((variant) => ({ def, variant })));
  }

  private render(): void {
    this.root.innerHTML =
      this.screen === 'main' ? this.mainScreen() : this.arcadeScreen();
  }

  private mainScreen(): string {
    const medals = this.career.medalsHeld;
    const money = this.career.money.toLocaleString('en-GB');
    return `
      <div class="menu-inner">
        <div class="menu-mark">RSC</div>
        <h1 class="menu-title">RALLY STAGE CHALLENGE</h1>
        <p class="menu-strap">Point to point, one car at a time, and everything you break stays broken.</p>
        <div class="menu-choices">
          <button class="menu-choice" data-action="career">
            <b>Career</b>
            <span>Earn, repair, upgrade, unlock. The car carries its damage between races.</span>
            <em>${money} in hand · ${medals} medal${medals === 1 ? '' : 's'}</em>
          </button>
          <button class="menu-choice" data-action="arcade">
            <b>Arcade</b>
            <span>Every stage and every condition, open from the start. Free entry, fresh car, no consequences.</span>
            <em>${this.arcadePicks().length} races</em>
          </button>
          <button class="menu-choice" data-action="multiplayer">
            <b>Multiplayer</b>
            <span>Up to four cars in one world, contact and all. Host a race or join one with an invite code.</span>
            <em>direct connection, no server</em>
          </button>
        </div>
        <div class="menu-foot">
          <span><b>Esc</b> menu · <b>R</b> restart · <b>Q</b> rescue · <b>T</b> tuning · <b>V</b> visibility</span>
        </div>
      </div>`;
  }

  private arcadeScreen(): string {
    const rows = this.arcadePicks()
      .map((pick) => {
        const record = this.career.recordFor(pick);
        const best = record
          ? `${formatTime(record.time)} · ${record.medal}`
          : '<span class="dim">no time set</span>';
        return `
          <button class="menu-row" data-action="drive" data-id="${pick.def.id}:${pick.variant.id}">
            <b>${pick.def.name}</b>
            <span class="dim">${pick.variant.name}</span>
            <span class="menu-row-best">${best}</span>
          </button>`;
      })
      .join('');

    return `
      <div class="menu-inner">
        <div class="menu-head">
          <h1 class="menu-title small">ARCADE</h1>
          <button data-action="back">Back</button>
        </div>
        <p class="menu-strap">
          Nothing here costs anything and nothing here is kept: the car arrives fixed
          and leaves forgotten. Your career's best time is shown to chase.
        </p>
        <div class="menu-rows">${rows}</div>
      </div>`;
  }
}
