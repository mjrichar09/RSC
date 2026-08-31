/**
 * Stage maps, drawn as SVG from the centreline.
 *
 * A stage is already a list of points, so its map is not an asset anybody has
 * to draw or keep in step — it is the same data the road is built from, seen
 * from above. The garage uses it to choose a stage and the HUD uses it to know
 * where you are on one; both read this.
 *
 * North-up and fixed. A map that rotates with the car is harder to learn than
 * one that stays put, and learning the shape of a stage is the point.
 *
 * ## Height
 *
 * Seen from above, a stage that climbs sixty metres looks exactly like one that
 * does not, and the two drive nothing alike: a crest unloads the car at the one
 * place you wanted to turn, and a long climb quietly eats the top of fourth.
 * The terrain has always been in the simulation — see `sim/terrain.ts` — and
 * the map was the one place it was invisible.
 *
 * It is shown twice, because the two questions are different ones. The route is
 * **tinted by height**, low to high, which answers "where does this stage sit"
 * at a glance and needs no reading. Under it runs a **profile**: height against
 * distance, with the gates marked and the car on it, which answers "what is
 * coming" — the question you actually have while driving. Neither needs a
 * number, and both are the same spline the road is built from.
 */

import type { Stage } from '../sim/stage.js';
import type { Vec3 } from '../sim/math.js';

export interface MapOptions {
  /** Viewport size, in SVG user units. Square. */
  size?: number;
  /** Draw checkpoint ticks and the start/finish markers. */
  markers?: boolean;
  /** Draw a dot for each corner, coloured by severity. */
  corners?: boolean;
  /** Stroke width of the route, in user units. */
  stroke?: number;
  /**
   * Tint the route by height.
   *
   * Off for the garage's 54-pixel thumbnails: at that size the shape is the
   * only thing readable, and a hundred separately coloured segments is a
   * hundred DOM nodes per row to say nothing.
   */
  elevation?: boolean;
}

/** Maps world XZ onto the SVG box, preserving the stage's shape. */
export interface MapProjection {
  project: (p: Vec3) => { x: number; y: number };
  size: number;
}

const SEVERITY_COLOUR = ['#e8552f', '#e8552f', '#f2c14e', '#f2c14e', '#7fd6a0', '#7fd6a0'];

/**
 * Build the projection for a stage.
 *
 * Aspect is preserved and the stage is centred, so a long thin stage does not
 * come out stretched into a square — the shape is the recognisable part.
 */
export function mapProjection(stage: Stage, size = 100, padding = 8): MapProjection {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let d = 0; d <= stage.length; d += 4) {
    const p = stage.spline.at(d).position;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }

  const spanX = Math.max(maxX - minX, 1);
  const spanZ = Math.max(maxZ - minZ, 1);
  const inner = size - padding * 2;
  const scale = Math.min(inner / spanX, inner / spanZ);
  const offsetX = padding + (inner - spanX * scale) / 2;
  const offsetY = padding + (inner - spanZ * scale) / 2;

  return {
    size,
    project: (p: Vec3) => ({
      x: offsetX + (p.x - minX) * scale,
      // World +Z is drawn downward, so the map reads the same way round as the
      // world does from above.
      y: offsetY + (p.z - minZ) * scale,
    }),
  };
}

/**
 * Height along the stage, and how much of it there is.
 *
 * `climb` and `descent` are the totals actually driven rather than the
 * difference between the ends: a stage that goes up sixty and back down sixty
 * finishes where it started and is not remotely flat, and the pair of numbers
 * is the only honest way to say so.
 */
export interface Elevation {
  /** Height at each sample, metres, from the start line to the finish. */
  heights: number[];
  /** Metres between samples. */
  step: number;
  low: number;
  high: number;
  climb: number;
  descent: number;
}

export function stageElevation(stage: Stage, step = 8): Elevation {
  const heights: number[] = [];
  for (let d = 0; d <= stage.length; d += step) heights.push(stage.spline.at(d).position.y);

  let climb = 0;
  let descent = 0;
  for (let i = 1; i < heights.length; i++) {
    const change = heights[i]! - heights[i - 1]!;
    if (change > 0) climb += change;
    else descent -= change;
  }

  return {
    heights,
    step,
    low: Math.min(...heights),
    high: Math.max(...heights),
    climb,
    descent,
  };
}

/**
 * Height ramp, low to high.
 *
 * Chosen to survive being read at 130 pixels on a dark HUD, and to not be
 * mistaken for the yellow that means "driven": cold and dark at the bottom of a
 * valley, warm and pale at the top of a pass. Five stops rather than two,
 * because a straight blue-to-white fade puts everything interesting in the
 * middle where nothing is distinguishable.
 */
