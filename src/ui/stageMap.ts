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

  return `<svg class="stage-map" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <path d="${path}" class="map-route"/>
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

  constructor(parent: HTMLElement, className = 'map-live') {
    this.root = document.createElement('div');
    this.root.className = className;
    parent.appendChild(this.root);
  }

  setStage(stage: Stage | null): void {
    if (!stage) {
      this.root.innerHTML = '';
      this.projection = null;
      return;
    }
    this.root.innerHTML = stageMapSvg(stage, { size: 100, corners: true });
    this.projection = mapProjection(stage, 100);
    this.car = this.root.querySelector('.map-car');
    this.done = this.root.querySelector('.map-done');
  }

  /** Move the car and fill the route behind it. `progress` is 0..1. */
  update(position: Vec3, progress: number): void {
    if (!this.projection || !this.car) return;
    const p = this.projection.project(position);
    this.car.setAttribute('cx', p.x.toFixed(1));
    this.car.setAttribute('cy', p.y.toFixed(1));
    this.car.style.display = '';
    const driven = Math.max(0, Math.min(progress, 1)) * 1000;
    this.done?.setAttribute('stroke-dasharray', `${driven.toFixed(0)} 1000`);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }
}
