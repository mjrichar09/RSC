/**
 * Browser entry point.
 *
 * Wires the simulation to the renderer, the HUD and the race rules. The sim
 * advances on a fixed 120 Hz clock regardless of display refresh rate;
 * rendering interpolates between the last two steps.
 */

import { STAGES, stageById } from './data/stages/index.js';
import { TEST_PATCHES } from './data/testGround.js';
import { Career, type RaceTarget } from './game/career.js';
import { rollcageMitigation } from './game/garage.js';
import { Race } from './game/race.js';
import { SaveStore } from './game/save.js';
import { NEUTRAL_INPUT } from './sim/input.js';
import { Driver } from './sim/driver.js';
import { GhostPlayer, GhostRecorder } from './sim/replay.js';
import { COMPONENTS, FAILURE_LABEL, type ComponentId } from './sim/damage.js';
import { Stage, findVariant, type StageVariant, variantKey } from './sim/stage.js';
import { cornersAhead } from './sim/corners.js';
import { visibility } from './sim/conditions.js';
import { TRACES, sampleTrace } from './sim/trace.js';
import { SimWorld, initPhysics } from './sim/world.js';
import { Mixer } from './audio/mixer.js';
import { CarView } from './render/carView.js';
import {
  ParticleField,
  Precipitation,
  SkidMarks,
  emitDragSparks,
  emitSteam,
  updateWheelEffects,
} from './render/fx.js';
import { IsoCamera } from './render/camera.js';
import {
  keyLightOffset,
  addProvingGround,
  addSurfacePatches,
  createScene,
} from './render/scene.js';
import { buildStageView, type StageView } from './render/stageMesh.js';
import { Controls } from './ui/controls.js';
import { Hud } from './ui/hud.js';
import { RaceHud } from './ui/raceHud.js';
import { DamagePanel } from './ui/damagePanel.js';
import { DebrisView } from './render/debrisView.js';
import { WildlifeView } from './render/wildlifeView.js';
import { Garage } from './ui/garage.js';
import { MultiplayerPanel } from './ui/multiplayer.js';
import { MultiplayerSession } from './game/multiplayer.js';
import { LiveStageMap } from './ui/stageMap.js';
import * as THREE from 'three';
import { rotate } from './sim/math.js';
import { Vision } from './sim/vision.js';
import { VisionPass } from './render/vision.js';
import { TuningPanel } from './ui/tuningPanel.js';

/**
 * Hooks the screenshot harness drives the game through, so a composite frame is
 * reproducible rather than whatever the game happened to be showing.
 */
interface HarnessHooks {
  ready: boolean;
  rendered: boolean;
  /**
   * Run a stage forward with the AI driver to `seconds`, then draw.
   * `crashFor` seconds of full lock into the embankment first, so a harness
   * frame can show real damage produced by the real impact pipeline rather
   * than by poking numbers into the model.
   */
  seekStage: (stageId: string, seconds: number, crashFor?: number, grip?: number) => void;
  /**
   * Drive a full AI lap, store it as the ghost, then replay a fresh run to
   * `seconds` so both cars are on screen. Used by the screenshot harness.
   */
  seedGhostAndSeek: (stageId: string, seconds: number) => Promise<void>;
  /** Run a proving-ground input trace to `seconds`, then draw. */
  seekTrace: (traceName: string, seconds: number) => void;
  draw: () => void;
  /** Text snapshot for the harness: cheaper to check than a screenshot. */
  status: () => Record<string, unknown>;
  /**
   * Drive the loaded stage to the finish with the AI and settle it, exactly as
   * a completed player run would be. Lets a whole career be exercised headlessly.
   */
  finishWithAi: (timeout?: number) => Promise<Record<string, unknown>>;
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
  const { renderer, scene, key, applyConditions, resize } = createScene(canvas);
  const camera = new IsoCamera();
  const carView = new CarView(scene);
  const ghostView = new CarView(scene, { ghost: true });
  const debrisView = new DebrisView(scene);
  // The minimap. Fixed north-up, so the shape of a stage can be learned.
  const minimap = new LiveStageMap(hudRoot, 'minimap');
  const vision = new Vision();
  /**
   * Advance what the driver can see. Shared by the render loop and the visual
   * harness — soiling accumulates over seconds, so a harness frame that only
   * ever advances it once shows a spotless screen in a downpour.
   */
  const advanceVision = (dt: number) => {
    const state = world.state();
    return vision.update(dt, {
      conditions: world.conditions,
      speed: Math.abs(state.speed),
      surface: state.wheels.find((w) => w.grounded)?.surface.id ?? 'tarmac',
      wiperHealth: world.damage?.get('wipers') ?? 1,
      lightHealth: world.damage?.get('lights') ?? 1,
    });
  };
  const visionPass = new VisionPass(renderer);
  /** Reused for the screen-space projection each frame. */
  const SCRATCH = new THREE.Vector3();
  const wildlifeView = new WildlifeView(scene);
  ghostView.visible = false;
  const particles = new ParticleField(scene);
  const skids = new SkidMarks(scene);
  const precipitation = new Precipitation(scene);
  const mixer = new Mixer();
  const hud = new Hud(hudRoot);
  const raceHud = new RaceHud(hudRoot);
  const damagePanel = new DamagePanel(hudRoot);
  const controls = new Controls();
  const save = new SaveStore();
  await save.open();
  const career = new Career(save, STAGES);

