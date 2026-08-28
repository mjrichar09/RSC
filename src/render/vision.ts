/**
 * The view through the windscreen.
 *
 * The scene is rendered into a target and then composited through one full
 * screen pass that does four things:
 *
 * - **Darkens everything outside the headlight cone**, so a night stage is
 *   driven by what the beams reach rather than by a dimmed version of the day.
 * - **Blurs what is dark or dirty**, because the failure of night vision is not
 *   only that things are dim, it is that you cannot resolve them.
 * - **Soils the screen** with rain, snow or mud, in that material's own shape.
 * - **Wipes it**, in sweeps, with the blade visibly crossing.
 *
 * One pass and one half-resolution blur target: the cost is a few full-screen
 * fetches, which on a scene this simple is far cheaper than the geometry.
 *
 * Everything it draws is decided in `sim/vision.ts`. This module owns *how* it
 * looks and none of *when*.
 */

import * as THREE from 'three';
import type { VisionState } from '../sim/vision.js';

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Separable blur, run twice into a half-size target. */
const BLUR = /* glsl */ `
  uniform sampler2D uScene;
  uniform vec2 uDirection;
  varying vec2 vUv;
  void main() {
    vec4 sum = texture2D(uScene, vUv) * 0.227;
    sum += texture2D(uScene, vUv + uDirection * 1.384) * 0.316;
    sum += texture2D(uScene, vUv - uDirection * 1.384) * 0.316;
    sum += texture2D(uScene, vUv + uDirection * 3.230) * 0.070;
    sum += texture2D(uScene, vUv - uDirection * 3.230) * 0.070;
    gl_FragColor = sum;
  }
`;

const COMPOSITE = /* glsl */ `
  uniform sampler2D uScene;
  uniform sampler2D uBlur;
  uniform vec2 uOrigin;      // car, in uv
  uniform vec2 uForward;     // where the car points, in uv
  uniform float uAspect;
  uniform float uDarkness;   // 0 day, 1 night
  uniform float uReach;      // cone length in uv
  uniform float uAngle;      // cone half-angle, radians
  uniform float uOcclusion;  // 0..1 muck on the screen
  uniform float uKind;       // 0 water, 1 snow, 2 mud
  uniform float uWiper;      // blade position 0..1, or -1 when parked
  uniform float uTime;
  /** How dark the darkest part of the world is allowed to get. */
  uniform float uFloor;
  varying vec2 vUv;

  // Cheap value noise: enough for droplets and splatter, and no texture to load.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y);
  }

  void main() {
    vec2 toPixel = vec2((vUv.x - uOrigin.x) * uAspect, vUv.y - uOrigin.y);
    float distance = length(toPixel);
    vec2 direction = distance > 0.0001 ? toPixel / distance : vec2(0.0, 1.0);

    // The lit cone: full inside, feathered at its edge, and fading out with
    // range the way a beam does.
    float alignment = dot(direction, normalize(vec2(uForward.x * uAspect, uForward.y)));
    float angle = acos(clamp(alignment, -1.0, 1.0));
    float inCone = 1.0 - smoothstep(uAngle * 0.55, uAngle, angle);
    float inRange = 1.0 - smoothstep(uReach * 0.45, uReach, distance);
    // A pool of light immediately around the car, so it is never itself dark.
    float nearby = 1.0 - smoothstep(0.02, 0.10, distance);
    float lit = clamp(max(inCone * inRange, nearby), 0.0, 1.0);

    // How much of this pixel is hidden: dark outside the beams, plus muck.
    float dark = uDarkness * (1.0 - lit);

    // Soiling. Water beads and runs, snow settles in patches, mud splatters in
    // hard-edged blobs — the same number drawn three ways.
    // Contrast matters more than coverage: droplets are small bright-edged
    // things with clear glass between them, and a soft even wash of grain
    // reads as a dirty *lens* rather than as weather on a windscreen.
    float grain;
    if (uKind < 0.5) {
      // Rain: fine, vertically stretched, running down.
      grain = noise(vUv * vec2(90.0, 40.0) + vec2(0.0, uTime * 1.4));
      grain = smoothstep(0.62, 0.98, grain);
    } else if (uKind < 1.5) {
      // Snow: bigger, softer, settling in patches.
      grain = noise(vUv * 26.0 + uTime * 0.06);
      grain = smoothstep(0.52, 0.9, grain);
    } else {
      // Mud: large hard-edged blobs that stay where they land.
      grain = noise(vUv * 15.0);
      grain = smoothstep(0.42, 0.62, grain);
    }
    // Heavier at the edges: the middle of a windscreen is what stays clear.
    float edge = smoothstep(0.15, 0.75, length((vUv - 0.5) * vec2(uAspect, 1.0)));
    // Multiplied by the grain rather than mixed toward it: where there is no
    // droplet there is clear glass, which is what makes the rest read as one.
    float muck = uOcclusion * mix(0.7, 1.15, edge) * grain;

    // The blade. Everything it has already crossed this sweep is clean, and the
    // edge itself is a dark line with a clean band just behind it.
    if (uWiper >= 0.0) {
      float bladeX = uWiper;
      float passed = step(vUv.x, bladeX);
      muck *= mix(1.0, 0.08, passed);
      float onBlade = 1.0 - smoothstep(0.0, 0.012, abs(vUv.x - bladeX));
      muck = mix(muck, 0.85, onBlade * 0.6);
    }
    muck = clamp(muck, 0.0, 1.0);

    float hidden = clamp(dark + muck * (1.0 - dark * 0.4), 0.0, 1.0);

    vec4 sharp = texture2D(uScene, vUv);
    vec4 soft = texture2D(uBlur, vUv);
    vec4 colour = mix(sharp, soft, clamp(hidden * 1.15, 0.0, 1.0));

    // Muck is lit by your own lights, so it greys rather than blackens; the
    // dark is genuinely dark.
    vec3 tint = uKind < 1.5 ? vec3(0.72, 0.76, 0.82) : vec3(0.42, 0.33, 0.24);
    // Never fully black: a driver's eyes adapt, and a screen that goes to zero
    // outside the beams is not dramatic, it is unplayable.
    colour.rgb = mix(colour.rgb, colour.rgb * uFloor, dark);
    colour.rgb = mix(colour.rgb, tint * (0.16 + 0.30 * (1.0 - uDarkness)), muck * 0.6);

    // Back to sRGB by hand. Rendering into a target skips the conversion three
    // does on its way to the canvas, and a ShaderMaterial gets no colour-space
    // epilogue of its own — so without this the whole game is displayed as its
    // own linear values and every frame comes out looking like midnight.
    //
    // The exact transfer function rather than a 2.2 gamma, because the pass
    // switches itself off in clear weather: an approximation would show up as
    // the whole screen changing brightness the moment it starts raining.
    vec3 linear = max(colour.rgb, 0.0);
    gl_FragColor = vec4(
      mix(linear * 12.92, 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, linear)),
      1.0);
  }
`;

