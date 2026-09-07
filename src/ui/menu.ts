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
import { stageVariants, variantKey, type StageDef, type StageVariant } from '../sim/stage.js';
import { formatTime } from './raceHud.js';
import type { BoardEntry, Leaderboard } from '../net/leaderboard.js';

/** Names come from other players, so they are escaped everywhere they land. */
const escapeHtml = (raw: string): string =>
  raw.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export interface ArcadePick {
  def: StageDef;
  variant: StageVariant;
}

type Screen = 'main' | 'arcade' | 'name';

export class StartMenu {
  onCareer: (() => void) | null = null;
  onArcade: ((pick: ArcadePick) => void) | null = null;
  onMultiplayer: (() => void) | null = null;
  /** Raised as the volume slider moves, 0..1. */
  onVolume: ((value: number) => void) | null = null;

  /** Where the slider sits. Set from the saved profile at startup. */
  private volume = 1;

  /**
   * The global board, or null where there is none.
   *
   * Optional in exactly the way the room broker is: a fork with no worker
   * behind it, or a player with no connection, gets an arcade screen with no
   * times on it and everything else working.
   */
  board: Leaderboard | null = null;

  /** Top three per track, filled in after the screen is already on show. */
  private tops = new Map<string, BoardEntry[]>();
  /** Set once the fetch has come back, so "no times yet" is not shown early. */
  private topsLoaded = false;

  /** Put the slider where the saved setting says, without raising a change. */
  setVolume(value: number): void {
    this.volume = Math.min(Math.max(value, 0), 1);
  }

  private readonly root: HTMLElement;
  private readonly career: Career;
  private screen: Screen = 'main';
  private open = false;

