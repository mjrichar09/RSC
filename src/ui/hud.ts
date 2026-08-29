/**
 * HUD overlay. Plain DOM on top of the canvas — far faster to build and restyle
 * than in-canvas text, and it costs nothing at this scale.
 */

import { CAR } from '../data/tuning.js';
import type { VehicleState } from '../sim/vehicle.js';

const GEAR_LABEL = (g: number): string => (g === 0 ? 'R' : String(g));

export class Hud {
  private readonly speed: HTMLElement;
  private readonly gear: HTMLElement;
  private readonly rpmFill: HTMLElement;
  private readonly drift: HTMLElement;
  private readonly surfaceEl: HTMLElement;
  private readonly fps: HTMLElement;

  constructor(parent: HTMLElement) {
    // Its own element, appended — not `parent.innerHTML =`, which silently
    // deleted every sibling created before it. The minimap vanished from the
    // page that way, and the only symptom was an element with no parent.
    const root = document.createElement('div');
    root.className = 'hud-basic';
    parent.appendChild(root);
    root.innerHTML = `
      <div class="hud-corner hud-tl">
        <div class="readout"><span id="hud-surface">tarmac</span></div>
        <div class="readout dim"><span id="hud-fps">—</span> fps</div>
      </div>
      <div class="hud-corner hud-br">
        <div class="rpm"><div class="rpm-fill" id="hud-rpm"></div></div>
        <div class="cluster">
          <div class="speed"><span id="hud-speed">0</span><em>km/h</em></div>
          <div class="gear" id="hud-gear">1</div>
        </div>
        <div class="drift" id="hud-drift"></div>
      </div>
      <div class="hud-corner hud-bl help">
        <b>WASD</b> drive · <b>Space</b> handbrake · <b>R</b> restart · <b>Q</b> rescue<br>
        <b>Esc</b> garage · <b>T</b> tuning · <b>M</b> mute · <b>V</b> visibility · <b>K</b> slow-mo
      </div>`;

    this.speed = root.querySelector('#hud-speed')!;
    this.gear = root.querySelector('#hud-gear')!;
    this.rpmFill = root.querySelector('#hud-rpm')!;
    this.drift = root.querySelector('#hud-drift')!;
    this.surfaceEl = root.querySelector('#hud-surface')!;
    this.fps = root.querySelector('#hud-fps')!;
  }

  update(state: VehicleState, fps: number): void {
    this.speed.textContent = Math.abs(state.speed * 3.6).toFixed(0);
    this.gear.textContent = GEAR_LABEL(state.gear);

    const frac = Math.min(state.rpm / CAR.maxRpm, 1);
    this.rpmFill.style.width = `${(frac * 100).toFixed(1)}%`;
    this.rpmFill.classList.toggle('redline', frac > 0.92);

    const deg = (state.driftAngle * 180) / Math.PI;
    // Only shown once the car is genuinely sideways, so it reads as an event
    // rather than as permanent clutter.
    this.drift.textContent = deg > 12 ? `${deg.toFixed(0)}° DRIFT` : '';
    this.drift.classList.toggle('big', deg > 35);

    const ground = state.wheels.find((w) => w.grounded);
    this.surfaceEl.textContent = state.airborne ? 'airborne' : (ground?.surface.id ?? '—');
    this.fps.textContent = fps.toFixed(0);
  }
}