const HEIGHT_RAMP: [number, number, number][] = [
  [0x35, 0x6b, 0x84],
  [0x46, 0x8d, 0x7e],
  [0x7f, 0xa8, 0x5e],
  [0xc4, 0xa9, 0x62],
  [0xea, 0xdf, 0xc6],
];

/** The ramp colour for a height fraction, 0 at the lowest point and 1 at the highest. */
export function heightColour(t: number): string {
  const clamped = Math.max(0, Math.min(t, 1)) * (HEIGHT_RAMP.length - 1);
  const i = Math.min(Math.floor(clamped), HEIGHT_RAMP.length - 2);
  const f = clamped - i;
  const a = HEIGHT_RAMP[i]!;
  const b = HEIGHT_RAMP[i + 1]!;
  const mix = (k: number) => Math.round(a[k]! + (b[k]! - a[k]!) * f);
  return `#${[mix(0), mix(1), mix(2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The route drawn as one short segment per sample, each tinted by its height.
 *
 * Segments overlap by one point so the joins do not show as gaps, and the whole
 * thing is drawn under the progress path rather than instead of it — where you
 * are is still yellow, and how high you are is the road underneath it.
 */
function tintedRoute(stage: Stage, projection: MapProjection, stroke: number): string {
  const elevation = stageElevation(stage, 8);
  const span = Math.max(elevation.high - elevation.low, 1);
  const parts: string[] = [];

  for (let i = 0; i < elevation.heights.length - 1; i++) {
    const a = projection.project(stage.spline.at(i * elevation.step).position);
    const b = projection.project(
      stage.spline.at(Math.min((i + 1) * elevation.step, stage.length)).position,
    );
    const mid = (elevation.heights[i]! + elevation.heights[i + 1]!) / 2;
    const colour = heightColour((mid - elevation.low) / span);
    parts.push(
      `<path d="M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}" ` +
        `stroke="${colour}" stroke-width="${stroke}" fill="none" ` +
        `stroke-linecap="round"/>`,
    );
  }
  return parts.join('');
}

/**
 * The stage in section: height against distance.
 *
 * Drawn to its own box rather than onto the map, because the two are answering
 * different questions and overlaying them makes both unreadable. The vertical
 * scale is exaggerated on purpose — a 740 m stage with 40 m of relief is a
 * flat line at true scale, and the shape of the climbs is the entire content.
 */
export function elevationProfileSvg(stage: Stage, width = 100, height = 26): string {
  const elevation = stageElevation(stage, 8);
  const span = Math.max(elevation.high - elevation.low, 4);
  const pad = 2;
  const inner = height - pad * 2;
  const x = (i: number) => (i / Math.max(elevation.heights.length - 1, 1)) * width;
  const y = (h: number) => pad + inner - ((h - elevation.low) / span) * inner;

  const line = elevation.heights
    .map((h, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(h).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${width} ${height} L0 ${height} Z`;

  // Gates on the profile, so a split is somewhere on a hill rather than
  // somewhere on a line.
  const gates = stage.checkpoints
    .map((cp) => {
      const at = (cp.distance / stage.length) * width;
      return `<line class="prof-gate" x1="${at.toFixed(1)}" y1="0" x2="${at.toFixed(1)}" y2="${height}"/>`;
    })
    .join('');

  return `<svg class="stage-profile" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <path class="prof-fill" d="${area}"/>
    ${gates}
    <path class="prof-line" d="${line}"/>
    <circle class="prof-car" r="2" style="display:none"/>
  </svg>`;
}