export class VisionPass {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly sceneTarget: THREE.WebGLRenderTarget;
  private readonly blurA: THREE.WebGLRenderTarget;
  private readonly blurB: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly blurMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  /** 0 turns the whole effect off; 1 is full strength. */
  strength = 1;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;

    const options = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true };
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, options);
    // Half resolution for the blur: it is a blur, and nobody can tell.
    this.blurA = new THREE.WebGLRenderTarget(1, 1, { ...options, depthBuffer: false });
    this.blurB = new THREE.WebGLRenderTarget(1, 1, { ...options, depthBuffer: false });

    this.blurMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: BLUR,
      uniforms: {
        uScene: { value: null },
        uDirection: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: COMPOSITE,
      uniforms: {
        uScene: { value: null },
        uBlur: { value: null },
        uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
        uForward: { value: new THREE.Vector2(0, 1) },
        uAspect: { value: 1.78 },
        uDarkness: { value: 0 },
        uReach: { value: 0.6 },
        uAngle: { value: 0.4 },
        uOcclusion: { value: 0 },
        uKind: { value: 0 },
        uWiper: { value: -1 },
        uTime: { value: 0 },
        uFloor: { value: 0.22 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setSize(width: number, height: number): void {
    const ratio = this.renderer.getPixelRatio();
    this.sceneTarget.setSize(width * ratio, height * ratio);
    this.blurA.setSize(Math.max(Math.floor((width * ratio) / 2), 1), Math.max(Math.floor((height * ratio) / 2), 1));
    this.blurB.setSize(this.blurA.width, this.blurA.height);
    this.compositeMaterial.uniforms.uAspect!.value = width / Math.max(height, 1);
  }

  /** True when the effect would change nothing, so the pass can be skipped. */
  idle(state: VisionState): boolean {
    return this.strength <= 0 || (state.darkness < 0.02 && state.occlusion < 0.02);
  }

  /**
   * Render the scene through the windscreen.
   *
   * `origin` and `forward` are the car's position and heading in screen uv —
   * the cone is anchored to the car on screen, not to the middle of it.
   */
  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    state: VisionState,
    origin: { x: number; y: number },
    forward: { x: number; y: number },
    time: number,
  ): void {
    if (this.idle(state)) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }

    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(scene, camera);

    // Two-tap separable blur at half size.
    this.quad.material = this.blurMaterial;
    const uniforms = this.blurMaterial.uniforms;
    uniforms.uScene!.value = this.sceneTarget.texture;
    (uniforms.uDirection!.value as THREE.Vector2).set(1 / this.blurA.width, 0);
    this.renderer.setRenderTarget(this.blurA);
    this.renderer.render(this.quadScene, this.quadCamera);

    uniforms.uScene!.value = this.blurA.texture;
    (uniforms.uDirection!.value as THREE.Vector2).set(0, 1 / this.blurA.height);
    this.renderer.setRenderTarget(this.blurB);
    this.renderer.render(this.quadScene, this.quadCamera);

    const c = this.compositeMaterial.uniforms;
    c.uScene!.value = this.sceneTarget.texture;
    c.uBlur!.value = this.blurB.texture;
    (c.uOrigin!.value as THREE.Vector2).set(origin.x, origin.y);
    (c.uForward!.value as THREE.Vector2).set(forward.x, forward.y);
    c.uDarkness!.value = state.darkness * this.strength;
    c.uReach!.value = state.coneReach;
    c.uAngle!.value = state.coneAngle;
    c.uOcclusion!.value = state.occlusion * this.strength;
    c.uKind!.value = state.kind === 'mud' ? 2 : state.kind === 'snow' ? 1 : 0;
    c.uWiper!.value = state.wiper ?? -1;
    c.uTime!.value = time;
    // At full strength the world outside the beams keeps a fifth of its light;
    // at low strength it barely dims at all.
    c.uFloor!.value = 1 - 0.8 * this.strength;

    this.quad.material = this.compositeMaterial;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }
}
