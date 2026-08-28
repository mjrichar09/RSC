/**
 * Replay and photo mode.
 *
 * Every run is already recorded — the ghost system captures a pose twenty times
 * a second so you can chase your own best lap — and until now that recording
 * was only ever played back as a translucent car to race against. It is a
 * replay, and it was one line away from being usable as one.
 *
 * What this adds is the ability to *look*: scrub, pause, slow it down, swing
 * the camera round an eighth of a turn at a time, zoom in, and take the
 * picture. Every screenshot a player posts is the best advertising this game
 * will ever have, and the shot they want is the one where the bonnet is folded
 * and the car is sideways — a moment that lasted a fifth of a second and that
 * nobody can capture while driving.
 *
 * The camera rule survives intact: still orthographic, still fixed, still
 * eighths of a turn. Photo mode lets the player choose which eighth.
 */

import type { GhostPlayer } from '../sim/replay.js';

export interface ReplayHandle {
  player: GhostPlayer;
  /** Seconds into the run. */
  time: number;
  playing: boolean;
  /** Playback rate: 1 is real time, 0.25 is slow motion. */
  rate: number;
  /** Camera yaw the player has chosen, radians. */
  yaw: number;
  /** Orthographic half-height. */
  zoom: number;
}

const EIGHTH = Math.PI / 4;

export class ReplayUi {
  /** Raised when the player leaves photo mode. */
  onExit: (() => void) | null = null;
  /** Raised on the save key, with the picture the player asked for. */
  onCapture: (() => void) | null = null;

  private readonly root: HTMLElement;
  private readonly hud: HTMLElement;
  private handle: ReplayHandle | null = null;
  private chrome = true;

  constructor(parent: HTMLElement) {
    this.hud = parent;
    this.root = document.createElement('div');
    this.root.className = 'replay';
    parent.appendChild(this.root);

    window.addEventListener('keydown', (event) => this.key(event));
  }

  get active(): boolean {
    return this.handle !== null;
  }

  get state(): ReplayHandle | null {
    return this.handle;
  }

  open(handle: ReplayHandle): void {
    this.handle = handle;
    this.chrome = true;
    this.hud.classList.add('in-replay');
    this.render();
  }

  close(): void {
    this.handle = null;
    this.hud.classList.remove('in-replay', 'no-chrome');
    this.root.innerHTML = '';
  }

  /** Advance the playhead. Returns the time to pose the car at. */
  advance(dt: number): number {
    const handle = this.handle;
    if (!handle) return 0;
    if (handle.playing) {
      handle.time += dt * handle.rate;
      if (handle.time > handle.player.duration) {
        handle.time = handle.player.duration;
        handle.playing = false;
      }
    }
    this.render();
    return handle.time;
  }

  private key(event: KeyboardEvent): void {
    const handle = this.handle;
    if (!handle) return;
    const step = event.shiftKey ? 0.1 : 0.5;

    switch (event.code) {
      case 'Space':
        handle.playing = !handle.playing;
        break;
      case 'ArrowLeft':
        handle.time = Math.max(handle.time - step, 0);
        handle.playing = false;
        break;
      case 'ArrowRight':
        handle.time = Math.min(handle.time + step, handle.player.duration);
        handle.playing = false;
        break;
      case 'ArrowUp':
        handle.rate = Math.min(handle.rate * 2, 2);
        break;
      case 'ArrowDown':
        handle.rate = Math.max(handle.rate / 2, 0.125);
        break;
      case 'BracketLeft':
        handle.yaw -= EIGHTH;
        break;
      case 'BracketRight':
        handle.yaw += EIGHTH;
        break;
      case 'Minus':
        handle.zoom = Math.min(handle.zoom * 1.25, 60);
        break;
      case 'Equal':
        handle.zoom = Math.max(handle.zoom / 1.25, 4);
        break;
      case 'KeyH':
        // Hide the chrome. The picture is the point, and the picture does not
        // want a scrub bar across the bottom of it.
        this.chrome = !this.chrome;
        this.hud.classList.toggle('no-chrome', !this.chrome);
        break;
      case 'KeyS':
        this.onCapture?.();
        break;
      // Not KeyP: the key that opens photo mode is bound in the game's own
      // controls, and both listeners see the same press — so a P handled here
      // as well would open and close it in one keystroke, which is exactly what
      // it did the first time.
      case 'Escape':
        event.preventDefault();
        this.onExit?.();
        return;
      default:
        return;
    }
    event.preventDefault();
    this.render();
  }

  private render(): void {
    const handle = this.handle;
    if (!handle) return;
    const progress = handle.player.duration > 0 ? handle.time / handle.player.duration : 0;

    this.root.innerHTML = `
      <div class="replay-bar">
        <div class="replay-fill" style="width:${(progress * 100).toFixed(1)}%"></div>
      </div>
      <div class="replay-keys">
        <b>${handle.time.toFixed(2)}s</b>
        <span>${handle.playing ? 'playing' : 'paused'} · ${handle.rate}×</span>
        <span><b>Space</b> play · <b>←→</b> scrub · <b>↑↓</b> speed</span>
        <span><b>[ ]</b> turn · <b>−/+</b> zoom · <b>H</b> hide · <b>S</b> save · <b>P</b> back</span>
      </div>`;
  }
}
