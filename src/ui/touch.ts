/**
 * On-screen controls, for playing this on a phone.
 *
 * The shape of it is the one every driving game on a touchscreen converges on,
 * and for a reason: your thumbs are already at the bottom corners of a phone
 * held in landscape, so that is where the controls go, and nothing else may be
 * put there.
 *
 * Steering is a **relative drag**, not a wheel and not a pair of arrows. Put a
 * thumb down anywhere in the left third and slide: the offset from wherever
 * you first touched is the steering angle. That matters more than it sounds.
 * A fixed on-screen wheel demands you look at it to find it; arrows are
 * digital, and this car's whole tyre model is about the region between
 * "straight" and "full lock", which a digital input cannot reach. A relative
 * drag is analogue, needs no aiming, and re-centres itself under your thumb
 * every time you lift.
 *
 * Everything here is pointer events with explicit `pointerId` tracking, which
 * is the only way to get two thumbs working at once — `touchstart` bookkeeping
 * by index breaks the moment a finger lifts in the middle of a corner.
 */

import type { DriverInput } from '../sim/input.js';
import { clamp } from '../sim/math.js';

/**
 * Thumb travel for full lock, as a fraction of the short screen edge.
 *
 * Tuned against the thing that actually limits it: a thumb pivoting from the
 * base can sweep about an inch and a half comfortably without regripping, and
 * asking for more than that means the player runs out of hand mid-corner.
 */
const STEER_TRAVEL = 0.26;
/** How fast the wheel returns to centre once the thumb lifts, per second. */
const STEER_RETURN = 6;
/** Pedal ramp, matched to the keyboard's so neither input is the fast one. */
const PEDAL_RATE = 4.5;
const PEDAL_RELEASE = 7;

interface Stick {
  pointer: number;
  originX: number;
}

/** Remembers that the home-screen advice has been read, so it is said once. */
const IOS_HINT_KEY = 'rsc.iosFullscreenHint';

export class TouchControls {
  readonly root: HTMLElement;
  /** Raised by the on-screen menu button. */
  onMenu: (() => void) | null = null;
  onHandbrakeTap: (() => void) | null = null;

  private steer = 0;
  private throttle = 0;
  private brake = 0;
  private handbrake = 0;
  /** Which pointer is doing what. A thumb can only be in one place at a time. */
  private stick: Stick | null = null;
  private readonly pedals = new Map<number, 'throttle' | 'brake' | 'handbrake'>();
  private wanted = { throttle: 0, brake: 0 };
  private visible = false;
  /** Whether the home-screen note has been read, this session or an earlier one. */
  private dismissed = (() => {
    try {
      return localStorage.getItem(IOS_HINT_KEY) === '1';
    } catch {
      return false;
    }
  })();
  private readonly wheel: HTMLElement;
  private readonly rotate: HTMLElement;
  /** The "add it to your home screen" note, on the one platform that needs it. */
  private readonly ios: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch';
    this.root.innerHTML = `
      <div class="touch-steer" data-touch="steer">
        <div class="touch-wheel"><i></i></div>
        <span>steer</span>
      </div>
      <div class="touch-pedals">
        <button class="touch-btn touch-hand" data-touch="handbrake">HAND</button>
        <button class="touch-btn touch-brake" data-touch="brake">BRAKE</button>
        <button class="touch-btn touch-gas" data-touch="throttle">GO</button>
      </div>
      <button class="touch-menu" data-touch="menu">☰</button>`;
    parent.appendChild(this.root);
    this.wheel = this.root.querySelector('.touch-wheel i')!;

    /*
     * Turn the phone.
     *
     * A portrait viewport on a phone is about 390 px across, which is narrower
     * than the car is on screen — the isometric camera has nowhere to put the
     * road. Rather than build a second layout nobody would enjoy, this asks
     * for the one orientation the game is for, and gets out of the way as soon
     * as it has it.
     */
    this.rotate = document.createElement('div');
    this.rotate.className = 'rotate-me';
    this.rotate.innerHTML = '<div><b>↻</b><span>Turn your phone sideways</span></div>';
    parent.appendChild(this.rotate);

