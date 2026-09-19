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
import { escapeHtml } from './escape.js';

export interface ArcadePick {
  def: StageDef;
  variant: StageVariant;
}

type Screen = 'main' | 'arcade' | 'name' | 'help';

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
  /** Which door sent us to the name screen, so it can be gone through after. */
  private after: 'arcade' | 'multiplayer' = 'arcade';

  /** Raised when a name is set here, so one identity is kept across the game. */
  onName: ((name: string) => void) | null = null;

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
        this.after = 'arcade';
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
          this.onName?.(typed);
          // Back to whichever door asked for the name, rather than always to
          // arcade — being made to name yourself and then landing somewhere
          // you were not going is a small betrayal of the click.
          if (this.after === 'multiplayer') {
            this.setOpen(false);
            this.onMultiplayer?.();
            return;
          }
          this.screen = 'arcade';
          void this.loadBoards();
          this.render();
        });
        return;
      }
      case 'multiplayer':
        // Same gate as arcade, for the same reason: a multiplayer race is
        // driven in the stock car and its times go on the same board, so it
        // needs the same name behind it. `after` is what the name screen goes
        // to once it has one.
        if (!this.career.driverName) {
          this.after = 'multiplayer';
          this.screen = 'name';
          break;
        }
        this.setOpen(false);
        this.onMultiplayer?.();
        return;
      case 'help':
        this.screen = 'help';
        break;
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
    if (!this.open || this.screen !== 'arcade') return;

    // Patched in place rather than re-rendered, for the same reason the lobby
    // is: `render()` replaces every row, so a reply arriving while somebody is
    // reaching for a stage destroys the row under their finger. The reply lands
    // a few hundred milliseconds after the screen opens, which is exactly when
    // the first tap happens.
    for (const row of Array.from(this.root.querySelectorAll<HTMLElement>('.menu-row'))) {
      const slot = row.querySelector('.menu-board');
      const key = row.dataset.id;
      if (slot && key) slot.outerHTML = this.boardStrip(key);
    }
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
          : this.screen === 'help'
            ? this.helpScreen()
            : this.arcadeScreen();
    if (this.screen === 'name') {
      const input = this.root.querySelector('[data-act="name"]') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    }
  }

  /**
   * How to play.
   *
   * Reachable from the front screen and nowhere else: it is read once, and a
   * help button on every panel is the clutter it exists to remove. The
   * keyboard bindings live here in full, which is what let the permanent
   * on-screen list at the bottom-left shrink to three.
   *
   * Static markup on purpose — nothing here reads game state, so there is
   * nothing to keep in step with the rest of the UI. The one thing that would
   * rot is the numbers: full lock and the dead zone are stated because a
   * player tilting a phone needs to know how far, and if `ui/tilt.ts` moves
   * them this text is wrong.
   */
  private helpScreen(): string {
    return `
      <div class="menu-inner">
        <div class="menu-head">
          <h1 class="menu-title small">HOW TO PLAY</h1>
          <button data-action="back">Back</button>
        </div>
        <div class="menu-scroll help-doc">
          <p>
            Timed single-car runs on point-to-point rally stages. One car on the
            stage at a time: you are racing the clock, not another car. Tires
            have a grip limit, the body takes damage, and damage costs money.
          </p>

          <h2>Modes</h2>
          <dl>
            <dt>Career</dt>
            <dd>
              Your car and your money. Stages charge an entry fee and pay out by
              medal. Damage persists between runs until you pay to repair it.
              Medals unlock harder stages and conditions.
            </dd>
            <dt>Arcade</dt>
            <dd>
              Any unlocked stage and conditions, stock car, nothing saved. Every
              arcade car is identical, so these are the only times that go on
              the world leaderboard.
            </dd>
            <dt>Multiplayer</dt>
            <dd>
              Up to 4 cars, same stage, live. One player hosts; others join with
              a 6-character room code or a pasted invite code. Stock cars.
              Nothing carries back to a career.
            </dd>
          </dl>

          <h2>Controls</h2>
          <table class="help-keys">
            <tr><th></th><th>Keyboard</th><th>Touch</th></tr>
            <tr><td>Steer</td><td><b>A</b> <b>D</b> or <b>&larr;</b> <b>&rarr;</b></td><td>Drag in the left third</td></tr>
            <tr><td>Throttle</td><td><b>W</b> or <b>&uarr;</b></td><td>GO</td></tr>
            <tr><td>Brake</td><td><b>S</b> or <b>&darr;</b></td><td>BRAKE</td></tr>
            <tr><td>Handbrake</td><td><b>Space</b></td><td>HAND</td></tr>
            <tr><td>Restart</td><td><b>R</b></td><td>&#8634; under the menu button</td></tr>
            <tr><td>Rescue to road</td><td><b>Q</b></td><td>&mdash;</td></tr>
            <tr><td>Menu</td><td><b>Esc</b></td><td>&#9776;</td></tr>
            <tr><td>Tuning panel</td><td><b>T</b></td><td>&mdash;</td></tr>
            <tr><td>Mute / visibility / slow-mo</td><td><b>M</b> <b>V</b> <b>K</b></td><td>&mdash;</td></tr>
          </table>
          <p>
            Gamepads work if connected. Steering is analogue in both schemes &mdash;
            key presses ramp, drag distance maps to lock angle. Restart and
            rescue are disabled in career runs.
          </p>
          <p>The handbrake rotates the car; it does not stop it.</p>

          <h2>Tilt steering (phone)</h2>
          <p><b>TILT</b> at the top of the screen switches steering from drag to tilt.</p>
          <ul>
            <li>The pose you are holding when you enable it becomes center. It calibrates to you, not to level.</li>
            <li>Roll &plusmn;35&deg; for full lock. Dead zone is &plusmn;2.2&deg;.</li>
            <li>The drag pad stays live and overrides tilt while a thumb is down.</li>
            <li>Tap twice to re-center after changing grip or turning the phone around.</li>
            <li>iOS asks permission on first use; the grant lasts the session.</li>
          </ul>

          <h2>Display</h2>
          <ul>
            <li><b>Top left</b> &mdash; surface, world record, personal best, car condition (temp / brake / fuel).</li>
            <li><b>Top center</b> &mdash; clock, delta to your best, medal you are currently on pace for.</li>
            <li><b>Bottom center</b> &mdash; stage progress and checkpoint splits.</li>
            <li><b>Bottom left</b> &mdash; next two corners. Severity <b>1</b> is a hairpin, <b>6</b> is flat.</li>
            <li><b>Bottom right</b> &mdash; speed and gear.</li>
          </ul>

          <h2>Rules</h2>
          <ul>
            <li>Missing a checkpoint invalidates the run. The HUD says so immediately.</li>
            <li>Weather and time of day change grip and visibility, not just appearance.</li>
            <li>Medal times come from measured laps of each stage.</li>
            <li>Career damage carries to the next start line.</li>
          </ul>
        </div>
      </div>`;
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
    const money = this.career.money.toLocaleString('en-US');
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
        <button class="menu-aux" data-action="help">How to play</button>
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
