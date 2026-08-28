/**
 * Wheel spray and skid marks.
 *
 * Both exist to make grip visible. Under a fixed isometric camera you cannot
 * feel the car through the seat, so the only channels for "this tyre has let
 * go" are sound and what the tyre leaves behind — a plume of gravel or a black
 * line on tarmac. They are read straight off tyre saturation, the same number
 * the physics uses, so what you see is genuinely what is happening.
 */

import * as THREE from 'three';
import type { Weather } from '../sim/conditions.js';
import type { Vec3 } from '../sim/math.js';
import type { WheelState } from '../sim/vehicle.js';

const MAX_PARTICLES = 900;
const MAX_SKID_QUADS = 1400;

/** Particles look like this: soft round points that fade and shrink with age. */
/**
 * Particles are soft round points that fade and shrink with age.
 *
 * The point size is scaled by an explicit uniform rather than by the usual
 * `1.0 / -mvPosition.z` perspective trick: the game camera is orthographic, so
 * that formula divides by a fixed ~140 m camera distance and produces
 * sub-pixel points that never appear at all.
 */
const PARTICLE_VERTEX = `
  attribute float size;
  attribute float alpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = alpha;
    vColor = aColor;
    gl_PointSize = max(size * uScale, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const PARTICLE_FRAGMENT = `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    gl_FragColor = vec4(vColor, vAlpha * (1.0 - r * 3.2));
  }`;

export class ParticleField {
  readonly points: THREE.Points;

  private readonly positions = new Float32Array(MAX_PARTICLES * 3);
  private readonly colors = new Float32Array(MAX_PARTICLES * 3);
  private readonly sizes = new Float32Array(MAX_PARTICLES);
  private readonly alphas = new Float32Array(MAX_PARTICLES);
  private readonly velocities = new Float32Array(MAX_PARTICLES * 3);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private next = 0;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;

  constructor(parent: THREE.Object3D) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      uniforms: { uScale: { value: 40 } },
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    parent.add(this.points);
  }

  /** Spawn one particle. Oldest are recycled once the pool is full. */
  emit(at: Vec3, velocity: Vec3, color: THREE.Color, size: number, life: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PARTICLES;

    this.positions[i * 3] = at.x;
    this.positions[i * 3 + 1] = at.y;
    this.positions[i * 3 + 2] = at.z;
    this.velocities[i * 3] = velocity.x;
    this.velocities[i * 3 + 1] = velocity.y;
    this.velocities[i * 3 + 2] = velocity.z;
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
    this.sizes[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.alphas[i] = 1;
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i]! <= 0) {
        this.alphas[i] = 0;
        continue;
      }
      this.life[i]! -= dt;

      // Gravity plus a little drag, so spray arcs and settles instead of
      // flying off in a straight line.
      this.velocities[i * 3 + 1]! -= 9.81 * dt * 0.55;
      const drag = 1 - Math.min(dt * 1.8, 0.9);
      this.velocities[i * 3]! *= drag;
      this.velocities[i * 3 + 1]! *= drag;
      this.velocities[i * 3 + 2]! *= drag;

      this.positions[i * 3]! += this.velocities[i * 3]! * dt;
      this.positions[i * 3 + 1]! += this.velocities[i * 3 + 1]! * dt;
      this.positions[i * 3 + 2]! += this.velocities[i * 3 + 2]! * dt;

      const t = this.life[i]! / this.maxLife[i]!;
      this.alphas[i] = t * t;
    }

    for (const name of ['position', 'aColor', 'size', 'alpha']) {
      this.geometry.getAttribute(name).needsUpdate = true;
    }
  }

  /**
   * Tell the field how many screen pixels a world metre covers, so points stay
   * the right physical size as the orthographic camera zooms.
   */
  setScale(pixelsPerMetre: number): void {
    this.material.uniforms.uScale!.value = pixelsPerMetre;
  }

  clear(): void {
    this.life.fill(0);
    this.alphas.fill(0);
    this.geometry.getAttribute('alpha').needsUpdate = true;
  }
}

/**
 * Skid marks, as a ring buffer of flat quads laid on the ground.
 *
 * A ring buffer rather than an ever-growing mesh: a long stage would otherwise
 * accumulate marks without limit, and the oldest ones are exactly the ones
 * nobody is looking at.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh;

  private readonly positions = new Float32Array(MAX_SKID_QUADS * 6 * 3);
  private readonly opacities = new Float32Array(MAX_SKID_QUADS * 6);
  private readonly geometry = new THREE.BufferGeometry();
  private next = 0;
  /** Last contact point per wheel, so a mark can be stretched between frames. */
  private readonly previous: (Vec3 | null)[] = [null, null, null, null];

  constructor(parent: THREE.Object3D) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aOpacity', new THREE.BufferAttribute(this.opacities, 1));

    const material = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aOpacity;
        varying float vOpacity;
        void main() {
          vOpacity = aOpacity;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying float vOpacity;
        void main() { gl_FragColor = vec4(0.03, 0.03, 0.04, vOpacity * 0.55); }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  /**
   * Lay a segment of mark for one wheel between its last position and this one.
   * `strength` fades the mark in as the tyre passes its limit.
   */
  lay(wheelIndex: number, at: Vec3, right: Vec3, width: number, strength: number): void {
    const last = this.previous[wheelIndex];
    this.previous[wheelIndex] = { ...at };
    if (!last || strength <= 0) return;

    const span = Math.hypot(at.x - last.x, at.z - last.z);
    // Skip micro-segments (parked) and teleports (a rescue or a restart).
    if (span < 0.05 || span > 6) return;

    const h = width / 2;
    const quad = [
      { x: last.x + right.x * h, y: last.y, z: last.z + right.z * h },
      { x: last.x - right.x * h, y: last.y, z: last.z - right.z * h },
      { x: at.x + right.x * h, y: at.y, z: at.z + right.z * h },
      { x: at.x - right.x * h, y: at.y, z: at.z - right.z * h },
    ];
    const order = [0, 1, 2, 2, 1, 3];

    const base = this.next * 6;
    this.next = (this.next + 1) % MAX_SKID_QUADS;
    for (let i = 0; i < 6; i++) {
      const v = quad[order[i]!]!;
      this.positions[(base + i) * 3] = v.x;
      this.positions[(base + i) * 3 + 1] = v.y + 0.015;
      this.positions[(base + i) * 3 + 2] = v.z;
      this.opacities[base + i] = strength;
    }

    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aOpacity').needsUpdate = true;
  }

  /** Called when a wheel stops marking, so the next mark does not bridge a gap. */
  lift(wheelIndex: number): void {
    this.previous[wheelIndex] = null;
  }

  clear(): void {
    this.opacities.fill(0);
    this.positions.fill(0);
    this.previous.fill(null);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aOpacity').needsUpdate = true;
  }
}

/**
 * Rain and snow.
 *
 * A separate system from the wheel spray rather than a reuse of it: spray is
 * emitted, arcs and dies, while precipitation is a permanent volume that falls
 * and wraps. Sharing one pool would mean a heavy shower starving the spray of
 * particles exactly when a slide most needs to be visible.
 */
export class Precipitation {
  readonly points: THREE.Points;

  private readonly count = 1400;
  private readonly positions: Float32Array;
  private readonly speeds: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  /** Side of the cube the particles live in, centred on the camera's focus. */
  private readonly extent = 90;
  private mode: 'none' | 'rain' | 'snow' = 'none';

  constructor(parent: THREE.Object3D) {
    this.positions = new Float32Array(this.count * 3);
    this.speeds = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.positions[i * 3] = (Math.random() - 0.5) * this.extent;
      this.positions[i * 3 + 1] = Math.random() * 60;
      this.positions[i * 3 + 2] = (Math.random() - 0.5) * this.extent;
      this.speeds[i] = 0.6 + Math.random() * 0.8;
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 30 },
        uSize: { value: 0.06 },
        uColor: { value: new THREE.Color(0xaecbe8) },
        uOpacity: { value: 0 },
        uStretch: { value: 3.5 },
      },
      vertexShader: `
        uniform float uScale;
        uniform float uSize;
        uniform float uStretch;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(uSize * uScale * uStretch, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          if (dot(d, d) > 0.25) discard;
          gl_FragColor = vec4(uColor, uOpacity);
        }`,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    parent.add(this.points);
  }

  /** Match the weather. Anything without falling water simply turns it off. */
  setWeather(weather: Weather): void {
    this.mode = weather === 'rain' ? 'rain' : weather === 'snowfall' ? 'snow' : 'none';
    this.points.visible = this.mode !== 'none';

    const u = this.material.uniforms;
    if (this.mode === 'rain') {
      (u.uColor!.value as THREE.Color).setHex(0xaecbe8);
      u.uSize!.value = 0.05;
      u.uStretch!.value = 4.5;
      u.uOpacity!.value = 0.5;
    } else if (this.mode === 'snow') {
      (u.uColor!.value as THREE.Color).setHex(0xf2f6fb);
      u.uSize!.value = 0.16;
      u.uStretch!.value = 1;
      u.uOpacity!.value = 0.75;
    }
  }

  /** Keep the volume over the car and let it fall. */
  update(dt: number, focus: THREE.Vector3, pixelsPerMetre: number): void {
    if (this.mode === 'none') return;
    this.material.uniforms.uScale!.value = pixelsPerMetre;

    const fall = this.mode === 'rain' ? 34 : 5;
    const drift = this.mode === 'rain' ? 4 : 2.2;
    const half = this.extent / 2;

    for (let i = 0; i < this.count; i++) {
      const y = i * 3 + 1;
      this.positions[y]! -= fall * this.speeds[i]! * dt;
      this.positions[i * 3]! += drift * dt;

      // Wrap rather than respawn: the volume follows the car, so a particle
      // that falls out of the bottom belongs back at the top of it.
      if (this.positions[y]! < focus.y - 4) {
        this.positions[y] = focus.y + 55;
        this.positions[i * 3] = focus.x + (Math.random() - 0.5) * this.extent;
        this.positions[i * 3 + 2] = focus.z + (Math.random() - 0.5) * this.extent;
      }
      if (Math.abs(this.positions[i * 3]! - focus.x) > half) {
        this.positions[i * 3] = focus.x + (Math.random() - 0.5) * this.extent;
      }
      if (Math.abs(this.positions[i * 3 + 2]! - focus.z) > half) {
        this.positions[i * 3 + 2] = focus.z + (Math.random() - 0.5) * this.extent;
      }
    }
    this.geometry.getAttribute('position').needsUpdate = true;
  }
}

const SPRAY_COLOR = new THREE.Color();
const SPARK_COLOR = new THREE.Color(0xffb648);
const scratch = { x: 0, y: 0, z: 0 };

/**
 * Sparks from a part scraping the road.
 *
 * This is the telegraph made visible: a dragging bumper has seconds of shower
 * before it lets go, and the shower is the only warning the player gets.
 */
export function emitDragSparks(
  particles: ParticleField,
  at: Vec3,
  carVelocity: Vec3,
  speed: number,
  dt: number,
): void {
  if (speed < 4) return;
  const count = Math.min(Math.round(speed * 1.4 * dt * 60), 8);
  for (let n = 0; n < count; n++) {
    scratch.x = -carVelocity.x * 0.3 + (Math.random() - 0.5) * 6;
    scratch.y = 1.2 + Math.random() * 3.5;
    scratch.z = -carVelocity.z * 0.3 + (Math.random() - 0.5) * 6;
    particles.emit(at, scratch, SPARK_COLOR, 0.12 + Math.random() * 0.16, 0.25 + Math.random() * 0.4);
  }
}

const STEAM_COLOR = new THREE.Color(0xd7e2e8);

/**
 * Steam from a boiling cooling system.
 *
 * The point is warning. An overheat used to arrive as a line of text and then
 * a dead engine; a plume out of the bonnet gives the player the twenty seconds
 * before that to decide whether to lift, and makes the decision visible from
 * the car rather than from the damage panel.
 *
 * It rises and drifts backwards over the car rather than being left behind,
 * because it is coming from under a bonnet moving through its own air.
 */
export function emitSteam(
  particles: ParticleField,
  at: Vec3,
  carVelocity: Vec3,
  intensity: number,
  dt: number,
): void {
  if (intensity <= 0) return;
  // Sparingly, and briefly. The first version emitted six a frame with a
  // second of life each and the car left a smoke-bomb trail a hundred metres
  // long: a plume that says "this car is in trouble" is a wisp above the
  // bonnet, not a special effect.
  // Rate per second rather than per frame, or the plume thickens on a fast
  // display and thins on a slow one.
  const count = Math.random() < intensity * dt * 60 ? 1 : 0;
  for (let n = 0; n < count; n++) {
    // Most of the car's own velocity is carried, so the plume hangs over the
    // bonnet and drifts back a little rather than being left standing.
    scratch.x = carVelocity.x * 0.62 + (Math.random() - 0.5) * 1.2;
    scratch.y = 1.6 + Math.random() * 1.4;
    scratch.z = carVelocity.z * 0.62 + (Math.random() - 0.5) * 1.2;
    particles.emit(
      at,
      scratch,
      STEAM_COLOR,
      0.7 + Math.random() * 0.6,
      0.5 + Math.random() * 0.4,
    );
  }
}

/**
 * Emit spray and lay marks for the current wheel states.
 *
 * Loose surfaces throw material; hard ones leave a line. Which happens is a
 * property of the surface, so gravel plumes and tarmac blackens without either
 * being special-cased at the call site.
 */
export function updateWheelEffects(
  particles: ParticleField,
  skids: SkidMarks,
  wheels: readonly WheelState[],
  carVelocity: Vec3,
  dt: number,
): void {
  for (let i = 0; i < wheels.length; i++) {
    const wheel = wheels[i]!;
    if (!wheel.grounded) {
      skids.lift(i);
      continue;
    }

    const slip = Math.max(0, wheel.saturation - 0.95);
    const surface = wheel.surface;

    // Loose surfaces spray; the amount tracks how hard the tyre is working.
    if (surface.spray > 0.05 && slip > 0.02) {
      const count = Math.min(Math.round(slip * surface.spray * 44 * dt * 60), 10);
      SPRAY_COLOR.setHex(surface.color).offsetHSL(0, 0, 0.12);
      for (let n = 0; n < count; n++) {
        scratch.x = -carVelocity.x * 0.22 + (Math.random() - 0.5) * 4.5;
        scratch.y = 1.6 + Math.random() * 3.2 * Math.min(slip, 1);
        scratch.z = -carVelocity.z * 0.22 + (Math.random() - 0.5) * 4.5;
        particles.emit(
          wheel.contact,
          scratch,
          SPRAY_COLOR,
          0.26 + Math.random() * 0.4,
          0.55 + Math.random() * 0.8,
        );
      }
    }

    // Firm surfaces take a mark. Ice cannot hold one, which is itself a useful
    // cue that there is nothing under you to bite.
    const marks = surface.id !== 'ice' && surface.id !== 'snow';
    if (marks && slip > 0.05) {
      const right = { x: 0, y: 0, z: 0 };
      // Lay the mark across the direction of travel.
      const speed = Math.hypot(carVelocity.x, carVelocity.z) || 1;
      right.x = -carVelocity.z / speed;
      right.z = carVelocity.x / speed;
      skids.lay(i, wheel.contact, right, 0.26, Math.min(slip * 1.6, 1));
    } else {
      skids.lift(i);
    }
  }
}
