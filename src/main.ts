/**
 * Browser entry point.
 *
 * Wires the simulation to the renderer, the HUD and the race rules. The sim
 * advances on a fixed 120 Hz clock regardless of display refresh rate;
 * rendering interpolates between the last two steps.
 */

import { STAGES, stageById } from './data/stages/index.js';
import { TEST_PATCHES } from './data/testGround.js';
import { Race } from './game/race.js';
import { NEUTRAL_INPUT } from './sim/input.js';
import { Driver } from './sim/driver.js';
import { Stage } from './sim/stage.js';
import { TRACES, sampleTrace } from './sim/trace.js';
import { SimWorld, initPhysics } from './sim/world.js';
import { CarView } from './render/carView.js';
import { IsoCamera } from './render/camera.js';
import {
  KEY_LIGHT_OFFSET,
  addProvingGround,
  addSurfacePatches,
  createScene,
} from './render/scene.js';
import { buildStageView, type StageView } from './render/stageMesh.js';
import { Controls } from './ui/controls.js';
import { Hud } from './ui/hud.js';
import { RaceHud } from './ui/raceHud.js';
import { TuningPanel } from './ui/tuningPanel.js';

/**
 * Hooks the screenshot harness drives the game through, so a composite frame is
 * reproducible rather than whatever the game happened to be showing.
 */
interface HarnessHooks {
  ready: boolean;
  rendered: boolean;
  /** Run a stage forward with the AI driver to `seconds`, then draw. */
  seekStage: (stageId: string, seconds: number) => void;
  /** Run a proving-ground input trace to `seconds`, then draw. */
  seekTrace: (traceName: string, seconds: number) => void;
  draw: () => void;
}

declare global {
  interface Window {
    RSC?: HarnessHooks;
  }
}

/** Seconds of being stuck before the car is put back on the road. */
const AUTO_RESCUE_AFTER = 3.5;

async function main(): Promise<void> {
  await initPhysics();

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hudRoot = document.getElementById('hud') as HTMLElement;
  const { renderer, scene, key, resize } = createScene(canvas);
  const camera = new IsoCamera();
  const carView = new CarView(scene);
  const hud = new Hud(hudRoot);
  const raceHud = new RaceHud(hudRoot);
  const controls = new Controls();

  const params = new URLSearchParams(location.search);
  const freeRoam = params.has('free') || params.has('trace');

  let world: SimWorld;
  let stage: Stage | null = null;
  let race: Race | null = null;
  let stageView: StageView | null = null;
  let tuningPanel: TuningPanel | null = null;
  let stuckFor = 0;

  const loadStage = (stageId: string) => {
    stageView?.dispose();
    if (stageView) scene.remove(stageView.group);

    stage = new Stage(stageById(stageId));
    stageView = buildStageView(stage);
    scene.add(stageView.group);

    world = new SimWorld({ stage });
    race = new Race(stage);
    raceHud.setStage(stage);
    tuningPanel?.rebind(world.vehicle.tuning);

    camera.applyZones(stage.def.cameraZones, 0);
    camera.jumpTo(world.state().position);
    stuckFor = 0;
  };

  const loadFreeRoam = () => {
    addProvingGround(scene);
    addSurfacePatches(scene, TEST_PATCHES);
    world = new SimWorld({ baseSurface: 'tarmac', patches: TEST_PATCHES });
    camera.jumpTo(world.state().position);
  };

  if (freeRoam) loadFreeRoam();
  else loadStage(params.get('stage') ?? STAGES[0]!.id);

  tuningPanel = new TuningPanel(hudRoot, world!.vehicle.tuning);
  controls.onToggleTuning = () => tuningPanel!.toggle();

  const restart = () => {
    if (stage && race) {
      world.vehicle.reset(stage.start.position, stage.start.heading);
      race.reset();
      raceHud.setStage(stage);
      camera.applyZones(stage.def.cameraZones, 0);
    } else {
      world.vehicle.reset({ x: 0, y: 1.2, z: 0 }, 0);
    }
    camera.jumpTo(world.state().position);
    stuckFor = 0;
  };

  controls.onReset = restart;
  controls.onRescue = () => {
    world.rescue(race?.furthest);
    stuckFor = 0;
  };
  controls.onSelectStage = (index) => {
    const def = STAGES[index];
    if (def && !freeRoam) loadStage(def.id);
  };

  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    resize(w, h);
    camera.resize(w, h);
  };
  window.addEventListener('resize', onResize);
  onResize();

  const drawOnce = (alpha: number, dt: number) => {
    const state = world.state();
    const transform = world.renderTransform(alpha);
    carView.update(transform, state);

    if (stage && race) camera.applyZones(stage.def.cameraZones, race.furthest);
    camera.follow(dt, transform.position, state.velocity);

    // The shadow frustum is far too tight to cover a whole stage, so it rides
    // along with the car.
    key.position.set(
      transform.position.x + KEY_LIGHT_OFFSET.x,
      transform.position.y + KEY_LIGHT_OFFSET.y,
      transform.position.z + KEY_LIGHT_OFFSET.z,
    );
    key.target.position.set(transform.position.x, transform.position.y, transform.position.z);
    key.target.updateMatrixWorld();

    renderer.render(scene, camera.camera);
  };

  window.RSC = {
    ready: true,
    rendered: false,
    seekStage(stageId, seconds) {
      loadStage(stageId);
      const driver = new Driver(stage!);
      for (let i = 0; i < 60; i++) world.step(NEUTRAL_INPUT);
      world.time = 0;
      while (world.time < seconds) {
        world.step(driver.input(world.state(), world.dt));
        race!.update(world.state(), world.dt);
      }
      camera.applyZones(stage!.def.cameraZones, race!.furthest);
      camera.jumpTo(world.state().position);
      raceHud.update(race!);
      hud.update(world.state(), 60);
    },
    seekTrace(traceName, seconds) {
      const trace = TRACES[traceName];
      if (!trace) throw new Error(`unknown trace: ${traceName}`);
      world.vehicle.reset({ x: 0, y: 1.2, z: 0 }, 0);
      world.time = 0;
      while (world.time < seconds) world.step(sampleTrace(trace, world.time));
      camera.jumpTo(world.state().position);
      hud.update(world.state(), 60);
    },
    draw() {
      drawOnce(1, 1 / 60);
      window.RSC!.rendered = true;
    },
  };

  const harnessTrace = params.get('trace');
  const harnessSeek = params.get('t');
  if (harnessTrace) {
    window.RSC.seekTrace(harnessTrace, Number(harnessSeek ?? '3'));
    window.RSC.draw();
    return;
  }
  if (harnessSeek) {
    window.RSC.seekStage(params.get('stage') ?? STAGES[0]!.id, Number(harnessSeek));
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

    const state = world.state();
    if (race) {
      race.update(state, dt);
      raceHud.update(race);

      // Beaching the chassis across the verge with all four wheels dangling is
      // unrecoverable by driving, so the game recovers for you.
      if (race.phase === 'running' && Math.abs(state.speed) < 1) {
        stuckFor += dt;
        if (stuckFor > AUTO_RESCUE_AFTER) {
          world.rescue(race.furthest);
          stuckFor = 0;
        }
      } else {
        stuckFor = 0;
      }
    }

    drawOnce(alpha, dt);
    hud.update(state, fps);
    tuningPanel!.update(state);
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
