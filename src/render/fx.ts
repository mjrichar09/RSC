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
/**
 * Quads in the track ring buffer, and how far the car travels per quad.
 *
 * 5000 at 1.15 m is about 1.4 km of track shared between four wheels — more
 * than a stage is long, so your own line through a corner is still there when
 * you come back to it on the next lap of the same road.
 */
const MAX_SKID_QUADS = 5000;
const MIN_SEGMENT = 1.15;

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
  /**
   * A height each particle will not fall through, or `-Infinity` for none.
   *
   * Spray and steam want no floor — they die in the air long before they reach
   * one. Crash debris does: a shard that carries on through the tarmac and
   * disappears is a spark, and the whole point of debris is that it *lands* and
   * is still lying there when the car has gone. One number per particle rather
   * than a terrain query, because a burst all leaves from one point and the
   * ground under that point is flat enough for the second the shards are in
   * the air.
   */
  private readonly floor = new Float32Array(MAX_PARTICLES);
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
  /**
   * How many of the particles asked for are actually spawned, 0..1.
   *
   * Thinning rather than capping: a phone still gets spray and sparks, just
   * fewer of them, and every emitter keeps working without knowing about it.
   */
  density = 1;
  private thin = 0;

  emit(
    at: Vec3,
    velocity: Vec3,
    color: THREE.Color,
    size: number,
    life: number,
    /** A height to come to rest on, for anything that should land. */
    floor = -Infinity,
  ): void {
    if (this.density < 1) {
      // Deterministic thinning: an accumulator rather than a random draw, so a
      // headless run is still reproducible and a steady jet does not flicker.
      this.thin += this.density;
      if (this.thin < 1) return;
      this.thin -= 1;
    }
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
    this.floor[i] = floor;
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

      // Land, and then stay landed. The vertical velocity is killed rather
      // than bounced: a point sprite has no shape to bounce with, and a shard
      // that skids to a stop and lies there reads as wreckage where one that
      // hops reads as a bug.
      const floor = this.floor[i]!;
      if (this.positions[i * 3 + 1]! < floor) {
        this.positions[i * 3 + 1] = floor;
        this.velocities[i * 3 + 1] = 0;
        const friction = 1 - Math.min(dt * 6, 0.95);
        this.velocities[i * 3]! *= friction;
        this.velocities[i * 3 + 2]! *= friction;
      }

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
    this.floor.fill(-Infinity);
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
  /** Per-vertex tint, so a rut in gravel and a skid on tarmac share one mesh. */
  private readonly colors = new Float32Array(MAX_SKID_QUADS * 6 * 3);
  private readonly geometry = new THREE.BufferGeometry();
  /**
   * Which quad each vertex belongs to, counted from the first mark of the run
   * and never wrapped — the buffer's own index does wrap, and a wrapped index
   * cannot answer "was this mark here yet".
   */
  private readonly serials = new Float32Array(MAX_SKID_QUADS * 6);
  private next = 0;
  /** Marks laid since the last `clear`. The serial the next quad will carry. */
  private serial = 0;
  private readonly cutoff = { value: Number.MAX_SAFE_INTEGER };
  /**
   * Last contact point per emitter, so a mark can be stretched between frames.
   *
   * Six, not four: the four wheels, then two spare slots for whatever is
   * scraping. A dragging bumper lays a mark on the road the same way a locked
   * tyre does, and it should — that gouge is the evidence you left behind.
   */
  private readonly previous: (Vec3 | null)[] = [null, null, null, null, null, null];

  constructor(parent: THREE.Object3D) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aOpacity', new THREE.BufferAttribute(this.opacities, 1));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('aSerial', new THREE.BufferAttribute(this.serials, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: { uCutoff: this.cutoff },
      vertexShader: `
        attribute float aOpacity;
        attribute vec3 aColor;
        attribute float aSerial;
        varying float vOpacity;
        varying vec3 vColor;
        varying float vSerial;
        void main() {
          vOpacity = aOpacity;
          vColor = aColor;
          vSerial = aSerial;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      // `uCutoff` hides marks laid after a moment being replayed. Nothing is
      // erased to do it: the crash cinematic is a window into the past that the
      // present is still writing behind, and a mark deleted for the replay
      // would be missing from the road when it ends.
      fragmentShader: `
        uniform float uCutoff;
        varying float vOpacity;
        varying vec3 vColor;
        varying float vSerial;
        void main() {
          if (vSerial > uCutoff) discard;
          gl_FragColor = vec4(vColor, vOpacity);
        }`,
      transparent: true,
      depthWrite: false,
      // Double-sided, and this is not a detail: the quads are wound so their
      // normals face *down*, so every skid mark this game has ever laid was
      // back-face culled and invisible. The little discs under the wheels were
      // the only grip cue that ever reached the screen, which is exactly why
      // they had to be there.
      side: THREE.DoubleSide,
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
  lay(
    /** 0-3 are the wheels; 4 and 5 are scraping bodywork. */
    wheelIndex: number,
    at: Vec3,
    right: Vec3,
    width: number,
    strength: number,
    color: THREE.Color,
  ): void {
    const last = this.previous[wheelIndex];
    if (!last) {
      this.previous[wheelIndex] = { ...at };
      return;
    }
    if (strength <= 0) return;

    const span = Math.hypot(at.x - last.x, at.z - last.z);
    // A teleport — a rescue, a restart — must not draw a stripe across the map.
    if (span > 6) {
      this.previous[wheelIndex] = { ...at };
      return;
    }
    // One quad per metre and a bit, rather than one per frame.
    //
    // Ruts are laid continuously now, not only under a slide, so at racing
    // speed a per-frame quad burned through the whole ring buffer in about six
    // seconds and the tracks vanished from under the car's own tail. Holding
    // the last point until the wheel has actually travelled makes each quad
    // longer, and the same buffer holds well over a kilometre of track.
    if (span < MIN_SEGMENT) return;
    this.previous[wheelIndex] = { ...at };

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
    const serial = this.serial++;
    for (let i = 0; i < 6; i++) {
      this.serials[base + i] = serial;
      const v = quad[order[i]!]!;
      this.positions[(base + i) * 3] = v.x;
      this.positions[(base + i) * 3 + 1] = v.y + 0.015;
      this.positions[(base + i) * 3 + 2] = v.z;
      this.colors[(base + i) * 3] = color.r;
      this.colors[(base + i) * 3 + 1] = color.g;
      this.colors[(base + i) * 3 + 2] = color.b;
      this.opacities[base + i] = strength;
    }

    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aOpacity').needsUpdate = true;
    this.geometry.getAttribute('aColor').needsUpdate = true;
    this.geometry.getAttribute('aSerial').needsUpdate = true;
  }

  /** Segments laid so far. The harness checks that tracks are being made. */
  get laid(): number {
    return this.next;
  }

  /**
   * The serial the next mark will carry — a stamp for "the road as it is now".
   *
   * Recorded per frame by the crash reel and handed back to `showUpTo` while
   * the cinematic plays, so a replay of the seconds before a crash does not
   * show the tracks the car laid *during* it.
   */
  get stamp(): number {
    return this.serial;
  }

  /** Draw only marks laid before `stamp`. Null for all of them. */
  showUpTo(stamp: number | null): void {
    this.cutoff.value = stamp === null ? Number.MAX_SAFE_INTEGER : stamp - 1;
  }

  /** Called when a wheel stops marking, so the next mark does not bridge a gap. */
  lift(wheelIndex: number): void {
    this.previous[wheelIndex] = null;
  }

  clear(): void {
    this.opacities.fill(0);
    this.positions.fill(0);
    this.colors.fill(0);
    this.serials.fill(0);
    this.previous.fill(null);
    this.serial = 0;
    this.next = 0;
    this.showUpTo(null);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aOpacity').needsUpdate = true;
    this.geometry.getAttribute('aColor').needsUpdate = true;
    this.geometry.getAttribute('aSerial').needsUpdate = true;
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
const TRACK_COLOR = new THREE.Color();
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
 * What a crash throws off, in three parts, all anchored to the same point.
 *
 * A crash used to *subtract*: the picture stayed exactly as it was and there
 * was simply less car in it. Slowing the clock down made that longer, not
 * bigger. What reads as an impact is what an impact *adds* to the frame, and it
 * arrives in three layers that do different jobs and are worth keeping separate:
 *
 * - **Sparks** say metal, and at dusk they are the brightest thing on screen.
 *   They come off along the contact normal, because a spark that sprays into
 *   the thing that caused it reads as coming from nowhere.
 * - **Dust** says *ground*, and it is the layer that gives the hit a size: one
 *   radial puff in the surface's own colour, wide and gone in half a second.
 * - **Debris** is the only one that lasts. It carries the car's own velocity,
 *   lands, skids and stays put — evidence on the road after the car has gone,
 *   which is what makes the crash something that happened rather than something
 *   that was displayed.
 *
 * All three take a `severity` of 0..1 rather than an impulse: newton-seconds
 * are the damage model's unit and nothing here should have an opinion about
 * where its thresholds are.
 */
const DEBRIS_COLORS = [
  new THREE.Color(0x2b2f36),
  new THREE.Color(0x8d9199),
  new THREE.Color(0xb9c6cf),
];

/**
 * Sparks off the contact, in a cone along the normal.
 *
 * Distinct from `emitDragSparks`, which is a steady trickle from something
 * grinding along the road for as long as it is grinding. This is a one-shot
 * burst, so it is scaled by how hard the hit was rather than by how long it
 * lasted.
 */
export function emitImpactSparks(
  particles: ParticleField,
  at: Vec3,
  normal: Vec3,
  severity: number,
): void {
  if (severity <= 0) return;
  const count = Math.round(6 + severity * 34);
  const speed = 5 + severity * 12;
  for (let n = 0; n < count; n++) {
    // Along the normal with a wide scatter: a tight jet reads as a welder, and
    // a hit at an isometric camera angle has to throw some of it sideways to
    // be seen at all.
    scratch.x = normal.x * speed + (Math.random() - 0.5) * speed * 1.2;
    scratch.y = normal.y * speed * 0.5 + 1.5 + Math.random() * speed * 0.5;
    scratch.z = normal.z * speed + (Math.random() - 0.5) * speed * 1.2;
    particles.emit(
      at,
      scratch,
      SPARK_COLOR,
      0.1 + Math.random() * 0.14,
      0.2 + Math.random() * 0.35,
    );
  }
}

/**
 * The ground going up: one radial puff at the contact, in the surface's colour.
 *
 * Mostly horizontal and deliberately large. This is the layer that says how big
 * the hit was — the eye reads the width of the cloud long before it reads
 * anything about the car — so its size scales with severity where the sparks'
 * only scales in number.
 */
export function emitImpactBurst(
  particles: ParticleField,
  at: Vec3,
  color: THREE.Color,
  severity: number,
): void {
  if (severity <= 0) return;
  const count = Math.round(8 + severity * 26);
  const speed = 3 + severity * 9;
  for (let n = 0; n < count; n++) {
    // Spread around the ring rather than randomly: a random draw at this count
    // leaves visible gaps, and a puff with a hole in it reads as a mistake.
    const angle = (n / count) * Math.PI * 2 + Math.random() * 0.4;
    const out = speed * (0.5 + Math.random() * 0.7);
    scratch.x = Math.cos(angle) * out;
    scratch.y = 1.2 + Math.random() * 3.2;
    scratch.z = Math.sin(angle) * out;
    particles.emit(
      at,
      scratch,
      color,
      0.5 + severity * 0.9 + Math.random() * 0.5,
      0.35 + Math.random() * 0.4,
    );
  }
}

/**
 * Shards that leave, land, and stay.
 *
 * Given the car's own velocity so they carry down the road with it rather than
 * dropping where the hit happened — that is the difference between debris and
 * confetti — and given a floor so they come to rest on it. Three greys: dark
 * trim, bright metal, and glass.
 */
export function emitCrashDebris(
  particles: ParticleField,
  at: Vec3,
  carVelocity: Vec3,
  ground: number,
  severity: number,
): void {
  if (severity <= 0) return;
  const count = Math.round(4 + severity * 22);
  for (let n = 0; n < count; n++) {
    // A third of the car's momentum, which is enough to travel with it without
    // keeping pace: debris that stays level with the car looks bolted to it.
    scratch.x = carVelocity.x * 0.33 + (Math.random() - 0.5) * (4 + severity * 10);
    scratch.y = 2 + Math.random() * (3 + severity * 5);
    scratch.z = carVelocity.z * 0.33 + (Math.random() - 0.5) * (4 + severity * 10);
    particles.emit(
      at,
      scratch,
      DEBRIS_COLORS[n % DEBRIS_COLORS.length]!,
      0.12 + Math.random() * 0.2,
      // Long enough to still be on the road as the car leaves, short enough
      // that a stage does not slowly fill with litter.
      2.2 + Math.random() * 1.4,
      ground,
    );
  }
}

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

    // What the tyre leaves behind.
    //
    // Two different things drawn by one system. On tarmac a tyre only marks
    // when it is sliding, and the mark is rubber: black, sharp, and absent
    // until you overdo it. On anything loose the tyre is always displacing
    // material, so it leaves a rut the moment it rolls — darker than the
    // surface, because a rut is disturbed ground and a shadow in it — and the
    // rut deepens as the tyre starts to slide.
    //
    // This replaces the little white discs that used to sit under each wheel.
    // They were an honest readout of tyre saturation and they looked like a
    // debug overlay, which is what they were.
    const loose = surface.spray > 0.4;
    const marking = loose ? 1 : slip > 0.05 ? 1 : 0;
    if (surface.id !== 'ice' && marking) {
      const right = { x: 0, y: 0, z: 0 };
      // Lay the mark across the direction of travel.
      const speed = Math.hypot(carVelocity.x, carVelocity.z) || 1;
      right.x = -carVelocity.z / speed;
      right.z = carVelocity.x / speed;

      if (loose) {
        // A rut: the surface's own colour, darkened. Faint while rolling,
        // stronger under power or lock, which is what makes a corner read as
        // having been driven rather than merely passed over.
        TRACK_COLOR.setHex(surface.color).multiplyScalar(0.45);
        const bite = 0.26 + Math.min(slip * 2.4, 0.5);
        skids.lay(i, wheel.contact, right, 0.34, bite, TRACK_COLOR);
      } else {
        TRACK_COLOR.setRGB(0.03, 0.03, 0.04);
        skids.lay(i, wheel.contact, right, 0.26, Math.min(slip * 1.6, 1) * 0.55, TRACK_COLOR);
      }
    } else {
      skids.lift(i);
    }
  }
}
