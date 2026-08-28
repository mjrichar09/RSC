/**
 * Damage readout.
 *
 * The design safeguard that keeps a punishing damage model from feeling
 * arbitrary: every consequence has to be visible the moment it happens and
 * legible at a glance afterwards. A car silhouette with colour-coded zones
 * answers "what is broken and how badly" without reading a table, and the
 * toasts answer "what just happened" while it is still happening.
 */

import {
  COMPONENTS,
  type ComponentId,
  type DamageEvent,
  type DamageModel,
} from '../sim/damage.js';

/** Zones drawn on the silhouette, and the components each one summarises. */
const ZONES: { id: string; label: string; x: number; y: number; w: number; h: number; parts: ComponentId[] }[] = [
  { id: 'nose', label: 'Front', x: 26, y: 8, w: 48, h: 22, parts: ['panelFront', 'cooling', 'lights', 'bonnet', 'wingFL', 'wingFR'] },
  { id: 'engine', label: 'Engine', x: 30, y: 32, w: 40, h: 26, parts: ['engine', 'turbo'] },
  { id: 'cabin', label: 'Cabin', x: 30, y: 60, w: 40, h: 30, parts: ['panelRoof', 'transmission', 'steering', 'windscreen', 'doorL', 'doorR'] },
  { id: 'rear', label: 'Rear', x: 26, y: 92, w: 48, h: 22, parts: ['panelRear', 'differential', 'fuelLine', 'boot', 'quarterRL', 'quarterRR', 'exhaust'] },
  { id: 'fl', label: 'FL', x: 2, y: 26, w: 20, h: 26, parts: ['suspensionFL', 'hubFL', 'tyreFL', 'brakeFL'] },
  { id: 'fr', label: 'FR', x: 78, y: 26, w: 20, h: 26, parts: ['suspensionFR', 'hubFR', 'tyreFR', 'brakeFR'] },
  { id: 'rl', label: 'RL', x: 2, y: 72, w: 20, h: 26, parts: ['suspensionRL', 'hubRL', 'tyreRL', 'brakeRL'] },
  { id: 'rr', label: 'RR', x: 78, y: 72, w: 20, h: 26, parts: ['suspensionRR', 'hubRR', 'tyreRR', 'brakeRR'] },
];

const LABEL: Record<string, string> = {
  'engine-seized': 'ENGINE SEIZED',
  overheated: 'OVERHEATED',
  'driveshaft-snapped': 'DRIVESHAFT SNAPPED',
  'out-of-fuel': 'OUT OF FUEL',
  'wheel-lost-FL': 'FRONT LEFT WHEEL LOST',
  'wheel-lost-FR': 'FRONT RIGHT WHEEL LOST',
  'wheel-lost-RL': 'REAR LEFT WHEEL LOST',
  'wheel-lost-RR': 'REAR RIGHT WHEEL LOST',
};

/**
 * Green through amber to red as a component's health falls.
 *
 * The ramp is deliberately steep. A linear hue mapping leaves a part at 80%
 * health looking healthy green, which hides exactly the damage the player most
 * needs to notice — the kind that is degrading the car right now without having
 * broken anything yet.
 */
function healthColor(health: number): string {
  const h = Math.max(health, 0);
  const hue = 130 * Math.pow(h, 2.4);
  const light = 30 + 20 * h;
  return `hsl(${hue.toFixed(0)} 68% ${light.toFixed(0)}%)`;
}

export class DamagePanel {
  private readonly root: HTMLElement;
  private readonly zones = new Map<string, SVGRectElement>();
  private readonly temp: HTMLElement;
  private readonly fuel: HTMLElement;
  private readonly tempFill: HTMLElement;
  private readonly brake: HTMLElement;
  private readonly brakeFill: HTMLElement;
  private readonly fuelFill: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly worst: HTMLElement;

  /** Health last drawn per zone, so the DOM is only touched when it changes. */
  private lastHealth = new Map<string, number>();
  private shownFailures = new Set<string>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'damage';
    this.root.innerHTML = `
      <div class="damage-title">CONDITION</div>
      <svg class="damage-car" viewBox="0 0 100 120" aria-hidden="true">
        ${ZONES.map(
          (z) =>
            `<rect data-zone="${z.id}" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="3"></rect>`,
        ).join('')}
      </svg>
      <div class="damage-worst" id="damage-worst"></div>
      <div class="gauge"><span>TEMP</span><div class="gauge-bar"><i id="gauge-temp"></i></div><b id="gauge-temp-v"></b></div>
      <div class="gauge"><span>BRAKE</span><div class="gauge-bar"><i id="gauge-brake"></i></div><b id="gauge-brake-v"></b></div>
      <div class="gauge"><span>FUEL</span><div class="gauge-bar"><i id="gauge-fuel"></i></div><b id="gauge-fuel-v"></b></div>
      <div class="damage-toasts" id="damage-toasts"></div>`;
    parent.appendChild(this.root);

