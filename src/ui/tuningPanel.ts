/**
 * Live tuning panel.
 *
 * P1's thesis is that vehicle feel is the whole game, and feel cannot be
 * derived — it has to be dialled in by driving. This panel mutates the live
 * tuning object so a change takes effect on the next physics step, with no
 * reload and no lost momentum, and "Copy" hands back a block that can be pasted
 * straight into `data/tuning.ts`.
 *
 * Telemetry sits alongside the sliders on purpose: the numbers that matter
 * (lateral g, axle balance, wheel loads) are exactly the ones you cannot judge
 * by eye, and they are what the headless sweep tool reports too — so a setup
 * found here can be verified there.
 */

import { CAR, type VehicleTuning } from '../data/tuning.js';
import type { VehicleState } from '../sim/vehicle.js';

type NumericKey = {
  [K in keyof VehicleTuning]: VehicleTuning[K] extends number ? K : never;
}[keyof VehicleTuning];

interface Slider {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

interface Group {
  title: string;
  hint: string;
  sliders: Slider[];
}

const GROUPS: Group[] = [
  {
    title: 'Grip',
    hint: 'Balance >1 favours the front, which loosens the rear. Slide floor is how much force a sliding tire keeps — the drift-controllability dial.',
    sliders: [
      { key: 'tireGrip', label: 'peak grip', min: 0.6, max: 2.2, step: 0.01 },
      { key: 'tireGripBalance', label: 'front/rear balance', min: 0.85, max: 1.25, step: 0.01 },
      { key: 'peakSlipAngle', label: 'peak slip angle', min: 0.08, max: 0.32, step: 0.005 },
      { key: 'peakSlipRatio', label: 'peak slip ratio', min: 0.05, max: 0.3, step: 0.005 },
      { key: 'slideGripFloor', label: 'slide floor', min: 0.4, max: 0.98, step: 0.01 },
    ],
  },
  {
    title: 'Steering',
    hint: 'Full lock much past the peak slip angle just ploughs. Falloff trades high-speed stability for low-speed agility.',
    sliders: [
      { key: 'maxSteerAngle', label: 'max lock', min: 0.2, max: 0.8, step: 0.01 },
      { key: 'steerSpeedFalloff', label: 'falloff at speed', min: 0.1, max: 1, step: 0.01 },
      { key: 'steerSpeedFalloffAt', label: 'falloff speed (m/s)', min: 10, max: 60, step: 1 },
      { key: 'steerRate', label: 'steer rate', min: 1, max: 8, step: 0.1 },
    ],
  },
  {
    title: 'Suspension',
    hint: 'Anti-roll keeps the inside wheels down. Too little and the car corners on two wheels and loses half its grip.',
    sliders: [
      { key: 'suspensionStiffness', label: 'spring', min: 15000, max: 90000, step: 500 },
      { key: 'suspensionDamping', label: 'damper', min: 800, max: 9000, step: 100 },
      { key: 'antiRollStiffness', label: 'anti-roll', min: 0, max: 30000, step: 250 },
    ],
  },
  {
    title: 'Drivetrain',
    hint: 'The LSD biases torque to the wheel that still has grip. More bias rotates the car harder on power.',
    sliders: [
      { key: 'awdRearBias', label: 'rear torque bias', min: 0.2, max: 0.9, step: 0.01 },
      { key: 'lsdLock', label: 'LSD lock', min: 0, max: 80, step: 1 },
      { key: 'lsdBias', label: 'LSD max bias', min: 0, max: 0.5, step: 0.01 },
      { key: 'engineBraking', label: 'engine braking', min: 0, max: 140, step: 2 },
    ],
  },
  {
    title: 'Brakes',
    hint: 'Handbrake grip loss is the rear grip multiplier while it is pulled — lower means it breaks away harder.',
    sliders: [
      { key: 'brakeTorque', label: 'brake torque', min: 1000, max: 7000, step: 50 },
      { key: 'brakeBias', label: 'front bias', min: 0.35, max: 0.85, step: 0.01 },
      { key: 'handbrakeTorque', label: 'handbrake', min: 500, max: 6000, step: 50 },
      { key: 'handbrakeGripLoss', label: 'handbrake grip loss', min: 0.1, max: 1, step: 0.01 },
    ],
  },
  {
    title: 'Body',
    hint: 'Yaw damping is the catchability dial: too little and every slide becomes a spin, too much and the car feels on rails.',
    sliders: [
      { key: 'dragFactor', label: 'drag', min: 0.1, max: 1.2, step: 0.01 },
      { key: 'downforceFactor', label: 'downforce', min: 0, max: 1.5, step: 0.01 },
      { key: 'yawDamping', label: 'yaw damping', min: 0, max: 6000, step: 50 },
    ],
  },
];

const AXLE = ['FL', 'FR', 'RL', 'RR'];

/**
 * Write a numeric tuning field. `NumericKey` already guarantees the field is a
 * number, but VehicleTuning has no index signature, so the write needs a cast.
 */
function setNumber(tuning: VehicleTuning, key: NumericKey, value: number): void {
  (tuning as unknown as Record<NumericKey, number>)[key] = value;
}

export class TuningPanel {
  private readonly root: HTMLElement;
  private readonly host: HTMLElement;
  private readonly inputs = new Map<NumericKey, HTMLInputElement>();
  private readonly values = new Map<NumericKey, HTMLElement>();
  private readonly telemetry: HTMLElement;
  private tuning: VehicleTuning;
  private open = false;

