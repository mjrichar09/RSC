/**
 * Three.js scene setup.
 *
 * Art direction from day one: flat-shaded low-poly, a tight palette, one strong
 * key light plus fill and rim. Untextured vertex-coloured primitives read as a
 * deliberate style rather than as placeholder art, so later model upgrades slot
 * in without a visual reset.
 *
 * P0 uses the WebGL renderer rather than WebGPU — it is the boring, reliable
 * choice while nothing on screen needs the extra capability. Revisit in P6 when
 * the visual pass actually asks for it.
 */

import * as THREE from 'three';
import { CLEAR_DAY, type Conditions, type TimeOfDay, visibility } from '../sim/conditions.js';
import { CAMERA_DISTANCE } from './camera.js';
import type { GroundPatch } from '../sim/world.js';
import { SURFACES } from '../sim/surfaces.js';

export const PALETTE = {
  sky: 0x20293a,
  fog: 0x20293a,
  ground: 0x39414d,
  grid: 0x59636f,
  gridMajor: 0x8794a3,
  carBody: 0xe8552f,
  carCabin: 0x1f242c,
  carAccent: 0xf2c14e,
  tire: 0x14171c,
} as const;

/**
 * Key light offset from the car, in world units.
 *
 * Deliberately on the opposite azimuth from the camera. Put the light on the
 * camera's side and the car sits exactly on top of its own shadow, which reads
 * on screen as having no shadow at all — and with a fixed isometric camera the
 * shadow is the only cue for how high the car is off the ground over a jump.
 *
 * The camera's yaw is now per-zone rather than a single value for the whole
 * game, so this cannot be one constant vector any more: `keyLightOffset` puts
 * the sun opposite whatever the camera is currently doing.
 */
export const KEY_LIGHT_OFFSET = { x: -38, y: 46, z: -34 } as const;

/** Horizontal distance and height of the key light from the car. */
const KEY_RADIUS = Math.hypot(KEY_LIGHT_OFFSET.x, KEY_LIGHT_OFFSET.z);
const KEY_HEIGHT = KEY_LIGHT_OFFSET.y;
/**
 * Sideways kick, radians, on top of "directly opposite the camera".
 *
 * Straight opposite would throw the shadow directly away from the viewer, where
 * the car itself hides most of it. A little to one side and the shadow lies
 * across the screen where its gap from the car can be read.
 */
const KEY_SWING = 0.55;

/** Where the key light should sit for a camera at this yaw. */
export function keyLightOffset(cameraYaw: number): { x: number; y: number; z: number } {
  const azimuth = cameraYaw + Math.PI + KEY_SWING;
  return {
    x: Math.sin(azimuth) * KEY_RADIUS,
    y: KEY_HEIGHT,
    z: Math.cos(azimuth) * KEY_RADIUS,
  };
}

/**
 * Lighting per time of day.
 *
 * The key light's *direction* is fixed for all of them — it stays opposite the
 * camera, or the car sits on its own shadow and the only height cue in the game
 * disappears. Only colour and intensity change with the hour.
 */
interface LightingPreset {
  key: { color: number; intensity: number };
  hemisphere: { sky: number; ground: number; intensity: number };
  fill: { color: number; intensity: number };
  background: number;
  fog: number;
  /** Shadows go soft and then vanish as the sun goes down. */
  shadowStrength: number;
}

const LIGHTING: Record<TimeOfDay, LightingPreset> = {
  dawn: {
    key: { color: 0xffd9b0, intensity: 1.9 },
    hemisphere: { sky: 0x9fb6d8, ground: 0x35281c, intensity: 0.75 },
    fill: { color: 0xa8c8ff, intensity: 0.5 },
    background: 0x3b3a4d,
    fog: 0x4a4356,
    shadowStrength: 0.7,
  },
  day: {
    key: { color: 0xfff2e0, intensity: 2.6 },
    hemisphere: { sky: 0x8fb4ff, ground: 0x2a2118, intensity: 0.6 },
    fill: { color: 0x6fa8ff, intensity: 0.55 },
    background: 0x20293a,
    fog: 0x20293a,
    shadowStrength: 1,
  },
  dusk: {
    key: { color: 0xff9a5c, intensity: 1.7 },
    hemisphere: { sky: 0x6f7fb0, ground: 0x2a1d16, intensity: 0.6 },
    fill: { color: 0x5f7fd0, intensity: 0.45 },
    background: 0x2e2436,
    fog: 0x3a2c3a,
    shadowStrength: 0.55,
  },
  night: {
    // Moonlight: cold and weak, but never black. A screen you genuinely cannot
    // read is a bug rather than a difficulty — the car's silhouette and the
    // rough line of the road have to stay legible, and the headlights are what
    // turn "roughly there" into "I can take this corner".
    //
    // Lifted once the windscreen pass existed: the pass darkens everything
    // outside the headlight cone, and it can only do that if there is something
    // there to darken. A base night that is already black leaves the cone
    // reading as the only lit thing in a void rather than as headlights.
    key: { color: 0x8fa8d8, intensity: 1.15 },
    hemisphere: { sky: 0x3a4d78, ground: 0x181d2a, intensity: 0.95 },
    fill: { color: 0x50709f, intensity: 0.5 },
    background: 0x0b0f18,
    fog: 0x0b0f18,
    shadowStrength: 0.25,
  },
};

