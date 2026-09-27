/**
 * The gamepad: driving, the actions a keyboard reaches with letters, and the
 * menus.
 *
 * It used to be four lines in `controls.ts` reading the *standard* layout —
 * buttons 6 and 7 for the pedals — which are the triggers on a pad the browser
 * recognises and something else entirely on one it does not. A pad reported
 * with a non-standard mapping (common in Firefox, and for any pad the browser
 * has no table for) puts its triggers on axes that rest at -1, and the buttons
 * at 6 and 7 are often the shoulders. So the pedals were on the bumpers for
 * exactly the players whose pad was least well supported, and nothing let them
 * change it. Every action is now a `Binding`, captured by pressing the control
 * you want, and the non-standard default looks for trigger-shaped axes.
 *
 * It polls on its own animation frame rather than from `frame()` in main.
 * That loop returns early while a menu covers the screen — which is exactly
 * when a pad has to be able to move around the menu.
 *
 * Actions fire on the press, never while held. The old Start-to-restart ran
 * every frame the button was down, so one press was a dozen restarts.
 */

import type { DriverInput } from '../sim/input.js';
import { clamp } from '../sim/math.js';

/** One physical control. An axis maps `from`..`to` onto 0..1. */
export type Binding =
  | { kind: 'button'; index: number }
  | { kind: 'axis'; index: number; from: number; to: number };

export type PadAction =
  | 'steer'
  | 'throttle'
  | 'brake'
  | 'handbrake'
  | 'restart'
  | 'rescue'
  | 'menu';

export type PadBindings = Record<PadAction, Binding>;

/** In the order the controller screen lists them. */
export const PAD_ACTIONS: readonly { id: PadAction; label: string; prompt: string }[] = [
  { id: 'steer', label: 'Steer', prompt: 'Push the steering stick right' },
  { id: 'throttle', label: 'Throttle', prompt: 'Press the throttle' },
  { id: 'brake', label: 'Brake', prompt: 'Press the brake' },
  { id: 'handbrake', label: 'Handbrake', prompt: 'Press the handbrake' },
  { id: 'restart', label: 'Restart', prompt: 'Press the restart button' },
  { id: 'rescue', label: 'Rescue to road', prompt: 'Press the rescue button' },
  { id: 'menu', label: 'Menu / pause', prompt: 'Press the menu button' },
];

/**
 * The standard layout: triggers for the pedals, which is where every driving
 * game on a pad puts them and where a thumb resting on the stick expects them.
 */
export const STANDARD_BINDINGS: PadBindings = {
  steer: { kind: 'axis', index: 0, from: 0, to: 1 },
  throttle: { kind: 'button', index: 7 },
  brake: { kind: 'button', index: 6 },
  handbrake: { kind: 'button', index: 0 },
  restart: { kind: 'button', index: 3 },
  rescue: { kind: 'button', index: 2 },
  menu: { kind: 'button', index: 9 },
};

const DEADZONE = 0.12;
/** How far a control has to move from rest to count as pressed while capturing. */
const CAPTURE_TRAVEL = 0.6;
/** Menu repeat while a direction is held: first delay, then the rate. */
const REPEAT_FIRST = 0.38;
const REPEAT_EVERY = 0.16;

const NAV_BUTTONS = { up: 12, down: 13, left: 14, right: 15, confirm: 0, back: 1 } as const;

const applyDeadzone = (v: number): number =>
  Math.abs(v) < DEADZONE ? 0 : Math.sign(v) * ((Math.abs(v) - DEADZONE) / (1 - DEADZONE));

const same = (a: Binding, b: Binding): boolean =>
  a.kind === b.kind && a.index === b.index;

/**
 * Defaults for a pad the browser does not recognise.
 *
 * Triggers reported as axes rest at -1 and travel to +1, which no stick does,
 * so a pair of axes past the first two sitting at -1 is taken as the triggers:
 * the lower index is the left one. Without that the standard table is the
 * best guess there is, and the controller screen is the answer to a wrong one.
 */
export function defaultBindings(pad: Gamepad): PadBindings {
  if (pad.mapping === 'standard') return { ...STANDARD_BINDINGS };
  const resting = pad.axes
    .map((v, index) => ({ v, index }))
    .filter(({ v, index }) => index >= 2 && v < -0.9)
    .map(({ index }) => index);
  if (resting.length < 2) return { ...STANDARD_BINDINGS };
  return {
    ...STANDARD_BINDINGS,
    brake: { kind: 'axis', index: resting[0]!, from: -1, to: 1 },
    throttle: { kind: 'axis', index: resting[1]!, from: -1, to: 1 },
  };
}