  constructor(parent: HTMLElement, tuning: VehicleTuning) {
    this.tuning = tuning;

    this.root = document.createElement('div');
    this.root.className = 'tuning';
    this.root.innerHTML = `
      <header>
        <b>TUNING</b>
        <span class="muted">T to hide</span>
      </header>
      <div class="tuning-telemetry" id="tune-telemetry"></div>
      <div class="tuning-body"></div>
      <footer>
        <button data-act="reset">Reset</button>
        <button data-act="copy">Copy setup</button>
        <span class="muted" id="tune-status"></span>
      </footer>`;

    const body = this.root.querySelector('.tuning-body') as HTMLElement;
    this.telemetry = this.root.querySelector('#tune-telemetry') as HTMLElement;

    for (const group of GROUPS) {
      const section = document.createElement('section');
      section.innerHTML = `<h4>${group.title}</h4><p class="hint">${group.hint}</p>`;
      for (const slider of group.sliders) {
        section.appendChild(this.buildSlider(slider));
      }
      body.appendChild(section);
    }

    this.root.querySelector('[data-act="reset"]')!.addEventListener('click', () => this.reset());
    this.root.querySelector('[data-act="copy"]')!.addEventListener('click', () => this.copy());

    this.host = parent;
    parent.appendChild(this.root);
    this.setOpen(false);
  }

  private buildSlider(slider: Slider): HTMLElement {
    const row = document.createElement('label');
    row.className = 'tuning-row';

    const name = document.createElement('span');
    name.className = 'tuning-name';
    name.textContent = slider.label;

    const value = document.createElement('span');
    value.className = 'tuning-value';

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(slider.min);
    input.max = String(slider.max);
    input.step = String(slider.step);
    input.value = String(this.tuning[slider.key]);

    input.addEventListener('input', () => {
      // Mutating the live tuning object means the change lands on the next
      // physics step — no reload, no losing the corner you were mid-way through.
      setNumber(this.tuning, slider.key, Number(input.value));
      this.renderValue(slider);
    });

    row.append(name, input, value);
    this.inputs.set(slider.key, input);
    this.values.set(slider.key, value);
    this.renderValue(slider);
    return row;
  }

  private renderValue(slider: Slider): void {
    const raw = this.tuning[slider.key] as number;
    const el = this.values.get(slider.key)!;
    el.textContent = slider.step >= 1 ? raw.toFixed(0) : raw.toFixed(slider.step < 0.01 ? 3 : 2);
    el.classList.toggle('changed', Math.abs(raw - (CAR[slider.key] as number)) > 1e-9);
  }

  /** Point the panel at a new vehicle's tuning after a world rebuild. */
  rebind(tuning: VehicleTuning): void {
    this.tuning = tuning;
    this.syncInputs();
  }

  private syncInputs(): void {
    for (const group of GROUPS) {
      for (const slider of group.sliders) {
        this.inputs.get(slider.key)!.value = String(this.tuning[slider.key]);
        this.renderValue(slider);
      }
    }
  }

  private reset(): void {
    for (const group of GROUPS) {
      for (const slider of group.sliders) {
        setNumber(this.tuning, slider.key, CAR[slider.key] as number);
      }
    }
    this.syncInputs();
    this.status('reset to defaults');
  }

  private copy(): void {
    // Only the values that actually differ, so what comes back is a diff to
    // apply rather than a wall of unchanged numbers.
    const changed: string[] = [];
    for (const group of GROUPS) {
      for (const slider of group.sliders) {
        const now = this.tuning[slider.key] as number;
        if (Math.abs(now - (CAR[slider.key] as number)) > 1e-9) {
          changed.push(`  ${slider.key}: ${now},`);
        }
      }
    }
    const text = changed.length > 0 ? changed.join('\n') : '// no changes from defaults';
    // Also logged, because clipboard access is blocked in some contexts and the
    // console copy is never lost.
    console.log(`/* paste into data/tuning.ts CAR */\n${text}`);
    void navigator.clipboard?.writeText(text).then(
      () => this.status(`copied ${changed.length} value(s)`),
      () => this.status('logged to console'),
    );
  }

  private status(message: string): void {
    const el = this.root.querySelector('#tune-status') as HTMLElement;
    el.textContent = message;
    window.setTimeout(() => {
      if (el.textContent === message) el.textContent = '';
    }, 2500);
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle('is-open', open);
    // Shift the HUD clear of the panel so the speed readout stays legible.
    this.host.classList.toggle('has-tuning', open);
  }

  /** Live readout of the numbers you cannot judge by eye. */
  update(state: VehicleState): void {
    if (!this.open) return;

    const lateralG = Math.abs(state.speed * state.yawRate) / 9.81;
    const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1);
    const axle = (i: number) =>
      (Math.abs(state.wheels[i]!.slipAngle) + Math.abs(state.wheels[i + 1]!.slipAngle)) / 2;
    const balance = ((axle(0) - axle(2)) * 180) / Math.PI;

    const wheels = state.wheels
      .map(
        (w, i) =>
          `<tr><td>${AXLE[i]}</td><td>${w.load.toFixed(0)}</td>` +
          `<td>${deg(w.slipAngle)}°</td><td class="${w.saturation > 1 ? 'hot' : ''}">${w.saturation.toFixed(2)}</td></tr>`,
      )
      .join('');

    this.telemetry.innerHTML = `
      <div class="tel-row"><span>lateral</span><b>${lateralG.toFixed(2)} g</b></div>
      <div class="tel-row"><span>balance</span><b class="${balance > 0.5 ? 'under' : balance < -0.5 ? 'over' : ''}">${
        balance > 0.5 ? 'understeer' : balance < -0.5 ? 'oversteer' : 'neutral'
      } ${balance.toFixed(1)}°</b></div>
      <div class="tel-row"><span>drift</span><b>${deg(state.driftAngle)}°</b></div>
      <table><tr><th></th><th>load N</th><th>slip</th><th>sat</th></tr>${wheels}</table>`;
  }
}
