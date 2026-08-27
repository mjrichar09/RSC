/**
 * Browser entry point: wires the sim to the renderer and the HUD.
 *
 * The sim advances on a fixed 120 Hz clock regardless of display refresh rate;
 * rendering interpolates between the last two steps.
 */

import { CAMERA } from './data/tuning.js';
import { TEST_PATCHES } from './data/testGround.js';
import { NEUTRAL_INPUT } from './sim/input.js';
import { sampleTrace, TRACES } from './sim/trace.js';
import { SimWorld, initPhysics } from './sim/world.js';
import { CarView } from './render/carView.js';
import { IsoCamera } from './render/camera.js';
import { KEY_LIGHT_OFFSET, addSurfacePatches, createScene } from './render/scene.js';
import { Controls } from './ui/controls.js';
import { Hud } from './ui/hud.js';

/**
 * The screenshot harness drives the car from a scripted trace instead of the
 * keyboard, so a composite is reproducible frame for frame.
 * `?trace=slalom&t=3.2` renders that trace at that moment.
 */
interface HarnessHooks {
  ready: boolean;
  /** Set once a harness frame has actually been drawn — what the shoot tool waits on. */
  rendered: boolean;
  /** Run the sim forward from a clean spawn to `seconds` along `traceName`. */
  seek: (traceName: string, seconds: number) => void;
  /** Render one frame immediately. */
  draw: () => void;
}

declare global {
  interface Window {
    RSC?: HarnessHooks;
  }
}

async function main(): Promise<void> {
  await initPhysics();

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const { renderer, scene, key, resize } = createScene(canvas);
  const camera = new IsoCamera();
  const carView = new CarView(scene);
  const hud = new Hud(document.getElementById('hud') as HTMLElement);
  const controls = new Controls();

  // A patchwork of surfaces so the grip model is testable without a stage.
  const worldOptions = { baseSurface: 'tarmac' as const, patches: TEST_PATCHES };
  addSurfacePatches(scene, TEST_PATCHES);

  let world = new SimWorld(worldOptions);
  const rebuild = () => {
    world = new SimWorld(worldOptions);
  };
  controls.onReset = () => {
    world.vehicle.reset({ x: 0, y: 1.2, z: 0 }, 0);
    camera.jumpTo(world.state().position);
  };

  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    resize(w, h);
    camera.resize(w, h);
  };
  window.addEventListener('resize', onResize);
  onResize();
  camera.jumpTo(world.state().position);

  const drawOnce = (alpha: number, dt: number) => {
    const state = world.state();
    const transform = world.renderTransform(alpha);
    carView.update(transform, state);
    camera.follow(dt, transform.position, state.velocity);
    // Keep the shadow frustum centred on the car; it is far too tight to cover
    // the whole 800 m ground plane.
    key.position.set(
      transform.position.x + KEY_LIGHT_OFFSET.x,
      KEY_LIGHT_OFFSET.y,
      transform.position.z + KEY_LIGHT_OFFSET.z,
    );
    key.target.position.set(transform.position.x, 0, transform.position.z);
    key.target.updateMatrixWorld();
    renderer.render(scene, camera.camera);
  };

  window.RSC = {
    ready: true,
    rendered: false,
    seek(traceName, seconds) {
      rebuild();
      const trace = TRACES[traceName];
      if (!trace) throw new Error(`unknown trace: ${traceName}`);
      for (let i = 0; i < 60; i++) world.step(NEUTRAL_INPUT);
      world.time = 0;
      world.steps = 0;
      while (world.time < seconds) world.step(sampleTrace(trace, world.time));
      camera.viewSize = CAMERA.viewSize;
      camera.jumpTo(world.state().position);
    },
    draw() {
      drawOnce(1, 1 / 60);
      window.RSC!.rendered = true;
    },
  };

  const params = new URLSearchParams(location.search);
  const harnessTrace = params.get('trace');
  if (harnessTrace) {
    // Static harness mode: no live loop, so the frame is deterministic.
    window.RSC.seek(harnessTrace, Number(params.get('t') ?? '3'));
    hud.update(world.state(), 60);
    window.RSC.draw();
    return;
  }

  let last = performance.now();
  let fps = 60;

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.08;

    const input = controls.sample(dt);
    const alpha = world.advance(dt, input);

    drawOnce(alpha, dt);
    hud.update(world.state(), fps);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:absolute;top:0;left:0;padding:20px;color:#e8552f">${String(err)}</pre>`,
  );
});
