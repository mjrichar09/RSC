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

/**
 * The default pool. Big enough for wheel spray, which is by far the hungriest
 * emitter — and small enough that it is worth knowing what else shares it.
 */
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
  attribute float aSeed;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vSeed;
  void main() {
    vAlpha = alpha;
    vColor = aColor;
    vSeed = aSeed;
    gl_PointSize = max(size * uScale, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const PARTICLE_FRAGMENT = `
  uniform float uSoft;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vSeed;
  float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float pNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(pHash(i), pHash(i + vec2(1.0, 0.0)), f.x),
               mix(pHash(i + vec2(0.0, 1.0)), pHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    // Haze is a cloud, not a pebble. A soft disc was still a disc: a trail of
    // them read as a row of tiles laid along the road. Each puff is ragged
    // now — its density broken up by noise seeded per particle, so no two are
    // the same shape — and it is the overlap of many faint ones that makes the
    // cloud, not the outline of any one.
    if (uSoft > 0.5) {
      vec2 at = gl_PointCoord * 3.0 + vSeed * 17.0;
      float lumps = pNoise(at) * 0.65 + pNoise(at * 2.3) * 0.35;
      float fall = 1.0 - r * 4.0;
      float density = fall * fall * (0.35 + 1.1 * lumps);
      gl_FragColor = vec4(vColor * (0.9 + 0.2 * lumps), vAlpha * clamp(density, 0.0, 1.0));
      return;
    }
    gl_FragColor = vec4(vColor, vAlpha * (1.0 - r * 3.2));
  }`;

export class ParticleField {
  readonly points: THREE.Points;

  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly velocities: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
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
  private readonly floor: Float32Array;
  /**
   * Gravity multiplier per particle.
   *
   * One number, because the three things a crash throws are three different
   * materials sharing one integrator: dust hangs, sparks arc, and a shard of
   * bodywork falls like the lump of steel it is. Thrown at the same speed under
   * the same gravity they all read as confetti — measured off a `shoot` frame,
   * the debris was still in the air two and a half seconds after the impact.
   */
  private readonly drop: Float32Array;
  /** Opacity at birth, 0..1. Spray is solid; dust and mist are a veil. */
  private readonly peak: Float32Array;
  /** Size at birth, and how much it swells by the end of its life (1 = doubles). */
  private readonly size0: Float32Array;
  private readonly grow: Float32Array;
  /** A random number per particle, for the shape of a haze puff. */
  private readonly seeds: Float32Array;
  /**
   * Fraction of life spent fading *in*. A puff that appears at full strength
   * is a puff you see arrive, and a stream of them arriving is the tiling.
   */
  fadeIn = 0;
  /**
   * The soft layer: dust plumes, snow powder, mist and tyre smoke.
   *
   * Its own pool, for the reason every pool here is its own: gravel spray
   * churns the main one at thousands a second, and a dust cloud that has to
   * hang for two seconds would be recycled before it had drifted a metre. A
   * child of the main field's points, so whatever hides the spray — a replay,
   * a reel — hides the haze with it, and `update` advances both.
   */
  readonly haze: ParticleField | null = null;
  private next = 0;
  /** How many slots this field has. Its own, not the module's. */
  private readonly capacity: number;
  /**
   * How the alpha falls off over a particle's life: `alpha = t ** fade`.
   *
   * 2 for spray, which should be gone almost as soon as it is thrown. Well
   * below 1 for anything that has to stay *legible* while it sits there — a
   * shard of bodywork lying in the road is evidence, and evidence that has
   * faded to a quarter opacity a third of the way through its life is not.
   */
  fade = 2;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;

  /**
   * `capacity` is a whole separate pool, and that is the point of it.
   *
   * Everything used to share one 900-slot ring, and wheel spray on a loose
   * surface fills it at about 2 400 particles a second — measured, a crash's
   * debris was *entirely* recycled within half a second of a three-second
   * lifetime, and a crash happens while the car is sliding on gravel with
   * every wheel spraying. Its own field cannot be evicted by anything.
   */
  constructor(
    parent: THREE.Object3D,
    capacity = MAX_PARTICLES,
    options: { haze?: number; soft?: boolean } = {},
  ) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.velocities = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.floor = new Float32Array(capacity).fill(-Infinity);
    this.drop = new Float32Array(capacity).fill(1);
    this.peak = new Float32Array(capacity).fill(1);
    this.size0 = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.seeds = new Float32Array(capacity);

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(this.seeds, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      uniforms: { uScale: { value: 40 }, uSoft: { value: options.soft ? 1 : 0 } },
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    parent.add(this.points);

    if (options.haze) {
      const haze = new ParticleField(this.points, options.haze, { soft: true });
      // A veil fades more evenly than a thrown stone: gone by the end, but
      // still there in the middle of its life, which is when it is the plume.
      haze.fade = 1.3;
      haze.fadeIn = 0.25;
      this.haze = haze;
    }
  }

  /** Thinning applies to the haze too, so a phone gets less of both. */
  set densityAll(value: number) {
    this.density = value;
    if (this.haze) this.haze.density = value;
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
    /**
     * `floor` is a height to come to rest on, for anything that should land;
     * `drop` scales gravity, for anything heavier or lighter than spray.
     */
    options?: { floor?: number; drop?: number; peak?: number; grow?: number },
  ): void {
    if (this.density < 1) {
      // Deterministic thinning: an accumulator rather than a random draw, so a
      // headless run is still reproducible and a steady jet does not flicker.
      this.thin += this.density;
      if (this.thin < 1) return;
      this.thin -= 1;
    }
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;

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
    this.size0[i] = size;
    this.grow[i] = options?.grow ?? 0;
    this.peak[i] = options?.peak ?? 1;
    this.seeds[i] = Math.random();
    this.life[i] = life;
    this.maxLife[i] = life;
    this.floor[i] = options?.floor ?? -Infinity;
    this.drop[i] = options?.drop ?? 1;
    this.alphas[i] = 1;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) {
        this.alphas[i] = 0;
        continue;
      }
      this.life[i]! -= dt;

      // Gravity plus a little drag, so spray arcs and settles instead of
      // flying off in a straight line.
      this.velocities[i * 3 + 1]! -= 9.81 * dt * 0.55 * this.drop[i]!;
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
      this.alphas[i] = (this.fade === 2 ? t * t : t ** this.fade) * this.peak[i]!;
      if (this.fadeIn > 0) this.alphas[i]! *= Math.min((1 - t) / this.fadeIn, 1);
      if (this.grow[i]! > 0) this.sizes[i] = this.size0[i]! * (1 + this.grow[i]! * (1 - t));
    }
    this.haze?.update(dt);

    for (const name of ['position', 'aColor', 'size', 'alpha', 'aSeed']) {
      this.geometry.getAttribute(name).needsUpdate = true;
    }
  }

  /** How many particles are currently alive. The harness and the tests read it. */
  get alive(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.life[i]! > 0) n++;
    return n;
  }

  /**
   * Living particles that were given at least `minLifespan` seconds to live.
   *
   * The way to ask "is the crash debris still here" without tagging particles:
   * nothing else in the game is thrown with a lifespan over two seconds, so a
   * lifespan is an identity. A pool being churned faster than its contents can
   * live shows up here and nowhere else — `alive` stays pinned at the capacity
   * the whole time, because it is full of the thing doing the churning.
   */
  survivors(minLifespan: number): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! > 0 && this.maxLife[i]! >= minLifespan) n++;
    }
    return n;
  }

  /** The lowest living particle, so a test can see that debris came to rest. */
  get lowest(): number {
    let low = Infinity;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! > 0) low = Math.min(low, this.positions[i * 3 + 1]!);
    }
    return low;
  }

  /**
   * Tell the field how many screen pixels a world metre covers, so points stay
   * the right physical size as the orthographic camera zooms.
   */
  setScale(pixelsPerMetre: number): void {
    this.material.uniforms.uScale!.value = pixelsPerMetre;
    this.haze?.setScale(pixelsPerMetre);
  }

  clear(): void {
    this.life.fill(0);
    this.alphas.fill(0);
    this.floor.fill(-Infinity);
    this.drop.fill(1);
    this.geometry.getAttribute('alpha').needsUpdate = true;
    this.haze?.clear();
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
  private mode: 'none' | 'rain' | 'snow' | 'dust' = 'none';

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
    this.mode =
      weather === 'rain' ? 'rain' : weather === 'snowfall' ? 'snow' : weather === 'dust' ? 'dust' : 'none';
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
    } else if (this.mode === 'dust') {
      // Grit, not flakes: small, opaque enough to read against red ground,
      // and the colour of what is blowing.
      (u.uColor!.value as THREE.Color).setHex(0xd59a68);
      u.uSize!.value = 0.11;
      u.uStretch!.value = 1.6;
      u.uOpacity!.value = 0.6;
    }
  }

  /** Keep the volume over the car and let it fall. */
  update(dt: number, focus: THREE.Vector3, pixelsPerMetre: number): void {
    if (this.mode === 'none') return;
    this.material.uniforms.uScale!.value = pixelsPerMetre;

    // Dust barely falls at all; it is carried sideways, hard, close to the
    // ground — which is why it wraps low as well as at the edges.
    const fall = this.mode === 'rain' ? 34 : this.mode === 'dust' ? 0.8 : 5;
    const drift = this.mode === 'rain' ? 4 : this.mode === 'dust' ? 26 : 2.2;
    const half = this.extent / 2;

    for (let i = 0; i < this.count; i++) {
      const y = i * 3 + 1;
      this.positions[y]! -= fall * this.speeds[i]! * dt;
      this.positions[i * 3]! += drift * dt;

      // Wrap rather than respawn: the volume follows the car, so a particle
      // that falls out of the bottom belongs back at the top of it.
      // A storm sits on the ground: anything left high from the volume's
      // first fill, or a stage that drops away under it, comes back down.
      if (this.mode === 'dust' && this.positions[y]! > focus.y + 24) {
        this.positions[y] = focus.y + Math.random() * 20;
      }
      if (this.positions[y]! < focus.y - 4) {
        this.positions[y] = focus.y + (this.mode === 'dust' ? 4 + Math.random() * 18 : 55);
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
  // Sized against what the camera actually is: orthographic at about 14 m of
  // half-height, which puts a metre at roughly 39 px on a 1080-tall window. A
  // 0.12 m spark is five pixels — real, emitted, and invisible from the seat.
  const count = Math.round(8 + severity * 40);
  const speed = 6 + severity * 14;
  for (let n = 0; n < count; n++) {
    // Along the normal with a wide scatter: a tight jet reads as a welder, and
    // a hit at an isometric camera angle has to throw some of it sideways to
    // be seen at all.
    scratch.x = normal.x * speed + (Math.random() - 0.5) * speed * 1.2;
    scratch.y = normal.y * speed * 0.5 + 1.5 + Math.random() * speed * 0.5;
    scratch.z = normal.z * speed + (Math.random() - 0.5) * speed * 1.2;
    // Hot metal, thrown hard and falling fast: a spark that floats is an ember.
    particles.emit(at, scratch, SPARK_COLOR, 0.16 + Math.random() * 0.2, 0.25 + Math.random() * 0.4, {
      drop: 1.6,
    });
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
  const count = Math.round(10 + severity * 30);
  const speed = 3.5 + severity * 10;
  for (let n = 0; n < count; n++) {
    // Spread around the ring rather than randomly: a random draw at this count
    // leaves visible gaps, and a puff with a hole in it reads as a mistake.
    const angle = (n / count) * Math.PI * 2 + Math.random() * 0.4;
    const out = speed * (0.5 + Math.random() * 0.7);
    scratch.x = Math.cos(angle) * out;
    scratch.y = 1.2 + Math.random() * 3.2;
    scratch.z = Math.sin(angle) * out;
    // Dust hangs: it is the only one of the three that should still be in the
    // air when the car has gone past.
    particles.emit(
      at,
      scratch,
      color,
      0.7 + severity * 1.3 + Math.random() * 0.6,
      0.45 + Math.random() * 0.5,
      { drop: 0.35 },
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
  const count = Math.round(6 + severity * 26);
  for (let n = 0; n < count; n++) {
    // A third of the car's momentum, which is enough to travel with it without
    // keeping pace: debris that stays level with the car looks bolted to it.
    scratch.x = carVelocity.x * 0.33 + (Math.random() - 0.5) * (4 + severity * 10);
    // Low, because it falls like steel. Thrown as high as the dust it comes
    // with, a shard spends most of a three-second life in the air and reads as
    // confetti rather than as wreckage.
    scratch.y = 1.2 + Math.random() * (1.6 + severity * 2.4);
    scratch.z = carVelocity.z * 0.33 + (Math.random() - 0.5) * (4 + severity * 10);
    particles.emit(
      at,
      scratch,
      DEBRIS_COLORS[n % DEBRIS_COLORS.length]!,
      0.18 + Math.random() * 0.26,
      // Long enough to still be on the road as the car leaves, short enough
      // that a stage does not slowly fill with litter.
      2.2 + Math.random() * 1.4,
      { floor: ground, drop: 2.4 },
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
/**
 * How hot a disc has to be before water coming off it steams, °C.
 *
 * Well under the glow, because the two say different things. Glow is a disc in
 * trouble; steam is the moment it stops being in trouble, and the player needs
 * to see that it worked — a driver who has taken the long way round through
 * standing water to save the brakes has bought something, and the steam is the
 * receipt. Ordinary brakes at the end of a normal stage sit under this, so it
 * only ever appears where it means something.
 */
const STEAM_FROM_C = 140;

/** Soft-layer colours that are not the surface's own. */
const POWDER = new THREE.Color(0xf1f5f9);
const MIST = new THREE.Color(0xdbe8ef);
const SMOKE = new THREE.Color(0xc4c8cc);
const HAZE_COLOR = new THREE.Color();
const up = { x: 0, y: 0, z: 0 };
const born = { x: 0, y: 0, z: 0 };

/** A whole number of emissions from a rate, carrying the fraction by chance. */
const howMany = (perSecond: number, dt: number): number => {
  const want = perSecond * dt;
  const whole = Math.floor(want);
  return whole + (Math.random() < want - whole ? 1 : 0);
};

/**
 * What a tyre throws, by what it is running on.
 *
 * One plume for every surface used to be the whole of it — surface-coloured
 * pebbles, only while the tyre was past its limit — so a car cruising a gravel
 * road at 120 km/h raised nothing at all, snow came off as white gravel and a
 * ford was a brown puff. Each surface throws what it is made of now:
 *
 * - **Gravel and dirt** raise a dust plume that trails the car at speed, gripping
 *   or not, and throw heavy clods backward when the tyre is sliding.
 * - **Snow** goes up in powder: rooster tails that hang and drift.
 * - **Water** is thrown out sideways in sheets, with mist behind.
 * - **Mud** comes off in heavy dark clumps and raises nothing.
 * - **Tarmac** smokes, only when the tyre is sliding, which is the one thing
 *   that says a tarmac tyre has let go.
 *
 * Plumes come off the rear wheels only: the fronts run in the same air, and
 * four plumes are twice the particles for a cloud that looks the same.
 */
function emitSpray(
  particles: ParticleField,
  wheel: WheelState,
  index: number,
  slip: number,
  carVelocity: Vec3,
  dt: number,
): void {
  const surface = wheel.surface;
  const haze = particles.haze;
  const speed = Math.hypot(carVelocity.x, carVelocity.z);
  const bx = speed > 0.5 ? -carVelocity.x / speed : 0;
  const bz = speed > 0.5 ? -carVelocity.z / speed : 0;
  const rear = index >= 2;
  const pace = Math.min(Math.max((speed - 4) / 22, 0), 1.4);
  const at = wheel.contact;
  up.x = at.x;
  up.y = at.y + 0.08;
  up.z = at.z;

  // What a sliding tyre throws is the grip readout, so it keeps the rate the
  // single plume always had — about 2 640 a second per unit of slip, capped at
  // ten a frame. The dust is on top of that, never instead of it.
  const sliding = Math.min(slip * surface.spray * 2640, 600);
  const clods = (rate: number, color: THREE.Color, size: number, drop: number) => {
    for (let n = howMany(rate, dt); n > 0; n--) {
      scratch.x = bx * speed * 0.28 + carVelocity.x * 0.35 + (Math.random() - 0.5) * 3.5;
      scratch.y = 1.4 + Math.random() * 3.0 * Math.min(0.4 + slip, 1);
      scratch.z = bz * speed * 0.28 + carVelocity.z * 0.35 + (Math.random() - 0.5) * 3.5;
      particles.emit(up, scratch, color, size * (0.6 + Math.random() * 0.8), 0.5 + Math.random() * 0.7, { drop });
    }
  };
  const plume = (
    rate: number,
    color: THREE.Color,
    size: number,
    peak: number,
    life: number,
    lift: number,
    drop: number,
    grow: number,
  ) => {
    if (!haze) return;
    // Twice as many at a little under the opacity, born scattered round the
    // wheel rather than all at the contact patch, and swelling to three times
    // their size: a cloud is many faint things overlapping, and it billows.
    for (let n = howMany(rate * 2, dt); n > 0; n--) {
      born.x = up.x + (Math.random() - 0.5) * 1.4;
      born.y = up.y + Math.random() * 0.5;
      born.z = up.z + (Math.random() - 0.5) * 1.4;
      scratch.x = carVelocity.x * 0.25 + bx * 1.5 + (Math.random() - 0.5) * 2.6;
      scratch.y = lift * (0.4 + Math.random());
      scratch.z = carVelocity.z * 0.25 + bz * 1.5 + (Math.random() - 0.5) * 2.6;
      haze.emit(born, scratch, color, size * (0.65 + Math.random() * 1.0), life * (0.7 + Math.random() * 0.7), {
        peak: peak * 0.8,
        grow: grow * 1.6,
        drop,
      });
    }
  };

  switch (surface.id) {
    case 'gravel':
    case 'dirt':
    case 'grass': {
      const dusty = surface.id === 'grass' ? 0.35 : surface.id === 'dirt' ? 1.1 : 1;
      if (rear) {
        HAZE_COLOR.setHex(surface.color).offsetHSL(0, -0.12, 0.2);
        plume((pace * 16 + slip * 30) * dusty, HAZE_COLOR, 2.1, 0.3 * dusty, 2.2, 0.8, -0.03, 1.3);
      }
      SPRAY_COLOR.setHex(surface.color).multiplyScalar(0.8);
      clods(sliding + (rear ? pace * 10 : 0), SPRAY_COLOR, 0.24, 1.5);
      break;
    }
    case 'mud': {
      SPRAY_COLOR.setHex(surface.color).multiplyScalar(0.7);
      clods(sliding + (rear ? pace * 14 : 0), SPRAY_COLOR, 0.34, 1.9);
      break;
    }
    case 'snow': {
      if (rear) plume(pace * 26 + slip * 45, POWDER, 1.25, 0.5, 1.4, 2.6 * (0.6 + slip), 0.12, 0.9);
      SPRAY_COLOR.setHex(0xf6f9fb);
      clods(sliding, SPRAY_COLOR, 0.22, 1.2);
      break;
    }
    case 'water': {
      // Sheets thrown out to both sides, carried along with the car.
      const wet = Math.min(speed / 10, 1.6);
      for (let n = howMany(wet * 55, dt); n > 0; n--) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const out = 2.5 + Math.random() * 3.5;
        scratch.x = carVelocity.x * 0.45 + -bz * side * out;
        scratch.y = 2.0 + Math.random() * 3.2;
        scratch.z = carVelocity.z * 0.45 + bx * side * out;
        particles.emit(up, scratch, MIST, 0.2 + Math.random() * 0.24, 0.45 + Math.random() * 0.45, { drop: 1.3 });
      }
      plume(wet * 14, MIST, 1.7, 0.26, 1.3, 1.0, -0.02, 1.0);
      break;
    }
    case 'tarmac': {
      if (slip > 0.08) plume(slip * 60, SMOKE, 1.6, 0.34, 2.2, 0.9, -0.06, 1.6);
      break;
    }
    default:
      break;
  }
}

export function updateWheelEffects(
  particles: ParticleField,
  skids: SkidMarks,
  wheels: readonly WheelState[],
  carVelocity: Vec3,
  dt: number,
  /** Disc temperatures, °C, when the damage model is running. */
  brakeTemp?: readonly number[],
): void {
  for (let i = 0; i < wheels.length; i++) {
    const wheel = wheels[i]!;
    if (!wheel.grounded) {
      skids.lift(i);
      continue;
    }

    // A hot disc dropped into standing water. Emitted from the contact patch
    // rather than the hub so it rises past the wheel, and scaled by how much
    // heat there actually is, so a lightly warm brake gives a wisp and a
    // cooked one boils.
    const disc = brakeTemp?.[i] ?? 0;
    if (wheel.surface.id === 'water' && disc > STEAM_FROM_C) {
      emitSteam(
        particles,
        wheel.contact,
        carVelocity,
        Math.min((disc - STEAM_FROM_C) / 260, 1),
        dt,
      );
    }

    const slip = Math.max(0, wheel.saturation - 0.95);
    const surface = wheel.surface;
    emitSpray(particles, wheel, i, slip, carVelocity, dt);

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
