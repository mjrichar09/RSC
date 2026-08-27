/**
 * Fixed isometric camera.
 *
 * Orthographic, locked pitch and yaw, position smoothed toward the car with
 * velocity lookahead so you see the corner you are arriving at rather than the
 * one you are in. P2 adds per-stage zones that blend yaw/pitch/zoom along the
 * stage spline — this class already takes those as settable fields.
 */

import * as THREE from 'three';
import { CAMERA } from '../data/tuning.js';
import type { Vec3 } from '../sim/math.js';
import type { CameraZone } from '../sim/stage.js';

/**
 * How far back the orthographic camera sits, in metres.
 *
 * Arbitrary for an orthographic projection — it only has to clear the near
 * plane and stay inside the shadow frustum — but everything depth-based has to
 * know it. Fog in particular is measured from the camera, so a fog range
 * meant to mean "60 m from the car" has to be expressed as 140 + 60.
 */
export const CAMERA_DISTANCE = 140;

/** Signed shortest angular difference from `from` to `to`, in radians. */
function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class IsoCamera {
  readonly camera: THREE.OrthographicCamera;

  yaw: number = CAMERA.yaw;
  pitch: number = CAMERA.pitch;
  viewSize: number = CAMERA.viewSize;

  private readonly target = new THREE.Vector3();
  private aspect = 16 / 9;

  /** Zone values the camera is easing toward. */
  private desiredYaw: number = CAMERA.yaw;
  private desiredPitch: number = CAMERA.pitch;
  private desiredZoom: number = CAMERA.viewSize;

  /** Current shake magnitude in metres, decaying every frame. */
  private shakeAmount = 0;
  private shakeSeed = Math.random() * 1000;
  /** Extra zoom-out from speed, multiplied onto the zone's view size. */
  private speedZoom = 1;

  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.applyProjection();
  }

  resize(width: number, height: number): void {
    this.aspect = width / Math.max(height, 1);
    this.applyProjection();
  }

  private applyProjection(): void {
    const h = this.viewSize * this.speedZoom;
    const w = h * this.aspect;
    const c = this.camera;
    c.left = -w;
    c.right = w;
    c.top = h;
    c.bottom = -h;
    c.updateProjectionMatrix();
  }

  /**
   * Adopt the stage's camera settings for a point along the stage.
   *
   * Zones are the answer to the one real weakness of a fixed isometric camera:
   * a stage that doubles back on itself becomes unreadable when the view angle
   * never changes. The transition is eased rather than cut, so the world turns
   * under the car instead of snapping.
   */
  applyZones(zones: readonly CameraZone[] | undefined, distance: number): void {
    if (!zones || zones.length === 0) return;

    let active = zones[0]!;
    for (const zone of zones) {
      if (distance >= zone.from) active = zone;
      else break;
    }
    if (active.yaw !== undefined) this.desiredYaw = active.yaw;
    if (active.pitch !== undefined) this.desiredPitch = active.pitch;
    if (active.zoom !== undefined) this.desiredZoom = active.zoom;
  }

  /**
   * Knock the camera. `severity` is 0..1; anything above a light bump reads as
   * an impact you felt rather than merely saw.
   */
  shake(severity: number): void {
    this.shakeAmount = Math.min(Math.max(this.shakeAmount, severity * 1.5), 2.2);
  }

  /** Snap straight to the subject, with no smoothing. */
  jumpTo(position: Vec3): void {
    this.target.set(position.x, position.y, position.z);
    this.yaw = this.desiredYaw;
    this.pitch = this.desiredPitch;
    this.viewSize = this.desiredZoom;
    this.applyProjection();
    this.place();
  }

  /**
   * @param dt      seconds since the last frame
   * @param position subject position
   * @param velocity subject velocity, used for lookahead
   */
  follow(dt: number, position: Vec3, velocity: Vec3): void {
    const speed = Math.hypot(velocity.x, velocity.z);
    const lead = Math.min(speed * CAMERA.lookaheadPerSpeed, CAMERA.maxLookahead);
    const dir = speed > 0.5 ? 1 / speed : 0;

    const desiredX = position.x + velocity.x * dir * lead;
    const desiredZ = position.z + velocity.z * dir * lead;

    // Framerate-independent exponential smoothing via half-life.
    const k = 1 - Math.pow(0.5, dt / CAMERA.followHalfLife);

    // Zone changes ease in far more slowly than the follow, so a yaw change
    // reads as the world rotating rather than as the camera being yanked.
    const zoneK = 1 - Math.pow(0.5, dt / CAMERA.zoneHalfLife);
    this.yaw += shortestAngle(this.yaw, this.desiredYaw) * zoneK;
    this.pitch += (this.desiredPitch - this.pitch) * zoneK;
    this.viewSize += (this.desiredZoom - this.viewSize) * zoneK;
    this.target.x += (desiredX - this.target.x) * k;
    this.target.y += (position.y - this.target.y) * k;
    this.target.z += (desiredZ - this.target.z) * k;

    // Pull back a little at speed: it buys lookahead exactly when the car needs
    // it, and reads as the world opening up rather than as a zoom. Kept as a
    // separate multiplier so it does not fight the camera-zone easing.
    const wanted = 1 + Math.min(speed / 60, 0.35);
    this.speedZoom += (wanted - this.speedZoom) * (1 - Math.pow(0.5, dt / 0.4));

    this.shakeAmount *= Math.pow(0.02, dt);
    if (this.shakeAmount < 0.001) this.shakeAmount = 0;

    this.applyProjection();
    this.place();
  }

  private place(): void {
    const dist = CAMERA_DISTANCE;
    const cp = Math.cos(this.pitch);
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    ).multiplyScalar(dist);

    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);

    if (this.shakeAmount > 0) {
      // Two out-of-phase sines rather than random noise: random jitter reads as
      // a dropped frame, a wobble reads as an impact.
      const t = performance.now() * 0.001 + this.shakeSeed;
      this.camera.position.x += Math.sin(t * 47) * this.shakeAmount;
      this.camera.position.y += Math.sin(t * 61 + 1.7) * this.shakeAmount * 0.6;
      this.camera.position.z += Math.cos(t * 53 + 0.4) * this.shakeAmount;
    }
  }

  /** Orthographic half-height actually in use, including the speed zoom. */
  get effectiveViewSize(): number {
    return this.viewSize * this.speedZoom;
  }

  get focus(): THREE.Vector3 {
    return this.target;
  }
}
