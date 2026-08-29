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
import { NEUTRAL_GRADE, gradeStrength, type Grade } from './grade.js';

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
  uniform float uOcclusion;  // 0..1 muck on the swept glass
  uniform float uCrust;      // 0..1 muck where the blades never reach
  uniform float uKind;       // 0 water, 1 snow, 2 mud
  uniform float uWiper;      // blade position 0..1, or -1 when parked
  uniform float uWiperBack;  // 1 while the blade is on its return stroke
  uniform float uTime;
  /** How dark the darkest part of the world is allowed to get. */
  uniform float uFloor;
  // The grade: the colour of the light, and what it does to shadows and colour.
  uniform vec3 uGain;
  uniform vec3 uLift;
  uniform float uSaturation;
  uniform float uContrast;
  uniform float uVignette;
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

  /**
   * Beads of water on glass.
   *
   * One droplet per cell of a jittered grid, each with its own size and its own
   * slow slide downward — so what is on the glass is a scatter of round things
   * with clear glass between them, which is what a windscreen in rain actually
   * looks like. A wash of noise reads as a dirty lens instead.
   *
   * Returns coverage, and writes the bead's bright edge into the rim output:
   * that edge is
   * most of why a droplet reads as a droplet rather than as a grey blob.
   */
  float droplets(vec2 uv, float scale, float speed, out float rim) {
    vec2 p = uv * scale;
    // Slow drift down the glass, faster for the bigger beads.
    p.y += uTime * speed;
    vec2 cell = floor(p);
    vec2 f = fract(p);

    float best = 0.0;
    rim = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 o = vec2(float(dx), float(dy));
        vec2 id = cell + o;
        float h = hash(id);
        float h2 = hash(id + 17.3);
        // Not every cell has a bead, and the ones that do sit anywhere in it.
        if (h > 0.72) continue;
        vec2 centre = o + vec2(0.2 + 0.6 * h2, 0.2 + 0.6 * fract(h * 31.7));
        float radius = 0.13 + 0.3 * h;
        float d = length((f - centre) * vec2(1.0, 1.15));
        float body = 1.0 - smoothstep(radius * 0.55, radius, d);
        best = max(best, body);
        rim = max(rim, (1.0 - smoothstep(radius * 0.72, radius * 1.05, d)) * smoothstep(radius * 0.5, radius * 0.85, d));
      }
    }
    return best;
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
    // The car itself. Not a pool of light — a hole in the whole effect: the
    // car has to stay sharp and legible whatever the weather is doing, because
    // its bodywork is where damage is read, and a blurred dark car in the rain
    // is a game that has hidden its own most important readout.
    // Radii in aspect-corrected uv, so this is an ellipse a little wider than
    // the car at the default zoom rather than a circle that clips its flanks
    // on a widescreen display.
    float onCar = 1.0 - smoothstep(0.035, 0.095, distance);
    float lit = clamp(max(inCone * inRange, onCar), 0.0, 1.0);

    // How much of this pixel is hidden: dark outside the beams, plus muck.
    float dark = uDarkness * (1.0 - lit);

    /*
     * What is on the glass, and where the blades can reach.
     *
     * A windscreen is not evenly dirty. The blades carve an arc and everything
     * outside it — the corners, the top, the strip along the bottom — keeps
     * whatever has landed on it for the whole stage. That hard, lumpy boundary
     * between swept glass and caked glass is the thing that makes a photograph
     * of a windscreen unmistakable, and no amount of grain over the whole frame
     * gets anywhere near it.
     *
     * The pivot sits below the bottom of the frame, as a real one does, so the
     * arc is wide at the top and pinched at the bottom.
     */
    vec2 fromPivot = vec2((vUv.x - 0.5) * uAspect, vUv.y + 0.62);
    float sweepR = length(fromPivot);
    float sweepA = atan(fromPivot.x, fromPivot.y);

    /*
     * Sized against the frame rather than picked by eye: on a 16:9 screen the
     * top middle sits 1.62 from the pivot and the top corners 1.84, so a reach
     * between the two clears the middle and leaves the corners caked. The
     * bottom corners are outside the angle for the same reason a real blade
     * never reaches them.
     */
    // A crumbling edge rather than a drawn one: the crust ends where it
    // happens to end, in lumps at two scales, and that ragged boundary is most
    // of what makes a photograph of a windscreen unmistakable.
    // The lumps move the whole boundary rather than one side of it. Applied to
    // the far edge alone they can push it past the near one, and a smoothstep
    // whose edges have crossed over is undefined — which showed up as crust
    // blooming in the middle of the swept arc wherever the noise dipped.
    float lumps = (noise(vUv * 20.0) - 0.5) * 0.13 + (noise(vUv * 6.0) - 0.5) * 0.11;
    float angleEdge = 0.80 + lumps;
    float reachEdge = 1.74 + lumps;
    float inAngle = 1.0 - smoothstep(angleEdge - 0.03, angleEdge + 0.03, abs(sweepA));
    float inReach = 1.0 - smoothstep(reachEdge - 0.04, reachEdge + 0.04, sweepR);
    float swept = inAngle * inReach;

    // Soiling. Water beads and runs, snow settles in patches, mud splatters in
    // hard-edged blobs — the same number drawn three ways.
    float grain;
    float rim = 0.0;
    if (uKind < 0.5) {
      // Rain: beads of two sizes, sliding, plus the runnels they leave behind.
      float rimA;
      float rimB;
      float big = droplets(vUv, 26.0, 0.03, rimA);
      float small = droplets(vUv + 3.1, 52.0, 0.012, rimB);
      rim = max(rimA, rimB * 0.6);
      float runnel = smoothstep(0.55, 0.95, noise(vUv * vec2(120.0, 9.0) + vec2(0.0, uTime * 0.5)));
      grain = clamp(max(big, small * 0.75) + runnel * 0.35, 0.0, 1.0);
    } else if (uKind < 1.5) {
      // Snow: bigger, softer, settling in clumps that pack together.
      float clump = noise(vUv * 20.0 + uTime * 0.02) * 0.7 + noise(vUv * 46.0) * 0.3;
      grain = smoothstep(0.42, 0.78, clump);
    } else {
      // Mud: large hard-edged blobs that stay exactly where they land.
      float blob = noise(vUv * 11.0) * 0.65 + noise(vUv * 31.0) * 0.35;
      grain = smoothstep(0.40, 0.58, blob);
    }

    // Inside the arc: whatever has arrived since the last sweep, in beads and
    // clumps with clear glass between them. Outside it: caked, and much more
    // solid — the crust is nearly continuous, with only the texture of the
    // material breaking it up.
    // The swept glass is *nearly* clear — a scatter of beads with glass
    // between them, which is what the arc is for. The crust is nearly solid,
    // and the two are kept apart all the way to the end: they are lit
    // differently, they blur differently, and mixing them into one number is
    // what made every windscreen in this game look like a dirty lens.
    float cleared = uOcclusion * grain * 0.8;
    float caked = uCrust * (0.62 + 0.38 * grain) * (1.0 - swept);
    float muck = max(caked, cleared * swept);

    /*
     * The blade, sweeping the arc.
     *
     * It travels along the same arc it clears, which is the whole reason the
     * arc is here: a bar crossing the screen vertically reads as a wipe effect,
     * and a blade pivoting through its own clean sector reads as a wiper.
     */
    if (uWiper >= 0.0) {
      float bladeA = mix(-0.78, 0.78, uWiper);
      // Outbound it is a line of clearing: everything it has crossed is clean.
      // On the way back it crosses glass it already cleared, so it is just the
      // blade — which is what makes the return stroke read as a wiper coming
      // back rather than as the screen dirtying itself again.
      float passed = step(sweepA, bladeA) * (1.0 - uWiperBack) * swept;
      muck *= mix(1.0, 0.08, passed);
      // Distance to the blade measured across the arc, so it stays a constant
      // width from pivot to tip instead of fanning out.
      float onBlade = (1.0 - smoothstep(0.0, 0.016, abs(sweepA - bladeA) * max(sweepR, 0.3))) * swept;
      muck = mix(muck, 0.9, onBlade * 0.75);
    }
    muck = clamp(muck, 0.0, 1.0);

    float hidden = clamp(dark + muck * (1.0 - dark * 0.4), 0.0, 1.0);

    // Blur is not only what is on the glass. Outside the beams there is
    // nothing your eyes are focused on, and in rain the far half of the view
    // goes to mush — so what is unlit gets softened whether or not a droplet
    // happens to land on that pixel. Inside the cone, and on the car, the
    // world stays sharp.
    float haze = (1.0 - lit) * (uDarkness * 0.55 + uOcclusion * 1.15) + uCrust * (1.0 - swept) * 1.4;
    float soften = clamp(hidden * 1.15 + haze, 0.0, 1.0) * (1.0 - onCar);

    vec4 sharp = texture2D(uScene, vUv);
    vec4 soft = texture2D(uBlur, vUv);
    vec4 colour = mix(sharp, soft, soften);

    // Muck is lit by your own lights, so it greys rather than blackens; the
    // dark is genuinely dark.
    vec3 tint = uKind < 1.5 ? vec3(0.72, 0.76, 0.82) : vec3(0.42, 0.33, 0.24);
    // Snow packs white and mud packs brown; both go nearly opaque where they
    // build up, which is the whole difference between a crusted windscreen and
    // a tinted one.
    vec3 crustTint = uKind < 0.5
      ? vec3(0.62, 0.66, 0.72)
      : (uKind < 1.5 ? vec3(0.88, 0.91, 0.95) : vec3(0.46, 0.35, 0.22));
    // Never fully black: a driver's eyes adapt, and a screen that goes to zero
    // outside the beams is not dramatic, it is unplayable.
    colour.rgb = mix(colour.rgb, colour.rgb * uFloor, dark * (1.0 - onCar));
    colour.rgb = mix(colour.rgb, tint * (0.16 + 0.30 * (1.0 - uDarkness)), cleared * swept * 0.55);
    colour.rgb = mix(colour.rgb, crustTint * (0.22 + 0.55 * (1.0 - uDarkness)), min(caked * 1.15, 0.94));
    // The bright edge of a bead, which is most of why a droplet reads as one:
    // it is a lens, and it catches whatever light there is.
    colour.rgb += rim * uOcclusion * swept * (0.18 + 0.26 * (1.0 - uDarkness));

    // The grade, last, on the finished picture — the light has to colour the
    // weather on the windscreen too, not just the world behind it.
    //
    // Lift then gain then contrast then saturation, which is the order a
    // colourist works in and the order that keeps each control doing one thing:
    // lift moves the black point, gain colours the light, contrast pivots about
    // the midpoint, saturation pulls toward luma last so it cannot undo the
    // colour the light just added.
    colour.rgb = colour.rgb * uGain + uLift;
    colour.rgb = (colour.rgb - 0.5) * uContrast + 0.5;
    float luma = dot(colour.rgb, vec3(0.2126, 0.7152, 0.0722));
    colour.rgb = mix(vec3(luma), colour.rgb, uSaturation);

    // A vignette, which is what makes a grade read as light rather than as a
    // filter: the corners of a frame are always darker than the middle.
    vec2 fromCentre = (vUv - 0.5) * vec2(uAspect, 1.0);
    colour.rgb *= 1.0 - uVignette * smoothstep(0.35, 0.95, length(fromCentre));
    colour.rgb = max(colour.rgb, 0.0);

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
        uCrust: { value: 0 },
        uKind: { value: 0 },
        uWiper: { value: -1 },
        uWiperBack: { value: 0 },
        uTime: { value: 0 },
        uFloor: { value: 0.22 },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uSaturation: { value: 1 },
        uContrast: { value: 1 },
        uVignette: { value: 0 },
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

  /**
   * The colour of the light, applied to every frame this pass draws.
   *
   * Set once when a stage loads. It is separate from the windscreen effect and
   * from its strength setting: a player who turns the windscreen off is asking
   * not to be blinded, not asking for dusk to look like midday.
   */
  grade: Grade = NEUTRAL_GRADE;

  /** True when the windscreen effect itself would change nothing. */
  private clearScreen(state: VisionState): boolean {
    return (
      this.strength <= 0 ||
      (state.darkness < 0.02 && state.occlusion < 0.02 && state.crust < 0.02)
    );
  }

  /** True when the whole pass would change nothing, so it can be skipped. */
  idle(state: VisionState): boolean {
    return this.clearScreen(state) && gradeStrength(this.grade) < 0.02;
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

    // The blur is only wanted when something is actually being hidden. On a
    // clear afternoon the pass still runs, for the grade, and two half-res
    // blur passes for a texture nothing samples would be a waste of the only
    // per-frame budget this renderer has.
    const blurred = !this.clearScreen(state);
    if (blurred) {
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
    }

    const c = this.compositeMaterial.uniforms;
    c.uScene!.value = this.sceneTarget.texture;
    // With no blur pass run, the "soft" texture is the sharp one: every mix
    // toward it becomes a no-op rather than a sample of a stale frame.
    c.uBlur!.value = blurred ? this.blurB.texture : this.sceneTarget.texture;
    (c.uOrigin!.value as THREE.Vector2).set(origin.x, origin.y);
    (c.uForward!.value as THREE.Vector2).set(forward.x, forward.y);
    c.uDarkness!.value = state.darkness * this.strength;
    c.uReach!.value = state.coneReach;
    c.uAngle!.value = state.coneAngle;
    c.uOcclusion!.value = state.occlusion * this.strength;
    c.uCrust!.value = state.crust * this.strength;
    c.uKind!.value = state.kind === 'mud' ? 2 : state.kind === 'snow' ? 1 : 0;
    c.uWiper!.value = state.wiper ?? -1;
    c.uWiperBack!.value = state.wiperReturning ? 1 : 0;

    const grade = this.grade;
    (c.uGain!.value as THREE.Vector3).set(grade.gain[0], grade.gain[1], grade.gain[2]);
    (c.uLift!.value as THREE.Vector3).set(grade.lift[0], grade.lift[1], grade.lift[2]);
    c.uSaturation!.value = grade.saturation;
    c.uContrast!.value = grade.contrast;
    c.uVignette!.value = grade.vignette;
    c.uTime!.value = time;
    // At full strength the world outside the beams keeps about a twelfth of
    // its light; at low strength it barely dims at all. This used to bottom
    // out at a fifth, which on a night stage read as "dim" rather than as
    // driving by the headlights.
    c.uFloor!.value = 1 - 0.92 * this.strength;

    this.quad.material = this.compositeMaterial;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }
}