/** Weather dims and desaturates on top of the hour. */
const WEATHER_DIM: Record<Conditions['weather'], number> = {
  clear: 1,
  overcast: 0.72,
  rain: 0.62,
  fog: 0.6,
  snowfall: 0.78,
};

export interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** Key light; its shadow frustum has to be kept over the car as it drives. */
  key: THREE.DirectionalLight;
  /** Re-light the scene for a set of conditions. Safe to call on every stage load. */
  applyConditions: (conditions: Conditions) => void;
  resize: (width: number, height: number) => void;
}

export function createScene(canvas: HTMLCanvasElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.sky);
  scene.fog = new THREE.Fog(PALETTE.fog, 90, 260);

  // Key light, angled to match the isometric read so the car casts a shadow
  // that actually tells you where the ground is.
  const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
  key.position.set(KEY_LIGHT_OFFSET.x, KEY_LIGHT_OFFSET.y, KEY_LIGHT_OFFSET.z);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  // Tight frustum: the shadow camera follows the car (see main.ts), so it only
  // ever has to cover the area actually on screen. A loose frustum here wastes
  // the whole 2048 map on ground nobody is looking at.
  const s = 34;
  key.shadow.camera.left = -s;
  key.shadow.camera.right = s;
  key.shadow.camera.top = s;
  key.shadow.camera.bottom = -s;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 200;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  // three.js does not refresh the shadow camera's projection when its frustum
  // bounds change, so without this the light keeps its default 10x10 m frustum
  // and the shadow silently never appears.
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);
  scene.add(key.target);

  const hemisphere = new THREE.HemisphereLight(0x8fb4ff, 0x2a2118, 0.6);
  scene.add(hemisphere);

  // Cool fill from the camera side, low and weak: lifts the shadowed faces just
  // enough to keep the silhouette readable without washing the shadow out.
  const fill = new THREE.DirectionalLight(0x6fa8ff, 0.55);
  fill.position.set(34, 16, 30);
  scene.add(fill);

  const applyConditions = (conditions: Conditions) => {
    const preset = LIGHTING[conditions.timeOfDay];
    const dim = WEATHER_DIM[conditions.weather];
    const view = visibility(conditions);

    key.color.setHex(preset.key.color);
    key.intensity = preset.key.intensity * dim;
    // A shadow needs a sun. Under moonlight or heavy cloud there is barely one,
    // and a hard shadow at midnight looks wrong immediately.
    key.castShadow = preset.shadowStrength * dim > 0.25;

    hemisphere.color.setHex(preset.hemisphere.sky);
    hemisphere.groundColor.setHex(preset.hemisphere.ground);
    hemisphere.intensity = preset.hemisphere.intensity * dim;

    fill.color.setHex(preset.fill.color);
    fill.intensity = preset.fill.intensity * dim;

    scene.background = new THREE.Color(preset.background);
    // Fog is measured from the camera, which sits a fixed distance back, so a
    // range meaning "visible for 60 m around the car" has to be offset by it.
    // Without the offset the entire world is past the far plane and every
    // frame renders as flat fog colour.
    scene.fog = new THREE.Fog(
      preset.fog,
      CAMERA_DISTANCE + view.fogNear,
      CAMERA_DISTANCE + view.fogFar,
    );
  };

  applyConditions(CLEAR_DAY);

  const resize = (width: number, height: number) => {
    renderer.setSize(width, height, false);
  };

  return { renderer, scene, key, applyConditions, resize };
}

/**
 * The P0/P1 proving ground: a large flat plane with a reference grid.
 *
 * Only added in free-roam mode. A stage brings its own geometry, and leaving
 * this in cuts a grid straight through the corridor and shows a flat plane
 * through every gap in it.
 */
export function addProvingGround(scene: THREE.Scene): void {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(800, 800),
    new THREE.MeshStandardMaterial({ color: PALETTE.ground, roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Two grids: a fine one for close-range speed cues and a coarse one that
  // still reads when the car is moving fast. Without them an empty plane gives
  // no sense of motion at all and the handling is impossible to judge.
  for (const [divisions, color, opacity, y] of [
    [200, PALETTE.grid, 0.5, 0.02],
    [40, PALETTE.gridMajor, 0.7, 0.03],
  ] as const) {
    const grid = new THREE.GridHelper(800, divisions, color, color);
    const mat = grid.material as THREE.Material;
    mat.transparent = true;
    mat.opacity = opacity;
    grid.position.y = y;
    scene.add(grid);
  }
}

/**
 * Draw the surface patches the sim is resolving grip from. Without this the HUD
 * announces "gravel" over ground that looks identical to tarmac, which makes
 * the grip model impossible to judge by eye.
 */
export function addSurfacePatches(scene: THREE.Scene, patches: readonly GroundPatch[]): void {
  patches.forEach((patch, i) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(patch.halfX * 2, patch.halfZ * 2),
      new THREE.MeshStandardMaterial({
        color: SURFACES[patch.surface].color,
        roughness: 0.95,
        metalness: 0,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    // Stacked slightly so overlapping patches never z-fight; drawn under the
    // grid so the motion cue survives.
    mesh.position.set(patch.x, 0.003 + i * 0.001, patch.z);
    mesh.receiveShadow = true;
    scene.add(mesh);
  });
}