/** How far a binding is pressed, 0..1. For steering, signed -1..1. */
export function readBinding(pad: Gamepad, b: Binding, signed = false): number {
  if (b.kind === 'button') return pad.buttons[b.index]?.value ?? 0;
  const raw = pad.axes[b.index] ?? 0;
  const t = (raw - b.from) / (b.to - b.from);
  return signed ? clamp(t, -1, 1) : clamp(t, 0, 1);
}

/** A short name for a binding, for the controller screen. */
export function describeBinding(b: Binding): string {
  if (b.kind === 'button') {
    const names: Record<number, string> = {
      0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
      8: 'View', 9: 'Menu', 10: 'L3', 11: 'R3', 12: 'D-pad up', 13: 'D-pad down',
      14: 'D-pad left', 15: 'D-pad right',
    };
    return names[b.index] ?? `Button ${b.index}`;
  }
  const direction = b.to > b.from ? '+' : '−';
  return `Axis ${b.index}${direction}`;
}

/** Throw out anything in a stored binding that is not a binding. */
export function cleanBindings(raw: unknown): Partial<PadBindings> {
  const out: Partial<PadBindings> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const index = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 64 ? v : null;
  for (const { id } of PAD_ACTIONS) {
    const b = (raw as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object') continue;
    const i = index(b.index);
    if (i === null) continue;
    if (b.kind === 'button') out[id] = { kind: 'button', index: i };
    else if (
      b.kind === 'axis' &&
      typeof b.from === 'number' &&
      typeof b.to === 'number' &&
      Number.isFinite(b.from) &&
      Number.isFinite(b.to) &&
      Math.abs(b.to - b.from) > 0.1
    ) {
      out[id] = { kind: 'axis', index: i, from: b.from, to: b.to };
    }
  }
  return out;
}

type Direction = 'up' | 'down' | 'left' | 'right';

interface Capture {
  action: PadAction;
  axes: number[];
  buttons: number[];
  resolve: (b: Binding | null) => void;
}

export class GamepadInput {
  /** Raised on the press of each action. */
  onRestart: (() => void) | null = null;
  onRescue: (() => void) | null = null;
  onMenu: (() => void) | null = null;
  /**
   * Raised when any of confirm, back or menu is pressed while a crash replay
   * is playing. Returns true when it consumed the press.
   */
  onSkip: (() => boolean) | null = null;
  /** Back out of whatever panel is open, when it has no Back button of its own. */
  onBack: (() => void) | null = null;
  /** Raised whenever a pad connects, so the UI can say which one it sees. */
  onConnect: ((pad: Gamepad) => void) | null = null;

  /** Custom bindings the player saved. Anything missing takes the default. */
  private custom: Partial<PadBindings> = {};
  private pad: Gamepad | null = null;
  private wasDown = new Map<string, boolean>();
  private held: Direction | null = null;
  private heldFor = 0;
  private repeatAt = 0;
  private last = 0;
  private capture: Capture | null = null;
  private knownPad = '';
  /**
   * Whether the pad is the thing moving around the menus. Set by any pad
   * navigation and cleared by the mouse, so a panel that re-renders under a
   * pad gets its focus back and one being clicked through is left alone.
   */
  private steering = false;

  constructor() {
    window.addEventListener('pointermove', () => {
      this.steering = false;
      for (const old of document.querySelectorAll('.pad-focus')) old.classList.remove('pad-focus');
    });
    const tick = (now: number) => {
      const dt = this.last === 0 ? 0 : Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      this.poll(dt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** True while any pad is connected. */
  get connected(): boolean {
    return this.pad !== null;
  }

  /** The connected pad, for the rumble motors. */
  get current(): Gamepad | null {
    return this.pad;
  }

  get padName(): string {
    return this.pad?.id ?? '';
  }

  setCustom(bindings: Partial<PadBindings>): void {
    this.custom = { ...bindings };
  }

  get customBindings(): Partial<PadBindings> {
    return { ...this.custom };
  }

  /** The bindings actually in force for the connected pad. */
  bindings(): PadBindings {
    const base = this.pad ? defaultBindings(this.pad) : { ...STANDARD_BINDINGS };
    return { ...base, ...this.custom };
  }

  /**
   * Wait for the next control the player moves and return it as a binding.
   * Resolves null if cancelled. Nothing else on the pad acts while waiting.
   */
  captureNext(action: PadAction): Promise<Binding | null> {
    this.cancelCapture();
    return new Promise((resolve) => {
      const pad = this.pad;
      this.capture = {
        action,
        axes: pad ? [...pad.axes] : [],
        buttons: pad ? pad.buttons.map((b) => b.value) : [],
        resolve,
      };
    });
  }

  cancelCapture(): void {
    this.capture?.resolve(null);
    this.capture = null;
  }

  /** The analogue part, merged by `Controls` with the keyboard. */
  driving(): DriverInput | null {
    const pad = this.pad;
    if (!pad || this.capture) return null;
    const b = this.bindings();
    return {
      throttle: readBinding(pad, b.throttle),
      brake: readBinding(pad, b.brake),
      handbrake: readBinding(pad, b.handbrake),
      steer: applyDeadzone(readBinding(pad, b.steer, true)),
    };
  }

  private poll(dt: number): void {
    this.pad = navigator.getGamepads?.().find((p) => p !== null && p.connected) ?? null;
    const pad = this.pad;
    if (!pad) return;
    if (pad.id !== this.knownPad) {
      this.knownPad = pad.id;
      this.onConnect?.(pad);
    }

    if (this.capture) {
      this.pollCapture(pad);
      return;
    }

    const b = this.bindings();
    const pressed = (key: string, down: boolean): boolean => {
      const was = this.wasDown.get(key) ?? false;
      this.wasDown.set(key, down);
      return down && !was;
    };
    const button = (i: number) => (pad.buttons[i]?.value ?? 0) > 0.5;
    const action = (a: PadAction) => readBinding(pad, b[a]) > 0.5;

    const confirm = pressed('confirm', button(NAV_BUTTONS.confirm));
    const back = pressed('back', button(NAV_BUTTONS.back));
    const menu = pressed('menu', action('menu'));
    const restart = pressed('restart', action('restart'));
    const rescue = pressed('rescue', action('rescue'));

    // A crash replay takes any of the buttons a player would reach for to get
    // out of something, and nothing else sees the press.
    if ((confirm || back || menu) && this.onSkip?.()) return;

    const root = navRoot();
    if (root) this.navigate(root, pad, dt, confirm, back);
    else this.held = null;
    if (menu) this.onMenu?.();
    // Restart works from the finish panel too — "again" is the most common
    // thing anybody does there — but not from a menu, where Y is nothing.
    const racing = !root || root.classList.contains('race-panel') || root.classList.contains('awards');
    if (racing && restart) this.onRestart?.();
    if (!root && rescue) this.onRescue?.();
  }

  private pollCapture(pad: Gamepad): void {
    const c = this.capture!;
    // The button that opened the capture is still down on the first frames.
    for (let i = 0; i < pad.buttons.length; i++) {
      const v = pad.buttons[i]!.value;
      const rest = c.buttons[i] ?? 0;
      if (rest > 0.5) {
        if (v < 0.2) c.buttons[i] = 0;
        continue;
      }
      if (v > 0.6) return this.finishCapture({ kind: 'button', index: i });
    }
    for (let i = 0; i < pad.axes.length; i++) {
      const v = pad.axes[i]!;
      const rest = Math.round(c.axes[i] ?? 0);
      if (Math.abs(v - rest) < CAPTURE_TRAVEL) continue;
      // A trigger rests at -1 and travels to +1; a stick rests at 0 and goes
      // to whichever end was pushed. Steering keeps its sign either way, so
      // "push right" defines which end is right.
      const to = rest === 0 ? Math.sign(v) : -rest;
      return this.finishCapture({ kind: 'axis', index: i, from: rest, to });
    }
  }

  private finishCapture(binding: Binding): void {
    const c = this.capture!;
    this.capture = null;
    // Swallow the press that made the binding, so it does not also act.
    for (const key of ['confirm', 'back', 'menu', 'restart', 'rescue']) this.wasDown.set(key, true);
    // One control, one action: the one it used to belong to gets its default.
    for (const { id } of PAD_ACTIONS) {
      const other = this.custom[id];
      if (id !== c.action && other && same(other, binding)) delete this.custom[id];
    }
    this.custom[c.action] = binding;
    c.resolve(binding);
  }

  /**
   * Move around whatever panel is open.
   *
   * Spatial rather than tab order: the garage and the arcade list are grids,
   * and tab order through a grid is a zig-zag that makes "down" mean "right".
   */
  private navigate(root: HTMLElement, pad: Gamepad, dt: number, confirm: boolean, back: boolean): void {
    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    const button = (i: number) => (pad.buttons[i]?.value ?? 0) > 0.5;
    const dir: Direction | null =
      button(NAV_BUTTONS.up) || y < -0.6
        ? 'up'
        : button(NAV_BUTTONS.down) || y > 0.6
          ? 'down'
          : button(NAV_BUTTONS.left) || x < -0.6
            ? 'left'
            : button(NAV_BUTTONS.right) || x > 0.6
              ? 'right'
              : null;

    if (dir || confirm || back) this.steering = true;
    // A panel that re-rendered under the pad took its focus with it. The
    // first press on a panel with nothing lit only lights something: acting
    // on a button the player could not see was chosen is a guess.
    const lit = focused(root) !== null;
    if (this.steering && !lit) {
      const first = visible(root.querySelectorAll<HTMLElement>(FOCUSABLE))[0];
      if (first) setPadFocus(first);
    }

    if (dir !== this.held) {
      this.held = dir;
      this.heldFor = 0;
      this.repeatAt = REPEAT_FIRST;
      if (dir && lit) this.move(root, dir);
    } else if (dir) {
      this.heldFor += dt;
      if (this.heldFor >= this.repeatAt) {
        this.repeatAt += REPEAT_EVERY;
        this.move(root, dir);
      }
    }

    if (confirm && lit) focused(root)?.click();
    if (back) {
      const button = visible(root.querySelectorAll<HTMLElement>('[data-action="back"], [data-pad-back]'))[0];
      if (button) button.click();
      else this.onBack?.();
    }
  }

  private move(root: HTMLElement, dir: Direction): void {
    const current = focused(root);
    // A slider takes left and right for itself.
    if (current instanceof HTMLInputElement && current.type === 'range' && (dir === 'left' || dir === 'right')) {
      const step = Number(current.step) || 1;
      const next = Number(current.value) + (dir === 'right' ? 5 : -5) * step;
      current.value = String(clamp(next, Number(current.min), Number(current.max)));
      current.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const items = visible(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const next = current ? nearest(current, items, dir) : items[0]!;
    if (!next) return;
    setPadFocus(next);
  }
}

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [data-action], [tabindex]:not([tabindex="-1"])';

/** The panel a pad should be moving around, topmost first, or null while driving. */
function navRoot(): HTMLElement | null {
  const order = ['.lobby.is-open', '.menu.is-open', '.garage.is-open', '.race-panel.is-open', '.awards'];
  for (const selector of order) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden') {
      if (visible(el.querySelectorAll<HTMLElement>(FOCUSABLE)).length > 0) return el;
    }
  }
  return null;
}

function visible(list: Iterable<HTMLElement>): HTMLElement[] {
  return [...list].filter((el) => {
    if (el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

function focused(root: HTMLElement): HTMLElement | null {
  const el = root.querySelector<HTMLElement>('.pad-focus');
  if (el && visible([el]).length > 0) return el;
  const active = document.activeElement as HTMLElement | null;
  return active && active !== document.body && root.contains(active) ? active : null;
}

function setPadFocus(el: HTMLElement): void {
  for (const old of document.querySelectorAll('.pad-focus')) old.classList.remove('pad-focus');
  el.classList.add('pad-focus');
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * The best element in a direction: the nearest *row* that way, then the
 * closest element across it.
 *
 * Not one score mixing the two. Weighting sideways distance double made "down"
 * from a full-width button skip a row split into two half-width buttons —
 * both of their centres are off to the side — for a slider straight below it
 * two rows further on, so the second of the pair was unreachable.
 */
function nearest(from: HTMLElement, items: HTMLElement[], dir: Direction): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  const vertical = dir === 'up' || dir === 'down';
  const candidates: { el: HTMLElement; gap: number; across: number }[] = [];
  for (const el of items) {
    if (el === from || el.contains(from) || from.contains(el)) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const along = dir === 'down' ? by - ay : dir === 'up' ? ay - by : dir === 'right' ? bx - ax : ax - bx;
    if (along <= 1) continue;
    // Edge to edge, so a tall element and a short one in the same row agree.
    const gap =
      dir === 'down' ? b.top - a.bottom : dir === 'up' ? a.top - b.bottom : dir === 'right' ? b.left - a.right : a.left - b.right;
    candidates.push({ el, gap: Math.max(gap, 0), across: vertical ? Math.abs(bx - ax) : Math.abs(by - ay) });
  }
  if (candidates.length === 0) return null;
  const row = Math.min(...candidates.map((c) => c.gap)) + 8;
  let best: HTMLElement | null = null;
  let across = Infinity;
  for (const c of candidates) {
    if (c.gap <= row && c.across < across) {
      across = c.across;
      best = c.el;
    }
  }
  return best;
}