  const params = new URLSearchParams(location.search);
  // `?vision=0.6` scales the whole windscreen effect. It is the setting most
  // likely to need a human eye, so it is adjustable rather than baked in.
  const visionParam = params.get('vision');
  const freeRoam = params.has('free') || params.has('trace');

  let world: SimWorld;
  let stage: Stage | null = null;
  let race: Race | null = null;
  let stageView: StageView | null = null;
  let variant: StageVariant | null = null;

  /**
   * The stage-and-conditions pairing currently loaded. Fees, payouts, records
   * and ghosts all key off this rather than off the stage alone: a night run is
   * its own race.
   */
  const currentTarget = (): RaceTarget => ({ def: stage!.def, variant: variant! });
  const currentKey = (): string => variantKey(stage!.def.id, variant!.id);
  let tuningPanel: TuningPanel | null = null;
  /**
   * The network race, when there is one. The local car is index 0 either way —
   * a guest swaps its own car into that slot — so everything below this point
   * is written as if there were only ever one car, exactly as it was.
   */
  let session: MultiplayerSession | null = null;
  /** Views for the other cars in a network race, by car index. */
  let rivalViews: CarView[] = [];
  const tagLayer = document.createElement('div');
  tagLayer.className = 'tags';
  hudRoot.appendChild(tagLayer);
  let stuckFor = 0;
  /**
   * A failure the car cannot continue from, and how long it has been stopped.
   *
   * The race does not end at the moment something breaks. The engine dies, and
   * the car coasts: it still steers, still brakes, and if the line is close
   * enough it still crosses it. Ending the run the instant a component failed
   * threw away the most dramatic twenty seconds a race can have.
   */
  let terminal: { label: string; stopped: number } | null = null;
  let ghost: GhostPlayer | null = null;
  const recorder = new GhostRecorder();

  /**
   * The car's condition when this stage session began.
   *
   * A restart re-runs the attempt from the condition you arrived in, not from
   * a factory-fresh car — otherwise a bad crash could be undone for nothing and
   * the damage economy would mean nothing.
   */
  /**
   * When set, the camera stays here instead of following the car. Harness only:
   * `drawOnce` calls `camera.follow`, so a jump made before drawing is undone
   * by the very frame it was made for.
   */
  let cameraLock: { at: { x: number; y: number; z: number }; zoom: number | null } | null = null;
  let sessionHealth: Partial<Record<ComponentId, number>> = {};
  let settled = false;

  /** Show the stored best for this pairing, and start chasing its ghost. */
  const attachGhost = async (key: string) => {
    const record = save.recordFor(key);
    raceHud.setBest(record?.time ?? null);

    const stored = await save.loadGhost(key);
    // Guard against the player switching stage or variant while this loaded.
    if (!stage || !variant || currentKey() !== key) return;
    ghost = stored ? new GhostPlayer(stored) : null;
    ghostView.visible = ghost !== null;
  };

  /**
   * Paint for the other cars. Distinct hues rather than shades: at a fixed
   * isometric distance, in a dust cloud, hue is the only thing that reads.
   */
  const RIVAL_PAINT = [0xd8563a, 0x4d86d6, 0x5fbf7a];

  const buildRivalViews = (cars: number) => {
    for (const view of rivalViews) scene.remove(view.group);
    rivalViews = [];
    for (let i = 1; i < cars; i++) {
      rivalViews.push(new CarView(scene, { body: RIVAL_PAINT[(i - 1) % RIVAL_PAINT.length]! }));
    }
    tagLayer.innerHTML = '';
  };

  const loadStage = (
    stageId: string,
    variantId?: string,
    grid?: { cars: number; slots?: number[] },
  ) => {
    stageView?.dispose();
    if (stageView) scene.remove(stageView.group);

    const def = stageById(stageId);
    variant = findVariant(def, variantId);
    stage = new Stage(def);

    // Conditions light the scene, set the fog, and decide how much the
    // headlights matter — which is what finally gives the `lights` component
    // something to do.
    applyConditions(variant.conditions);
    precipitation.setWeather(variant.conditions.weather);
    carView.setHeadlightWeight(visibility(variant.conditions).headlightWeight);
    stageView = buildStageView(stage);
    scene.add(stageView.group);

    // Damage is on for stages and off for the proving ground: the handling
    // tests and the tuning sweep are measuring the car, not the crashing.
    world = new SimWorld({
      stage,
      tuning: career.tuning(),
      damage: { rollcage: rollcageMitigation(career.upgrades) },
      conditions: variant.conditions,
      ...(grid ? { cars: grid.cars, ...(grid.slots ? { slots: grid.slots } : {}) } : {}),
    });
    buildRivalViews(grid?.cars ?? 1);
    applyCarCondition();
    race = new Race(stage, variant.medals);
    settled = false;
    terminal = null;
    damagePanel.reset();
    raceHud.setStage(stage, variant.name, variant.medals);
    minimap.setStage(stage);
    tuningPanel?.rebind(world.vehicle.tuning);

    camera.applyZones(stage.cameraZones, 0);
    camera.jumpTo(world.state().position);
    stuckFor = 0;
    particles.clear();
    skids.clear();
    vision.reset();

    ghost = null;
    ghostView.visible = false;
    recorder.reset();
    void attachGhost(currentKey());
  };

