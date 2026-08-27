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
 * Deliberately on the opposite azimuth from the camera (which looks from +x/+z
 * at 45°). Put the light on the camera's side and the car sits exactly on top
 * of its own shadow, which reads on screen as having no shadow at all — and
 * with a fixed isometric camera the shadow is the only cue for how high the car
 * is off the ground over a jump.
 */
export const KEY_LIGHT_OFFSET = { x: -38, y: 46, z: -34 } as const;

export interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** Key light; its shadow frustum has to be kept over the car as it drives. */
  key: THREE.DirectionalLight;
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

  scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x2a2118, 0.6));

  // Cool fill from the camera side, low and weak: lifts the shadowed faces just
  // enough to keep the silhouette readable without washing the shadow out.
  const fill = new THREE.DirectionalLight(0x6fa8ff, 0.55);
  fill.position.set(34, 16, 30);
  scene.add(fill);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(800, 800),
    new THREE.MeshStandardMaterial({ color: PALETTE.ground, roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Without a grid on an empty plane there is no motion cue at all, and the
  // handling is impossible to judge.
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

  const resize = (width: number, height: number) => {
    renderer.setSize(width, height, false);
  };

  return { renderer, scene, key, resize };
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