  constructor(parent: HTMLElement, career: Career) {
    this.career = career;
    this.root = document.createElement('div');
    this.root.className = 'menu';
    parent.appendChild(this.root);

    // `input` rather than `change`, so the sound follows the thumb instead of
    // waiting for it to be let go — a volume slider you cannot hear while
    // dragging is a volume slider you have to guess at.
    this.root.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | null;
      if (target?.dataset.act !== 'volume') return;
      this.volume = Number(target.value) / 100;
      const readout = this.root.querySelector('.menu-volume b');
      if (readout) {
        readout.textContent = this.volume === 0 ? 'muted' : `${Math.round(this.volume * 100)}%`;
      }
      this.onVolume?.(this.volume);
    });

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
        // A name first, or the board is a list of anonymous numbers. Asked once
        // and remembered; `name` also reaches here from the arcade screen when
        // somebody wants to change it.
        this.screen = this.career.driverName ? 'arcade' : 'name';
        if (this.screen === 'arcade') void this.loadBoards();
        break;
      case 'name':
        this.screen = 'name';
        break;
      case 'save-name': {
        const input = this.root.querySelector('[data-act="name"]') as HTMLInputElement | null;
        const typed = input?.value.trim() ?? '';
        if (!typed) {
          // Refusing is the whole point of the screen, so say so rather than
          // silently doing nothing to a button somebody just pressed.
          input?.classList.add('is-bad');
          input?.focus();
          return;
        }
        void this.career.setDriverName(typed).then(() => {
          this.screen = 'arcade';
          void this.loadBoards();
          this.render();
        });
        return;
      }
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

  /**
   * Fetch every board the arcade screen shows, in one request.
   *
   * Deliberately not awaited by anything that draws: the screen goes up
   * immediately with the times missing and fills them in when they arrive. A
   * stage list that will not open because a leaderboard request is hanging is
   * a far worse bug than a stage list with no times in it.
   */
  private async loadBoards(): Promise<void> {
    if (!this.board) {
      this.topsLoaded = true;
      return;
    }
    const keys = this.arcadePicks().map((p) => variantKey(p.def.id, p.variant.id));
    const boards = await this.board.many(keys, 3);
    this.topsLoaded = true;
    if (boards) this.tops = new Map(Object.entries(boards));
    // Only if the player is still looking at it — they may have driven off by
    // now, and re-rendering a closed menu would throw away a screen they are
    // on the way to.
    if (this.open && this.screen === 'arcade') this.render();
  }

  /** Every stage under every condition, with nothing locked. */
  private arcadePicks(): ArcadePick[] {
    return STAGES.flatMap((def) => stageVariants(def).map((variant) => ({ def, variant })));
  }

  private render(): void {
    this.root.innerHTML =
      this.screen === 'main'
        ? this.mainScreen()
        : this.screen === 'name'
          ? this.nameScreen()
          : this.arcadeScreen();
    if (this.screen === 'name') {
      const input = this.root.querySelector('[data-act="name"]') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    }
  }

  /**
   * Ask who is driving.
   *
   * Once, before the first arcade race, and never again unless it is changed
   * on purpose. Career is not gated on it: nothing there is published, and
   * making somebody name themselves to play alone would be a toll on the mode
   * that has none of the benefit.
   */
  private nameScreen(): string {
    const current = escapeHtml(this.career.driverName);
    return `
      <div class="menu-inner">
        <div class="menu-head">
          <h1 class="menu-title small">DRIVER</h1>
          <button data-action="back">Back</button>
        </div>
        <p class="menu-strap">
          Arcade times go on a global board for each stage. This is the name that
          appears beside yours.
        </p>
        <div class="name-entry">
          <input data-act="name" maxlength="16" placeholder="Your name"
                 value="${current}" autocomplete="off" spellcheck="false" />
          <button class="wide" data-action="save-name">Start racing</button>
        </div>
        <p class="menu-strap dim">
          Sixteen characters. Change it any time from the arcade screen — your
          old times keep the old name.
        </p>
      </div>`;
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
        ${this.volumeRow()}
        <div class="menu-foot">
          <span><b>Esc</b> menu · <b>R</b> restart · <b>Q</b> rescue · <b>T</b> tuning · <b>V</b> visibility · <b>K</b> slow-mo</span>
        </div>
      </div>`;
  }

  /**
   * The volume, on the front screen.
   *
   * Here rather than behind a key, because the M key mutes and nothing else
   * existed — which on a phone means there was no way to turn the sound down at
   * all, only off, and only if you had a keyboard. The menu is reachable from
   * anywhere with Escape or the pause button, which makes it the one place that
   * works on both.
   */
  private volumeRow(): string {
    const percent = Math.round(this.volume * 100);
    return `
      <label class="menu-volume">
        <span>Volume</span>
        <input type="range" min="0" max="100" step="1" value="${percent}" data-act="volume"
               aria-label="Volume">
        <b>${percent === 0 ? 'muted' : `${percent}%`}</b>
      </label>`;
  }

  /** The three fastest, or a word about why there are not three. */
  private boardStrip(key: string): string {
    if (!this.board) return '';
    if (!this.topsLoaded) return '<span class="menu-board dim">loading times…</span>';
    const top = this.tops.get(key) ?? [];
    if (top.length === 0) return '<span class="menu-board dim">no times yet — set the first</span>';
    return `<span class="menu-board">${top
      .map(
        (entry, i) =>
          `<i><u>${i + 1}</u> ${escapeHtml(entry.name)} <b>${formatTime(entry.time)}</b></i>`,
      )
      .join('')}</span>`;
  }

  private arcadeScreen(): string {
    const rows = this.arcadePicks()
      .map((pick) => {
        const record = this.career.recordFor(pick);
        const best = record
          ? `${formatTime(record.time)} · ${record.medal}`
          : '<span class="dim">no time set</span>';
        return `
          <button class="menu-row has-board" data-action="drive" data-id="${pick.def.id}:${pick.variant.id}">
            <span class="menu-row-head">
              <b>${pick.def.name}</b>
              <span class="dim">${pick.variant.name}</span>
              <span class="menu-row-best">${best}</span>
            </span>
            ${this.boardStrip(variantKey(pick.def.id, pick.variant.id))}
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
          Nothing here costs anything and nothing here is kept: the car arrives fixed,
          stock and unmodified, and leaves forgotten. Every arcade car is the same car,
          which is what makes the board worth reading.
          <button class="link" data-action="name">Racing as <b>${escapeHtml(
            this.career.driverName,
          )}</b> — change</button>
        </p>
        <div class="menu-rows">${rows}</div>
      </div>`;
  }
}