  /** Seed the world's damage model with the condition the car is actually in. */
  const applyCarCondition = () => {
    if (!world.damage) return;
    for (const [id, health] of Object.entries(sessionHealth)) {
      if (typeof health === 'number') world.damage.health.set(id as ComponentId, health);
    }
    world.damage.refreshFailures();
  };

  const loadFreeRoam = () => {
    addProvingGround(scene);
    addSurfacePatches(scene, TEST_PATCHES);
    world = new SimWorld({ baseSurface: 'tarmac', patches: TEST_PATCHES });
    camera.jumpTo(world.state().position);
  };

  if (freeRoam) loadFreeRoam();
  else {
    sessionHealth = { ...career.profile.carHealth };
    // `?cars=4` fills the grid without a network, so the visual question — do
    // four cars read as four cars, and do the tags land on them — can be
    // answered by the screenshot harness rather than by two browsers.
    const grid = Number(params.get('cars') ?? '1');
    loadStage(
      params.get('stage') ?? STAGES[0]!.id,
      params.get('variant') ?? undefined,
      grid > 1 ? { cars: grid } : undefined,
    );
  }

  tuningPanel = new TuningPanel(hudRoot, world!.vehicle.tuning);
  controls.onToggleTuning = () => tuningPanel!.toggle();