/** The centreline as an SVG path, sampled every few metres. */
export function routePath(stage: Stage, projection: MapProjection): string {
  const points: string[] = [];
  for (let d = 0; d <= stage.length; d += 6) {
    const { x, y } = projection.project(stage.spline.at(d).position);
    points.push(`${points.length === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return points.join(' ');
}

/**
 * A complete stage map as an SVG string.
 *
 * The route is drawn twice: once dim for the whole stage, once bright and
 * clipped by a dash offset for the part already driven. `pathLength` is fixed
 * at 1000 so the progress dash is in units of thousandths, whatever the real
 * length of the path is.
 */
export function stageMapSvg(stage: Stage, options: MapOptions = {}): string {
  const size = options.size ?? 100;
  const stroke = options.stroke ?? 2.4;
  const projection = mapProjection(stage, size);
  const path = routePath(stage, projection);

  const start = projection.project(stage.spline.at(0).position);
  const finish = projection.project(stage.spline.at(stage.length).position);

  const markers = options.markers === false ? '' : `
    ${stage.checkpoints
      .map((cp) => {
        const p = projection.project(cp.position);
        return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(stroke * 0.7).toFixed(1)}" class="map-cp"/>`;
      })
      .join('')}
    <circle cx="${start.x.toFixed(1)}" cy="${start.y.toFixed(1)}" r="${(stroke * 1.1).toFixed(1)}" class="map-start"/>
    <circle cx="${finish.x.toFixed(1)}" cy="${finish.y.toFixed(1)}" r="${(stroke * 1.1).toFixed(1)}" class="map-finish"/>`;

  const corners = options.corners
    ? stage.corners
        .map((corner) => {
          const p = projection.project(stage.spline.at(corner.apex).position);
          const colour = SEVERITY_COLOUR[corner.severity - 1] ?? '#f2c14e';
          return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(stroke * 0.6).toFixed(1)}" fill="${colour}" opacity="0.9"/>`;
        })
        .join('')
    : '';

  const relief =
    options.elevation === false ? '' : tintedRoute(stage, projection, stroke);

  return `<svg class="stage-map" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <path d="${path}" class="map-route"/>
    ${relief}
    <path d="${path}" class="map-done" pathLength="1000" stroke-dasharray="0 1000"/>
    ${corners}
    ${markers}
    <circle r="${(stroke * 1.3).toFixed(1)}" class="map-car" style="display:none"/>
  </svg>`;
}

/**
 * A live map: the same SVG, plus a car that moves and a route that fills in.
 *
 * Kept as a class because the HUD updates it every frame and rebuilding the
 * path forty times a second to move one dot would be absurd.
 */
export class LiveStageMap {
  readonly root: HTMLElement;
  private projection: MapProjection | null = null;
  private car: SVGCircleElement | null = null;
  private done: SVGPathElement | null = null;
  private profileCar: SVGCircleElement | null = null;
  private readonly profileWidth = 100;
  private readonly profileHeight = 26;
  /** Height samples for the profile, so the car marker can ride the line. */
  private profile: Elevation | null = null;

  constructor(parent: HTMLElement, className = 'map-live') {
    this.root = document.createElement('div');
    this.root.className = className;
    parent.appendChild(this.root);
  }

  setStage(stage: Stage | null): void {
    if (!stage) {
      this.root.innerHTML = '';
      this.projection = null;
      this.profileCar = null;
      this.profile = null;
      return;
    }
    const elevation = stageElevation(stage);
    this.profile = elevation;
    this.root.innerHTML =
      stageMapSvg(stage, { size: 100, corners: true }) +
      elevationProfileSvg(stage, this.profileWidth, 26) +
      // The one number worth printing. Everything else about the height is
      // easier to see than to read.
      `<div class="profile-label">▲${Math.round(elevation.climb)} ▼${Math.round(elevation.descent)} m</div>`;
    this.projection = mapProjection(stage, 100);
    this.car = this.root.querySelector('.map-car');
    this.done = this.root.querySelector('.map-done');
    this.profileCar = this.root.querySelector('.prof-car');
  }

  /** Move the car and fill the route behind it. `progress` is 0..1. */
  update(position: Vec3, progress: number): void {
    if (!this.projection || !this.car) return;
    const p = this.projection.project(position);
    this.car.setAttribute('cx', p.x.toFixed(1));
    this.car.setAttribute('cy', p.y.toFixed(1));
    this.car.style.display = '';
    const clamped = Math.max(0, Math.min(progress, 1));
    this.done?.setAttribute('stroke-dasharray', `${(clamped * 1000).toFixed(0)} 1000`);

    // The profile is drawn with preserveAspectRatio="none", so its own x runs
    // 0..profileWidth however wide the box ends up on screen.
    if (this.profileCar) {
      this.profileCar.setAttribute('cx', (clamped * this.profileWidth).toFixed(1));
      this.profileCar.setAttribute('cy', this.profileY(clamped).toFixed(1));
      this.profileCar.style.display = '';
    }
  }

  /** Where on the profile the car sits, in that SVG's own units. */
  private profileY(progress: number): number {
    const elevation = this.profile;
    if (!elevation) return this.profileHeight / 2;
    // Matches `elevationProfileSvg`: same padding, same exaggerated span.
    const pad = 2;
    const inner = this.profileHeight - pad * 2;
    const span = Math.max(elevation.high - elevation.low, 4);
    const at = progress * (elevation.heights.length - 1);
    const i = Math.min(Math.floor(at), elevation.heights.length - 2);
    const height = elevation.heights[i]! + (elevation.heights[i + 1]! - elevation.heights[i]!) * (at - i);
    return pad + inner - ((height - elevation.low) / span) * inner;
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }
}
