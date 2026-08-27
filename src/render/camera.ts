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

export class IsoCamera {
  readonly camera: THREE.OrthographicCamera;

  yaw = CAMERA.yaw;
  pitch = CAMERA.pitch;
  viewSize = CAMERA.viewSize;

  private readonly target = new THREE.Vector3();
  private aspect = 16 / 9;

  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.applyProjection();
  }

  resize(width: number, height: number): void {
    this.aspect = width / Math.max(height, 1);
    this.applyProjection();
  }

  private applyProjection(): void {
    const h = this.viewSize;
    const w = h * this.aspect;
    const c = this.camera;
    c.left = -w;
    c.right = w;
    c.top = h;
    c.bottom = -h;
    c.updateProjectionMatrix();
  }

  /** Snap straight to the subject, with no smoothing. */
  jumpTo(position: Vec3): void {
    this.target.set(position.x, position.y, position.z);
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
    this.target.x += (desiredX - this.target.x) * k;
    this.target.y += (position.y - this.target.y) * k;
    this.target.z += (desiredZ - this.target.z) * k;

    this.applyProjection();
    this.place();
  }

  private place(): void {
    // Orthographic distance is arbitrary; it only has to clear the far plane's
    // near side and stay inside the shadow camera's frustum.
    const dist = 140;
    const cp = Math.cos(this.pitch);
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    ).multiplyScalar(dist);

    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  }

  get focus(): THREE.Vector3 {
    return this.target;
  }
}