    /*
     * The one thing an iPhone will not do.
     *
     * Safari on iOS has no Fullscreen API on a phone — not a refused promise,
     * no method at all — so there is nothing to call and nothing to retry, and
     * an address bar and a home indicator eat about a fifth of a landscape
     * screen. The only route to a real fullscreen game there is the home
     * screen: launched from an icon the page runs standalone, which the
     * manifest and the `apple-mobile-web-app-capable` meta already ask for.
     *
     * So this says so, once, and then never again. It is advice, not a modal:
     * it sits along the top edge, takes no pointer events away from anything
     * and dismisses itself on a tap.
     */
    this.ios = document.createElement('div');
    this.ios.className = 'ios-fs';
    this.ios.innerHTML =
      '<span>For fullscreen on iPhone: <b>Share</b> → <b>Add to Home Screen</b>, then play from the icon.</span><button type="button">Got it</button>';
    this.ios.querySelector('button')!.addEventListener('click', () => this.dismissIosHint());
    parent.appendChild(this.ios);

    this.root.addEventListener('pointerdown', (event) => this.down(event));
    /*
     * And on the turn into landscape, which is when a player expects it.
     *
     * `orientationchange` is not a user gesture, so this is granted only where
     * the browser still counts the touch that caused the rotation as recent —
     * some do, some do not. Where it does not, the next tap gets it: `main.ts`
     * asks on every touch anywhere, which is a menu tap long before the race.
     */
    window.addEventListener('orientationchange', () => this.onLandscape());
    window
      .matchMedia('(orientation: landscape)')
      .addEventListener('change', (event) => {
        if (event.matches) this.onLandscape();
      });
    // Listened for on the window, not on the button: a thumb that slides off
    // the throttle mid-corner must still release it, and a pointer that leaves
    // the element it started on never fires `pointerup` there.
    window.addEventListener('pointermove', (event) => this.move(event));
    window.addEventListener('pointerup', (event) => this.up(event));
    window.addEventListener('pointercancel', (event) => this.up(event));
    // A long press on a control is not a text selection or a context menu.
    this.root.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  /** Show the controls. Off on a machine with a keyboard until a touch says otherwise. */
  setVisible(on: boolean): void {
    if (this.visible === on) return;
    this.visible = on;
    this.root.classList.toggle('is-on', on);
    this.rotate.classList.toggle('is-on', on);
    if (on) this.showIosHint();
    else {
      this.ios.classList.remove('is-on');
      this.release();
    }
  }

  /**
   * Go fullscreen, on the earliest gesture that can carry it.
   *
   * Browsers only grant this from inside a user gesture, and on Android the
   * address bar is a fifth of a landscape phone's height — so this is worth
   * more here than anywhere else.
   *
   * It used to be asked for on the first thumb on the *steering pad*, which is
   * the first gesture of the race — so Android's "RSC is now full screen"
   * toast landed across the middle of the start countdown, every time. The
   * gesture that can carry it is the first touch anywhere: tapping a menu, a
   * stage, a Go button. By the time the lights run, the toast has been and
   * gone. Best-effort throughout — a refusal changes nothing about the game.
   *
   * iOS Safari on a phone has no Fullscreen API at all, so nothing here can
   * work there; `showIosHint` is what that platform gets instead.
   */
  requestFullscreen(): void {
    if (!this.visible || document.fullscreenElement) return;
    void document.documentElement.requestFullscreen?.().catch(() => {
      // Refused, which several browsers do. The game plays either way.
    });
  }

  /** Landscape: ask for fullscreen, and offer the iOS advice if that is all there is. */
  private onLandscape(): void {
    this.requestFullscreen();
    this.showIosHint();
  }