    for (const z of ZONES) {
      this.zones.set(z.id, this.root.querySelector(`[data-zone="${z.id}"]`)!);
    }
    this.tempFill = this.root.querySelector('#gauge-temp')!;
    this.brakeFill = this.root.querySelector('#gauge-brake')!;
    this.brake = this.root.querySelector('#gauge-brake-v')!;
    this.fuelFill = this.root.querySelector('#gauge-fuel')!;
    this.temp = this.root.querySelector('#gauge-temp-v')!;
    this.fuel = this.root.querySelector('#gauge-fuel-v')!;
    this.toasts = this.root.querySelector('#damage-toasts')!;
    this.worst = this.root.querySelector('#damage-worst')!;
  }

  reset(): void {
    this.lastHealth.clear();
    this.shownFailures.clear();
    this.toasts.innerHTML = '';
  }

  update(damage: DamageModel): void {
    for (const zone of ZONES) {
      // A zone shows its worst part: one destroyed component matters more than
      // three healthy ones next to it.
      const health = Math.min(...zone.parts.map((p) => damage.get(p)));
      if (this.lastHealth.get(zone.id) === health) continue;
      this.lastHealth.set(zone.id, health);

      const rect = this.zones.get(zone.id)!;
      // Inline style, not a presentation attribute: the stylesheet's `fill`
      // rule outranks an attribute, so setAttribute here would silently do
      // nothing and every zone would stay green however wrecked the car was.
      rect.style.fill = healthColor(health);
      rect.classList.toggle('critical', health <= 0);
    }

    const t = Math.min(damage.temperature, 1);
    this.tempFill.style.width = `${(t * 100).toFixed(0)}%`;
    this.tempFill.classList.toggle('hot', damage.temperature > 0.8);
    this.temp.textContent = `${(damage.temperature * 120).toFixed(0)}°`;

    // Brakes: the hottest disc, in the units the model works in. Fade is
    // otherwise invisible — the pedal simply stops working and there is nothing
    // on screen to explain why.
    const hottest = Math.max(...damage.brakeTemp);
    const worstFade = Math.min(damage.brakeFade(0), damage.brakeFade(1), damage.brakeFade(2), damage.brakeFade(3));
    this.brakeFill.style.width = `${Math.min((hottest / 800) * 100, 100).toFixed(0)}%`;
    this.brakeFill.classList.toggle('hot', worstFade < 0.98);
    this.brake.textContent = `${hottest.toFixed(0)}°`;

    const f = damage.fuel / damage.fuelCapacity;
    this.fuelFill.style.width = `${(f * 100).toFixed(0)}%`;
    this.fuelFill.classList.toggle('hot', f < 0.15);
    this.fuel.textContent = `${damage.fuel.toFixed(0)}L`;

    // The single worst component, named. "Something is broken" is not useful;
    // "Radiator 0%" tells you why the temperature is climbing.
    let worst = COMPONENTS[0]!;
    for (const c of COMPONENTS) if (damage.get(c.id) < damage.get(worst.id)) worst = c;
    const worstHealth = damage.get(worst.id);
    this.worst.textContent = worstHealth > 0.98 ? '' : `${worst.label} ${(worstHealth * 100).toFixed(0)}%`;
    this.worst.style.color = worstHealth > 0.98 ? '' : healthColor(worstHealth);

    for (const failure of damage.failures) {
      if (this.shownFailures.has(failure)) continue;
      this.shownFailures.add(failure);
      this.toast(LABEL[failure] ?? failure.toUpperCase(), true);
    }
  }

  /** Show what just broke, while the impact is still on screen. */
  report(events: DamageEvent[]): void {
    // Collapse an impact's many small component hits into its worst one, or the
    // player gets a wall of text every time they brush a bank.
    const significant = events.filter((e) => e.amount > 0.04);
    if (significant.length === 0) return;
    const worst = significant.reduce((a, b) => (a.amount > b.amount ? a : b));
    this.toast(`${worst.label} ${(worst.remaining * 100).toFixed(0)}%`, worst.remaining <= 0);
  }

  /** Announce something that happened to the car, rather than inside it. */
  notice(text: string): void {
    this.toast(text, true);
  }

  private toast(text: string, severe: boolean): void {
    const el = document.createElement('div');
    el.className = `damage-toast${severe ? ' severe' : ''}`;
    el.textContent = text;
    this.toasts.prepend(el);
    while (this.toasts.childElementCount > 4) this.toasts.lastElementChild!.remove();
    window.setTimeout(() => el.remove(), severe ? 6000 : 3200);
  }
}