  const restart = () => {
    if (stage && race) {
      // Each attempt on a paid stage costs its fee again: that is what makes a
      // committed run different from an idle retry. The free stage stays freely
      // retryable, so the Trackmania practice loop survives intact.
      //
      // Any attempt that actually started counts, not just one that was settled.
      // Charging only on settled runs let a player crash at nine tenths
      // distance, restart for nothing, and discard the damage with it — which
      // costs the damage economy most of its meaning.
      const attemptUsed = race.phase !== 'staging';
      if (stage.def.entryFee > 0 && attemptUsed) {
        if (!career.canEnter(currentTarget()).allowed) {
          openGarage();
          return;
        }
        void career.enter(currentTarget());
      }
      world.vehicle.reset(stage.start.position, stage.start.heading);
      race.reset();
      raceHud.setStage(stage, variant?.name, variant?.medals);
      raceHud.setBest(save.recordFor(currentKey())?.time ?? null);
      raceHud.setSplitDeltas([]);
      raceHud.setDelta(null);
      recorder.reset();
      world.damage?.reset();
      world.clearDebris();
      debrisView.clear();
      wildlifeView.clear();
      vision.reset();
      applyCarCondition();
      particles.clear();
      skids.clear();
      settled = false;
      terminal = null;
      raceHud.setLedger(null);
      damagePanel.reset();
      camera.applyZones(stage.cameraZones, 0);
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
  const multiplayer = new MultiplayerPanel(hudRoot);
  multiplayer.onRace = (start) => {
    garage.setOpen(false);
    sessionHealth = { ...career.profile.carHealth };
    loadStage(start.setup.stageId, start.setup.variantId, {
      cars: start.cars,
      ...(start.slots ? { slots: start.slots } : {}),
    });

    // The host is the authority and starts the clock; a guest hands its world
    // over and is corrected toward the host's from the first snapshot.
    if (start.host) start.host.start(start.setup, world);
    else start.guest!.attach(world);

    session = new MultiplayerSession(
      { ...(start.host ? { host: start.host } : {}), ...(start.guest ? { guest: start.guest } : {}) },
      {
        world,
        setup: start.setup,
        progressOf: (car) => stage!.progressAt(world.state(car).position).distance,
      },
    );
  };

  const garage = new Garage(hudRoot, career);
  garage.onEnter = (target) => {
    // The fee is taken by the garage; this is the condition the attempt starts
    // from, and the one a restart returns to.
    sessionHealth = { ...career.profile.carHealth };
    // Entering from the garage is a solo run: hang up whatever was connected
    // rather than leaving a race running behind a menu.
    if (session) {
      session.leave();
      session = null;
      multiplayer.reset();
    }
    loadStage(target.def.id, target.variant.id);
  };

  garage.onReset = () => {
    // A fresh career gets a fresh car: the world is holding the old one's
    // damage, and leaving it there would hand the new career a wreck.
    sessionHealth = {};
    if (!freeRoam) loadStage(STAGES[0]!.id);
  };

  const openGarage = () => {
    if (freeRoam) return;
    // Bank whatever happened before leaving, so damage is never lost by walking
    // away from a half-finished run.
    if (race && race.phase === 'running') void settleRun(true);
    garage.setOpen(true);
  };

  // Browsers refuse to start audio without a gesture, so the graph is built on
  // the first interaction and the game is silent but playable until then.
  const startAudio = () => mixer.start();
  window.addEventListener('keydown', startAudio, { once: true });
  window.addEventListener('pointerdown', startAudio, { once: true });

  controls.onMute = () => mixer.toggleMute();

  // The windscreen effect is a taste setting, so it is cycled from the keyboard
  // and remembered: at 0 a night stage is merely dim, at 1 you drive by the
  // headlights alone. The URL parameter still wins, for the visual harness.
  const VISION_STEPS = [0, 0.35, 0.6, 1];
  visionPass.strength = visionParam !== null ? Number(visionParam) : career.profile.settings.vision;
  controls.onVision = () => {
    const next =
      VISION_STEPS[(VISION_STEPS.findIndex((v) => v >= visionPass.strength - 0.01) + 1) % VISION_STEPS.length] ??
      0.6;
    visionPass.strength = next;
    damagePanel.notice(`Visibility effect ${Math.round(next * 100)}%`);
    void save.update((profile) => {
      profile.settings.vision = next;
    });
  };

  controls.onMultiplayer = () => {
    if (freeRoam) return;
    if (garage.isOpen) garage.setOpen(false);
    multiplayer.toggle();
  };

  controls.onGarage = () => {
    if (freeRoam) return;
    if (garage.isOpen) garage.setOpen(false);
    else openGarage();
  };
  controls.onSelectStage = (index) => {
    if (freeRoam) return;
    if (garage.isOpen) void garage.enterByIndex(index);
  };

  /**
   * Settle a finished or retired attempt: pay out, carry the damage forward,
   * and store the ghost if it was a new best.
   */
  const settleRun = async (retired: boolean) => {
    if (!stage || !race || settled || !world.damage) return;
    settled = true;

    const time = race.finishTime;
    const previous = save.recordFor(currentKey())?.time ?? null;

    const result = await career.settle(currentTarget(), {
      medal: race.medal,
      time,
      retired,
      damage: world.damage,
      ...(retired || time === null ? {} : { ghost: recorder.finish(currentKey(), time) }),
    });

    // Everyone else wants to know you are done, and the host is the only one
    // who can say so — so a guest sends it up and the host passes it on.
    session?.report(0, time, retired);

    raceHud.setLedger(result);
    if (result.newRecord && time !== null) {
      raceHud.setBest(time);
      raceHud.markRecord(previous);
      await attachGhost(currentKey());
    }
  };

  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    resize(w, h);
    camera.resize(w, h);
    visionPass.setSize(w, h);
  };

  /** Screen pixels per world metre under the orthographic camera. */
  const updateParticleScale = () => {
    particles.setScale(window.innerHeight / (2 * camera.effectiveViewSize));
  };
  window.addEventListener('resize', onResize);
  onResize();

  /**
   * Name tags over the rival cars, in screen space.
   *
   * Projected through the same camera the cars are drawn with, so a tag is
   * exactly over its car whatever a zone's yaw and zoom are.
   */
  const updateTags = () => {
    const names = session?.names ?? [];
    while (tagLayer.children.length < rivalViews.length) {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tagLayer.appendChild(tag);
    }
    for (const [i, node] of [...tagLayer.children].entries()) {
      const tag = node as HTMLElement;
      const index = i + 1;
      const car = world.cars[index];
      if (!car || i >= rivalViews.length) {
        tag.style.display = 'none';
        continue;
      }
      const p = car.vehicle.body.translation();
      SCRATCH.set(p.x, p.y + 1.6, p.z).project(camera.camera);
      // Behind the camera, or off the edge: no tag rather than a wrong one.
      const onScreen = Math.abs(SCRATCH.x) < 1.1 && Math.abs(SCRATCH.y) < 1.1 && SCRATCH.z < 1;
      tag.style.display = onScreen ? 'block' : 'none';
      tag.style.left = `${(SCRATCH.x * 0.5 + 0.5) * window.innerWidth}px`;
      tag.style.top = `${(-SCRATCH.y * 0.5 + 0.5) * window.innerHeight}px`;
      tag.style.color = `#${(RIVAL_PAINT[(i % RIVAL_PAINT.length)] ?? 0xffffff).toString(16)}`;
      tag.textContent = names[index] ?? `P${index + 1}`;
    }
  };

  /**
   * The order of the field. Progress along the stage rather than a lap count:
   * it is the same number the host publishes, and it is the meaningful one on a
   * point-to-point stage where nobody laps anybody.
   */
  const updateStandings = () => {
    if (!stage || world.cars.length < 2) return;
    const names = session?.names ?? [];
    raceHud.setStandings(
      world.cars.map((car, index) => ({
        name: index === 0 ? 'You' : (names[index] || `P${index + 1}`),
        progress: stage!.progressAt(car.vehicle.body.translation()).distance,
        you: index === 0,
      })),
    );
  };

  const drawOnce = (alpha: number, dt: number) => {
    const state = world.state();
    const transform = world.renderTransform(alpha);
    carView.update(transform, state, world.damage, world.debris);
    debrisView.update(world.loose);

    // The other cars, and a name over each. Everything else about them — their
    // damage, their shed panels, their brake glow — is the same code the local
    // car uses, because on this side of the wire they are just cars.
    for (const [i, view] of rivalViews.entries()) {
      const index = i + 1;
      const car = world.cars[index];
      if (!car) continue;
      view.update(
        world.renderTransform(alpha, index),
        world.state(index),
        car.damage,
        car.debris,
      );
    }
    updateTags();
    // Turn the corner boards to face the camera. Cheap — there are a handful —
    // and it is the only way they stay readable through a zone change.
    for (const board of stageView?.signBoards ?? []) board.rotation.y = camera.yaw;
    wildlifeView.update(world.wildlife?.animals ?? []);

    if (ghost && race) {
      const sample = ghost.sampleAt(race.time);
      if (sample) ghostView.updateFromGhost(sample);
      // Hide it once its run has ended rather than freezing a car on the road.
      ghostView.visible = race.time <= ghost.duration + 0.5;
    }

    if (stage && race) camera.applyZones(stage.cameraZones, race.furthest);
    if (cameraLock) {
      camera.jumpTo(cameraLock.at);
      // After the jump, because `jumpTo` takes its view size from the zone the
      // line above just applied — which is how a locked frame ended up at the
      // stage's own zoom rather than the one asked for.
      if (cameraLock.zoom !== null) camera.setViewSize(cameraLock.zoom);
    } else {
      camera.follow(dt, transform.position, state.velocity);
    }

    // The shadow frustum is far too tight to cover a whole stage, so it rides
    // along with the car — and its azimuth tracks the camera, so the shadow
    // never ends up hidden behind the car whatever a zone's yaw is.
    const sun = keyLightOffset(camera.yaw);
    key.position.set(
      transform.position.x + sun.x,
      transform.position.y + sun.y,
      transform.position.z + sun.z,
    );
    key.target.position.set(transform.position.x, transform.position.y, transform.position.z);
    key.target.updateMatrixWorld();

    // Through the windscreen. The cone is anchored to the car *on screen* and
    // aimed along its heading, so it turns with the car rather than with the
    // camera — which is what makes it read as headlights rather than a vignette.
    const visionState = advanceVision(dt);

    const toUv = (p: { x: number; y: number; z: number }) => {
      SCRATCH.set(p.x, p.y, p.z).project(camera.camera);
      return { x: SCRATCH.x * 0.5 + 0.5, y: SCRATCH.y * 0.5 + 0.5 };
    };
    const nose = rotate(transform.rotation, { x: 0, y: 0, z: 12 });
    const origin = toUv(transform.position);
    const ahead = toUv({
      x: transform.position.x + nose.x,
      y: transform.position.y + nose.y,
      z: transform.position.z + nose.z,
    });
    const forwardX = ahead.x - origin.x;
    const forwardY = ahead.y - origin.y;
    const forwardLength = Math.hypot(forwardX, forwardY) || 1;

    visionPass.render(
      scene,
      camera.camera,
      visionState,
      origin,
      { x: forwardX / forwardLength, y: forwardY / forwardLength },
      performance.now() / 1000,
    );
  };

  window.RSC = {
    ready: true,
    rendered: false,
    seekStage(stageId, seconds, crashFor = 0, grip = 0.6) {
      // Reuse the loaded stage when possible: reloading would drop the ghost
      // that seedGhostAndSeek has just attached.
      if (!stage || stage.def.id !== stageId) loadStage(stageId);
      else restart();
      const driver = new Driver(stage!, { gripBudget: grip });
      for (let i = 0; i < 60; i++) world.step(NEUTRAL_INPUT);
      world.time = 0;
      while (world.time < seconds) {
        world.step(driver.input(world.state(), world.dt));
        race!.update(world.state(), world.dt);
        // Accumulate spray and marks so a harness frame shows the same effects
        // a player would see, rather than a suspiciously clean road.
        updateWheelEffects(particles, skids, world.state().wheels, world.state().velocity, world.dt);
        particles.update(world.dt);
        advanceVision(world.dt);
      }
      if (crashFor > 0) {
        const until = world.time + crashFor;
        while (world.time < until) {
          world.step({ throttle: 1, brake: 0, steer: 1, handbrake: 0 });
          race!.update(world.state(), world.dt);
          updateWheelEffects(particles, skids, world.state().wheels, world.state().velocity, world.dt);
          particles.update(world.dt);
          const failure = [...(world.damage?.failures ?? [])][0];
          if (failure) race!.retire(FAILURE_LABEL[failure]);
        }
        damagePanel.report(world.damage!.drainEvents());
      }
      raceHud.setSplitDeltas(
        race!.splits.map((split) => {
          const at = ghost?.timeAtDistance(split.distance);
          return at === null || at === undefined ? null : split.time - at;
        }),
      );

      // Pose the ghost for the same moment, so a harness frame shows the chase.
      if (ghost) {
        const sample = ghost.sampleAt(race!.time);
        if (sample) ghostView.updateFromGhost(sample);
        ghostView.visible = race!.time <= ghost.duration + 0.5;
        const ghostAt = ghost.timeAtDistance(race!.furthest);
        raceHud.setDelta(ghostAt === null ? null : race!.time - ghostAt);
      }
      camera.applyZones(stage!.cameraZones, race!.furthest);
      camera.jumpTo(world.state().position);
      raceHud.update(race!, world.damage);
      updateStandings();
      raceHud.setNotes(cornersAhead(stage!.corners, race!.furthest, 2));
      minimap.update(world.state().position, race!.progress);
      damagePanel.update(world.damage!);
      hud.update(world.state(), 60);
    },
    async seedGhostAndSeek(stageId, seconds) {
      if (!stage || stage.def.id !== stageId) loadStage(stageId);
      const driver = new Driver(stage!);
      for (let i = 0; i < 60; i++) world.step(NEUTRAL_INPUT);
      world.time = 0;

      // A full lap first, recorded exactly as a player's run would be.
      while (race!.phase !== 'finished' && world.time < 240) {
        world.step(driver.input(world.state(), world.dt));
        race!.update(world.state(), world.dt);
        if (race!.phase === 'running') {
          recorder.capture(race!.time, race!.furthest, world.state());
        }
      }
      if (race!.phase === 'finished' && race!.medal) {
        await settleRun(false);
      }

      restart();
      await attachGhost(currentKey());
      this.seekStage(stageId, seconds);
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
      updateParticleScale();
      precipitation.update(1 / 60, camera.focus, window.innerHeight / (2 * camera.effectiveViewSize));
      drawOnce(1, 1 / 60);
      window.RSC!.rendered = true;
    },
    async finishWithAi(timeout = 240) {
      if (!stage || !race) return { error: 'no stage loaded' };
      const driver = new Driver(stage);
      for (let i = 0; i < 60; i++) world.step(NEUTRAL_INPUT);
      world.time = 0;

      let stuck = 0;
      while (race.phase !== 'finished' && race.phase !== 'retired' && world.time < timeout) {
        world.step(driver.input(world.state(), world.dt));
        race.update(world.state(), world.dt);
        if (race.phase === 'running') recorder.capture(race.time, race.furthest, world.state());

        const failure = [...(world.damage?.failures ?? [])][0];
        if (failure && race.phase === 'running') race.retire(FAILURE_LABEL[failure]);

        if (race.phase === 'running' && Math.abs(world.state().speed) < 1) {
          stuck += world.dt;
          if (stuck > AUTO_RESCUE_AFTER) {
            world.rescue(race.furthest);
            stuck = 0;
          }
        } else {
          stuck = 0;
        }
      }

      await settleRun(race.phase === 'retired');
      raceHud.update(race, world.damage);
      // The co-driver reads from the same corner list the boards are built
      // from, so a note can never disagree with a sign.
      raceHud.setNotes(cornersAhead(stage.corners, race.furthest, 2));
      minimap.update(world.state().position, race.progress);
      return this.status();
    },
    status() {
      const d = world.damage;
      return {
        stage: stage?.def.id ?? 'free',
        phase: race?.phase ?? 'n/a',
        money: career.money,
        medal: race?.medal ?? null,
        time: race?.time.toFixed(2),
        condition: d ? +(d.condition * 100).toFixed(1) : null,
        bill: d?.repairBill().total ?? null,
        worst: d
          ? d
              .repairBill()
              .lines.slice(0, 3)
              .map((l) => l.label)
          : null,
        failures: d ? [...d.failures] : [],
        dragging: world.debris?.dragging() ?? [],
        shed: world.loose.map((l) => l.id),
        temp: d ? +d.temperature.toFixed(2) : null,
        // Multiplayer, for the two-page check: how many cars are in this
        // world, where they are, and who this machine thinks it is talking to.
        cars: world.cars.length,
        // Simulated seconds and fixed steps: the first thing to check when a
        // car is not moving is whether the world is running at all.
        worldTime: +world.time.toFixed(2),
        steps: world.steps,
        // Ground position per car, x and z. Not z alone: a stage's start
        // heading is whatever the road does, so a car driving hard down the
        // road can barely change its z at all.
        carsAt: world.cars.map((car) => {
          const p = car.vehicle.body.translation();
          return [+p.x.toFixed(2), +p.z.toFixed(2)];
        }),
        net: session
          ? {
              role: session.role,
              players: session.names,
              connected: session.connected,
              ping: session.ping,
            }
          : null,
      };
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
    const id = params.get('stage') ?? STAGES[0]!.id;
    if (params.has('ghost')) await window.RSC.seedGhostAndSeek(id, Number(harnessSeek));
    else {
      window.RSC.seekStage(
        id,
        Number(harnessSeek),
        Number(params.get('crash') ?? '0'),
        Number(params.get('grip') ?? '0.6'),
      );
    }
    // `?brakes=650` preheats the discs. Brake glow starts at a temperature the
    // AI does not reach on a clean lap, so the only way to check how it looks
    // is to put the heat there directly.
    // `?loosen=15000` puts one impact's worth of N·s through the nose mounts,
    // then runs on a couple of seconds so the parts do what they were going to
    // do. The visual question — does a dragging bumper read as dragging — is
    // otherwise only answerable by crashing until it happens.
    // `?wreck=18000` puts a few impacts of that size through the nose, a
    // flank and the tail. Crashing into scenery until the car looks right is a
    // slow way to answer "does the crumple read".
    const wreck = params.get('wreck');
    if (wreck && world!.damage) {
      const impulse = Number(wreck);
      for (const at of [
        { x: 0, y: 0, z: 1.9 },
        { x: -0.9, y: 0, z: 0.6 },
        { x: 0.9, y: 0.1, z: -1.2 },
        { x: 0, y: 0.3, z: -1.9 },
      ]) {
        world!.damage.applyImpact(at, impulse);
        world!.debris?.applyImpact(at, impulse);
      }
      // A moment of driving so the parts settle into their new poses, then put
      // the camera back on the car it just beat up.
      for (let i = 0; i < 30; i++) world!.step({ throttle: 0.3, brake: 0, steer: 0, handbrake: 0 });
      camera.jumpTo(world!.state().position);
      if (world!.damage) damagePanel.update(world!.damage);
    }

    const loosen = params.get('loosen');
    if (loosen) {
      world!.debris?.applyImpact({ x: 0, y: 0, z: 1.9 }, Number(loosen));
      const state = () => world!.state();
      for (let i = 0; i < 120 * Number(params.get('after') ?? '2'); i++) {
        world!.step({ throttle: 0.35, brake: 0, steer: 0, handbrake: 0 });
        updateWheelEffects(particles, skids, state().wheels, state().velocity, world!.dt);
        // Sparks too, or a harness frame of a dragging bumper shows the pose
        // without the shower that is the actual telegraph.
        for (const id of world!.debris?.dragging() ?? []) {
          const at = carView.dragPoint(id);
          if (at) emitDragSparks(particles, at, state().velocity, Math.abs(state().speed), world!.dt);
        }
        particles.update(world!.dt);
      }
      camera.jumpTo(world!.state().position);
    }
    // `?sign=2` puts the camera on that corner board, for reading the arrow.
    const signIndex = params.get('sign');
    if (signIndex) {
      const sign = stage!.signs[Number(signIndex)];
      // Aim at the board itself, not at the foot of its post.
      const zoomParam = params.get('zoom');
      if (sign) {
        cameraLock = {
          at: { x: sign.position.x, y: sign.position.y + 2.6, z: sign.position.z },
          zoom: zoomParam ? Number(zoomParam) : null,
        };
      }
    }

    const brakes = params.get('brakes');
    if (brakes) world!.damage?.brakeTemp.fill(Number(brakes));
    // `?zoom=8` pulls the orthographic camera in. Detail on the car itself —
    // a brake disc is about a metre across — is invisible at race distance.
    const zoom = params.get('zoom');
    if (zoom) camera.setViewSize(Number(zoom));
    window.RSC.draw();
    return;
  }

  // `?wreckCar=20000` puts a wrecked car in the garage, so the turntable and
  // the repair list can be looked at together without crashing one first.
  const wreckCar = params.get('wreckCar');
  if (wreckCar) {
    const model = career.buildDamage();
    for (const at of [
      { x: 0, y: 0, z: 1.9 },
      { x: -0.9, y: 0.1, z: 0.6 },
      { x: 0.9, y: 0.1, z: -1.2 },
    ]) {
      model.applyImpact(at, Number(wreckCar));
    }
    const health: Partial<Record<ComponentId, number>> = {};
    for (const component of COMPONENTS) health[component.id] = model.get(component.id);
    await save.update((profile) => {
      profile.carHealth = health;
    });
  }

  // Start in the garage: the first decision the game asks for is which stage to
  // spend money on, not which corner to take.
  if (!freeRoam) garage.setOpen(true);

  let last = performance.now();
  let fps = 60;

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.08;

    // The world keeps stepping behind the garage so the scene stays alive, but
    // it takes no input while a menu is up.
    const input = garage.isOpen || multiplayer.isOpen ? NEUTRAL_INPUT : controls.sample(dt);
    // In a network race every fixed step goes through the host or the guest:
    // that is what puts inputs on the wire and takes snapshots off it.
    const alpha = session ? session.advance(dt, input) : world.advance(dt, input);

    const state = world.state();
    if (race && stage) {
      const wasRunning = race.phase === 'running';
      const splitsBefore = race.splits.length;
      race.update(state, dt);

      // A bump the car shrugs off should still be felt and heard, so this reads
      // the raw impulse rather than waiting for a damage event.
      if (world.lastImpact > 1200) {
        const severity = Math.min((world.lastImpact - 1200) / 26_000, 1);
        camera.shake(severity);
        mixer.impact(severity);
      }

      // What happened first, then what it broke.
      for (const notice of world.drainNotices()) damagePanel.notice(notice);

      // Surface what just broke while the impact is still on screen.
      if (world.damage) {
        damagePanel.report(world.damage.drainEvents());
        damagePanel.update(world.damage);

        // A terminal failure stops the engine; it does not stop the race. The
        // run ends when the car does — or does not end at all, if the car
        // rolls over the line first.
        const failure = [...world.damage.failures][0];
        if (failure && race.phase === 'running' && !terminal) {
          terminal = { label: FAILURE_LABEL[failure], stopped: 0 };
          damagePanel.notice(`${FAILURE_LABEL[failure]} — coasting, brake to stop`);
        }
      }

      if (terminal && race.phase === 'running') {
        terminal.stopped = Math.abs(state.speed) < 0.8 ? terminal.stopped + dt : 0;
        // Half a second of genuinely stopped, so a car pausing against a rock
        // on its way down a hill is not called a retirement.
        if (terminal.stopped > 0.5) race.retire(terminal.label);
      }

      if (race.phase === 'running') {
        recorder.capture(race.time, race.furthest, state);

        // Live delta: when did the ghost reach the point we have reached?
        const ghostTime = ghost?.timeAtDistance(race.furthest) ?? null;
        raceHud.setDelta(ghostTime === null ? null : race.time - ghostTime);
      }

      if (race.splits.length !== splitsBefore) {
        raceHud.setSplitDeltas(
          race.splits.map((split) => {
            const at = ghost?.timeAtDistance(split.distance);
            return at === null || at === undefined ? null : split.time - at;
          }),
        );
      }

      if (wasRunning && (race.phase === 'finished' || race.phase === 'retired')) {
        void settleRun(race.phase === 'retired');
      }

      raceHud.update(race);
      // The order of the field. Progress along the stage rather than a lap
      // count: it is the same number the standings the host publishes use, and
      // it is meaningful on a point-to-point stage where nobody laps anybody.
      updateStandings();
      // The co-driver's call and the minimap both read the corner list and the
      // progress the race is already tracking.
      if (stage) {
        raceHud.setNotes(cornersAhead(stage.corners, race.furthest, 2));
        minimap.update(state.position, race.progress);
      }

      // Beaching the chassis across the verge with all four wheels dangling is
      // unrecoverable by driving, so the game recovers for you.
      // A car with a dead engine is not stuck, it is finished coasting, and
      // putting it back on the road would be putting a corpse on the road.
      if (race.phase === 'running' && !terminal && Math.abs(state.speed) < 1) {
        stuckFor += dt;
        if (stuckFor > AUTO_RESCUE_AFTER) {
          world.rescue(race.furthest);
          stuckFor = 0;
        }
      } else {
        stuckFor = 0;
      }
    }

    // Spray, marks and sound all read straight off tyre saturation — the same
    // number the physics uses — so what you see and hear is what is happening.
    if (!garage.isOpen) {
      updateWheelEffects(particles, skids, state.wheels, state.velocity, dt);
      // Steam from a boiling radiator, out of the bonnet vents.
      const boiling = world.damage?.boiling ?? 0;
      if (boiling > 0) {
        const t = world.renderTransform(1);
        const vent = rotate(t.rotation, { x: 0, y: 0.55, z: 1.15 });
        emitSteam(
          particles,
          { x: t.position.x + vent.x, y: t.position.y + vent.y, z: t.position.z + vent.z },
          state.velocity,
          boiling,
          dt,
        );
      }

      // Anything scraping along the road throws sparks from where it touches.
      for (const id of world.debris?.dragging() ?? []) {
        const at = carView.dragPoint(id);
        if (at) emitDragSparks(particles, at, state.velocity, Math.abs(state.speed), dt);
      }
      mixer.update(state, {
        maxRpm: world.vehicle.tuning.maxRpm,
        throttle: input.throttle,
        engineHealth: world.damage?.get('engine') ?? 1,
        turboHealth: world.damage?.get('turbo') ?? 1,
        misfiring: world.damage?.effects().misfiring ?? false,
        dt,
      });
    } else {
      mixer.quiet();
    }
    particles.update(dt);
    updateParticleScale();
    precipitation.update(dt, camera.focus, window.innerHeight / (2 * camera.effectiveViewSize));

    drawOnce(alpha, dt);
    // The visual harness waits on this, so the live loop has to set it too or
    // a garage screenshot waits for a frame that only the seek path reports.
    window.RSC!.rendered = true;
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