  /**
   * Show the home-screen note, if this is the platform with no other answer.
   *
   * Feature-detected rather than sniffed for the part that matters — no
   * `requestFullscreen` on the document element is the actual condition, and
   * it is true of exactly the browsers this advice is for. The iOS test on top
   * of it keeps the note off a desktop browser with the API disabled, where
   * "add it to your home screen" would be nonsense.
   */
  private showIosHint(): void {
    if (!this.visible || this.dismissed) return;
    // Typed as always present, and on an iPhone it is simply absent — which is
    // the whole condition this is testing, so the cast is the honest one.
    const api = document.documentElement as { requestFullscreen?: unknown };
    if (api.requestFullscreen) return;
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as { standalone?: boolean }).standalone === true;
    if (standalone) return;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!ios) return;
    this.ios.classList.add('is-on');
  }

  private dismissIosHint(): void {
    this.dismissed = true;
    this.ios.classList.remove('is-on');
    try {
      localStorage.setItem(IOS_HINT_KEY, '1');
    } catch {
      // Private browsing refuses this. Then it is shown again next time, which
      // is a small annoyance and not worth a second storage path.
    }
  }

  get shown(): boolean {
    return this.visible;
  }

  /** Fold this frame's touch state into whatever the keyboard and pad said. */
  merge(input: DriverInput, dt: number): DriverInput {
    if (!this.visible) return input;

    // Pedals ramp rather than switching, for the same reason the keyboard's do:
    // a digital brake locks all four wheels on every stop, and this tyre model
    // rewards not doing that.
    for (const pedal of ['throttle', 'brake'] as const) {
      const target = this.wanted[pedal];
      const rate = (target > this[pedal] ? PEDAL_RATE : PEDAL_RELEASE) * dt;
      this[pedal] = clamp(this[pedal] + clamp(target - this[pedal], -rate, rate), 0, 1);
    }
    if (this.stick === null) {
      this.steer += clamp(-this.steer, -STEER_RETURN * dt, STEER_RETURN * dt);
    }
    this.wheel.style.transform = `translateX(${(this.steer * 34).toFixed(1)}px)`;

    return {
      throttle: Math.max(input.throttle, this.throttle),
      brake: Math.max(input.brake, this.brake),
      handbrake: Math.max(input.handbrake, this.handbrake),
      steer: Math.abs(this.steer) > Math.abs(input.steer) ? this.steer : input.steer,
    };
  }

  /** Drop every held control — leaving the race, opening a menu, losing focus. */
  release(): void {
    this.stick = null;
    this.pedals.clear();
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;
    this.wanted = { throttle: 0, brake: 0 };
    for (const el of this.root.querySelectorAll('.is-held')) el.classList.remove('is-held');
  }

  private down(event: PointerEvent): void {
    const target = (event.target as HTMLElement).closest('[data-touch]') as HTMLElement | null;
    const what = target?.dataset.touch;
    if (!what) return;
    event.preventDefault();

    if (what === 'menu') {
      this.release();
      this.onMenu?.();
      return;
    }
    if (what === 'steer') {
      this.stick = { pointer: event.pointerId, originX: event.clientX };
      // A backstop, not the main path: `main.ts` asks on the first touch
      // anywhere, which is normally a menu tap long before this. Kept because
      // it costs nothing — the request returns immediately once it is granted
      // — and it covers a session that reached the road without one.
      this.requestFullscreen();
      return;
    }
    if (what === 'handbrake') {
      this.handbrake = 1;
      this.pedals.set(event.pointerId, 'handbrake');
      target!.classList.add('is-held');
      this.onHandbrakeTap?.();
      return;
    }
    const pedal = what as 'throttle' | 'brake';
    this.wanted[pedal] = 1;
    this.pedals.set(event.pointerId, pedal);
    target!.classList.add('is-held');
  }

  private move(event: PointerEvent): void {
    const stick = this.stick;
    if (!stick || stick.pointer !== event.pointerId) return;
    event.preventDefault();
    const travel = Math.min(window.innerWidth, window.innerHeight) * STEER_TRAVEL;
    this.steer = clamp((event.clientX - stick.originX) / travel, -1, 1);
  }

  private up(event: PointerEvent): void {
    if (this.stick?.pointer === event.pointerId) this.stick = null;
    const pedal = this.pedals.get(event.pointerId);
    if (pedal === undefined) return;
    this.pedals.delete(event.pointerId);
    // Another finger may still be holding the same control.
    const stillHeld = [...this.pedals.values()].includes(pedal);
    if (stillHeld) return;
    if (pedal === 'handbrake') this.handbrake = 0;
    else this.wanted[pedal] = 0;
    for (const el of this.root.querySelectorAll(`[data-touch="${pedal}"]`)) {
      el.classList.remove('is-held');
    }
  }
}
